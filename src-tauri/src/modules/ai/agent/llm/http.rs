//! OpenAI 兼容端点 HTTP 客户端（deepseek / 任意 custom baseUrl），基于 reqwest。
//!
//! 发送 `POST {base_url}/chat/completions`，Bearer 鉴权。兼容：
//! - DeepSeek：`reasoning_content` 思考链、usage 缓存字段
//! - OpenRouter / 部分网关：`reasoning` 字段（思考链字段双兼容）
//! - Ollama / llama.cpp / R1 蒸馏部署：content 内联 `<think>` 段自动路由为推理增量
//!
//! 契约：`complete` 对网络 / HTTP 错误一律返回 `Err` 不 panic；
//! `Retry-After` 头透传进错误文本（`; retry-after=<秒>`），供上层退避策略解析。

use reqwest::header::RETRY_AFTER;
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::OnceLock;

use crate::error::{ReinError, Result};

use super::sse::{
    merge_reasonings, parse_reasoning_field, parse_usage, separate_think_blocks, SseAccumulator,
};
use super::wire::build_body;
use super::{Compat, DeltaTx, LlmBackend, LlmRequest, LlmResponse, LlmToolCall};

/// 读取 `Retry-After` 响应头（秒数字面量；HTTP-date 形态不支持）。
fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .and_then(|s| s.parse::<u64>().ok())
}

/// 把 `Retry-After` 建议透传进错误文本，供上层退避策略解析；无该头时原样返回。
fn with_retry_after(message: String, retry_after: Option<u64>) -> String {
    match retry_after {
        Some(secs) => format!("{message} ; retry-after={secs}"),
        None => message,
    }
}

/// 安装进程级 rustls crypto provider（ring）。
///
/// reqwest 0.13 的 `rustls-no-provider` 特性不带 provider，建 Client 前必须装好，
/// 否则 panic。全局只能装一次：重复安装返回 `Err(已安装)`，忽略即可（复用现有
/// provider，行为一致）。放在构造函数里做，测试与运行时代码路径同一处理。
fn install_crypto_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// OpenAI 兼容 Chat Completions 客户端
pub struct OpenAiCompatBackend {
    http: reqwest::Client,
    /// 端点前缀，如 `https://api.deepseek.com/v1`（`/chat/completions` 自动拼接）
    base_url: String,
    api_key: String,
    model: String,
    compat: Compat,
    /// 对应 pi 的 `model.reasoning`（Rein 运行时恒 true，见 src/ai/runtime.ts）
    model_reasoning: bool,
}

impl OpenAiCompatBackend {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        install_crypto_provider();
        let base_url = base_url.into();
        Self {
            // 不设总超时（流式可以很長）；连接与「块间空闲」给死线，
            // 防止端点挂起把 ai_probe / agent run 无限吊住
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("reqwest Client 构建失败"),
            compat: Compat::detect(&base_url),
            base_url,
            api_key: api_key.into(),
            model: model.into(),
            model_reasoning: true,
        }
    }

    fn url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }
}

#[async_trait::async_trait]
impl LlmBackend for OpenAiCompatBackend {
    fn model(&self) -> &str {
        &self.model
    }

    async fn complete(&self, req: &LlmRequest) -> Result<LlmResponse> {
        let mut body = build_body(req, &self.compat, self.model_reasoning);
        body["stream"] = Value::Bool(false);

        let resp = self
            .http
            .post(self.url())
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ReinError::Message(format!("LLM 请求发送失败: {e}")))?;

        let status = resp.status();
        let retry_after = retry_after_secs(resp.headers());
        let text = resp
            .text()
            .await
            .map_err(|e| ReinError::Message(format!("LLM 响应读取失败: {e}")))?;

        if status != StatusCode::OK {
            return Err(ReinError::Message(with_retry_after(
                format!("LLM 请求失败（{status}）: {text}"),
                retry_after,
            )));
        }

        let v: Value = serde_json::from_str(&text).map_err(|e| {
            ReinError::Message(format!(
                "LLM 响应解析失败: {e}; body={}",
                &text[..text.len().min(512)]
            ))
        })?;

        let message = &v["choices"][0]["message"];
        // 思考链双来源：独立字段 + content 内联 `<think>` 段，归并为 reasoning
        let field_reasoning = parse_reasoning_field(message);
        let (content, inline_reasoning) =
            separate_think_blocks(message["content"].as_str().unwrap_or(""));
        let reasoning = merge_reasonings(field_reasoning, inline_reasoning);

