//! 网关的线上协议：消息信封（含协议版本）、请求/响应/事件三种消息、错误码、方法注册表。
//!
//! 这里只描述**帧的形状**，不做 IO、不碰 DB、不做鉴权 —— 那些由服务与授权层负责
//! （`server.rs` / `auth.rs` / `models.rs::Scope`）。字段名一律 camelCase（与 IPC 一致，见
//! `docs/STANDARDS.md` §2 / contract §4.3）。
//!
//! 三种消息（contract §4.3）：
//! - **请求**：`{ v, id, method, params }`（客户端 → 服务端）
//! - **响应**：`{ v, id, ok, result|error }`（服务端 → 客户端，`id` 回填）
//! - **事件**：`{ v, event, data }`（服务端 → 客户端，非应答、无 `id`）

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::modules::gateway::models::Scope;

/// 协议版本。信封里的 `v` 必须等于它，否则回 `unsupported_version`（contract §4.6）。
pub const PROTOCOL_VERSION: u32 = 1;

/// `RequestEnvelope.params` 缺省时的值：空对象。
/// serde 的 `Value` 默认是 `Value::Null`，与「缺省视为空对象」的注释不符，也逼下游各自判空；
/// 统一在这里给空对象，方法层直接按对象解析。
fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

// ---------------------------------------------------------------- 首帧（令牌）

/// 连接后的**首帧**（contract §4.2）：不带 `method`，用来证明身份。
/// 5 秒内没到就 `1008` 关闭（那条闸门在 `server.rs`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub v: u32,
    /// 客户端生成、稳定的 uuid，跨重连不变（`ext_clients.client_id`）。
    pub client_id: String,
    /// 展示名（弹窗上给人看）。
    #[serde(default)]
    pub client_name: String,
    /// 「始终允许」时签发的凭证；命中未撤销的 allow 行即放行，跳过弹窗。
    #[serde(default)]
    pub client_token: Option<String>,
    /// 安装级配对令牌；LAN 模式必填且必须匹配。
    #[serde(default)]
    pub pair_token: Option<String>,
}

// ---------------------------------------------------------------- 请求 / 响应 / 事件

/// 请求帧（客户端 → 服务端）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub v: u32,
    /// 请求 uuid 字符串，响应原样回填。
    pub id: String,
    /// 方法名，见 [`Method`]。
    pub method: String,
    /// 方法参数；缺省视为空对象。
    #[serde(default = "empty_object")]
    pub params: Value,
}

/// 错误体（响应里的 `error`）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// 响应帧（服务端 → 客户端）。构造一律走 [`ResponseEnvelope::ok`] / [`ResponseEnvelope::err`]，
/// 保证 `ok` 与 `result`/`error` 的配对不会写错。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub v: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl ResponseEnvelope {
    /// 成功响应。
    pub fn ok(id: impl Into<String>, result: Value) -> Self {
        ResponseEnvelope {
            v: PROTOCOL_VERSION,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    /// 失败响应。`code` 用 [`ErrorCode`]。
    pub fn err(id: impl Into<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        ResponseEnvelope {
            v: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.as_str().to_string(),
                message: message.into(),
            }),
        }
    }
}

/// 事件帧（服务端 → 客户端，非应答）。事件名字符串见 contract §4.5。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub v: u32,
    pub event: String,
    pub data: Value,
}

impl EventEnvelope {
    pub fn new(event: impl Into<String>, data: Value) -> Self {
        EventEnvelope {
            v: PROTOCOL_VERSION,
            event: event.into(),
            data,
        }
    }
}

/// 三条 WS→外部客户端事件名（contract §4.5）。只是字符串常量，前端/外部照抄。
pub mod events {
    pub const AUTH_PENDING: &str = "gateway.auth.pending";
    pub const AUTH_GRANTED: &str = "gateway.auth.granted";
    pub const AUTH_DENIED: &str = "gateway.auth.denied";
}

/// 两条 Tauri→前端的**下行控制**事件名（contract §14.3）。外部方法只回受理回执，
/// 真正执行由前端 store 完成：服务层在锁外用 AppHandle `emit` 这两个事件
/// （前端 `externalAccessRuntime` 照抄这两个字符串监听）。
pub mod downlink {
    /// `pomodoro.start/pause/stop` → 前端 `pomodoroStore`。
    pub const POMODORO_COMMAND: &str = "gateway://pomodoro-command";
    /// `workout.sessionStart/sessionSnapshot/sessionFinish/sessionAbort` → 前端 `sessionStore`。
    pub const SESSION_COMMAND: &str = "gateway://session-command";
}

