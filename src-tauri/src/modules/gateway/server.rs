//! 对外网关的 WebSocket 服务端：监听、握手闸门、首帧令牌、四态授权流程、
//! 请求分派、以及把同步变更推给已连接的客户端。
//!
//! 用仓库既有依赖 `tokio` + `tokio-tungstenite`（`Cargo.toml`），不引入 axum/hyper。
//! 六条闸门按 contract §4.1/§7：
//!
//! 1. **绑定**：`local` 绑 `127.0.0.1` 与 `::1`；`lan` 只绑 `0.0.0.0`。默认端口 17650，
//!    被占则 17650..17659 顺延，全占退系统分配；**实际**端口写回设置（由 `commands.rs` 做）。
//! 2. **Origin**：缺失或为空 → 放行（原生客户端）；非空必须**精确命中**用户批准过的白名单
//!    （`app_meta` 键 `gateway.allowedOrigins`），否则 403 并留审计（contract §15）。
//!    放行某个 Origin **不放松任何鉴权**：首帧令牌 / 四态授权 / 逐次 scope 全部照旧。
//! 3. **Host**：非空时必须指向本机（socket 的 `local_addr` / 回环 IP / `localhost` / 本机主机名；
//!    挡 DNS rebinding —— tungstenite 自己不校验 Host）。`local_addr()` 拿不到时该闸门**跳过**
//!    （无法判定，不因此拒连；contract §17.5）。
//! 4. **首帧令牌**：握手成功后 5 秒内必须发首帧，否则 1008。
//! 5. **逐次 scope**：每个请求进业务逻辑前过 `auth::require`。
//! 6. **参数收紧**：单帧/单消息 256KiB、控制面请求 64KiB、未鉴权并发 ≤ 8。
//!
//! 会话/授权状态、scope 判据、待决队列全在 `auth.rs`；这里只做 IO 与编排。

use std::borrow::Cow;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::{HOST, ORIGIN};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::error::{ReinError, Result};
use crate::modules::gateway::auth::{
    self, AuthDecision, ConnGrant, GatewayHub, GrantKind, PendingAuth, ServerEvent,
    AUTH_PENDING_TIMEOUT_MS, EVENT_AUTH_REQUIRED,
};
use crate::modules::gateway::models::{
    AuditDecision, AuditRecord, BindMode, ClientDecision, PromptGate, Scope, ScopeSet,
};
use crate::modules::gateway::protocol::{
    events, ClientHello, ErrorCode, EventEnvelope, Method, RequestEnvelope, ResponseEnvelope,
    PROTOCOL_VERSION,
};
use crate::modules::gateway::{methods, store};
use crate::state::AppState;

/// 契约默认端口（contract §4.1）。
pub const DEFAULT_PORT: u16 = 17650;
/// 端口占用时的顺延次数（17650..17659）。
const PORT_TRIES: u16 = 10;
/// 单帧 / 单消息上限。
const MAX_FRAME: usize = 256 * 1024;
/// 控制面单请求上限（超过即 `payload_too_large`）。
const MAX_CONTROL: usize = 64 * 1024;
/// 未鉴权并发上限。
const MAX_UNAUTH_CONN: usize = 8;
/// 已鉴权并发上限（contract §4.1）。
const MAX_AUTHED_CONN: usize = 4;
/// 首帧（令牌）等待上限。
const HELLO_TIMEOUT_SECS: u64 = 5;
/// 首帧展示字段（`clientId` / `clientName`）的字符上限：首帧不经控制面 64KiB 检查，
/// 超长串会被带进待决弹窗与 `ext_clients`（contract §17.5）。
const MAX_HELLO_FIELD: usize = 256;
/// 每连接下行队列容量（满即断）。
const OUT_CAP: usize = 64;
/// 服务端 ping 间隔（contract §4.1）。
const PING_INTERVAL_SECS: u64 = 30;
/// 连续多少次 ping 没等到 pong 判半开并关闭（contract §4.1「两次无 pong」）。
const MAX_MISSED_PONGS: u32 = 2;
/// 外部查询时间预算（毫秒）：同一把 DB 锁内跑，超预算中断并回 `timeout`（contract §6.4）。
const QUERY_BUDGET_MS: u64 = 2000;
/// `progress_handler` 的检查粒度（约每多少条 VM 指令回调一次）。
const PROGRESS_OPS: i32 = 10_000;

/// WS→外部客户端的变更推送事件名。
///
/// **注意**：契约 §4.5 只冻结了三条 auth 事件，没有约定变更推送的事件名（也没有 `subscribe`
/// 方法）。此处把每条**已授权**连接视为已订阅，统一用 `gateway.change` 推送
/// [`crate::modules::gateway::models::ChangeEvent`] —— 这是本层补齐的约定，非契约原文。
pub const EVENT_CHANGE: &str = "gateway.change";

/// 运行态变更推送的事件名（contract §14.5）：载荷 `{ kind:"focus", data:FocusRuntime|null, at:int }`，
/// 只发**已鉴权且含 `pomodoro.read`** 的连接。
pub const EVENT_RUNTIME: &str = "gateway.runtime";
/// 服务端事件推送的事件名（contract §14.5）：端口变化 `{ event:"port-changed", port }`。
pub const EVENT_SERVER: &str = "gateway.server";

/// `ChangeEvent.kind`（= 同步登记项 `TableSpec.name`，见 `sync/tables.rs`）→ 该域所需的读 scope。
///
/// 网关只对外暴露三个域（日程/待办、运动、番茄钟，contract §1.1）。不在其列的业务表
/// （饮食 / 知识库 / 记账…）**谁也不推** —— 它们不在 scope 模型里，外部客户端拿不到看它们的权利；
/// 于是只授 `schedule.read` 的连接收不到任何无关表的变更元数据（contract §14.5 / §17.5）。
fn change_scope(kind: &str) -> Option<Scope> {
    match kind {
        "todos" => Some(Scope::ScheduleRead),
        "workouts" | "workout_plans" | "workout_sessions" => Some(Scope::WorkoutRead),
        "pomodoro_sessions" => Some(Scope::PomodoroRead),
        _ => None,
    }
}

/// 启动服务：同步完成端口绑定（好把实际端口立刻回给调用方），再交给 tokio 任务 accept。
/// 返回**实际**监听端口。
pub fn start(app: AppHandle, hub: Arc<GatewayHub>, bind: BindMode, port: Option<u16>) -> Result<u16> {
    let (listeners, actual) = bind_listeners(bind, port)?;
    let (tx, _rx) = watch::channel(false);
    // 并发槽用 Semaphore 在 accept 前**强占**（不是事后计数检查，避免竞态）：
    // 两个 listener 共享同一对信号量，Local 双绑不翻倍。
    let unauth = Arc::new(Semaphore::new(MAX_UNAUTH_CONN));
    let authed = Arc::new(Semaphore::new(MAX_AUTHED_CONN));
    for listener in listeners {
        let app = app.clone();
        let hub = Arc::clone(&hub);
        let mut shutdown = tx.subscribe();
        let unauth = Arc::clone(&unauth);
        let authed = Arc::clone(&authed);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = accept_loop(app, hub, listener, unauth, authed, &mut shutdown).await {
                eprintln!("网关监听循环退出：{e}");
            }
        });
    }
    hub.set_server(tx);
    Ok(actual)
}

/// 停止服务（幂等）。已建立的连接不主动断开（它们各自持有自己的 socket）。
pub fn stop(hub: &GatewayHub) {
    if let Some(tx) = hub.take_shutdown() {
        let _ = tx.send(true);
    }
}

// ---------------------------------------------------------------- 绑定

