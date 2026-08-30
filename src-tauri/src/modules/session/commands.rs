//! 训练课会话命令 · 命令名与前端 `sessionService.ts` 对应。

use tauri::State;
use serde_json::Value;

use crate::error::Result;
use crate::state::AppState;
use crate::modules::exercise::workout_by_id;

use super::models::{FinishInput, SessionRecord, StrengthExerciseRef, StrengthLastWeight, StrengthSetRecord};

/// 一行原始数据（state_json 先取字符串，再解析）
type RawRow = (i64, String, String, String, String, String, i64, i64, f64, f64, String);

fn to_record(raw: RawRow) -> Result<SessionRecord> {
    let state = serde_json::from_str(&raw.10).unwrap_or(Value::Null);
    Ok(SessionRecord {
        id: raw.0,
        plan_id: raw.1,
        plan_name: raw.2,
        status: raw.3,
        started_at: raw.4,
        updated_at: raw.5,
        ex_index: raw.6,
        set_index: raw.7,
        weight_kg: raw.8,
        elapsed_sec: raw.9,
        state,
    })
}

fn read_by_id(conn: &rusqlite::Connection, id: i64) -> Result<SessionRecord> {
    let raw = conn.query_row(
        "SELECT id, plan_id, plan_name, status, started_at, updated_at, ex_index, \
         set_index, weight_kg, elapsed_sec, state_json FROM workout_sessions WHERE id = ?1",
        [id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    )?;
    to_record(raw)
}

/// 开始一场训练课。防御性规则：任何旧 active 会话先标记 aborted（前端正常流程不会出现并发生效会话）。
#[tauri::command]
pub fn session_start(
    state: State<AppState>,
    plan_id: String,
    plan_name: String,
    started_at: String,
    state_json: Value,
) -> Result<SessionRecord> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE workout_sessions SET status = 'aborted' WHERE status = 'active'",
        [],
    )?;
    conn.execute(
        "INSERT INTO workout_sessions (plan_id, plan_name, status, started_at, updated_at, \
         ex_index, set_index, weight_kg, state_json) \
         VALUES (?1, ?2, 'active', ?3, datetime('now'), 0, 1, 0, ?4)",
        rusqlite::params![plan_id, plan_name, started_at, state_json.to_string()],
    )?;
    read_by_id(&conn, conn.last_insert_rowid())
}

/// 事件级快照：每个训练事件（做组/休息/计时/重量调整…）调用一次。
/// `elapsed_sec` 在服务端按两次快照的间隔自动累加，前端无需管理。
#[tauri::command]
pub fn session_snapshot(
    state: State<AppState>,
    id: i64,
    ex_index: i64,
    set_index: i64,
    weight_kg: f64,
    state_json: Value,
) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE workout_sessions SET \
           ex_index = ?2, set_index = ?3, weight_kg = ?4, state_json = ?5, \
           elapsed_sec = elapsed_sec + MAX(0.0, (julianday('now') - julianday(updated_at)) * 86400.0), \
           updated_at = datetime('now') \
         WHERE id = ?1 AND status = 'active'",
        rusqlite::params![id, ex_index, set_index, weight_kg, state_json.to_string()],
    )?;
    Ok(())
}

