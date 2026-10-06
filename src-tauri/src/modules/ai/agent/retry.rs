//! 瞬态错误重试决策（纯函数，便于单测）。
//!
//! 限流与普通瞬态错误的恢复时间尺度不同：网络抖动 / 5xx 毫秒~秒级恢复，
//! 适合「短退避 + 多次数」；限流受服务商配额窗口（分钟级）约束，短退避只会
//! 把窗口越打越宽，因此走「长退避 + 少次数」并在上游给出 `Retry-After` 时优先采纳。
//! 语义移植自 EffiBuddy `services/error_classify`（MIT，同作者）。

use std::time::Duration;

/// 短退避基数（毫秒）：其他瞬态错误第 1 次重试前等待 200ms
pub const TRANSIENT_BACKOFF_BASE_MS: u64 = 200;
/// 短退避上限
pub const TRANSIENT_BACKOFF_CAP_MS: u64 = 2_000;
/// 短退避最大重试次数
pub const TRANSIENT_MAX_RETRIES: usize = 2;

/// 限流退避基数（毫秒）：首次重试前等待 5s
pub const RATE_LIMIT_BACKOFF_BASE_MS: u64 = 5_000;
/// 限流退避上限：指数增长封顶 60s
pub const RATE_LIMIT_BACKOFF_CAP_MS: u64 = 60_000;
/// 限流最大重试次数（长退避，次数要少）
pub const RATE_LIMIT_MAX_RETRIES: usize = 3;
/// 采纳上游 `Retry-After` 建议的上限：超过则交互式回合长时间挂起，
/// 用户手动重试更合适，故截断到 120s
pub const RATE_LIMIT_RETRY_AFTER_CAP_MS: u64 = 120_000;

/// 重试决策
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPlan {
    /// 不重试（错误非瞬态，或已达次数上限）
    Fail,
    /// 退避后重试
    Retry(Duration),
}

