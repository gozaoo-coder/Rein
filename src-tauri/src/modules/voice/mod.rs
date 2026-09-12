//! 语音对话域（豆包 ASR + TTS）：配置存储、流式识别会话、纪要持久化。
//!
//! 职责边界：Rust 负责需要自定义鉴权头的 WS/HTTP 连接（浏览器 WebSocket 带不了
//! X-Api-* 头）与音频文件落盘；纪要的生成（LLM）在前端 ai/memoGen.ts。

pub mod asr;
pub mod commands;
pub mod models;
pub mod protocol;