fn bind_addrs(bind: BindMode) -> Vec<SocketAddr> {
    match bind {
        // Windows 上 `localhost` 常先解析到 `::1`，两条回环都要绑。
        BindMode::Local => vec![
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, 0)),
        ],
        BindMode::Lan => vec![SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))],
    }
}

fn try_bind(addr: SocketAddr) -> std::io::Result<std::net::TcpListener> {
    let l = std::net::TcpListener::bind(addr)?;
    l.set_nonblocking(true)?;
    Ok(l)
}

/// 绑一组同端口地址：先按 17650..17659 顺延，全占则让系统分配。
/// `local` 模式下 `::1` 绑不上不算失败（该机器没有 IPv6 回环）。
fn bind_listeners(bind: BindMode, port: Option<u16>) -> Result<(Vec<std::net::TcpListener>, u16)> {
    let preferred = port.unwrap_or(DEFAULT_PORT);
    let addrs = bind_addrs(bind);
    let mut last_err: Option<std::io::Error> = None;

    for off in 0..PORT_TRIES {
        let p = preferred.saturating_add(off);
        if p == 0 {
            break;
        }
        match bind_group(&addrs, p) {
            Ok(found) => return Ok(found),
            Err(e) => last_err = Some(e),
        }
    }
    // 全占：系统分配（v4 先拿下端口，v6 复用同一个；拿不到就只要 v4）
    match bind_group(&addrs, 0) {
        Ok(found) => Ok(found),
        Err(e) => Err(ReinError::Message(format!(
            "网关端口绑定失败（{}）：{}",
            bind.as_str(),
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| e.to_string())
        ))),
    }
}

/// 在给定端口上把 `addrs` 全绑上；端口 0 时以第一个成功绑定的实际端口为准。
fn bind_group(
    addrs: &[SocketAddr],
    port: u16,
) -> std::io::Result<(Vec<std::net::TcpListener>, u16)> {
    let mut listeners = Vec::with_capacity(addrs.len());
    let mut actual = port;
    for (i, base) in addrs.iter().enumerate() {
        let addr = SocketAddr::new(base.ip(), if i == 0 { port } else { actual });
        match try_bind(addr) {
            Ok(l) => {
                if i == 0 {
                    actual = l.local_addr()?.port();
                }
                listeners.push(l);
            }
            Err(e) => {
                // 只有第一个地址是硬性要求；后面的（::1 / 系统分配）绑不上就跳过。
                if i == 0 {
                    return Err(e);
                }
            }
        }
    }
    Ok((listeners, actual))
}

// ---------------------------------------------------------------- accept

async fn accept_loop(
    app: AppHandle,
    hub: Arc<GatewayHub>,
    listener: std::net::TcpListener,
    unauth: Arc<Semaphore>,
    authed: Arc<Semaphore>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<()> {
    let listener = TcpListener::from_std(listener)?;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("网关 accept 失败：{e}");
                        continue;
                    }
                };
                // 未鉴权失败过多的来源 IP 在封禁期内直接丢弃（contract §4.1/§7）。
                if hub.is_ip_banned(&peer.ip().to_string()) {
                    drop(stream);
                    continue;
                }
                // 未鉴权并发上限：在 accept 前**强占**一个槽位（Semaphore），
                // 满则直接丢弃 —— 不给它建立会话的机会，也不存在「检查后计数」的竞态。
                let permit = match Arc::clone(&unauth).try_acquire_owned() {
                    Ok(p) => p,
                    Err(_) => {
                        drop(stream);
                        continue;
                    }
                };
                // 拿不到本机地址时 Host 闸门无法判定 → 按契约**跳过**那道闸门（contract §17.5），
                // 连接照常进握手，不因此拒连。
                let local = stream.local_addr().ok();
                let app = app.clone();
                let hub = Arc::clone(&hub);
                let authed = Arc::clone(&authed);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) =
                        handle_connection(app, hub, stream, peer, local, permit, authed).await
                    {
                        eprintln!("网关连接结束：{e}");
                    }
                });
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- 握手

fn ws_config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_FRAME),
        max_frame_size: Some(MAX_FRAME),
        max_write_buffer_size: MAX_FRAME,
        write_buffer_size: 16 * 1024,
        ..Default::default()
    }
}

fn reject(msg: impl Into<String>) -> ErrorResponse {
    let mut resp = ErrorResponse::new(Some(msg.into()));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp
}

/// Origin 闸门（contract §15.1）：头缺失或为空 → 放行（原生客户端，行为不变）；
/// 非空 → 必须**精确命中**白名单（精确字符串相等、大小写敏感，不做通配 / 子域 / 前缀匹配）。
/// 拒绝原因带上原串 —— 它会落进 `ext_audit.detail`，设置页据此列出「被拦下的来源」（§15.2b）。
fn gate_origin(origin: Option<&str>, allowed: &[String]) -> std::result::Result<(), String> {
    let Some(o) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    if allowed.iter().any(|a| a == o) {
        return Ok(());
    }
    Err(format!("{}{o}", store::ORIGIN_BLOCKED_PREFIX))
}

/// 本机主机名的比较用别名（小写）。Windows 取 `COMPUTERNAME`，其余取 `HOSTNAME`，
/// 都拿不到时退回 `hostname` 命令；结果缓存一次（主机名在进程生命周期内不变）。
/// 契约 §17.5：LAN 模式下客户端用主机名连（`DESKTOP-X:17650`）不该被 Host 闸门 403。
fn local_host_names() -> &'static [String] {
    static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let mut out = vec!["localhost".to_string()];
        for key in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(v) = std::env::var(key) {
                push_host_name(&mut out, &v);
            }
        }
        // 非 Windows 上两个环境变量都可能没有（如 systemd 服务）：问一次 `hostname`。
        if out.len() == 1 && !cfg!(windows) {
            if let Ok(o) = std::process::Command::new("hostname").output() {
                if o.status.success() {
                    push_host_name(&mut out, &String::from_utf8_lossy(&o.stdout));
                }
            }
        }
        out
    })
}

fn push_host_name(out: &mut Vec<String>, raw: &str) {
    let v = raw.trim().to_lowercase();
    if !v.is_empty() && !out.contains(&v) {
        out.push(v);
    }
}

/// Host 闸门：必须指向本机（挡 DNS rebinding；tungstenite 自己不校验 Host）。
///
/// 放行「本机地址」集合：实际 socket 的 `local_addr`（IP 字面量，含 IPv6 方括号写法）、
/// 回环 IP + `localhost` 别名、以及**本机主机名**（contract §17.5 的 LAN 主机名连接）；
/// 带端口的写法端口必须与实际监听端口一致。`local` 为 `None`（`local_addr()` 失败）时
/// **跳过**该闸门 —— 无法判定就不判，别把正常连接按拒处理。
fn gate_host(host: Option<&str>, local: Option<SocketAddr>) -> std::result::Result<(), String> {
    let Some(local) = local else {
        return Ok(());
    };
    let Some(h) = host.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err("缺少 Host 头".into());
    };
    let port = local.port();
    let ip = local.ip().to_string();
    // IP 字面量：裸写与带端口；IPv6 在 Host 头里是方括号写法。
    let ip_forms = [
        ip.clone(),
        format!("{ip}:{port}"),
        format!("[{ip}]"),
        format!("[{ip}]:{port}"),
    ];
    // 主机名别名（大小写不敏感，DNS 名本来就大小写无关）；回环字面量的别名也在此列。
    let lower = h.to_lowercase();
    let name_ok = ["127.0.0.1", "::1", "[::1]"]
        .iter()
        .copied()
        .chain(local_host_names().iter().map(|s| s.as_str()))
        .any(|a| {
            let a = a.to_lowercase();
            lower == a || lower == format!("{a}:{port}")
        });
    if ip_forms.iter().any(|f| f == h) || name_ok {
        Ok(())
    } else {
        Err("Host 与本机地址不符".into())
    }
}

