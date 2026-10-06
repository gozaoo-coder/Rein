//! LLM 后端抽象（kernel 对 LLM 的唯一边界，对应 pi 的 `StreamFn` seam）。
//!
//! 消息模型刻意保持「薄」：只表达 OpenAI Chat Completions 语义
//! （system / user / assistant / tool），工具参数以 `serde_json::Value` 传递，
//! 线格式由 [`wire`] 负责（`arguments` 字符串化、多模态 content 数组）。
//!
//! 契约（对齐 EffiBuddy `LlmBackend`）：`complete` 对网络 / HTTP / provider
//! 错误一律返回 `Err` 不 panic；`stream_complete` 增量实时经 `DeltaTx` 外发，
//! 返回值与 `complete` 同语义（聚合契约由后端保证）。
// Phase 1 只有探测（非流式）在用；流式链路的消费者是 Phase 2 的 agent 循环，
// 接入后移除本行。
#![allow(dead_code)]

pub mod compat;
pub mod http;
pub mod mock;
pub mod sse;
pub mod wire;

pub use compat::Compat;
pub use http::OpenAiCompatBackend;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// LLM 消息角色（OpenAI Chat Completions 语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmRole {
    System,
    User,
    Assistant,
    /// 工具执行结果（携带 `tool_call_id`）
    Tool,
}

/// LLM 工具调用块（挂在 assistant 消息内）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmToolCall {
    pub id: String,
    pub name: String,
    /// 工具参数（object 或 null）；线格式字符串化由后端负责
    pub arguments: serde_json::Value,
}

/// 消息携带的图片（base64 直传，无 `data:` 前缀 —— 前端落库的就是这个形态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageData {
    pub data: String,
    pub mime: String,
}

/// 发给 LLM 的单条消息
///
/// - assistant 消息带 `tool_calls` 表示「模型决定调用这些工具」
/// - tool 消息带 `tool_call_id` 表示「对应调用返回的结果」
/// - user 消息带 `images` 表示视觉输入；tool 消息带 `images` 表示工具结果附图
///   （线格式层会拆成 tool 文本 + 延迟落位的 user 多模态消息，防 DeepSeek 400）
/// - `reasoning` 是 assistant 的思考链，DeepSeek 回灌历史时转 `reasoning_content`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: LlmRole,
    #[serde(default)]
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tool_calls: Vec<LlmToolCall>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub images: Vec<ImageData>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning: Option<String>,
}

impl LlmMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::User,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
            images: Vec::new(),
            reasoning: None,
        }
    }

    pub fn user_with_images(content: impl Into<String>, images: Vec<ImageData>) -> Self {
        Self {
            images,
            ..Self::user(content)
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
            images: Vec::new(),
            reasoning: None,
        }
    }

    /// 模型发起工具调用的 assistant 消息（content 通常为空）
    pub fn assistant_with_calls(tool_calls: Vec<LlmToolCall>) -> Self {
        Self {
            tool_calls,
            ..Self::assistant(String::new())
        }
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Tool,
            content: content.into(),
            tool_call_id: Some(call_id.into()),
            tool_calls: Vec::new(),
            images: Vec::new(),
            reasoning: None,
        }
    }

    pub fn tool_with_images(
        call_id: impl Into<String>,
        content: impl Into<String>,
        images: Vec<ImageData>,
    ) -> Self {
        Self {
            images,
            ..Self::tool(call_id, content)
        }
    }
}

/// 工具定义（发给 LLM 的 JSON Schema 形状，对齐 OpenAI `tools[].function`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema（`{"type":"object","properties":...,"required":...}`）
    pub parameters: serde_json::Value,
}

/// 一次 completion 请求（循环每步构造；`thinking_level` 由后端按 compat 注入请求体）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<LlmToolDef>,
    /// 温度；None = 不发送，用 provider 默认
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub temperature: Option<f64>,
    /// 最大生成 token；None = 不发送。字段名（max_tokens vs max_completion_tokens）
    /// 按 compat 决定 —— 探测协议依赖这一点对齐 pi 行为
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_tokens: Option<u32>,
    /// 思考档：'off' | 'low' | 'medium' | 'high' …（前端入口现值就这两档 + 探测五档）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub thinking_level: Option<String>,
}

/// token 用量统计。`input` 口径对齐 pi-ai：prompt_tokens 扣除缓存命中/写入
/// （成本记账 `ai_usage` 的输入侧不重复计缓存 token）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    pub total: u64,
}

/// 流式增量事件：实时发布给 UI（前端逐 token 渲染）。
/// 刻意与「终稿」分离 —— 增量是纯 UI 通道，不进消息历史。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    Text(String),
    Reasoning(String),
}

/// 流式增量的发送端（loop 持有，后端逐块推送）
pub type DeltaTx = tokio::sync::mpsc::UnboundedSender<StreamDelta>;

/// 一次 completion 的响应
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmResponse {
    /// 最终文本（工具调用轮通常为空）
    pub content: String,
    /// 思考链（独立字段 / 内联 `<think>` 已归并）；provider 不支持时为 None
    pub reasoning: Option<String>,
    /// 模型发起的工具调用（空 = 本轮回复完成）
    pub tool_calls: Vec<LlmToolCall>,
    pub usage: Option<LlmUsage>,
}

impl LlmResponse {
    pub fn has_tool_calls(&self) -> bool {
        !self.tool_calls.is_empty()
    }
}

/// LLM 后端抽象：kernel 与 provider 之间的 seam
#[async_trait::async_trait]
pub trait LlmBackend: Send + Sync {
    /// 模型标识（日志 / 计费用）
    fn model(&self) -> &str;

    /// 发送一次 completion 请求
    async fn complete(&self, req: &LlmRequest) -> Result<LlmResponse>;

    /// 流式 completion：增量经 `tx` 实时发布，返回聚合后的完整响应。
    /// 默认实现退化为一次性 `complete`（非流式后端零成本兼容）。
    async fn stream_complete(&self, req: &LlmRequest, tx: DeltaTx) -> Result<LlmResponse> {
        let resp = self.complete(req).await?;
        if let Some(r) = &resp.reasoning {
            let _ = tx.send(StreamDelta::Reasoning(r.clone()));
        }
        if !resp.content.is_empty() {
            let _ = tx.send(StreamDelta::Text(resp.content.clone()));
        }
        Ok(resp)
    }
}
