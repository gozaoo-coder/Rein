//! 待办域命令 · 命令名与前端 `todoService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use chrono::{Datelike, Duration, NaiveDate, Utc};

use super::models::{RecRule, Todo, TodoSubtask};

const COLS: &str = "id, title, notes, date, start_min, duration_min, category, priority, status, completed_at, created_at, program_id, rec_rule, rec_key, subtasks";

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 周一 = 0 … 周日 = 6（与前端 weekDates/WEEKDAY_LABELS 对齐）
fn dow_of(d: NaiveDate) -> i64 {
    d.weekday().num_days_from_monday() as i64
}

fn json_str<T: serde::Serialize>(v: &Option<T>) -> Option<String> {
    v.as_ref()
        .map(|x| serde_json::to_string(x).expect("序列化不可失败"))
}

fn rule_matches(rule: &RecRule, template_date: &str, date: &str) -> bool {
    if let (Some(end), Some(d)) = (&rule.end_date, parse_date(date)) {
        if let Some(e) = parse_date(end) {
            if d > e {
                return false;
            }
        }
    }
    let (Some(t), Some(d)) = (parse_date(template_date), parse_date(date)) else {
        return false;
    };
    if d < t {
        return false;
    }
    match rule.freq.as_str() {
        "daily" => true,
        "weekly" => rule.weekdays.contains(&dow_of(d)),
        "interval" => rule.interval_days > 0 && (d - t).num_days() % rule.interval_days == 0,
        _ => false,
    }
}

/// 子任务实例化：结构照抄、勾选状态清零（新的一天从零开始）
/// 重复待办模板行：物化实例所需的字段快照
struct RecTemplate {
    id: i64,
    title: String,
    notes: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: String,
    priority: i64,
    subtasks: Option<String>,
    rec_rule: Option<String>,
    date: Option<String>,
}

fn reset_subtasks(raw: &Option<String>) -> Option<String> {
    let subs: Vec<TodoSubtask> =
        serde_json::from_str(raw.as_deref().unwrap_or("[]")).unwrap_or_default();
    if subs.is_empty() {
        return None;
    }
    let reset: Vec<TodoSubtask> = subs
        .into_iter()
        .map(|s| TodoSubtask { title: s.title, done: false })
        .collect();
    Some(serde_json::to_string(&reset).expect("序列化不可失败"))
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    let rec_rule: Option<RecRule> = row
        .get::<_, Option<String>>(12)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let rec_key: Option<String> = row.get(13)?;
    let subtasks: Option<Vec<TodoSubtask>> = row
        .get::<_, Option<String>>(14)?
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Todo {
        id: row.get(0)?,
        title: row.get(1)?,
        notes: row.get(2)?,
        date: row.get(3)?,
        start_min: row.get(4)?,
        duration_min: row.get(5)?,
        category: row.get(6)?,
        priority: row.get(7)?,
        status: row.get(8)?,
        completed_at: row.get(9)?,
        created_at: row.get(10)?,
        program_id: row.get(11)?,
        rec_rule,
        rec_key,
        subtasks,
    })
}