/// 握手期从请求头取到的东西：给待决弹窗看的 Origin，以及被拒时留审计的原因。
/// 由回调写入、由连接任务读回（`accept_hdr_async` 的回调闭包吃掉 `Request`，只能这样带出来）。
#[derive(Debug, Default)]
struct HandshakeMeta {
    /// 该连接请求头里的 `Origin`（缺失 / 空白 → `None`）。**客户端无法自报**：取自握手请求。
    origin: Option<String>,
    /// 被拒时的原因（含被拒的 Origin 原串，供审计）。
    reject: Option<String>,
}

/// `tungstenite::handshake::server::Callback` 的回调返回类型 `{Response, ErrorResponse}` 由库固定，
/// `ErrorResponse`（`HttpResponse<Option<String>>`）偏大 —— 不是我们可选的设计，故局部放行。
#[allow(clippy::result_large_err)]
async fn handshake(
    stream: TcpStream,
    local: Option<SocketAddr>,
    allowed_origins: Vec<String>,
    meta: Arc<Mutex<HandshakeMeta>>,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>> {
    let cfg = ws_config();
    tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        move |req: &Request, resp: Response| {
            let origin = req
                .headers()
                .get(ORIGIN)
                .and_then(|o| o.to_str().ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Ok(mut m) = meta.lock() {
                m.origin = origin.clone();
            }
            if let Err(m) = gate_origin(origin.as_deref(), &allowed_origins) {
                record_reject(&meta, &m);
                return Err(reject(m));
            }
            let host = req.headers().get(HOST).and_then(|h| h.to_str().ok());
            if let Err(m) = gate_host(host, local) {
                record_reject(&meta, &m);
                return Err(reject(m));
            }
            Ok(resp)
        },
        Some(cfg),
    )
    .await
    .map_err(|e| ReinError::Message(format!("WebSocket 握手失败：{e}")))
}

/// 把拒绝原因留在 [`HandshakeMeta`] 上，供连接任务写审计（事件回调没有别的出口）。
fn record_reject(meta: &Arc<Mutex<HandshakeMeta>>, reason: &str) {
    if let Ok(mut m) = meta.lock() {
        m.reject = Some(reason.to_string());
    }
}

// ---------------------------------------------------------------- 连接主体

/// 连接级的并发记账（基于 Semaphore 的**已占槽位**，不是事后计数）：
/// accept 前先占「未鉴权」槽；鉴权成功那一刻换成「已鉴权」槽。
/// permit 落 `Drop` 自动归还 —— 无论从哪条 `return` 退出都不会漏。
struct ConnGuard {
    unauth: Option<OwnedSemaphorePermit>,
    authed: Arc<Semaphore>,
    authed_permit: Option<OwnedSemaphorePermit>,
}

impl ConnGuard {
    fn new(unauth: OwnedSemaphorePermit, authed: Arc<Semaphore>) -> Self {
        ConnGuard {
            unauth: Some(unauth),
            authed,
            authed_permit: None,
        }
    }

    /// 鉴权成功：释放未鉴权槽、占一个已鉴权槽。返回 `false` = 已鉴权并发已满，
    /// 调用方应回 `busy` 并关闭（未鉴权槽由 `Drop` 归还）。
    fn mark_authed(&mut self) -> bool {
        match Arc::clone(&self.authed).try_acquire_owned() {
            Ok(p) => {
                self.authed_permit = Some(p);
                self.unauth = None; // 释放未鉴权槽
                true
            }
            Err(_) => false,
        }
    }
}

/// `R` 泛型只为单元测试：测试用 `tauri::test::MockRuntime` 起 AppHandle，
/// 否则要真起一个 Wry 事件循环才能拿到 `AppHandle`。生产路径照旧是默认运行时。
async fn handle_connection<R: Runtime>(
    app: AppHandle<R>,
    hub: Arc<GatewayHub>,
    stream: TcpStream,
    peer: SocketAddr,
    local: Option<SocketAddr>,
    unauth_permit: OwnedSemaphorePermit,
    authed: Arc<Semaphore>,
) -> Result<()> {
    let mut slot = ConnGuard::new(unauth_permit, authed);
    let ip = peer.ip().to_string();
    let conn_id = hub.next_conn_id();
    // Origin 白名单在握手前读一次（短锁）：回调里不能再取锁（std Mutex 非重入）。
    let allowed_origins = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        store::get_allowed_origins(&conn)
    };
    let meta = Arc::new(Mutex::new(HandshakeMeta::default()));
    let ws = match handshake(stream, local, allowed_origins, Arc::clone(&meta)).await {
        Ok(ws) => ws,
        Err(e) => {
            // Origin/Host 被拒等握手失败：记未鉴权失败并留一条审计（限频封 IP + 追责）。
            // 详情由回调写在 meta 上（含被拒的 Origin 原串，设置页据此列「被拦下的来源」）。
            let detail = meta
                .lock()
                .ok()
                .and_then(|m| m.reject.clone())
                .unwrap_or_else(|| "握手被拒（Origin/Host）".to_string());
            note_failure(&app, &hub, &ip, &detail);
            return Err(e);
        }
    };
    // 握手请求头里的 Origin（缺失 → None）：授权弹窗上「谁在请求」的可核验信息。
    let origin = meta.lock().ok().and_then(|m| m.origin.clone());

    let (mut write, mut read) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUT_CAP);
    // 写侧独占一个任务：读侧 `select!` 里就不会同时出现「借 ws 读」与「借 ws 写」。
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    let _grant = match authorize(&app, &hub, &out_tx, &mut read, &conn_id, &ip, origin).await {
        Ok(Some(g)) => g,
        Ok(None) => {
            drop(out_tx);
            drain_writer(writer).await;
            hub.end_conn(&conn_id);
            return Ok(());
        }
        Err(e) => {
            drop(out_tx);
            drain_writer(writer).await;
            hub.end_conn(&conn_id);
            return Err(e);
        }
    };

    // 鉴权成功 → 转入「已鉴权」槽；满则回 busy 并关闭。
    if !slot.mark_authed() {
        let _ = send_response(&out_tx, "", ErrorCode::Busy, "已鉴权并发超限").await;
        close_ws(&out_tx, 1008, "busy").await;
        drop(out_tx);
        drain_writer(writer).await;
        hub.end_conn(&conn_id);
        return Ok(());
    }

    // 已授权：订阅变更流，进入请求/推送循环
    let mut feed_rx = hub.feed.subscribe();
    // 控制面推送（运行态 / 端口变化，contract §14.5）：与业务变更流分开，单独订阅。
    let mut events_rx = hub.subscribe_events();
    // 存活探测：每 30s 一次 ping，连续两次没等到 pong 判半开并关闭（contract §4.1）。
    let mut ping = tokio::time::interval(Duration::from_secs(PING_INTERVAL_SECS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // 消费 interval 的立即首拍
    let mut missed_pongs: u32 = 0;
    loop {
        tokio::select! {
            _ = ping.tick() => {
                missed_pongs += 1;
                if missed_pongs >= MAX_MISSED_PONGS {
                    close_ws(&out_tx, 1008, "ping 超时（半开）").await;
                    break;
                }
                if !try_send(&out_tx, Message::Ping(Vec::new())) {
                    break;
                }
            }
            incoming = read.next() => {
                match incoming {
                    None => break,
                    Some(Err(_)) => {
                        // 多半是超帧上限（payload 过大）：以 1009 收尾
                        close_ws(&out_tx, 1009, "消息过大").await;
                        break;
                    }
                    Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Text(text))) => {
                        let (payload, close) = handle_request(&app, &hub, &conn_id, &ip, &text);
                        // 「满即断」：下行队列积满（客户端只连不读）就断，绝不背压挂死。
                        if !try_send(&out_tx, Message::Text(payload)) {
                            break;
                        }
                        if let Some(code) = close {
                            close_ws(&out_tx, code, "请求被拒").await;
                            break;
                        }
                    }
                    // 客户端 ping：回 pong（split 后不会自动回，得手动）。
                    Some(Ok(Message::Ping(p))) => {
                        if !try_send(&out_tx, Message::Pong(p)) {
                            break;
                        }
                    }
                    // 收到 pong：本轮存活确认。
                    Some(Ok(Message::Pong(_))) => {
                        missed_pongs = 0;
                    }
                    // 二进制帧等：本地接口不消费，忽略
                    Some(Ok(_)) => {}
                }
            }
            ev = feed_rx.recv() => {
                match ev {
                    Ok(change) => {
                        // 按连接的 scope 过滤（contract §14.5 / §17.2）：只推该连接有读权限的域。
                        // 只有 schedule.read 的连接因此收不到 workout / pomodoro 的变更元数据。
                        let scopes = hub.session_scopes(&conn_id);
                        let Some(need) = change_scope(&change.kind) else {
                            continue;
                        };
                        if !scopes.contains(need) {
                            continue;
                        }
                        let data = serde_json::to_value(change).unwrap_or(Value::Null);
                        if !send_event(&out_tx, EVENT_CHANGE, data).await {
                            break;
                        }
                    }
                    // 订阅者追不上：契约要求全量重查（这里无法代替客户端做，忽略该批）
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
            ev = events_rx.recv() => {
                match ev {
                    Ok(ServerEvent::Focus { data, at }) => {
                        // 运行态只推给含 `pomodoro.read` 的连接（contract §14.5）。
                        if !hub.session_scopes(&conn_id).contains(Scope::PomodoroRead) {
                            continue;
                        }
                        let payload = json!({ "kind": "focus", "data": data, "at": at });
                        if !send_event(&out_tx, EVENT_RUNTIME, payload).await {
                            break;
                        }
                    }
                    Ok(ServerEvent::PortChanged { port }) => {
                        // 端口变化通知所有已鉴权连接改连（不需要 scope）。
                        let payload = json!({ "event": "port-changed", "port": port });
                        if !send_event(&out_tx, EVENT_SERVER, payload).await {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
        }
    }
    drop(out_tx);
    drain_writer(writer).await;
    hub.end_conn(&conn_id);
    Ok(())
}

/// 首帧令牌 → 四态授权。成功返回 `Some(grant)`；被拒 / 超时返回 `None`（连接已收尾）。
async fn authorize<R: Runtime>(
    app: &AppHandle<R>,
    hub: &GatewayHub,
    out_tx: &mpsc::Sender<Message>,
    read: &mut SplitStream<WebSocketStream<TcpStream>>,
    conn_id: &str,
    ip: &str,
    origin: Option<String>,
) -> Result<Option<ConnGrant>> {
    let first = tokio::time::timeout(Duration::from_secs(HELLO_TIMEOUT_SECS), read.next()).await;
    let text = match first {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => {
            note_failure(app, hub, ip, "首帧缺失或超时");
            close_ws(out_tx, 1008, "首帧缺失或超时").await;
            return Ok(None);
        }
    };
    let hello: ClientHello = match serde_json::from_str(&text) {
        Ok(h) => h,
        Err(_) => {
            note_failure(app, hub, ip, "首帧格式错误");
            let _ = send_response(out_tx, "", ErrorCode::Unauthorized, "首帧格式错误").await;
            close_ws(out_tx, 1008, "首帧格式错误").await;
            return Ok(None);
        }
    };
    if hello.v != PROTOCOL_VERSION {
        note_failure(app, hub, ip, "协议版本不支持");
        let _ =
            send_response(out_tx, "", ErrorCode::UnsupportedVersion, "不支持的协议版本").await;
        close_ws(out_tx, 400, "unsupported_version").await;
        return Ok(None);
    }
    if hello.client_id.trim().is_empty() {
        note_failure(app, hub, ip, "clientId 为空");
        let _ = send_response(out_tx, "", ErrorCode::Unauthorized, "clientId 不能为空").await;
        close_ws(out_tx, 1008, "unauthorized").await;
        return Ok(None);
    }
    // 首帧不经 `handle_request` 的 64KiB 检查：`clientId` / `clientName` 无上限会被带进
    // 待决弹窗与 `ext_clients`（contract §17.5）。这里先夹一刀（展示字段，256 字符足够）。
    if hello.client_id.chars().count() > MAX_HELLO_FIELD
        || hello.client_name.chars().count() > MAX_HELLO_FIELD
    {
        note_failure(app, hub, ip, "首帧字段过长");
        let _ = send_response(out_tx, "", ErrorCode::BadRequest, "客户端标识或名称过长").await;
        close_ws(out_tx, 1008, "bad_request").await;
        return Ok(None);
    }
    let client_id = hello.client_id.clone();

    let state = app.state::<AppState>();
    let (bind, pair_expected, existing) = {
        let conn = state.db.lock();
        (
            store::get_bind_mode(&conn),
            store::get_pair_token(&conn),
            store::find_client(&conn, &client_id)?,
        )
    };

    // LAN 模式必带正确的配对令牌（contract §4.2）
    if bind == BindMode::Lan {
        let ok = match (hello.pair_token.as_deref(), pair_expected.as_deref()) {
            (Some(p), Some(exp)) => store::constant_time_eq(p, exp),
            _ => false,
        };
        if !ok {
            note_failure(app, hub, ip, "LAN 配对令牌错误");
            let _ = send_response(
                out_tx,
                "",
                ErrorCode::Unauthorized,
                "局域网模式必须提供正确的配对令牌",
            )
            .await;
            close_ws(out_tx, 1008, "unauthorized").await;
            return Ok(None);
        }
    }

    // 有效 clientToken → 直接放行，跳过弹窗（每次调用仍会逐次回 DB 校验 scope）。
    // 只要首帧带了 clientToken 字段，未命中有效行（不存在 / 已撤销 / 哈希已清）**或形状非法**
    // → 一律 unauthorized + 1008（contract §4.6），并计入失败限频；绝不当作「没带令牌」放进待决。
    if let Some(tok) = hello.client_token.as_deref() {
        if !store::looks_like_token(tok) {
            note_failure(app, hub, ip, "客户端令牌格式非法");
            let _ =
                send_response(out_tx, "", ErrorCode::Unauthorized, "令牌无效或已被撤销").await;
            close_ws(out_tx, 1008, "unauthorized").await;
            return Ok(None);
        }
        let hit = {
            let conn = state.db.lock();
            store::find_by_token(&conn, tok)?
        };
        match hit {
            Some(row) => {
                let grant = ConnGrant {
                    client_id: row.client_id.clone(),
                    name: row.name.clone(),
                    scopes: row.scopes.clone(),
                    kind: GrantKind::Always,
                };
                hub.grant(conn_id, grant.clone());
                {
                    let conn = state.db.lock();
                    store::touch_seen(&conn, &row.client_id, Some(ip))?;
                }
                return Ok(Some(grant));
            }
            None => {
                note_failure(app, hub, ip, "客户端令牌无效或已被撤销");
                let _ =
                    send_response(out_tx, "", ErrorCode::Unauthorized, "令牌无效或已被撤销").await;
                close_ws(out_tx, 1008, "unauthorized").await;
                return Ok(None);
            }
        }
    }

    // 持久拒绝：不弹窗，直接回绝
    if let Some(row) = &existing {
        if row.decision == ClientDecision::Deny {
            let _ =
                send_event(out_tx, events::AUTH_DENIED, json!({ "reason": "该客户端已被拒绝" })).await;
            let _ = send_response(out_tx, "", ErrorCode::Denied, "该客户端已被拒绝").await;
            close_ws(out_tx, 1008, "denied").await;
            return Ok(None);
        }
    }

    // 待决 → 四选一。用户「忽略」只记限频、不决策，连接维持 pending。
    // 决策窗口 60 秒（contract §16 规则 2）；**超时与忽略两条路径都计入按 IP 的失败限频**
    // （§16 规则 6：与握手被拒同一套 `note_failure`，纳入 AUTH_FAIL_PER_MIN / AUTH_BAN）。
    let deadline = Instant::now() + Duration::from_millis(AUTH_PENDING_TIMEOUT_MS as u64);
    let requested = ScopeSet::minimal_default();
    // 反复被限频空转（轮换 clientId 使 prompt_gate 每次都 Show、随后被按 IP 弹窗限频压掉）
    // 只记一次失败：每 500ms 记一次会把审计刷爆。记这一次即让该 IP 计入 AUTH_FAIL 封禁，
    // 使「轮换 clientId 撑满未鉴权并发槽」这条路径也会触发封禁（contract §16 规则 6）。
    let mut rate_limited_noted = false;
    loop {
        if Instant::now() >= deadline {
            note_failure(app, hub, ip, "授权超时（用户未决）");
            let _ = send_event(out_tx, events::AUTH_DENIED, json!({ "reason": "授权超时" })).await;
            close_ws(out_tx, 1008, "授权超时").await;
            return Ok(None);
        }
        let gate = {
            let conn = state.db.lock();
            auth::prompt_gate(&conn, &client_id)?
        };
        match gate {
            PromptGate::Show => {
                // 同一来源 IP 弹窗过密 → 静默挂起。防「轮换 clientId 刷弹窗」：
                // clientId 限频（prompt_gate）挡不住换 id，这里按 IP 再兜一层。
                if !hub.prompt_allowed(ip) {
                    if !rate_limited_noted {
                        rate_limited_noted = true;
                        note_failure(app, hub, ip, "待决授权被按 IP 弹窗限频挂起");
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                let pending = PendingAuth {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    client_id: client_id.clone(),
                    client_name: hello.client_name.clone(),
                    // 握手请求头里的 Origin（原生客户端为 None）——弹窗上「谁在请求」的第三行。
                    origin: origin.clone(),
                    ip: Some(ip.to_string()),
                    scopes: requested.clone(),
                    created_at: store::now_iso(),
                    timeout_ms: AUTH_PENDING_TIMEOUT_MS,
                };
                let rx = hub.begin_pending(conn_id, pending.clone());
                let _ = app.emit(EVENT_AUTH_REQUIRED, &pending);
                let _ = send_event(
                    out_tx,
                    events::AUTH_PENDING,
                    json!({ "requestId": pending.request_id, "timeoutMs": AUTH_PENDING_TIMEOUT_MS }),
                )
                .await;

                let remaining = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(remaining, rx).await {
                    Ok(Ok(AuthDecision::Granted { kind, token, scopes })) => {
                        let grant = ConnGrant {
                            client_id: client_id.clone(),
                            name: hello.client_name.clone(),
                            scopes: scopes.clone(),
                            kind,
                        };
                        hub.grant(conn_id, grant.clone());
                        // clientToken 仅在 always 时出现一次（contract §4.5）
                        let data = match token {
                            Some(t) => {
                                json!({ "grant": kind.as_str(), "clientToken": t, "scopes": scopes })
                            }
                            None => json!({ "grant": kind.as_str(), "scopes": scopes }),
                        };
                        let _ = send_event(out_tx, events::AUTH_GRANTED, data).await;
                        return Ok(Some(grant));
                    }
                    Ok(Ok(AuthDecision::Denied { reason })) => {
                        let _ =
                            send_event(out_tx, events::AUTH_DENIED, json!({ "reason": reason })).await;
                        close_ws(out_tx, 1008, "denied").await;
                        return Ok(None);
                    }
                    // 忽略：限频已记（30s 同 client 不再弹 / 连续 3 次转静默）、请求已出队；
                    // 同时计入按 IP 的失败限频（contract §16 规则 5/6）。回到循环顶部，
                    // 下一次多半是 Suppress，直到 60 秒预算耗尽。
                    Ok(Ok(AuthDecision::Ignored)) => {
                        note_failure(app, hub, ip, "用户忽略授权请求");
                        continue;
                    }
                    Ok(Err(_)) => {
                        // 裁决通道断开（请求被丢弃）：收尾
                        close_ws(out_tx, 1008, "授权请求已失效").await;
                        return Ok(None);
                    }
                    Err(_) => {
                        note_failure(app, hub, ip, "授权超时（决策窗口超时）");
                        let _ =
                            send_event(out_tx, events::AUTH_DENIED, json!({ "reason": "授权超时" })).await;
                        close_ws(out_tx, 1008, "授权超时").await;
                        return Ok(None);
                    }
                }
            }
            // 限频防骚扰：静默挂起，不弹窗、不发事件，睡一小觉再看
            PromptGate::Suppress | PromptGate::Silent => {
                if !rate_limited_noted {
                    rate_limited_noted = true;
                    note_failure(app, hub, ip, "待决授权被静默挂起（限频）");
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

// ---------------------------------------------------------------- 请求分派

/// 查询预算的 RAII 守卫：`Drop` 时摘掉 `progress_handler`。
/// 万一 `require`/`dispatch` 之间 panic，也不会把过期的 deadline 留给下一次查询
/// （`progress_handler` 挂在唯一的 sqlite3 句柄上，靠顺序清理会漏）。
struct ProgressGuard<'a> {
    conn: &'a rusqlite::Connection,
}

impl Drop for ProgressGuard<'_> {
    fn drop(&mut self) {
        self.conn.progress_handler(0, None::<fn() -> bool>);
    }
}

/// 处理一条已授权连接上的请求。返回（响应 JSON，需要关闭连接时的关闭码）。
fn handle_request<R: Runtime>(
    app: &AppHandle<R>,
    hub: &GatewayHub,
    conn_id: &str,
    ip: &str,
    text: &str,
) -> (String, Option<u16>) {
    let env: RequestEnvelope = match serde_json::from_str(text) {
        Ok(e) => e,
        Err(_) => return (err_json("", ErrorCode::BadRequest, "请求格式错误"), None),
    };
    if env.v != PROTOCOL_VERSION {
        return (
            err_json(&env.id, ErrorCode::UnsupportedVersion, "不支持的协议版本"),
            Some(400),
        );
    }
    if text.len() > MAX_CONTROL {
        return (err_json(&env.id, ErrorCode::PayloadTooLarge, "请求过大"), Some(1009));
    }
    let Some(method) = Method::from_name(&env.method) else {
        return (
            err_json(&env.id, ErrorCode::BadRequest, format!("未知方法：{}", env.method)),
            None,
        );
    };
    let client_id = hub.session_client(conn_id).unwrap_or_default();
    if !hub.rate_check(&client_id) {
        return (err_json(&env.id, ErrorCode::Busy, "请求过于频繁"), None);
    }

    let state = app.state::<AppState>();
    // 短锁：先逐次校验 scope，再调域函数；一次取锁包住两者（contract §5.3 / §6.3）。
    let conn = state.db.lock();
    let started = Instant::now();
    // 查询预算：同一把锁内设 progress_handler，超预算中断（contract §6.4）。
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let flag = Arc::clone(&interrupted);
        let deadline = started + Duration::from_millis(QUERY_BUDGET_MS);
        conn.progress_handler(
            PROGRESS_OPS,
            Some(move || {
                if Instant::now() >= deadline {
                    flag.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }),
        );
    }
    let (outcome, decision, effects) = {
        // RAII：本作用域结束时（含 panic 展开）一定摘掉预算。
        let _guard = ProgressGuard { conn: &conn };
        // 模块门禁**先于** scope 校验（contract §4.7）：关掉的功能，客户端拿着全部 scope
        // 也不该可用 —— 这是「这个功能此刻在不在」的事实，不是授权判定，所以同样记 denied。
        match store::module_gate(&conn, method) {
            Err(e) => (Err(e), AuditDecision::Denied, Vec::new()),
            Ok(()) => match auth::require(&conn, hub, conn_id, method.scope()) {
                Err(e) => (Err(e), AuditDecision::Denied, Vec::new()),
                // 用 `dispatch_with_effects` 收下锁外动作（下行 emit / HC 删除传播），
                // 靠下面「松锁 → 执行 → 回帧」的三段式落地（contract §13.3 / §14.3 / §17.3）。
                // 直接用 `dispatch` 会把 effects 整包丢掉：外部控制前端收不到、HC 副本不删。
                Ok(()) => match methods::dispatch_with_effects(&conn, method, &env.params) {
                    Ok((v, effects)) => (Ok(v), AuditDecision::Allowed, effects),
                    Err(e) => (Err(e), AuditDecision::Error, Vec::new()),
                },
            },
        }
    };
    let duration_ms = started.elapsed().as_millis() as i64;
    // 被预算中断 → 统一回 `timeout`（contract §4.6 / §6.4）。
    let outcome = if interrupted.load(Ordering::Relaxed) {
        Err(ReinError::coded("timeout", "查询超时"))
    } else {
        outcome
    };
    let _ = store::insert_audit(
        &conn,
        &AuditRecord {
            at: store::now_iso(),
            client_id: if client_id.is_empty() {
                None
            } else {
                Some(client_id.clone())
            },
            method: method.name().to_string(),
            scope: method.scope().as_str().to_string(),
            decision,
            // 写操作记**参数摘要**（按 scope 域白名单挑字段、逐字段截断，contract §17.4）；出错时
            // 优先记错误串。只读成功不记（避免审计表被读调用撑爆）。
            // 错误串同样要截断：serde 反序列化错误会把「意外的字符串」原样回显（如传入 64KiB 的
            // 非法字段值），不截断即可把近 64KiB 写进从不清理的 `ext_audit.detail`（§17.5）。
            detail: match &outcome {
                Err(e) => Some(truncate_chars(&e.to_string(), AUDIT_DETAIL_MAX)),
                Ok(_) if method.is_write() => summarize_params(method.name(), &env.params),
                Ok(_) => None,
            },
            ip: Some(ip.to_string()),
            duration_ms,
        },
    );
    drop(conn);
    // 锁外执行锁外动作（contract §6.3 / §13.3 / §14.3）：下行 emit 与 HC 删除传播都不许持锁。
    // effects 只在派发成功时产生；即便预算把 outcome 改写成 timeout，动作本身也已受理/已落库，
    // 照常执行不会造成不一致（控制方法不碰 DB、workout.delete 的删行已成事实）。
    for effect in effects {
        match effect {
            methods::Effect::Emit { event, data } => {
                let _ = app.emit(event, data);
            }
            methods::Effect::PropagateDelete { external_id } => {
                crate::modules::healthsync::commands::propagate_delete(app, &external_id);
            }
        }
    }

    match outcome {
        Ok(v) => (ok_json(&env.id, v), None),
        Err(e) => {
            let code = ErrorCode::from_rein_code(e.code());
            // `internal`（含 rusqlite 原文）不外泄 schema 细节：只回固定文案，
            // 原文已写进 ext_audit.detail（contract §4.6「internal = 其余」）。
            let msg = if code == ErrorCode::Internal {
                "内部错误".to_string()
            } else {
                e.to_string()
            };
            (err_json(&env.id, code, msg), code.close_code())
        }
    }
}

// ---------------------------------------------------------------- 发送助手

/// 鉴权阶段失败：记一次未鉴权失败（限频封 IP）**并**落一条审计（`method` 为空）——
/// 「谁在探测令牌/端口」必须留痕，否则事后追责做不到（contract §5.4）。
///
/// 除握手被拒 / 首帧非法 / 令牌无效外，**待决超时与用户「忽略」也走这里**
/// （contract §16 规则 6）：两条路径都计入 `AUTH_FAIL_PER_MIN` / `AUTH_BAN`。
fn note_failure<R: Runtime>(app: &AppHandle<R>, hub: &GatewayHub, ip: &str, detail: &str) {
    hub.note_auth_failure(ip);
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    let _ = store::insert_audit(
        &conn,
        &AuditRecord {
            at: store::now_iso(),
            client_id: None,
            method: String::new(),
            scope: String::new(),
            decision: AuditDecision::Denied,
            // `detail` 里可能含**攻击者可控**的握手 Origin（超长串）：落库前统一截断，
            // 否则任意网页可把无界字符串写进 ext_audit 并被设置页原样回显（contract §17.5）。
            detail: Some(truncate_chars(detail, AUDIT_DETAIL_MAX)),
            ip: Some(ip.to_string()),
            duration_ms: 0,
        },
    );
}

/// 非阻塞投递：下行队列满（客户端只连不读）就返回 false，调用方据此**断连**
/// （contract §4.1「每连接下行 mpsc 容量 64，满即断」）。绝不背压挂死连接任务。
fn try_send(tx: &mpsc::Sender<Message>, msg: Message) -> bool {
    tx.try_send(msg).is_ok()
}

/// 等写侧任务收尾，但**封顶**——避免「只连不读」把连接任务永久挂住（槽位不归还）。
/// 超时就把写任务 abort 掉（它已不可能再正常收尾）。
async fn drain_writer(writer: tauri::async_runtime::JoinHandle<()>) {
    let mut writer = writer;
    if tokio::time::timeout(Duration::from_secs(5), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

async fn send_json(tx: &mpsc::Sender<Message>, value: &Value) -> bool {
    match serde_json::to_string(value) {
        Ok(s) => try_send(tx, Message::Text(s)),
        Err(_) => false,
    }
}

async fn send_response(tx: &mpsc::Sender<Message>, id: &str, code: ErrorCode, msg: impl Into<String>) -> bool {
    match serde_json::to_value(ResponseEnvelope::err(id, code, msg)) {
        Ok(v) => send_json(tx, &v).await,
        Err(_) => false,
    }
}

async fn send_event(tx: &mpsc::Sender<Message>, event: &str, data: Value) -> bool {
    match serde_json::to_value(EventEnvelope::new(event, data)) {
        Ok(v) => send_json(tx, &v).await,
        Err(_) => false,
    }
}

async fn close_ws(tx: &mpsc::Sender<Message>, code: u16, reason: &'static str) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: Cow::Borrowed(reason),
    };
    let _ = try_send(tx, Message::Close(Some(frame)));
}

fn ok_json(id: &str, v: Value) -> String {
    serde_json::to_string(&ResponseEnvelope::ok(id, v)).unwrap_or_default()
}

fn err_json(id: &str, code: ErrorCode, msg: impl Into<String>) -> String {
    serde_json::to_string(&ResponseEnvelope::err(id, code, msg)).unwrap_or_default()
}

/// 审计参数摘要：单个字符串字段的截断上限。
const AUDIT_FIELD_MAX: usize = 200;
/// 审计参数摘要的整体长度上限（`ext_audit.detail` 一列，别让一次 `sessionFinish` 撑爆它）。
const AUDIT_DETAIL_MAX: usize = 1000;

/// 可进审计的参数**字段名白名单**，按方法名的域前缀（`schedule.` / `workout.` / `pomodoro.`）分。
///
/// 白名单而不是黑名单：将来新增方法/字段时，忘了登记 = 不记（审计少一条），
/// 而不是把 `attachments`（内嵌 data URL）这类大字段顺手抄进审计表（contract §17.4）。
fn audit_fields(domain: &str) -> &'static [&'static str] {
    match domain {
        "schedule" => &[
            "id",
            "title",
            "notes",
            "date",
            "startMin",
            "durationMin",
            "category",
            "priority",
            "status",
            "completedAt",
            "startDate",
            "endDate",
            "semesterId",
            "from",
            "to",
        ],
        "workout" => &[
            "id",
            "name",
            "note",
            "workoutType",
            "date",
            "startMin",
            "durationMin",
            "intensity",
            "effort",
            "kcal",
            "startDate",
            "endDate",
            "days",
            "exerciseId",
            "exerciseIds",
            "planId",
            "planName",
            "startedAt",
            "exIndex",
            "setIndex",
            "weightKg",
        ],
        "pomodoro" => &[
            "todoId",
            "focusMin",
            "breakMin",
            "startedAt",
            "endedAt",
            "completed",
        ],
        _ => &[],
    }
}

/// 写操作参数摘要（JSON 文本）：按域白名单挑字段、逐字段截断到 [`AUDIT_FIELD_MAX`]，
/// 整体再截到 [`AUDIT_DETAIL_MAX`]。没有可记的字段时返回 `None`（`detail` 留空）。
///
/// 嵌套对象（`todo` / `session` / `sessionFinish`）**下沉一层**：内层键同样过白名单，
/// 键名写成 `父.子`；数组只记项数（`[3 项]`），绝不把内容抄进审计表。
fn summarize_params(method_name: &str, params: &Value) -> Option<String> {
    let fields = audit_fields(method_name.split('.').next().unwrap_or(""));
    if fields.is_empty() {
        return None;
    }
    let obj = params.as_object()?;
    let mut picked = serde_json::Map::new();
    for (key, value) in obj {
        pick_audit_field(&mut picked, key, value, fields, false);
    }
    if picked.is_empty() {
        return None;
    }
    Some(truncate_chars(&Value::Object(picked).to_string(), AUDIT_DETAIL_MAX))
}

/// [`summarize_params`] 的单字段收敛（`nested` = 已经在嵌套层，不再往下钻）。
/// 白名单比对用**叶子键名**（`todo.title` 里的 `title`），输出键名保留 `父.子` 便于归属。
fn pick_audit_field(
    out: &mut serde_json::Map<String, Value>,
    out_key: &str,
    value: &Value,
    fields: &[&str],
    nested: bool,
) {
    let leaf = out_key.rsplit('.').next().unwrap_or(out_key);
    match value {
        // 嵌套对象只下钻一层：`todo` / `session` / `sessionFinish` 的参数在其内部。
        Value::Object(inner) if !nested => {
            for (k, v) in inner {
                pick_audit_field(out, &format!("{out_key}.{k}"), v, fields, true);
            }
        }
        Value::String(s) if fields.contains(&leaf) => {
            out.insert(
                out_key.into(),
                Value::String(truncate_chars(s, AUDIT_FIELD_MAX)),
            );
        }
        Value::Number(_) | Value::Bool(_) if fields.contains(&leaf) => {
            out.insert(out_key.into(), value.clone());
        }
        Value::Array(a) if fields.contains(&leaf) => {
            out.insert(out_key.into(), Value::String(format!("[{} 项]", a.len())));
        }
        _ => {}
    }
}

/// 截到 `max` 个字符（按字符不按字节，中文不被劈开），被截时加省略号。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::gateway::auth::GatewayHub;

    fn local(addr: &str) -> Option<SocketAddr> {
        Some(addr.parse().unwrap())
    }

    /// Origin 三态：缺失 / 空 → 放行（原生）；命中白名单 → 放行；其余 → 拒（原因含原串给审计）。
    #[test]
    fn origin_gate_allows_native_and_whitelisted_only() {
        let allowed = vec!["null".to_string(), "http://localhost:5173".to_string()];
        // 原生客户端：没有 Origin 头 / 空串
        assert!(gate_origin(None, &allowed).is_ok());
        assert!(gate_origin(Some("   "), &allowed).is_ok());
        // 白名单命中（精确、大小写敏感；`file://` 页面的 Origin 就是字面量 "null"）
        assert!(gate_origin(Some("null"), &allowed).is_ok());
        assert!(gate_origin(Some("http://localhost:5173"), &allowed).is_ok());
        // 未命中：拒绝，且原因带上被拒的 Origin（它会落进审计，设置页据此列「被拦下的来源」）
        let err = gate_origin(Some("http://evil.example"), &allowed).unwrap_err();
        assert!(err.contains("http://evil.example"));
        assert!(err.starts_with(store::ORIGIN_BLOCKED_PREFIX));
        assert!(gate_origin(Some("HTTP://LOCALHOST:5173"), &allowed).is_err(), "不做大小写归一");
        assert!(gate_origin(Some("null"), &[]).is_err(), "空白名单拒一切网页");
        // 子域 / 前缀不算命中（精确字符串相等）
        assert!(gate_origin(Some("http://localhost:5173/x"), &allowed).is_err());
    }

    /// Host 闸门：IP 字面量 + 端口、`localhost`、本机主机名放行；外来 Host 与错端口拒；
    /// `local_addr()` 为 `None` 时整段跳过（contract §17.5）。
    #[test]
    fn host_gate_covers_ip_localhost_hostname_and_none() {
        let v4 = local("127.0.0.1:17650");
        assert!(gate_host(Some("127.0.0.1"), v4).is_ok());
        assert!(gate_host(Some("127.0.0.1:17650"), v4).is_ok());
        assert!(gate_host(Some("localhost"), v4).is_ok());
        assert!(gate_host(Some("LOCALHOST:17650"), v4).is_ok(), "DNS 名大小写无关");
        // LAN 下用主机名连（契约 §17.5）：本机主机名在别名里，一律放行
        for name in local_host_names() {
            assert!(gate_host(Some(name), v4).is_ok(), "主机名 {name} 应放行");
            assert!(gate_host(Some(&format!("{name}:17650")), v4).is_ok());
        }
        // 端口不符 / 外来来源 / 缺头 → 拒（挡 DNS rebinding）
        assert!(gate_host(Some("127.0.0.1:9999"), v4).is_err());
        assert!(gate_host(Some("evil.example"), v4).is_err());
        assert!(gate_host(None, v4).is_err());
        assert!(gate_host(Some("  "), v4).is_err());
        // IPv6 回环（Host 头里的方括号写法）
        let v6 = local("[::1]:17650");
        assert!(gate_host(Some("[::1]:17650"), v6).is_ok());
        assert!(gate_host(Some("::1"), v6).is_ok());
        assert!(gate_host(Some("[::1]"), v6).is_ok());
        // 拿不到本机地址 → 跳过闸门，不拒连
        assert!(gate_host(Some("anything.example"), None).is_ok());
    }

    /// 变更推送的 scope 映射：三个对外域各归其读权限，其余业务表谁也不推。
    #[test]
    fn change_kinds_map_to_read_scopes() {
        assert_eq!(change_scope("todos"), Some(Scope::ScheduleRead));
        assert_eq!(change_scope("workouts"), Some(Scope::WorkoutRead));
        assert_eq!(change_scope("workout_plans"), Some(Scope::WorkoutRead));
        assert_eq!(change_scope("workout_sessions"), Some(Scope::WorkoutRead));
        assert_eq!(change_scope("pomodoro_sessions"), Some(Scope::PomodoroRead));
        // 不在对外 scope 模型里的域：不推给任何人（含饮食 / 知识库 / 记账 / 凭据）
        for kind in ["foods", "meals", "kb_files", "ledger_entries", "ext_clients", ""] {
            assert_eq!(change_scope(kind), None, "{kind} 不该有推送 scope");
        }
    }

    /// 过滤的实际效果：只授 schedule.read 的会话拿不到运动 / 番茄钟的任何变更。
    #[test]
    fn only_scoped_domains_reach_a_connection() {
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
        let scopes = hub.session_scopes("conn-1");
        let deliver = |kind: &str| {
            change_scope(kind)
                .map(|need| scopes.contains(need))
                .unwrap_or(false)
        };
        assert!(deliver("todos"), "日程域可推");
        assert!(!deliver("workouts"), "没授 workout.read 就不推");
        assert!(!deliver("pomodoro_sessions"), "没授 pomodoro.read 就不推");
        assert!(!deliver("foods"), "不在 scope 模型里的域谁来都不推");
    }

    /// 审计参数摘要：只挑白名单字段、嵌套下沉一层、长串截断、数组只记项数。
    #[test]
    fn audit_params_pick_whitelisted_fields_and_truncate() {
        // 白名单外的字段（recRule / attachments 这类大字段）不进摘要
        let s = summarize_params(
            "schedule.create",
            &json!({
                "title": "买菜", "date": "2026-10-13", "startMin": 600,
                "recRule": "FREQ=DAILY", "attachments": "data:image/png;base64,AAAA"
            }),
        )
        .unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["title"], "买菜");
        assert_eq!(v["startMin"], 600);
        assert!(v.get("recRule").is_none(), "白名单外字段不进审计");
        assert!(v.get("attachments").is_none());

        // 嵌套 todo：下沉一层，键名带父前缀
        let nested = summarize_params(
            "schedule.update",
            &json!({ "todo": { "id": 7, "title": "改标题", "attachments": "x", "recRule": "y" } }),
        )
        .unwrap();
        let nv: Value = serde_json::from_str(&nested).unwrap();
        assert_eq!(nv["todo.id"], 7);
        assert_eq!(nv["todo.title"], "改标题");
        assert!(nv.get("todo.attachments").is_none());

        // 逐字段截断到 200 字符 + 省略号；整体再截到 1000
        let long = "字".repeat(500);
        let truncated = summarize_params("workout.create", &json!({ "name": long })).unwrap();
        let tv: Value = serde_json::from_str(&truncated).unwrap();
        let name = tv["name"].as_str().unwrap();
        assert_eq!(name.chars().count(), AUDIT_FIELD_MAX + 1);
        assert!(name.ends_with('…'));

        // 数组只记项数（exerciseIds 可能很长）
        let arr = summarize_params("workout.lastWeights", &json!({ "exerciseIds": ["a", "b", "c"] }))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&arr).unwrap()["exerciseIds"], "[3 项]");

        // 没有可记的字段 / 域不在白名单 → None（detail 留空）
        assert!(summarize_params("schedule.create", &json!({ "recRule": "y" })).is_none());
        assert!(summarize_params("campus.schedule", &json!({ "id": 1 })).is_none());
        assert!(summarize_params("workout.create", &Value::Null).is_none());

        // 整体长度上限：拼一堆中文字段也不越界
        let many = json!({
            "title": "字".repeat(200), "notes": "字".repeat(200), "name": "字".repeat(200),
            "note": "字".repeat(200), "date": "2026-10-13", "startDate": "2026-10-13",
            "endDate": "2026-10-13", "workoutType": "run", "intensity": "high"
        });
        let big = summarize_params("workout.create", &many).unwrap();
        assert!(big.chars().count() <= AUDIT_DETAIL_MAX + 1, "整体截断到 {AUDIT_DETAIL_MAX} 字符");
    }

    // 这里原本还有一组走 `handle_connection` 全链路的用例（真 socket · 真首帧 · 真 authorize）：
    // 它们要 `tauri::test::mock_app`，而 mock 运行时的代码在 Windows 上必须链进应用清单，
    // 否则测试进程在 `main` 之前就以 STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139）结束；清单只能
    // 靠覆盖 bin 的链接指令送进去，而那会把 `resource.lib` 的 VERSION 资源链进 bin 两次
    // （CVTRES CVT1100: duplicate resource）—— 结果是「单测跑得动、App 链不出来」。
    // 把事件发送与 `AppHandle` 解耦（测试用空通知器）之后可以把它们原样搬回来；
    // 全链路的真机覆盖眼下由 `scripts/e2e-external-api.mjs` 承担。
    //
    // 下面这条**不需要** AppHandle（`handshake` 只要 stream / local / 白名单），所以既留在 CI
    // 里，也验到 Origin 闸门的活路径：真监听、真客户端、真 403 / 真 101。

    /// 起一个只做握手的监听，返回地址与任务句柄（调用方负责 abort）。
    ///
    /// 传 `local = None`：Host 闸门在这种情况下**按设计跳过**（见 [`gate_host`]），
    /// 于是这条测试只测 Origin 闸门 —— Host 闸门自有 `host_gate_covers_*` 单测，
    /// 它在真机上的组合行为由 `scripts/e2e-external-api.mjs` 覆盖。若不跳过，临时端口
    /// 与 `gate_host` 的别名集合对不上，会把 Origin 的结论污染成「Host 不符」。
    async fn once_handshake(allowed: Vec<String>) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            if let Ok((stream, _local)) = listener.accept().await {
                let meta = Arc::new(Mutex::new(HandshakeMeta::default()));
                let _ = handshake(stream, None, allowed, meta).await;
            }
        });
        (addr, handle)
    }

    /// Origin 闸门的活路径：白名单外必须被 403 挡下，白名单内必须放行（101）。
    ///
    /// 为什么要有这条：真机端到端里这一块会与「按 IP 的未鉴权失败限频」相互干扰（负向握手
    /// 计失败次数、失败多了整段被拒），于是它只能在这里拿到确定性证据。
    #[tokio::test]
    async fn origin_gate_blocks_unlisted_and_allows_listed_on_the_wire() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let origin = "http://widget.e2e";

        let (addr, srv) = once_handshake(vec![origin.to_string()]).await;
        let mut req = format!("ws://{addr}/").into_client_request().unwrap();
        req.headers_mut()
            .insert("Origin", "http://evil.example".parse().unwrap());
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        match tokio_tungstenite::client_async(req, stream).await {
            Ok(_) => panic!("白名单外的 Origin 必须被拒"),
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                let status = resp.status().as_u16();
                let body = String::from_utf8_lossy(&resp.body().clone().unwrap_or_default()).into_owned();
                assert_eq!(status, 403, "应当是 403，实际 {status}；body={body}");
            }
            Err(e) => panic!("应当被 403 拒绝，实际：{e}"),
        }
        srv.abort();

        let (addr, srv) = once_handshake(vec![origin.to_string()]).await;
        let mut req = format!("ws://{addr}/").into_client_request().unwrap();
        req.headers_mut().insert("Origin", origin.parse().unwrap());
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        match tokio_tungstenite::client_async(req, stream).await {
            Ok(_) => {}
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => panic!(
                "白名单内的 Origin 被拒：{} body={}",
                resp.status(),
                String::from_utf8_lossy(&resp.body().clone().unwrap_or_default())
            ),
            Err(e) => panic!("白名单内的 Origin 必须放行，实际被拒：{e}"),
        }
        srv.abort();
    }
}
