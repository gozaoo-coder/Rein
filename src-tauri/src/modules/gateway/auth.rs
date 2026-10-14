//! 网关的授权层：四态状态机（pending / 本次会话 / 始终允许 / 忽略 / 拒绝）、
//! 连接级会话表、待决授权队列、逐次调用的 scope 强制点、每 token 限流。
//!
//! 三条结构性的硬要求（contract §5.1 / §5.3）：
//!
//! 1. **「允许本次会话」只活在内存**：`conn_id → ConnGrant` 存在 [`GatewayHub::sessions`]，
//!    连接断开（`end_conn`）即清除 —— 不靠超时猜，也绝不落库。`conn_id` 由服务端在 accept
//!    时生成（`next_conn_id`），外部无法自报，否则自报即可伪造重连。
//! 2. **scope 每次调用都查，不缓存**：[`require`] 对「始终允许」每次回 DB 读当前行，
//!    撤销 / 收窄**立刻**生效；「本次会话」读内存里的那份 scopes。缓存即撤销延迟生效。
//! 3. **配对是能力上的**：首帧带有效 `clientToken` 的走 `store::find_by_token`（恒定时间比较），
//!    否则进待决队列等用户四选一；`deny` 行直接回绝。
//!
//! 本模块不碰 WS（那是 `server.rs`）、不注册 tauri 命令（那是 `commands.rs`），
//! 只提供它们共用的状态与判据。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot, watch};

use crate::error::{ReinError, Result};
use crate::modules::gateway::models::{PromptGate, Scope, ScopeSet};
use crate::modules::gateway::{store, ChangeFeed};

/// 待决授权请求的有效期（毫秒）。超时未决 → 回 `gateway.auth.denied` 并关连接
/// （contract §16 规则 2：**60 秒**，以后端计时为准，前端只显示倒计时；
/// 待决超时同时计入按 IP 的失败限频，见 `server.rs::note_failure`）。
pub const AUTH_PENDING_TIMEOUT_MS: i64 = 60_000;

/// 每 token（按 client_id 计）每分钟最大调用数；超限回 `busy`（contract §4.1）。
pub const TOKEN_RATE_PER_MIN: usize = 120;

/// 限流统计窗口。
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// 未鉴权失败限频：窗口内超过此数即封禁来源 IP（contract §4.1/§7）。
pub const AUTH_FAIL_PER_MIN: usize = 5;
/// 未鉴权失败统计窗口。
pub const AUTH_FAIL_WINDOW: Duration = Duration::from_secs(60);
/// 失败超限后的封禁时长。
pub const AUTH_BAN: Duration = Duration::from_secs(600);

/// 同一来源 IP 每分钟最多弹出几次授权窗；超过即静默挂起（防轮换 clientId 刷弹窗）。
pub const PROMPT_PER_MIN_IP: usize = 3;
/// 按 IP 的弹窗限频窗口。
pub const PROMPT_WINDOW_IP: Duration = Duration::from_secs(60);

/// Tauri→前端事件名（前端照抄，contract §4.5）。放这里是因为 `server.rs`（待决）与
/// `commands.rs`（授权结果）都要发，`auth` 是两者共同的底座。
pub const EVENT_AUTH_REQUIRED: &str = "gateway://authorization-required";
pub const EVENT_AUTH_CHANGED: &str = "gateway://authorization-changed";

/// 控制面推送事件的广播容量（`gateway.runtime` / `gateway.server`）。
/// 比业务变更流小：这两类事件稀疏，订阅者够快，堆积即已异常。
pub const EVENT_CAPACITY: usize = 64;

/// 服务端 → 外部连接的**控制面推送**（非业务表变更，contract §14.5）。
///
/// 由 tauri 命令（`focus_publish` / `focus_unpublish` / 端口写回）发布，连接任务订阅后
/// 编码成 WS 事件帧发给已鉴权客户端（运行态事件只发含 `pomodoro.read` 的连接）。
#[derive(Debug, Clone)]
pub enum ServerEvent {
    /// 番茄钟运行态变更：`data` 是 `FocusRuntime` JSON；`Null` 表示已清（不再有计时）。
    Focus { data: Value, at: i64 },
    /// 实际监听端口与设置项不一致：通知已连接客户端改连（contract §14.5 / §17.2）。
    PortChanged { port: u16 },
}