/// 从错误文本解析 HTTP 状态码（`（429 Too Many Requests）` 或裸 `429` 形态）
fn http_status(err_lower: &str) -> Option<u16> {
    let bytes = err_lower.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j - i == 3 {
                // 三位数：确认前后不是数字（避免从长数字里截三位）
                let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
                let after_ok = j >= bytes.len() || !bytes[j].is_ascii_digit();
                if before_ok && after_ok {
                    if let Ok(code) = err_lower[i..j].parse::<u16>() {
                        if (100..600).contains(&code) {
                            return Some(code);
                        }
                    }
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// 从错误文本解析上游 `Retry-After` 建议（秒）。
///
/// 后端把响应头以 `; retry-after=30` 形式透传进错误串；兼容 `=` 与 `:` 分隔。
/// 解析不到（无该头 / HTTP-date 形态）返回 `None`，由调用方回退到退避表。
pub fn retry_after_hint(err: &str) -> Option<Duration> {
    let lower = err.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(pos) = lower[from..].find("retry-after") {
        let start = from + pos + "retry-after".len();
        let rest =
            err[start..].trim_start_matches(|c: char| c == ':' || c == '=' || c.is_whitespace());
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(secs) = digits.parse::<u64>() {
            return Some(Duration::from_secs(secs.min(3600)));
        }
        from = start;
    }
    None
}

/// 第 `attempt` 次限流重试前的退避时长（`attempt` 从 1 开始）：
/// 5s → 10s → 20s → 40s → 60s，封顶 60s。
pub fn rate_limit_backoff_delay(attempt: u32) -> Duration {
    let exp = attempt.saturating_sub(1).min(4);
    let ms = RATE_LIMIT_BACKOFF_BASE_MS.saturating_mul(1u64 << exp);
    Duration::from_millis(ms.min(RATE_LIMIT_BACKOFF_CAP_MS))
}

/// 规划一次失败后的动作。`attempt` 为已重试次数（首次失败为 0）。
pub fn plan_retry(err: &str, attempt: usize) -> RetryPlan {
    let lower = err.to_ascii_lowercase();
    let status = http_status(&lower);
    match status {
        Some(429) => {
            if attempt >= RATE_LIMIT_MAX_RETRIES {
                return RetryPlan::Fail;
            }
            let delay = retry_after_hint(err)
                .map(|d| d.min(Duration::from_millis(RATE_LIMIT_RETRY_AFTER_CAP_MS)))
                .unwrap_or_else(|| rate_limit_backoff_delay(attempt as u32 + 1));
            RetryPlan::Retry(delay)
        }
        // 显式 4xx（除 429）：请求本身有问题，重试无意义
        Some(code) if (400..500).contains(&code) => RetryPlan::Fail,
        // 5xx / 无状态码（网络中断、超时等）：短退避重试
        _ => {
            let transient = status.is_some_and(|c| c >= 500)
                || lower.contains("timeout")
                || lower.contains("timed out")
                || lower.contains("connection")
                || lower.contains("network")
                || lower.contains("发送失败")
                || lower.contains("读取失败")
                || lower.contains("流读取失败");
            if !transient || attempt >= TRANSIENT_MAX_RETRIES {
                return RetryPlan::Fail;
            }
            let backoff_ms =
                (TRANSIENT_BACKOFF_BASE_MS * (attempt as u64 + 1)).min(TRANSIENT_BACKOFF_CAP_MS);
            RetryPlan::Retry(Duration::from_millis(backoff_ms))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_uses_long_backoff() {
        let err = "LLM 流式请求失败（429 Too Many Requests）: busy";
        assert_eq!(plan_retry(err, 0), RetryPlan::Retry(Duration::from_millis(5_000)));
        assert_eq!(plan_retry(err, 1), RetryPlan::Retry(Duration::from_millis(10_000)));
        assert_eq!(plan_retry(err, 2), RetryPlan::Retry(Duration::from_millis(20_000)));
        assert_eq!(plan_retry(err, 3), RetryPlan::Fail, "限流重试次数要少");
    }

    #[test]
    fn rate_limit_prefers_retry_after_and_caps() {
        let err = "LLM 流式请求失败（429）: slow down ; retry-after=12";
        assert_eq!(plan_retry(err, 0), RetryPlan::Retry(Duration::from_secs(12)));
        // 异常大的建议值截断到 120s
        let huge = "LLM 流式请求失败（429）: slow ; retry-after=9999";
        assert_eq!(plan_retry(huge, 0), RetryPlan::Retry(Duration::from_secs(120)));
    }

    #[test]
    fn transient_errors_get_quick_backoff() {
        assert_eq!(
            plan_retry("LLM 流式请求失败（502 Bad Gateway）: upstream", 0),
            RetryPlan::Retry(Duration::from_millis(200))
        );
        assert_eq!(
            plan_retry("LLM 请求发送失败: error sending request: connection refused", 0),
            RetryPlan::Retry(Duration::from_millis(200))
        );
        assert_eq!(
            plan_retry("LLM 流读取失败: timeout", 1),
            RetryPlan::Retry(Duration::from_millis(400))
        );
        assert_eq!(plan_retry("LLM 流读取失败: timeout", 2), RetryPlan::Fail);
    }

    #[test]
    fn non_transient_errors_fail_fast() {
        assert_eq!(plan_retry("LLM 请求失败（401 Unauthorized）: bad key", 0), RetryPlan::Fail);
        assert_eq!(plan_retry("LLM 请求失败（400 Bad Request）: bad schema", 0), RetryPlan::Fail);
        assert_eq!(plan_retry("LLM 响应解析失败: expected value", 0), RetryPlan::Fail);
    }

    #[test]
    fn status_parsing_ignores_long_numbers() {
        assert_eq!(http_status("code 12345 happened"), None);
        assert_eq!(http_status("failure (429 too many)"), Some(429));
        assert_eq!(http_status("no status here"), None);
    }
}
