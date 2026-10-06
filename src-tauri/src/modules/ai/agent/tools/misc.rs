//! context 域：跨会话检索全部历史聊天（`search_history`，对应 TS tools/misc.ts）。

use serde_json::json;
use serde_json::Value;
use tauri::Manager;

use crate::error::Result;
use crate::modules::ai::commands::chat_search_conn;
use crate::state::AppState;

use super::RegisteredTool;

pub const SEARCH_HISTORY_NAME: &str = "search_history";

pub fn search_history() -> RegisteredTool {
    RegisteredTool {
        name: SEARCH_HISTORY_NAME,
        group: "context",
        label: "搜索历史聊天",
        description: "跨所有会话搜索 Rein 的全部历史聊天记录。用户问「我之前/上次说过什么」或需要回忆历史内容时调用。",
        parameters: json!({
            "type": "object",
            "properties": {
                "keyword": { "type": "string", "description": "搜索关键词" },
                "limit": { "type": "number", "description": "最多返回条数，默认 8" }
            },
            "required": ["keyword"]
        }),
    }
}

/// 执行：与 TS 版同一投影（chat/role/at/text 截 200 字）
pub(super) async fn run(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let keyword = args.get("keyword").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let limit = super::num_arg(args, "limit", 8.0);
    let limit = Some((limit.clamp(1.0, 30.0)) as i64);
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    let hits = chat_search_conn(&conn, &keyword, limit)?;
    drop(conn);
    let projection: Vec<Value> = hits
        .iter()
        .map(|h| {
            json!({
                "chat": h.chat_title,
                "role": h.role,
                "at": h.created_at,
                "text": h.text.as_deref().unwrap_or("").chars().take(200).collect::<String>(),
            })
        })
        .collect();
    Ok(json!(projection))
}
