//! Rein 在线服务（预留接口）：探测服务端能力，供「更新」之外的在线功能接入。
//!
//! 更新只是这台服务的第一件事。第二件（在线大模型 API）服务端已经实现为
//! OpenAI 兼容网关：`/v1/models` + `/v1/chat/completions`，密钥与配额留在服务端，
//! 客户端只需把模型的 baseUrl 指过来。
//!
//! 为什么客户端侧只做「探测 + 报告」而不直接写模型配置：模型装配的知识全在前端
//! `src/ai/runtime.ts`（走哪条线路、thinking 怎么传、max_tokens 字段名），Rust 不该
//! 猜这些。所以这里只回答「服务端现在能不能用、有哪些模型」，由前端复用已有的
//! `aiService.addModel` 落库 —— 预留的是接口，不是第二套模型配置逻辑。

use std::io::Read;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{ReinError, Result};

use super::DEFAULT_SERVICE_BASE;

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProvider {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGatewayInfo {
    /// ready = 有可用 provider；not_configured = 服务在线但还没配模型
    pub status: String,
    pub enabled: bool,
    pub require_token: bool,
    pub client_count: usize,
    pub providers: Vec<ServiceProvider>,
    pub models_endpoint: String,
    pub chat_endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub channel: String,
    pub current: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineServiceStatus {
    pub base_url: String,
    pub reachable: bool,
    pub service: Option<String>,
    pub version: Option<String>,
    pub current_release: Option<String>,
    pub channels: Vec<ChannelInfo>,
    pub manifest_url: Option<String>,
    pub ai: Option<AiGatewayInfo>,
    pub error: Option<String>,
    pub checked_at: String,
    pub elapsed_ms: u64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(PROBE_TIMEOUT)
        .redirects(3)
        .user_agent(concat!("Rein/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn get_json(agent: &ureq::Agent, url: &str) -> std::result::Result<serde_json::Value, String> {
    let resp = agent
        .get(url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| e.to_string())?;
    let mut text = String::new();
    resp.into_reader()
        .take(MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("返回的不是 JSON：{e}"))
}

fn str_at(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 探测一台 Rein 在线服务：更新源状态 + 模型网关状态。
#[tauri::command]
pub async fn online_service_status(base_url: Option<String>) -> Result<OnlineServiceStatus> {
    let base = base_url
        .map(|b| b.trim().trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_BASE.to_string());

    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(ReinError::Message("服务地址必须是 http(s)".into()));
    }

    let result = tauri::async_runtime::spawn_blocking({
        let base = base.clone();
        move || -> OnlineServiceStatus {
            let started = Instant::now();
            let agent = agent();

            let mut status = OnlineServiceStatus {
                base_url: base.clone(),
                reachable: false,
                service: None,
                version: None,
                current_release: None,
                channels: Vec::new(),
                manifest_url: None,
                ai: None,
                error: None,
                checked_at: chrono::Utc::now().to_rfc3339(),
                elapsed_ms: 0,
            };

            match get_json(&agent, &format!("{base}/health")) {
                Ok(health) => {
                    status.reachable = true;
                    status.service = str_at(&health, "service");
                    status.version = str_at(&health, "version");
                    status.channels = health
                        .get("channels")
                        .and_then(|c| c.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|c| {
                                    Some(ChannelInfo {
                                        channel: str_at(c, "channel")?,
                                        current: c
                                            .get("current")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    status.current_release = status
                        .channels
                        .iter()
                        .find(|c| c.channel == "stable")
                        .and_then(|c| c.current.clone());
                    status.manifest_url = health
                        .get("update")
                        .and_then(|u| u.get("manifest"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string());
                    status.ai = health.get("ai").map(parse_ai);
                }
                Err(e) => {
                    status.error = Some(format!("无法连接 {base}/health：{e}"));
                }
            }

            status.elapsed_ms = started.elapsed().as_millis() as u64;
            status
        }
    })
    .await
    .map_err(|e| ReinError::Message(format!("探测任务失败：{e}")))?;

    Ok(result)
}

fn parse_ai(value: &serde_json::Value) -> AiGatewayInfo {
    let base = value
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_SERVICE_BASE);
    AiGatewayInfo {
        status: value
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        enabled: value.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        require_token: value
            .get("requireToken")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        client_count: value
            .get("clientCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        providers: value
            .get("providers")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|p| ServiceProvider {
                        id: str_at(p, "id").unwrap_or_default(),
                        name: str_at(p, "name").unwrap_or_default(),
                        enabled: p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                        models: p
                            .get("models")
                            .and_then(|v| v.as_array())
                            .map(|ms| {
                                ms.iter()
                                    .filter_map(|m| m.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        models_endpoint: format!("{base}/v1/models"),
        chat_endpoint: format!("{base}/v1/chat/completions"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ai_block_from_health_payload() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{
              "baseUrl": "http://47.100.36.179:8787",
              "status": "ready",
              "enabled": true,
              "requireToken": true,
              "clientCount": 2,
              "providers": [
                {"id":"ark","name":"火山方舟","enabled":true,"models":["doubao-seed-1-6-250615"]}
              ]
            }"#,
        )
        .unwrap();
        let ai = parse_ai(&value);
        assert_eq!(ai.status, "ready");
        assert_eq!(ai.client_count, 2);
        assert_eq!(ai.providers.len(), 1);
        assert_eq!(ai.providers[0].models, vec!["doubao-seed-1-6-250615"]);
        assert_eq!(ai.chat_endpoint, "http://47.100.36.179:8787/v1/chat/completions");
    }

    #[test]
    fn missing_ai_block_falls_back_to_unknown_not_a_panic() {
        let ai = parse_ai(&serde_json::json!({}));
        assert_eq!(ai.status, "unknown");
        assert!(!ai.enabled);
        assert!(ai.providers.is_empty());
    }
}
