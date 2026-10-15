//! 域方法绑定：把协议层注册的方法（contract §4.4，28 条）接到各域已有的 `*_on` 函数。
//!
//! 三条纪律：
//! 1. 每个 handler 收 `&Connection` —— 由服务层用**同一把** `state.db.lock()` 提供，
//!    本模块绝不 `Connection::open`、也不自己取锁（contract §6.1 单连接铁律：钩子按连接注册）。
//! 2. 写操作走的就是那条带 `update_hook` 的唯一连接，所以写入会被同步自动捕获；
//!    本模块不需要（也**不允许**）再装第二个钩子。
//! 3. 这里只做「参数 → `*_on` → DTO」的映射，不做鉴权：scope 校验由服务层在调用
//!    [`dispatch`] 之前用 [`Method::scope`] 完成（contract §5.3「先 require 再取锁」）。
//!
//! **控制方法（`workout.session*` / `pomodoro.start|pause|stop`）**不在这里执行任何动作：
//! 计时/状态机真源在前端，服务层拿到 [`control_command`] 的 `(事件名, 载荷)` 后用 AppHandle
//! `emit` 给前端 store，再回 `{accepted:true}` 受理回执（contract §14.3）。

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ReinError, Result};
use crate::modules::gateway::protocol::{downlink, Method};
use crate::modules::gateway::runtime;
use crate::modules::program::models::ProgramRecord;
use crate::modules::session::models::{FinishInput, SessionRecord};
use crate::modules::todo::models::Todo;
use crate::modules::{campus, exercise, plan, pomodoro, program, session, todo};

// ---------------------------------------------------------------- 对外 DTO

// workout / plan / pomodoro / strength 的对外形状**直接复用**域模型（contract §4.4：字段干净）。
// `SessionRecord` 不复用（其 `state` 是前端状态机快照，对外无意义）。
//
// 这几个再导出是给后续层与测试**照抄的名字**（`WorkoutDto`/`PlanDto`/`PomodoroDto`/`Strength*`）；
// 此刻它们在本层内部没有调用点，而 `modules` 在 lib.rs 里是私有模块、rustc 的可见性分析
// 看不到「将来会被用」，于是报 unused —— 沿用到来的层接上即可删掉这些 allow。
#[allow(unused_imports)]
pub use crate::modules::exercise::models::Workout as WorkoutDto;
#[allow(unused_imports)]
pub use crate::modules::plan::models::PlanRecord as PlanDto;
#[allow(unused_imports)]
pub use crate::modules::pomodoro::models::PomodoroSession as PomodoroDto;
#[allow(unused_imports)]
pub use crate::modules::session::models::{
    StrengthExerciseRef, StrengthLastWeight, StrengthSetRecord,
};

/// 对外待办（contract §4.4）。**剥离** `attachments`（含 data URL，体积/内容泄漏）、
/// `rec_rule`/`rec_key`、`subtasks`、`course_session_id`、`created_at`；
/// 并派生 `source`（`category == "class"` → 课表派生的 `campus`，否则 `user`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDto {
    pub id: i64,
    pub title: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub start_min: Option<i64>,
    pub duration_min: Option<i64>,
    pub category: String,
    pub priority: i64,
    pub status: String,
    pub completed_at: Option<String>,
    /// `"campus"` | `"user"`（由 category 派生，见类型注释）。
    pub source: String,
}

impl TodoDto {
    pub fn from_todo(t: Todo) -> Self {
        let source = if t.category == "class" { "campus" } else { "user" };
        TodoDto {
            id: t.id,
            title: t.title,
            notes: t.notes,
            date: t.date,
            start_min: t.start_min,
            duration_min: t.duration_min,
            category: t.category,
            priority: t.priority,
            status: t.status,
            completed_at: t.completed_at,
            source: source.to_string(),
        }
    }
}

/// 进行中的训练课投影（`workout.sessionActive`，contract §14.2）。
///
/// 比 `SessionRecord` 多两件对外有用、而库里没有的东西：
/// - `elapsed_sec`：沿用 `workout_sessions.elapsed_sec`（服务端按快照间隔累加的真实流逝秒）；
/// - `rest_left_sec`：**服务端补时**后的休息剩余秒（库里那份 `state_json.restLeft` 是
///   「上次快照时刻」的值，外部不必复刻前端那套折算，见 `src/stores/session.ts:1166`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLive {
    pub id: i64,
    pub plan_id: String,
    pub plan_name: String,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
    pub ex_index: i64,
    pub set_index: i64,
    pub weight_kg: f64,
    pub elapsed_sec: f64,
    /// 仅当快照 `state.phase == "rest"` 时为 `Some`（已按 `updatedAt` 补时，且不小于 0）。
    pub rest_left_sec: Option<i64>,
    /// = `updatedAt`（这份投影的数据时刻，contract §14.2）。
    pub reported_at: String,
}

impl SessionLive {
    /// 从库里那一行投影出对外形状。时间折算用**服务端时钟**（不信前端自报）。
    fn from_record(rec: SessionRecord, now: DateTime<Utc>) -> Self {
        let rest_left_sec = project_rest_left(&rec, now);
        SessionLive {
            id: rec.id,
            plan_id: rec.plan_id,
            plan_name: rec.plan_name,
            status: rec.status,
            started_at: rec.started_at,
            updated_at: rec.updated_at.clone(),
            ex_index: rec.ex_index,
            set_index: rec.set_index,
            weight_kg: rec.weight_kg,
            elapsed_sec: rec.elapsed_sec,
            rest_left_sec,
            reported_at: rec.updated_at,
        }
    }
}

