//! 待办域命令 · 命令名与前端 `todoService.ts` 对应。

use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use chrono::{Datelike, Duration, NaiveDate, Utc};

use super::models::{
    RecRule, Todo, TodoAttachment, TodoDayCount, TodoDistribution, TodoPage, TodoSubtask,
};

const COLS: &str = "id, title, notes, date, start_min, duration_min, category, priority, status, completed_at, created_at, program_id, rec_rule, rec_key, subtasks, attachments, course_session_id";

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 周一 = 0 … 周日 = 6（与前端 weekDates/WEEKDAY_LABELS 对齐）
fn dow_of(d: NaiveDate) -> i64 {
    d.weekday().num_days_from_monday() as i64
}

/// JSON 列序列化。用 `?` 而不是 `expect`：这些类型序列化失败的概率趋近于零，
/// 但真失败时也该是一条可解释的错误（`ReinError::Json`），而不是 panic 毒化全局 DB 锁。
fn json_str<T: serde::Serialize>(v: &Option<T>) -> Result<Option<String>> {
    match v.as_ref() {
        Some(x) => Ok(Some(serde_json::to_string(x)?)),
        None => Ok(None),
    }
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

fn reset_subtasks(raw: &Option<String>) -> Result<Option<String>> {
    let subs: Vec<TodoSubtask> =
        serde_json::from_str(raw.as_deref().unwrap_or("[]")).unwrap_or_default();
    if subs.is_empty() {
        return Ok(None);
    }
    let reset: Vec<TodoSubtask> = subs
        .into_iter()
        .map(|s| TodoSubtask {
            title: s.title,
            done: false,
        })
        .collect();
    Ok(Some(serde_json::to_string(&reset)?))
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
    let rec_rule: Option<RecRule> = row
        .get::<_, Option<String>>(12)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let rec_key: Option<String> = row.get(13)?;
    let subtasks: Option<Vec<TodoSubtask>> = row
        .get::<_, Option<String>>(14)?
        .and_then(|s| serde_json::from_str(&s).ok());
    let attachments: Option<Vec<TodoAttachment>> = row
        .get::<_, Option<String>>(15)?
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
        attachments,
        course_session_id: row.get(16)?,
    })
}

