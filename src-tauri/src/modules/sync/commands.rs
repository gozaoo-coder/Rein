//! 同步域的 IPC 命令。业务逻辑在 `engine` / `link` 等子模块里，这里只做参数校验与落库。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::identity;
use super::models::{PairOffer, PairStatus, SyncPeerInfo, SyncStatus};

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0)
}

/// 本机同步状态（设置页那张卡片的全部输入）。
#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    let conn = state.db.lock();
    let me = identity::ensure(&conn)?;

    let mut peers: Vec<SyncPeerInfo> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT device, name, x25519_pub, last_seen, path, last_seq_sent, last_seq_ack \
             FROM sync_peers ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let device: String = r.get(0)?;
            let name: String = r.get(1)?;
            let public: String = r.get(2)?;
            let dec = super::identity::decode_public(&public);
            Ok(SyncPeerInfo {
                short: identity::short(&device),
                fingerprint: dec.map(|p| identity::fingerprint(&p)).unwrap_or_default(),
                device,
                name,
                path: r.get(4)?,
                last_seen: r.get(3)?,
                seq_sent: r.get(5)?,
                seq_ack: r.get(6)?,
            })
        })?;
        for row in rows {
            peers.push(row?);
        }
    }

    let group_id = super::meta_get(&conn, "group_id").filter(|s| !s.is_empty());

    Ok(SyncStatus {
        device_short: identity::short(&me.device_id),
        fingerprint: identity::fingerprint(&me.public),
        device_id: me.device_id,
        device_name: me.name,
        in_group: group_id.is_some() || !peers.is_empty(),
        group_id,
        peers,
        objects: count(&conn, "SELECT COUNT(*) FROM sync_objects WHERE deleted = 0"),
        tombstones: count(&conn, "SELECT COUNT(*) FROM sync_objects WHERE deleted = 1"),
        log_len: count(&conn, "SELECT COUNT(*) FROM sync_log"),
        // 脏队列在里程碑 2 接上；在此之前如实报 0（而不是编一个数字）
        pending: super::pending_count(),
        stale_tables: super::engine::stale_tables(&conn).unwrap_or(-1),
        conflicts: count(&conn, "SELECT COUNT(*) FROM sync_conflicts"),
        last_at: super::meta_get(&conn, "last_at").and_then(|v| v.parse().ok()),
        last_path: super::meta_get(&conn, "last_path").filter(|s| !s.is_empty()),
        last_up: super::meta_get(&conn, "last_up")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        last_down: super::meta_get(&conn, "last_down")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    })
}

/// 改设备名（设置页）。
#[tauri::command]
pub fn sync_set_device_name(state: State<'_, AppState>, name: String) -> Result<SyncStatus> {
    {
        let conn = state.db.lock();
        identity::set_name(&conn, &name)?;
    }
    sync_status(state)
}

// ---------- 配对：开码 / 轮询 / 报码 ----------

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(6))
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("Rein/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn post_json(url: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    let resp = agent()
        .post(url)
        .set("content-type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| ReinError::Message(format!("连不上在线服务：{e}")))?;
    let text = resp.into_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| ReinError::Message(format!("服务回执看不懂：{text}")))
}

fn get_json(url: &str) -> Result<serde_json::Value> {
    let resp = agent()
        .get(url)
        .call()
        .map_err(|e| ReinError::Message(format!("连不上在线服务：{e}")))?;
    let text = resp.into_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| ReinError::Message(format!("服务回执看不懂：{text}")))
}

fn service_base(conn: &Connection) -> Result<String> {
    let base = super::runner::server_base(conn);
    if base.is_empty() {
        return Err(ReinError::Message(
            "还没配在线服务地址（设置 → 在线服务，与更新、模型网关共用同一台）".into(),
        ));
    }
    Ok(base)
}

fn peer_info(conn: &Connection, device: &str) -> Option<SyncPeerInfo> {
    conn.query_row(
        "SELECT device, name, x25519_pub, last_seen, path, last_seq_sent, last_seq_ack FROM sync_peers WHERE device = ?1",
        [device],
        |r| {
            let device: String = r.get(0)?;
            let public: String = r.get(2)?;
            let dec = identity::decode_public(&public);
            Ok(SyncPeerInfo {
                short: identity::short(&device),
                fingerprint: dec.map(|p| identity::fingerprint(&p)).unwrap_or_default(),
                device,
                name: r.get(1)?,
                path: r.get(4)?,
                last_seen: r.get(3)?,
                seq_sent: r.get(5)?,
                seq_ack: r.get(6)?,
            })
        },
    )
    .ok()
}

