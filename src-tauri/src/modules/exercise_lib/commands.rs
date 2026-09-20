//! 动作库命令 · 命令名与前端 `exerciseLibService.ts` 对应。

use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::models::{ExerciseInput, ExerciseRecord};
use super::{exercise_from_row, EXERCISE_SELECT};

const KINDS: [&str; 3] = ["strength", "timed", "cardio"];
const CATEGORIES: [&str; 7] = ["push", "pull", "legs", "core", "cardio", "mobility", "other"];
const EQUIPMENT: [&str; 8] = [
    "barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "cardio", "other",
];

/// 查询动作库：默认按「最近使用」倒序（未用过的按名称排后）。
/// 筛选条件都可缺省；`includeHidden` 打开时把用户隐藏的内置动作也带出来（管理用）。
#[tauri::command]
pub fn list_exercises(
    state: State<AppState>,
    kind: Option<String>,
    category: Option<String>,
    query: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<ExerciseRecord>> {
    let conn = state.db.lock().unwrap();
    let mut sql = String::from(EXERCISE_SELECT);
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if include_hidden != Some(true) {
        wheres.push("e.hidden = 0".into());
    }
    if let Some(k) = kind.filter(|s| !s.is_empty()) {
        wheres.push(format!("e.kind = ?{}", args.len() + 1));
        args.push(Box::new(k));
    }
    if let Some(c) = category.filter(|s| !s.is_empty()) {
        wheres.push(format!("e.category = ?{}", args.len() + 1));
        args.push(Box::new(c));
    }
    if let Some(q) = query.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        let idx = args.len() + 1;
        wheres.push(format!("(e.name LIKE '%' || ?{idx} || '%' OR e.aliases LIKE '%' || ?{idx} || '%')"));
        args.push(Box::new(q));
    }
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }
    sql.push_str(" ORDER BY (u.last_date IS NULL), u.last_date DESC, e.name");

    let mut stmt = conn.prepare(&sql)?;
    let list = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), exercise_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

#[tauri::command]
pub fn get_exercise(state: State<AppState>, id: String) -> Result<ExerciseRecord> {
    let conn = state.db.lock().unwrap();
    let sql = format!("{EXERCISE_SELECT} WHERE e.id = ?1");
    conn.query_row(&sql, [&id], exercise_from_row)
        .optional()?
        .ok_or_else(|| ReinError::Message(format!("动作不存在：{id}")))
}

/// 新建 / 更新自建动作。内置动作（is_custom=0）一律拒绝：先隐藏它，或另建自建动作。
#[tauri::command]
pub fn upsert_exercise(state: State<AppState>, input: ExerciseInput) -> Result<ExerciseRecord> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(ReinError::Message("动作名称不能为空".into()));
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(ReinError::Message(format!("未知的动作类型：{}", input.kind)));
    }
    if !CATEGORIES.contains(&input.category.as_str()) {
        return Err(ReinError::Message(format!("未知的动作分类：{}", input.category)));
    }
    if let Some(eq) = &input.equipment {
        if !eq.is_empty() && !EQUIPMENT.contains(&eq.as_str()) {
            return Err(ReinError::Message(format!("未知的器材：{eq}")));
        }
    }

    let conn = state.db.lock().unwrap();
    let id = match input.id.clone().filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => format!("custom-{}", uuid::Uuid::new_v4()),
    };

    let existing: Option<i64> = conn
        .query_row("SELECT is_custom FROM exercises WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .optional()?;
    if existing == Some(0) {
        return Err(ReinError::Message(
            "内置动作不可编辑：可以隐藏它，或另建一个自建动作".into(),
        ));
    }

    // 同名查重（名称或别名命中其它条目）：库里两条同名动作会让重量曲线分裂
    let dup: Option<String> = conn
        .query_row(
            "SELECT id FROM exercises WHERE id <> ?1 AND (name = ?2 \
             OR EXISTS (SELECT 1 FROM json_each(exercises.aliases) WHERE value = ?2)) LIMIT 1",
            params![id, name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(dup_id) = dup {
        return Err(ReinError::Message(format!(
            "已有同名动作「{name}」（id={dup_id}），请直接使用它"
        )));
    }

    let aliases = serde_json::to_string(&input.aliases)?;
    conn.execute(
        "INSERT INTO exercises \
         (id, name, aliases, kind, category, equipment, muscles, tips, default_sets, default_reps, \
          default_weight_kg, default_target_sec, default_duration_min, default_rest_sec, weight_step, \
          is_custom, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, \
                 datetime('now'), datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, aliases = excluded.aliases, kind = excluded.kind, \
           category = excluded.category, equipment = excluded.equipment, muscles = excluded.muscles, \
           tips = excluded.tips, default_sets = excluded.default_sets, \
           default_reps = excluded.default_reps, default_weight_kg = excluded.default_weight_kg, \
           default_target_sec = excluded.default_target_sec, \
           default_duration_min = excluded.default_duration_min, \
           default_rest_sec = excluded.default_rest_sec, weight_step = excluded.weight_step, \
           updated_at = datetime('now') \
         WHERE exercises.is_custom = 1",
        params![
            id,
            name,
            aliases,
            input.kind,
            input.category,
            input.equipment.filter(|s| !s.is_empty()),
            input.muscles.to_string(),
            input.tips.trim(),
            input.default_sets.max(1),
            input.default_reps.filter(|v| *v > 0),
            input.default_weight_kg.filter(|v| *v >= 0.0),
            input.default_target_sec.filter(|v| *v > 0),
            input.default_duration_min.filter(|v| *v > 0),
            input.default_rest_sec.max(0),
            input.weight_step.max(0.0),
        ],
    )?;

    let sql = format!("{EXERCISE_SELECT} WHERE e.id = ?1");
    conn.query_row(&sql, [&id], exercise_from_row)
        .optional()?
        .ok_or_else(|| ReinError::Message("动作写入失败".into()))
}

/// 删除动作：自建动作真删（历史做组记录保留，展示回落快照名）；内置动作只做隐藏。
#[tauri::command]
pub fn delete_exercise(state: State<AppState>, id: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    let is_custom: Option<i64> = conn
        .query_row("SELECT is_custom FROM exercises WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .optional()?;
    match is_custom {
        None => Err(ReinError::Message(format!("动作不存在：{id}"))),
        Some(0) => {
            conn.execute(
                "UPDATE exercises SET hidden = 1, updated_at = datetime('now') WHERE id = ?1",
                [&id],
            )?;
            Ok(())
        }
        Some(_) => {
            conn.execute("DELETE FROM exercises WHERE id = ?1", [&id])?;
            Ok(())
        }
    }
}

/// 恢复显示被隐藏的内置动作
#[tauri::command]
pub fn restore_exercise(state: State<AppState>, id: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE exercises SET hidden = 0, updated_at = datetime('now') WHERE id = ?1",
        [&id],
    )?;
    Ok(())
}
