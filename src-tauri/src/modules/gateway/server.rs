//! 对外网关的 WebSocket 服务端：监听、握手闸门、首帧令牌、四态授权流程、
//! 请求分派、以及把同步变更推给已连接的客户端。
//!
//! 用仓库既有依赖 `tokio` + `tokio-tungstenite`（`Cargo.toml`），不引入 axum/hyper。
//! 六条闸门按 contract §4.1/§7：
//!
//! 1. **绑定**：`local` 绑 `127.0.0.1` 与 `::1`；`lan` 只绑 `0.0.0.0`。默认端口 17650，
//!    被占则 17650..17659 顺延，全占退系统分配；**实际**端口写回设置（由 `commands.rs` 做）。
//! 2. **Origin**：带非空 `Origin` 头的连接一律 403（挡浏览器页面）。
//! 3. **Host**：必须是客户端敲到的本机地址（挡 DNS rebinding；tungstenite 自己不校验 Host）。
//! 4. **首帧令牌**：握手成功后 5 秒内必须发首帧，否则 1008。
//! 5. **逐次 scope**：每个请求进业务逻辑前过 `auth::require`。
//! 6. **参数收紧**：单帧/单消息 256KiB、控制面请求 64KiB、未鉴权并发 ≤ 8。
//!
//! 会话/授权状态、scope 判据、待决队列全在 `auth.rs`；这里只做 IO 与编排。

use std::borrow::Cow;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
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
    self, AuthDecision, ConnGrant, GatewayHub, GrantKind, PendingAuth, AUTH_PENDING_TIMEOUT_MS,
    EVENT_AUTH_REQUIRED,
};
use crate::modules::gateway::models::{
    AuditDecision, AuditRecord, BindMode, ClientDecision, PromptGate, ScopeSet,
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
    hub.set_server(tx, actual);
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
                let Some(local) = stream.local_addr().ok() else {
                    // 拿不到本机地址就没法过 Host 闸门：按拒处理，别静默跳过校验。
                    drop(stream);
                    continue;
                };
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

fn reject(msg: &'static str) -> ErrorResponse {
    let mut resp = ErrorResponse::new(Some(msg.to_string()));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp
}

/// Origin 闸门：头缺失或为空放行，其余一律拒（挡浏览器页面发起的连接）。
fn gate_origin(req: &Request) -> std::result::Result<(), &'static str> {
    if let Some(o) = req.headers().get(ORIGIN) {
        let s = o.to_str().unwrap_or("").trim();
        if !s.is_empty() {
            return Err("拒绝来自网页（带 Origin）的连接");
        }
    }
    Ok(())
}

/// Host 闸门：必须指向本机（挡 DNS rebinding；tungstenite 自己不校验 Host）。
///
/// 放行「本机地址」集合：实际 socket 的 `local_addr`、回环 IP 字面量、以及主机名 `localhost`
/// （契约 §4.1 以「Windows 上 localhost 常先解析到 ::1」为由要求双绑，等于承认 localhost 是合法入口）。
/// 带端口的写法端口必须与实际监听端口一致。
fn gate_host(req: &Request, local: SocketAddr) -> std::result::Result<(), &'static str> {
    let Some(h) = req.headers().get(HOST) else {
        return Err("缺少 Host 头");
    };
    let h = h.to_str().unwrap_or("");
    let port = local.port();
    let local_ip = local.ip().to_string();
    let aliases = ["127.0.0.1", "::1", "[::1]", "localhost"];
    let ok = h == local_ip
        || h == format!("{local_ip}:{port}")
        || aliases
            .iter()
            .any(|a| h == *a || h == format!("{a}:{port}"));
    if ok {
        Ok(())
    } else {
        Err("Host 与本机地址不符")
    }
}

