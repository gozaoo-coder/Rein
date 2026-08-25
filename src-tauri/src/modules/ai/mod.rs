//! AI 域：文字食物解析（本地关键词）/ 模型配置存储 / 聊天历史。
//!
//! - 文字解析仍为「关键词 + 数量词」本地解析器（无网络依赖）。
//! - 照片识别由前端 `src/ai/vision.ts` 用 pi-ai 直连视觉模型完成，不经 Rust。
//! - 模型配置（`ai_models`）与聊天历史（`ai_chats` / `ai_chat_messages`）
//!   仅做持久化，模型请求和 max_tokens=1 能力探测都在前端 WebView 内执行。

pub mod commands;
pub mod models;
