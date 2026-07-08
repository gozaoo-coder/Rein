pub mod discovery;
pub mod merge;
pub mod pairing;
pub mod store;
pub mod transport;

pub use discovery::DiscoveryState;
pub use pairing::{current_pair_code, code_remaining_secs, PairingState};
pub use transport::TransportState;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::sync::store::SyncStore;

/// P2P 同步总状态
pub struct SyncState {
    pub store: Arc<SyncStore>,
    pub pairing: Arc<pairing::PairingState>,
    pub discovery: Arc<discovery::DiscoveryState>,
    pub transport: Arc<transport::TransportState>,
    pub device_id: String,
    pub device_name: String,
}

/// 网络上发现的设备
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredDevice {
    pub device_id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub paired: bool,
}

/// 传输消息（TCP 长连接帧）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Message {
    /// 心跳
    Ping { from: String, ts: u64 },
    /// 配对请求
    PairRequest {
        from_id: String,
        from_name: String,
        code: String,
    },
    /// 配对同意
    PairAccept {
        from_id: String,
        from_name: String,
        from_ip: String,
        from_port: u16,
        to_id: String,
    },
    /// 配对拒绝
    PairReject { from_id: String, to_id: String },
    /// 全量数据请求
    FullSyncRequest { from: String },
    /// 全量数据响应
    FullSyncResponse { records: Vec<store::Record> },
    /// 单条增量变更
    RecordChange { record: store::Record },
    /// 已配对设备名单同步
    PairedList { ids: Vec<String> },
}

pub const UDP_PORT: u16 = 17732;
pub const TCP_PORT: u16 = 17733;
pub const PAIR_CODE_TTL_SECS: u64 = 30;
pub const PAIR_REQUEST_COOLDOWN_SECS: u64 = 300;
