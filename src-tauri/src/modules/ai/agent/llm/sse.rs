//! 流式分块解析与聚合（Chat Completions SSE）。
//!
//! 纯函数式状态机：逐行喂入 [`SseAccumulator::line`]，增量实时转发 UI 通道，
//! 流末尾 [`SseAccumulator::finish`] 聚合出终稿 [`LlmResponse`]。
//!
//! 线格式细节（EffiBuddy 实测覆盖）：
//! - 每事件一行 `data: {json}`，`data: [DONE]` 终止；空行 / `:` 注释行忽略
//! - 推理增量字段双兼容：`delta.reasoning_content`（DeepSeek / 硅基流动等）
//!   与 `delta.reasoning`（OpenRouter / 部分网关）
//! - 正文内联 `<think>...</think>` 段（Ollama / llama.cpp / R1 蒸馏部署）
//!   经 [`ThinkSplitter`] 路由为推理增量，正文剥离标签
//! - 工具调用按 `delta.tool_calls[].index` 分片到达（id / name / arguments 逐段补全）
//! - `include_usage` 的末块 `choices` 为空、仅带顶层 `usage`

use std::collections::BTreeMap;

use crate::error::ReinError;

use super::{DeltaTx, LlmResponse, LlmToolCall, LlmUsage, StreamDelta};