/// 休息剩余秒的服务端补时（contract §14.2）：`state.phase == "rest"` 时
/// `max(0, round(state.restLeft - (now - updatedAt)))`；其余相位 / 坏时间戳返回 `None`。
/// `state.restLeft` 是「上次事件时刻」的值，所以必须加上这段时间才是当前剩余。
fn project_rest_left(rec: &SessionRecord, now: DateTime<Utc>) -> Option<i64> {
    if rec.state.get("phase").and_then(Value::as_str) != Some("rest") {
        return None;
    }
    let base = rec.state.get("restLeft").and_then(Value::as_f64).unwrap_or(0.0);
    let elapsed = parse_server_timestamp(&rec.updated_at)
        .map(|t| now.signed_duration_since(t).num_milliseconds() as f64 / 1000.0)
        .unwrap_or(0.0)
        .max(0.0);
    Some((base - elapsed).max(0.0).round() as i64)
}

/// 解析服务端写的时间戳：`workout_sessions.updated_at` 是 SQLite `datetime('now')` 的
/// `YYYY-MM-DD HH:MM:SS`（UTC，无时区标记）；也兼容 RFC3339。解不出来返回 `None`
/// （该行按「无流逝」处理，宁可少补也不多补）。
fn parse_server_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.with_timezone(&Utc));
    }
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|n| n.and_utc())
}


