//! 记账域工具（对应 TS tools/ledger.ts）：流水 CRUD + 月度预算。存储为整数分，工具层用元。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::{ReinError, Result};
use crate::modules::ledger::commands as ledger;
use crate::modules::ledger::models::{LedgerEntry, LedgerEntryInput};
use crate::state::AppState;

use super::{num_arg, resolve_date, RegisteredTool};

/// 分类 key 与合法 kind（与前端 src/config/ledger.ts 一致）
const EXPENSE_CATEGORIES: [&str; 10] =
    ["food", "transport", "shopping", "entertainment", "housing", "medical", "education", "bills", "travel", "other"];
const INCOME_CATEGORIES: [&str; 4] = ["salary", "bonus", "refund", "other"];

fn categories_of(kind: &str) -> &'static [&'static str] {
    if kind == "income" { &INCOME_CATEGORIES } else { &EXPENSE_CATEGORIES }
}

fn assert_category(kind: &str, category: &str) -> Result<()> {
    if categories_of(kind).contains(&category) {
        Ok(())
    } else {
        let valid = categories_of(kind).join("/");
        Err(ReinError::Message(format!(
            "「{category}」不是{}的合法分类，可选：{valid}",
            if kind == "expense" { "支出" } else { "收入" }
        )))
    }
}

fn cents_to_yuan(cents: i64) -> f64 {
    cents as f64 / 100.0
}

fn yuan_to_cents(yuan: f64) -> i64 {
    (yuan * 100.0).round() as i64
}

fn brief(e: &LedgerEntry) -> Value {
    json!({
        "id": e.id,
        "kind": e.kind,
        "category": e.category,
        "amountYuan": cents_to_yuan(e.amount_cents),
        "note": e.note,
        "date": e.date,
    })
}

/// 本月 1 日 / 月末（对齐 TS startOfMonth/endOfMonth）
fn month_bounds(today: &str) -> (String, String) {
    let parts: Vec<&str> = today.split('-').collect();
    let (y, m) = (parts[0].parse::<i32>().unwrap_or(2026), parts[1].parse::<u32>().unwrap_or(1));
    let start = format!("{y:04}-{m:02}-01");
    let last_day = [31, if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m as usize - 1).min(11)];
    (start, format!("{y:04}-{m:02}-{last_day:02}"))
}

/// 分派；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    Some(match name {
        "list_entries" => run_list(app, args).await,
        "create_entry" => run_create(app, args).await,
        "update_entry" => run_update(app, args).await,
        "delete_entry" => run_delete(app, args).await,
        "get_budget" => run_get_budget(app, args).await,
        "set_budget" => run_set_budget(app, args).await,
        _ => return None,
    })
}

async fn run_list(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let today = super::today_str();
    let (month_start, month_end) = month_bounds(&today);
    let start = match args.get("start").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        Some(_) => resolve_date(args, "start")?,
        None => month_start,
    };
    let end = match args.get("end").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        Some(_) => resolve_date(args, "end")?,
        None => month_end,
    };
    let state = app.state::<AppState>();
    let rows = ledger::list_ledger_entries(
        &state,
        start,
        end,
        args.get("category").and_then(|v| v.as_str()).map(str::to_string),
        args.get("keyword").and_then(|v| v.as_str()).map(str::to_string),
    )?;
    let mut expense = 0i64;
    let mut income = 0i64;
    let entries: Vec<Value> = rows
        .iter()
        .map(|e| {
            if e.kind == "expense" {
                expense += e.amount_cents;
            } else {
                income += e.amount_cents;
            }
            brief(e)
        })
        .collect();
    Ok(json!({
        "count": entries.len(),
        "expenseYuan": cents_to_yuan(expense),
        "incomeYuan": cents_to_yuan(income),
        "entries": entries,
    }))
}

fn kind_arg(args: &Value) -> Result<String> {
    let v = args.get("kind").and_then(|x| x.as_str()).unwrap_or("");
    match v {
        "expense" | "income" => Ok(v.to_string()),
        _ => Err(ReinError::Message(format!("kind 应为 expense/income，收到「{v}」"))),
    }
}

async fn run_create(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let kind = kind_arg(args)?;
    let category = super::str_arg(args, "category")?.to_string();
    assert_category(&kind, &category)?;
    let amount = num_arg(args, "amountYuan", 0.0);
    if amount <= 0.0 {
        return Err(ReinError::Message(format!("金额必须为正数：{amount}")));
    }
    let state = app.state::<AppState>();
    let row = ledger::create_ledger_entry(
        &state,
        LedgerEntryInput {
            kind,
            category,
            amount_cents: yuan_to_cents(amount),
            note: args.get("note").and_then(|v| v.as_str()).map(str::to_string),
            date: resolve_date(args, "date")?,
        },
    )?;
    Ok(json!({ "ok": true, "id": row.id, "entry": brief(&row) }))
}

