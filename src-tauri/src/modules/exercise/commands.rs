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
    list_workouts_on(&conn, &start_date, &end_date)
}

/// `list_workouts` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
pub(crate) fn list_workouts_on(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<Workout>> {
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts WHERE date BETWEEN ?1 AND ?2 \
         ORDER BY date DESC, (start_min IS NULL), start_min"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([start_date, end_date], workout_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 对外网关专用：带 SQL 侧 `LIMIT` 的 `list_workouts`（contract §6.4「禁止无界全表」）。
pub(crate) fn list_workouts_on_limited(
    conn: &rusqlite::Connection,
    start_date: &str,
    end_date: &str,
    limit: i64,
) -> Result<Vec<Workout>> {
    let sql = format!(
        "SELECT {WORKOUT_COLS} FROM workouts WHERE date BETWEEN ?1 AND ?2 \
         ORDER BY date DESC, (start_min IS NULL), start_min LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map((start_date, end_date, limit), workout_from_row)?
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
    create_workout_on(
        &conn,
        name,
        workout_type,
        date,
        start_min,
        duration_min,
        intensity,
        effort,
        kcal,
        note,
    )
}

/// `create_workout` 的本体：收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用
/// （网关拿的是同一把 `state.db.lock()`，见 contract §6.1 单连接铁律）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_workout_on(
    conn: &rusqlite::Connection,
    name: String,
    workout_type: String,
    date: String,
    start_min: Option<i64>,
    duration_min: f64,
    intensity: Option<String>,
    effort: Option<i64>,
    kcal: f64,
    note: Option<String>,
) -> Result<Workout> {
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
    app: tauri::AppHandle,
    state: State<AppState>,
    id: i64,
) -> Result<()> {
    use crate::modules::healthsync::commands as health;

    let conn = state.db.lock();
    let propagate = delete_workout_on(&conn, id)?;
    if let Some(external_id) = propagate {
        drop(conn);
        // JNI 必须在锁外发（dispatch 会切到 WebView 主线程）；传 AppHandle，
        // 与网关照到的删除共用同一条传播路径（contract §13.3）。
        health::propagate_delete(&app, &external_id);
    }
    Ok(())
}

/// `delete_workout` 的本体：删行 + 按 `source` 决定 HC 语义，返回**需要传播删除**的
/// `external_id`（`Some` = 本地记录且已导出、且回写开关开）。
///
/// 收 `&Connection` 而不是 `State`，供 tauri 命令与对外网关共用（contract §6.1 单连接铁律）。
/// **传播在锁外由调用方触发**：网关侧无 `Webview`，只能拿到这个返回值（contract §13.3）。
pub(crate) fn delete_workout_on(
    conn: &rusqlite::Connection,
    id: i64,
) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;

    use crate::modules::healthsync::commands as health;

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
            health::add_tombstone(conn, &external_id)?;
        } else if health::is_push_enabled(conn) {
            // 本地记录 + 回写开：把 externalId 交回调用方，由它在锁外传播删除
            return Ok(Some(external_id));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// 对外网关专用的 LIMIT 变体：SQL 侧限行（contract §6.4）。
    #[test]
    fn list_workouts_on_limited_caps_rows_in_sql() {
        let conn = fresh();
        for i in 0..5 {
            create_workout_on(
                &conn,
                format!("w{i}"),
                "run".into(),
                "2026-09-23".into(),
                None,
                30.0,
                None,
                None,
                100.0,
                None,
            )
            .unwrap();
        }
        assert_eq!(
            list_workouts_on(&conn, "2026-09-01", "2026-09-30").unwrap().len(),
            5
        );
        assert_eq!(
            list_workouts_on_limited(&conn, "2026-09-01", "2026-09-30", 2)
                .unwrap()
                .len(),
            2,
            "LIMIT 生效"
        );
    }
}
