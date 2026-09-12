//! ASR 适配器层：把不同厂商的流式识别协议归一化为统一的
//! 命令（send_audio/finish_input）+ 归一化事件（NormEvent）契约。
//!
//! 各家协议互不通用（2026-09-10 核对）：
//! - **豆包**（docs/6561/1354869）：自定义二进制帧（4B header + 大端 size + payload），
//!   上行 payload gzip，**下行实测未压缩**（compression 标志=0，flags bit0 标记 4B sequence）；
//!   鉴权 X-Api-App-Key/Access-Key（旧版）或 X-Api-Key（新版）；`utterances[].definite` 显式定句。
//! - **Qwen/DashScope**（官方 SDK 1.27.4 权威核对）：JSON 控制消息 + 二进制音频帧，
//!   鉴权 `Authorization: Bearer <key>`；run-task(streaming=duplex, task_group=audio, task=asr,
//!   function=recognition) → task-started → 二进制 PCM 帧 → finish-task；
//!   服务端事件 header.event = task-started / result-generated / task-finished / task-failed，
//!   `payload.output.sentence = {begin_time, end_time, text}`，**end_time 非 null 即句终**。
//!
//! 新增厂商 = 实现本 trait + 在 `AnyAsrAdapter` 枚举里加一个分支。

use std::future::Future;

use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::error::{ReinError, Result};

use super::protocol::WsFrame;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const MAX_PAYLOAD: usize = 16 * 1024 * 1024;

/// 适配器种类（配置里 'auto' 解析后的结果）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrAdapterKind {
    Doubao,
    Qwen,
}

impl AsrAdapterKind {
    /// 按 baseURL / 模型名关键词识别厂商（前端双层自动选择的后端兜底）
    pub fn detect(base_url: &str, model: &str) -> Option<Self> {
        let s = format!("{} {}", base_url, model).to_lowercase();
        if s.contains("qwen") || s.contains("dashscope") || s.contains("aliyun") {
            Some(Self::Qwen)
        } else if s.contains("doubao")
            || s.contains("volc")
            || s.contains("openspeech")
            || s.contains("bytedance")
            || s.contains("seedasr")
        {
            Some(Self::Doubao)
        } else {
            None
        }
    }

    pub fn default_url(&self) -> &'static str {
        match self {
            // 豆包流式语音识别模型 2.0 端点（/plan/ 路径，官方配置指南 2026-09）
            Self::Doubao => "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async",
            Self::Qwen => "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
        }
    }
}

/// 一条适配器会话的连接参数
#[derive(Debug, Clone)]
pub struct AsrSessionParams {
    pub url: String,
    /// 豆包：App ID / API Key；Qwen：DASHSCOPE_API_KEY
    pub app_key: String,
    /// 豆包旧版 Access Token（Qwen 不用）
    pub access_key: String,
    /// 豆包 legacy = App ID + Token，new = 仅 API Key
    pub credential_mode: String,
    /// 豆包 Resource-Id / Qwen 模型名
    pub model: String,
}

/// 归一化识别事件（不含 ended/error，由共享会话层包装）
#[derive(Debug, Clone)]
pub enum NormEvent {
    /// 未完句（会被后续 partial/final 覆盖）
    Partial { text: String, start_ms: i64 },
    /// 定稿句（逐句落库依据）
    Final { text: String, start_ms: i64, end_ms: i64 },
}

/// ASR 适配器契约：一家厂商一个实现。
/// 适配器持有 WS 连接与自身状态；共享会话层只喂命令、收归一化事件。
pub trait AsrAdapter: Send {
    /// 建连 + 鉴权 + 发送首控包（豆包 full client request / Qwen run-task）
    fn connect(&mut self) -> impl Future<Output = Result<()>> + Send;
    /// 拉一条下行帧；None = 连接关闭（Ping 内部回 Pong 后继续读）
    fn next_frame(&mut self) -> impl Future<Output = Option<Result<WsFrame>>> + Send;
    /// 推一包 16k/16bit/mono PCM（200ms）
    fn send_audio(&mut self, pcm: &[u8]) -> impl Future<Output = Result<()>> + Send;
    /// 输入结束（豆包负包 / Qwen finish-task）
    fn finish_input(&mut self) -> impl Future<Output = Result<()>> + Send;
    /// 处理一条下行帧 → 0..n 条归一化事件
    fn on_frame(&mut self, frame: WsFrame) -> impl Future<Output = Result<Vec<NormEvent>>> + Send;
    /// 会话是否已正常结束（收到最终响应；之后共享层收尾发 ended）
    fn is_done(&self) -> bool;
}

