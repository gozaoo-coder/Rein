//! 饮食域工具（对应 TS tools/diet.ts）：食物库检索/新增 + 餐次记录 CRUD。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::{ReinError, Result};
use crate::modules::diet::commands as diet;
use crate::modules::diet::models::{FoodCreateInput, FoodUnit};
use crate::state::AppState;

use super::{resolve_date, RegisteredTool};

fn food_brief(f: &crate::modules::diet::models::Food) -> Value {
    json!({
        "id": f.id, "name": f.name, "category": f.category,
        "kcal": f.kcal, "protein": f.protein, "carb": f.carb, "fat": f.fat,
        "defaultUnit": f.default_unit,
    })
}

fn meal_type_arg(args: &Value) -> Result<String> {
    let v = args.get("mealType").and_then(|x| x.as_str()).unwrap_or("");
    match v {
        "breakfast" | "lunch" | "dinner" | "snack" => Ok(v.to_string()),
        _ => Err(ReinError::Message(format!(
            "mealType 应为 breakfast/lunch/dinner/snack，收到「{v}」"
        ))),
    }
}

fn f64_arg(args: &Value, key: &str) -> Result<f64> {
    args.get(key)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| ReinError::Message(format!("参数 {key} 缺失或不是数字")))
}

/// 分派；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    Some(match name {
        "search_food" => run_search(app, args).await,
        "get_food" => run_get(app, args).await,
        "list_meals" => run_list_meals(app, args).await,
        "log_meal" => run_log_meal(app, args).await,
        "create_food" => run_create_food(app, args).await,
        "delete_meal" => run_delete_meal(app, args).await,
        _ => return None,
    })
}

async fn run_search(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let limit = Some(super::num_arg(args, "limit", 15.0).clamp(1.0, 30.0) as i64);
    let q = args.get("query").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    let state = app.state::<AppState>();
    // 模糊搜索算法在 Rust 层；无关键词时回退常用列表（与 TS 一致）
    let rows = match q {
        Some(q) => diet::search_foods_fuzzy(&state, Some(q.to_string()), limit)?,
        None => diet::list_foods(&state, None, None, limit)?,
    };
    Ok(json!(rows.iter().map(food_brief).collect::<Vec<_>>()))
}

async fn run_get(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = f64_arg(args, "id")? as i64;
    let state = app.state::<AppState>();
    let f = diet::get_food(&state, id)?
        .ok_or_else(|| ReinError::Message(format!("食物不存在：id={id}")))?;
    Ok(serde_json::to_value(&f)?)
}

async fn run_list_meals(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let date = resolve_date(args, "date")?;
    let state = app.state::<AppState>();
    let rows = diet::list_meals(&state, date.clone())?;
    let mut total_kcal = 0f64;
    let meals: Vec<Value> = rows
        .iter()
        .map(|m| {
            let kcal = ((m.food.as_ref().map(|f| f.kcal).unwrap_or(0.0)) * m.grams / 100.0).round();
            total_kcal += kcal;
            json!({
                "id": m.id,
                "mealType": m.meal_type,
                "foodName": m.food.as_ref().map(|f| f.name.clone()).unwrap_or_else(|| format!("food#{}", m.food_id)),
                "grams": m.grams,
                "kcal": kcal,
                "note": m.note,
            })
        })
        .collect();
    Ok(json!({ "date": date, "totalKcal": total_kcal, "count": meals.len(), "meals": meals }))
}

