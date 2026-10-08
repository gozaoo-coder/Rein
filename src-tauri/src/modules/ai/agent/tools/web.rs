//! web 域：联网搜索与抓取（`web_search` / `web_fetch`，对应 TS tools/web.ts）。
//! 抓取本体在 modules/web（ureq，绕开 WebView CORS），这里只做入参换算与投影。

use serde_json::json;
use serde_json::Value;

use crate::error::Result;
use crate::modules::web::commands::{web_fetch, web_search};

use super::RegisteredTool;

pub const WEB_SEARCH_NAME: &str = "web_search";
pub const WEB_FETCH_NAME: &str = "web_fetch";

pub fn web_search_def() -> RegisteredTool {
    RegisteredTool {
        name: WEB_SEARCH_NAME,
    group: "web",
    label: "联网搜索",
    description: "用必应搜索网页，返回结果列表（每条含标题、可点击的真实链接、摘要）。应用数据之外的事实都先用它查：食物营养与配料表、品牌/连锁餐品规格、菜谱做法与配比、时效性信息、拿不准的名词。关键词写具体（「杨枝甘露 每100g 热量」优于「杨枝甘露」）；拿到链接后用 web_fetch 读正文再下结论。",
    parameters: json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "搜索关键词，尽量具体（如「可乐 每100g 热量」）" },
            "maxChars": { "type": "number", "description": "最多返回字符数，默认 6000" }
        },
            "required": ["query"]
        }),
    }
}

pub fn web_fetch_def() -> RegisteredTool {
    RegisteredTool {
        name: WEB_FETCH_NAME,
    group: "web",
    label: "抓取网页",
    description: "抓取任意 http/https 页面并转成纯文本。用于阅读 web_search 结果里具体某一条的全文（优先选权威来源：官方营养标签、百科、专业站），或用户给出的网址内容。",
    parameters: json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "完整网址，如 https://www.example.com/page" },
            "maxChars": { "type": "number", "description": "最多返回字符数，默认 6000" }
        },
            "required": ["url"]
        }),
    }
}

/// 本模块负责执行的名字（测试用它断言「注册表 ⊆ 各域认领」）。
pub fn handles(name: &str) -> bool {
    name == WEB_SEARCH_NAME || name == WEB_FETCH_NAME
}

/// 执行：search 投影带 engine 标记，fetch 带 contentType（与 TS 版字段一致）
pub(super) async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Result<Value> {
    let _ = app; // web 抓取无状态，签名留 app 以便未来需要
    run_impl(name, args).await
}

/// 无 app 依赖的实现体（冒烟测试直接驱动：真实模型 → 注册表 → 真实抓取）
pub(crate) async fn run_impl(name: &str, args: &Value) -> Result<Value> {
    let max_chars = Some(super::num_arg(args, "maxChars", 6000.0) as usize);
    if name == WEB_SEARCH_NAME {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let r = web_search(query, max_chars).await?;
        Ok(json!({ "engine": "bing", "url": r.url, "text": r.text, "truncated": r.truncated }))
    } else {
        let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let r = web_fetch(url, max_chars).await?;
        Ok(json!({ "url": r.url, "contentType": r.content_type, "text": r.text, "truncated": r.truncated }))
    }
}