/* ---------------- 帧工具（豆包二进制协议） ---------------- */

pub fn gzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut enc, data)?;
    Ok(enc.finish()?)
}

pub fn gunzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut dec = flate2::read::GzDecoder::new(data);
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut dec, &mut out)?;
    Ok(out)
}

/// 4B header（version|header-size / msg-type|flags / serialization|compression / 保留）
/// + 4B 大端 payload size + payload
fn frame_msg(msg_type: u8, flags: u8, serialization: u8, compression: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(0x11);
    out.push((msg_type << 4) | flags);
    out.push((serialization << 4) | compression);
    out.push(0x00);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/* ---------------- 豆包 ---------------- */

pub struct DoubaoAdapter {
    ws: Option<Ws>,
    params: AsrSessionParams,
    done: bool,
}

impl DoubaoAdapter {
    pub fn new(params: AsrSessionParams) -> Self {
        Self { ws: None, params, done: false }
    }

    fn ws_mut(&mut self) -> Option<&mut Ws> {
        self.ws.as_mut()
    }

    async fn send_frame(&mut self, data: Vec<u8>) -> Result<()> {
        use futures_util::SinkExt;
        self.ws
            .as_mut()
            .ok_or_else(|| ReinError::Message("ASR 连接未建立".into()))?
            .send(Message::Binary(data.into()))
            .await
            .map_err(|e| ReinError::Message(format!("ASR 发送失败：{e}")))
    }
}

impl AsrAdapter for DoubaoAdapter {
    async fn connect(&mut self) -> Result<()> {
        let mut req = self
            .params
            .url
            .clone()
            .into_client_request()
            .map_err(|e| ReinError::Message(format!("ASR 请求构造失败：{e}")))?;
        {
            let headers = req.headers_mut();
            let hs: Vec<(String, String)> = match self.params.credential_mode.as_str() {
                "new" => vec![("X-Api-Key".into(), self.params.app_key.clone())],
                _ => vec![
                    ("X-Api-App-Key".into(), self.params.app_key.clone()),
                    ("X-Api-Access-Key".into(), self.params.access_key.clone()),
                ],
            };
            for (k, v) in hs {
                let name = HeaderName::from_bytes(k.as_bytes())
                    .map_err(|e| ReinError::Message(format!("鉴权头名非法：{e}")))?;
                let value = HeaderValue::from_str(&v)
                    .map_err(|e| ReinError::Message(format!("鉴权头值非法：{e}")))?;
                headers.insert(name, value);
            }
            headers.insert("X-Api-Resource-Id", HeaderValue::from_str(&self.params.model).unwrap());
            headers.insert(
                "X-Api-Request-Id",
                HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()).unwrap(),
            );
            headers.insert("X-Api-Sequence", HeaderValue::from_static("-1"));
        }
        let (ws, resp) = tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| ReinError::Message(format!("豆包 ASR 连接失败：{e}")))?;
        // logid 排错线索（响应头 X-Tt-Logid）
        let _logid = resp.headers().get("x-tt-logid").and_then(|v| v.to_str().ok()).map(str::to_string);
        self.ws = Some(ws);
        // full client request：16k/16bit/pcm + 二遍识别（definite 定句）+ 增量返回
        let json = serde_json::json!({
            "user": { "uid": "rein" },
            "audio": { "format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1 },
            "request": {
                "model_name": "bigmodel",
                "enable_nonstream": true,
                "show_utterances": true,
                "result_type": "single",
                "enable_punc": true,
                "enable_itn": true,
            },
        });
        let body = serde_json::to_vec(&json)?;
        self.send_frame(frame_msg(0b0001, 0b0000, 0b0001, 0b0001, &gzip(&body)?)).await
    }

    async fn next_frame(&mut self) -> Option<Result<WsFrame>> {
        use futures_util::StreamExt;
        let ws = self.ws_mut()?;
        loop {
            match ws.next().await {
                Some(Ok(Message::Ping(p))) => {
                    use futures_util::SinkExt;
                    let _ = ws.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Text(t))) => return Some(Ok(WsFrame::Text(t.to_string()))),
                Some(Ok(Message::Binary(b))) => return Some(Ok(WsFrame::Binary(b.to_vec()))),
                Some(Ok(Message::Close(_))) | None => return None,
                Some(Ok(_)) => {} // 其余帧忽略
                Some(Err(e)) => return Some(Err(ReinError::Message(format!("ASR 连接中断：{e}")))),
            }
        }
    }

    async fn send_audio(&mut self, pcm: &[u8]) -> Result<()> {
        // 音频包：无序列化 + gzip；最后一包 flags 0b0010（负包）由 finish_input 发
        self.send_frame(frame_msg(0b0010, 0b0000, 0b0000, 0b0001, &gzip(pcm)?)).await
    }

    async fn finish_input(&mut self) -> Result<()> {
        self.send_frame(frame_msg(0b0010, 0b0010, 0b0000, 0b0001, &gzip(&[])?)).await
    }

    async fn on_frame(&mut self, frame: WsFrame) -> Result<Vec<NormEvent>> {
        let bytes = match frame {
            WsFrame::Binary(b) => b,
            WsFrame::Text(_) => return Ok(vec![]),
        };
        if bytes.len() < 4 {
            return Err(ReinError::Message("ASR 响应帧过短".into()));
        }
        let msg_type = bytes[1] >> 4;
        let flags = bytes[1] & 0x0f;
        // 错误帧：4B 错误码 + 4B 长度 + 明文（不压缩）
        if msg_type == 0b1111 {
            if bytes.len() >= 12 {
                let size = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
                let end = 12 + size.min(bytes.len().saturating_sub(12));
                let msg = String::from_utf8_lossy(&bytes[12..end]);
                return Err(ReinError::Message(format!("豆包 ASR 错误：{msg}")));
            }
            return Err(ReinError::Message("豆包 ASR 错误帧".into()));
        }
        if msg_type != 0b1001 {
            return Ok(vec![]);
        }
        // full server response：flags bit0 = header 后带 4B sequence（首帧 ACK 不带）。
        // 实测（2026-09-12 真实凭据）：服务端回包 compression 标志 = 0（未压缩 JSON），
        // mock 与旧实现按恒 gzip 解析会失败，故按压缩标志决定是否 gunzip。
        let compressed = (bytes[2] & 0x0f) == 0b0001;
        let decode = |payload: &[u8]| -> Option<serde_json::Value> {
            let raw = if compressed { gunzip(payload).ok()? } else { payload.to_vec() };
            serde_json::from_slice(&raw).ok()
        };
        // 带 sequence：header(4)+seq(4)+size(4)+payload；不带：header(4)+size(4)+payload。
        // 按标志位选主序，另一种作兜底
        let try_a = || -> Option<serde_json::Value> {
            if bytes.len() < 12 {
                return None;
            }
            let size = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
            if size == 0 || size > MAX_PAYLOAD || 12 + size > bytes.len() {
                return None;
            }
            decode(&bytes[12..12 + size])
        };
        let try_b = || -> Option<serde_json::Value> {
            if bytes.len() < 8 {
                return None;
            }
            let size = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
            if size == 0 || size > MAX_PAYLOAD || 8 + size > bytes.len() {
                return None;
            }
            decode(&bytes[8..8 + size])
        };
        let v = if (flags & 0b0001) != 0 { try_a().or_else(try_b) } else { try_b().or_else(try_a) }
            .ok_or_else(|| ReinError::Message("ASR 响应解析失败".into()))?;
        let last = (flags & 0b0010) != 0;
        let mut out = Vec::new();
        if let Some(uts) = v.get("result").and_then(|r| r.get("utterances")).and_then(|u| u.as_array()) {
            for u in uts {
                let text = u.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                if text.is_empty() {
                    continue;
                }
                let start = u.get("start_time").and_then(|t| t.as_i64()).unwrap_or(0);
                let end = u.get("end_time").and_then(|t| t.as_i64()).unwrap_or(start);
                let definite = u.get("definite").and_then(|d| d.as_bool()).unwrap_or(false);
                out.push(if definite {
                    NormEvent::Final { text, start_ms: start, end_ms: end }
                } else {
                    NormEvent::Partial { text, start_ms: start }
                });
            }
        }
        if last {
            self.done = true;
        }
        Ok(out)
    }

    fn is_done(&self) -> bool {
        self.done
    }
}