/// 授权的持久性：本次会话（内存）还是始终允许（落库）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    Session,
    Always,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GrantKind::Session => "session",
            GrantKind::Always => "always",
        }
    }
}

/// 一条连接当前持有的授权（`conn_id → ConnGrant`）。
#[derive(Debug, Clone)]
pub struct ConnGrant {
    pub client_id: String,
    pub name: String,
    pub scopes: ScopeSet,
    pub kind: GrantKind,
}

/// 用户对一条待决请求的裁决（经 oneshot 从命令送回连接任务）。
#[derive(Debug, Clone)]
pub enum AuthDecision {
    /// 允许（本次会话 / 始终）。`token` 仅在 `always` 时出现一次。
    Granted {
        kind: GrantKind,
        token: Option<String>,
        scopes: ScopeSet,
    },
    /// 拒绝：连接回 `gateway.auth.denied` 并以 1008 关闭。
    Denied { reason: String },
    /// 忽略：不授权、不拒绝，连接维持 pending（限频）。
    Ignored,
}

/// 一条待决授权请求（`gateway_authorization_pending` 返回、事件负载）。
/// 字段名对齐前端 `GatewayAuthRequest`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuth {
    pub request_id: String,
    pub client_id: String,
    pub client_name: String,
    /// 该连接握手请求头里的 Origin（原生客户端没有这个头 → `None`）。**客户端无法自报**，
    /// 取自握手请求；带 Origin 的连接必须已命中白名单才可能走到这里（contract §15）。
    pub origin: Option<String>,
    /// 请求来源 IP（服务端从 socket 取，请求方无法伪造）——弹窗上「谁在请求」的可核验信息。
    pub ip: Option<String>,
    /// 建议授权的 scope 集合（默认最小集 = 仅 schedule.read）。
    pub scopes: ScopeSet,
    /// ISO-8601。
    pub created_at: String,
    pub timeout_ms: i64,
}

struct PendingEntry {
    /// 这条待决请求属于哪条连接（决定授权落在哪个会话上）。**不上线**。
    conn_id: String,
    req: PendingAuth,
    tx: Option<oneshot::Sender<AuthDecision>>,
}

#[derive(Default)]
struct ServerHandle {
    /// 服务运行时的关停信号；`Some` = 正在监听。
    shutdown: Option<watch::Sender<bool>>,
    /// 实际监听端口。
    port: Option<u16>,
}

/// 网关的进程内状态：变更广播 hub + 连接会话表 + 待决队列 + 服务生命周期 + 限流。
pub struct GatewayHub {
    /// 同步捕获到的变更由此广播给外部订阅者（`sync/engine.rs` 用 `set_feed` 接上）。
    pub feed: Arc<ChangeFeed>,
    sessions: Mutex<HashMap<String, ConnGrant>>,
    pending: Mutex<HashMap<String, PendingEntry>>,
    conn_seq: AtomicU64,
    server: Mutex<ServerHandle>,
    rate: Mutex<HashMap<String, Vec<Instant>>>,
    /// 未鉴权失败时刻（按来源 IP），用于限频封禁。
    auth_fail: Mutex<HashMap<String, Vec<Instant>>>,
    /// 封禁到期时刻（按来源 IP）。
    bans: Mutex<HashMap<String, Instant>>,
    /// 授权弹窗时刻（按来源 IP），防轮换 clientId 刷弹窗。
    prompt_ip: Mutex<HashMap<String, Vec<Instant>>>,
    /// 控制面推送（运行态 / 端口变化）的广播发送端。
    events: broadcast::Sender<ServerEvent>,
}