// ---------------------------------------------------------------- 错误码

/// 响应 `error.code` 的取值集合（contract §4.6）。`close_code()` 给出需要随之关闭连接时的
/// WebSocket 关闭码（`None` = 保持连接，只回错误帧）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnsupportedVersion,
    BadRequest,
    Unauthorized,
    ForbiddenScope,
    PendingAuthorization,
    Denied,
    NotFound,
    Timeout,
    Busy,
    PayloadTooLarge,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::Unauthorized => "unauthorized",
            ErrorCode::ForbiddenScope => "forbidden_scope",
            ErrorCode::PendingAuthorization => "pending_authorization",
            ErrorCode::Denied => "denied",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Busy => "busy",
            ErrorCode::PayloadTooLarge => "payload_too_large",
            ErrorCode::Internal => "internal",
        }
    }

    /// 该错误是否要求关闭连接（contract §4.6 的「WS 关闭」列）。
    pub fn close_code(self) -> Option<u16> {
        match self {
            // 协议版本不对：回错误帧并 400 关闭
            ErrorCode::UnsupportedVersion => Some(400),
            // 鉴权失败 / 用户拒绝：1008 policy violation
            ErrorCode::Unauthorized | ErrorCode::Denied => Some(1008),
            // 消息过大：1009 message too big
            ErrorCode::PayloadTooLarge => Some(1009),
            ErrorCode::BadRequest
            | ErrorCode::ForbiddenScope
            | ErrorCode::PendingAuthorization
            | ErrorCode::NotFound
            | ErrorCode::Timeout
            | ErrorCode::Busy
            | ErrorCode::Internal => None,
        }
    }

    /// 由既有 `ReinError::code()` 的字符串映射回来；认不出的按 `internal`（contract §4.6 末行）。
    pub fn from_rein_code(code: &str) -> ErrorCode {
        match code {
            "unsupported_version" => ErrorCode::UnsupportedVersion,
            "bad_request" => ErrorCode::BadRequest,
            "unauthorized" => ErrorCode::Unauthorized,
            "forbidden_scope" => ErrorCode::ForbiddenScope,
            "pending_authorization" => ErrorCode::PendingAuthorization,
            "denied" => ErrorCode::Denied,
            "not_found" => ErrorCode::NotFound,
            "timeout" => ErrorCode::Timeout,
            "busy" => ErrorCode::Busy,
            "payload_too_large" => ErrorCode::PayloadTooLarge,
            _ => ErrorCode::Internal,
        }
    }
}

// ---------------------------------------------------------------- 方法注册表

/// 全部对外方法（contract §4.4：v1 15 条 + 第二轮 13 条 = 28 条）。`name()` 是线上字符串，
/// `scope()` 是调用它所需的权限 —— 二者合起来就是**方法注册表**：入站请求先按 `from_name`
/// 命中，再用 `scope()` 走逐次授权校验。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    ScheduleList,
    ScheduleListAll,
    ScheduleCreate,
    ScheduleUpdate,
    ScheduleDelete,
    ScheduleCampus,
    SchedulePrograms,
    ScheduleProgramActive,
    WorkoutPlans,
    WorkoutPlan,
    WorkoutList,
    WorkoutCreate,
    WorkoutStrengthHistory,
    WorkoutStrengthExercises,
    WorkoutLastWeights,
    WorkoutRecentSets,
    WorkoutSessionActive,
    WorkoutSessionStart,
    WorkoutSessionSnapshot,
    WorkoutSessionFinish,
    WorkoutSessionAbort,
    WorkoutDelete,
    PomodoroList,
    PomodoroSave,
    PomodoroStatus,
    PomodoroStart,
    PomodoroPause,
    PomodoroStop,
}

