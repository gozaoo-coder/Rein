//! 网关的管理面：6 条 tauri 命令（开关 / 绑定 / 状态 / 待决 / 裁决 / 撤销）与 2 个 Tauri 事件。
//!
//! 命令名与事件名字符串**严格照抄** contract §4.5，一个字符都不改 —— 前端
//! `src/services/gatewayService.ts` 要照抄同一套，`scripts/check-ipc-contract.mjs` 会比对。
//!
//! 对外数据方法（`schedule.*` / `workout.*` / `pomodoro.*`）**不**在这里注册成 tauri 命令，
//! 由 `server.rs` 的 WS 私有 router 分发（contract §1.2 / §2.2）。

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::error::{ReinError, Result};
use crate::modules::gateway::auth::{
    AuthDecision, ConnGrant, GatewayHub, GrantKind, PendingAuth, EVENT_AUTH_CHANGED,
};
use crate::modules::gateway::models::{BindMode, ClientDecision, ScopeSet};
use crate::modules::gateway::{server, store};
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
        let conn = state.db.lock();
        store::set_port(&conn, Some(actual))?;
        store::set_enabled(&conn, true)?;
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
        let conn = state.db.lock();
        store::set_port(&conn, Some(actual))?;
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
/// - `allow` 行：置 `revoked_at`（令牌立即失效，行保留以便审计与显示「已撤销」）。
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
            // 拒绝 / 静默限频都是「解除后回到无记录」，直接删行。
            Some(row)
                if row.decision == ClientDecision::Deny
                    || row.decision == ClientDecision::Ignore =>
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

// ---------------------------------------------------------------- 内部

fn build_status(state: &AppState, hub: &GatewayHub) -> Result<GatewayStatus> {
    let conn = state.db.lock();
    let enabled = store::get_enabled(&conn);
    let bind_mode = store::get_bind_mode(&conn);
    let port = store::get_port(&conn);
    let pair_token = store::get_pair_token(&conn);
    let rows = store::list_clients(&conn)?;
    let sessions = hub.session_grants();

    let mut clients: Vec<GatewayClient> = Vec::new();
    let mut blocked: Vec<GatewayBlocked> = Vec::new();
    // 持久「始终允许」的行
    for r in &rows {
        if !r.is_authorized() {
            // 拒绝 / 已撤销 / 静默限频：列进「被拦下」清单，设置页可解除（contract §5.1）。
            let reason = if r.decision == ClientDecision::Deny {
                "deny"
            } else if r.revoked_at.is_some() {
                "revoked"
            } else {
                "ignore"
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
    })
}

fn emit_changed(app: &AppHandle, status: &GatewayStatus) {
    let _ = app.emit(EVENT_AUTH_CHANGED, status);
}
