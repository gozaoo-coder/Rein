//! 网关的管理面：8 条管理 tauri 命令（开关 / 绑定 / 状态 / 待决 / 裁决 / 撤销 /
//! 来源白名单 / 最近审计）与 2 个 Tauri 事件；外加运行态上报 2 条（`focus_publish` /
//! `focus_unpublish`，contract §14.1）。
//!
//! 命令名与事件名字符串**严格照抄** contract §4.5，一个字符都不改 —— 前端
//! `src/services/gatewayService.ts` 要照抄同一套，`scripts/check-ipc-contract.mjs` 会比对。
//! （第二轮新增的 `gateway_set_allowed_origins` / `gateway_audit_recent` 出自 §15.2 / §17.3，
//! 不在 §4.5 的六条表内，但同样三处同步。）
//!
//! 对外数据方法（`schedule.*` / `workout.*` / `pomodoro.*`）**不**在这里注册成 tauri 命令，
//! 由 `server.rs` 的 WS 私有 router 分发（contract §1.2 / §2.2）。

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::error::{ReinError, Result};
use crate::modules::gateway::auth::{
    AuthDecision, ConnGrant, GatewayHub, GrantKind, PendingAuth, ServerEvent, EVENT_AUTH_CHANGED,
};
use crate::modules::gateway::models::{AuditEntry, BindMode, ClientDecision, ExtClient, ScopeSet};
use crate::modules::gateway::{runtime, server, store};
use crate::state::AppState;

/// 一个已授权客户端（管理面列表项）。字段名对齐前端 `GatewayClient`（contract §4.5）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClient {
    pub client_id: String,
    pub name: String,
    /// `"session"` | `"always"`。
    pub grant: String,
    pub scopes: Vec<String>,
    /// ISO-8601；从未活跃为 null。
    pub last_seen: Option<String>,
    pub online: bool,
    pub ip: Option<String>,
}

/// 一个被拦下的客户端（拒绝 / 已撤销 / 静默限频中）——设置页要能看到并解除，
/// 否则「拒绝」与「连续忽略」都是用户无法撤销的死结（contract §5.1）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayBlocked {
    pub client_id: String,
    pub name: String,
    /// `"deny"` | `"revoked"` | `"ignore"`。
    pub reason: String,
    /// ISO-8601；从未活跃为 null。
    pub last_seen: Option<String>,
    pub ip: Option<String>,
}

/// 服务状态（`gateway_status` 的返回、`gateway://authorization-changed` 的负载）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub enabled: bool,
    pub bind_mode: BindMode,
    pub port: Option<u16>,
    /// 安装级配对令牌（LAN 模式必填）；设置页显示、供用户抄给外部客户端。未生成为 null。
    pub pair_token: Option<String>,
    pub pending_count: usize,
    pub clients: Vec<GatewayClient>,
    /// 被拒绝 / 已撤销 / 静默限频中的客户端（设置页可解除）。
    pub blocked: Vec<GatewayBlocked>,
    /// 用户批准过的网页来源（`Origin`）白名单（contract §15.2）。
    pub allowed_origins: Vec<String>,
    /// 被 Origin 闸门拒过、且尚未加白的来源（设置页「被拦下的来源」→ 一键加入白名单）。
    pub blocked_origins: Vec<String>,
}

/// 服务状态：开关 / 绑定模式 / 端口 / 待决数 / 已授权客户端列表。
#[tauri::command]
pub fn gateway_status(
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
) -> Result<GatewayStatus> {
    build_status(&state, &hub)
}

/// 开 / 关服务。开启时绑定并按设置写回实际端口；服务默认不启动（用户开了才监听）。
#[tauri::command]
pub fn gateway_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    enabled: bool,
) -> Result<GatewayStatus> {
    let hub_arc: Arc<GatewayHub> = (*hub).clone();
    if enabled {
        let (bind, port) = {
            let conn = state.db.lock();
            (store::get_bind_mode(&conn), store::get_port(&conn))
        };
        {
            let conn = state.db.lock();
            // LAN 模式必带配对令牌：开启时确保它已生成（设置页要显示它）
            store::ensure_pair_token(&conn)?;
        }
        if hub.is_running() {
            server::stop(&hub);
        }
        let actual = server::start(app.clone(), hub_arc, bind, port)?;
        {
            let conn = state.db.lock();
            store::set_port(&conn, Some(actual))?;
            store::set_enabled(&conn, true)?;
        }
        // 实际端口与设置不一致（默认端口被占、顺延到 17651..）→ 通知已连接客户端改连
        // （contract §14.5 / §17.2）。首次开启时通常也在此列（设置项可能是 None）。
        if port != Some(actual) {
            hub.publish_event(ServerEvent::PortChanged { port: actual });
        }
    } else {
        server::stop(&hub);
        let conn = state.db.lock();
        store::set_port(&conn, None)?;
        store::set_enabled(&conn, false)?;
    }
    let status = build_status(&state, &hub)?;
    emit_changed(&app, &status);
    Ok(status)
}

