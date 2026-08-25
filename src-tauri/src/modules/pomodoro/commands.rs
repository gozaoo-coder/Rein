//! 番茄钟域命令 · 命令名与前端 `pomodoroService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;

use super::models::{PomodoroSession, PomodoroSessionInput};

const COLS: &str = "id, todo_id, started_at, ended_at, focus_min, break_min, completed";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PomodoroSession> {
    Ok(PomodoroSession {
        id: row.get(0)?,
        todo_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        focus_min: row.get(4)?,
        break_min: row.get(5)?,
        completed: row.get::<_, i64>(6)? != 0,
    })
}

#[tauri::command]
pub fn save_pomodoro_session(
    state: State<AppState>,
    session: PomodoroSessionInput,
) -> Result<PomodoroSession> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO pomodoro_sessions (todo_id, started_at, ended_at, focus_min, break_min, completed) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            session.todo_id,
            session.started_at,
            session.ended_at,
            session.focus_min,
            session.break_min,
            session.completed as i64
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {COLS} FROM pomodoro_sessions WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 按 started_at 的日期部分（YYYY-MM-DD）过滤
#[tauri::command]
pub fn list_pomodoro_sessions(
    state: State<AppState>,
    start_date: String,
    end_date: String,
) -> Result<Vec<PomodoroSession>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM pomodoro_sessions \
         WHERE substr(started_at, 1, 10) BETWEEN ?1 AND ?2 ORDER BY started_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([&start_date, &end_date], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}
