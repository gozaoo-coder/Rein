//! Tauri commands for P2P sync

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::sync::store::{now_ts, PairedDevice, Record};
use crate::sync::{current_pair_code, code_remaining_secs, SyncState, DiscoveredDevice};

/// 获取本机设备信息
#[tauri::command]
pub fn sync_device_info(state: State<SyncState>) -> serde_json::Value {
    serde_json::json!({
        "device_id": state.device_id,
        "device_name": state.device_name,
    })
}

/// 获取当前 30 秒匹配码
#[tauri::command]
pub fn sync_pair_code(state: State<SyncState>) -> serde_json::Value {
    serde_json::json!({
        "code": current_pair_code(&state.device_id),
        "remaining_secs": code_remaining_secs(),
        "ttl": crate::sync::PAIR_CODE_TTL_SECS,
    })
}

/// 发起配对请求：检查防撞码 → TCP 发送 PairRequest
#[tauri::command]
pub async fn sync_pair_request(
    app: AppHandle,
    state: State<'_, SyncState>,
    target_device_id: String,
    target_ip: String,
    target_port: u16,
    target_code: String,
) -> Result<(), String> {
    // 防撞码
    state.pairing.check_cooldown(&target_device_id).map_err(|secs| {
        format!("请等待 {secs} 秒后再次发起配对")
    })?;
    // 验证对方匹配码（我们这边不可验证，由对方验证；这里仅本地防撞）
    state.pairing.mark_request(&target_device_id);

    // 通过 TCP 发送请求
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    let mut stream = TcpStream::connect(format!("{target_ip}:{target_port}"))
        .await
        .map_err(|e| format!("无法连接 {target_ip}:{target_port}: {e}"))?;
    let msg = crate::sync::Message::PairRequest {
        from_id: state.device_id.clone(),
        from_name: state.device_name.clone(),
        code: target_code,
    };
    let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let len = payload.len() as u32;
    stream.write_all(&len.to_be_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(&payload).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    // 注册到连接池（保持长连接）
    let conn = Arc::new(tokio::sync::Mutex::new(stream));
    state.transport.conns.lock().await.insert(target_device_id.clone(), conn);

    let _ = app.emit("sync-pair-pending", &serde_json::json!({ "target": target_device_id }));
    Ok(())
}

/// 接收端：用户同意/拒绝配对
#[tauri::command]
pub async fn sync_pair_respond(
    app: AppHandle,
    state: State<'_, SyncState>,
    from_id: String,
    from_name: String,
    from_ip: String,
    from_port: u16,
    accept: bool,
) -> Result<(), String> {
    let msg = if accept {
        // 双方互写
        state.store.add_paired(PairedDevice {
            device_id: from_id.clone(),
            name: from_name.clone(),
            ip: from_ip.clone(),
            port: from_port,
            paired_at: now_ts(),
        }).await;
        crate::sync::Message::PairAccept {
            from_id: state.device_id.clone(),
            from_name: state.device_name.clone(),
            to_id: from_id.clone(),
        }
    } else {
        crate::sync::Message::PairReject {
            from_id: state.device_id.clone(),
            to_id: from_id.clone(),
        }
    };
    // 推送给对方
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    let mut stream = TcpStream::connect(format!("{from_ip}:{from_port}"))
        .await
        .map_err(|e| format!("无法连接: {e}"))?;
    let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let len = payload.len() as u32;
    stream.write_all(&len.to_be_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(&payload).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())?;

    // 若同意：注册长连接并自动开始全量同步
    if accept {
        let conn = Arc::new(tokio::sync::Mutex::new(stream));
        state.transport.conns.lock().await.insert(from_id.clone(), conn);
        crate::sync::transport::connect_to(&app, &from_ip, from_port, &from_id);
        let _ = app.emit("sync-pair-success", &serde_json::json!({ "device_id": from_id }));
    }
    Ok(())
}

/// 取消配对（移除已配对设备）
#[tauri::command]
pub async fn sync_unpair(state: State<'_, SyncState>, device_id: String) -> Result<(), String> {
    state.store.remove_paired(&device_id).await;
    // 断开 TCP
    state.transport.conns.lock().await.remove(&device_id);
    Ok(())
}

/// 获取已配对设备列表
#[tauri::command]
pub async fn sync_paired_list(state: State<'_, SyncState>) -> Result<Vec<PairedDevice>, String> {
    Ok(state.store.paired_list().await)
}

/// 获取在线设备列表
#[tauri::command]
pub async fn sync_online_list(state: State<'_, SyncState>) -> Result<Vec<DiscoveredDevice>, String> {
    Ok(state.discovery.online.read().await.clone())
}

/// 读取所有同步记录
#[tauri::command]
pub async fn sync_records_list(state: State<'_, SyncState>) -> Result<Vec<Record>, String> {
    Ok(state.store.all_records().await)
}

/// 新增/编辑本地记录（同时推送给所有配对设备）
#[tauri::command]
pub async fn sync_record_upsert(
    app: AppHandle,
    state: State<'_, SyncState>,
    id: String,
    content: String,
) -> Result<Record, String> {
    let ts = now_ts();
    let rec = Record {
        id,
        content,
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
    };
    state.store.upsert_local(rec.clone()).await;
    crate::sync::transport::broadcast_change(&app, rec.clone()).await;
    Ok(rec)
}

/// 软删除记录
#[tauri::command]
pub async fn sync_record_delete(
    app: AppHandle,
    state: State<'_, SyncState>,
    id: String,
) -> Result<(), String> {
    state.store.delete_local(&id).await;
    // 推送软删除版本
    let ts = now_ts();
    let rec = Record {
        id,
        content: String::new(),
        created_at: ts,
        updated_at: ts,
        deleted_at: Some(ts),
    };
    crate::sync::transport::broadcast_change(&app, rec).await;
    Ok(())
}
