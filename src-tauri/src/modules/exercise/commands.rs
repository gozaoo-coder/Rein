//! 运动域命令 · 命令名与前端 `exerciseService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use chrono::Utc;

use super::models::Workout;
use super::{workout_from_row, WORKOUT_COLS};

#[tauri::command]
pub fn list_workouts(
    state: State<AppState>,
    start_date: String,
    end_date: String,
) -> Result<Vec<Workout>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts WHERE date BETWEEN ?1 AND ?2 \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([&start_date, &end_date], workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 全量记录（全部运动记录页）：不分日期范围，日期倒序。
#[tauri::command]
pub fn list_all_workouts(state: State<AppState>) -> Result<Vec<Workout>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([], workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_workout(
    state: State<AppState>,
    name: String,
    // 注意：IPC 参数用 workoutType 而非 type（避免原始标识符 r#type 的参数名转换问题）
    workout_type: String,
    date: String,
    start_min: Option<i64>,
    duration_min: f64,
    intensity: Option<String>,
    kcal: f64,
    note: Option<String>,
) -> Result<Workout> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, intensity, note, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            name,
            workout_type,
            date,
            start_min,
            duration_min,
            kcal,
            intensity.unwrap_or_else(|| "moderate".into()),
            note,
            Utc::now().to_rfc3339()
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {WORKOUT_COLS} FROM workouts WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], workout_from_row)?)
}

#[tauri::command]
pub fn delete_workout(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM workouts WHERE id = ?1", [id])?;
    Ok(())
}
