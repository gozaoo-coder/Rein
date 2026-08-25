//! 饮食域命令 · 命令名与前端 `dietService.ts` 一一对应。

use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;
use chrono::Utc;

use super::{attach_units, food_from_row, food_from_row_at, FOOD_COLS};
use super::models::{Food, FoodCreateInput, FoodCreateResult, MealLog};

#[tauri::command]
pub fn list_foods(
    state: State<AppState>,
    query: Option<String>,
    category: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Food>> {
    let conn = state.db.lock().unwrap();
    let like = query
        .as_deref()
        .map(|q| format!("%{}%", q.trim()))
        .filter(|q| q != "%%");

    let sql = format!(
        "SELECT {FOOD_COLS} FROM foods f \
         WHERE (?1 IS NULL OR f.name LIKE ?1) AND (?2 IS NULL OR f.category = ?2) \
         ORDER BY f.id LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut foods: Vec<Food> = stmt
        .query_map(
            rusqlite::params![like, category, limit.unwrap_or(60)],
            food_from_row,
        )?
        .collect::<rusqlite::Result<_>>()?;
    attach_units(&conn, &mut foods)?;
    Ok(foods)
}

#[tauri::command]
pub fn get_food(state: State<AppState>, id: i64) -> Result<Option<Food>> {
    let conn = state.db.lock().unwrap();
    fetch_food(&conn, id)
}

/* ---------- 模糊搜索（按字的包含程度与顺序相似度打分） ---------- */

/// 归一化：去空白、英文字母转小写（中文不受影响）
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 最长公共子序列长度（字符级，保持相对顺序）——LCS 天然度量"按顺序包含"
fn lcs_len(a: &[char], b: &[char]) -> usize {
    let (n, m) = (a.len(), b.len());
    let w = m + 1;
    let mut dp = vec![0u16; (n + 1) * w];
    for i in 1..=n {
        for j in 1..=m {
            dp[i * w + j] = if a[i - 1] == b[j - 1] {
                dp[(i - 1) * w + (j - 1)] + 1
            } else {
                dp[(i - 1) * w + j].max(dp[i * w + (j - 1)])
            };
        }
    }
    dp[n * w + m] as usize
}

/// 名称相似度 0..=1：完全一致 = 1.0；
/// 否则 = 0.65×顺序覆盖率(lcs/query_len) + 0.35×长度贴近度(min(1, query_len/name_len))。
/// 例：搜「可乐」→「可乐」1.0；「无糖可乐」0.825（适当减分）；「快乐水」0.558。
fn name_similarity(query: &str, name: &str) -> f64 {
    let qn = norm(query);
    let nn = norm(name);
    if qn.is_empty() {
        return 0.0;
    }
    if qn == nn {
        return 1.0;
    }
    let qc: Vec<char> = qn.chars().collect();
    let nc: Vec<char> = nn.chars().collect();
    let lcs = lcs_len(&qc, &nc);
    if lcs == 0 {
        return 0.0;
    }
    let order = lcs as f64 / qc.len() as f64;
    let len = (qc.len() as f64 / nc.len() as f64).min(1.0);
    0.65 * order + 0.35 * len
}

/// 模糊搜索：按相似度排序返回 top-N（低于阈值过滤噪声）。
/// 算法放 Rust 层，避免移动端 JS 逐条打分；全量 2722 条毫秒级。
#[tauri::command]
pub fn search_foods_fuzzy(
    state: State<AppState>,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Food>> {
    let conn = state.db.lock().unwrap();
    let q = query.as_deref().map(str::trim).unwrap_or("");
    let limit = limit.unwrap_or(20).clamp(1, 50) as usize;

    let sql = format!("SELECT {FOOD_COLS} FROM foods f");
    let mut stmt = conn.prepare(&sql)?;
    let foods = stmt
        .query_map([], food_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if q.is_empty() {
        let mut out: Vec<Food> = foods.into_iter().take(limit).collect();
        attach_units(&conn, &mut out)?;
        return Ok(out);
    }

    let mut scored: Vec<(i32, Food)> = foods
        .into_iter()
        .map(|f| ((name_similarity(q, &f.name) * 100.0).round() as i32, f))
        .filter(|(s, _)| *s >= 35)
        .collect();
    // 分数降序 → 名称短者优先 → id 升序（稳定）
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.name.chars().count().cmp(&b.1.name.chars().count()))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    scored.truncate(limit);
    let mut out: Vec<Food> = scored.into_iter().map(|(_, f)| f).collect();
    attach_units(&conn, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::name_similarity;

    fn pct(q: &str, n: &str) -> i32 {
        (name_similarity(q, n) * 100.0).round() as i32
    }

    #[test]
    fn exact_match_is_full_score() {
        assert_eq!(pct("可乐", "可乐"), 100);
        assert_eq!(pct("无糖可乐", "无糖可乐"), 100);
        // 归一化后一致（去空白、忽略大小写）
        assert_eq!(pct("可乐", " 可乐 "), 100);
    }

    #[test]
    fn partial_match_penalized_but_found() {
        // 搜「可乐」→「无糖可乐」适当减分，但远高于噪声
        let partial = pct("可乐", "无糖可乐");
        assert!(partial < 100 && partial >= 80, "partial={partial}");
        // 完全不相关为 0
        assert_eq!(pct("可乐", "白米饭"), 0);
    }

    #[test]
    fn order_matters_more_than_character_set() {
        // 「无糖可乐」顺序正确（可→乐），高于乱序「乐可」
        assert!(pct("可乐", "无糖可乐") > pct("可乐", "乐可"));
        // 短名（额外内容少）优先于长名
        assert!(pct("可乐", "无糖可乐") > pct("可乐", "可乐（无糖零卡汽水）"));
    }

    #[test]
    fn longer_query_still_matches_subsets() {
        // 搜「无糖可乐」命中「可乐」：顺序覆盖率低但可搜到
        let hit = pct("无糖可乐", "可乐");
        assert!(hit >= 60 && hit < 100, "hit={hit}");
    }
}

/// get_food 的连接复用版（create_food 等内部路径用）
fn fetch_food(conn: &rusqlite::Connection, id: i64) -> Result<Option<Food>> {
    let sql = format!("SELECT {FOOD_COLS} FROM foods f WHERE f.id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut foods = stmt
        .query_map([id], food_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if foods.is_empty() {
        return Ok(None);
    }
    attach_units(conn, &mut foods)?;
    Ok(foods.pop())
}

/// 新建自定义食品（is_custom=1）。同名已存在时直接返回既有记录，不重复建。
#[tauri::command]
pub fn create_food(state: State<AppState>, food: FoodCreateInput) -> Result<FoodCreateResult> {
    let name = food.name.trim().to_string();
    if name.is_empty() {
        return Err(ReinError::Message("食物名称不能为空".into()));
    }
    let conn = state.db.lock().unwrap();

    let existing: Option<i64> = conn
        .query_row("SELECT id FROM foods WHERE name = ?1", [&name], |r| r.get(0))
        .ok();
    if let Some(id) = existing {
        let food = fetch_food(&conn, id)?.ok_or_else(|| ReinError::Message("食物查询失败".into()))?;
        return Ok(FoodCreateResult { food, created: false });
    }

    let now = Utc::now().to_rfc3339();
    // 微量营养素暂不开放给 AI 填写，统一落 0
    conn.execute(
        "INSERT INTO foods (name, category, kcal, protein, carb, fat, fiber, sugar, sodium_mg, \
         potassium_mg, calcium_mg, iron_mg, zinc_mg, magnesium_mg, \
         vit_a_ug, vit_c_mg, vit_d_ug, vit_e_mg, vit_b12_ug, folate_ug, default_unit, is_custom, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?10, 1, ?11)",
        rusqlite::params![
            name,
            food.category,
            food.kcal,
            food.protein,
            food.carb,
            food.fat,
            food.fiber,
            food.sugar,
            food.sodium_mg,
            food.default_unit,
            now
        ],
    )?;
    let id = conn.last_insert_rowid();

    for u in &food.units {
        let unit_name = u.name.trim();
        if unit_name.is_empty() || u.grams <= 0.0 {
            continue;
        }
        conn.execute(
            "INSERT INTO food_units (food_id, name, grams) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, unit_name, u.grams],
        )?;
    }

    let created_food =
        fetch_food(&conn, id)?.ok_or_else(|| ReinError::Message("食物创建失败".into()))?;
    Ok(FoodCreateResult {
        food: created_food,
        created: true,
    })
}

const MEAL_SELECT: &str = "ml.id, ml.food_id, ml.date, ml.meal_type, ml.quantity_mode, ml.grams, \
     ml.units, ml.unit_name, ml.source, ml.note, ml.created_at";

#[tauri::command]
pub fn list_meals(state: State<AppState>, date: String) -> Result<Vec<MealLog>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {MEAL_SELECT}, {FOOD_COLS} \
         FROM meal_logs ml JOIN foods f ON f.id = ml.food_id \
         WHERE ml.date = ?1 ORDER BY ml.created_at, ml.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let logs = stmt
        .query_map([&date], meal_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(logs)
}

fn meal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MealLog> {
    Ok(MealLog {
        id: row.get(0)?,
        food_id: row.get(1)?,
        date: row.get(2)?,
        meal_type: row.get(3)?,
        quantity_mode: row.get(4)?,
        grams: row.get(5)?,
        units: row.get(6)?,
        unit_name: row.get(7)?,
        source: row.get(8)?,
        note: row.get(9)?,
        created_at: row.get(10)?,
        food: Some(food_from_row_at(row, 11)?),
    })
}

/// 写入一条饮食记录。`grams` 必须已是换算后的克重（unit 模式由前端换算）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn log_meal(
    state: State<AppState>,
    food_id: i64,
    date: String,
    meal_type: String,
    quantity_mode: String,
    grams: f64,
    units: Option<f64>,
    unit_name: Option<String>,
    source: String,
    note: Option<String>,
) -> Result<MealLog> {
    let conn = state.db.lock().unwrap();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO meal_logs (food_id, date, meal_type, quantity_mode, grams, units, unit_name, source, note, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![food_id, date, meal_type, quantity_mode, grams, units, unit_name, source, note, now],
    )?;
    let id = conn.last_insert_rowid();

    let sql = format!("SELECT {MEAL_SELECT}, {FOOD_COLS} FROM meal_logs ml JOIN foods f ON f.id = ml.food_id WHERE ml.id = ?1");
    let log = conn.query_row(&sql, [id], meal_from_row)?;
    Ok(log)
}

#[tauri::command]
pub fn delete_meal(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM meal_logs WHERE id = ?1", [id])?;
    Ok(())
}
