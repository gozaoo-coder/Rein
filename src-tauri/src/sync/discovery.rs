//! UDP 局域网发现：每 5 秒广播自身 + 监听他人广播

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::sync::UDP_PORT;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Broadcast {
    pub device_id: String,
    pub name: String,
    pub port: u16, // TCP port
}

pub struct DiscoveryState {
    pub online: Arc<RwLock<Vec<crate::sync::DiscoveredDevice>>>,
    /// 设备最后一次被发现的时间戳（秒）
    pub last_seen: Arc<RwLock<HashMap<String, u64>>>,
}

impl DiscoveryState {
    pub fn new() -> Self {
        Self {
            online: Arc::new(RwLock::new(Vec::new())),
            last_seen: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 启动广播 + 监听任务
pub fn spawn(app: AppHandle, device_id: String, device_name: String) {
    // 广播任务
    let app_b = app.clone();
    let did_b = device_id.clone();
    let dname_b = device_name.clone();
    tokio::spawn(async move {
        let sock = match UdpSocket::bind("0.0.0.0:0") {
            Ok(s) => s,
            Err(e) => {
                log::error!("UDP broadcast bind failed: {e}");
                return;
            }
        };
        let _ = sock.set_broadcast(true);
        let bc = Broadcast {
            device_id: did_b,
            name: dname_b,
            port: crate::sync::TCP_PORT,
        };
        let payload = serde_json::to_vec(&bc).unwrap_or_default();
        let addr: SocketAddr = format!("255.255.255.255:{UDP_PORT}").parse().unwrap();
        loop {
            if sock.send_to(&payload, addr).is_err() {
                // 网络瞬时错误：忽略
            }
            // 清理超时在线设备（>20s 未刷新）
            {
                let state = app_b.state::<crate::sync::SyncState>();
                let now = now_secs();
                let mut last_seen = state.discovery.last_seen.write().await;
                last_seen.retain(|_id, ts| now.saturating_sub(*ts) < 20);
                let stale_ids: Vec<String> = last_seen
                    .keys()
                    .cloned()
                    .collect();
                drop(last_seen);
                let mut online = state.discovery.online.write().await;
                online.retain(|d| stale_ids.contains(&d.device_id));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // 监听任务
    let app_l = app.clone();
    let did_l = device_id.clone();
    tokio::spawn(async move {
        let sock = match UdpSocket::bind(format!("0.0.0.0:{UDP_PORT}")) {
            Ok(s) => s,
            Err(e) => {
                log::error!("UDP listen bind failed: {e}");
                return;
            }
        };
        let mut buf = [0u8; 512];
        loop {
            match sock.recv_from(&mut buf) {
                Ok((n, src)) => {
                    let data = &buf[..n];
                    let bc: Broadcast = match serde_json::from_slice(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if bc.device_id == did_l {
                        continue; // 忽略自身
                    }
                    let state = app_l.state::<crate::sync::SyncState>();
                    let paired = state.store.is_paired(&bc.device_id).await;
                    let dev = crate::sync::DiscoveredDevice {
                        device_id: bc.device_id.clone(),
                        name: bc.name.clone(),
                        ip: src.ip().to_string(),
                        port: bc.port,
                        paired,
                    };
                    {
                        let mut last_seen = state.discovery.last_seen.write().await;
                        last_seen.insert(dev.device_id.clone(), now_secs());
                        let mut g = state.discovery.online.write().await;
                        if let Some(existing) = g.iter_mut().find(|d| d.device_id == dev.device_id) {
                            *existing = dev.clone();
                        } else {
                            g.push(dev.clone());
                        }
                    }
                    let _ = app_l.emit("sync-device-discovered", &dev);
                    // 若已配对，自动建立 TCP 连接
                    if paired {
                        crate::sync::transport::connect_to(&app_l, &dev.ip, dev.port, &bc.device_id);
                    }
                }
                Err(e) => {
                    log::warn!("UDP recv err: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}
