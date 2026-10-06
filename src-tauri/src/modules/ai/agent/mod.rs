//! AI agent 内核：LLM 调用 + 工具循环从 WebView（pi-ai / pi-agent-core）整体下沉。
//!
//! 移植自 EffiBuddy 的 `effibuddy-core::kernel`（MIT，同作者仓库），按 Rein 的形态裁剪：
//! - 不移植 JSONL 账本：Rein 的持久化口径不变（`ai_chat_messages` 存 UI 记录，
//!   工具中间轮不跨会话回放，与前端 pi 行为一致），循环用每 run 内存消息表；
//! - 消息模型：`LlmMessage{role, content, tool_calls?, images(base64), reasoning?}`，
//!   图片直传 base64（前端已压缩落库），不像 EffiBuddy 那样按路径读盘；
//! - 请求线格式按 baseUrl 自动探测 compat（对齐 pi-ai `detectCompat` 的行为子集，
//!   见 [`llm::compat`]），DeepSeek 的 thinking/effort/max_tokens 特判是行为基准。
//!
//! 分层：
//! - [`llm`]：消息类型 + OpenAI 兼容后端（wire 线格式 / SSE 流解析 / HTTP 客户端）
//! - [`turn`]：agent 工具循环（工具执行走 [`turn::ToolExecutor`] 缝）
//! - [`hub`]：run 会话表 + 桥接期工具结果通道（早到缓冲 / 超时兜底）
//! - [`retry`]：瞬态错误退避决策（限流长退避，其他短退避）
//! - [`probe`]：max_tokens=1 六发能力探测（判定语义逐字对齐前端 `src/ai/probe.ts`）
//! - [`tools`]：Rust 侧工具注册表（渐进迁移，Rust 优先 / 未注册回退前端桥接）
//! - [`models`]：IPC 契约（run 入参 / 流式事件 / 工具结果）
//! - [`commands`]：Tauri 命令入口

pub mod commands;
pub mod hub;
pub mod llm;
pub mod turn;
pub mod models;
pub mod probe;
pub mod retry;
pub mod tools;

/// 真实 provider 冒烟（默认跳过）：见 smoke.rs 头注释的运行方式
#[cfg(test)]
mod smoke;