async fn run_log_meal(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let food_id = f64_arg(args, "foodId")? as i64;
    let state = app.state::<AppState>();
    let food = diet::get_food(&state, food_id)?
        .ok_or_else(|| ReinError::Message(format!("食物不存在：id={food_id}，请先用 search_food 确认")))?;
    let grams = args.get("grams").and_then(|v| v.as_f64());
    if let Some(g) = grams {
        if !g.is_finite() || g <= 0.0 {
            return Err(ReinError::Message(format!("克重非法：{g}")));
        }
    }
    let meal = diet::log_meal(
        &state,
        food.id,
        resolve_date(args, "date")?,
        meal_type_arg(args)?,
        "grams".into(),
        grams.unwrap_or(100.0),
        None,
        None,
        "text_ai".into(),
        args.get("note").and_then(|v| v.as_str()).map(str::to_string),
    )?;
    Ok(json!({ "ok": true, "mealId": meal.id, "foodName": food.name, "grams": meal.grams }))
}

async fn run_create_food(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let name = str_arg(args, "name")?.trim().to_string();
    if name.is_empty() {
        return Err(ReinError::Message("食物名称不能为空".into()));
    }
    let kcal = f64_arg(args, "kcal")?;
    let protein = f64_arg(args, "protein")?;
    let carb = f64_arg(args, "carb")?;
    let fat = f64_arg(args, "fat")?;
    for (label, v) in [("热量", kcal), ("蛋白质", protein), ("碳水", carb), ("脂肪", fat)] {
        if !v.is_finite() || v < 0.0 {
            return Err(ReinError::Message(format!("{label}数值非法：{v}")));
        }
    }
    let units: Vec<FoodUnit> = args
        .get("units")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|u| {
                    let name = u.get("name")?.as_str()?.trim().to_string();
                    let grams = u.get("grams")?.as_f64()?;
                    (grams.is_finite() && grams > 0.0).then(|| FoodUnit {
                        name,
                        grams: grams.round(),
                    })
                })
                .take(4)
                .collect()
        })
        .unwrap_or_default();
    let input = FoodCreateInput {
        name,
        category: args.get("category").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        kcal,
        protein,
        carb,
        fat,
        fiber: args.get("fiber").and_then(|v| v.as_f64()).unwrap_or(0.0),
        sugar: args.get("sugar").and_then(|v| v.as_f64()).unwrap_or(0.0),
        sodium_mg: args.get("sodiumMg").and_then(|v| v.as_f64()).unwrap_or(0.0),
        default_unit: args.get("defaultUnit").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
        units,
    };
    let state = app.state::<AppState>();
    let r = diet::create_food(&state, input)?;
    let message = if r.created {
        format!("已创建「{}」（id={}），可直接用于 log_meal", r.food.name, r.food.id)
    } else {
        format!("食物库已有同名「{}」（id={}），直接复用即可", r.food.name, r.food.id)
    };
    Ok(json!({ "id": r.food.id, "name": r.food.name, "created": r.created, "message": message }))
}

async fn run_delete_meal(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = f64_arg(args, "id")? as i64;
    let state = app.state::<AppState>();
    diet::delete_meal(&state, id)?;
    Ok(json!({ "ok": true }))
}

/* ---------- defs ---------- */

pub fn search_food() -> RegisteredTool {
    RegisteredTool {
        name: "search_food",
        group: "diet",
        label: "搜索食物库",
        description: "按名称模糊搜索 Rein 食物库（按字包含/顺序相似度排序），返回 id 与每 100g 营养。记录饮食前先用它确认 foodId；换几个通用关键词再搜（别名、同类）往往能命中。库里确实没有时不要放弃这条记录：先按构成处理（web_search 查配料与营养，或拆成库内已有食材），再用 create_food 补录。",
        parameters: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "名称关键词，如「米饭」「无糖可乐」；不传返回常见食物" },
                "limit": { "type": "number", "description": "最多返回条数，默认 15，最大 30" }
            }
        }),
    }
}

pub fn get_food() -> RegisteredTool {
    RegisteredTool {
        name: "get_food",
        group: "diet",
        label: "查询食物详情",
        description: "按 id 查询单个食物的完整营养信息（每 100g，含维生素矿物质）。",
        parameters: json!({
            "type": "object",
            "properties": { "id": { "type": "number", "description": "search_food 返回的食物 id" } },
            "required": ["id"]
        }),
    }
}

