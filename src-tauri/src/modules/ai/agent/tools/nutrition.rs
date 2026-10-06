//! 营养域工具（对应 TS tools/nutrition.ts）：每日汇总 / 目标与资料 / 体重身高。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::{ReinError, Result};
use crate::modules::nutrition::commands as nut;
use crate::modules::nutrition::models::{BodyMetricInput, DailyTargets, Profile};
use crate::state::AppState;

use super::{num_arg, resolve_date, RegisteredTool};

fn f64_opt(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64()).filter(|v| v.is_finite())
}

/// 分派；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    Some(match name {
        "get_daily_summary" => {
            let state = app.state::<AppState>();
            let date = resolve_date(args, "date")?;
            Ok(serde_json::to_value(nut::get_daily_summary(&state, date)?)?)
        }
        "get_targets" => {
            let state = app.state::<AppState>();
            Ok(serde_json::to_value(nut::get_targets(&state, None)?)?)
        }
        "set_targets" => run_set_targets(app, args).await,
        "get_profile" => {
            let state = app.state::<AppState>();
            Ok(serde_json::to_value(nut::get_profile(&state)?)?)
        }
        "update_profile" => run_update_profile(app, args).await,
        "list_body_metrics" => {
            let state = app.state::<AppState>();
            let limit = Some(num_arg(args, "limit", 30.0).clamp(1.0, 120.0) as i64);
            let rows = nut::list_body_metrics(&state, limit)?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| json!({ "id": r.id, "date": r.date, "weightKg": r.weight_kg, "heightCm": r.height_cm }))
                .collect();
            Ok(json!(items))
        }
        "record_body_metric" => {
            let weight = f64_opt(args, "weightKg");
            let height = f64_opt(args, "heightCm");
            if weight.is_none() && height.is_none() {
                Err(ReinError::Message("至少提供 weightKg 或 heightCm".into()))?;
            }
            let state = app.state::<AppState>();
            let row = nut::record_body_metric(
                &state,
                BodyMetricInput {
                    date: resolve_date(args, "date")?,
                    weight_kg: weight,
                    height_cm: height,
                },
            )?;
            Ok(json!({ "ok": true, "id": row.id, "date": row.date }))
        }
        "delete_body_metric" => {
            let id = num_arg(args, "id", 0.0) as i64;
            let state = app.state::<AppState>();
            nut::delete_body_metric(&state, id)?;
            Ok(json!({ "ok": true }))
        }
        _ => return None,
    })
}

async fn run_set_targets(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let patch = [
        f64_opt(args, "kcal"),
        f64_opt(args, "protein"),
        f64_opt(args, "carb"),
        f64_opt(args, "fat"),
        f64_opt(args, "sodiumMg"),
        f64_opt(args, "waterMl"),
    ];
    if patch.iter().all(|v| v.is_none()) {
        return Err(ReinError::Message("至少提供一个要修改的字段".into()));
    }
    let state = app.state::<AppState>();
    let current: Value = serde_json::to_value(nut::get_targets(&state, None)?)?;
    let mut next = current.as_object().cloned().unwrap_or_default();
    for (key, v) in [
        ("kcal", patch[0]),
        ("protein", patch[1]),
        ("carb", patch[2]),
        ("fat", patch[3]),
        ("sodiumMg", patch[4]),
        ("waterMl", patch[5]),
    ] {
        if let Some(v) = v {
            next.insert(key.into(), json!(v));
        }
    }
    let targets: DailyTargets = serde_json::from_value(Value::Object(next.clone()))?;
    nut::set_targets(&state, targets, None)?;
    Ok(json!({ "ok": true, "targets": Value::Object(next) }))
}

async fn run_update_profile(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let state = app.state::<AppState>();
    let current: Value = serde_json::to_value(nut::get_profile(&state)?)?;
    let mut next = current.as_object().cloned().unwrap_or_default();
    for key in ["nickname", "sex", "birthday", "activityLevel", "goal"] {
        if let Some(v) = args.get(key).and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
            next.insert(key.into(), json!(v));
        }
    }
    for key in ["heightCm", "weightKg", "targetWeightKg"] {
        if let Some(v) = f64_opt(args, key) {
            next.insert(key.into(), json!(v));
        }
    }
    let profile: Profile = serde_json::from_value(Value::Object(next))?;
    let saved = nut::update_profile(&state, profile)?;
    Ok(serde_json::to_value(&saved)?)
}

