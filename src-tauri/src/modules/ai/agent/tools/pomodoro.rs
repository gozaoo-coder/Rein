//! 番茄钟域工具（对应 TS tools/pomodoro.ts）：补记与区间查询。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::Result;
use crate::modules::pomodoro::commands as pomo;
use crate::modules::pomodoro::models::PomodoroSessionInput;
use crate::state::AppState;

use super::{num_arg, resolve_date, RegisteredTool};

/// 本地日期偏移（对齐 TS addDays）
fn add_days(days: i64) -> String {
    (chrono::Local::now() + chrono::Duration::days(days)).format("%Y-%m-%d").to_string()
}

/// 分派；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    Some(match name {
        "save_pomodoro" => {
            let focus_min = num_arg(args, "focusMin", 0.0);
            let ended = chrono::Utc::now().to_rfc3339();
            let started = (chrono::Utc::now() - chrono::Duration::minutes(focus_min as i64)).to_rfc3339();
            let state = app.state::<AppState>();
            let row = pomo::save_pomodoro_session(
                &state,
                PomodoroSessionInput {
                    todo_id: args.get("todoId").and_then(|v| v.as_i64()),
                    started_at: started,
                    ended_at: ended,
                    focus_min,
                    break_min: args.get("breakMin").and_then(|v| v.as_f64()).unwrap_or(5.0),
                    completed: args.get("completed").and_then(|v| v.as_bool()).unwrap_or(true),
                },
            )?;
            Ok(json!({ "ok": true, "id": row.id }))
        }
        "list_pomodoros" => {
            let start = match args.get("start").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                Some(_) => resolve_date(args, "start")?,
                None => add_days(-6),
            };
            let end = resolve_date(args, "end")?;
            let state = app.state::<AppState>();
            let rows = pomo::list_pomodoro_sessions(&state, start, end)?;
            let mut total_focus = 0f64;
            let sessions: Vec<Value> = rows
                .iter()
                .map(|r| {
                    total_focus += r.focus_min;
                    json!({
                        "id": r.id, "todoId": r.todo_id, "startedAt": r.started_at,
                        "focusMin": r.focus_min, "completed": r.completed,
                    })
                })
                .collect();
            Ok(json!({ "count": sessions.len(), "totalFocusMin": total_focus, "sessions": sessions }))
        }
        _ => return None,
    })
}

pub fn defs() -> Vec<RegisteredTool> {
    vec![
        RegisteredTool {
            name: "save_pomodoro",
            group: "pomodoro",
            label: "补记番茄钟",
            description: "补记一段专注（默认按 focusMin 倒推结束时间为现在）。通常只在用户说明离线完成了一段专注时使用。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "focusMin": { "type": "number", "description": "专注时长（分钟）" },
                    "breakMin": { "type": "number", "description": "休息时长（分钟），默认 5" },
                    "todoId": { "type": "number", "description": "关联的待办 id" },
                    "completed": { "type": "boolean", "description": "是否完整完成，默认 true" }
                },
                "required": ["focusMin"]
            }),
        },
        RegisteredTool {
            name: "list_pomodoros",
            group: "pomodoro",
            label: "查看番茄钟记录",
            description: "查看某日期区间的番茄钟记录。区间不传默认最近 7 天。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "start": { "type": "string", "description": "起始 YYYY-MM-DD，缺省为 6 天前" },
                    "end": { "type": "string", "description": "结束 YYYY-MM-DD，缺省为今天" }
                }
            }),
        },
    ]
}
