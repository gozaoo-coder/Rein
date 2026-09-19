//! 营养域：每日汇总、目标与个人资料。

pub mod commands;
pub mod models;

use rusqlite::Connection;

use crate::error::{ReinError, Result};
use models::{DailyTargets, Profile};

const PROFILE_COLS: &str = "nickname, sex, birthday, height_cm, weight_kg, target_weight_kg, \
     activity_level, goal, target_kcal, target_protein, target_carb, target_fat, \
     target_sodium_mg, target_water_ml, training_days_per_week, preferred_time_slots, \
     equipment, diet_restrictions, experience";

pub(crate) fn profile_targets(conn: &Connection) -> Result<DailyTargets> {
    Ok(DailyTargets {
        kcal: conn.query_row("SELECT target_kcal FROM profile WHERE id = 1", [], |r| {
            r.get(0)
        })?,
        protein: conn.query_row("SELECT target_protein FROM profile WHERE id = 1", [], |r| {
            r.get(0)
        })?,
        carb: conn.query_row("SELECT target_carb FROM profile WHERE id = 1", [], |r| {
            r.get(0)
        })?,
        fat: conn.query_row("SELECT target_fat FROM profile WHERE id = 1", [], |r| {
            r.get(0)
        })?,
        sodium_mg: conn.query_row(
            "SELECT target_sodium_mg FROM profile WHERE id = 1",
            [],
            |r| r.get(0),
        )?,
        water_ml: conn.query_row(
            "SELECT target_water_ml FROM profile WHERE id = 1",
            [],
            |r| r.get(0),
        )?,
    })
}

/// JSON 文本列 → Vec<String>；列值为 NULL 或内容损坏时回落 None（不阻塞资料读取）
fn json_text_list(raw: Option<String>) -> Option<Vec<String>> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

pub(crate) fn load_profile(conn: &Connection) -> Result<Profile> {
    let sql = format!("SELECT {PROFILE_COLS} FROM profile WHERE id = 1");
    let p = conn.query_row(&sql, [], |r| {
        Ok(Profile {
            nickname: r.get(0)?,
            sex: r.get(1)?,
            birthday: r.get(2)?,
            height_cm: r.get(3)?,
            weight_kg: r.get(4)?,
            target_weight_kg: r.get(5)?,
            activity_level: r.get(6)?,
            goal: r.get(7)?,
            targets: DailyTargets {
                kcal: r.get(8)?,
                protein: r.get(9)?,
                carb: r.get(10)?,
                fat: r.get(11)?,
                sodium_mg: r.get(12)?,
                water_ml: r.get(13)?,
            },
            training_days_per_week: r.get(14)?,
            preferred_time_slots: json_text_list(r.get(15)?),
            equipment: r.get(16)?,
            diet_restrictions: json_text_list(r.get(17)?),
            experience: r.get(18)?,
        })
    })?;
    Ok(p)
}

pub(crate) fn ensure_found(res: Result<Profile>) -> Result<Profile> {
    match res {
        Ok(p) => Ok(p),
        Err(ReinError::Db(rusqlite::Error::QueryReturnedNoRows)) => {
            Err(ReinError::Message("资料行缺失，请重启应用以初始化".into()))
        }
        Err(e) => Err(e),
    }
}
