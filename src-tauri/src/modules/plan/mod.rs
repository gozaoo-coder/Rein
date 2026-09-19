//! 训练课程域：用户可编辑的课程（计划）CRUD 与「最近使用」维护。
//!
//! 课程是用户数据（首启种子来自 `resources/workout_plans.json`）；
//! 动作数组结构由前端 TS 类型约束，Rust 侧按 JSON 原样透传。

pub mod commands;
pub mod models;

use rusqlite::Row;
use serde_json::Value;

use crate::error::Result;
use models::PlanRecord;

/// workout_plans 表列清单（SELECT 时必须使用，保证行映射下标稳定）
pub(crate) const PLAN_COLS: &str =
    "id, name, subtitle, workout_type, exercises_json, last_used_at, \
     created_at, updated_at, equipment, est_duration_min";

pub(crate) fn plan_from_row(row: &Row<'_>) -> rusqlite::Result<PlanRecord> {
    let exercises: String = row.get(4)?;
    Ok(PlanRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        subtitle: row.get(2)?,
        workout_type: row.get(3)?,
        exercises: serde_json::from_str(&exercises).unwrap_or(Value::Null),
        last_used_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        // 器械要求与预估时长是内置课程 meta：用户编辑课程不提供这两个字段（保持 NULL）
        equipment: row.get(8)?,
        est_duration_min: row.get(9)?,
    })
}

pub(crate) fn plan_by_id(conn: &rusqlite::Connection, id: &str) -> Result<PlanRecord> {
    let sql = format!("SELECT {PLAN_COLS} FROM workout_plans WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], plan_from_row)?)
}
