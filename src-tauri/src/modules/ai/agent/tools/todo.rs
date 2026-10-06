//! 待办域工具（对应 TS tools/todo.ts）：分页列表 / 日程分布 / 增删改。

use serde_json::{json, Value};
use tauri::Manager;

use crate::error::{ReinError, Result};
use crate::modules::todo::commands as todo;
use crate::modules::todo::models::{RecRule, Todo};
use crate::state::AppState;

use super::{num_arg, resolve_date, RegisteredTool};

/// 重复规则摘要（对齐 TS describeRule：WD=['一','二','三','四','五','六','日']）
fn describe_rule(rule: &RecRule) -> String {
    match rule.freq.as_str() {
        "daily" => "每天".into(),
        "weekly" => {
            let mut wd: Vec<i64> = rule.weekdays.clone();
            wd.sort_unstable();
            let names = ["一", "二", "三", "四", "五", "六", "日"];
            let ds: Vec<&str> = wd.iter().map(|d| names.get(*d as usize).copied().unwrap_or("?")).collect();
            if ds.is_empty() {
                "每周".into()
            } else {
                format!("每周{}", ds.join("、"))
            }
        }
        "interval" => format!("每 {} 天", rule.interval_days),
        _ => "重复".into(),
    }
}

/// 列表投影：只留模型需要的字段（对齐 TS brief）
fn brief(t: &Todo) -> Value {
    let subtasks = t.subtasks.as_ref().filter(|s| !s.is_empty()).map(|s| {
        let done = s.iter().filter(|x| x.done).count();
        format!("{done}/{} 完成", s.len())
    });
    json!({
        "id": t.id,
        "title": t.title,
        "date": t.date,
        "startMin": t.start_min,
        "durationMin": t.duration_min,
        "category": t.category,
        "priority": t.priority,
        "status": t.status,
        "subtasks": subtasks,
        "repeat": t.rec_rule.as_ref().map(describe_rule),
    })
}

/// 分派；返回 None 表示名字不归本模块
pub async fn run(app: &tauri::AppHandle, name: &str, args: &Value) -> Option<Result<Value>> {
    Some(match name {
        "list_todos" => run_list(app, args).await,
        "todo_distribution" => run_distribution(app, args).await,
        "create_todo" => run_create(app, args).await,
        "update_todo" => run_update(app, args).await,
        "delete_todo" => run_delete(app, args).await,
        _ => return None,
    })
}

async fn run_list(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let limit = Some(num_arg(args, "limit", 20.0).clamp(1.0, 20.0) as i64);
    let page = num_arg(args, "page", 1.0).max(1.0) as i64;
    let offset = (page - 1) * limit.unwrap_or(20);
    let today = super::today_str();
    let start_raw = args
        .get("start")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| args.get("end").and_then(|v| v.as_str()).filter(|s| !s.is_empty()));
    let state = app.state::<AppState>();
    let res = match start_raw {
        Some(s) => {
            let start = resolve_date(args, "start")?;
            let end = match args.get("end").and_then(|v| v.as_str()).filter(|x| !x.is_empty()) {
                Some(_) => resolve_date(args, "end")?,
                None => start.clone(),
            };
            todo::query_todos(&state, today, Some("range".into()), Some(start), Some(end), limit, Some(offset))?
        }
        None => todo::query_todos(&state, today, Some("focus".into()), None, None, limit, Some(offset))?,
    };
    let items: Vec<Value> = res.items.iter().map(brief).collect();
    Ok(json!({
        "items": items,
        "page": page,
        "total": res.total,
        "hasMore": offset + items.len() as i64 < res.total,
    }))
}

async fn run_distribution(app: &tauri::AppHandle, _args: &Value) -> Result<Value> {
    let state = app.state::<AppState>();
    let dist = todo::todo_distribution(&state, super::today_str())?;
    // 年 → 月 → 日 计数；键归一为非补零数字串（对齐 TS，键序按数值升序）
    let mut years = serde_json::Map::new();
    for d in &dist.days {
        let parts: Vec<&str> = d.date.split('-').collect();
        if parts.len() != 3 {
            continue;
        }
        let month_key = (parts[1].parse::<i64>().unwrap_or(0)).to_string();
        let day_key = (parts[2].parse::<i64>().unwrap_or(0)).to_string();
        let year = years.entry(parts[0].to_string()).or_insert_with(|| json!({}));
        let month = year
            .as_object_mut()
            .unwrap()
            .entry(month_key)
            .or_insert_with(|| json!({}));
        month.as_object_mut().unwrap().insert(day_key, json!(d.count));
    }
    Ok(json!({ "years": Value::Object(years), "inbox": dist.inbox, "overdue": dist.overdue }))
}