impl GatewayHub {
    pub fn new() -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self {
            feed: Arc::new(ChangeFeed::new()),
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            conn_seq: AtomicU64::new(1),
            server: Mutex::new(ServerHandle::default()),
            rate: Mutex::new(HashMap::new()),
            auth_fail: Mutex::new(HashMap::new()),
            bans: Mutex::new(HashMap::new()),
            prompt_ip: Mutex::new(HashMap::new()),
            events,
        }
    }

    // ---------- 连接与会话 ----------

    /// 服务端生成的下一个连接 id（外部无法自报，见类型注释第 1 条）。
    pub fn next_conn_id(&self) -> String {
        format!("conn-{}", self.conn_seq.fetch_add(1, Ordering::Relaxed))
    }

    /// 登记（或升级）一条连接的授权。
    pub fn grant(&self, conn_id: &str, grant: ConnGrant) {
        self.sessions
            .lock()
            .unwrap()
            .insert(conn_id.to_string(), grant);
    }

    fn session(&self, conn_id: &str) -> Option<ConnGrant> {
        self.sessions.lock().unwrap().get(conn_id).cloned()
    }

    /// 连接在其上的 client_id（限流与审计用）。
    pub fn session_client(&self, conn_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(conn_id)
            .map(|g| g.client_id.clone())
    }

    /// 连接当前持有的 scope 集合（**变更推送过滤**用，contract §14.5：只推该连接 scope
    /// 覆盖的域）。连接不在会话表里 = 空集（什么都不推）。
    ///
    /// 与 [`require`] 的区别：`require` 每次回 DB 复核「始终允许」的行（撤销立刻生效），
    /// 这里读的是授权那一刻的内存副本 —— 推送是元数据、不是数据，撤销由下一次调用兜住。
    pub fn session_scopes(&self, conn_id: &str) -> ScopeSet {
        self.sessions
            .lock()
            .unwrap()
            .get(conn_id)
            .map(|g| g.scopes.clone())
            .unwrap_or_default()
    }

    /// 全部活动中的连接授权（管理面列「session」客户端用）。
    pub fn session_grants(&self) -> Vec<ConnGrant> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// 连接结束：清掉它的会话授权与所有待决请求 —— 「断链即会话结束」的落地处。
    pub fn end_conn(&self, conn_id: &str) {
        self.sessions.lock().unwrap().remove(conn_id);
        self.pending
            .lock()
            .unwrap()
            .retain(|_, e| e.conn_id != conn_id);
    }

    /// 撤销某客户端的全部会话授权（`gateway_revoke_client` / 改判拒绝时调用）。
    pub fn clear_sessions_for_client(&self, client_id: &str) {
        self.sessions
            .lock()
            .unwrap()
            .retain(|_, g| g.client_id != client_id);
    }

    // ---------- 待决授权队列 ----------

    /// 入队一条待决请求，返回裁决接收端。
    pub fn begin_pending(&self, conn_id: &str, req: PendingAuth) -> oneshot::Receiver<AuthDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            req.request_id.clone(),
            PendingEntry {
                conn_id: conn_id.to_string(),
                req,
                tx: Some(tx),
            },
        );
        rx
    }

    /// 按 id 取一条待决请求的副本 + 它所属的连接 id（命令据此拿 info / 决定授权落在哪）。
    pub fn pending_by_id(&self, request_id: &str) -> Option<(PendingAuth, String)> {
        self.pending
            .lock()
            .unwrap()
            .get(request_id)
            .map(|e| (e.req.clone(), e.conn_id.clone()))
    }

    /// 冷启动补漏：当前所有待决请求。
    pub fn pending_list(&self) -> Vec<PendingAuth> {
        let mut out: Vec<PendingAuth> = self
            .pending
            .lock()
            .unwrap()
            .values()
            .map(|e| e.req.clone())
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    pub fn pending_len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// 裁决一条待决请求并唤醒对应连接任务。
    pub fn resolve(&self, request_id: &str, decision: AuthDecision) -> Result<()> {
        let entry = self.pending.lock().unwrap().remove(request_id);
        match entry {
            Some(mut e) => {
                if let Some(tx) = e.tx.take() {
                    let _ = tx.send(decision);
                }
                Ok(())
            }
            None => Err(ReinError::coded(
                "bad_request",
                "该授权请求不存在或已被处理",
            )),
        }
    }

    /// 该待决请求所属的连接 id（用来登记会话授权）。
    pub fn pending_conn(&self, request_id: &str) -> Option<String> {
        self.pending
            .lock()
            .unwrap()
            .get(request_id)
            .map(|e| e.conn_id.clone())
    }

    // ---------- 控制面推送（§14.5） ----------

    /// 订阅控制面推送流（连接任务在鉴权成功后调用）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<ServerEvent> {
        self.events.subscribe()
    }

    /// 发布一条控制面推送。无订阅者时静默丢弃（网关没开、外部没人连时照常无碍）。
    pub fn publish_event(&self, ev: ServerEvent) {
        let _ = self.events.send(ev);
    }

    // ---------- 服务生命周期 ----------

    pub fn is_running(&self) -> bool {
        self.server.lock().unwrap().shutdown.is_some()
    }

    pub fn set_server(&self, shutdown: watch::Sender<bool>, port: u16) {
        let mut guard = self.server.lock().unwrap();
        guard.shutdown = Some(shutdown);
        guard.port = Some(port);
    }

    /// 取出关停信号并标记停止（返回 None 表示本就没在跑）。
    pub fn take_shutdown(&self) -> Option<watch::Sender<bool>> {
        let mut guard = self.server.lock().unwrap();
        guard.port = None;
        guard.shutdown.take()
    }

    pub fn port(&self) -> Option<u16> {
        self.server.lock().unwrap().port
    }

    // ---------- 限流 ----------

    /// 每 client_id 每分钟最多 [`TOKEN_RATE_PER_MIN`] 次。返回 false = 超限（回 `busy`）。
    pub fn rate_check(&self, key: &str) -> bool {
        let mut map = self.rate.lock().unwrap();
        let now = Instant::now();
        let hits = map.entry(key.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < RATE_WINDOW);
        if hits.len() >= TOKEN_RATE_PER_MIN {
            return false;
        }
        hits.push(now);
        true
    }

    // ---------- 未鉴权失败限频 / 封 IP ----------

    /// 该来源 IP 当前是否处于封禁期（未鉴权失败过多）。过期即顺手清掉。
    pub fn is_ip_banned(&self, ip: &str) -> bool {
        let mut bans = self.bans.lock().unwrap();
        match bans.get(ip) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                bans.remove(ip);
                false
            }
            None => false,
        }
    }

    /// 记一次未鉴权失败（握手被拒 / 首帧非法 / 令牌无效）。窗口内超限即封禁该 IP。
    pub fn note_auth_failure(&self, ip: &str) {
        let now = Instant::now();
        let mut map = self.auth_fail.lock().unwrap();
        let hits = map.entry(ip.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < AUTH_FAIL_WINDOW);
        hits.push(now);
        if hits.len() >= AUTH_FAIL_PER_MIN {
            hits.clear();
            drop(map);
            self.bans.lock().unwrap().insert(ip.to_string(), now + AUTH_BAN);
        }
    }

    /// 该来源 IP 现在还能不能再弹一次授权窗（按 IP 限频，防轮换 clientId 刷弹窗）。
    /// 返回 true 并记一次；false = 本窗口内弹窗已过密，调用方应静默挂起。
    pub fn prompt_allowed(&self, ip: &str) -> bool {
        let now = Instant::now();
        let mut map = self.prompt_ip.lock().unwrap();
        let hits = map.entry(ip.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < PROMPT_WINDOW_IP);
        if hits.len() >= PROMPT_PER_MIN_IP {
            return false;
        }
        hits.push(now);
        true
    }
}