/* ---------- defs ---------- */

pub fn defs() -> Vec<RegisteredTool> {
    vec![
        RegisteredTool {
            name: "get_daily_summary",
            group: "nutrition",
            label: "查看每日营养汇总",
            description: "查询某天的摄入聚合（热量/蛋白/碳水/脂肪/钠等）、当日目标与运动消耗。date 不传默认今天。",
            parameters: json!({
                "type": "object",
                "properties": { "date": { "type": "string", "description": "YYYY-MM-DD，缺省为今天" } }
            }),
        },
        RegisteredTool {
            name: "get_targets",
            group: "nutrition",
            label: "查看每日目标",
            description: "查看当前生效的每日营养目标（热量/蛋白/碳水/脂肪/钠/饮水）。",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        RegisteredTool {
            name: "set_targets",
            group: "nutrition",
            label: "设置每日目标",
            description: "修改每日营养目标，只传需要改的字段（其余保持不变）。用户明确要求调整目标时调用（应用内另有确认卡流程，这里是直接生效）。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "kcal": { "type": "number", "description": "能量（大卡）" },
                    "protein": { "type": "number", "description": "蛋白质（g）" },
                    "carb": { "type": "number", "description": "碳水（g）" },
                    "fat": { "type": "number", "description": "脂肪（g）" },
                    "sodiumMg": { "type": "number", "description": "钠（mg）" },
                    "waterMl": { "type": "number", "description": "饮水（ml）" }
                }
            }),
        },
        RegisteredTool {
            name: "get_profile",
            group: "nutrition",
            label: "查看个人资料",
            description: "查看个人资料：昵称、性别、生日、身高体重、目标体重、活动水平、减脂/保持/增肌目标。",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        RegisteredTool {
            name: "update_profile",
            group: "nutrition",
            label: "更新个人资料",
            description: "更新个人资料，只传需要改的字段。注意：体重变化建议用 record_body_metric 留档。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "nickname": { "type": "string", "description": "昵称" },
                    "sex": { "type": "string", "enum": ["male","female"], "description": "性别：male=男 / female=女" },
                    "birthday": { "type": "string", "description": "YYYY-MM-DD" },
                    "heightCm": { "type": "number", "description": "身高（cm）" },
                    "weightKg": { "type": "number", "description": "体重（kg）" },
                    "targetWeightKg": { "type": "number", "description": "目标体重（kg）" },
                    "activityLevel": { "type": "string", "enum": ["sedentary","light","moderate","active"], "description": "活动水平：sedentary=久坐 / light=轻度活动 / moderate=中度活动 / active=高度活动" },
                    "goal": { "type": "string", "enum": ["cut","keep","bulk"], "description": "目标：cut=减脂 / keep=保持 / bulk=增肌" }
                }
            }),
        },
        RegisteredTool {
            name: "list_body_metrics",
            group: "nutrition",
            label: "查看体重身高记录",
            description: "按时间倒序查看最近的体重 / 身高记录。查最新体重时 limit 取 1。",
            parameters: json!({
                "type": "object",
                "properties": { "limit": { "type": "number", "description": "最多返回条数，默认 30" } }
            }),
        },
        RegisteredTool {
            name: "record_body_metric",
            group: "nutrition",
            label: "记录体重身高",
            description: "补录一条体重和/或身高（同日再记只覆盖）。date 不传默认今天。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "weightKg": { "type": "number", "description": "体重（kg）" },
                    "heightCm": { "type": "number", "description": "身高（cm）" },
                    "date": { "type": "string", "description": "YYYY-MM-DD，缺省为今天" }
                }
            }),
        },
        RegisteredTool {
            name: "delete_body_metric",
            group: "nutrition",
            label: "删除体重身高记录",
            description: "删除一条体重 / 身高记录。仅限用户明确要求删除时使用；id 来自 list_body_metrics。",
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "number", "description": "list_body_metrics 返回的记录 id" } },
                "required": ["id"]
            }),
        },
    ]
}
