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
/// 首次安装直接按最新版本导入；老库升级后不自动刷新内容，而是返回
/// `PlanSeedStatus::Pending`，由前端发起三选一（兼容合并 / 使用新版本 / 保留我的）。
const PLAN_SEED_CONTENT_VERSION: i64 = 5;

/// 课程种子升级决策（持久化在 app_meta）：兼容合并已把种子内容吸收进用户数据。
const META_APPLIED: &str = "plan_seed_applied";
/// 课程种子升级决策：用户选择「使用新版本」，本地内置课内容已被新种子覆盖。
const META_OVERRIDE: &str = "plan_seed_override";
/// 课程种子升级决策：用户选择「保留我的」，本版本不再打扰，下个种子版本再问。
const META_KEEP: &str = "plan_seed_keep";

/// 读 app_meta 键（存数值）。
fn meta_int(conn: &Connection, key: &str) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = ?1",
        [key],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 内置课程种子升级状态（前端课程库页据此决定是否弹出「新版本」横幅）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSeedStatus {
    /// 当前内置课程种子版本（已合入 / 决策后的版本）
    pub current_version: i64,
    /// 资源文件里的最新种子版本
    pub latest_version: i64,
}

impl PlanSeedStatus {
    fn pending() -> PlanSeedStatus {
        PlanSeedStatus { current_version: 0, latest_version: PLAN_SEED_CONTENT_VERSION }
    }

    fn settled(v: i64) -> PlanSeedStatus {
        PlanSeedStatus { current_version: v, latest_version: PLAN_SEED_CONTENT_VERSION }
    }
}

/// 读种子升级状态：current_version 落后于 latest_version 即表示「有新版本待决策」。
/// 决策标识只用来区分是应用了（migrate/override）还是忽略了（keep），
/// 避免每次启动重复弹窗；三种都记在 current_version。
pub fn plan_seed_status(conn: &Connection) -> Result<PlanSeedStatus> {
    let applied = meta_int(conn, META_APPLIED);
    let override_ = meta_int(conn, META_OVERRIDE);
    let keep = meta_int(conn, META_KEEP);
    let stored = meta_int(conn, "plan_seed_version");

    let settled = match stored {
        s if s > 0 => Some(s),
        _ => [applied, override_, keep].into_iter().find(|&v| v > 0),
    };
    Ok(match settled {
        Some(v) => PlanSeedStatus::settled(v),
        None => PlanSeedStatus::pending(),
    })
}

/// 写入决策：统一在 `plan_seed_version` 记目标版本，并清掉其它决策标识，
/// 保证三种决策互斥、幂等（重复调用无害）。
fn settle_seed_decision(conn: &Connection, version: i64, applied: bool) -> Result<()> {
    let overridden = !applied;
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES ('plan_seed_version', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version.to_string()],
    )?;
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES ('plan_seed_applied', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [(if applied { version } else { 0 }).to_string()],
    )?;
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES ('plan_seed_override', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [(if overridden { version } else { 0 }).to_string()],
    )?;
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES ('plan_seed_keep', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [0_i64.to_string()],
    )?;
    Ok(())
}

/// 兼容合并：把新种子内容合并进本地课程，**绝不覆盖用户设置过的任何值**。
///  - 按动作 id 对齐：本地缺失的字段补上新种子值（激活热身组、肌群标注等结构改进）；
///    用户已设置的字段一律保留。
///  - 本地缺失的动作整条补上（`kind` 相同才补，防止换过动作的 id 被错放）。
///  - 名称 / 副标题 / 类型 / 组数 / 次数 / 重量：始终尊重用户数据，不合并。
pub fn plan_seed_migrate(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut update = conn.prepare(
            "UPDATE workout_plans SET exercises_json = ?2, updated_at = ?3 WHERE id = ?1",
        )?;
        for p in &seed.plans {
            let current: Option<String> = conn
                .query_row(
                    "SELECT exercises_json FROM workout_plans WHERE id = ?1",
                    [&p.id],
                    |r| r.get(0),
                )
                .ok();
            let Some(cur) = current else { continue };
            let merged = merge_plan_exercises(&cur, p.exercises.as_array().unwrap_or(&vec![]));
            update.execute(rusqlite::params![p.id, merged, chrono::Utc::now().to_rfc3339()])?;
        }
        drop(update);
        settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, true)?;
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