        let tool_calls = message["tool_calls"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|tc| LlmToolCall {
                        id: tc["id"].as_str().unwrap_or("").to_string(),
                        name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                        arguments: tc["function"]["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or(serde_json::Value::Null),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let usage = v.get("usage").filter(|u| u.is_object()).map(parse_usage);

        Ok(LlmResponse {
            content,
            reasoning,
            tool_calls,
            usage,
        })
    }

    async fn stream_complete(&self, req: &LlmRequest, tx: DeltaTx) -> Result<LlmResponse> {
        let mut body = build_body(req, &self.compat, self.model_reasoning);
        body["stream"] = Value::Bool(true);
        // OpenAI 约定：末块单独携带 usage（choices 为空）；DeepSeek/Qwen 兼容
        body["stream_options"] = serde_json::json!({ "include_usage": true });

        let mut resp = self
            .http
            .post(self.url())
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| ReinError::Message(format!("LLM 流式请求发送失败: {e}")))?;

        let status = resp.status();
        if status != StatusCode::OK {
            let retry_after = retry_after_secs(resp.headers());
            let text = resp.text().await.unwrap_or_default();
            return Err(ReinError::Message(with_retry_after(
                format!(
                    "LLM 流式请求失败（{status}）: {}",
                    &text[..text.len().min(512)]
                ),
                retry_after,
            )));
        }

        // SSE 逐行解析：reqwest chunk() 原生异步迭代，手工按 \n 切行并保留
        // 半行余量；行解析逻辑在 SseAccumulator（纯函数可测）。
        let mut acc = SseAccumulator::default();
        let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&line);
                        acc.line(line.trim_end_matches(['\r', '\n']), &tx)?;
                    }
                }
                Ok(None) => break, // EOF
                Err(e) => return Err(ReinError::Message(format!("LLM 流读取失败: {e}"))),
            }
        }
        if !buf.is_empty() {
            let line = String::from_utf8_lossy(&buf);
            acc.line(line.trim_end_matches(['\r', '\n']), &tx)?;
        }
        acc.finish(&tx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn retry_after_header_is_surfaced_in_errors() {
        let mut headers = HeaderMap::new();
        assert_eq!(retry_after_secs(&headers), None);

        headers.insert(RETRY_AFTER, HeaderValue::from_static("30"));
        assert_eq!(retry_after_secs(&headers), Some(30));
        assert_eq!(
            with_retry_after(
                "LLM 流式请求失败（429 Too Many Requests）: busy".to_string(),
                Some(30)
            ),
            "LLM 流式请求失败（429 Too Many Requests）: busy ; retry-after=30"
        );

        // HTTP-date 形态不解析：错误文本保持原样，由上层退避表兜底
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(retry_after_secs(&headers), None);
        assert_eq!(with_retry_after("boom".to_string(), None), "boom");
    }

    #[test]
    fn compat_is_detected_at_construction() {
        let b = OpenAiCompatBackend::new("https://api.deepseek.com/v1", "sk", "m");
        assert_eq!(b.compat.max_tokens_field, "max_tokens");
        let b2 = OpenAiCompatBackend::new("https://x.example/v1", "sk", "m");
        assert_eq!(b2.compat.max_tokens_field, "max_completion_tokens");
    }

    // ---------------------------------------------------------
    // 端到端：std-only 本地假 provider（真实 HTTP 请求 + 真实 SSE 解析）
    // ---------------------------------------------------------

    use std::io::{Read, Write};
    use std::sync::mpsc::Receiver;

    use super::super::{LlmMessage, StreamDelta};

    /// 起一个单线程 HTTP 服务，按脚本逐次应答；返回 (端口, 收到的请求体通道)
    fn spawn_http_server(responses: Vec<String>) -> (u16, Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 4096];
                let body_start = loop {
                    let n = stream.read(&mut tmp).unwrap_or(0);
                    if n == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                        let cl = head
                            .lines()
                            .find_map(|l| l.strip_prefix("Content-Length: ").or_else(|| l.strip_prefix("content-length: ")))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        let start = pos + 4;
                        while buf.len() - start < cl {
                            let n = stream.read(&mut tmp).unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        break Some(start);
                    }
                };
                if let Some(start) = body_start {
                    let _ = tx.send(String::from_utf8_lossy(&buf[start..]).to_string());
                }
                // SSE 用例分两次写并 flush，模拟真实分块到达
                if let Some((head, body)) = resp.split_once("\r\n\r\n") {
                    let _ = stream.write_all(format!("{head}\r\n\r\n").as_bytes());
                    let _ = stream.flush();
                    if let Some(second) = body.split_once("<!--cut-->") {
                        std::thread::sleep(std::time::Duration::from_millis(15));
                        let _ = stream.write_all(second.0.as_bytes());
                        let _ = stream.flush();
                        std::thread::sleep(std::time::Duration::from_millis(15));
                        let _ = stream.write_all(second.1.as_bytes());
                    } else {
                        let _ = stream.write_all(body.as_bytes());
                    }
                } else {
                    let _ = stream.write_all(resp.as_bytes());
                }
                let _ = stream.flush();
            }
        });
        (port, rx)
    }

    fn json_resp(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn test_req() -> LlmRequest {
        LlmRequest {
            model: "mock-model".into(),
            system: Some("你是助手".into()),
            messages: vec![LlmMessage::user("hi")],
            tools: Vec::new(),
            temperature: None,
            max_tokens: Some(1),
            thinking_level: Some("high".into()),
        }
    }

    #[tokio::test]
    async fn complete_parses_provider_response_and_sends_expected_body() {
        let body = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "你好<think>内心戏</think>世界",
                    "reasoning_content": "先想",
                    "tool_calls": [{
                        "id": "c1", "type": "function",
                        "function": { "name": "search_food", "arguments": "{\"query\":\"鸡蛋\"}" }
                    }]
                }
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14 }
        })
        .to_string();
        let (port, rx) = spawn_http_server(vec![json_resp(&body)]);
        let backend = OpenAiCompatBackend::new(format!("http://127.0.0.1:{port}/v1"), "sk-test", "mock-model");

        let resp = backend.complete(&test_req()).await.unwrap();
        assert_eq!(resp.content, "你好世界", "内联 think 段应剥离进 reasoning");
        assert_eq!(resp.reasoning.as_deref(), Some("先想\n内心戏"));
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "search_food");
        assert_eq!(resp.tool_calls[0].arguments["query"], "鸡蛋");
        assert_eq!(resp.usage.map(|u| u.total), Some(14));

        // 请求体：URL 路径、鉴权头、字段名（未知域名 → max_completion_tokens）
        let seen: serde_json::Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
        assert_eq!(seen["model"], "mock-model");
        assert_eq!(seen["system"], serde_json::Value::Null, "system 走 messages 首条");
        assert_eq!(seen["messages"][0]["role"], "developer", "OpenAI 风格域名用 developer");
        assert_eq!(seen["messages"][0]["content"], "你是助手");
        assert_eq!(seen["max_completion_tokens"], 1);
        assert_eq!(seen["stream"], false);
        assert_eq!(seen["reasoning_effort"], "high");
    }

    #[tokio::test]
    async fn stream_complete_splits_sse_into_deltas_and_aggregates() {
        // 分三块到达：思考增量 / 正文增量 + tool_call 参数跨块 / usage 末块
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"答\",\"tool_calls\":[{\"index\":0,\"id\":\"c9\",\"function\":{\"name\":\"log_meal\",\"arguments\":\"{\\\"grams\\\":\"}}]}}]}\r\n\r\n",
            "<!--cut-->",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"120}\"}}]}}]}\r\n\r\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\r\n\r\n",
            "data: [DONE]\r\n\r\n"
        );
        let resp_raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{sse}"
        );
        let (port, _rx) = spawn_http_server(vec![resp_raw]);
        let backend = OpenAiCompatBackend::new(format!("http://127.0.0.1:{port}/v1"), "sk", "mock-model");

        let (tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel();
        let resp = backend.stream_complete(&test_req(), tx).await.unwrap();

        let mut deltas = Vec::new();
        while let Ok(d) = delta_rx.try_recv() {
            deltas.push(d);
        }
        assert_eq!(
            deltas,
            vec![
                StreamDelta::Reasoning("想".into()),
                StreamDelta::Text("答".into()),
            ],
            "token 增量实时外发"
        );
        assert_eq!(resp.content, "答");
        assert_eq!(resp.reasoning.as_deref(), Some("想"));
        assert_eq!(resp.tool_calls.len(), 1, "跨块参数片应拼合");
        assert_eq!(resp.tool_calls[0].id, "c9");
        assert_eq!(resp.tool_calls[0].name, "log_meal");
        assert_eq!(resp.tool_calls[0].arguments["grams"], 120);
        assert_eq!(resp.usage.map(|u| u.total), Some(10));
    }

    #[tokio::test]
    async fn http_error_status_surfaces_body_and_retry_after() {
        let raw = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 12\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"error\":\"rate limited\"}"
            .to_string();
        let (port, _rx) = spawn_http_server(vec![raw]);
        let backend = OpenAiCompatBackend::new(format!("http://127.0.0.1:{port}/v1"), "sk", "m");
        let err = backend.complete(&test_req()).await.unwrap_err().to_string();
        assert!(err.contains("429"), "错误应带状态码: {err}");
        assert!(err.contains("rate limited"), "错误应带响应体: {err}");
        assert!(err.contains("retry-after=12"), "Retry-After 应透传: {err}");
    }
}
