//! 全局应用状态：单个 SQLite 连接（桌面单窗口场景足够；并发瓶颈出现时再引入连接池）。

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use tokio::sync::mpsc::UnboundedSender;

use crate::modules::voice::protocol::AsrCmd;

/// 语音识别会话注册表：sessionId → 命令通道（音频包/结束/取消）。
/// 识别任务由 `voice_asr_start` spawn，命令经通道送进 WS 任务。
pub struct VoiceHub {
    pub sessions: Mutex<HashMap<String, UnboundedSender<AsrCmd>>>,
}

impl VoiceHub {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

pub struct AppState {
    pub db: Mutex<Connection>,
}

impl AppState {
    pub fn new(db: Connection) -> Self {
        Self { db: Mutex::new(db) }
    }
}