/// 设置绑定模式与端口。正在运行时用新设置重启监听，并把**实际**端口写回设置。
#[tauri::command]
pub fn gateway_set_bind(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    bind_mode: String,
    port: Option<u16>,
) -> Result<GatewayStatus> {
    let mode = BindMode::parse(&bind_mode)
        .ok_or_else(|| ReinError::coded("bad_request", format!("未知绑定模式：{bind_mode}")))?;
    {
        let conn = state.db.lock();
        store::set_bind_mode(&conn, mode)?;
        store::set_port(&conn, port)?;
    }
    if hub.is_running() {
        {
            let conn = state.db.lock();
            store::ensure_pair_token(&conn)?;
        }
        let hub_arc: Arc<GatewayHub> = (*hub).clone();
        server::stop(&hub);
        let actual = server::start(app.clone(), hub_arc, mode, port)?;
        {
            let conn = state.db.lock();
            store::set_port(&conn, Some(actual))?;
        }
        if port != Some(actual) {
            hub.publish_event(ServerEvent::PortChanged { port: actual });
        }
    }
    let status = build_status(&state, &hub)?;
    emit_changed(&app, &status);
    Ok(status)
}

/// 冷启动补漏：所有尚未裁决的授权请求（丢事件也不至于卡住连接）。
#[tauri::command]
pub fn gateway_authorization_pending(
    hub: State<'_, Arc<GatewayHub>>,
) -> Result<Vec<PendingAuth>> {
    Ok(hub.pending_list())
}

/// 前端回传用户对一条待决请求的裁决。成功回空对象 `{}`（契约 §4.5）。
#[tauri::command]
pub fn gateway_authorization_respond(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    request_id: String,
    decision: String,
    scopes: Vec<String>,
) -> Result<serde_json::Value> {
    let scope_set = ScopeSet::parse(&scopes);
    let (pending, conn_id) = hub
        .pending_by_id(&request_id)
        .ok_or_else(|| ReinError::coded("bad_request", "该授权请求不存在或已被处理"))?;

    match decision.as_str() {
        "allow-session" | "allow-always" => {
            let kind = if decision == "allow-always" {
                GrantKind::Always
            } else {
                GrantKind::Session
            };
            let mut token = None;
            {
                let conn = state.db.lock();
                if kind == GrantKind::Always {
                    let t = store::generate_token();
                    store::upsert_allow(
                        &conn,
                        &pending.client_id,
                        &pending.client_name,
                        &scope_set,
                        &store::hash_token(&t),
                        None,
                    )?;
                    token = Some(t);
                }
                store::touch_seen(&conn, &pending.client_id, None)?;
            }
            hub.grant(
                &conn_id,
                ConnGrant {
                    client_id: pending.client_id.clone(),
                    name: pending.client_name.clone(),
                    scopes: scope_set.clone(),
                    kind,
                },
            );
            hub.resolve(
                &request_id,
                AuthDecision::Granted {
                    kind,
                    token,
                    scopes: scope_set,
                },
            )?;
        }
        "deny" => {
            {
                let conn = state.db.lock();
                store::upsert_deny(&conn, &pending.client_id, &pending.client_name, None)?;
            }
            hub.clear_sessions_for_client(&pending.client_id);
            hub.resolve(
                &request_id,
                AuthDecision::Denied {
                    reason: "已被用户拒绝".into(),
                },
            )?;
        }
        "ignore" => {
            {
                let conn = state.db.lock();
                store::record_ignore(&conn, &pending.client_id, &pending.client_name, None)?;
            }
            hub.resolve(&request_id, AuthDecision::Ignored)?;
        }
        other => {
            return Err(ReinError::coded(
                "bad_request",
                format!("未知授权决定：{other}"),
            ))
        }
    }
    let status = build_status(&state, &hub)?;
    emit_changed(&app, &status);
    Ok(serde_json::json!({}))
}