/// 「使用新版本」：按 id 把本地内置课内容整体覆盖为新种子（用户对该内置课的编辑
/// 会被替换 —— 用户明确选择了新版本，语义一致）。
pub fn plan_seed_override(conn: &Connection) -> Result<()> {
    let seed: PlanSeedFile = serde_json::from_str(WORKOUT_PLANS_JSON)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare(
            "UPDATE workout_plans SET subtitle = ?2, exercises_json = ?3, updated_at = ?4 WHERE id = ?1",
        )?;
        for p in &seed.plans {
            stmt.execute(rusqlite::params![
                p.id, p.subtitle, p.exercises.to_string(), now
            ])?;
        }
        drop(stmt);
        settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, false)?;
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

/// 「保留我的」：本版本不再刷新内置课内容，只结清版本提示（下个种子版本再问）。
pub fn plan_seed_keep(conn: &Connection) -> Result<()> {
    conn.execute_batch("BEGIN")?;
    let result = settle_seed_decision(conn, PLAN_SEED_CONTENT_VERSION, true);
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    result.map(|_| ())
}

/// 把 `stored_json`（本地已存的内置课动作数组）与新种子动作数组做字段级合并。
/// 不依赖具体 schema，字段名一致即吸收新值；本地缺该动作时补整条（同 kind）。
fn merge_plan_exercises(stored_json: &str, seed: &[Value]) -> String {
    let stored: Value = serde_json::from_str(stored_json).unwrap_or(Value::Null);
    let arr = stored.as_array();
    // 本地不是数组（异常数据）或种子为空：保留本地，安全兜底
    let Some(local) = arr else { return stored_json.to_string() };
    if seed.is_empty() {
        return stored_json.to_string();
    }

    let mut map: std::collections::HashMap<&str, Value> = std::collections::HashMap::new();
    for e in local {
        if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
            map.insert(id, e.clone());
        }
    }

    let mut out: Vec<Value> = Vec::new();
    for e in seed {
        let Some(id) = e.get("id").and_then(|v| v.as_str()) else {
            out.push(e.clone()); // 种子动作无 id：按整条补上
            continue;
        };
        match map.get(id) {
            Some(local_ex) => {
                // 只补本地缺失的字段；本地已有的字段（含用户改过的）一律保留
                let mut merged = local_ex.clone();
                let obj = merged.as_object_mut();
                if let (Some(o), Some(s)) = (obj, e.as_object()) {
                    for (k, sv) in s {
                        o.entry(k.to_string()).or_insert_with(|| sv.clone());
                    }
                }
                out.push(merged);
            }
            None => {
                // 新动作：仅当类型与本地同 id 动作一致才补（防御换过动作的 id 冲突）
                if let Some(kind) = e.get("kind").and_then(|v| v.as_str()) {
                    let conflict = local.iter().any(|x| x.get("kind").and_then(|v| v.as_str()) == Some(kind));
                    if !conflict {
                        out.push(e.clone());
                    }
                } else {
                    out.push(e.clone());
                }
            }
        }
    }
    // 本地独有的动作（用户新增的自定义动作）保留
    let seed_ids: std::collections::HashSet<&str> =
        seed.iter().filter_map(|e| e.get("id").and_then(|v| v.as_str())).collect();
    for e in local {
        let id = e.get("id").and_then(|v| v.as_str());
        if let Some(id) = id {
            if !seed_ids.contains(id) {
                out.push(e.clone());
            }
        }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| stored_json.to_string())
}

/// 内置课程种子：启动时按 id **增量**补种（INSERT OR IGNORE）。
/// 缺失的内置课补入（含老库 0003 前从未导入的旧版课程）；已有行（含用户改过的）
/// 永不覆盖；内容版本升级不再自动刷新，见 `plan_seed_status` 与三选一命令。
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