impl Default for GatewayHub {
    fn default() -> Self {
        Self::new()
    }
}

/// 逐次调用的 scope 强制点（contract §5.3）。
///
/// **每个入站调用在进入业务逻辑之前**都要过这里：
/// - 「本次会话」读内存 scopes；连接断开后会话表里已无此 conn（`end_conn`），自然不放行；
/// - 「始终允许」**每次回 DB** 读当前行 —— 撤销 / 收窄立刻生效，绝不缓存。
pub fn require(conn: &Connection, hub: &GatewayHub, conn_id: &str, need: Scope) -> Result<()> {
    let grant = hub
        .session(conn_id)
        .ok_or_else(|| ReinError::coded("unauthorized", "连接未获授权或授权已失效"))?;
    match grant.kind {
        GrantKind::Session => {
            if grant.scopes.contains(need) {
                Ok(())
            } else {
                Err(forbidden(need))
            }
        }
        GrantKind::Always => match store::find_client(conn, &grant.client_id)? {
            Some(row) if row.is_authorized() => {
                if row.scopes.contains(need) {
                    Ok(())
                } else {
                    Err(forbidden(need))
                }
            }
            _ => Err(ReinError::coded("unauthorized", "授权已被撤销")),
        },
    }
}

fn forbidden(need: Scope) -> ReinError {
    ReinError::coded("forbidden_scope", format!("缺少权限：{}", need.as_str()))
}