/// token 用量解析（非流式 usage 对象与流式末块共用）。
/// `input` 口径对齐 pi-ai：prompt_tokens 扣除缓存命中 / 写入。
pub(super) fn parse_usage(u: &serde_json::Value) -> LlmUsage {
    let prompt = u["prompt_tokens"].as_u64().unwrap_or(0);
    let cache_read = u["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| u["prompt_cache_hit_tokens"].as_u64())
        .unwrap_or(0);
    let cache_write = u["prompt_tokens_details"]["cache_write_tokens"].as_u64().unwrap_or(0);
    let output = u["completion_tokens"].as_u64().unwrap_or(0);
    let reasoning = u["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0);
    let input = prompt.saturating_sub(cache_read + cache_write);
    LlmUsage { input, output, cache_read, cache_write, reasoning, total: input + output + cache_read + cache_write }
}

/// 读取思考链独立字段：`reasoning_content`（DeepSeek / 硅基流动等）优先，
/// `reasoning`（OpenRouter / 部分网关）回退——两者不会同时出现。
pub(super) fn parse_reasoning_field(message: &serde_json::Value) -> Option<String> {
    message["reasoning_content"]
        .as_str()
        .or_else(|| message["reasoning"].as_str())
        .map(str::to_string)
}

/// 合并多来源思考链：独立字段在前，内联 think 块在后（换行连接）。
pub(super) fn merge_reasonings(field: Option<String>, inline: String) -> Option<String> {
    match (field.filter(|s| !s.is_empty()), inline.is_empty()) {
        (None, true) => None,
        (Some(f), true) => Some(f),
        (None, false) => Some(inline),
        (Some(f), false) => Some(format!("{f}\n{inline}")),
    }
}

/// `<think>` 起始标签
const THINK_OPEN: &str = "<think>";
/// `</think>` 闭合标签
const THINK_CLOSE: &str = "</think>";

/// 把 content 中的内联 `<think>...</think>` 段剥离出来（非流式路径）。
///
/// 返回 `(正文, 内联思考全文)`：think 段从正文移除，多段以换行拼接；
/// 无闭合标签时剩余部分整体视为思考内容（模型被截断在思考中）。
pub(super) fn separate_think_blocks(content: &str) -> (String, String) {
    let mut body = String::with_capacity(content.len());
    let mut thinking = String::new();
    let mut rest = content;
    loop {
        match rest.find(THINK_OPEN) {
            None => {
                body.push_str(rest);
                break;
            }
            Some(pos) => {
                body.push_str(&rest[..pos]);
                let after_open = &rest[pos + THINK_OPEN.len()..];
                match after_open.find(THINK_CLOSE) {
                    Some(end) => {
                        if !thinking.is_empty() {
                            thinking.push('\n');
                        }
                        thinking.push_str(&after_open[..end]);
                        rest = &after_open[end + THINK_CLOSE.len()..];
                    }
                    None => {
                        if !thinking.is_empty() {
                            thinking.push('\n');
                        }
                        thinking.push_str(after_open);
                        break;
                    }
                }
            }
        }
    }
    (body, thinking)
}

/// 流式 `<think>` 分流器：把 content 增量中的 think 段路由为推理增量，
/// 其余照常作为正文增量外发。容忍标签跨 chunk 切断（如 `"<thi"` + `"nk>"`）。
#[derive(Default)]
pub(super) struct ThinkSplitter {
    in_think: bool,
    buf: String,
}

impl ThinkSplitter {
    pub(super) fn feed(&mut self, chunk: &str) -> Vec<(bool, String)> {
        self.buf.push_str(chunk);
        self.drain(false)
    }

    /// 流结束：清空缓冲。未闭合 think 的残余内容按推理输出。
    pub(super) fn flush(&mut self) -> Vec<(bool, String)> {
        self.drain(true)
    }

    fn drain(&mut self, eof: bool) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        loop {
            let needle = if self.in_think { THINK_CLOSE } else { THINK_OPEN };
            match self.buf.find(needle) {
                Some(pos) => {
                    Self::push(&mut out, self.in_think, self.buf[..pos].to_string());
                    self.buf.drain(..pos + needle.len());
                    self.in_think = !self.in_think;
                }
                None => break,
            }
        }
        if !eof {
            // 保留可能是目标标签前缀的尾巴（最多 needle.len()-1 字节），其余照常输出
            let needle = if self.in_think { THINK_CLOSE } else { THINK_OPEN };
            let keep = tag_prefix_suffix_len(&self.buf, needle);
            let cut = self.buf.len() - keep;
            if cut > 0 {
                Self::push(&mut out, self.in_think, self.buf[..cut].to_string());
                self.buf.drain(..cut);
            }
        } else {
            Self::push(&mut out, self.in_think, std::mem::take(&mut self.buf));
        }
        out
    }

    /// 相邻同路片段合并，减少增量碎片
    fn push(out: &mut Vec<(bool, String)>, is_reasoning: bool, text: String) {
        if text.is_empty() {
            return;
        }
        if let Some((last_r, last_t)) = out.last_mut() {
            if *last_r == is_reasoning {
                last_t.push_str(&text);
                return;
            }
        }
        out.push((is_reasoning, text));
    }
}

/// buf 尾部与 needle 前缀的最长匹配长度（不含完整匹配；ASCII 标签可按字节切）。
fn tag_prefix_suffix_len(buf: &str, needle: &str) -> usize {
    let max = needle.len().saturating_sub(1).min(buf.len());
    for len in (1..=max).rev() {
        if buf.as_bytes()[buf.len() - len..] == needle.as_bytes()[..len] {
            return len;
        }
    }
    0
}

/// SSE 流聚合器：把流式分块**纯函数式**聚合为最终 [`LlmResponse`]，
/// 同时把文本 / 推理增量实时转发到 UI 通道。
#[derive(Default)]
pub(super) struct SseAccumulator {
    content: String,
    reasoning: String,
    has_reasoning: bool,
    think: ThinkSplitter,
    /// tool_calls 分片累计：index → (id, name, arguments 片段串)
    tools: BTreeMap<u64, (String, String, String)>,
    usage: Option<LlmUsage>,
}

impl SseAccumulator {
    fn emit(&mut self, is_reasoning: bool, text: &str, tx: &DeltaTx) {
        if text.is_empty() {
            return;
        }
        if is_reasoning {
            self.reasoning.push_str(text);
            self.has_reasoning = true;
            let _ = tx.send(StreamDelta::Reasoning(text.to_string()));
        } else {
            self.content.push_str(text);
            let _ = tx.send(StreamDelta::Text(text.to_string()));
        }
    }

    /// 处理一行 SSE 文本。错误载荷（部分网关以 data 事件回传错误）返回 Err。
    pub(super) fn line(&mut self, raw: &str, tx: &DeltaTx) -> crate::error::Result<()> {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(':') {
            return Ok(()); // 空行 / keep-alive 注释
        }
        let Some(payload) = line.strip_prefix("data:") else {
            return Ok(()); // 非 data 行（event:/id:/retry:），当前不使用
        };
        let payload = payload.trim();
        if payload == "[DONE]" {
            return Ok(());
        }
        let v: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
            ReinError::Message(format!(
                "LLM 流分块解析失败: {e}; data={}",
                &payload[..payload.len().min(200)]
            ))
        })?;
        if let Some(err) = v.get("error") {
            return Err(ReinError::Message(format!("LLM 流式错误: {err}")));
        }

        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(parse_usage(u));
        }

        let Some(choice) = v["choices"].get(0) else {
            return Ok(()); // usage 末块等无 choices 载荷
        };
        let delta = &choice["delta"];

        if let Some(r) = parse_reasoning_field(delta) {
            self.emit(true, &r, tx);
        }
        if let Some(c) = delta["content"].as_str() {
            for (is_reasoning, part) in self.think.feed(c) {
                self.emit(is_reasoning, &part, tx);
            }
        }
        if let Some(tcs) = delta["tool_calls"].as_array() {
            for tc in tcs {
                let idx = tc["index"].as_u64().unwrap_or(0);
                let entry = self.tools.entry(idx).or_default();
                if let Some(id) = tc["id"].as_str() {
                    entry.0.push_str(id);
                }
                if let Some(name) = tc["function"]["name"].as_str() {
                    entry.1.push_str(name);
                }
                if let Some(args) = tc["function"]["arguments"].as_str() {
                    entry.2.push_str(args);
                }
            }
        }
        Ok(())
    }

    /// 聚合终稿：工具调用参数片段拼合后反序列化为 Value（非法 JSON 记 Null，
    /// 由 loop 落错误结果让模型自行纠正）。`tx` 用于冲刷分流器缓冲的残余片段
    /// （半截标签 / 未闭合 think 尾巴）——保证「终稿 = 全部增量之和」。
    pub(super) fn finish(mut self, tx: &DeltaTx) -> crate::error::Result<LlmResponse> {
        for (is_reasoning, part) in self.think.flush() {
            self.emit(is_reasoning, &part, tx);
        }
        let tool_calls = self
            .tools
            .into_iter()
            .map(|(_, (id, name, args))| LlmToolCall {
                id,
                name,
                arguments: serde_json::from_str(&args).unwrap_or(serde_json::Value::Null),
            })
            .collect();
        Ok(LlmResponse {
            content: self.content,
            reasoning: self.has_reasoning.then_some(self.reasoning),
            tool_calls,
            usage: self.usage,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    /// 跑完一条 SSE 流（喂行 + finish 冲刷），返回 (终稿聚合, 全部 UI 增量)
    fn run_stream(lines: &[&str]) -> (LlmResponse, Vec<StreamDelta>) {
        let (tx, mut rx) = unbounded_channel();
        let mut acc = SseAccumulator::default();
        for l in lines {
            acc.line(l, &tx).unwrap();
        }
        let resp = acc.finish(&tx).unwrap();
        drop(tx);
        let mut out = Vec::new();
        while let Ok(d) = rx.try_recv() {
            out.push(d);
        }
        (resp, out)
    }

    #[test]
    fn sse_ignores_noise_and_done() {
        let (resp, _) = run_stream(&["", ": keep-alive", "event: ping", "data: [DONE]"]);
        assert_eq!(resp.content, "");
    }

    #[test]
    fn sse_aggregates_text_and_reasoning_in_order() {
        let (resp, deltas) = run_stream(&[
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考A\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考B\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"}}]}",
        ]);
        assert_eq!(
            deltas,
            vec![
                StreamDelta::Reasoning("思考A".into()),
                StreamDelta::Reasoning("思考B".into()),
                StreamDelta::Text("你好".into()),
                StreamDelta::Text("世界".into()),
            ]
        );
        assert_eq!(resp.content, "你好世界");
        assert_eq!(resp.reasoning.as_deref(), Some("思考A思考B"));
    }

    #[test]
    fn sse_openrouter_style_reasoning_field_also_routes() {
        let (resp, deltas) = run_stream(&[
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"想1\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"想2\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"答\"}}]}",
        ]);
        assert_eq!(
            deltas,
            vec![
                StreamDelta::Reasoning("想1".into()),
                StreamDelta::Reasoning("想2".into()),
                StreamDelta::Text("答".into()),
            ]
        );
        assert_eq!(resp.reasoning.as_deref(), Some("想1想2"));
        assert_eq!(resp.content, "答");
    }

    #[test]
    fn sse_inline_think_tags_route_to_reasoning_across_chunks() {
        // Ollama / llama.cpp 风格：思考以 <think>...</think> 混在 content 里，
        // 且标签跨 chunk 切断（真实流式常见形态）
        let (resp, deltas) = run_stream(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"<thi\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"nk>先分析\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"问题。</think>最终\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}",
        ]);
        assert_eq!(
            deltas,
            vec![
                StreamDelta::Reasoning("先分析".into()),
                StreamDelta::Reasoning("问题。".into()),
                StreamDelta::Text("最终".into()),
                StreamDelta::Text("答案".into()),
            ],
            "think 段应路由为推理增量，正文剥离标签"
        );
        assert_eq!(resp.content, "最终答案");
        assert_eq!(resp.reasoning.as_deref(), Some("先分析问题。"));
    }

    #[test]
    fn sse_unclosed_think_tail_flushes_to_reasoning() {
        let (resp, deltas) = run_stream(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"前情\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"<think>还在想\"}}]}",
        ]);
        assert_eq!(deltas.len(), 2);
        assert_eq!(resp.content, "前情");
        assert_eq!(resp.reasoning.as_deref(), Some("还在想"));
    }

    #[test]
    fn sse_plain_content_with_angle_bracket_not_eaten() {
        // 正文中出现普通 "<" 与标签无关的文本：不应被半截标签缓冲吞掉
        let (resp, deltas) =
            run_stream(&["data: {\"choices\":[{\"delta\":{\"content\":\"a < b 并且 c<d\"}}]}"]);
        assert_eq!(deltas, vec![StreamDelta::Text("a < b 并且 c<d".into())]);
        assert_eq!(resp.content, "a < b 并且 c<d");
        assert!(resp.reasoning.is_none());
    }

    #[test]
    fn separate_think_blocks_variants() {
        let (b, t) = separate_think_blocks("纯正文");
        assert_eq!((b.as_str(), t.as_str()), ("纯正文", ""));
        let (b, t) = separate_think_blocks("<think>想</think>说");
        assert_eq!((b.as_str(), t.as_str()), ("说", "想"));
        let (b, t) = separate_think_blocks("<think>a</think>X<think>b</think>Y");
        assert_eq!((b.as_str(), t.as_str()), ("XY", "a\nb"));
        let (b, t) = separate_think_blocks("开头<think>截断");
        assert_eq!((b.as_str(), t.as_str()), ("开头", "截断"));
    }

    #[test]
    fn reasoning_field_parsing_prefers_reasoning_content() {
        let msg = serde_json::json!({"reasoning_content": "主", "reasoning": "备"});
        assert_eq!(parse_reasoning_field(&msg).as_deref(), Some("主"));
        let msg2 = serde_json::json!({"reasoning": "备"});
        assert_eq!(parse_reasoning_field(&msg2).as_deref(), Some("备"));
        let msg3 = serde_json::json!({});
        assert!(parse_reasoning_field(&msg3).is_none());
    }

    #[test]
    fn usage_input_excludes_cached_tokens_like_pi() {
        // DeepSeek 缓存命中：prompt_cache_hit_tokens；成本记账口径与 pi-ai 一致
        let u = parse_usage(&serde_json::json!({
            "prompt_tokens": 100,
            "prompt_cache_hit_tokens": 60,
            "completion_tokens": 5,
            "total_tokens": 105
        }));
        assert_eq!(u.input, 40);
        assert_eq!(u.cache_read, 60);
        assert_eq!(u.output, 5);
        assert_eq!(u.total, 105);
        // OpenAI 形态：prompt_tokens_details.cached_tokens
        let u2 = parse_usage(&serde_json::json!({
            "prompt_tokens": 50,
            "prompt_tokens_details": { "cached_tokens": 20 },
            "completion_tokens": 10
        }));
        assert_eq!(u2.input, 30);
        assert_eq!(u2.cache_read, 20);
    }

    #[test]
    fn sse_assembles_tool_call_fragments_across_chunks() {
        // arguments 分片模拟真实流式行为：参数 JSON 字符串跨多个 chunk 逐段到达
        let l1 = format!(
            "data: {}",
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 0, "id": "call-1",
                    "function": { "name": "search_food", "arguments": "{\"query\":" }
                }] } }]
            })
        );
        let l2 = format!(
            "data: {}",
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 0, "function": { "arguments": "\"鸡蛋\"}" }
                }] } }]
            })
        );
        let (resp, deltas) = run_stream(&[&l1, &l2]);
        assert!(deltas.is_empty(), "工具调用分片不应产生 UI 增量");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call-1");
        assert_eq!(resp.tool_calls[0].name, "search_food");
        assert_eq!(resp.tool_calls[0].arguments["query"], "鸡蛋");
    }

    #[test]
    fn sse_captures_usage_tail_chunk_and_error_payload() {
        let (resp, _) = run_stream(&[
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}",
        ]);
        assert_eq!(resp.usage.map(|u| u.total), Some(15));

        let (tx, _rx) = unbounded_channel();
        let mut acc2 = SseAccumulator::default();
        let err = acc2
            .line("data: {\"error\":{\"message\":\"rate limited\"}}", &tx)
            .unwrap_err();
        assert!(err.to_string().contains("rate limited"));
    }
}
