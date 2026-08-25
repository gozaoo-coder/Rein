//! 运动域：训练记录。消耗大卡由前端按 MET × 体重估算后写入。

pub mod commands;
pub mod models;

use rusqlite::Row;

use crate::error::Result;
use models::Workout;

/// workouts 表列清单（SELECT 时必须使用，保证行映射下标稳定）
pub(crate) const WORKOUT_COLS: &str =
    "id, name, type, date, start_min, duration_min, kcal, intensity, note, session_id, created_at";

pub(crate) fn workout_from_row(row: &Row<'_>) -> rusqlite::Result<Workout> {
    Ok(Workout {
        id: row.get(0)?,
        name: row.get(1)?,
        r#type: row.get(2)?,
        date: row.get(3)?,
        start_min: row.get(4)?,
        duration_min: row.get(5)?,
        kcal: row.get(6)?,
        intensity: row.get(7)?,
        note: row.get(8)?,
        session_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

/// 按 id 读取一条训练记录（供其他模块复用，如 session_finish）
pub(crate) fn workout_by_id(conn: &rusqlite::Connection, id: i64) -> Result<Workout> {
    let sql = format!("SELECT {WORKOUT_COLS} FROM workouts WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], workout_from_row)?)
}