// ---------------------------------------------------------------- 参数形状（camelCase）

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleListParams {
    pub start_date: String,
    pub end_date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCreateParams {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub start_min: Option<i64>,
    #[serde(default)]
    pub duration_min: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
}

/// `schedule.update` 的提交体（contract §4.4 的 `TodoInput`）。
/// **不含** `attachments`/`subtasks`/`recRule`/`courseSessionId`/`createdAt` —— 那些列从原行保留。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoInput {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub start_min: Option<i64>,
    #[serde(default)]
    pub duration_min: Option<i64>,
    pub category: String,
    pub priority: i64,
    pub status: String,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpdateParams {
    pub todo: TodoInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIdParams {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutListParams {
    pub start_date: String,
    pub end_date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutCreateParams {
    pub name: String,
    pub workout_type: String,
    pub date: String,
    #[serde(default)]
    pub start_min: Option<i64>,
    pub duration_min: f64,
    #[serde(default)]
    pub intensity: Option<String>,
    #[serde(default)]
    pub effort: Option<i64>,
    pub kcal: f64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseIdParams {
    pub exercise_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseIdsParams {
    pub exercise_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSetsParams {
    #[serde(default)]
    pub days: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroListParams {
    pub start_date: String,
    pub end_date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroSaveParams {
    pub session: pomodoro::models::PomodoroSessionInput,
}

/// `schedule.campus` 的参数（都是可选，缺省 = 当前学期 + 物化窗口）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCampusParams {
    #[serde(default)]
    pub semester_id: Option<i64>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// `workout.sessionStart` 的参数（contract §14.3 下行 `start`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartParams {
    pub plan_id: String,
    pub plan_name: String,
    pub started_at: String,
    #[serde(default)]
    pub state: Option<Value>,
}

/// `workout.sessionSnapshot` 的参数（contract §14.3 下行 `snapshot`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshotParams {
    pub id: i64,
    pub ex_index: i64,
    pub set_index: i64,
    pub weight_kg: f64,
    pub state: Value,
}

/// `workout.sessionFinish` 的提交体（内层是 `FinishInput`，对齐 `session/models.rs:29`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFinishParams {
    pub session_finish: FinishInput,
}

/// `pomodoro.start` 的参数（都可省；`todoId` 允许显式 `null`）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroStartParams {
    #[serde(default)]
    pub focus_min: Option<i64>,
    #[serde(default)]
    pub break_min: Option<i64>,
    #[serde(default)]
    pub todo_id: Option<i64>,
}

// ---------------------------------------------------------------- 分派

/// 列表类方法的每页行数上限（contract §6.4：列表默认 100、上限 500）。
///
/// 对外列表查询在 **SQL 侧**就带 `LIMIT`（各域 `*_on_limited` 变体），这里再对结果做一次
/// Rust 侧硬上限兜底（防止将来新增方法忘了加 SQL LIMIT）。
const MAX_LIST_ROWS: usize = 500;

/// 截断列表结果到 [`MAX_LIST_ROWS`]（SQL 侧 LIMIT 之外的第二道兜底）。
fn cap_rows<T>(mut v: Vec<T>) -> Vec<T> {
    v.truncate(MAX_LIST_ROWS);
    v
}

/// 写操作字符串字段的长度上限：单帧可到 256KiB，不设限的话巨串会入库并被同步钩子放大。
const MAX_TITLE: usize = 500;
const MAX_TEXT: usize = 10_000;
/// 时间戳串上限（RFC3339 含时区/偏移，正常 ≤ 35 字符；留余量）。
const MAX_TIME: usize = 64;
/// 运行态快照 `state`（任意 JSON）序列化后的字符上限：`workout_sessions.state_json`
/// 与下行 `sessionSnapshot` 都会被这一路写，不设限则接近整帧上限（contract §17.5）。
const MAX_STATE_JSON: usize = 16_384;

/// 校验一个字符串字段的长度（超限回 `bad_request`，contract §4.6）。
fn check_len(field: &str, value: &str, max: usize) -> Result<()> {
    if value.chars().count() > max {
        return Err(ReinError::coded(
            "bad_request",
            format!("{field} 过长（上限 {max} 字符）"),
        ));
    }
    Ok(())
}

/// 校验一个任意 JSON 值序列化后的大小（`state` 这类自由对象用）。
fn check_json_len(field: &str, value: &Value, max: usize) -> Result<()> {
    if value.to_string().chars().count() > max {
        return Err(ReinError::coded(
            "bad_request",
            format!("{field} 过大（上限 {max} 字符）"),
        ));
    }
    Ok(())
}

/// 一次派发产生的**锁外附加动作**。必须由服务层在 `state.db.lock()` 释放**之后**执行
/// （contract §6.3「授权弹窗与所有网络往返必须落在锁外」/ §13.3 / §14.3）。
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// 下行控制：服务层用 AppHandle `app.emit(event, data)` 交前端 store 执行（§14.3）。
    Emit { event: &'static str, data: Value },
    /// 本地运动记录删除后需向 Health Connect 传播删除（本地 `source='local'` + 已导出 +
    /// 回写开关开）。服务层用 AppHandle 调 `healthsync::propagate_delete`（§13.3）。
    PropagateDelete { external_id: String },
}

/// 把一条**已通过 scope 校验**的方法调用派发到对应域函数（丢弃 [`Effect`]）。
///
/// 保留这个签名是给「不需要处理锁外动作」的调用方用；服务层应改用
/// [`dispatch_with_effects`] 并**在锁外**执行返回的动作。
/// 目前只有单测用它（服务层已全部改走 `dispatch_with_effects`），故挂 `#[cfg(test)]`。
#[cfg(test)]
pub fn dispatch(conn: &Connection, method: Method, params: &Value) -> Result<Value> {
    dispatch_with_effects(conn, method, params).map(|(value, _effects)| value)
}

/// 派发一次调用，并回传需要在**锁外**执行的附加动作（下行 emit / HC 传播删除）。
///
/// 错误一律以 [`ReinError`] 返回，其 `code()` 即协议错误码
/// （`bad_request`/`not_found`/`internal`…，contract §4.6），由服务层翻译成错误帧。
pub fn dispatch_with_effects(
    conn: &Connection,
    method: Method,
    params: &Value,
) -> Result<(Value, Vec<Effect>)> {
    let mut effects: Vec<Effect> = Vec::new();
    let value = dispatch_inner(conn, method, params, &mut effects)?;
    Ok((value, effects))
}

/// [`dispatch_with_effects`] 的本体：`effects` 收集锁外动作，返回值即对外结果。
fn dispatch_inner(
    conn: &Connection,
    method: Method,
    params: &Value,
    effects: &mut Vec<Effect>,
) -> Result<Value> {
    match method {
        Method::ScheduleList => {
            let p: ScheduleListParams = parse(params)?;
            let list = todo::commands::list_todos_on_limited(
                conn,
                &p.start_date,
                &p.end_date,
                MAX_LIST_ROWS as i64,
            )?;
            to_value(cap_rows(list.into_iter().map(TodoDto::from_todo).collect::<Vec<_>>()))
        }
        Method::ScheduleListAll => {
            let list = todo::commands::list_all_todos_on_limited(conn, MAX_LIST_ROWS as i64)?;
            to_value(cap_rows(list.into_iter().map(TodoDto::from_todo).collect::<Vec<_>>()))
        }
        Method::ScheduleCreate => {
            let p: ScheduleCreateParams = parse(params)?;
            // 契约 §4.4：其余参数取默认 —— 外部不提供 rec_rule/subtasks/attachments。
            check_len("title", &p.title, MAX_TITLE)?;
            if let Some(n) = &p.notes {
                check_len("notes", n, MAX_TEXT)?;
            }
            let created = todo::commands::create_todo_on(
                conn,
                p.title,
                p.notes,
                p.date,
                p.start_min,
                p.duration_min,
                p.category,
                p.priority,
                None,
                None,
                None,
            )?;
            to_value(TodoDto::from_todo(created))
        }
        Method::ScheduleUpdate => {
            let p: ScheduleUpdateParams = parse(params)?;
            schedule_update(conn, p.todo)
        }
        Method::ScheduleDelete => {
            let p: IdParams = parse(params)?;
            todo::commands::delete_todo_on(conn, p.id)?;
            Ok(json!({}))
        }
        Method::ScheduleCampus => {
            let p: ScheduleCampusParams = parse(params)?;
            // 读课表：走**只读**变体 —— `schedule.read` 只授了读，而 `campus_schedule_on`
            // 会先 `DELETE` 该账号全部未完成派生待办再重建（contract §13.2 认账的本地写）。
            // 网关这条路径绝不能带着写副作用（`session::commands` 那批 `_on` 同理）。
            let view =
                campus::commands::campus_schedule_readonly_on(conn, p.semester_id, p.from, p.to)?;
            to_value(view)
        }
        Method::SchedulePrograms => {
            // `program_list` 本体自身已 `LIMIT 20`，这里再过一次 Rust 侧兜底。
            to_value(cap_rows(program::commands::program_list_on(conn)?))
        }
        Method::ScheduleProgramActive => {
            let active: Option<ProgramRecord> = program::commands::program_get_active_on(conn)?;
            to_value(active)
        }
        Method::WorkoutPlans => to_value(cap_rows(plan::commands::list_workout_plans_on_limited(
            conn,
            MAX_LIST_ROWS as i64,
        )?)),
        Method::WorkoutPlan => {
            let p: PlanIdParams = parse(params)?;
            match plan::commands::get_workout_plan_on(conn, &p.id) {
                Ok(plan) => to_value(plan),
                // 目标 id 不存在 → 协议 `not_found`（不是笼统的 db 错误）
                Err(ReinError::Db(rusqlite::Error::QueryReturnedNoRows)) => {
                    Err(ReinError::coded("not_found", format!("课程不存在：{}", p.id)))
                }
                Err(e) => Err(e),
            }
        }
        Method::WorkoutList => {
            let p: WorkoutListParams = parse(params)?;
            to_value(cap_rows(exercise::commands::list_workouts_on_limited(
                conn,
                &p.start_date,
                &p.end_date,
                MAX_LIST_ROWS as i64,
            )?))
        }
        Method::WorkoutCreate => {
            let p: WorkoutCreateParams = parse(params)?;
            check_len("name", &p.name, MAX_TITLE)?;
            if let Some(n) = &p.note {
                check_len("note", n, MAX_TEXT)?;
            }
            let created = exercise::commands::create_workout_on(
                conn,
                p.name,
                p.workout_type,
                p.date,
                p.start_min,
                p.duration_min,
                p.intensity,
                p.effort,
                p.kcal,
                p.note,
            )?;
            to_value(created)
        }
        Method::WorkoutSessionActive => {
            // 活跃会话投影（contract §14.2）：`restLeftSec` 由服务端补时，不信前端自报。
            let live = session::commands::session_active_on(conn)?
                .map(|rec| SessionLive::from_record(rec, Utc::now()));
            to_value(live)
        }
        Method::WorkoutDelete => {
            let p: IdParams = parse(params)?;
            // 与 UI `delete_workout` 同一条路径：删行 + 按 source 决定 HC 墓碑/传播。
            // 需要在锁外传播删除的 external_id 走 Effect，由服务层拿 AppHandle 执行（§13.3）。
            if let Some(external_id) = exercise::commands::delete_workout_on(conn, p.id)? {
                effects.push(Effect::PropagateDelete { external_id });
            }
            Ok(json!({}))
        }
        Method::WorkoutSessionStart
        | Method::WorkoutSessionSnapshot
        | Method::WorkoutSessionFinish
        | Method::WorkoutSessionAbort
        | Method::PomodoroStart
        | Method::PomodoroPause
        | Method::PomodoroStop => {
            // 下行控制：先按契约把参数校验 / 编成下行命令，再回受理回执。
            // 真正的 `app.emit(event, data)` 由服务层在**锁外**用 AppHandle 执行
            // （顺序：dispatch_with_effects → 松锁 → emit → 回 {accepted:true}，contract §14.3）。
            let (event, data) = control_command(method, params)?
                .ok_or_else(|| ReinError::coded("internal", "控制方法未产出下行命令"))?;
            effects.push(Effect::Emit { event, data });
            Ok(json!({ "accepted": true }))
        }
        Method::WorkoutStrengthHistory => {
            let p: ExerciseIdParams = parse(params)?;
            // SQL 侧 LIMIT（`_on_limited`）+ 这里的 `cap_rows` 兜底，两道都留着（contract §6.4）。
            to_value(cap_rows(session::commands::strength_history_on_limited(
                conn,
                &p.exercise_id,
                MAX_LIST_ROWS as i64,
            )?))
        }
        Method::WorkoutStrengthExercises => to_value(cap_rows(
            session::commands::strength_exercises_on_limited(conn, MAX_LIST_ROWS as i64)?,
        )),
        Method::WorkoutLastWeights => {
            let p: ExerciseIdsParams = parse(params)?;
            to_value(cap_rows(session::commands::strength_last_weights_on(conn, &p.exercise_ids)?))
        }
        Method::WorkoutRecentSets => {
            let p: RecentSetsParams = parse(params)?;
            to_value(cap_rows(session::commands::strength_recent_sets_on_limited(
                conn,
                p.days,
                MAX_LIST_ROWS as i64,
            )?))
        }
        Method::PomodoroList => {
            let p: PomodoroListParams = parse(params)?;
            to_value(cap_rows(pomodoro::commands::list_pomodoro_sessions_on_limited(
                conn,
                &p.start_date,
                &p.end_date,
                MAX_LIST_ROWS as i64,
            )?))
        }
        Method::PomodoroSave => {
            let p: PomodoroSaveParams = parse(params)?;
            // 时间戳串上限（§17.5）：这两列进同步白名单，超长串会被放大到其它设备。
            check_len("startedAt", &p.session.started_at, MAX_TIME)?;
            check_len("endedAt", &p.session.ended_at, MAX_TIME)?;
            to_value(pomodoro::commands::save_pomodoro_session_on(conn, &p.session)?)
        }
        Method::PomodoroStatus => {
            // 运行态读取（contract §14.1）：快照由前端 1s 一次 `focus_publish` 写进 `app_meta`。
            // `focus_state_on` 内部用 `fresh_runtime_snapshot`：陈旧（now - 写入时刻 > 5s）即 `null`
            // —— 判定在后端，不信前端自报的 `reportedAt`。返回原样 `FocusRuntime` JSON。
            match runtime::focus_state_on(conn)? {
                None => Ok(Value::Null),
                Some(snap) => Ok(snap),
            }
        }
    }
}

// ---------------------------------------------------------------- 下行控制（§14.3）

/// 把一条**控制方法**编成前端要执行的下行命令：`(Tauri 事件名, 载荷)`。
///
/// 契约 §14.3：外部控制**不直写**状态机表（直写会被前端内存旧值在下次 `touch()` 静默覆盖），
/// 而是 `外部方法 → 校验 scope → app.emit(event, {action,args}) → 前端 store 执行`。
/// 本函数只产出该 emit 的 `(事件名, 载荷)`；服务层在**锁外**用 AppHandle emit，再回受理回执。
/// **非控制方法返回 `Ok(None)`**。
///
/// 顺带承担控制方法的参数校验（`bad_request`）与长度上限（contract §17.5）。
pub fn control_command(method: Method, params: &Value) -> Result<Option<(&'static str, Value)>> {
    let cmd = match method {
        Method::PomodoroStart => {
            let p: PomodoroStartParams = parse(params)?;
            (
                downlink::POMODORO_COMMAND,
                json!({
                    "action": "start",
                    "args": optional_args([
                        ("focusMin", p.focus_min.map(Value::from)),
                        ("breakMin", p.break_min.map(Value::from)),
                        ("todoId", p.todo_id.map(Value::from)),
                    ]),
                }),
            )
        }
        Method::PomodoroPause => (
            downlink::POMODORO_COMMAND,
            json!({ "action": "pause", "args": {} }),
        ),
        Method::PomodoroStop => (
            downlink::POMODORO_COMMAND,
            json!({ "action": "stop", "args": {} }),
        ),
        Method::WorkoutSessionStart => {
            let p: SessionStartParams = parse(params)?;
            // 写字段长度校验覆盖所有第二轮写入方法（contract §17.5）。
            check_len("planName", &p.plan_name, MAX_TITLE)?;
            check_len("startedAt", &p.started_at, MAX_TIME)?;
            if let Some(state) = &p.state {
                check_json_len("state", state, MAX_STATE_JSON)?;
            }
            (
                downlink::SESSION_COMMAND,
                json!({
                    "action": "start",
                    "args": optional_args([
                        ("planId", Some(Value::from(p.plan_id))),
                        ("planName", Some(Value::from(p.plan_name))),
                        ("startedAt", Some(Value::from(p.started_at))),
                        ("state", p.state),
                    ]),
                }),
            )
        }
        Method::WorkoutSessionSnapshot => {
            let p: SessionSnapshotParams = parse(params)?;
            check_json_len("state", &p.state, MAX_STATE_JSON)?;
            (
                downlink::SESSION_COMMAND,
                json!({
                    "action": "snapshot",
                    "args": {
                        "id": p.id, "exIndex": p.ex_index, "setIndex": p.set_index,
                        "weightKg": p.weight_kg, "state": p.state,
                    },
                }),
            )
        }
        Method::WorkoutSessionFinish => {
            let p: SessionFinishParams = parse(params)?;
            check_len("name", &p.session_finish.name, MAX_TITLE)?;
            if let Some(n) = &p.session_finish.note {
                check_len("note", n, MAX_TEXT)?;
            }
            // 载荷原样透传参数里的 `sessionFinish`（保留前端可能带的额外字段），
            // 类型与长度由上面的解析 + check_len 把关。
            let raw = params.get("sessionFinish").cloned().unwrap_or(Value::Null);
            (
                downlink::SESSION_COMMAND,
                json!({ "action": "finish", "args": { "sessionFinish": raw } }),
            )
        }
        Method::WorkoutSessionAbort => {
            let p: IdParams = parse(params)?;
            (
                downlink::SESSION_COMMAND,
                json!({ "action": "abort", "args": { "id": p.id } }),
            )
        }
        _ => return Ok(None),
    };
    Ok(Some(cmd))
}

/// 组装 args 对象：`None` 的键**不出现**（与契约里 `field?` 的「可选」语义一致），
/// 而不是留一个 `null`。
fn optional_args<const N: usize>(entries: [(&'static str, Option<Value>); N]) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        if let Some(v) = value {
            map.insert(key.to_string(), v);
        }
    }
    Value::Object(map)
}

/// `schedule.update` 的 handler：读原行 → 拒绝带附件 → 保留非暴露列 → 全量更新。
fn schedule_update(conn: &Connection, input: TodoInput) -> Result<Value> {
    check_len("title", &input.title, MAX_TITLE)?;
    if let Some(n) = &input.notes {
        check_len("notes", n, MAX_TEXT)?;
    }
    let existing = todo::commands::get_todo_on(conn, input.id)?.ok_or_else(|| {
        ReinError::coded("not_found", format!("待办不存在：{}", input.id))
    })?;
    // `update_todo` 是全量覆盖（`attachments = ?13`）。外部 DTO 不带 attachments，
    // 直接覆盖会把附件清空。contract §10 的 v1 决定：**拒绝**更新带附件的待办。
    if existing.attachments.as_ref().is_some_and(|a| !a.is_empty()) {
        return Err(ReinError::coded(
            "bad_request",
            "该待办含附件，外部接口暂不支持更新（请先在 Rein 内移除附件）",
        ));
    }
    // 非暴露列（rec_rule/rec_key/subtasks/attachments/program_id/course_session_id/created_at）
    // 从原行保留 —— 外部 `TodoInput` 里压根没有这些字段，不保留就会被一次外部编辑抹掉。
    let todo = Todo {
        id: input.id,
        title: input.title,
        notes: input.notes,
        date: input.date,
        start_min: input.start_min,
        duration_min: input.duration_min,
        category: input.category,
        priority: input.priority,
        status: input.status,
        completed_at: input.completed_at,
        created_at: existing.created_at,
        program_id: existing.program_id,
        rec_rule: existing.rec_rule,
        rec_key: existing.rec_key,
        subtasks: existing.subtasks,
        attachments: existing.attachments,
        course_session_id: existing.course_session_id,
    };
    let updated = todo::commands::update_todo_on(conn, &todo)?;
    to_value(TodoDto::from_todo(updated))
}

/// 参数反序列化：字段缺失 / 类型错统一回 `bad_request`（contract §4.6）。
/// `params` 是 `null`（客户端没带 `params`）时按空对象处理，好让「全无参数」的方法也能调。
fn parse<T: DeserializeOwned>(params: &Value) -> Result<T> {
    let v = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params.clone()
    };
    serde_json::from_value(v)
        .map_err(|e| ReinError::coded("bad_request", format!("参数格式错误：{e}")))
}

/// 输出序列化（`ReinError::Json` → `code() == "internal"`）。
fn to_value<T: Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;
    use crate::modules::gateway::store;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    fn call(conn: &Connection, name: &str, params: Value) -> Result<Value> {
        let m = Method::from_name(name).expect("方法必须已注册");
        dispatch(conn, m, &params)
    }

    #[test]
    fn schedule_create_list_delete_roundtrip_strips_internal_columns() {
        let conn = db();
        let created = call(
            &conn,
            "schedule.create",
            json!({ "title": "买菜", "date": "2026-09-23", "startMin": 600, "durationMin": 30 }),
        )
        .unwrap();
        // DTO 剥离了 attachments/subtasks/recRule/recKey/courseSessionId/createdAt
        assert_eq!(created["title"], "买菜");
        assert_eq!(created["source"], "user");
        assert!(created.get("attachments").is_none());
        assert!(created.get("recRule").is_none());
        assert!(created.get("createdAt").is_none());
        let id = created["id"].as_i64().unwrap();

        let listed = call(
            &conn,
            "schedule.list",
            json!({ "startDate": "2026-09-01", "endDate": "2026-09-30" }),
        )
        .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], id);

        let empty = call(&conn, "schedule.delete", json!({ "id": id })).unwrap();
        assert_eq!(empty, json!({}));
        let after = call(&conn, "schedule.listAll", json!({})).unwrap();
        assert!(after.as_array().unwrap().is_empty());
    }

    #[test]
    fn update_preserves_hidden_columns_and_rejects_attachments() {
        let conn = db();
        // 直接插一行带附件的待办（模拟前端创建时带附件）
        conn.execute(
            "INSERT INTO todos (id, title, category, priority, status, created_at, attachments) \
             VALUES (1, '带附件', 'general', 0, 'todo', 'now', '[{\"kind\":\"text\",\"name\":\"n\",\"createdAt\":\"now\"}]')",
            [],
        )
        .unwrap();
        let rejected = call(
            &conn,
            "schedule.update",
            json!({ "todo": { "id": 1, "title": "改标题", "category": "general", "priority": 0, "status": "todo" } }),
        )
        .unwrap_err();
        assert_eq!(rejected.code(), "bad_request");
        // 原行没被动过
        let title: String = conn
            .query_row("SELECT title FROM todos WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "带附件");

        // 无附件行：更新成功且 source 派生正确
        conn.execute(
            "INSERT INTO todos (id, title, category, priority, status, created_at) \
             VALUES (2, '课', 'class', 3, 'todo', 'now')",
            [],
        )
        .unwrap();
        let updated = call(
            &conn,
            "schedule.update",
            json!({ "todo": { "id": 2, "title": "课改", "category": "class", "priority": 3, "status": "done" } }),
        )
        .unwrap();
        assert_eq!(updated["source"], "campus");
        assert_eq!(updated["status"], "done");
    }

    #[test]
    fn schedule_update_missing_id_is_not_found() {
        let conn = db();
        let err = call(
            &conn,
            "schedule.update",
            json!({ "todo": { "id": 999, "title": "x", "category": "general", "priority": 0, "status": "todo" } }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn workout_and_pomodoro_reads_return_arrays() {
        let conn = db();
        assert!(call(&conn, "workout.plans", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(
            call(&conn, "workout.list", json!({ "startDate": "2026-01-01", "endDate": "2026-12-31" }))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(call(&conn, "workout.strengthExercises", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        // recentSets 的 days 可省（默认 42）
        assert!(call(&conn, "workout.recentSets", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(
            call(&conn, "pomodoro.list", json!({ "startDate": "2026-01-01", "endDate": "2026-12-31" }))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn pomodoro_save_writes_and_reads_back() {
        let conn = db();
        let saved = call(
            &conn,
            "pomodoro.save",
            json!({ "session": {
                "startedAt": "2026-09-23T09:00:00Z", "endedAt": "2026-09-23T09:25:00Z",
                "focusMin": 25.0, "breakMin": 5.0, "completed": true
            }}),
        )
        .unwrap();
        assert_eq!(saved["focusMin"], 25.0);
        assert_eq!(saved["completed"], true);
        let list = call(
            &conn,
            "pomodoro.list",
            json!({ "startDate": "2026-09-01", "endDate": "2026-09-30" }),
        )
        .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[test]
    fn bad_params_become_bad_request() {
        let conn = db();
        // 缺必填的 title
        let err = call(&conn, "schedule.create", json!({ "date": "2026-01-01" })).unwrap_err();
        assert_eq!(err.code(), "bad_request");
        // 完全不带 params 也能调「无参」方法（params = null → 空对象）
        let m = Method::WorkoutPlans;
        assert!(dispatch(&conn, m, &Value::Null).is_ok());
    }

    #[test]
    fn workout_plan_missing_id_is_not_found() {
        let conn = db();
        let err = call(&conn, "workout.plan", json!({ "id": "nope" })).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    // ------------------------------------------------ 第二轮新增方法（§13/§14）

    /// `schedule.campus`：无账号 → 空视图（不报错）。物化副作用在无账号时自然不发生。
    #[test]
    fn schedule_campus_returns_empty_view_without_account() {
        let conn = db();
        let view = call(&conn, "schedule.campus", json!({})).unwrap();
        assert!(view["account"].is_null());
        assert!(view["entries"].as_array().unwrap().is_empty());
        // 参数可省（semesterId / from / to 全缺省）
        let explicit = call(
            &conn,
            "schedule.campus",
            json!({ "semesterId": null, "from": "2026-01-01", "to": "2026-01-31" }),
        )
        .unwrap();
        assert!(explicit["semester"].is_null());
    }

    /// `schedule.programs` / `schedule.programActive`：空库 → `[]` / `null`。
    #[test]
    fn schedule_program_reads_are_empty_on_fresh_db() {
        let conn = db();
        let list = call(&conn, "schedule.programs", json!({})).unwrap();
        assert!(list.as_array().unwrap().is_empty());
        let active = call(&conn, "schedule.programActive", json!({})).unwrap();
        assert!(active.is_null());
    }

    /// `workout.sessionActive`：活跃会话投影，`restLeftSec` 由服务端补时（§14.2）。
    #[test]
    fn workout_session_active_projects_and_compensates_rest() {
        let conn = db();
        // 无活跃会话 → null
        assert!(call(&conn, "workout.sessionActive", json!({})).unwrap().is_null());

        // 插一条 10 秒前快照、处于休息相位的活跃会话：restLeft=42，补时后 ≈ 32
        conn.execute(
            "INSERT INTO workout_sessions (id, plan_id, plan_name, status, started_at, updated_at, \
             ex_index, set_index, weight_kg, elapsed_sec, state_json) \
             VALUES (1, 'p1', '胸推日', 'active', '2026-01-01T09:00:00Z', datetime('now', '-10 seconds'), \
             1, 2, 40.0, 1830.0, '{\"phase\":\"rest\",\"restLeft\":42}')",
            [],
        )
        .unwrap();
        let live = call(&conn, "workout.sessionActive", json!({})).unwrap();
        assert_eq!(live["id"], 1);
        assert_eq!(live["planName"], "胸推日");
        assert_eq!(live["elapsedSec"], 1830.0);
        assert_eq!(live["reportedAt"], live["updatedAt"]);
        let rest = live["restLeftSec"].as_i64().expect("休息相位应有补时后的剩余秒");
        assert!((30..=33).contains(&rest), "42 秒减去约 10 秒流逝，实得 {rest}");

        // 非休息相位 → restLeftSec 为 null
        conn.execute(
            "UPDATE workout_sessions SET state_json = '{\"phase\":\"exercise\"}' WHERE id = 1",
            [],
        )
        .unwrap();
        let live = call(&conn, "workout.sessionActive", json!({})).unwrap();
        assert!(live["restLeftSec"].is_null());
    }

    /// 训练课 4 条事件级写入：只回受理回执；下行命令的事件名与载荷照干净契约 §14.3。
    #[test]
    fn workout_session_controls_accept_and_shape_downlink() {
        let conn = db();
        let start = call(
            &conn,
            "workout.sessionStart",
            json!({ "planId": "p1", "planName": "胸推日", "startedAt": "2026-01-01T09:00:00Z" }),
        )
        .unwrap();
        assert_eq!(start, json!({ "accepted": true }));
        let (event, data) =
            control_command(Method::WorkoutSessionStart, &json!({ "planId": "p1", "planName": "胸推日", "startedAt": "2026-01-01T09:00:00Z" }))
                .unwrap()
                .unwrap();
        assert_eq!(event, "gateway://session-command");
        assert_eq!(data["action"], "start");
        assert_eq!(data["args"]["planId"], "p1");
        assert!(data["args"].get("state").is_none(), "未给的 state 不该出现 null");

        let snap = call(
            &conn,
            "workout.sessionSnapshot",
            json!({ "id": 1, "exIndex": 0, "setIndex": 1, "weightKg": 40.0, "state": { "phase": "exercise" } }),
        )
        .unwrap();
        assert_eq!(snap, json!({ "accepted": true }));
        let (_, sdata) = control_command(
            Method::WorkoutSessionSnapshot,
            &json!({ "id": 1, "exIndex": 0, "setIndex": 1, "weightKg": 40.0, "state": { "phase": "exercise" } }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(sdata["action"], "snapshot");
        assert_eq!(sdata["args"]["exIndex"], 0);
        assert_eq!(sdata["args"]["state"]["phase"], "exercise");

        let finish = call(
            &conn,
            "workout.sessionFinish",
            json!({ "sessionFinish": {
                "id": 1, "name": "胸推日", "workoutType": "strength", "date": "2026-01-01",
                "durationMin": 42.0, "kcal": 300.0,
                "sets": [{ "exerciseKey": "bench", "exerciseName": "卧推", "kind": "strength", "setNo": 1, "weightKg": 40.0, "reps": 8 }]
            }}),
        )
        .unwrap();
        assert_eq!(finish, json!({ "accepted": true }));
        let (_, fdata) = control_command(
            Method::WorkoutSessionFinish,
            &json!({ "sessionFinish": { "id": 1, "name": "胸推日", "workoutType": "strength", "date": "2026-01-01", "durationMin": 42.0, "kcal": 300.0 } }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(fdata["action"], "finish");
        assert_eq!(fdata["args"]["sessionFinish"]["name"], "胸推日");

        let abort = call(&conn, "workout.sessionAbort", json!({ "id": 1 })).unwrap();
        assert_eq!(abort, json!({ "accepted": true }));
        let (_, adata) = control_command(Method::WorkoutSessionAbort, &json!({ "id": 7 }))
            .unwrap()
            .unwrap();
        assert_eq!(adata["action"], "abort");
        assert_eq!(adata["args"]["id"], 7);
        // 「无参数」的会话方法缺必填 id：应 bad_request（params = null 按空对象解析）
        assert!(
            dispatch(&conn, Method::WorkoutSessionAbort, &Value::Null).is_err(),
            "缺 id 应 bad_request"
        );
    }

    /// 控制方法的锁外动作：`dispatch_with_effects` 回一条 `Emit`，服务层据此 emit（§14.3）。
    #[test]
    fn control_dispatch_emits_effect_for_the_service_layer() {
        let conn = db();
        let (value, effects) = dispatch_with_effects(
            &conn,
            Method::PomodoroStart,
            &json!({ "focusMin": 25, "todoId": 7 }),
        )
        .unwrap();
        assert_eq!(value, json!({ "accepted": true }));
        assert_eq!(effects.len(), 1);
        match &effects[0] {
            Effect::Emit { event, data } => {
                assert_eq!(*event, "gateway://pomodoro-command");
                assert_eq!(data["action"], "start");
                assert_eq!(data["args"]["focusMin"], 25);
            }
            other => panic!("应为 Emit，实得 {other:?}"),
        }
        // 只读方法不产生任何锁外动作
        let (_, effects) = dispatch_with_effects(&conn, Method::PomodoroStatus, &json!({})).unwrap();
        assert!(effects.is_empty());
    }

    /// `workout.delete` 的锁外动作：本地记录 + 已导出 + 回写开 → `PropagateDelete`；
    /// HC 导入记录 → 只记墓碑、不回传（contract §13.3）。
    #[test]
    fn workout_delete_effects_handle_health_connect_semantics() {
        use crate::db::meta_set;

        let conn = db();
        // 本地记录 + external_id + 回写开关开 → 需在锁外传播删除
        conn.execute(
            "INSERT INTO workouts (id, name, type, date, duration_min, kcal, intensity, source, external_id, created_at) \
             VALUES (1, '晨跑', 'run', '2026-09-23', 30.0, 200.0, 'moderate', 'local', 'hc-1', datetime('now'))",
            [],
        )
        .unwrap();
        meta_set(&conn, "health_sync.push_enabled", "1").unwrap();
        let (value, effects) = dispatch_with_effects(&conn, Method::WorkoutDelete, &json!({ "id": 1 })).unwrap();
        assert_eq!(value, json!({}));
        assert_eq!(effects, vec![Effect::PropagateDelete { external_id: "hc-1".into() }]);

        // 导入记录 → 只记墓碑，不产生锁外动作
        conn.execute(
            "INSERT INTO workouts (id, name, type, date, duration_min, kcal, intensity, source, external_id, created_at) \
             VALUES (2, '导入的跑步', 'run', '2026-09-24', 20.0, 120.0, 'moderate', 'health_connect', 'hc-2', datetime('now'))",
            [],
        )
        .unwrap();
        let (_, effects) = dispatch_with_effects(&conn, Method::WorkoutDelete, &json!({ "id": 2 })).unwrap();
        assert!(effects.is_empty(), "HC 是权威，本机删除不动 HC 侧");
        let tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM health_sync_tombstones WHERE external_id = 'hc-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstones, 1, "导入记录删除应留一条墓碑");
    }

    /// `workout.delete`：与 UI 同路径删行，回 `{}`。
    #[test]
    fn workout_delete_removes_the_row() {
        let conn = db();
        let created = call(
            &conn,
            "workout.create",
            json!({ "name": "晨跑", "workoutType": "run", "date": "2026-09-23", "durationMin": 30.0, "kcal": 200.0 }),
        )
        .unwrap();
        let id = created["id"].as_i64().unwrap();
        assert_eq!(call(&conn, "workout.delete", json!({ "id": id })).unwrap(), json!({}));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM workouts WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// `pomodoro.status`：未陈旧 → 原样返回快照；陈旧 → `null`（判定在后端，§14.1）。
    #[test]
    fn pomodoro_status_reads_fresh_runtime_and_nulls_stale() {
        let conn = db();
        assert!(call(&conn, "pomodoro.status", json!({})).unwrap().is_null(), "无快照 → null");
        let payload = r#"{"phase":"focus","running":true,"remainingSec":1234,"reportedAt":"2026-01-01T09:00:00Z"}"#;
        store::put_runtime_snapshot(&conn, store::KEY_FOCUS_RUNTIME, payload).unwrap();
        let got = call(&conn, "pomodoro.status", json!({})).unwrap();
        assert_eq!(got["phase"], "focus");
        assert_eq!(got["remainingSec"], 1234);
        // 写入时刻推到 5 秒窗口之外 → 陈旧 → null
        let stale_at = (Utc::now() - chrono::Duration::milliseconds(6_000)).to_rfc3339();
        store::put_runtime_snapshot_at(&conn, store::KEY_FOCUS_RUNTIME, payload, &stale_at).unwrap();
        assert!(call(&conn, "pomodoro.status", json!({})).unwrap().is_null(), "陈旧 → null");
    }

    /// 番茄钟三条控制：只回受理回执；下行命令走 `gateway://pomodoro-command`。
    #[test]
    fn pomodoro_controls_accept_and_shape_downlink() {
        let conn = db();
        let started = call(&conn, "pomodoro.start", json!({ "focusMin": 25, "breakMin": 5, "todoId": 42 }))
            .unwrap();
        assert_eq!(started, json!({ "accepted": true }));
        let (event, data) = control_command(
            Method::PomodoroStart,
            &json!({ "focusMin": 25, "breakMin": 5, "todoId": 42 }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(event, "gateway://pomodoro-command");
        assert_eq!(data["action"], "start");
        assert_eq!(data["args"]["focusMin"], 25);
        assert_eq!(data["args"]["todoId"], 42);

        // 无参控制（params = null → 空对象），可选字段不出现
        assert_eq!(call(&conn, "pomodoro.pause", Value::Null).unwrap(), json!({ "accepted": true }));
        let (_, pdata) = control_command(Method::PomodoroPause, &Value::Null).unwrap().unwrap();
        assert_eq!(pdata["action"], "pause");
        assert_eq!(pdata["args"], json!({}));

        assert_eq!(call(&conn, "pomodoro.stop", json!({})).unwrap(), json!({ "accepted": true }));
        // 非控制方法不给下行命令
        assert!(control_command(Method::PomodoroStatus, &json!({})).unwrap().is_none());
        assert!(control_command(Method::PomodoroList, &Value::Null).unwrap().is_none());
    }

    /// 控制方法的参数违规：`sessionStart` 缺 `planId`、`planName` 超长 → `bad_request`（§17.5）。
    #[test]
    fn control_params_are_validated() {
        let conn = db();
        let err = call(&conn, "workout.sessionStart", json!({ "planName": "x", "startedAt": "t" }))
            .unwrap_err();
        assert_eq!(err.code(), "bad_request");
        let long = "字".repeat(MAX_TITLE + 1);
        let err = call(
            &conn,
            "workout.sessionStart",
            json!({ "planId": "p", "planName": long, "startedAt": "t" }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_request");
        // sessionFinish 的 name 超长
        let err = call(
            &conn,
            "workout.sessionFinish",
            json!({ "sessionFinish": {
                "id": 1, "name": "字".repeat(MAX_TITLE + 1), "workoutType": "strength",
                "date": "2026-01-01", "durationMin": 1.0, "kcal": 1.0
            }}),
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_request");
    }
}
