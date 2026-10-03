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
    let conn = state.db.lock();
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
    let conn = state.db.lock();
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

/// 新增一条运动记录（手动补录）。
///
/// `effort` 是体感强度 1–5（手动补录专用）；课程/跑步走 `session_finish`，不经过这里。
/// `intensity` 在表上是 NOT NULL，由调用方从 effort 派生后传入（见 db.rs MIGRATION_0035）。
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
    effort: Option<i64>,
    kcal: f64,
    note: Option<String>,
) -> Result<Workout> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, intensity, effort, note, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            name,
            workout_type,
            date,
            start_min,
            duration_min,
            kcal,
            intensity.unwrap_or_else(|| "moderate".into()),
            effort,
            note,
            Utc::now().to_rfc3339()
        ],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {WORKOUT_COLS} FROM workouts WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], workout_from_row)?)
}

/// 删除一条运动记录。
///
/// 从迁移 0036 起，`workouts` 里可能混着两种记录，删除的语义不同（见
/// `modules/healthsync` 的模块说明）：
/// - 本地记录（`source = 'local'`）：本机说了算。若它已经导出到 Health Connect，
///   顺手把 HC 侧那份也收掉 —— 否则用户的「删除」在两个地方不一致。
/// - 导入记录（`source = 'health_connect'`）：HC 是权威，本机删**不动 HC 侧**
///   （那可能是别家 App 写进去的数据），只记一条墓碑，免得下次同步又拉回来。
#[tauri::command]
pub fn delete_workout(
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
    id: i64,
) -> Result<()> {
    use rusqlite::OptionalExtension;

    use crate::modules::healthsync::commands as health;

    let conn = state.db.lock();
    let link: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT source, external_id FROM workouts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    conn.execute("DELETE FROM workouts WHERE id = ?1", [id])?;

    if let Some((source, Some(external_id))) = link {
        if source == "health_connect" {
            health::add_tombstone(&conn, &external_id)?;
        } else if health::is_push_enabled(&conn) {
            drop(conn);
            // JNI 必须在锁外发（dispatch 会切到 WebView 主线程）
            health::propagate_delete(&webview, &external_id);
        }
    }
    Ok(())
}