async fn run_update(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = num_arg(args, "id", 0.0) as i64;
    let state = app.state::<AppState>();
    let all = ledger::list_ledger_entries(&state, "2000-01-01".into(), "2999-12-31".into(), None, None)?;
    let mut cur = all
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| ReinError::Message(format!("流水不存在：id={id}（先用 list_entries 查 id）")))?;
    let kind = match args.get("kind").and_then(|v| v.as_str()) {
        Some(k) => k.to_string(),
        None => cur.kind.clone(),
    };
    let category = args.get("category").and_then(|v| v.as_str()).unwrap_or(&cur.category).to_string();
    assert_category(&kind, &category)?;
    if let Some(a) = args.get("amountYuan").and_then(|v| v.as_f64()) {
        if a <= 0.0 {
            return Err(ReinError::Message(format!("金额必须为正数：{a}")));
        }
        cur.amount_cents = yuan_to_cents(a);
    }
    cur.kind = kind;
    cur.category = category;
    if let Some(n) = args.get("note").and_then(|v| v.as_str()) {
        cur.note = Some(n.to_string());
    }
    if args.get("date").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).is_some() {
        cur.date = resolve_date(args, "date")?;
    }
    let saved = ledger::update_ledger_entry(&state, cur)?;
    Ok(json!({ "ok": true, "entry": brief(&saved) }))
}

async fn run_delete(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = num_arg(args, "id", 0.0) as i64;
    let state = app.state::<AppState>();
    ledger::delete_ledger_entry(&state, id)?;
    Ok(json!({ "ok": true }))
}

async fn run_get_budget(app: &tauri::AppHandle, _args: &Value) -> Result<Value> {
    let state = app.state::<AppState>();
    let s = ledger::get_ledger_budget(&state)?;
    Ok(json!({ "monthlyBudgetYuan": cents_to_yuan(s.monthly_budget_cents), "updatedAt": s.updated_at }))
}

async fn run_set_budget(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let yuan = num_arg(args, "monthlyBudgetYuan", 0.0);
    if yuan < 0.0 {
        return Err(ReinError::Message(format!("预算不能为负：{yuan}")));
    }
    let state = app.state::<AppState>();
    ledger::set_ledger_budget(&state, yuan_to_cents(yuan))?;
    Ok(json!({ "ok": true, "monthlyBudgetYuan": yuan }))
}

/* ---------- defs ---------- */

pub fn defs() -> Vec<RegisteredTool> {
    vec![
        RegisteredTool {
            name: "list_entries",
            group: "ledger",
            label: "查看账目",
            description: "查看某日期区间的收支流水，可按分类过滤、按备注关键词搜索。区间不传默认本月。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "start": { "type": "string", "description": "起始 YYYY-MM-DD，缺省为本月 1 日" },
                    "end": { "type": "string", "description": "结束 YYYY-MM-DD，缺省为本月末" },
                    "category": { "type": "string", "description": "按分类 key 过滤" },
                    "keyword": { "type": "string", "description": "按备注关键词模糊搜索" }
                }
            }),
        },
        RegisteredTool {
            name: "create_entry",
            group: "ledger",
            label: "记一笔账",
            description: "新增一条收入或支出。amountYuan 为正数金额（元）；date 不传默认今天。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["expense","income"], "description": "expense=支出 / income=收入" },
                    "category": { "type": "string", "enum": ["food","transport","shopping","entertainment","housing","medical","education","bills","travel","salary","bonus","refund","other"], "description": "分类 key：food=餐饮 / transport=交通 / shopping=购物 / entertainment=娱乐 / housing=居住 / medical=医疗 / education=教育 / bills=通讯缴费 / travel=旅行 / salary=工资 / bonus=奖金 / refund=退款 / other=其他" },
                    "amountYuan": { "type": "number", "description": "金额（元，正数），如 25.5" },
                    "date": { "type": "string", "description": "YYYY-MM-DD，缺省为今天" },
                    "note": { "type": "string", "description": "备注" }
                },
                "required": ["kind", "category", "amountYuan"]
            }),
        },
        RegisteredTool {
            name: "update_entry",
            group: "ledger",
            label: "修改账目",
            description: "修改一条流水，只传需要改的字段；id 来自 list_entries。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "number", "description": "流水 id" },
                    "kind": { "type": "string", "enum": ["expense","income"], "description": "expense=支出 / income=收入" },
                    "category": { "type": "string", "description": "分类 key" },
                    "amountYuan": { "type": "number", "description": "新金额（元，正数）" },
                    "date": { "type": "string", "description": "改到 YYYY-MM-DD" },
                    "note": { "type": "string", "description": "新备注" }
                },
                "required": ["id"]
            }),
        },
        RegisteredTool {
            name: "delete_entry",
            group: "ledger",
            label: "删除账目",
            description: "删除一条流水。仅限用户明确要求删除时使用。",
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "number", "description": "流水 id" } },
                "required": ["id"]
            }),
        },
        RegisteredTool {
            name: "get_budget",
            group: "ledger",
            label: "查看月度预算",
            description: "查看月度总预算（元）。未设置返回 0。",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        RegisteredTool {
            name: "set_budget",
            group: "ledger",
            label: "设置月度预算",
            description: "设置月度总预算（元）；传 0 表示清除预算。",
            parameters: json!({
                "type": "object",
                "properties": { "monthlyBudgetYuan": { "type": "number", "description": "月度预算（元），≥0" } },
                "required": ["monthlyBudgetYuan"]
            }),
        },
    ]
}
