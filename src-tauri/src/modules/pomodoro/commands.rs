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
    let conn = state.db.lock();
    save_pomodoro_session_on(&conn, &session)
}

/// `save_pomodoro_session` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
pub(crate) fn save_pomodoro_session_on(
    conn: &rusqlite::Connection,
    session: &PomodoroSessionInput,
) -> Result<PomodoroSession> {
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
    let conn = state.db.lock();
    list_pomodoro_sessions_on(&conn, &start_date, &end_date)
}

/// `list_pomodoro_sessions` 的本体（见 [`save_pomodoro_session_on`]）。
pub(crate) fn list_pomodoro_sessions_on(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<PomodoroSession>> {
    let sql = format!(
        "SELECT {COLS} FROM pomodoro_sessions \
         WHERE substr(started_at, 1, 10) BETWEEN ?1 AND ?2 ORDER BY started_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([start_date, end_date], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 `list_pomodoro_sessions`（contract §6.4「禁止无界全表」）。
pub(crate) fn list_pomodoro_sessions_on_limited(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
    limit: i64,
) -> Result<Vec<PomodoroSession>> {
    let sql = format!(
        "SELECT {COLS} FROM pomodoro_sessions \
         WHERE substr(started_at, 1, 10) BETWEEN ?1 AND ?2 ORDER BY started_at LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map((start_date, end_date, limit), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pomodoro::models::PomodoroSessionInput;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// 对外网关专用的 LIMIT 变体：SQL 侧限行（contract §6.4）。
    #[test]
    fn list_pomodoro_sessions_on_limited_caps_rows_in_sql() {
        let conn = fresh();
        for i in 0..5 {
            save_pomodoro_session_on(
                &conn,
                &PomodoroSessionInput {
                    todo_id: None,
                    started_at: format!("2026-09-23T09:{i:02}:00Z"),
                    ended_at: format!("2026-09-23T09:{i:02}:30Z"),
                    focus_min: 25.0,
                    break_min: 5.0,
                    completed: true,
                },
            )
            .unwrap();
        }
        assert_eq!(
            list_pomodoro_sessions_on(&conn, "2026-09-01", "2026-09-30").unwrap().len(),
            5
        );
        assert_eq!(
            list_pomodoro_sessions_on_limited(&conn, "2026-09-01", "2026-09-30", 2)
                .unwrap()
                .len(),
            2,
            "LIMIT 生效"
        );
    }
}