#[tauri::command]
pub fn list_todos(state: State<AppState>, start_date: String, end_date: String) -> Result<Vec<Todo>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM todos \
         WHERE date IS NOT NULL AND date BETWEEN ?1 AND ?2 \
         ORDER BY date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([&start_date, &end_date], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
/// 全部待办（含收件箱 date IS NULL），按 未完成→日期→时间→优先级 排序。
/// 供「全部待办」页与虚拟时间线使用。
pub fn list_all_todos(state: State<AppState>) -> Result<Vec<Todo>> {
    let conn = state.db.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM todos \
         ORDER BY (status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let todos = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(todos)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_todo(
    state: State<AppState>,
    title: String,
    notes: Option<String>,
    date: Option<String>,
    start_min: Option<i64>,
    duration_min: Option<i64>,
    category: Option<String>,
    priority: Option<i64>,
    rec_rule: Option<RecRule>,
    subtasks: Option<Vec<TodoSubtask>>,
) -> Result<Todo> {
    let conn = state.db.lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let category = category.unwrap_or_else(|| "general".into());
    conn.execute(
        "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, created_at, rec_rule, subtasks) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            title,
            notes,
            date,
            start_min,
            duration_min,
            category,
            priority.unwrap_or(0),
            now,
            json_str(&rec_rule),
            json_str(&subtasks),
        ],
    )?;
    let id = conn.last_insert_rowid();
    // 重复模板：自身即首日实例，rec_key = "id:日期"
    if rec_rule.is_some() {
        if let Some(d) = &date {
            conn.execute(
                "UPDATE todos SET rec_key = ?1 WHERE id = ?2",
                rusqlite::params![format!("{id}:{d}"), id],
            )?;
        }
    }
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 全量更新（前端持有完整对象；避免设计 patch 合并逻辑）。
#[tauri::command]
pub fn update_todo(state: State<AppState>, todo: Todo) -> Result<Todo> {
    let conn = state.db.lock().unwrap();
    // 模板改动后 rec_key 跟随自身日期，保持"模板 = 首日实例"不变式
    let rec_key: Option<String> = if todo.rec_rule.is_some() {
        todo.date.as_ref().map(|d| format!("{}:{}", todo.id, d))
    } else {
        None
    };
    conn.execute(
        "UPDATE todos SET title = ?1, notes = ?2, date = ?3, start_min = ?4, duration_min = ?5, \
         category = ?6, priority = ?7, status = ?8, completed_at = ?9, rec_rule = ?10, rec_key = ?11, subtasks = ?12 \
         WHERE id = ?13",
        rusqlite::params![
            todo.title,
            todo.notes,
            todo.date,
            todo.start_min,
            todo.duration_min,
            todo.category,
            todo.priority,
            todo.status,
            todo.completed_at,
            json_str(&todo.rec_rule),
            rec_key,
            json_str(&todo.subtasks),
            todo.id
        ],
    )?;
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, [todo.id], from_row)?)
}

#[tauri::command]
pub fn delete_todo(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
    Ok(())
}

#[tauri::command]
/// 重复实例物化（幂等，前端每次全量加载前调用）：
/// 1) 规则已不匹配/越界的未来未完成实例 → 删除（改规则、改结束日期后自动收敛）；
/// 2) 窗口 [今天-1, 今天+7] 内缺失的实例 → 按模板补建（rec_key = "模板id:日期"）。
/// 返回本次新增实例数。
pub fn sync_recurrences(state: State<AppState>, today: String) -> Result<usize> {
    let conn = state.db.lock().unwrap();
    let Some(today_d) = parse_date(&today) else {
        return Err(crate::error::ReinError::Message("日期格式应为 YYYY-MM-DD".into()));
    };
    let win_start = (today_d - Duration::days(1)).format("%Y-%m-%d").to_string();
    let win_end = (today_d + Duration::days(7)).format("%Y-%m-%d").to_string();

    // 1) 清理失效的未来未完成实例
    let stale: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, rec_key FROM todos \
             WHERE rec_key IS NOT NULL AND status != 'done' AND date IS NOT NULL AND date > ?1",
        )?;
        let rows = stmt
            .query_map([&today], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut deleted = 0usize;
    for (id, key) in stale {
        let Some((tid_s, ds)) = key.rsplit_once(':') else { continue };
        let Ok(tid) = tid_s.parse::<i64>() else { continue };
        let keep = conn
            .query_row(
                "SELECT rec_rule, date FROM todos WHERE id = ?1",
                [tid],
                |r| {
                    let raw: Option<String> = r.get(0)?;
                    let tdate: Option<String> = r.get(1)?;
                    Ok((raw, tdate))
                },
            )
            .ok()
            .and_then(|(raw, tdate)| {
                let rule: Option<RecRule> = raw.and_then(|s| serde_json::from_str(&s).ok());
                let td = tdate?;
                Some(matches!(rule, Some(r) if rule_matches(&r, &td, ds)))
            })
            .unwrap_or(false);
        if !keep {
            deleted += conn.execute("DELETE FROM todos WHERE id = ?1", [id])?;
        }
    }

    // 2) 物化窗口内缺失实例
    let mut inserted = 0usize;
    let templates = {
        let mut stmt = conn.prepare(
            "SELECT id, title, notes, start_min, duration_min, category, priority, subtasks, rec_rule, date \
             FROM todos WHERE rec_rule IS NOT NULL AND date IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RecTemplate {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    notes: r.get(2)?,
                    start_min: r.get(3)?,
                    duration_min: r.get(4)?,
                    category: r.get(5)?,
                    priority: r.get(6)?,
                    subtasks: r.get(7)?,
                    rec_rule: r.get(8)?,
                    date: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for t in templates {
        let (Some(raw), Some(tdate)) = (t.rec_rule, t.date) else {
            continue;
        };
        let Some(rule) = serde_json::from_str::<RecRule>(&raw).ok() else {
            continue;
        };
        let mut d = parse_date(&win_start);
        while let Some(day) = d {
            let ds = day.format("%Y-%m-%d").to_string();
            d = Some(day + Duration::days(1));
            if day > parse_date(&win_end).unwrap() {
                break;
            }
            if ds == tdate || !rule_matches(&rule, &tdate, &ds) {
                continue;
            }
            let key = format!("{}:{}", t.id, ds);
            let exists: bool = conn
                .query_row("SELECT 1 FROM todos WHERE rec_key = ?1", [&key], |_| Ok(true))
                .unwrap_or(false);
            if exists {
                continue;
            }
            conn.execute(
                "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, status, created_at, rec_key, subtasks) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'todo', ?8, ?9, ?10)",
                rusqlite::params![
                    t.title.as_str(),
                    t.notes.as_deref(),
                    ds,
                    t.start_min,
                    t.duration_min,
                    t.category.as_str(),
                    t.priority,
                    Utc::now().to_rfc3339(),
                    key,
                    reset_subtasks(&t.subtasks),
                ],
            )?;
            inserted += 1;
        }
    }
    let _ = deleted; // 清理数仅用于调试观察，不进返回值
    Ok(inserted)
}
