//! 运行态桥接的**存储/恢复**层（contract `docs/EXTERNAL-API.md` §14.1）。
//!
//! 番茄钟的「进行中」真源在前端（`src/stores/pomodoro.ts`）：前端 `running` 时每 1 秒
//! `focus_publish(snapshot)` 把一份 `FocusRuntime` JSON 写进 `app_meta:runtime.focus.v1`，
//! 相位结束 / 暂停 / 复位时 `focus_unpublish()` 删键。本模块是这条上行的后端本体：
//! `focus_publish_on` / `focus_unpublish_on` / `focus_state_on` 收 `&Connection`
//! （与 `gateway::methods` 共用同一把 `state.db.lock()`，contract §6.1 单连接铁律），
//! tauri 命令退化为壳。
//!
//! 另有 **`recover_focus`**（用户定稿的重启恢复语义）：应用关闭期间倒计时走完时，
//! 启动自检用 `save_pomodoro_session_on` 补写一行，并删掉陈旧键；未到零 / 休息相位只清键。
//! `FocusRuntime.phaseStartedAt + remainingSec` 就是「预计结束时刻」，前端拼快照时按这条
//! 等式锚定（`src/stores/pomodoro.ts:63-65`），恢复自检据此判「关闭期间是否已走完」。

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;
use serde_json::Value;

use crate::error::{ReinError, Result};
use crate::modules::gateway::store;
use crate::modules::pomodoro::commands::save_pomodoro_session_on;
use crate::modules::pomodoro::models::PomodoroSessionInput;

/// 读运行态（`pomodoro.status` 的对外结果）。陈旧（`now - 写入时刻 > 5s`）即 `None`
/// —— 判定在**后端**做，不信前端自报的 `reportedAt`（contract §14.1）。
///
/// 载荷是前端原样 JSON：解析失败按 `internal` 报（坏数据不该被当成「没有运行态」静默吞掉）。
pub fn focus_state_on(conn: &Connection) -> Result<Option<Value>> {
    let Some(snap) = store::fresh_runtime_snapshot(conn, store::KEY_FOCUS_RUNTIME)? else {
        return Ok(None);
    };
    serde_json::from_str::<Value>(&snap.payload)
        .map(Some)
        .map_err(|e| ReinError::coded("internal", format!("运行态快照不是合法 JSON：{e}")))
}

/// 写入一份运行态快照（前端 `focus_publish` 的本体）。载荷原样落 `app_meta`，
/// 同时记服务端写入时刻；陈旧判定据此（本层不解析其形状）。
pub fn focus_publish_on(conn: &Connection, snapshot: &Value) -> Result<()> {
    let payload = serde_json::to_string(snapshot)
        .map_err(|e| ReinError::coded("internal", format!("运行态快照无法序列化：{e}")))?;
    store::put_runtime_snapshot(conn, store::KEY_FOCUS_RUNTIME, &payload)
}

/// 清除运行态快照（前端 `focus_unpublish` 的本体；幂等）。
pub fn focus_unpublish_on(conn: &Connection) -> Result<()> {
    store::clear_runtime_snapshot(conn, store::KEY_FOCUS_RUNTIME)
}

/// 启动恢复语义（contract §14.1「重启恢复语义（用户定稿）」）。
///
/// 1. 无键 → 无操作。
/// 2. `running==true` 且相位为 `focus`，且 `phaseStartedAt + remainingSec <= now`
///    （倒计时归零发生在应用关闭期间）→ 按「计时确实走完」用 `save_pomodoro_session_on`
///    补写一行，**同一事务**删键（幂等：不会因中途崩溃补写两次）。
/// 3. 其余情况（未到零、或相位是 `break`、或载荷坏到解不出锚点）→ 仅删陈旧键，不补写
///    （`break` 不落库，与前端 `finishPhase` 一致：只有 focus 写库）。
pub fn recover_focus(conn: &Connection, now: DateTime<Utc>) -> Result<()> {
    let Some(snap) = store::get_runtime_snapshot(conn, store::KEY_FOCUS_RUNTIME)? else {
        return Ok(());
    };
    let parsed: Value = serde_json::from_str(&snap.payload).unwrap_or(Value::Null);

    let Some(input) = backfill_input(&parsed, now) else {
        // 未到零 / 休息相位 / 坏载荷：只清键。
        return store::clear_runtime_snapshot(conn, store::KEY_FOCUS_RUNTIME);
    };

    // 补写 + 删键同一事务：崩在中间也不会补写两次（幂等）。
    let tx = conn.unchecked_transaction()?;
    save_pomodoro_session_on(&tx, &input)?;
    store::clear_runtime_snapshot(&tx, store::KEY_FOCUS_RUNTIME)?;
    tx.commit()?;
    Ok(())
}