/// 撤销 / 解除一个客户端。
/// - `allow` 行：置 `revoked_at`（令牌立即失效，行保留以便审计与显示「已撤销」）；
///   对**已撤销**的行再调一次 = 删行（把「已撤销」从「被拦下」清单里清出去）。
/// - `deny` 行：删行，「拒绝名单」回到无记录（设置页解除拒绝）。
/// - `ignore` 行（连续忽略进入静默）：删行，清掉限频记录，下次可重新弹窗。
/// 三种情形都清掉该 client 的活动会话授权。
#[tauri::command]
pub fn gateway_revoke_client(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    client_id: String,
) -> Result<GatewayStatus> {
    {
        let conn = state.db.lock();
        match store::find_client(&conn, &client_id)? {
            // 拒绝 / 静默限频 / **已撤销**：解除 = 删行，回到无记录。
            // 已撤销的 allow 行若再次撤销只置位不删，就会永远留在「被拦下」清单里
            // （清单只增不减的死结，同「拒绝无处解除」）。
            Some(row)
                if row.decision == ClientDecision::Deny
                    || row.decision == ClientDecision::Ignore
                    || row.revoked_at.is_some() =>
            {
                store::delete_client(&conn, &client_id)?
            }
            Some(_) => store::revoke_client(&conn, &client_id)?,
            None => {}
        }
    }
    hub.clear_sessions_for_client(&client_id);
    let status = build_status(&state, &hub)?;
    emit_changed(&app, &status);
    Ok(status)
}

/// 写入「允许的网页来源」白名单（整表替换：设置页的增 / 删都走它，contract §15.2a）。
///
/// 传空数组即清空白名单 —— 此后只放行没有 `Origin` 的原生客户端（默认姿态）。
/// 来源的**匹配语义不变**：精确字符串相等，`file://` 页面的 Origin 就是字面量 `"null"`。
#[tauri::command]
pub fn gateway_set_allowed_origins(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    origins: Vec<String>,
) -> Result<GatewayStatus> {
    {
        let conn = state.db.lock();
        store::set_allowed_origins(&conn, &origins)?;
    }
    let status = build_status(&state, &hub)?;
    emit_changed(&app, &status);
    Ok(status)
}

/// 最近的审计记录（设置页「最近访问记录」用，contract §17.3）。
/// `limit` 缺省 50，统一夹到 `[1, 500]`；`clientId` 给了就只看那个客户端。
#[tauri::command]
pub fn gateway_audit_recent(
    state: State<'_, AppState>,
    limit: Option<i64>,
    client_id: Option<String>,
) -> Result<Vec<AuditEntry>> {
    let conn = state.db.lock();
    let limit = limit.unwrap_or(DEFAULT_AUDIT_LIMIT);
    match client_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => store::list_audit_for_client(&conn, id, limit),
        None => store::list_audit(&conn, limit),
    }
}

