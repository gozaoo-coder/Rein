//! TCP P2P 通道：服务端监听 + 客户端连接 + 长连接保活

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::sync::store::{now_ts, PairedDevice};
use crate::sync::{Message, TCP_PORT};

pub struct TransportState {
    /// 已建立的 TCP 长连接：device_id -> writer
    pub conns: Arc<Mutex<HashMap<String, Arc<Mutex<TcpStream>>>>>,
}

impl TransportState {
    pub fn new() -> Self {
        Self {
            conns: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// 启动 TCP 服务端
pub fn spawn_server(app: AppHandle) {
    tokio::spawn(async move {
        let listener = match TcpListener::bind(format!("0.0.0.0:{TCP_PORT}")).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("TCP listen bind failed: {e}");
                return;
            }
        };
        log::info!("P2P TCP server listening on :{TCP_PORT}");
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let app_c = app.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_conn(app_c, stream, addr).await {
                            log::warn!("conn handler err: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("accept err: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

/// 主动连接远端
pub fn connect_to(app: &AppHandle, ip: &str, port: u16, device_id: &str) {
    let ip = ip.to_string();
    let did = device_id.to_string();
    let app_c = app.clone();
    tokio::spawn(async move {
        let addr = format!("{ip}:{port}");
        loop {
            match TcpStream::connect(&addr).await {
                Ok(stream) => {
                    log::info!("P2P connected to {addr} ({did})");
                    register_conn(&app_c, &did, stream).await;
                    // 连接建立后触发全量同步
                    let _ = request_full_sync(&app_c, &did).await;
                    // 心跳保活
                    keepalive(&app_c, &did).await;
                    // 连接断开：等待 3s 重连
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

async fn register_conn(app: &AppHandle, device_id: &str, stream: TcpStream) {
    let state = app.state::<crate::sync::SyncState>();
    let mut g = state.transport.conns.lock().await;
    g.insert(device_id.to_string(), Arc::new(Mutex::new(stream)));
}

async fn keepalive(app: &AppHandle, device_id: &str) {
    let state = app.state::<crate::sync::SyncState>();
    loop {
        let conn = {
            let g = state.transport.conns.lock().await;
            g.get(device_id).cloned()
        };
        let Some(conn) = conn else { break; };
        let ping = Message::Ping {
            from: state.device_id.clone(),
            ts: now_ts(),
        };
        let payload = serde_json::to_vec(&ping).unwrap_or_default();
        let mut w = conn.lock().await;
        if write_frame(&mut *w, &payload).await.is_err() {
            drop(w);
            // 断开
            let mut g = state.transport.conns.lock().await;
            g.remove(device_id);
            break;
        }
        drop(w);
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

async fn request_full_sync(app: &AppHandle, device_id: &str) -> Result<(), String> {
    let state = app.state::<crate::sync::SyncState>();
    let conn = {
        let g = state.transport.conns.lock().await;
        g.get(device_id).cloned()
    };
    let conn = conn.ok_or("no connection")?;
    let msg = Message::FullSyncRequest {
        from: state.device_id.clone(),
    };
    let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    let mut w = conn.lock().await;
    write_frame(&mut *w, &payload).await.map_err(|e| e.to_string())
}

/// 处理一条入站连接
async fn handle_conn(app: AppHandle, mut stream: TcpStream, _addr: std::net::SocketAddr) -> Result<(), String> {
    loop {
        let frame = read_frame(&mut stream).await?;
        let msg: Message = serde_json::from_slice(&frame).map_err(|e| e.to_string())?;
        if let Err(e) = handle_message(&app, &mut stream, msg).await {
            log::warn!("msg handler err: {e}");
        }
    }
}

async fn handle_message(app: &AppHandle, stream: &mut TcpStream, msg: Message) -> Result<(), String> {
    let state = app.state::<crate::sync::SyncState>();
    match msg {
        Message::Ping { .. } => {
            // 心跳：无需回复
        }
        Message::PairRequest { from_id, from_name, code } => {
            // 验证码 + 防撞码
            if !crate::sync::pairing::verify_pair_code(&from_id, &code) {
                let reject = Message::PairReject {
                    from_id: state.device_id.clone(),
                    to_id: from_id.clone(),
                };
                send(stream, &reject).await?;
                return Ok(());
            }
            // 前端弹窗确认
            let _ = app.emit("sync-pair-request", &serde_json::json!({
                "from_id": from_id,
                "from_name": from_name,
            }));
            // 等待前端通过 sync_pair_respond 命令回送结果
            // 简化：返回 ack，前端异步处理
        }
        Message::PairAccept { from_id, from_name, to_id } => {
            if to_id != state.device_id {
                return Ok(());
            }
            // 双方互写授权
            state.store.add_paired(PairedDevice {
                device_id: from_id.clone(),
                name: from_name,
                ip: String::new(),
                port: TCP_PORT,
                paired_at: now_ts(),
            }).await;
            let _ = app.emit("sync-pair-success", &serde_json::json!({ "device_id": from_id }));
        }
        Message::PairReject { from_id: _, to_id } => {
            if to_id == state.device_id {
                let _ = app.emit("sync-pair-rejected", &serde_json::json!({}));
            }
        }
        Message::FullSyncRequest { from } => {
            let records = state.store.all_records().await;
            let resp = Message::FullSyncResponse { records };
            send(stream, &resp).await?;
            let _ = from;
        }
        Message::FullSyncResponse { records } => {
            let mut guard = state.store.records.write().await;
            let changed = crate::sync::merge::merge_into(&mut guard, records);
            drop(guard);
            if changed {
                state.store.persist_records().await;
                let _ = app.emit("sync-records-updated", &serde_json::json!({}));
            }
        }
        Message::RecordChange { record } => {
            let mut guard = state.store.records.write().await;
            let changed = crate::sync::merge::merge_one(&mut guard, record);
            drop(guard);
            if changed {
                state.store.persist_records().await;
                let _ = app.emit("sync-records-updated", &serde_json::json!({}));
            }
        }
        Message::PairedList { ids } => {
            let _ = ids;
        }
    }
    Ok(())
}

/// 推送单条变更到所有已连接的配对设备
pub async fn broadcast_change(app: &AppHandle, record: crate::sync::store::Record) {
    let state = app.state::<crate::sync::SyncState>();
    let conns = state.transport.conns.lock().await.clone();
    let msg = Message::RecordChange { record };
    let payload = serde_json::to_vec(&msg).unwrap_or_default();
    for (_id, conn) in conns {
        let mut w = conn.lock().await;
        let _ = write_frame(&mut *w, &payload).await;
    }
}

async fn send(stream: &mut TcpStream, msg: &Message) -> Result<(), String> {
    let payload = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    write_frame(stream, &payload).await.map_err(|e| e.to_string())
}

/// 长度前缀帧：4 字节大端长度 + payload
async fn write_frame(w: &mut (impl AsyncWriteExt + Unpin), payload: &[u8]) -> std::io::Result<()> {
    let len = payload.len() as u32;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

async fn read_frame(r: &mut (impl AsyncReadExt + Unpin)) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await.map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > 10 * 1024 * 1024 {
        return Err("frame too large".into());
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(buf)
}