/// `tungstenite::handshake::server::Callback` 的回调返回类型 `{Response, ErrorResponse}` 由库固定，
/// `ErrorResponse`（`HttpResponse<Option<String>>`）偏大 —— 不是我们可选的设计，故局部放行。
#[allow(clippy::result_large_err)]
async fn handshake(
    stream: TcpStream,
    local: SocketAddr,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>> {
    let cfg = ws_config();
    tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        move |req: &Request, resp: Response| {
            if let Err(m) = gate_origin(req) {
                return Err(reject(m));
            }
            // Host 闸门**总是**执行（local 由 accept 侧保证非空）。
            if let Err(m) = gate_host(req, local) {
                return Err(reject(m));
            }
            Ok(resp)
        },
        Some(cfg),
    )
    .await
    .map_err(|e| ReinError::Message(format!("WebSocket 握手失败：{e}")))
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

async fn handle_connection(
    app: AppHandle,
    hub: Arc<GatewayHub>,
    stream: TcpStream,
    peer: SocketAddr,
    local: SocketAddr,
    unauth_permit: OwnedSemaphorePermit,
    authed: Arc<Semaphore>,
) -> Result<()> {
    let mut slot = ConnGuard::new(unauth_permit, authed);
    let ip = peer.ip().to_string();
    let conn_id = hub.next_conn_id();
    let ws = match handshake(stream, local).await {
        Ok(ws) => ws,
        Err(e) => {
            // Origin/Host 被拒等握手失败：记未鉴权失败并留一条审计（限频封 IP + 追责）。
            note_failure(&app, &hub, &ip, "握手被拒（Origin/Host）");
            return Err(e);
        }
    };

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

    let _grant = match authorize(&app, &hub, &out_tx, &mut read, &conn_id, &ip).await {
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
        }
    }
    drop(out_tx);
    drain_writer(writer).await;
    hub.end_conn(&conn_id);
    Ok(())
}

/// 首帧令牌 → 四态授权。成功返回 `Some(grant)`；被拒 / 超时返回 `None`（连接已收尾）。
async fn authorize(
    app: &AppHandle,
    hub: &GatewayHub,
    out_tx: &mpsc::Sender<Message>,
    read: &mut SplitStream<WebSocketStream<TcpStream>>,
    conn_id: &str,
    ip: &str,
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
    let deadline = Instant::now() + Duration::from_millis(AUTH_PENDING_TIMEOUT_MS as u64);
    let requested = ScopeSet::minimal_default();
    loop {
        if Instant::now() >= deadline {
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
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                let pending = PendingAuth {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    client_id: client_id.clone(),
                    client_name: hello.client_name.clone(),
                    origin: None,
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
                    // 忽略：限频已记、请求已出队；回到循环顶部，下一次多半是 Suppress
                    Ok(Ok(AuthDecision::Ignored)) => continue,
                    Ok(Err(_)) => {
                        // 裁决通道断开（请求被丢弃）：收尾
                        close_ws(out_tx, 1008, "授权请求已失效").await;
                        return Ok(None);
                    }
                    Err(_) => {
                        let _ =
                            send_event(out_tx, events::AUTH_DENIED, json!({ "reason": "授权超时" })).await;
                        close_ws(out_tx, 1008, "授权超时").await;
                        return Ok(None);
                    }
                }
            }
            // 限频防骚扰：静默挂起，不弹窗、不发事件，睡一小觉再看
            PromptGate::Suppress | PromptGate::Silent => {
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
fn handle_request(
    app: &AppHandle,
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
    let (outcome, decision) = {
        // RAII：本作用域结束时（含 panic 展开）一定摘掉预算。
        let _guard = ProgressGuard { conn: &conn };
        match auth::require(&conn, hub, conn_id, method.scope()) {
            Err(e) => (Err(e), AuditDecision::Denied),
            Ok(()) => match methods::dispatch(&conn, method, &env.params) {
                Ok(v) => (Ok(v), AuditDecision::Allowed),
                Err(e) => (Err(e), AuditDecision::Error),
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
            // 写操作记参数摘要（含目标 id）——「改了什么」要能从审计里答出来；
            // 出错时优先记错误串。只读成功不记（避免审计表被读调用撑爆）。
            detail: match &outcome {
                Err(e) => Some(e.to_string()),
                Ok(_) if method.is_write() => Some(summarize_params(&env.params)),
                Ok(_) => None,
            },
            ip: Some(ip.to_string()),
            duration_ms,
        },
    );
    drop(conn);

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
fn note_failure(app: &AppHandle, hub: &GatewayHub, ip: &str, detail: &str) {
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
            detail: Some(detail.to_string()),
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

/// 写操作参数摘要（截断到 500 字符）——审计里「改了什么」的可读线索。
fn summarize_params(params: &Value) -> String {
    let s = params.to_string();
    const MAX: usize = 500;
    if s.chars().count() > MAX {
        let mut out: String = s.chars().take(MAX).collect();
        out.push('…');
        out
    } else {
        s
    }
}