/// 忽略限频判据的透传（`server.rs` 决定要不要弹窗时用）。
pub fn prompt_gate(conn: &Connection, client_id: &str) -> Result<PromptGate> {
    store::prompt_gate(conn, client_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::gateway::models::ClientDecision;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    fn hello_pending(hub: &GatewayHub, conn_id: &str, client_id: &str) -> oneshot::Receiver<AuthDecision> {
        hub.begin_pending(
            conn_id,
            PendingAuth {
                request_id: uuid::Uuid::new_v4().to_string(),
                client_id: client_id.into(),
                client_name: "小组件".into(),
                origin: None,
                ip: None,
                scopes: ScopeSet::minimal_default(),
                created_at: store::now_iso(),
                timeout_ms: AUTH_PENDING_TIMEOUT_MS,
            },
        )
    }

    #[test]
    fn session_grant_dies_with_the_connection() {
        let hub = GatewayHub::new();
        hub.grant(
            "conn-1",
            ConnGrant {
                client_id: "c-1".into(),
                name: "小组件".into(),
                scopes: ScopeSet::minimal_default(),
                kind: GrantKind::Session,
            },
        );
        assert_eq!(hub.session_client("conn-1").as_deref(), Some("c-1"));
        hub.end_conn("conn-1");
        assert!(hub.session("conn-1").is_none(), "连接结束即清除会话授权");
    }

    /// 授权的决策窗口按契约定稿为 60 秒（contract §16 规则 2），且以后端计时为准。
    #[test]
    fn auth_pending_timeout_is_sixty_seconds() {
        assert_eq!(AUTH_PENDING_TIMEOUT_MS, 60_000);
    }

    /// 会话 scope 供变更推送过滤：随授权走、随连接消亡。
    #[test]
    fn session_scopes_follow_the_grant_and_die_with_the_connection() {
        let hub = GatewayHub::new();
        assert!(hub.session_scopes("conn-nope").is_empty(), "未登记连接没有 scope");
        let scopes: ScopeSet = [Scope::ScheduleRead, Scope::WorkoutRead].into_iter().collect();
        hub.grant(
            "conn-1",
            ConnGrant {
                client_id: "c-1".into(),
                name: "小组件".into(),
                scopes: scopes.clone(),
                kind: GrantKind::Session,
            },
        );
        let got = hub.session_scopes("conn-1");
        assert!(got.contains(Scope::ScheduleRead) && got.contains(Scope::WorkoutRead));
        assert!(!got.contains(Scope::PomodoroRead));
        hub.end_conn("conn-1");
        assert!(hub.session_scopes("conn-1").is_empty(), "断链即不再推任何域");
    }

    /// 超时 / 忽略都走 `note_auth_failure`：打满窗口即封该来源 IP（contract §16.6）。
    #[test]
    fn auth_failures_ban_the_source_ip() {
        let hub = GatewayHub::new();
        for _ in 0..(AUTH_FAIL_PER_MIN - 1) {
            hub.note_auth_failure("10.0.0.7");
            assert!(!hub.is_ip_banned("10.0.0.7"), "未打满窗口不该封");
        }
        hub.note_auth_failure("10.0.0.7");
        assert!(hub.is_ip_banned("10.0.0.7"), "第 5 次失败即封禁");
        assert!(!hub.is_ip_banned("10.0.0.8"), "只封来源 IP，不牵连别的地址");
    }

    #[test]
    fn require_rechecks_the_db_for_always_grants() {
        let conn = db();
        let hub = GatewayHub::new();
        let token = store::generate_token();
        store::upsert_allow(
            &conn,
            "c-always",
            "外部 UI",
            &ScopeSet::minimal_default(),
            &store::hash_token(&token),
            None,
        )
        .unwrap();
        hub.grant(
            "conn-1",
            ConnGrant {
                client_id: "c-always".into(),
                name: "外部 UI".into(),
                scopes: ScopeSet::minimal_default(),
                kind: GrantKind::Always,
            },
        );
        assert!(require(&conn, &hub, "conn-1", Scope::ScheduleRead).is_ok());
        // 没授写权限
        assert_eq!(
            require(&conn, &hub, "conn-1", Scope::ScheduleWrite)
                .unwrap_err()
                .code(),
            "forbidden_scope"
        );
        // 撤销后逐次校验立刻拒绝（不缓存）
        store::revoke_client(&conn, "c-always").unwrap();
        assert_eq!(
            require(&conn, &hub, "conn-1", Scope::ScheduleRead)
                .unwrap_err()
                .code(),
            "unauthorized"
        );
    }

    #[test]
    fn require_rejects_scope_prefix_not_present() {
        let conn = db();
        let hub = GatewayHub::new();
        hub.grant(
            "conn-1",
            ConnGrant {
                client_id: "c-1".into(),
                name: "小组件".into(),
                scopes: ScopeSet::minimal_default(), // 仅 schedule.read
                kind: GrantKind::Session,
            },
        );
        // 精确匹配：有 schedule.read，不等于有 schedule.write / schedule.create
        assert!(require(&conn, &hub, "conn-1", Scope::ScheduleRead).is_ok());
        assert_eq!(
            require(&conn, &hub, "conn-1", Scope::ScheduleCreate)
                .unwrap_err()
                .code(),
            "forbidden_scope"
        );
        // 未登记的连接 = 未授权
        assert_eq!(
            require(&conn, &hub, "conn-nope", Scope::ScheduleRead)
                .unwrap_err()
                .code(),
            "unauthorized"
        );
    }

    #[test]
    fn pending_resolve_wakes_waiter_and_ignore_keeps_pending() {
        let hub = GatewayHub::new();
        let rx = hello_pending(&hub, "conn-1", "c-1");
        assert_eq!(hub.pending_len(), 1);
        let (req, conn) = hub
            .pending_by_id(&hub.pending_list()[0].request_id)
            .unwrap();
        assert_eq!(conn, "conn-1");
        hub.resolve(
            &req.request_id,
            AuthDecision::Granted {
                kind: GrantKind::Session,
                token: None,
                scopes: ScopeSet::minimal_default(),
            },
        )
        .unwrap();
        assert!(rx.blocking_recv().is_ok());
        assert_eq!(hub.pending_len(), 0);
        // 再裁决同一条 → 不存在
        assert!(hub.resolve(&req.request_id, AuthDecision::Ignored).is_err());
    }

    #[test]
    fn ignore_records_rate_limit_without_deciding() {
        let conn = db();
        // 首次应弹窗
        assert_eq!(prompt_gate(&conn, "c-ign").unwrap(), PromptGate::Show);
        store::record_ignore(&conn, "c-ign", "小组件", None).unwrap();
        // 30s 静默窗口内不再弹窗（限频防骚扰）
        assert_eq!(prompt_gate(&conn, "c-ign").unwrap(), PromptGate::Suppress);
        let row = store::find_client(&conn, "c-ign").unwrap().unwrap();
        assert_eq!(row.decision, ClientDecision::Ignore, "忽略不落 allow/deny 决策");
        assert!(row.scopes.is_empty(), "忽略不授予权限");
    }

    #[test]
    fn end_conn_drops_only_its_own_pending() {
        let hub = GatewayHub::new();
        let _r1 = hello_pending(&hub, "conn-1", "c-1");
        let _r2 = hello_pending(&hub, "conn-2", "c-2");
        assert_eq!(hub.pending_len(), 2);
        hub.end_conn("conn-1");
        assert_eq!(hub.pending_len(), 1, "只清掉该连接的待决");
        let rid = hub.pending_list()[0].request_id.clone();
        assert_eq!(hub.pending_conn(&rid).as_deref(), Some("conn-2"));
    }

    #[test]
    fn rate_check_limits_per_key() {
        let hub = GatewayHub::new();
        assert!(hub.rate_check("c-1"));
        assert!(hub.rate_check("c-1"));
        assert!(hub.rate_check("c-2"), "不同 key 互不影响");
        // 打满窗口
        for _ in 0..(TOKEN_RATE_PER_MIN - 2) {
            assert!(hub.rate_check("c-1"));
        }
        assert!(!hub.rate_check("c-1"), "超限应返回 false");
    }
}
