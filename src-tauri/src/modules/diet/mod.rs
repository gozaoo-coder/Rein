//! 饮食域：食物库与当日记录。
//! 查询规模小（单日 / 单页），SQL 直接写在 commands.rs；
//! 当某模块查询超过约 200 行时，再拆出 repo.rs（见 docs/STANDARDS.md）。

pub mod commands;
pub mod models;

use rusqlite::Row;

use crate::error::Result;
use models::Food;

/// foods 表列清单（带 f. 前缀，必须配合别名 `FROM foods f` 使用，保证 join 不撞列名；
/// SELECT 时必须使用，保证行映射下标稳定）
pub(crate) const FOOD_COLS: &str = "f.id, f.name, f.category, f.kcal, f.protein, f.carb, f.fat, f.fiber, f.sugar, \
     f.sodium_mg, f.potassium_mg, f.calcium_mg, f.iron_mg, f.zinc_mg, f.magnesium_mg, \
     f.vit_a_ug, f.vit_c_mg, f.vit_d_ug, f.vit_e_mg, f.vit_b12_ug, f.folate_ug, f.default_unit";

/// 从行映射 Food（列偏移从 0 开始；join 场景用 `food_from_row_at`）
pub(crate) fn food_from_row(row: &Row<'_>) -> rusqlite::Result<Food> {
    food_from_row_at(row, 0)
}

pub(crate) fn food_from_row_at(row: &Row<'_>, off: usize) -> rusqlite::Result<Food> {
    let c = |i: usize| off + i;
    Ok(Food {
        id: row.get(c(0))?,
        name: row.get(c(1))?,
        category: row.get(c(2))?,
        kcal: row.get(c(3))?,
        protein: row.get(c(4))?,
        carb: row.get(c(5))?,
        fat: row.get(c(6))?,
        fiber: row.get(c(7))?,
        sugar: row.get(c(8))?,
        sodium_mg: row.get(c(9))?,
        potassium_mg: row.get(c(10))?,
        calcium_mg: row.get(c(11))?,
        iron_mg: row.get(c(12))?,
        zinc_mg: row.get(c(13))?,
        magnesium_mg: row.get(c(14))?,
        vit_a_ug: row.get(c(15))?,
        vit_c_mg: row.get(c(16))?,
        vit_d_ug: row.get(c(17))?,
        vit_e_mg: row.get(c(18))?,
        vit_b12_ug: row.get(c(19))?,
        folate_ug: row.get(c(20))?,
        default_unit: row.get(c(21))?,
        units: Vec::new(),
    })
}

/// 为一批 Food 填充份量单位（数量小，N+1 可接受）
pub(crate) fn attach_units(conn: &rusqlite::Connection, foods: &mut [Food]) -> Result<()> {
    for f in foods {
        let mut stmt =
            conn.prepare("SELECT name, grams FROM food_units WHERE food_id = ?1 ORDER BY id")?;
        f.units = stmt
            .query_map([f.id], |r| {
                Ok(models::FoodUnit {
                    name: r.get(0)?,
                    grams: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(())
}