/// 判断这份快照是否「关闭期间走完」，走完则给出要补写的那行。
///
/// 走完的充要条件：`running==true` 且 `phase=="focus"` 且 `phaseStartedAt + remainingSec <= now`。
/// 锚点解不出（缺字段 / 坏时间戳）一律判「没走完」（宁可少补一行，也不凭空造记录）。
fn backfill_input(snapshot: &Value, now: DateTime<Utc>) -> Option<PomodoroSessionInput> {
    if snapshot.get("running").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    if snapshot.get("phase").and_then(Value::as_str) != Some("focus") {
        return None;
    }
    let started = parse_rfc3339(snapshot.get("phaseStartedAt").and_then(Value::as_str)?)?;
    let remaining = snapshot.get("remainingSec").and_then(Value::as_f64)?;
    let ended = started + Duration::seconds(remaining as i64);
    if ended > now {
        return None;
    }
    Some(PomodoroSessionInput {
        todo_id: snapshot.get("linkedTodoId").and_then(Value::as_i64),
        started_at: started.to_rfc3339(),
        ended_at: ended.to_rfc3339(),
        focus_min: snapshot
            .get("plannedFocusMin")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        // `break` 不落库；补写的都是 focus 相位，breakMin 固定 0（contract §14.1 第 2 条）。
        break_min: 0.0,
        completed: true,
    })
}

/// 解析 RFC3339 时间戳；兼容无时区标记的写法（当作 UTC）。
fn parse_rfc3339(raw: &str) -> Option<DateTime<Utc>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn put(conn: &Connection, snapshot: Value) {
        focus_publish_on(conn, &snapshot).unwrap();
    }

    /// `focus_publish_on` / `focus_state_on` / `focus_unpublish_on` 与命令行为一致。
    #[test]
    fn publish_state_unpublish_roundtrip() {
        let conn = db();
        assert!(focus_state_on(&conn).unwrap().is_none(), "无快照 → None");
        put(
            &conn,
            serde_json::json!({
                "phase": "focus", "running": true, "remainingSec": 1200,
                "plannedFocusMin": 25, "plannedBreakMin": 5,
                "phaseStartedAt": "2026-10-13T09:00:00Z", "linkedTodoId": 7
            }),
        );
        let got = focus_state_on(&conn).unwrap().expect("刚写完应新鲜");
        assert_eq!(got["phase"], "focus");
        assert_eq!(got["remainingSec"], 1200);
        focus_unpublish_on(&conn).unwrap();
        assert!(focus_state_on(&conn).unwrap().is_none(), "清键后无快照");
        focus_unpublish_on(&conn).unwrap(); // 幂等
    }

    /// 关闭期间走完（`phaseStartedAt + remainingSec <= now`）→ 补写一行 + 删键。
    #[test]
    fn recover_backfills_a_finished_focus() {
        let conn = db();
        // 关联待办必须先存在（pomodoro_sessions.todo_id 有外键）
        conn.execute(
            "INSERT INTO todos (id, title, category, priority, status, created_at) \
             VALUES (42, '写周报', 'general', 0, 'todo', 'now')",
            [],
        )
        .unwrap();
        // 09:00 起、剩 25 分钟 → 09:25 结束；现在 10:00（关闭期间早已走完）
        put(
            &conn,
            serde_json::json!({
                "phase": "focus", "running": true, "remainingSec": 1500,
                "plannedFocusMin": 25, "plannedBreakMin": 5,
                "phaseStartedAt": "2026-10-13T09:00:00Z", "linkedTodoId": 42
            }),
        );
        let now = "2026-10-13T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        recover_focus(&conn, now).unwrap();

        let rows: Vec<(Option<i64>, String, String, f64, f64, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT todo_id, started_at, ended_at, focus_min, break_min, completed \
                     FROM pomodoro_sessions",
                )
                .unwrap();
            let it = stmt
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .unwrap();
            it.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(rows.len(), 1, "走完应补写一行");
        assert_eq!(rows[0].0, Some(42), "关联待办透传");
        assert_eq!(rows[0].2, "2026-10-13T09:25:00+00:00", "endedAt = 起点 + 剩余");
        assert_eq!(rows[0].3, 25.0);
        assert_eq!(rows[0].4, 0.0, "focus 补写 breakMin=0");
        assert_eq!(rows[0].5, 1, "completed=true");
        assert!(focus_state_on(&conn).unwrap().is_none(), "补写后键已删");
        // 幂等：再跑一次不会再补一行
        recover_focus(&conn, now).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "重复恢复不重复补写");
    }

    /// 未到零 → 只清键，不补写。
    #[test]
    fn recover_clears_only_when_not_finished() {
        let conn = db();
        put(
            &conn,
            serde_json::json!({
                "phase": "focus", "running": true, "remainingSec": 1500,
                "plannedFocusMin": 25, "plannedBreakMin": 5,
                "phaseStartedAt": "2026-10-13T09:00:00Z"
            }),
        );
        // 现在是 09:10，还剩约 15 分钟 → 未到零
        let now = "2026-10-13T09:10:00Z".parse::<DateTime<Utc>>().unwrap();
        recover_focus(&conn, now).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "未到零不补写");
        assert!(focus_state_on(&conn).unwrap().is_none(), "陈旧键已清");
    }

    /// 休息相位走完也不落库（与前端 `finishPhase` 一致：只有 focus 写库）。
    #[test]
    fn recover_does_not_backfill_break_phase() {
        let conn = db();
        put(
            &conn,
            serde_json::json!({
                "phase": "break", "running": true, "remainingSec": 300,
                "plannedFocusMin": 25, "plannedBreakMin": 5,
                "phaseStartedAt": "2026-10-13T09:00:00Z"
            }),
        );
        let now = "2026-10-13T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        recover_focus(&conn, now).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "休息相位不落库");
        assert!(focus_state_on(&conn).unwrap().is_none());
    }
}