/* ---------------- Qwen / DashScope ---------------- */

pub struct QwenAdapter {
    ws: Option<Ws>,
    params: AsrSessionParams,
    /// task-started 已收到（之后才能发二进制音频）
    started: bool,
    /// task-started 前到达的音频排队
    queue: Vec<Vec<u8>>,
    /// Finish 命令先于 task-started 到达时挂起
    finish_pending: bool,
    task_id: String,
    done: bool,
}

impl QwenAdapter {
    pub fn new(params: AsrSessionParams) -> Self {
        Self {
            ws: None,
            params,
            started: false,
            queue: Vec::new(),
            finish_pending: false,
            task_id: uuid::Uuid::new_v4().simple().to_string(),
            done: false,
        }
    }

    fn ws_mut(&mut self) -> Option<&mut Ws> {
        self.ws.as_mut()
    }

    async fn send_text(&mut self, msg: serde_json::Value) -> Result<()> {
        use futures_util::SinkExt;
        self.ws
            .as_mut()
            .ok_or_else(|| ReinError::Message("ASR 连接未建立".into()))?
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| ReinError::Message(format!("Qwen ASR 发送失败：{e}")))
    }

    async fn send_run_task(&mut self) -> Result<()> {
        let msg = serde_json::json!({
            "headers": { "action": "run-task", "task_id": self.task_id, "streaming": "duplex" },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": self.params.model,
                "parameters": { "sample_rate": 16000, "format": "pcm" },
                "input": {},
            },
        });
        self.send_text(msg).await
    }

    async fn send_finish_task(&mut self) -> Result<()> {
        let msg = serde_json::json!({
            "headers": { "action": "finish-task", "task_id": self.task_id },
            "payload": { "input": {} },
        });
        self.send_text(msg).await
    }

    async fn flush_queue(&mut self) -> Result<()> {
        use futures_util::SinkExt;
        let queue = std::mem::take(&mut self.queue);
        for pcm in queue {
            self.ws
                .as_mut()
                .ok_or_else(|| ReinError::Message("ASR 连接未建立".into()))?
                .send(Message::Binary(pcm.into()))
                .await
                .map_err(|e| ReinError::Message(format!("Qwen ASR 发送失败：{e}")))?;
        }
        Ok(())
    }
}