impl Method {
    /// 全部方法（注册表的唯一真源，顺序即 contract §4.4 的表格顺序）。
    pub const ALL: [Method; 28] = [
        Method::ScheduleList,
        Method::ScheduleListAll,
        Method::ScheduleCreate,
        Method::ScheduleUpdate,
        Method::ScheduleDelete,
        Method::ScheduleCampus,
        Method::SchedulePrograms,
        Method::ScheduleProgramActive,
        Method::WorkoutPlans,
        Method::WorkoutPlan,
        Method::WorkoutList,
        Method::WorkoutCreate,
        Method::WorkoutStrengthHistory,
        Method::WorkoutStrengthExercises,
        Method::WorkoutLastWeights,
        Method::WorkoutRecentSets,
        Method::WorkoutSessionActive,
        Method::WorkoutSessionStart,
        Method::WorkoutSessionSnapshot,
        Method::WorkoutSessionFinish,
        Method::WorkoutSessionAbort,
        Method::WorkoutDelete,
        Method::PomodoroList,
        Method::PomodoroSave,
        Method::PomodoroStatus,
        Method::PomodoroStart,
        Method::PomodoroPause,
        Method::PomodoroStop,
    ];

    /// 线上方法名字符串。
    pub fn name(self) -> &'static str {
        match self {
            Method::ScheduleList => "schedule.list",
            Method::ScheduleListAll => "schedule.listAll",
            Method::ScheduleCreate => "schedule.create",
            Method::ScheduleUpdate => "schedule.update",
            Method::ScheduleDelete => "schedule.delete",
            Method::ScheduleCampus => "schedule.campus",
            Method::SchedulePrograms => "schedule.programs",
            Method::ScheduleProgramActive => "schedule.programActive",
            Method::WorkoutPlans => "workout.plans",
            Method::WorkoutPlan => "workout.plan",
            Method::WorkoutList => "workout.list",
            Method::WorkoutCreate => "workout.create",
            Method::WorkoutStrengthHistory => "workout.strengthHistory",
            Method::WorkoutStrengthExercises => "workout.strengthExercises",
            Method::WorkoutLastWeights => "workout.lastWeights",
            Method::WorkoutRecentSets => "workout.recentSets",
            Method::WorkoutSessionActive => "workout.sessionActive",
            Method::WorkoutSessionStart => "workout.sessionStart",
            Method::WorkoutSessionSnapshot => "workout.sessionSnapshot",
            Method::WorkoutSessionFinish => "workout.sessionFinish",
            Method::WorkoutSessionAbort => "workout.sessionAbort",
            Method::WorkoutDelete => "workout.delete",
            Method::PomodoroList => "pomodoro.list",
            Method::PomodoroSave => "pomodoro.save",
            Method::PomodoroStatus => "pomodoro.status",
            Method::PomodoroStart => "pomodoro.start",
            Method::PomodoroPause => "pomodoro.pause",
            Method::PomodoroStop => "pomodoro.stop",
        }
    }

    /// 调用该方法所需的 scope（`scope::require` 的唯一入参来源）。
    /// **删除不从写权限派生**：`schedule.delete` / `workout.delete` 是独立权限（contract §13.1）。
    pub fn scope(self) -> Scope {
        match self {
            Method::ScheduleList | Method::ScheduleListAll => Scope::ScheduleRead,
            Method::ScheduleCampus
            | Method::SchedulePrograms
            | Method::ScheduleProgramActive => Scope::ScheduleRead,
            Method::ScheduleCreate => Scope::ScheduleCreate,
            Method::ScheduleUpdate => Scope::ScheduleWrite,
            Method::ScheduleDelete => Scope::ScheduleDelete,
            Method::WorkoutPlans
            | Method::WorkoutPlan
            | Method::WorkoutList
            | Method::WorkoutStrengthHistory
            | Method::WorkoutStrengthExercises
            | Method::WorkoutLastWeights
            | Method::WorkoutRecentSets
            | Method::WorkoutSessionActive => Scope::WorkoutRead,
            Method::WorkoutCreate
            | Method::WorkoutSessionStart
            | Method::WorkoutSessionSnapshot
            | Method::WorkoutSessionFinish
            | Method::WorkoutSessionAbort => Scope::WorkoutWrite,
            Method::WorkoutDelete => Scope::WorkoutDelete,
            Method::PomodoroList | Method::PomodoroStatus => Scope::PomodoroRead,
            Method::PomodoroSave => Scope::PomodoroWrite,
            Method::PomodoroStart | Method::PomodoroPause | Method::PomodoroStop => {
                Scope::PomodoroControl
            }
        }
    }

    /// 该方法是写操作吗（会改数据：直接写库、或经下行事件落到前端再写库）？
    /// 审计据此记**参数摘要**（contract §17.4），`check_len` 据此覆盖所有写入方法（§17.5）。
    ///
    /// 说明：`schedule.campus` 虽然会顺带物化课表派生行（contract §13.2 认账的幂等本地写），
    /// 但对外语义是「读课表」，故不在此列；`pomodoro.status` / 各读方法同理。
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Method::ScheduleCreate
                | Method::ScheduleUpdate
                | Method::ScheduleDelete
                | Method::WorkoutCreate
                | Method::WorkoutDelete
                | Method::WorkoutSessionStart
                | Method::WorkoutSessionSnapshot
                | Method::WorkoutSessionFinish
                | Method::WorkoutSessionAbort
                | Method::PomodoroSave
                | Method::PomodoroStart
                | Method::PomodoroPause
                | Method::PomodoroStop
        )
    }

    /// 该方法是不是「下行控制」——只回受理回执，实际动作由前端 store 完成
    /// （contract §14.3：`control_command` 的入参）。非控制方法返回 `false`。
    pub fn is_control(self) -> bool {
        matches!(
            self,
            Method::WorkoutSessionStart
                | Method::WorkoutSessionSnapshot
                | Method::WorkoutSessionFinish
                | Method::WorkoutSessionAbort
                | Method::PomodoroStart
                | Method::PomodoroPause
                | Method::PomodoroStop
        )
    }

    /// 精确匹配方法名；未注册的方法返回 `None`（调用方回 `bad_request`）。
    pub fn from_name(name: &str) -> Option<Method> {
        Method::ALL.into_iter().find(|m| m.name() == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_twenty_eight_unique_methods() {
        assert_eq!(Method::ALL.len(), 28);
        // 名字唯一
        let mut names: Vec<&str> = Method::ALL.iter().map(|m| m.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 28, "方法名必须两两不同");
        // 逐个能反查
        for m in Method::ALL {
            assert_eq!(Method::from_name(m.name()), Some(m));
        }
        assert_eq!(Method::from_name("schedule.listSecret"), None, "精确匹配，不认前缀别名");
        assert_eq!(Method::from_name(""), None);
        // 第二轮 13 条的线上名逐一登记（外部与前端照抄这些字符串）
        for (name, m) in [
            ("schedule.campus", Method::ScheduleCampus),
            ("schedule.programs", Method::SchedulePrograms),
            ("schedule.programActive", Method::ScheduleProgramActive),
            ("workout.sessionActive", Method::WorkoutSessionActive),
            ("workout.sessionStart", Method::WorkoutSessionStart),
            ("workout.sessionSnapshot", Method::WorkoutSessionSnapshot),
            ("workout.sessionFinish", Method::WorkoutSessionFinish),
            ("workout.sessionAbort", Method::WorkoutSessionAbort),
            ("workout.delete", Method::WorkoutDelete),
            ("pomodoro.status", Method::PomodoroStatus),
            ("pomodoro.start", Method::PomodoroStart),
            ("pomodoro.pause", Method::PomodoroPause),
            ("pomodoro.stop", Method::PomodoroStop),
        ] {
            assert_eq!(Method::from_name(name), Some(m), "{name} 必须已注册");
            assert_eq!(m.name(), name);
        }
    }

    #[test]
    fn scopes_match_contract() {
        assert_eq!(Method::ScheduleList.scope(), Scope::ScheduleRead);
        assert_eq!(Method::ScheduleCreate.scope(), Scope::ScheduleCreate);
        assert_eq!(Method::ScheduleUpdate.scope(), Scope::ScheduleWrite);
        // 删除由 schedule.write 拆出（contract §13.1）
        assert_eq!(Method::ScheduleDelete.scope(), Scope::ScheduleDelete);
        assert_eq!(Method::WorkoutDelete.scope(), Scope::WorkoutDelete);
        // 日程域扩到校园课表与训练方案：都只读
        assert_eq!(Method::ScheduleCampus.scope(), Scope::ScheduleRead);
        assert_eq!(Method::SchedulePrograms.scope(), Scope::ScheduleRead);
        assert_eq!(Method::ScheduleProgramActive.scope(), Scope::ScheduleRead);
        // 会话事件级写入 → workout.write；活跃投影 → workout.read
        assert_eq!(Method::WorkoutSessionActive.scope(), Scope::WorkoutRead);
        assert_eq!(Method::WorkoutSessionStart.scope(), Scope::WorkoutWrite);
        assert_eq!(Method::WorkoutSessionFinish.scope(), Scope::WorkoutWrite);
        // 番茄钟控制独立于写会话记录
        assert_eq!(Method::PomodoroStatus.scope(), Scope::PomodoroRead);
        assert_eq!(Method::PomodoroStart.scope(), Scope::PomodoroControl);
        assert_eq!(Method::PomodoroStop.scope(), Scope::PomodoroControl);
        assert_eq!(Method::WorkoutCreate.scope(), Scope::WorkoutWrite);
        assert_eq!(Method::WorkoutList.scope(), Scope::WorkoutRead);
        assert_eq!(Method::PomodoroSave.scope(), Scope::PomodoroWrite);
        assert_eq!(Method::PomodoroList.scope(), Scope::PomodoroRead);
        assert!(Method::WorkoutCreate.is_write());
        assert!(Method::ScheduleDelete.is_write());
        assert!(Method::WorkoutDelete.is_write());
        assert!(!Method::WorkoutList.is_write());
        assert!(!Method::ScheduleCampus.is_write(), "读课表不算写（物化行是认账的副作用）");
        assert!(!Method::PomodoroStatus.is_write());
        // 控制方法：只回受理回执，实际动作在前端
        for m in [
            Method::PomodoroStart,
            Method::PomodoroPause,
            Method::PomodoroStop,
            Method::WorkoutSessionStart,
            Method::WorkoutSessionSnapshot,
            Method::WorkoutSessionFinish,
            Method::WorkoutSessionAbort,
        ] {
            assert!(m.is_control(), "{} 应是下行控制方法", m.name());
        }
        assert!(!Method::PomodoroStatus.is_control());
        assert!(!Method::WorkoutSessionActive.is_control());
    }

    #[test]
    fn response_envelope_shapes() {
        let ok = ResponseEnvelope::ok("r1", serde_json::json!({ "n": 1 }));
        let j = serde_json::to_value(&ok).unwrap();
        assert_eq!(j["v"], 1);
        assert_eq!(j["id"], "r1");
        assert_eq!(j["ok"], true);
        assert_eq!(j["result"]["n"], 1);
        assert!(j.get("error").is_none(), "成功响应不该带 error 字段");

        let err = ResponseEnvelope::err("r2", ErrorCode::ForbiddenScope, "没这个权限");
        let j = serde_json::to_value(&err).unwrap();
        assert_eq!(j["ok"], false);
        assert_eq!(j["error"]["code"], "forbidden_scope");
        assert_eq!(j["error"]["message"], "没这个权限");
        assert!(j.get("result").is_none(), "失败响应不该带 result 字段");
    }

    #[test]
    fn request_and_event_serde_are_camel_case() {
        let req: RequestEnvelope = serde_json::from_value(serde_json::json!({
            "v": 1, "id": "abc", "method": "schedule.list",
            "params": { "startDate": "2026-01-01", "endDate": "2026-01-31" }
        }))
        .unwrap();
        assert_eq!(req.v, 1);
        assert_eq!(req.method, "schedule.list");
        assert_eq!(req.params["startDate"], "2026-01-01");
        // params 缺省时是空对象而不是报错
        let req2: RequestEnvelope =
            serde_json::from_value(serde_json::json!({ "v": 1, "id": "x", "method": "schedule.listAll" }))
                .unwrap();
        assert!(req2.params.is_object());

        let ev = EventEnvelope::new(events::AUTH_PENDING, serde_json::json!({ "timeoutMs": 30000 }));
        let j = serde_json::to_value(&ev).unwrap();
        assert_eq!(j["event"], "gateway.auth.pending");
        assert_eq!(j["v"], 1);
        assert!(j.get("id").is_none(), "事件不带 id");
    }

    #[test]
    fn error_close_codes() {
        assert_eq!(ErrorCode::Unauthorized.close_code(), Some(1008));
        assert_eq!(ErrorCode::Denied.close_code(), Some(1008));
        assert_eq!(ErrorCode::UnsupportedVersion.close_code(), Some(400));
        assert_eq!(ErrorCode::PayloadTooLarge.close_code(), Some(1009));
        assert_eq!(ErrorCode::ForbiddenScope.close_code(), None);
        assert_eq!(ErrorCode::from_rein_code("anything-unknown"), ErrorCode::Internal);
    }

    #[test]
    fn hello_requires_v1_shape() {
        let h: ClientHello = serde_json::from_value(serde_json::json!({
            "v": 1, "clientId": "c-1", "clientName": "小组件"
        }))
        .unwrap();
        assert_eq!(h.client_id, "c-1");
        assert_eq!(h.client_token, None);
        assert_eq!(h.pair_token, None);
    }
}
