//! 健康方案域命令 · 命令名与前端 `programService.ts` 对应。
//!
//! 方案的「计算」全部在前端引擎（`src/utils/programEngine.ts`）；本模块只做
//! 持久化、单激活约束与方案日程（todos.program_id）的事务化重排。跨域写 todos
//! 属于模块内聚的存储职责，与会话结束写 workouts 同理。

use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::models::{
    ProgramCreateInput, ProgramDayMeals, ProgramRecord, ProgramUpdateInput, ScheduleTodoInput,
    ShoppingCheck,
};

const COLS: &str =
    "id, goal, tier, status, version, weeks, params_json, adjustments_json, created_at, activated_at, updated_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProgramRecord> {
    Ok(ProgramRecord {
        id: row.get(0)?,
        goal: row.get(1)?,
        tier: row.get(2)?,
        status: row.get(3)?,
        version: row.get(4)?,
        weeks: row.get(5)?,
        params_json: row.get(6)?,
        adjustments_json: row.get(7)?,
        created_at: row.get(8)?,
        activated_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn program_by_id(conn: &rusqlite::Connection, id: i64) -> Result<ProgramRecord> {
    let sql = format!("SELECT {COLS} FROM programs WHERE id = ?1");
    Ok(conn.query_row(&sql, [id], from_row)?)
}

/// 方案历史（含归档），新的在前；供版本回溯与复盘参考。
#[tauri::command]
pub fn program_list(state: State<AppState>) -> Result<Vec<ProgramRecord>> {
    let conn = state.db.lock().unwrap();
    let sql = format!("SELECT {COLS} FROM programs ORDER BY id DESC LIMIT 20");
    let mut stmt = conn.prepare(&sql)?;
    let list = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 当前生效方案；没有时返回 None（页面据此进入引导流）。
#[tauri::command]
pub fn program_get_active(state: State<AppState>) -> Result<Option<ProgramRecord>> {
    let conn = state.db.lock().unwrap();
    let sql = format!("SELECT {COLS} FROM programs WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    let res = conn.query_row(&sql, [], from_row);
    match res {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 启用一套新方案：旧 active 自动归档，保证同一时刻至多一个生效方案。
/// 换方案时旧计划的「将来要做的事」同步回收：所有归档方案（含刚归档的旧 active）
/// 从今天起未完成的日程待办一并清除——提前归档/直接换方案都不再残留时间轴脏数据；
/// 已完成待办保留为执行历史。
#[tauri::command]
pub fn program_create(state: State<AppState>, input: ProgramCreateInput) -> Result<ProgramRecord> {
    if !(1..=26).contains(&input.weeks) {
        return Err(ReinError::Message("方案周期应为 1~26 周".into()));
    }
    if input.goal.is_empty() || input.tier.is_empty() || input.params_json.is_empty() {
        return Err(ReinError::Message("方案内容不完整".into()));
    }
    let conn = state.db.lock().unwrap();
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        conn.execute(
            "UPDATE programs SET status = 'archived', updated_at = datetime('now') WHERE status = 'active'",
            [],
        )?;
        conn.execute(
            "DELETE FROM todos WHERE program_id IN (SELECT id FROM programs WHERE status = 'archived') \
             AND date IS NOT NULL AND date >= date('now', 'localtime') AND status != 'done'",
            [],
        )?;
        conn.execute(
            "INSERT INTO programs (goal, tier, status, version, weeks, params_json, adjustments_json, created_at, activated_at, updated_at) \
             VALUES (?1, ?2, 'active', 1, ?3, ?4, '[]', datetime('now'), datetime('now'), datetime('now'))",
            rusqlite::params![input.goal, input.tier, input.weeks, input.params_json],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    program_by_id(&conn, conn.last_insert_rowid())
}

/// 应用一次调整（AI 建议经确认 / 手动改参）：整体替换内容快照并自增版本号；
/// 日程重排由前端随后调 program_schedule_replace 完成。
#[tauri::command]
pub fn program_update_params(
    state: State<AppState>,
    id: i64,
    input: ProgramUpdateInput,
) -> Result<ProgramRecord> {
    if input.params_json.is_empty() {
        return Err(ReinError::Message("方案内容不能为空".into()));
    }
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE programs SET params_json = ?2, adjustments_json = ?3, version = version + 1, \
         updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id, input.params_json, input.adjustments_json],
    )?;
    program_by_id(&conn, id)
}

/// 归档方案并回收日程：from_date（含）起未完成的方案日程一并清除。
/// 提前归档时，剩下的「将来要做的事」不该继续留在时间轴上；
/// 已完成待办保留为执行历史（与 program_delete 的语义一致，只是方案记录保留）。
/// 返回清除的待办条数。
#[tauri::command]
pub fn program_archive(state: State<AppState>, id: i64, from_date: String) -> Result<i64> {
    if from_date.is_empty() {
        return Err(ReinError::Message("from_date 不能为空".into()));
    }
    let conn = state.db.lock().unwrap();
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        conn.execute(
            "UPDATE programs SET status = 'archived', updated_at = datetime('now') WHERE id = ?1",
            [id],
        )?;
        let removed = conn.execute(
            "DELETE FROM todos WHERE program_id = ?1 AND date IS NOT NULL AND date >= ?2 AND status != 'done'",
            rusqlite::params![id, from_date],
        )? as i64;
        Ok(removed)
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("COMMIT")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// 删除方案：未完成的日程待办一并清除；已完成的是执行记录，保留但脱离关联。
/// 返回清除的待办条数。
#[tauri::command]
pub fn program_delete(state: State<AppState>, id: i64) -> Result<i64> {
    let conn = state.db.lock().unwrap();
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let removed = conn.execute(
            "DELETE FROM todos WHERE program_id = ?1 AND status != 'done'",
            [id],
        )? as i64;
        // 已完成待办保留为普通待办（execution history），只解除关联
        conn.execute("UPDATE todos SET program_id = NULL WHERE program_id = ?1", [id])?;
        conn.execute("DELETE FROM programs WHERE id = ?1", [id])?;
        Ok(removed)
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("COMMIT")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// 重排方案日程：删除该方案从 `from_date` 起（含）未来且未完成的待办，
/// 再整批写入新日程。首次启用与每次调整后都走这一条命令，保证幂等。
/// 返回写入条数。
#[tauri::command]
pub fn program_schedule_replace(
    state: State<AppState>,
    id: i64,
    from_date: String,
    todos: Vec<ScheduleTodoInput>,
) -> Result<i64> {
    if from_date.is_empty() {
        return Err(ReinError::Message("from_date 不能为空".into()));
    }
    let conn = state.db.lock().unwrap();
    program_by_id(&conn, id)?;
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        conn.execute(
            "DELETE FROM todos WHERE program_id = ?1 AND date IS NOT NULL AND date >= ?2 AND status != 'done'",
            rusqlite::params![id, from_date],
        )?;
        let mut stmt = conn.prepare(
            "INSERT INTO todos (title, notes, date, start_min, duration_min, category, priority, program_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
        )?;
        for t in &todos {
            if t.title.trim().is_empty() || t.date.is_none() {
                continue; // 缺日期的条目无法落在时间线上，跳过而非失败
            }
            stmt.execute(rusqlite::params![
                t.title.trim(),
                t.notes,
                t.date,
                t.start_min,
                t.duration_min,
                t.category.as_deref().unwrap_or("general"),
                t.priority.unwrap_or(0),
                id,
            ])?;
        }
        Ok(todos.len() as i64)
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("COMMIT")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/* ---------------- 每日菜单缓存（AI 按天生成，未生成的日期回落模板菜单） ---------------- */

/// 读取某天已生成的菜单；没有则返回 None
#[tauri::command]
pub fn program_meals_get(
    state: State<AppState>,
    program_id: i64,
    date: String,
) -> Result<Option<ProgramDayMeals>> {
    let conn = state.db.lock().unwrap();
    let res = conn.query_row(
        "SELECT program_id, date, meals_json, updated_at FROM program_meals \
         WHERE program_id = ?1 AND date = ?2",
        rusqlite::params![program_id, date],
        |r| {
            Ok(ProgramDayMeals {
                program_id: r.get(0)?,
                date: r.get(1)?,
                meals_json: r.get(2)?,
                updated_at: r.get(3)?,
            })
        },
    );
    match res {
        Ok(m) => Ok(Some(m)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 区间读取已生成的菜单缓存（闭区间 [start_date, end_date]，日期升序）——采购清单聚合用
#[tauri::command]
pub fn program_meals_range(
    state: State<AppState>,
    program_id: i64,
    start_date: String,
    end_date: String,
) -> Result<Vec<ProgramDayMeals>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT program_id, date, meals_json, updated_at FROM program_meals \
         WHERE program_id = ?1 AND date BETWEEN ?2 AND ?3 ORDER BY date",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![program_id, start_date, end_date],
            |r| {
                Ok(ProgramDayMeals {
                    program_id: r.get(0)?,
                    date: r.get(1)?,
                    meals_json: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// 写入/覆盖某天的菜单（AI 生成成功后落库）
#[tauri::command]
pub fn program_meals_set(
    state: State<AppState>,
    program_id: i64,
    date: String,
    meals_json: String,
) -> Result<ProgramDayMeals> {
    if date.is_empty() || meals_json.is_empty() {
        return Err(ReinError::Message("date 与 meals_json 不能为空".into()));
    }
    let conn = state.db.lock().unwrap();
    program_by_id(&conn, program_id)?;
    conn.execute(
        "INSERT INTO program_meals (program_id, date, meals_json, updated_at) \
         VALUES (?1, ?2, ?3, datetime('now')) \
         ON CONFLICT(program_id, date) DO UPDATE SET \
           meals_json = excluded.meals_json, updated_at = excluded.updated_at",
        rusqlite::params![program_id, date, meals_json],
    )?;
    Ok(conn.query_row(
        "SELECT program_id, date, meals_json, updated_at FROM program_meals \
         WHERE program_id = ?1 AND date = ?2",
        rusqlite::params![program_id, date],
        |r| {
            Ok(ProgramDayMeals {
                program_id: r.get(0)?,
                date: r.get(1)?,
                meals_json: r.get(2)?,
                updated_at: r.get(3)?,
            })
        },
    )?)
}

/// 清除 fromDate（含）起的缓存菜单：方案调整后未来菜单需按新参数重新生成。
/// 返回清除的天数。
#[tauri::command]
pub fn program_meals_clear(
    state: State<AppState>,
    program_id: i64,
    from_date: String,
) -> Result<i64> {
    let conn = state.db.lock().unwrap();
    let n = conn.execute(
        "DELETE FROM program_meals WHERE program_id = ?1 AND date >= ?2",
        rusqlite::params![program_id, from_date],
    )?;
    Ok(n as i64)
}

/* ---------------- 采购清单勾选状态（清单由前端实时聚合，此处仅存已购标记） ---------------- */

#[tauri::command]
pub fn shopping_checks_list(state: State<AppState>) -> Result<Vec<ShoppingCheck>> {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT item_key, checked_at FROM shopping_checks ORDER BY checked_at")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ShoppingCheck {
                item_key: r.get(0)?,
                checked_at: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// 勾选/取消一个采购项：checked=true 落 upsert，false 删除
#[tauri::command]
pub fn shopping_check_set(state: State<AppState>, item_key: String, checked: bool) -> Result<()> {
    let conn = state.db.lock().unwrap();
    if checked {
        conn.execute(
            "INSERT INTO shopping_checks (item_key, checked_at) VALUES (?1, datetime('now')) \
             ON CONFLICT(item_key) DO UPDATE SET checked_at = excluded.checked_at",
            [&item_key],
        )?;
    } else {
        conn.execute("DELETE FROM shopping_checks WHERE item_key = ?1", [&item_key])?;
    }
    Ok(())
}

/// 清空全部勾选（新一期采购前重置）；返回清除条数
#[tauri::command]
pub fn shopping_checks_clear(state: State<AppState>) -> Result<i64> {
    let conn = state.db.lock().unwrap();
    let n = conn.execute("DELETE FROM shopping_checks", [])?;
    Ok(n as i64)
}
