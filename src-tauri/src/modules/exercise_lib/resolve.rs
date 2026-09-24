//! 名称 → 动作库 id 的解析，以及存量数据的幂等回填。
//!
//! 归一化的关键一步：老库里的课程条目与做组记录只有动作名，没有库 id。
//! `backfill_exercise_refs` 在启动种子之后跑一次，把两者都挂到库上；匹配不到的
//! 名字会**自动建成自建动作**（`is_custom=1`），因此任何自由命名的历史动作都不会丢。

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::Result;

/// 名称索引：库内全部 name 与 aliases → id。
///
/// 整表载入内存做精确匹配（几十到几百行），刻意不用 SQL LIKE —— aliases 是 JSON
/// 文本，子串匹配会把「卧推」误命中「上斜哑铃卧推」这类包含关系。
pub struct NameIndex {
    map: HashMap<String, String>,
}

impl NameIndex {
    pub fn load(conn: &Connection) -> Result<NameIndex> {
        let mut map = HashMap::new();
        let mut stmt = conn.prepare("SELECT id, name, aliases FROM exercises")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name, aliases) in rows {
            map.entry(normalize(&name)).or_insert_with(|| id.clone());
            for a in serde_json::from_str::<Vec<String>>(&aliases).unwrap_or_default() {
                map.entry(normalize(&a)).or_insert_with(|| id.clone());
            }
        }
        Ok(NameIndex { map })
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.map.get(&normalize(name)).map(|s| s.as_str())
    }

    fn insert(&mut self, name: &str, id: &str) {
        self.map.insert(normalize(name), id.to_string());
    }
}

/// 名称规范化：去空白 + 小写（中文无大小写，主要挡全角空格与首尾空白）
fn normalize(name: &str) -> String {
    name.trim().to_lowercase()
}

/// 新建自建动作时的默认值来源（课程条目的处方 / 历史做组记录的重量）
#[derive(Debug, Default, Clone)]
pub struct ExerciseHint {
    pub kind: Option<String>,
    pub sets: Option<i64>,
    pub reps: Option<i64>,
    pub weight_kg: Option<f64>,
    pub target_sec: Option<i64>,
    pub duration_min: Option<i64>,
    pub rest_sec: Option<i64>,
    pub tips: Option<String>,
    /// 课程条目上的显式肌群表（AI 写入）：按名建库时带进库记录，
    /// 否则同一动作在课程里显示肌群、在动作库里却空白。
    pub muscles: Value,
}