impl AsrAdapter for QwenAdapter {
    async fn connect(&mut self) -> Result<()> {
        let mut req = self
            .params
            .url
            .clone()
            .into_client_request()
            .map_err(|e| ReinError::Message(format!("ASR 请求构造失败：{e}")))?;
        req.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {}", self.params.app_key))
                .map_err(|e| ReinError::Message(format!("鉴权头值非法：{e}")))?,
        );
        let (ws, _resp) = tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| ReinError::Message(format!("Qwen ASR 连接失败：{e}")))?;
        self.ws = Some(ws);
        self.send_run_task().await
    }

    async fn next_frame(&mut self) -> Option<Result<WsFrame>> {
        use futures_util::StreamExt;
        let ws = self.ws_mut()?;
        loop {
            match ws.next().await {
                Some(Ok(Message::Ping(p))) => {
                    use futures_util::SinkExt;
                    let _ = ws.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Text(t))) => return Some(Ok(WsFrame::Text(t.to_string()))),
                Some(Ok(Message::Binary(b))) => return Some(Ok(WsFrame::Binary(b.to_vec()))),
                Some(Ok(Message::Close(_))) | None => return None,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Some(Err(ReinError::Message(format!("Qwen ASR 连接中断：{e}")))),
            }
        }
    }

    async fn send_audio(&mut self, pcm: &[u8]) -> Result<()> {
        use futures_util::SinkExt;
        if !self.started {
            self.queue.push(pcm.to_vec());
            return Ok(());
        }
        self.ws
            .as_mut()
            .ok_or_else(|| ReinError::Message("ASR 连接未建立".into()))?
            .send(Message::Binary(pcm.to_vec().into()))
            .await
            .map_err(|e| ReinError::Message(format!("Qwen ASR 发送失败：{e}")))
    }

    async fn finish_input(&mut self) -> Result<()> {
        if !self.started {
            self.finish_pending = true;
            return Ok(());
        }
        self.send_finish_task().await
    }

    async fn on_frame(&mut self, frame: WsFrame) -> Result<Vec<NormEvent>> {
        let text = match frame {
            WsFrame::Text(t) => t,
            WsFrame::Binary(_) => return Ok(vec![]), // 识别无二进制下行
        };
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| ReinError::Message(format!("Qwen ASR 消息解析失败：{e}")))?;
        let event = v.get("header").and_then(|h| h.get("event")).and_then(|e| e.as_str()).unwrap_or("");
        match event {
            "task-started" => {
                self.started = true;
                self.flush_queue().await?;
                if self.finish_pending {
                    self.finish_pending = false;
                    self.send_finish_task().await?;
                }
                Ok(vec![])
            }
            "result-generated" => {
                let sentence = v.pointer("/payload/output/sentence");
                let text = sentence
                    .and_then(|s| s.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                if text.is_empty() {
                    return Ok(vec![]);
                }
                let begin = sentence.and_then(|s| s.get("begin_time")).and_then(|t| t.as_i64()).unwrap_or(0);
                let end = sentence.and_then(|s| s.get("end_time")).and_then(|t| t.as_i64());
                // 官方 SDK 判定：end_time 非 null 即句终（RecognitionResult::is_sentence_end）
                Ok(vec![match end {
                    Some(e) if e >= 0 => NormEvent::Final { text, start_ms: begin, end_ms: e },
                    _ => NormEvent::Partial { text, start_ms: begin },
                }])
            }
            "task-finished" => {
                self.done = true;
                Ok(vec![])
            }
            "task-failed" => {
                let code = v
                    .get("header")
                    .and_then(|h| h.get("error_code"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("unknown");
                let message = v
                    .get("header")
                    .and_then(|h| h.get("error_message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown");
                Err(ReinError::Message(format!("Qwen ASR 错误：{code} {message}")))
            }
            _ => Ok(vec![]),
        }
    }

    fn is_done(&self) -> bool {
        self.done
    }
}

/* ---------------- 枚举分发（不用 dyn：AFIT trait 非对象安全） ---------------- */

pub enum AnyAsrAdapter {
    Doubao(DoubaoAdapter),
    Qwen(QwenAdapter),
}

impl AsrAdapter for AnyAsrAdapter {
    async fn connect(&mut self) -> Result<()> {
        match self {
            Self::Doubao(a) => a.connect().await,
            Self::Qwen(a) => a.connect().await,
        }
    }

    async fn next_frame(&mut self) -> Option<Result<WsFrame>> {
        match self {
            Self::Doubao(a) => a.next_frame().await,
            Self::Qwen(a) => a.next_frame().await,
        }
    }

    async fn send_audio(&mut self, pcm: &[u8]) -> Result<()> {
        match self {
            Self::Doubao(a) => a.send_audio(pcm).await,
            Self::Qwen(a) => a.send_audio(pcm).await,
        }
    }

    async fn finish_input(&mut self) -> Result<()> {
        match self {
            Self::Doubao(a) => a.finish_input().await,
            Self::Qwen(a) => a.finish_input().await,
        }
    }

    async fn on_frame(&mut self, frame: WsFrame) -> Result<Vec<NormEvent>> {
        match self {
            Self::Doubao(a) => a.on_frame(frame).await,
            Self::Qwen(a) => a.on_frame(frame).await,
        }
    }

    fn is_done(&self) -> bool {
        match self {
            Self::Doubao(a) => a.is_done(),
            Self::Qwen(a) => a.is_done(),
        }
    }
}
