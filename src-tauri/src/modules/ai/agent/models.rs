//! agent 内核的 IPC 契约：run 入参、流式事件、工具结果。
//!
//! 事件名 `ai://agent`（仿 `voice://asr` / `kb://index` 先例），载荷自带
//! `runId` 供前端按会话过滤；`type` 为 camelCase 判别标签。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::llm::{ImageData, LlmToolDef, LlmUsage};

/// 一次 agent run 的入参（`ai_agent_run`）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunParams {
    /// 模型主键（base_url / api_key / model_id 从 ai_models 读）
    pub model_id: i64,
    /// 系统提示词（含动态注入的日期与工具清单）
    pub system_prompt: Option<String>,
    /// 历史消息（仅 user/assistant 文本与图片；工具中间轮不回放）
    #[serde(default)]
    pub messages: Vec<super::llm::LlmMessage>,
    /// 本轮用户输入
    pub prompt: String,
    /// 本轮用户附带的图片（base64）
    #[serde(default)]
    pub images: Vec<ImageData>,
    /// 工具定义（过渡期由前端提供；Phase 4 起可留空由 Rust 注册表填）
    #[serde(default)]
    pub tools: Vec<LlmToolDef>,
    /// 思考档：'off' | 'low' | …
    #[serde(default)]
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// 工具的最终结果（执行方：过渡期为前端桥接，Phase 4 起为 Rust 注册表）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
    /// 工具结果附图（放大镜等）
    #[serde(default)]
    pub images: Vec<ImageData>,
}

impl ToolOutcome {
    pub fn ok(content: impl Into<String>) -> Self {
        Self { content: content.into(), is_error: false, images: Vec::new() }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self { content: content.into(), is_error: true, images: Vec::new() }
    }
}

/// 流式事件（`app.emit("ai://agent", …)`）。
/// `rename_all` 管变体名，`rename_all_fields` 管字段名（run_id → runId 等）——
/// 漏掉后者时前端按 runId 认领会全数丢弃（真机联调踩过的坑）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// run 已启动（前端据此把气泡切到流式态）
    Started { run_id: String },
    /// 正文增量
    TextDelta { run_id: String, delta: String },
    /// 思考增量
    ThinkingDelta { run_id: String, delta: String },
    /// 单步思考结束：该步累计思考全文（对齐 pi 的 thinking_end 契约）
    ThinkingEnd { run_id: String, content: String },
    /// 某步因瞬态错误重试：前端应重置本步的文本/思考累积，避免重复显示
    StepRetry { run_id: String, attempt: u32, delay_ms: u64 },
    /// 模型请求执行工具（过渡期＝前端立即执行；Rust 工具期＝即将开始执行）
    ToolStarted { run_id: String, call_id: String, name: String, args: Value },
    /// 工具执行完成
    ToolCompleted {
        run_id: String,
        call_id: String,
        name: String,
        is_error: bool,
        content: String,
    },
    /// 单次 completion 的 token 用量
    Usage { run_id: String, usage: LlmUsage },
    /// 整轮结束
    Done {
        run_id: String,
        text: String,
        thinking: Option<String>,
        usage: Option<LlmUsage>,
        stop_reason: String,
        steps: u32,
        tools: u32,
        duration_ms: u64,
    },
    /// 整轮失败
    Error { run_id: String, message: String },
}

/// 事件名常量（`AppHandle::emit` 与前端 `listen` 必须一致）
pub const AGENT_EVENT: &str = "ai://agent";