fn rec_rule_arg(args: &Value) -> Result<Option<RecRule>> {
    let Some(r) = args.get("repeat") else { return Ok(None) };
    let freq = r.get("freq").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if freq.is_empty() {
        return Ok(None);
    }
    Ok(Some(RecRule {
        freq,
        weekdays: r
            .get("weekdays")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default(),
        interval_days: r.get("intervalDays").and_then(|v| v.as_i64()).unwrap_or(0),
        end_date: r
            .get("endDate")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }))
}

fn hhmm_to_min(v: &str) -> Result<i64> {
    let parts: Vec<&str> = v.trim().split(':').collect();
    if parts.len() != 2 {
        return Err(ReinError::Message(format!("时间格式应为 HH:mm，收到「{v}」")));
    }
    let h: i64 = parts[0].trim().parse().map_err(|_| ReinError::Message(format!("时间格式应为 HH:mm，收到「{v}」")))?;
    let m: i64 = parts[1].trim().parse().map_err(|_| ReinError::Message(format!("时间格式应为 HH:mm，收到「{v}」")))?;
    if !(0..24).contains(&h) || !(0..60).contains(&m) {
        return Err(ReinError::Message(format!("时间超出范围：{v}")));
    }
    Ok(h * 60 + m)
}

async fn run_create(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let title = super::str_arg(args, "title")?.trim().to_string();
    if title.is_empty() {
        return Err(ReinError::Message("标题不能为空".into()));
    }
    let date = match args.get("date").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        Some(_) => Some(resolve_date(args, "date")?),
        None => None,
    };
    let start_min = match args.get("startTime").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        Some(t) => Some(hhmm_to_min(t)?),
        None => None,
    };
    let state = app.state::<AppState>();
    let t = todo::create_todo(
        &state,
        title,
        args.get("notes").and_then(|v| v.as_str()).map(str::to_string),
        date,
        start_min,
        args.get("durationMin").and_then(|v| v.as_i64()),
        args.get("category").and_then(|v| v.as_str()).map(str::to_string),
        args.get("priority").and_then(|v| v.as_i64()),
        rec_rule_arg(args)?,
        None,
        None,
    )?;
    Ok(json!({ "ok": true, "id": t.id, "todo": brief(&t) }))
}

async fn run_update(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = num_arg(args, "id", 0.0) as i64;
    let state = app.state::<AppState>();
    let all = todo::list_all_todos(&state)?;
    let mut cur = all
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| ReinError::Message(format!("待办不存在：id={id}（先用 list_todos 查 id）")))?;
    if let Some(t) = args.get("title").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        cur.title = t.to_string();
    }
    if let Some(n) = args.get("notes").and_then(|v| v.as_str()) {
        cur.notes = Some(n.to_string());
    }
    if let Some(d) = args.get("date").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
        cur.date = Some(resolve_date(args, "date")?);
    }
    if let Some(t) = args.get("startTime").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        cur.start_min = Some(hhmm_to_min(t)?);
    }
    if let Some(d) = args.get("durationMin").and_then(|v| v.as_i64()) {
        cur.duration_min = Some(d);
    }
    if let Some(c) = args.get("category").and_then(|v| v.as_str()) {
        cur.category = c.to_string();
    }
    if let Some(p) = args.get("priority").and_then(|v| v.as_i64()) {
        cur.priority = p;
    }
    if let Some(s) = args.get("status").and_then(|v| v.as_str()) {
        cur.status = s.to_string();
    }
    let saved = todo::update_todo(&state, cur)?;
    Ok(json!({ "ok": true, "todo": brief(&saved) }))
}

async fn run_delete(app: &tauri::AppHandle, args: &Value) -> Result<Value> {
    let id = num_arg(args, "id", 0.0) as i64;
    let state = app.state::<AppState>();
    todo::delete_todo(&state, id)?;
    Ok(json!({ "ok": true }))
}

/* ---------- defs ---------- */