impl ExerciseHint {
    /// 从课程条目取默认值（字段名与前端 `PlanExercise` 一致）
    pub fn from_plan_item(item: &Value) -> ExerciseHint {
        ExerciseHint {
            kind: str_field(item, "kind"),
            sets: int_field(item, "sets"),
            reps: int_field(item, "reps"),
            weight_kg: item.get("weightKg").and_then(|v| v.as_f64()),
            target_sec: int_field(item, "targetSec"),
            duration_min: int_field(item, "durationMin"),
            rest_sec: int_field(item, "restSec"),
            tips: str_field(item, "tips"),
            muscles: item.get("muscles").cloned().unwrap_or(Value::Null),
        }
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

fn int_field(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// 按名解析库 id；未命中则新建自建动作并登记进索引（同一次回填里同名不重复建）。
pub fn ensure_for_name(
    conn: &Connection,
    index: &mut NameIndex,
    name: &str,
    hint: &ExerciseHint,
) -> Result<String> {
    let name = name.trim();
    if let Some(id) = index.get(name) {
        return Ok(id.to_string());
    }
    let id = format!("custom-{}", uuid::Uuid::new_v4());
    let kind = hint.kind.clone().unwrap_or_else(|| "strength".into());
    // 自重 / 计时 / 有氧动作不按杠铃片步进取整
    let weight_step = if kind == "strength" { 2.5 } else { 0.0 };
    // 课程条目上标好的肌群直接带进库（清洗过才落库）：动作库与课程展示口径一致
    let muscles = super::muscles::sanitize_muscles(&hint.muscles).to_string();
    conn.execute(
        "INSERT INTO exercises \
         (id, name, aliases, kind, category, equipment, muscles, tips, default_sets, default_reps, \
          default_weight_kg, default_target_sec, default_duration_min, default_rest_sec, weight_step, \
          is_custom, created_at, updated_at) \
         VALUES (?1, ?2, '[]', ?3, 'other', NULL, ?12, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, \
                 datetime('now'), datetime('now'))",
        rusqlite::params![
            id,
            name,
            kind,
            hint.tips.clone().unwrap_or_default(),
            hint.sets.unwrap_or(3),
            hint.reps,
            hint.weight_kg,
            hint.target_sec,
            hint.duration_min,
            hint.rest_sec.unwrap_or(90),
            weight_step,
            muscles,
        ],
    )?;
    index.insert(name, &id);
    Ok(id)
}

/// 把课程条目数组里的动作名解析成库 id（缺 `exerciseId` 的补上）。
/// 返回 (处理后的数组, 是否有改动)，供写入路径统一调用（upsert / 种子覆盖）。
pub fn resolve_plan_exercises(
    conn: &Connection,
    index: &mut NameIndex,
    exercises: &Value,
) -> Result<(Value, bool)> {
    let Some(arr) = exercises.as_array() else {
        return Ok((exercises.clone(), false));
    };
    let mut out = Vec::with_capacity(arr.len());
    let mut changed = false;
    for item in arr {
        let existing = item
            .get("exerciseId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        if existing.is_some() {
            out.push(item.clone());
            continue;
        }
        let Some(name) = item.get("name").and_then(|v| v.as_str()) else {
            out.push(item.clone());
            continue;
        };
        let id = ensure_for_name(conn, index, name, &ExerciseHint::from_plan_item(item))?;
        let mut obj = item.clone();
        if let Some(m) = obj.as_object_mut() {
            m.insert("exerciseId".into(), json!(id));
        }
        out.push(obj);
        changed = true;
    }
    Ok((Value::Array(out), changed))
}

/// 幂等回填存量数据（老库升级路径，每次启动跑一次；只填 NULL / 只补字段）：
///
/// 1. `workout_sets.exercise_id IS NULL` 的行 → 按 `exercise_name` 解析；
/// 2. `workout_plans.exercises_json` 里缺 `exerciseId` 的条目 → 按 `name` 解析。
///
/// 返回处理过的记录条数（做组行 + 课程条目），仅供日志与测试断言。
pub fn backfill_exercise_refs(conn: &Connection) -> Result<usize> {
    let mut index = NameIndex::load(conn)?;
    let mut touched = 0usize;

    // 1) 做组记录：按 (名称, 类型) 分组批量 UPDATE
    let pending: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT exercise_name, kind FROM workout_sets \
             WHERE exercise_id IS NULL AND exercise_name <> ''",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (name, kind) in pending {
        let hint = ExerciseHint {
            kind: Some(kind),
            ..Default::default()
        };
        let id = ensure_for_name(conn, &mut index, &name, &hint)?;
        touched += conn.execute(
            "UPDATE workout_sets SET exercise_id = ?1 \
             WHERE exercise_id IS NULL AND exercise_name = ?2",
            rusqlite::params![id, name],
        )?;
    }

    // 2) 课程动作条目
    let plans: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, exercises_json FROM workout_plans")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (plan_id, json_text) in plans {
        let Ok(value) = serde_json::from_str::<Value>(&json_text) else {
            continue;
        };
        let (resolved, changed) = resolve_plan_exercises(conn, &mut index, &value)?;
        if !changed {
            continue;
        }
        let count = resolved.as_array().map(|a| a.len()).unwrap_or(0);
        conn.execute(
            "UPDATE workout_plans SET exercises_json = ?2 WHERE id = ?1",
            rusqlite::params![plan_id, resolved.to_string()],
        )?;
        touched += count;
    }

    Ok(touched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_with_seed() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        crate::modules::seed::seed_exercises(&conn).unwrap();
        conn
    }

    /// 内置动作名与别名都能解析到同一条库 id
    #[test]
    fn resolves_builtin_by_name_and_alias() {
        let conn = conn_with_seed();
        let index = NameIndex::load(&conn).unwrap();
        assert_eq!(index.get("杠铃卧推"), Some("barbell-bench-press"));
        assert_eq!(index.get("卧推"), Some("barbell-bench-press"));
        assert_eq!(index.get(" 卧推 "), Some("barbell-bench-press"));
        assert_eq!(index.get("不存在的动作"), None);
    }

    /// 未命中的名字自动建成自建动作，且同一名字只建一条
    #[test]
    fn unknown_name_becomes_custom_exercise() {
        let conn = conn_with_seed();
        let mut index = NameIndex::load(&conn).unwrap();
        let hint = ExerciseHint {
            kind: Some("strength".into()),
            sets: Some(4),
            reps: Some(8),
            weight_kg: Some(42.5),
            ..Default::default()
        };
        let a = ensure_for_name(&conn, &mut index, "自制拉背器", &hint).unwrap();
        let b = ensure_for_name(&conn, &mut index, "自制拉背器", &hint).unwrap();
        assert_eq!(a, b);
        let (custom, is_custom, sets, weight): (String, i64, i64, f64) = conn
            .query_row(
                "SELECT name, is_custom, default_sets, default_weight_kg FROM exercises WHERE id = ?1",
                [&a],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(custom, "自制拉背器");
        assert_eq!(is_custom, 1);
        assert_eq!(sets, 4);
        assert_eq!(weight, 42.5);
    }

    /// 课程条目上的显式肌群必须带进自动建的自建动作（否则动作库里同一动作没有肌群图）
    #[test]
    fn custom_exercise_carries_plan_item_muscles() {
        let conn = conn_with_seed();
        let mut index = NameIndex::load(&conn).unwrap();
        let item = serde_json::json!({
            "id": "e9",
            "name": "我的推日动作",
            "kind": "strength",
            "sets": 3,
            "muscles": { "chest-low": 3, "triceps": 2, "not-a-muscle": 3, "abs": 9 }
        });
        let id = ensure_for_name(&conn, &mut index, "我的推日动作", &ExerciseHint::from_plan_item(&item)).unwrap();
        let raw: String = conn
            .query_row("SELECT muscles FROM exercises WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        let map: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // 合法键保留，未知键与非法档位被清洗掉
        assert_eq!(map, serde_json::json!({ "chest-low": 3, "triceps": 2 }));
    }

    /// 回填：课程条目与做组记录都挂上库 id，且重复执行不改变结果
    #[test]
    fn backfill_is_idempotent() {
        let conn = conn_with_seed();
        conn.execute(
            "INSERT INTO workout_plans (id, name, subtitle, workout_type, exercises_json, created_at, updated_at) \
             VALUES ('p1', '我的课', '', 'strength', ?1, datetime('now'), datetime('now'))",
            [r#"[{"id":"e1","name":"杠铃卧推","kind":"strength","sets":4,"reps":8},{"id":"e2","name":"自制拉背器","kind":"strength","sets":3,"reps":10}]"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workouts (name, type, date, duration_min, kcal, intensity, created_at) \
             VALUES ('训练', 'strength', '2026-09-01', 60, 300, 'moderate', datetime('now'))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workout_sets (workout_id, exercise_key, exercise_name, set_no, kind, weight_kg, reps, warmup, created_at) \
             VALUES (1, 'e1', '杠铃卧推', 1, 'strength', 60, 8, 0, datetime('now'))",
            [],
        )
        .unwrap();

        let first = backfill_exercise_refs(&conn).unwrap();
        assert!(first >= 2, "至少要回填一个课程条目与一行做组记录");

        let plan: String = conn
            .query_row("SELECT exercises_json FROM workout_plans WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        let v: Value = serde_json::from_str(&plan).unwrap();
        assert_eq!(v[0]["exerciseId"], "barbell-bench-press");
        assert!(v[1]["exerciseId"].as_str().unwrap().starts_with("custom-"));
        let set_id: String = conn
            .query_row("SELECT exercise_id FROM workout_sets WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(set_id, "barbell-bench-press");

        // 第二次运行：没有 NULL 行可填，课程条目已带 id，结果不变
        backfill_exercise_refs(&conn).unwrap();
        let plan2: String = conn
            .query_row("SELECT exercises_json FROM workout_plans WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(plan, plan2);
        let customs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM exercises WHERE name = '自制拉背器'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(customs, 1);
    }

    /// 种子刷新不会覆盖用户自建动作（同名时自建动作也保持自己的 id 与内容）
    #[test]
    fn seed_refresh_leaves_custom_rows_alone() {
        let conn = conn_with_seed();
        conn.execute(
            "INSERT INTO exercises (id, name, is_custom, default_sets) VALUES ('custom-x', '我的深蹲', 1, 5)",
            [],
        )
        .unwrap();
        crate::modules::seed::seed_exercises(&conn).unwrap();
        let sets: i64 = conn
            .query_row("SELECT default_sets FROM exercises WHERE id='custom-x'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sets, 5);
    }
}