pub fn list_meals() -> RegisteredTool {
    RegisteredTool {
        name: "list_meals",
        group: "diet",
        label: "查看饮食记录",
        description: "查看某一天的已记录餐次（含换算后热量）。date 不传默认今天。",
        parameters: json!({
            "type": "object",
            "properties": { "date": { "type": "string", "description": "YYYY-MM-DD，缺省为今天" } }
        }),
    }
}

pub fn log_meal() -> RegisteredTool {
    RegisteredTool {
        name: "log_meal",
        group: "diet",
        label: "写入饮食记录",
        description: "把一条食物写入指定日期的餐次记录。foodId 必填——先用 search_food 搜索并选定；库里没有时先调 create_food 补录（营养按每 100g 估算）拿到新 id 再写，不要硬写。",
        parameters: json!({
            "type": "object",
            "properties": {
                "foodId": { "type": "number", "description": "search_food 选定的食物 id" },
                "grams": { "type": "number", "description": "克重，按常见份量估算，默认 100" },
                "mealType": { "type": "string", "enum": ["breakfast","lunch","dinner","snack"], "description": "餐次：breakfast=早餐 / lunch=午餐 / dinner=晚餐 / snack=加餐" },
                "date": { "type": "string", "description": "YYYY-MM-DD，缺省为今天" },
                "note": { "type": "string", "description": "备注" }
            },
            "required": ["foodId", "mealType"]
        }),
    }
}

pub fn create_food() -> RegisteredTool {
    RegisteredTool {
        name: "create_food",
        group: "diet",
        label: "新增食物到库",
        description: "把食物库没有的食品新建进 Rein 食物库，营养按每 100g 估算。**估算要有依据**：优先用它的构成换算（配料/菜谱配比；品牌与包装食品可先用 web_search 查配料表与营养成分），或参考库内最接近的同类食品；拿不准构成就先问用户，不要凭空填数字。search_food 确认库里没有时可直接调用补录（无需先征求用户同意），建完用返回的 id 继续后续动作；同名已存在时直接返回已有记录（不重复建）。",
        parameters: json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "食品通用名称，不带品牌/规格后缀，如「杨枝甘露」" },
                "kcal": { "type": "number", "description": "每 100g 热量（大卡）" },
                "protein": { "type": "number", "description": "每 100g 蛋白质（g）" },
                "carb": { "type": "number", "description": "每 100g 碳水（g）" },
                "fat": { "type": "number", "description": "每 100g 脂肪（g）" },
                "category": { "type": "string", "description": "分类：主食/肉蛋/水产/蔬菜/水果/豆制品/奶类/坚果/油脂/饮品/调味品/零食/加工食品/其他" },
                "fiber": { "type": "number", "description": "每 100g 膳食纤维（g），未知可省略" },
                "sugar": { "type": "number", "description": "每 100g 糖（g），未知可省略" },
                "sodiumMg": { "type": "number", "description": "每 100g 钠（mg），未知可省略" },
                "defaultUnit": { "type": "string", "description": "常用份单位名，如 碗/个/杯/片" },
                "units": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string", "description": "份单位名，如 碗" }, "grams": { "type": "number", "description": "一份对应的克重" } }, "required": ["name", "grams"] }, "description": "份单位换算表，最多 4 个" }
            },
            "required": ["name", "kcal", "protein", "carb", "fat"]
        }),
    }
}

pub fn delete_meal() -> RegisteredTool {
    RegisteredTool {
        name: "delete_meal",
        group: "diet",
        label: "删除饮食记录",
        description: "删除一条饮食记录。仅限用户明确要求删除时使用；id 来自 list_meals。",
        parameters: json!({
            "type": "object",
            "properties": { "id": { "type": "number", "description": "list_meals 返回的记录 id" } },
            "required": ["id"]
        }),
    }
}
