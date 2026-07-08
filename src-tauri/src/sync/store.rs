//! 内存状态 + JSON 文件持久化
//!
//! 数据：Vec<Record>，Arc<RwLock<>> 保护
//! 持久化：debounced 异步写入 data.json
//! 配对设备：Vec<Device>，paired.json

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::fs;
use tokio::sync::RwLock;

use crate::sync::DiscoveredDevice;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub content: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedDevice {
    pub device_id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub paired_at: u64,
}

pub struct SyncStore {
    pub records: Arc<RwLock<Vec<Record>>>,
    pub paired: Arc<RwLock<Vec<PairedDevice>>>,
    pub dir: PathBuf,
}

impl SyncStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            records: Arc::new(RwLock::new(Vec::new())),
            paired: Arc::new(RwLock::new(Vec::new())),
            dir,
        }
    }

    pub async fn load(&self) -> std::io::Result<()> {
        let data_path = self.dir.join("sync-data.json");
        if let Ok(s) = fs::read_to_string(&data_path).await {
            if let Ok(v) = serde_json::from_str::<Vec<Record>>(&s) {
                *self.records.write().await = v;
            }
        }
        let paired_path = self.dir.join("paired-devices.json");
        if let Ok(s) = fs::read_to_string(&paired_path).await {
            if let Ok(v) = serde_json::from_str::<Vec<PairedDevice>>(&s) {
                *self.paired.write().await = v;
            }
        }
        Ok(())
    }

    pub async fn persist_records(&self) {
        let path = self.dir.join("sync-data.json");
        let guard = self.records.read().await;
        let s = serde_json::to_string_pretty(&*guard).unwrap_or_else(|_| "[]".into());
        drop(guard);
        let _ = fs::write(&path, s).await;
    }

    pub async fn persist_paired(&self) {
        let path = self.dir.join("paired-devices.json");
        let guard = self.paired.read().await;
        let s = serde_json::to_string_pretty(&*guard).unwrap_or_else(|_| "[]".into());
        drop(guard);
        let _ = fs::write(&path, s).await;
    }

    pub async fn add_paired(&self, dev: PairedDevice) {
        let mut guard = self.paired.write().await;
        if !guard.iter().any(|d| d.device_id == dev.device_id) {
            guard.push(dev);
        }
        drop(guard);
        self.persist_paired().await;
    }

    pub async fn remove_paired(&self, device_id: &str) {
        let mut guard = self.paired.write().await;
        guard.retain(|d| d.device_id != device_id);
        drop(guard);
        self.persist_paired().await;
    }

    pub async fn is_paired(&self, device_id: &str) -> bool {
        self.paired.read().await.iter().any(|d| d.device_id == device_id)
    }

    pub async fn paired_list(&self) -> Vec<PairedDevice> {
        self.paired.read().await.clone()
    }

    pub async fn all_records(&self) -> Vec<Record> {
        self.records.read().await.clone()
    }

    /// 本地写入：新增 / 编辑 / 软删除
    pub async fn upsert_local(&self, rec: Record) {
        let mut guard = self.records.write().await;
        if let Some(existing) = guard.iter_mut().find(|r| r.id == rec.id) {
            *existing = rec.clone();
        } else {
            guard.push(rec);
        }
        drop(guard);
        self.persist_records().await;
    }

    pub async fn delete_local(&self, id: &str) {
        let mut guard = self.records.write().await;
        if let Some(r) = guard.iter_mut().find(|r| r.id == id) {
            r.deleted_at = Some(now_ts());
            r.updated_at = now_ts();
        }
        drop(guard);
        self.persist_records().await;
    }
}

pub fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn init_store(app: &tauri::App) -> SyncStore {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app_data_dir should resolve");
    let _ = std::fs::create_dir_all(&dir);
    SyncStore::new(dir)
}

/// 把 PairedDevice 转成 DiscoveredDevice（供前端展示）
pub fn paired_to_discovered(p: &PairedDevice) -> DiscoveredDevice {
    DiscoveredDevice {
        device_id: p.device_id.clone(),
        name: p.name.clone(),
        ip: p.ip.clone(),
        port: p.port,
        paired: true,
    }
}