/// 开码：本机开一个 5 分钟有效的短码，念给另一台设备。
#[tauri::command]
pub async fn sync_pair_start(app: AppHandle) -> Result<PairOffer> {
    tauri::async_runtime::spawn_blocking(move || -> Result<PairOffer> {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let me = identity::ensure(&conn)?;
        let base = service_base(&conn)?;
        let v = post_json(
            &format!("{base}/api/v1/sync/pair"),
            &serde_json::json!({ "device": me.device_id, "pub": B64.encode(me.public) }),
        )?;
        let code = v.get("code").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if code.is_empty() {
            return Err(ReinError::Message(format!("服务没有给出同步码：{v}")));
        }
        super::meta_set(&conn, "pair_code", &code)?;
        Ok(PairOffer {
            code,
            expires_at: v.get("expiresAt").and_then(|x| x.as_i64()).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| ReinError::Message(format!("配对任务失败：{e}")))?
}

/// 开码侧轮询：有人报码了就落库（组密钥 + 房间号 + 对端公钥）。
#[tauri::command]
pub async fn sync_pair_poll(app: AppHandle) -> Result<PairStatus> {
    tauri::async_runtime::spawn_blocking(move || -> Result<PairStatus> {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let me = identity::ensure(&conn)?;
        let code = super::meta_get(&conn, "pair_code").unwrap_or_default();
        if code.is_empty() {
            return Ok(PairStatus {
                pending: false,
                peer: None,
                room: None,
            });
        }
        let base = service_base(&conn)?;
        let v = get_json(&format!("{base}/api/v1/sync/pair/{code}"))?;
        let peer = v.get("peer");
        let room = v.get("room").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let device = peer.and_then(|p| p.get("device")).and_then(|x| x.as_str()).unwrap_or("");
        let public = peer.and_then(|p| p.get("pub")).and_then(|x| x.as_str()).unwrap_or("");
        if device.is_empty() || public.is_empty() || room.is_empty() {
            return Ok(PairStatus {
                pending: true,
                peer: None,
                room: None,
            });
        }
        let paired = super::runner::accept_pairing(&conn, &me, device, public, &code, &room)?;
        super::meta_set(&conn, "pair_code", "")?;
        Ok(PairStatus {
            pending: false,
            peer: peer_info(&conn, &paired.device),
            room: Some(room),
        })
    })
    .await
    .map_err(|e| ReinError::Message(format!("配对任务失败：{e}")))?
}

/// 报码：输入另一台设备上的短码；房间号由本机生成后交给服务端转达。
#[tauri::command]
pub async fn sync_pair_claim(app: AppHandle, code: String) -> Result<PairStatus> {
    tauri::async_runtime::spawn_blocking(move || -> Result<PairStatus> {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let me = identity::ensure(&conn)?;
        let base = service_base(&conn)?;
        let clean = code.trim().to_uppercase();
        if clean.len() < 6 {
            return Err(ReinError::Message("同步码不对（应是 8 位字母数字）".into()));
        }
        let room = super::runner::new_room();
        let v = post_json(
            &format!("{base}/api/v1/sync/pair/{clean}"),
            &serde_json::json!({ "device": me.device_id, "pub": B64.encode(me.public), "room": room }),
        )?;
        let peer = v.get("peer");
        let device = peer.and_then(|p| p.get("device")).and_then(|x| x.as_str()).unwrap_or("");
        let public = peer.and_then(|p| p.get("pub")).and_then(|x| x.as_str()).unwrap_or("");
        if device.is_empty() || public.is_empty() {
            return Err(ReinError::Message(format!("服务没有给出对端：{v}")));
        }
        let paired = super::runner::accept_pairing(&conn, &me, device, public, &clean, &room)?;
        Ok(PairStatus {
            pending: false,
            peer: peer_info(&conn, &paired.device),
            room: Some(room),
        })
    })
    .await
    .map_err(|e| ReinError::Message(format!("配对任务失败：{e}")))?
}

// ---------- 同步 ----------

/// 跑一轮同步（后台线程，结果用 `sync://result` 事件回报）。
/// 同一进程同一时间只允许一次会话：两条会话会互相踩对方的复制游标（游标回退、对象重发）。
static SESSION_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn sync_run(app: AppHandle) -> Result<()> {
    if SESSION_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err(ReinError::Message("上一次同步还在跑，等它结束".into()));
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("rein-sync-run".into())
        .spawn(move || {
            let outcome = (|| -> Result<(Vec<super::runner::RunStats>, Vec<String>)> {
                let state = handle.state::<AppState>();
                let hub = handle.state::<super::engine::SyncHub>();
                let store = super::blobs::BlobStore::new(hub.data_dir());
                let conn = state.db.lock();
                let me = identity::ensure(&conn)?;
                // 先把手头还没落成对象的改动冲掉，否则「刚改的没过去」
                hub.flush(&conn, &store, &me.device_id)?;
                super::runner::run_all(&conn, &store, &me)
            })();
            let payload = match outcome {
                Ok((stats, errors)) => serde_json::json!({ "ok": errors.is_empty(), "stats": stats, "errors": errors }),
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
            };
            let _ = handle.emit("sync://result", payload);
            SESSION_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    if let Err(e) = spawned {
        SESSION_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        return Err(ReinError::Message(format!("起不了同步线程：{e}")));
    }
    Ok(())
}

/// 解除一台设备的配对；解开最后一台时整组退掉（下次要重新配对）。
#[tauri::command]
pub fn sync_forget(state: State<'_, AppState>, device: String) -> Result<SyncStatus> {
    {
        let conn = state.db.lock();
        conn.execute("DELETE FROM sync_peers WHERE device = ?1", [&device])?;
        let left = count(&conn, "SELECT COUNT(*) FROM sync_peers");
        if left == 0 {
            super::meta_set(&conn, "group_secret", "")?;
            super::meta_set(&conn, "group_id", "")?;
        }
    }
    sync_status(state)
}