/// 上报一份番茄钟运行态快照（前端 → 后端，contract §14.1）。原样 JSON 写
/// `app_meta:runtime.focus.v1`，服务端同时落写入时刻（`…​.at`）——陈旧判定（>5s）在
/// 后端做，不信前端自报的 `reportedAt`。前端 `gatewayService.focusPublish` 1 秒一次，
/// 失败由调用方决定是否静默。成功回空对象 `{}`（与其余写命令一致）。
#[tauri::command]
pub fn focus_publish(
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value> {
    {
        let conn = state.db.lock();
        runtime::focus_publish_on(&conn, &snapshot)?;
    }
    // 锁外推给已鉴权且含 pomodoro.read 的连接（contract §14.5）：载荷就是这份快照。
    hub.publish_event(ServerEvent::Focus {
        data: snapshot,
        at: now_millis(),
    });
    Ok(serde_json::json!({}))
}

/// 清除运行态快照（`pause` / `reset` / 相位结束；幂等）。contract §14.1。
/// 清除后向含 `pomodoro.read` 的连接推一条 `data:null` 的运行态事件（§14.5）。
#[tauri::command]
pub fn focus_unpublish(
    state: State<'_, AppState>,
    hub: State<'_, Arc<GatewayHub>>,
) -> Result<serde_json::Value> {
    {
        let conn = state.db.lock();
        runtime::focus_unpublish_on(&conn)?;
    }
    hub.publish_event(ServerEvent::Focus {
        data: serde_json::Value::Null,
        at: now_millis(),
    });
    Ok(serde_json::json!({}))
}

// ---------------------------------------------------------------- 内部

/// `gateway_audit_recent` 不给 `limit` 时的默认条数。
const DEFAULT_AUDIT_LIMIT: i64 = 50;

fn build_status(state: &AppState, hub: &GatewayHub) -> Result<GatewayStatus> {
    let conn = state.db.lock();
    let enabled = store::get_enabled(&conn);
    let bind_mode = store::get_bind_mode(&conn);
    let port = store::get_port(&conn);
    let pair_token = store::get_pair_token(&conn);
    let allowed_origins = store::get_allowed_origins(&conn);
    // 「被拦下的来源」由审计行反解（只列还没加白的那些）——审计表本身钳在最近 500 条。
    let blocked_origins = store::list_blocked_origins(&conn, store::AUDIT_LIMIT_MAX)?;
    let rows = store::list_clients(&conn)?;
    let sessions = hub.session_grants();

    let mut clients: Vec<GatewayClient> = Vec::new();
    let mut blocked: Vec<GatewayBlocked> = Vec::new();
    // 持久「始终允许」的行
    for r in &rows {
        if !r.is_authorized() {
            // 拒绝 / 已撤销：列进「被拦下」清单，设置页可解除（contract §5.1）。
            if r.decision == ClientDecision::Deny || r.revoked_at.is_some() {
                let reason = if r.decision == ClientDecision::Deny {
                    "deny"
                } else {
                    "revoked"
                };
                blocked.push(GatewayBlocked {
                    client_id: r.client_id.clone(),
                    name: r.name.clone(),
                    reason: reason.to_string(),
                    last_seen: r.last_seen_at.clone(),
                    ip: r.last_ip.clone(),
                });
                continue;
            }
            // 纯「忽略」行只是限频记录（读授权等价于不存在）。**只有连续忽略进入静默**才列进
            // blocked —— contract §4.5：blocked = 被拒绝 / 已撤销 / **连续忽略进入静默**的客户端。
            // 只忽略一次的客户端 30s 后还会再弹窗，列进「已忽略」会把「没被拉黑」误报成拉黑。
            if r.decision == ClientDecision::Ignore && ignore_is_silent(r) {
                blocked.push(GatewayBlocked {
                    client_id: r.client_id.clone(),
                    name: r.name.clone(),
                    reason: "ignore".to_string(),
                    last_seen: r.last_seen_at.clone(),
                    ip: r.last_ip.clone(),
                });
            }
            continue;
        }
        clients.push(GatewayClient {
            client_id: r.client_id.clone(),
            name: r.name.clone(),
            grant: GrantKind::Always.as_str().to_string(),
            scopes: r.scopes.to_strings(),
            last_seen: r.last_seen_at.clone(),
            online: sessions.iter().any(|g| g.client_id == r.client_id),
            ip: r.last_ip.clone(),
        });
    }
    // 只在本次会话里被允许、且没有持久行的连接
    for g in &sessions {
        if g.kind != GrantKind::Session {
            continue;
        }
        if clients.iter().any(|c| c.client_id == g.client_id) {
            continue;
        }
        clients.push(GatewayClient {
            client_id: g.client_id.clone(),
            name: g.name.clone(),
            grant: GrantKind::Session.as_str().to_string(),
            scopes: g.scopes.to_strings(),
            last_seen: None,
            online: true,
            ip: None,
        });
    }

    Ok(GatewayStatus {
        enabled,
        bind_mode,
        port,
        pair_token,
        pending_count: hub.pending_len(),
        clients,
        blocked,
        allowed_origins,
        blocked_origins,
    })
}

fn emit_changed(app: &AppHandle, status: &GatewayStatus) {
    let _ = app.emit(EVENT_AUTH_CHANGED, status);
}

/// 事件载荷里的 `at`：epoch 毫秒（contract §14.5 的 `gateway.runtime` 载荷）。
fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 一条「忽略」行的客户端是否已**进入静默**（连续忽略到上限、且已越过 30s 静默窗口）。
/// 只有进入静默才列进 blocked：窗口内那次 30 秒后还会再弹窗，不算已静默（contract §4.5/§16）。
fn ignore_is_silent(r: &ExtClient) -> bool {
    if r.prompt_count < store::MAX_SILENT_PROMPTS {
        return false;
    }
    !r.last_prompt_at
        .as_deref()
        .is_some_and(|t| store::within_ignore_window(t, store::IGNORE_WINDOW_SECS))
}
