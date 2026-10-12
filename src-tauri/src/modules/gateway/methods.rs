//! 域方法绑定：把协议层注册的 v1 方法（contract §4.4，15 条）接到各域已有的 `*_on` 函数。
//!
//! 三条纪律：
//! 1. 每个 handler 收 `&Connection` —— 由服务层用**同一把** `state.db.lock()` 提供，
//!    本模块绝不 `Connection::open`、也不自己取锁（contract §6.1 单连接铁律：钩子按连接注册）。
//! 2. 写操作走的就是那条带 `update_hook` 的唯一连接，所以写入会被同步自动捕获；
//!    本模块不需要（也**不允许**）再装第二个钩子。
//! 3. 这里只做「参数 → `*_on` → DTO」的映射，不做鉴权：scope 校验由服务层在调用
//!    [`dispatch`] 之前用 [`Method::scope`] 完成（contract §5.3「先 require 再取锁」）。

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ReinError, Result};
use crate::modules::gateway::protocol::Method;
use crate::modules::todo::models::Todo;
use crate::modules::{exercise, plan, pomodoro, session, todo};

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

/// 把一条**已通过 scope 校验**的方法调用派发到对应域函数。
///
/// 错误一律以 [`ReinError`] 返回，其 `code()` 即协议错误码
/// （`bad_request`/`not_found`/`internal`…，contract §4.6），由服务层翻译成错误帧。
pub fn dispatch(conn: &Connection, method: Method, params: &Value) -> Result<Value> {
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
        Method::WorkoutPlans => to_value(cap_rows(plan::commands::list_workout_plans_on(conn)?)),
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
        Method::WorkoutStrengthHistory => {
            let p: ExerciseIdParams = parse(params)?;
            to_value(cap_rows(session::commands::strength_history_on(conn, &p.exercise_id)?))
        }
        Method::WorkoutStrengthExercises => {
            to_value(cap_rows(session::commands::strength_exercises_on(conn)?))
        }
        Method::WorkoutLastWeights => {
            let p: ExerciseIdsParams = parse(params)?;
            to_value(cap_rows(session::commands::strength_last_weights_on(conn, &p.exercise_ids)?))
        }
        Method::WorkoutRecentSets => {
            let p: RecentSetsParams = parse(params)?;
            to_value(cap_rows(session::commands::strength_recent_sets_on(conn, p.days)?))
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
            to_value(pomodoro::commands::save_pomodoro_session_on(conn, &p.session)?)
        }
    }
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
}
