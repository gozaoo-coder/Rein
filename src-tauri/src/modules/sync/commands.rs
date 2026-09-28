//! 同步域的 IPC 命令。业务逻辑在 `engine` / `link` 等子模块里，这里只做参数校验与落库。

use rusqlite::Connection;
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

use super::identity;
use super::models::{SyncPeerInfo, SyncStatus};

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0)
}

/// 本机同步状态（设置页那张卡片的全部输入）。
#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    let conn = state.db.lock().unwrap();
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
        let conn = state.db.lock().unwrap();
        identity::set_name(&conn, &name)?;
    }
    sync_status(state)
}