const CATEGORY_DESC: &str = "分类：general=日常 / workout=运动 / health=健康 / study=学习 / work=工作";
const PRIORITY_DESC: &str = "重要程度：0=普通 / 1=重要 / 2=紧急";

pub fn defs() -> Vec<RegisteredTool> {
    vec![
        RegisteredTool {
            name: "list_todos",
            group: "todo",
            label: "查看待办（分页）",
            description: "分页查看待办。不传日期 = 聚焦视图：逾期未完成 + 未来7天 + 收件箱（收件箱排最后）；传 start/end（YYYY-MM-DD）查指定日期区间。返回 {items, page, total, hasMore}，hasMore 为 true 时用 page 翻页；limit 默认/最大 20。改某条待办前先在这里找 id。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "每页条数，默认 20，最大 20" },
                    "page": { "type": "number", "description": "页码，从 1 起，默认 1" },
                    "start": { "type": "string", "description": "区间起 YYYY-MM-DD（与 end 任一传入即按区间查询）" },
                    "end": { "type": "string", "description": "区间止 YYYY-MM-DD，缺省同 start" }
                }
            }),
        },
        RegisteredTool {
            name: "todo_distribution",
            group: "todo",
            label: "日程分布总览",
            description: "查看全部日程的按日分布计数（年→月→日 层级，只给数量不给明细），附收件箱与逾期条数。想知道哪几天安排得多、该从哪天下钻时先调它，再用 list_todos 传 start/end 查明细，不要试图一次拉全量。",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        RegisteredTool {
            name: "create_todo",
            group: "todo",
            label: "新建待办",
            description: "创建一条待办。date 不传进收件箱；要排在某天就传 YYYY-MM-DD，可另给 startTime（HH:mm）与 durationMin。每个单元事件独立一条待办、各有自己的 date/startTime/durationMin——多段任务拆成多条分别创建，不要塞进同一条的备注或子任务里。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "标题" },
                    "notes": { "type": "string", "description": "备注" },
                    "date": { "type": "string", "description": "YYYY-MM-DD；缺省 = 不安排日期（收件箱）" },
                    "startTime": { "type": "string", "description": "开始时间 HH:mm（需与 date 同传才有意义）" },
                    "durationMin": { "type": "number", "description": "预计时长（分钟）" },
                    "category": { "type": "string", "enum": ["general","workout","health","study","work"], "description": CATEGORY_DESC },
                    "priority": { "type": "number", "enum": [0,1,2], "description": PRIORITY_DESC },
                    "repeat": { "type": "object", "properties": {
                        "freq": { "type": "string", "enum": ["daily","weekly","interval"] },
                        "weekdays": { "type": "array", "items": { "type": "number" }, "description": "weekly 专用：周一=0…周日=6" },
                        "intervalDays": { "type": "number", "description": "interval 专用：每 N 天" },
                        "endDate": { "type": "string", "description": "结束日期 YYYY-MM-DD，缺省永不" }
                    }, "description": "重复规则；用户说\"每天/每周X/每N天\"时才传" }
                },
                "required": ["title"]
            }),
        },
        RegisteredTool {
            name: "update_todo",
            group: "todo",
            label: "修改待办",
            description: "修改一条待办，只传需要改的字段；id 来自 list_todos。标记完成传 status:\"done\"。每次调用只动一条事件，批量调整多个事件时逐条调用。",
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "number", "description": "待办 id" },
                    "title": { "type": "string", "description": "新标题" },
                    "notes": { "type": "string", "description": "新备注" },
                    "date": { "type": "string", "description": "改期到 YYYY-MM-DD" },
                    "startTime": { "type": "string", "description": "开始时间 HH:mm" },
                    "durationMin": { "type": "number", "description": "时长（分钟）" },
                    "category": { "type": "string", "enum": ["general","workout","health","study","work"], "description": CATEGORY_DESC },
                    "priority": { "type": "number", "enum": [0,1,2], "description": PRIORITY_DESC },
                    "status": { "type": "string", "enum": ["todo","doing","done"], "description": "状态：todo=待办 / doing=进行中 / done=已完成" }
                },
                "required": ["id"]
            }),
        },
        RegisteredTool {
            name: "delete_todo",
            group: "todo",
            label: "删除待办",
            description: "删除一条待办。仅限用户明确要求删除时使用。",
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "number", "description": "待办 id" } },
                "required": ["id"]
            }),
        },
    ]
}
