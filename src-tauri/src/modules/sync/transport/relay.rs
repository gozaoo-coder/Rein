//! 中继链路：打洞不成时，帧借云服务器的**内存邮箱**过一趟。
//!
//! 服务器看到的只是密文（会话层已经端到端加密），而且不落盘：房间是内存里的环形
//! 缓冲，10 分钟没人碰就消失。取件是长轮询（有新帧立刻唤醒），所以在「有来有回」
//! 的同步节奏下延迟是可接受的；真正的带宽需求（大图、语音）优先走前两档。
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

use crate::error::{ReinError, Result};

use super::super::protocol::Link;

/// 一次长轮询最多挂多久（与服务端的 25s 上限对齐）。
const LONG_POLL_MS: u64 = 20_000;
/// 单帧上限，与服务端一致；超了是调用方分片没做好，直接报错比静默截断好。
const MAX_FRAME_BYTES: usize = 256 * 1024;

fn err(msg: impl Into<String>) -> ReinError {
    ReinError::Message(msg.into())
}

pub struct RelayLink {
    agent: ureq::Agent,
    url: String,
    cursor: i64,
    pending: VecDeque<Vec<u8>>,
    up: i64,
    down: i64,
}

impl RelayLink {
    pub fn new(base_url: &str, room: &str) -> Result<Self> {
        let base = base_url.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(err("没有配置在线服务地址，无法用中继"));
        }
        if room.is_empty() {
            return Err(err("还没有配对（缺房间号），无法用中继"));
        }
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(6))
                .timeout(Duration::from_secs(LONG_POLL_MS / 1000 + 20))
                .user_agent(concat!("Rein/", env!("CARGO_PKG_VERSION")))
                .build(),
            url: format!("{base}/api/v1/sync/relay/{room}"),
            cursor: 0,
            pending: VecDeque::new(),
            up: 0,
            down: 0,
        })
    }
}

impl Link for RelayLink {
    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(err("单帧过大，中继不接受（应该走分片）"));
        }
        let resp = self
            .agent
            .post(&self.url)
            .set("content-type", "application/json")
            .send_string(&json!({ "frames": [B64.encode(bytes)] }).to_string())
            .map_err(|e| err(format!("中继投递失败：{e}")))?;
        let v: Value = serde_json::from_str(&resp.into_string().map_err(|e| err(format!("中继回执无法读取：{e}")))?)
            .map_err(|e| err(format!("中继回执无法解析：{e}")))?;
        if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            return Err(err(format!("中继拒绝了这次的帧：{v}")));
        }
        self.up += bytes.len() as i64;
        Ok(())
    }

    fn recv(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(Some(frame));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            let wait = left.min(Duration::from_millis(LONG_POLL_MS)).as_millis();
            let url = format!("{}?after={}&wait={}", self.url, self.cursor, wait);
            let resp = self.agent.get(&url).call().map_err(|e| err(format!("中继取件失败：{e}")))?;
            let v: Value = serde_json::from_str(&resp.into_string().map_err(|e| err(format!("中继取件无法读取：{e}")))?)
                .map_err(|e| err(format!("中继取件无法解析：{e}")))?;
            if let Some(frames) = v.get("frames").and_then(|f| f.as_array()) {
                for f in frames {
                    if let Some(data) = f.get("data").and_then(|x| x.as_str()) {
                        match B64.decode(data) {
                            Ok(bytes) => {
                                self.down += bytes.len() as i64;
                                self.pending.push_back(bytes);
                            }
                            Err(_) => return Err(err("中继来的帧不是合法 base64")),
                        }
                    }
                    if let Some(seq) = f.get("seq").and_then(|x| x.as_i64()) {
                        self.cursor = self.cursor.max(seq);
                    }
                }
            }
            if let Some(frame) = self.pending.pop_front() {
                return Ok(Some(frame));
            }
        }
    }

    fn path(&self) -> String {
        "relay".to_string()
    }

    fn stats(&self) -> (i64, i64) {
        (self.up, self.down)
    }
}