#[tauri::command]
pub fn list_todos(
    state: State<AppState>,
    start_date: String,
    end_date: String,
) -> Result<Vec<Todo>> {
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
/// AI 渐进式分页查询（对应工具 list_todos），避免全量倾倒：
/// scope="focus" 默认聚焦视图 = 逾期未完成 + [今天, 今天+7] + 收件箱（排最后）；
/// scope="range" 按 [start, end] 日期区间过滤（不含收件箱）。
/// 排序与 list_all_todos 一致：done 沉底 → 日期 → 时间 → 优先级。
pub fn query_todos(
    state: State<AppState>,
    today: String,
    scope: Option<String>,
    start: Option<String>,
    end: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<TodoPage> {
    let conn = state.db.lock().unwrap();
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let offset = offset.unwrap_or(0).max(0);

    // 两个分支的参数形状固定，分别构造 WHERE 与绑定值
    let (where_sql, vals): (String, Vec<String>) = if scope.as_deref() == Some("range") {
        let (Some(s), Some(e)) = (start, end) else {
            return Err(crate::error::ReinError::Message(
                "scope=range 需要 start/end（YYYY-MM-DD）".into(),
            ));
        };
        ("date BETWEEN ?1 AND ?2".to_string(), vec![s, e])
    } else {
        let Some(today_d) = parse_date(&today) else {
            return Err(crate::error::ReinError::Message(
                "日期格式应为 YYYY-MM-DD".into(),
            ));
        };
        let win_end = (today_d + Duration::days(7)).format("%Y-%m-%d").to_string();
        (
            "(date IS NULL OR (status != 'done' AND (date < ?1 OR date BETWEEN ?1 AND ?2)))"
                .to_string(),
            vec![today.clone(), win_end],
        )
    };
    let order =
        "(status = 'done'), (date IS NULL), date, (start_min IS NULL), start_min, priority DESC, id";
    let sql = format!(
        "SELECT {COLS} FROM todos WHERE {where_sql} ORDER BY {order} LIMIT {limit} OFFSET {offset}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(vals.iter()), from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM todos WHERE {where_sql}"),
        rusqlite::params_from_iter(vals.iter()),
        |r| r.get(0),
    )?;
    Ok(TodoPage {
        items,
        total,
        limit,
        offset,
    })
}

#[tauri::command]
/// 全部日程按日分布总览（对应工具 todo_distribution）：按日计数 + 收件箱/逾期摘要。
/// AI 先看分布再分页下钻，避免拉全量明细。
pub fn todo_distribution(state: State<AppState>, today: String) -> Result<TodoDistribution> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT date, COUNT(*) FROM todos WHERE date IS NOT NULL GROUP BY date ORDER BY date",
    )?;
    let days = stmt
        .query_map([], |r| {
            Ok(TodoDayCount {
                date: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let inbox: i64 = conn.query_row("SELECT COUNT(*) FROM todos WHERE date IS NULL", [], |r| {
        r.get(0)
    })?;
    let overdue: i64 = conn.query_row(
        "SELECT COUNT(*) FROM todos WHERE date IS NOT NULL AND status != 'done' AND date < ?1",
        [&today],
        |r| r.get(0),
    )?;
    Ok(TodoDistribution {
        days,
        inbox,
        overdue,
    })
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
    attachments: Option<Vec<TodoAttachment>>,
) -> Result<Todo> {
    let conn = state.db.lock().unwrap();
    let now = Utc::now().to_rfc3339();
    let category = category.unwrap_or_else(|| "general".into());
    conn.execute(
        "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, created_at, rec_rule, subtasks, attachments) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            title,
            notes,
            date,
            start_min,
            duration_min,
            category,
            priority.unwrap_or(0),
            now,
            json_str(&rec_rule)?,
            json_str(&subtasks)?,
            json_str(&attachments)?,
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
         category = ?6, priority = ?7, status = ?8, completed_at = ?9, rec_rule = ?10, rec_key = ?11, subtasks = ?12, attachments = ?13 \
         WHERE id = ?14",
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
            json_str(&todo.rec_rule)?,
            rec_key,
            json_str(&todo.subtasks)?,
            json_str(&todo.attachments)?,
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
    sync_recurrences_on(&conn, &today)
}

/// `sync_recurrences` 的本体：收 `&Connection` 而不是 `State`，测试才能在内存库上直接跑
/// （与 `ai::commands::usage_summary_on` 同一套路）。
fn sync_recurrences_on(conn: &rusqlite::Connection, today: &str) -> Result<usize> {
    let Some(today_d) = parse_date(today) else {
        return Err(crate::error::ReinError::Message(
            "日期格式应为 YYYY-MM-DD".into(),
        ));
    };
    let win_start = (today_d - Duration::days(1)).format("%Y-%m-%d").to_string();
    // 窗口末端直接用日期对象：省掉一次字符串解析，也不给 `parse_date(..).unwrap()` 留位置
    let win_end_d = today_d + Duration::days(7);

    // 1) 清理失效的未来未完成实例
    let stale: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, rec_key FROM todos \
             WHERE rec_key IS NOT NULL AND status != 'done' AND date IS NOT NULL AND date > ?1",
        )?;
        let rows = stmt
            .query_map([today], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut deleted = 0usize;
    for (id, key) in stale {
        let Some((tid_s, ds)) = key.rsplit_once(':') else {
            continue;
        };
        let Ok(tid) = tid_s.parse::<i64>() else {
            continue;
        };
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
            if day > win_end_d {
                break;
            }
            let ds = day.format("%Y-%m-%d").to_string();
            d = Some(day + Duration::days(1));
            if ds == tdate || !rule_matches(&rule, &tdate, &ds) {
                continue;
            }
            let key = format!("{}:{}", t.id, ds);
            let exists: bool = conn
                .query_row("SELECT 1 FROM todos WHERE rec_key = ?1", [&key], |_| {
                    Ok(true)
                })
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
                    reset_subtasks(&t.subtasks)?,
                ],
            )?;
            inserted += 1;
        }
    }
    let _ = deleted; // 清理数仅用于调试观察，不进返回值
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 内存库 + 完整迁移（不跑种子）：todos 的 JSON 列、rec_key 部分唯一索引都在。
    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn rule(freq: &str, weekdays: Vec<i64>, interval_days: i64, end_date: Option<&str>) -> RecRule {
        RecRule {
            freq: freq.into(),
            weekdays,
            interval_days,
            end_date: end_date.map(|s| s.into()),
        }
    }

    #[test]
    fn rule_matches_covers_freq_end_date_and_boundaries() {
        let daily = rule("daily", vec![], 1, None);
        assert!(
            !rule_matches(&daily, "2026-09-23", "2026-09-22"),
            "模板日期之前永不物化"
        );
        assert!(rule_matches(&daily, "2026-09-23", "2026-09-30"));

        // weekly：周一=0，2026-09-23 是周三
        let weekly = rule("weekly", vec![2], 1, None);
        assert!(rule_matches(&weekly, "2026-09-21", "2026-09-23"));
        assert!(!rule_matches(&weekly, "2026-09-21", "2026-09-24"));

        // interval：距模板日每 3 天
        let interval = rule("interval", vec![], 3, None);
        assert!(rule_matches(&interval, "2026-09-21", "2026-09-24"));
        assert!(!rule_matches(&interval, "2026-09-21", "2026-09-25"));

        // end_date 含当天，之后不再物化
        let ended = rule("daily", vec![], 1, Some("2026-09-22"));
        assert!(rule_matches(&ended, "2026-09-21", "2026-09-22"));
        assert!(!rule_matches(&ended, "2026-09-21", "2026-09-23"));
    }

    fn insert_template(conn: &Connection, rule_json: &str) -> i64 {
        conn.execute(
            "INSERT INTO todos (title, category, priority, status, created_at, date, rec_rule) \
             VALUES ('晨跑', 'general', 0, 'todo', '2026-09-21T00:00:00Z', '2026-09-21', ?1)",
            [rule_json],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// 现存的重复实例（日期, 是否完成），按日期升序。
    fn instances(conn: &Connection) -> Vec<(String, bool)> {
        let mut stmt = conn
            .prepare("SELECT date, status FROM todos WHERE rec_key IS NOT NULL ORDER BY date")
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)? == "done",
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    #[test]
    fn sync_materializes_window_is_idempotent_and_converges_after_rule_change() {
        let conn = fresh();
        let tid = insert_template(&conn, r#"{"freq":"daily","weekdays":[],"intervalDays":1}"#);

        // 窗口 = [今天-1, 今天+7] = 09-22 … 09-30（9 天）；模板日 09-21 不在窗口内
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 9);
        // 幂等：再跑一遍什么都不补
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);

        let mut stmt = conn
            .prepare("SELECT rec_key FROM todos WHERE rec_key IS NOT NULL")
            .unwrap();
        let keys = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(keys.len(), 9);
        assert!(
            keys.iter().all(|k| k.starts_with(&format!("{tid}:"))),
            "实例键必须是「模板id:日期」：{keys:?}"
        );

        // 把 09-25 标成完成，再把规则改成「每周三」——
        // 未来不再匹配的未完成实例应被删除，已完成的照旧留住（历史行永不追溯）
        conn.execute(
            "UPDATE todos SET status = 'done' WHERE rec_key = ?1",
            [format!("{tid}:2026-09-25")],
        )
        .unwrap();
        conn.execute(
            "UPDATE todos SET rec_rule = ?1 WHERE id = ?2",
            rusqlite::params![
                r#"{"freq":"weekly","weekdays":[2],"intervalDays":1}"#,
                tid
            ],
        )
        .unwrap();
        assert_eq!(sync_recurrences_on(&conn, "2026-09-23").unwrap(), 0);

        assert_eq!(
            instances(&conn),
            vec![
                ("2026-09-22".to_string(), false), // 昨天：不在清理范围
                ("2026-09-23".to_string(), false), // 周三
                ("2026-09-25".to_string(), true),  // 已完成：留着
                ("2026-09-30".to_string(), false), // 周三
            ]
        );
    }
}
