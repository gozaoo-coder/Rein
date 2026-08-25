//! 待办域命令 · 命令名与前端 `todoService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use chrono::Utc;

use super::models::Todo;

const COLS: &str =
    "id, title, notes, date, start_min, duration_min, category, priority, status, completed_at, created_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: row.get(0)?,
        title: row.get(1)?,
        notes: row.get(2)?,
        date: row.get(3)?,
        start_min: row.get(4)?,
        duration_min: row.get(5)?,
        category: row.get(6)?,
        priority: row.get(7)?,
        status: row.get(8)?,
        completed_at: row.get(9)?,
        created_at: row.get(10)?,
    })
}

#[tauri::command]
pub fn list_todos(state: State<AppState>, start_date: String, end_date: String) -> Result<Vec<Todo>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM todos \
         WHERE date IS NOT NULL AND date BETWEEN ?1 AND ?2 \
         ORDER BY date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([&start_date, &end_date], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
/// 全部待办（含收件箱 date IS NULL），按 未完成→日期→时间→优先级 排序。
/// 供「全部待办」页与虚拟时间线使用。
pub fn list_all_todos(state: State<AppState>) -> Result<Vec<Todo>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM todos \
         ORDER BY (status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_todo(
    state: State<AppState>,
    title: String,
    notes: Option<String>,
    date: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: Option<String>,
    priority: Option<i64>,
) -> Result<Todo> {
    let conn = state.db.lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let category = category.unwrap_or_else(|| "general".into());
    conn.execute(
        "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![title, notes, date, start_min, duration_min, category, priority.unwrap_or(0), now],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 全量更新（前端持有完整对象；避免设计 patch 合并逻辑）。
#[tauri::command]
pub fn update_todo(state: State<AppState>, todo: Todo) -> Result<Todo> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE todos SET title = ?1, notes = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         category = ?6, priority = ?7, status = ?8, completed_at = ?9 WHERE id = ?10",
        rusqlite::params![
            todo.title,
            todo.notes,
            todo.date,
            todo.start_min,
            todo.duration_min,
            todo.category,
            todo.priority,
            todo.status,
            todo.completed_at,
            todo.id
        ],
    )?;
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [todo.id], from_row)?)
}

#[tauri::command]
pub fn delete_todo(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
    Ok(())
}
