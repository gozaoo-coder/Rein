//! Web 抓取域：为 AI 提供 web_search / web_fetch 工具的后端。
//! 在 Rust 侧完成 HTTP 请求（WebView 内 JS fetch 会被 CORS 拦掉），
//! HTML 转纯文本后返回给模型，默认搜索引擎为必应。

pub mod commands;
