//! 同步域的数据结构（跨 IPC 的那些）。

use serde::{Deserialize, Serialize};

/// 一台已配对的设备。`path` 是上次同步走成的传输路径（`lan` / `punch` / `relay`）——
/// 界面上如实显示它，用户才看得到「打洞到底通没通」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPeerInfo {
    pub device: String,
    pub short: String,
    pub name: String,
    pub fingerprint: String,
    pub path: Option<String>,
    pub last_seen: Option<i64>,
    /// 已送达 / 已确认的复制日志序号（增量同步的进度）
    pub seq_sent: i64,
    pub seq_ack: i64,
}

/// 本机同步状态：设置页那一张卡片的全部输入。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub device_id: String,
    pub device_short: String,
    pub device_name: String,
    /// 公钥指纹（8 字节 hex，给人核对两台设备是不是同一对）
    pub fingerprint: String,
    /// 是否已经入组（入组 = 至少配过一台设备）
    pub in_group: bool,
    pub group_id: Option<String>,
    pub peers: Vec<SyncPeerInfo>,
    /// 对象总数 / 墓碑数 / 复制日志长度
    pub objects: i64,
    pub tombstones: i64,
    pub log_len: i64,
    /// 待处理的本地改动（脏队列积压）
    pub pending: i64,
    /// 还差几张表没补录存量（首次运行或表结构刚变过；0 = 已补齐）
    pub stale_tables: i64,
    pub conflicts: i64,
    pub last_at: Option<i64>,
    pub last_path: Option<String>,
    pub last_up: i64,
    pub last_down: i64,
}

/// 同步设置（存 `sync_meta`，与业务数据一起同步没有意义，因此只在本机）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    /// 打开应用时自动同步
    pub auto: bool,
    /// 自动同步的最小间隔（分钟）
    pub interval_min: i64,
    /// 允许走蜂窝网络同步媒体（大块）
    pub media_over_cellular: bool,
    /// 打洞失败时自动落云端中继（关掉则只在局域网/打洞可用时同步）
    pub auto_over_relay: bool,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            auto: true,
            interval_min: 15,
            media_over_cellular: false,
            auto_over_relay: true,
        }
    }
}

/// `sync_set_settings` 的入参：只带要改的字段。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettingsPatch {
    pub auto: Option<bool>,
    pub interval_min: Option<i64>,
    pub media_over_cellular: Option<bool>,
    pub auto_over_relay: Option<bool>,
}
