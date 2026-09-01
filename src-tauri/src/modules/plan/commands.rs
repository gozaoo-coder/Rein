//! 训练课程命令 · 命令名与前端 `planService.ts` 对应。

use tauri::State;

use crate::error::{ReinError, Result};
use crate::modules::seed::{plan_seed_keep, plan_seed_migrate, plan_seed_override, plan_seed_status, PlanSeedStatus};
use crate::state::AppState;

use super::models::{PlanInput, PlanRecord};
use super::{plan_by_id, plan_from_row, PLAN_COLS};

/// 内置课程种子升级状态（前端据此决定是否弹「新版本」横幅）
#[tauri::command]
pub fn plan_seed_status_cmd(state: State<AppState>) -> Result<PlanSeedStatus> {
    let conn = state.db.lock().unwrap();
    plan_seed_status(&conn)
}

/// 兼容合并：把新种子内容按动作字段级合并进本地内置课，绝不覆盖用户设置。
/// 仅当确实有待升级的种子时执行，否则幂等返回当前状态。
#[tauri::command]
pub fn apply_plan_seed_migrate(state: State<AppState>) -> Result<PlanSeedStatus> {
    let conn = state.db.lock().unwrap();
    let status = plan_seed_status(&conn)?;
    if status.current_version >= status.latest_version {
        return Ok(status);
    }
    plan_seed_migrate(&conn)?;
    plan_seed_status(&conn)
}

/// 使用新版本：按 id 把本地内置课内容整体替换为新种子。
#[tauri::command]
pub fn apply_plan_seed_override(state: State<AppState>) -> Result<PlanSeedStatus> {
    let conn = state.db.lock().unwrap();
    let status = plan_seed_status(&conn)?;
    if status.current_version >= status.latest_version {
        return Ok(status);
    }
    plan_seed_override(&conn)?;
    plan_seed_status(&conn)
}

/// 保留我的：本版本不再刷新内置课内容，只结清版本提示。
#[tauri::command]
pub fn apply_plan_seed_keep(state: State<AppState>) -> Result<PlanSeedStatus> {
    let conn = state.db.lock().unwrap();
    let status = plan_seed_status(&conn)?;
    if status.current_version >= status.latest_version {
        return Ok(status);
    }
    plan_seed_keep(&conn)?;
    plan_seed_status(&conn)
}

/// 课程列表：最近使用的在前（未用过的按更新时间排后）
#[tauri::command]
pub fn list_workout_plans(state: State<AppState>) -> Result<Vec<PlanRecord>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {PLAN_COLS} FROM workout_plans \
         ORDER BY (last_used_at IS NULL), last_used_at DESC, updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map([], plan_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

#[tauri::command]
pub fn get_workout_plan(state: State<AppState>, id: String) -> Result<PlanRecord> {
    let conn = state.db.lock().unwrap();
    plan_by_id(&conn, &id)
}

/// 新建或整体更新一门课程（前端每次提交全量字段）。
/// equipment / est_duration_min 是内置课程 meta，编辑器不提供：缺省时 COALESCE 保留原值。
#[tauri::command]
pub fn upsert_workout_plan(state: State<AppState>, input: PlanInput) -> Result<PlanRecord> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(ReinError::Message("课程名称不能为空".into()));
    }
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO workout_plans (id, name, subtitle, workout_type, exercises_json, equipment, est_duration_min, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, subtitle = excluded.subtitle, \
           workout_type = excluded.workout_type, exercises_json = excluded.exercises_json, \
           equipment = COALESCE(excluded.equipment, workout_plans.equipment), \
           est_duration_min = COALESCE(excluded.est_duration_min, workout_plans.est_duration_min), \
           updated_at = datetime('now')",
        rusqlite::params![
            input.id,
            name,
            input.subtitle.trim(),
            input.workout_type,
            input.exercises.to_string(),
            input.equipment,
            input.est_duration_min,
        ],
    )?;
    plan_by_id(&conn, &input.id)
}

#[tauri::command]
pub fn delete_workout_plan(state: State<AppState>, id: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM workout_plans WHERE id = ?1", [&id])?;
    Ok(())
}

/// 标记「最近使用」：每次以该课程开始训练时调用
#[tauri::command]
pub fn touch_workout_plan(state: State<AppState>, id: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE workout_plans SET last_used_at = datetime('now'), updated_at = datetime('now') \
         WHERE id = ?1",
        [&id],
    )?;
    Ok(())
}
