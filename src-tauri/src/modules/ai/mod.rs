//! AI 域：文字食物解析（本地关键词）/ 模型配置存储 / 聊天历史 / Rein 在线服务接入。
//!
//! - 文字解析仍为「关键词 + 数量词」本地解析器（无网络依赖）。
//! - 照片识别由前端 `src/ai/vision.ts` 用 pi-ai 直连视觉模型完成，不经 Rust。
//! - 模型配置（`ai_models`）与聊天历史（`ai_chats` / `ai_chat_messages`）
//!   仅做持久化，模型请求和 max_tokens=1 能力探测都在前端 WebView 内执行。
//! - `online.rs` 是 Rein 在线服务的客户端：用服务密钥换模型目录、按服务端清单落库、
//!   与服务端对账成本；本机账本（`ai_usage`）由前端按单价记，服务端账本为权威口径。

pub mod commands;
pub mod models;
pub mod online;
