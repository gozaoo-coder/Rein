//! 动态匹配码 + 防撞码
//!
//! 匹配码：基于设备 ID + 30s 时间窗 hash 6 位
//! 防撞码：HashMap<target_device_id, last_request_time>，5 分钟内拒绝

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::sync::{PAIR_CODE_TTL_SECS, PAIR_REQUEST_COOLDOWN_SECS};

pub struct PairingState {
    /// 目标设备 ID -> 上次发起配对请求时间
    pub last_request: Mutex<HashMap<String, SystemTime>>,
}

impl PairingState {
    pub fn new() -> Self {
        Self {
            last_request: Mutex::new(HashMap::new()),
        }
    }

    /// 检查防撞码：返回 Ok 或剩余秒数
    pub fn check_cooldown(&self, target_id: &str) -> Result<(), u64> {
        let guard = self.last_request.lock().ok();
        if let Some(g) = guard {
            if let Some(last) = g.get(target_id) {
                let elapsed = SystemTime::now()
                    .duration_since(*last)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if elapsed < PAIR_REQUEST_COOLDOWN_SECS {
                    return Err(PAIR_REQUEST_COOLDOWN_SECS - elapsed);
                }
            }
        }
        Ok(())
    }

    /// 标记已对某目标发起请求
    pub fn mark_request(&self, target_id: &str) {
        if let Ok(mut g) = self.last_request.lock() {
            g.insert(target_id.to_string(), SystemTime::now());
        }
    }
}

/// 生成当前 30 秒窗口的 6 位匹配码
pub fn current_pair_code(device_id: &str) -> String {
    let window = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() / PAIR_CODE_TTL_SECS)
        .unwrap_or(0);
    code_for_window(device_id, window)
}

/// 给定时间窗的 6 位匹配码
fn code_for_window(device_id: &str, window: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hasher.update(window.to_le_bytes());
    let hash = hasher.finalize();
    // 取前 6 字节，模 1e6
    let n: u64 = (hash[0] as u64)
        | ((hash[1] as u64) << 8)
        | ((hash[2] as u64) << 16)
        | ((hash[3] as u64) << 24)
        | ((hash[4] as u64) << 32)
        | ((hash[5] as u64) << 40);
    format!("{:06}", n % 1_000_000)
}

/// 验证对方匹配码：当前窗口或上一窗口合法
pub fn verify_pair_code(device_id: &str, code: &str) -> bool {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let window = now / PAIR_CODE_TTL_SECS;
    let cur = code_for_window(device_id, window);
    let prev = code_for_window(device_id, window.saturating_sub(1));
    code == cur || code == prev
}

/// 剩余多少秒滚动到下一码
pub fn code_remaining_secs() -> u64 {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    PAIR_CODE_TTL_SECS - (now % PAIR_CODE_TTL_SECS)
}

#[allow(dead_code)]
pub fn cooldown_remaining(state: &PairingState, target_id: &str) -> Option<Duration> {
    let g = state.last_request.lock().ok()?;
    let last = *g.get(target_id)?;
    let elapsed = SystemTime::now().duration_since(last).ok()?;
    if elapsed.as_secs() < PAIR_REQUEST_COOLDOWN_SECS {
        Some(Duration::from_secs(PAIR_REQUEST_COOLDOWN_SECS - elapsed.as_secs()))
    } else {
        None
    }
}
