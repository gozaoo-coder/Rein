//! 种子数据：启动时把 `resources/foods.json`（前后端共用的单一来源）导入食物库，
//! 把 `resources/workout_plans.json` 导入课程库。食物按 name 幂等补齐
//! （UNIQUE 约束 + INSERT OR IGNORE：老库保留原 id 与份量，新增种子自动追加）；
//! 内置课程按 id 幂等补齐（不覆盖已有行，删除的内置课会补回）。

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedFile {
    foods: Vec<SeedFood>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedFood {
    name: String,
    category: String,
    kcal: f64,
    protein: f64,
    carb: f64,
    fat: f64,
    fiber: f64,
    sugar: f64,
    sodium_mg: f64,
    potassium_mg: f64,
    calcium_mg: f64,
    iron_mg: f64,
    zinc_mg: f64,
    magnesium_mg: f64,
    vit_a_ug: f64,
    vit_c_mg: f64,
    vit_d_ug: f64,
    vit_e_mg: f64,
    vit_b12_ug: f64,
    folate_ug: f64,
    default_unit: Option<String>,
    units: Vec<SeedUnit>,
}

#[derive(Deserialize)]
struct SeedUnit {
    name: String,
    grams: f64,
}

const FOODS_JSON: &str = include_str!("../../../resources/foods.json");

/// 0003 起课程表启用：内置课程种子（与前端 mock 共用同一 JSON 单一来源）
const WORKOUT_PLANS_JSON: &str = include_str!("../../../resources/workout_plans.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeedFile {
    plans: Vec<PlanSeed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSeed {
    id: String,
    name: String,
    subtitle: String,
    workout_type: String,
    exercises: Value,
    /// 器械要求：gym / home / 缺省 = NULL（通用）
    #[serde(default)]
    equipment: Option<String>,
    /// 预估时长（分钟）；缺省 = NULL
    #[serde(default)]
    est_duration_min: Option<i64>,
}

/// 食物种子：按 name 幂等补齐（见模块注释）。
pub fn seed_foods(conn: &Connection) -> Result<()> {
    let seed: SeedFile = serde_json::from_str(FOODS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO foods (name, category, kcal, protein, carb, fat, fiber, sugar, \
             sodium_mg, potassium_mg, calcium_mg, iron_mg, zinc_mg, magnesium_mg, \
             vit_a_ug, vit_c_mg, vit_d_ug, vit_e_mg, vit_b12_ug, folate_ug, default_unit, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
        )?;
        for f in &seed.foods {
            let inserted = stmt.execute(rusqlite::params![
                f.name, f.category, f.kcal, f.protein, f.carb, f.fat, f.fiber, f.sugar,
                f.sodium_mg, f.potassium_mg, f.calcium_mg, f.iron_mg, f.zinc_mg, f.magnesium_mg,
                f.vit_a_ug, f.vit_c_mg, f.vit_d_ug, f.vit_e_mg, f.vit_b12_ug, f.folate_ug,
                f.default_unit, now
            ])?;
            if inserted == 0 {
                continue; // 老库已有同名食物：保留原行（id/份量不变）
            }
            let food_id = conn.last_insert_rowid();
            for u in &f.units {
                conn.execute(
                    "INSERT INTO food_units (food_id, name, grams) VALUES (?1, ?2, ?3)",
                    rusqlite::params![food_id, u.name, u.grams],
                )?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}

/// 内置课程种子内容版本：种子里的课程内容（exercises/subtitle）变更时 +1。
/// 首次安装直接按最新版本导入；老库升级后低于该版本时会**按 id 刷新课程内容**
/// （覆盖内置课的 exercises_json —— 激活热身组等结构改进需要送达已存在的库；
/// 用户对内置课的编辑会被重置为新种子，此语义与「内置课程始终可用优先」一致）。
const PLAN_SEED_CONTENT_VERSION: i64 = 4;

/// 内置课程种子：按 id 幂等补齐（INSERT OR IGNORE）。
/// 老库升级后自动拿到新增的内置课程；已有课程（含用户改过的）永不覆盖——
/// 但种子内容版本升级时会按 id 刷新内置课内容（见 PLAN_SEED_CONTENT_VERSION）。
/// 代价：用户删除的内置课程会在下次启动时补回——内置课程始终可用优先。
pub fn seed_builtin_plans(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO workout_plans (id, name, subtitle, workout_type, exercises_json, equipment, est_duration_min, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )?;
        for p in &seed.plans {
            stmt.execute(rusqlite::params![
                p.id,
                p.name,
                p.subtitle,
                p.workout_type,
                p.exercises.to_string(),
                p.equipment,
                p.est_duration_min,
                now
            ])?;
        }
        drop(stmt);

        // 内容版本刷新：老库（含 0003 前导入的旧版课程）拿到最新的内置课内容
        let stored: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'plan_seed_version'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if stored < PLAN_SEED_CONTENT_VERSION {
            let mut upd = conn.prepare(
                "UPDATE workout_plans SET exercises_json = ?2, subtitle = ?3, updated_at = ?4 WHERE id = ?1",
            )?;
            for p in &seed.plans {
                upd.execute(rusqlite::params![
                    p.id,
                    p.exercises.to_string(),
                    p.subtitle,
                    now
                ])?;
            }
            drop(upd);
            conn.execute(
                "INSERT INTO app_meta (key, value) VALUES ('plan_seed_version', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [PLAN_SEED_CONTENT_VERSION.to_string()],
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(())
}