/// 当前是否有进行中（含异常中断）的训练
#[tauri::command]
pub fn session_active(state: State<AppState>) -> Result<Option<SessionRecord>> {
    let conn = state.db.lock().unwrap();
    let res = conn.query_row(
        "SELECT id, plan_id, plan_name, status, started_at, updated_at, ex_index, \
         set_index, weight_kg, elapsed_sec, state_json \
         FROM workout_sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1",
        [],
        |r| -> rusqlite::Result<RawRow> {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    );
    match res {
        Ok(raw) => Ok(Some(to_record(raw)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 正常结束（保存）：同一事务内写入训练记录 + 逐组做组明细 + 关闭会话。
#[tauri::command]
pub fn session_finish(
    state: State<AppState>,
    input: FinishInput,
) -> Result<crate::modules::exercise::models::Workout> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO workouts (name, type, date, start_min, duration_min, kcal, intensity, note, session_id, created_at) \
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
        rusqlite::params![
            input.name,
            input.workout_type,
            input.date,
            input.duration_min,
            input.kcal,
            input.intensity.clone().unwrap_or_else(|| "moderate".into()),
            input.note,
            input.id
        ],
    )?;
    let workout_id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO workout_sets (workout_id, plan_id, exercise_key, exercise_name, set_no, kind, weight_kg, reps, sec, warmup, created_at) \
             VALUES (?1, (SELECT plan_id FROM workout_sessions WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))",
        )?;
        for s in &input.sets {
            stmt.execute(rusqlite::params![
                workout_id,
                input.id,
                s.exercise_key,
                s.exercise_name,
                s.set_no,
                s.kind,
                s.weight_kg,
                s.reps,
                s.sec,
                s.warmup,
            ])?;
        }
    }
    tx.execute(
        "UPDATE workout_sessions SET status = 'finished', updated_at = datetime('now') WHERE id = ?1",
        [input.id],
    )?;
    tx.commit()?;
    workout_by_id(&conn, workout_id)
}

/// 正常结束（放弃）：只关闭会话，不写训练记录。
#[tauri::command]
pub fn session_abort(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE workout_sessions SET status = 'aborted', updated_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// 按训练记录反查其来源会话（含最后一帧快照：轨迹 / 做组明细）。
/// 手动添加的记录没有来源会话，返回 None。
#[tauri::command]
pub fn session_for_workout(state: State<AppState>, workout_id: i64) -> Result<Option<SessionRecord>> {
    let conn = state.db.lock().unwrap();
    let res = conn.query_row(
        "SELECT s.id, s.plan_id, s.plan_name, s.status, s.started_at, s.updated_at, \
         s.ex_index, s.set_index, s.weight_kg, s.elapsed_sec, s.state_json \
         FROM workout_sessions s JOIN workouts w ON w.session_id = s.id WHERE w.id = ?1",
        [workout_id],
        |r| -> rusqlite::Result<RawRow> {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
            ))
        },
    );
    match res {
        Ok(raw) => Ok(Some(to_record(raw)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/* ---------- 重量曲线（逐组记录查询） ---------- */

/// 某动作的全部做组记录（按日期升序；含热身组，前端按需过滤/聚合）
#[tauri::command]
pub fn strength_history(
    state: State<AppState>,
    exercise_name: String,
) -> Result<Vec<StrengthSetRecord>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT s.workout_id, w.date, s.exercise_name, s.set_no, s.weight_kg, s.reps, s.sec, s.warmup \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         WHERE s.exercise_name = ?1 \
         ORDER BY w.date ASC, s.workout_id ASC, s.id ASC",
    )?;
    let list = stmt
        .query_map([&exercise_name], |r| {
            Ok(StrengthSetRecord {
                workout_id: r.get(0)?,
                date: r.get(1)?,
                exercise_name: r.get(2)?,
                set_no: r.get(3)?,
                weight_kg: r.get(4)?,
                reps: r.get(5)?,
                sec: r.get(6)?,
                warmup: r.get::<_, i64>(7)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 有力量记录的动作清单（按最近一次训练的日期倒序）
#[tauri::command]
pub fn strength_exercises(state: State<AppState>) -> Result<Vec<StrengthExerciseRef>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT s.exercise_name, MAX(w.date) AS last_date, COUNT(DISTINCT s.workout_id) AS sessions \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         WHERE s.warmup = 0 AND s.weight_kg IS NOT NULL \
         GROUP BY s.exercise_name \
         ORDER BY last_date DESC",
    )?;
    let list = stmt
        .query_map([], |r| {
            Ok(StrengthExerciseRef {
                name: r.get(0)?,
                last_date: r.get(1)?,
                sessions: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(list)
}

/// 一批动作各自的「最近一次做组重量」（取该动作最近一次训练里最后一组正式组）。
/// 沉浸页开始课程时批量预填「上次重量」；查不到的动作不出现在返回里。
#[tauri::command]
pub fn strength_last_weights(
    state: State<AppState>,
    names: Vec<String>,
) -> Result<Vec<StrengthLastWeight>> {
    let conn = state.db.lock().unwrap();
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT s.weight_kg, s.reps, w.date \
         FROM workout_sets s JOIN workouts w ON w.id = s.workout_id \
         WHERE s.exercise_name = ?1 AND s.warmup = 0 AND s.weight_kg IS NOT NULL \
         ORDER BY w.date DESC, s.workout_id DESC, s.id DESC LIMIT 1",
    )?;
    for name in &names {
        let res = stmt.query_row([name], |r| {
            Ok(StrengthLastWeight {
                name: name.clone(),
                weight_kg: r.get(0)?,
                reps: r.get(1)?,
                date: r.get(2)?,
            })
        });
        if let Ok(row) = res {
            out.push(row);
        }
    }
    Ok(out)
}
