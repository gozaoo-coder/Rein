//! Rein 在线服务的客户端：模型下发、密钥换取、成本对账。
//!
//! 与更新分发不同，在线模型这条路**必须带密钥**：服务端用签发的客户端令牌
//! （`rein_sk_…`，只存 sha256 摘要）判断「这个客户端能用哪些模型」，并把它能用
//! 的模型连同官方单价一起下发。所以本地不再让用户手填模型 ID —— 模型清单是
//! 服务端说了算，客户端只做「拉清单 → 选中 → 落库」。
//!
//! 两条链路各算各的账：
//!   - 服务端：真实 usage + 真实字节数 → 每条请求的成本（权威口径）；
//!   - 本机：pi-ai 返回的 usage + 本地量的字节数 → `ai_usage`（离线也能看，服务端可对账）。
//!
//! 为什么不把这段逻辑放进前端：密钥要落库（app_meta）、请求要绕过 CORS、模型清单与
//! 计价的字段映射要有单一真源。前端只消费结果，模型装配的知识仍留在 `src/ai/runtime.ts`。

use std::io::Read;
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use tauri::State;

use crate::error::{ReinError, Result};
use crate::modules::update::DEFAULT_SERVICE_BASE;
use crate::state::AppState;

use super::commands::{ai_model_from_row, AI_MODEL_COLS};
use super::models::{
    AiModel, OnlineCatalog, OnlineModel, OnlineServiceSettings, OnlineSyncResult, OnlineUsage,
};

/// app_meta 键：与语音（voice_config）、更新（update_settings_v1）同一套存储
const META_KEY: &str = "online_service_v1";
/// 服务端的默认模型别名：后台换模型不改客户端，我们只是「跟随」这个名字
const AUTO_MODEL_ID: &str = "auto-model";
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BYTES: u64 = 1024 * 1024;
const CHAT_SUFFIX: &str = "/v1/chat/completions";

fn normalize_base(raw: Option<String>) -> String {
    let base = raw
        .map(|b| b.trim().trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_BASE.to_string());
    // 用户可能把「chat/completions」整条地址粘进来：按 /v1 截断，别把路径拼重
    match base.find("/v1") {
        Some(idx) if base[idx..].starts_with("/v1") => base[..idx].to_string(),
        _ => base,
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(PROBE_TIMEOUT)
        .redirects(3)
        .user_agent(concat!("Rein/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn read_json(resp: ureq::Response) -> std::result::Result<serde_json::Value, String> {
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

fn num_at(v: &serde_json::Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn i64_at(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// 服务端错误体 → 状态码（界面据此说人话：密钥不对 / 服务端还没配模型 / 连不上）
fn status_of_error_body(body: &serde_json::Value) -> String {
    match body
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
    {
        "ai_unauthorized" => "unauthorized",
        "ai_not_configured" => "not_configured",
        "model_not_allowed" => "forbidden",
        _ => "error",
    }
    .to_string()
}

fn message_of_error_body(body: &serde_json::Value) -> Option<String> {
    body.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// `app_meta` 读写走 `db` 的唯一实现（本模块只留短别名，便于阅读）。
fn meta_get(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    crate::db::meta_get(conn, key)
}

fn meta_set(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<()> {
    crate::db::meta_set(conn, key, value)
}

/* ---------- 设置（地址 + 密钥） ---------- */

/// 读在线服务设置；没保存过时回落内置服务地址、密钥为空。
#[tauri::command]
pub fn online_service_settings_get(state: State<AppState>) -> Result<OnlineServiceSettings> {
    let conn = state.db.lock().unwrap();
    let Some(raw) = meta_get(&conn, META_KEY) else {
        return Ok(OnlineServiceSettings::default());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// 保存在线服务设置：地址 + 服务密钥（密钥是访问在线模型的唯一凭据，与语音凭据同样存本机库）。
#[tauri::command]
pub fn online_service_settings_save(
    state: State<AppState>,
    settings: OnlineServiceSettings,
) -> Result<OnlineServiceSettings> {
    let saved = OnlineServiceSettings {
        base_url: normalize_base(Some(settings.base_url)),
        api_key: settings.api_key.trim().to_string(),
        saved_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let conn = state.db.lock().unwrap();
    meta_set(
        &conn,
        META_KEY,
        &serde_json::to_string(&saved).map_err(|e| ReinError::Message(e.to_string()))?,
    )?;
    Ok(saved)
}

/* ---------- 目录（服务端指定可用模型） ---------- */

fn fetch_catalog(base_url: Option<String>, api_key: Option<String>) -> Result<OnlineCatalog> {
    let base = normalize_base(base_url);
    let key = api_key.unwrap_or_default().trim().to_string();
    let started = Instant::now();
    let mut out = OnlineCatalog {
        base_url: base.clone(),
        ok: false,
        status: "unreachable".into(),
        models_endpoint: format!("{base}/v1/models"),
        chat_endpoint: format!("{base}{CHAT_SUFFIX}"),
        currency: "CNY".into(),
        traffic_per_gb: 0.0,
        traffic_scope: "egress".into(),
        client_name: None,
        client_models: Vec::new(),
        models: Vec::new(),
        error: None,
        checked_at: chrono::Utc::now().to_rfc3339(),
        elapsed_ms: 0,
    };

    if key.is_empty() {
        out.status = "unauthorized".into();
        out.error = Some("还没有填服务密钥（rein_sk_…），在线模型需要密钥才能取到".into());
        return Ok(out);
    }

    let result = agent()
        .get(&out.models_endpoint)
        .set("Accept", "application/json")
        .set("Authorization", &format!("Bearer {key}"))
        .call();

    match result {
        Ok(resp) => match read_json(resp) {
            Ok(body) => {
                out.ok = true;
                out.status = "ready".into();
                let rein = body.get("rein").cloned().unwrap_or(serde_json::Value::Null);
                out.currency = str_at(&rein, "currency").unwrap_or_else(|| "CNY".into());
                out.traffic_per_gb = num_at(&rein, "trafficPerGb");
                out.traffic_scope = str_at(&rein, "trafficScope").unwrap_or_else(|| "egress".into());
                if let Some(client) = rein.get("client") {
                    out.client_name = str_at(client, "name");
                    out.client_models = client
                        .get("models")
                        .and_then(|m| m.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                }
                out.models = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|arr| arr.iter().map(parse_model).collect())
                    .unwrap_or_default();
            }
            Err(e) => out.error = Some(e),
        },
        Err(ureq::Error::Status(code, resp)) => {
            let body = read_json(resp).unwrap_or(serde_json::Value::Null);
            out.status = if code == 401 {
                "unauthorized".to_string()
            } else {
                status_of_error_body(&body)
            };
            out.error = message_of_error_body(&body)
                .or_else(|| Some(format!("服务端返回 HTTP {code}")))
                .map(|m| if m.is_empty() { format!("服务端返回 HTTP {code}") } else { m });
        }
        Err(e) => {
            out.error = Some(format!("无法连接 {}/v1/models：{e}", base));
        }
    }

    out.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

fn parse_model(item: &serde_json::Value) -> OnlineModel {
    let rein = item.get("rein").cloned().unwrap_or(serde_json::Value::Null);
    OnlineModel {
        id: str_at(item, "id").unwrap_or_default(),
        provider_id: str_at(&rein, "providerId").or_else(|| str_at(item, "owned_by")).unwrap_or_default(),
        provider_name: str_at(&rein, "providerName").unwrap_or_default(),
        price_in: num_at(&rein, "priceIn"),
        price_out: num_at(&rein, "priceOut"),
        priced: rein.get("priced").and_then(|p| p.as_bool()).unwrap_or(false),
        currency: str_at(&rein, "currency").unwrap_or_else(|| "CNY".into()),
        unit: str_at(&rein, "unit").unwrap_or_else(|| "per_1m_tokens".into()),
    }
}

/// 用服务密钥换模型目录：服务端回「这个密钥能用哪些模型 + 单价 + 流量价」。
#[tauri::command]
pub async fn online_service_catalog(
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<OnlineCatalog> {
    tauri::async_runtime::spawn_blocking(move || fetch_catalog(base_url, api_key))
        .await
        .map_err(|e| ReinError::Message(format!("在线服务请求失败：{e}")))?
}

/* ---------- 服务端账本（对账用） ---------- */

/// 拉服务端记的账：这个密钥一共调了多少次、花了多少（模型费 + 流量费）。
#[tauri::command]
pub async fn online_service_usage(
    base_url: Option<String>,
    api_key: Option<String>,
    days: Option<i64>,
) -> Result<OnlineUsage> {
    let base = normalize_base(base_url);
    let key = api_key.unwrap_or_default().trim().to_string();
    let days = days.unwrap_or(30).clamp(1, 90);

    let mut out = OnlineUsage {
        ok: false,
        base_url: base.clone(),
        days,
        calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        bytes_in: 0,
        bytes_out: 0,
        cost_tokens: 0.0,
        cost_traffic: 0.0,
        cost_total: 0.0,
        currency: "CNY".into(),
        error: None,
    };
    if key.is_empty() {
        out.error = Some("还没有填服务密钥".into());
        return Ok(out);
    }

    let url = format!("{base}/api/v1/ai/usage?days={days}");
    let result = tauri::async_runtime::spawn_blocking({
        let key = key.clone();
        let url = url.clone();
        // ureq 的错误类型本身很大（result_large_err），进任务边界前先 Box 掉，
        // 让跨线程搬运的 Result 保持小体积。
        move || -> std::result::Result<ureq::Response, Box<ureq::Error>> {
            agent()
                .get(&url)
                .set("Accept", "application/json")
                .set("Authorization", &format!("Bearer {key}"))
                .call()
                .map_err(Box::new)
        }
    })
    .await
    .map_err(|e| ReinError::Message(format!("在线服务请求失败：{e}")))?;

    match result {
        Ok(resp) => match read_json(resp) {
            Ok(body) => {
                out.ok = true;
                let totals = body.get("totals").cloned().unwrap_or(serde_json::Value::Null);
                let cost = totals.get("costCNY").cloned().unwrap_or(serde_json::Value::Null);
                out.calls = i64_at(&totals, "calls");
                out.prompt_tokens = i64_at(&totals, "promptTokens");
                out.completion_tokens = i64_at(&totals, "completionTokens");
                out.bytes_in = i64_at(&totals, "bytesIn");
                out.bytes_out = i64_at(&totals, "bytesOut");
                out.cost_tokens = num_at(&cost, "tokens");
                out.cost_traffic = num_at(&cost, "traffic");
                out.cost_total = num_at(&cost, "total");
                out.currency = body
                    .get("pricing")
                    .and_then(|p| str_at(p, "currency"))
                    .unwrap_or_else(|| "CNY".into());
            }
            Err(e) => out.error = Some(e),
        },
        Err(e) => match *e {
            ureq::Error::Status(code, resp) => {
                let body = read_json(resp).unwrap_or(serde_json::Value::Null);
                out.error = message_of_error_body(&body).or_else(|| Some(format!("服务端返回 HTTP {code}")));
            }
            other => out.error = Some(format!("无法连接 {url}：{other}")),
        },
    }
    Ok(out)
}

/* ---------- 同步（把服务端的清单落库成可用模型） ---------- */

/// 一条默认模型都没有时（比如刚装好就只导入在线模型）挑一个顶上：优先服务端下发的
/// `auto-model` —— 它是「服务端当前主推模型」的别名，后台换模型不必让用户改设置；
/// 服务端没下发这个别名（没配默认模型）时退回最早的一条。
/// 已经有默认就什么都不做：用户自己选过的默认，同步不该抢走。
fn ensure_default_model(conn: &rusqlite::Connection, service_base: &str) -> Result<()> {
    let has_default: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_models WHERE is_default = 1)",
        [],
        |r| r.get(0),
    )?;
    if has_default {
        return Ok(());
    }
    let picked = conn.execute(
        "UPDATE ai_models SET is_default = 1 WHERE id = (SELECT MIN(id) FROM ai_models \
         WHERE source = 'online' AND service_base = ?1 AND model_id = ?2)",
        rusqlite::params![service_base, AUTO_MODEL_ID],
    )?;
    if picked == 0 {
        conn.execute(
            "UPDATE ai_models SET is_default = 1 WHERE id = (SELECT MIN(id) FROM ai_models)",
            [],
        )?;
    }
    Ok(())
}

/// 把服务端清单里的模型落库成 `ai_models` 行（`source='online'`）。
///
/// - `model_ids` 为空 = 导入目录里的全部模型；
/// - `prune = true`（默认）会删掉同一个服务地址下、服务端已不再提供的 online 行：
///   服务端撤下某个模型后本地不该还能接着调（那条路已经会 403）；
/// - 手动添加的模型（`source='manual'`）永远不受影响。
#[tauri::command]
pub async fn online_service_sync(
    state: State<'_, AppState>,
    base_url: Option<String>,
    api_key: Option<String>,
    model_ids: Option<Vec<String>>,
    prune: Option<bool>,
) -> Result<OnlineSyncResult> {
    // 密钥要写进每条模型行：真正发请求的是前端 pi-ai，它从这一行读 baseUrl + apiKey
    let key = api_key.clone().unwrap_or_default().trim().to_string();
    let catalog = tauri::async_runtime::spawn_blocking(move || fetch_catalog(base_url, api_key))
        .await
        .map_err(|e| ReinError::Message(format!("在线服务请求失败：{e}")))??;

    if !catalog.ok {
        return Err(ReinError::Message(
            catalog.error.unwrap_or_else(|| "在线服务不可用".into()),
        ));
    }

    let wanted: Vec<OnlineModel> = match &model_ids {
        Some(ids) if !ids.is_empty() => catalog
            .models
            .iter()
            .filter(|m| ids.contains(&m.id))
            .cloned()
            .collect(),
        _ => catalog.models.clone(),
    };
    if wanted.is_empty() {
        return Err(ReinError::Message(
            "服务端没有下发任何模型（可能是还没配 provider，或密钥的白名单为空）".into(),
        ));
    }
    // 密钥在上面的 fetch_catalog 之前已取出：真正发请求的是前端 pi-ai，它从模型行读 baseUrl + apiKey
    let base = catalog.base_url.clone();
    let chat_base = format!("{base}/v1");
    let traffic = catalog.traffic_per_gb;
    let now = chrono::Utc::now().to_rfc3339();

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let mut added = 0usize;
    let mut updated = 0usize;

    for m in &wanted {
        let name = if m.provider_name.trim().is_empty() {
            format!("在线 · {}", m.id)
        } else {
            format!("{} · {}", m.provider_name, m.id)
        };
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM ai_models WHERE source = 'online' AND service_base = ?1 AND model_id = ?2",
                rusqlite::params![base, m.id],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(id) => {
                // 单价/流量价/地址/密钥都刷新；用户设的默认项与探测结果保留
                tx.execute(
                    "UPDATE ai_models SET name = ?1, provider = 'rein-online', base_url = ?2, api_key = ?3, \
                     price_in = ?4, price_out = ?5, price_currency = ?6, traffic_per_gb = ?7, updated_at = ?8 \
                     WHERE id = ?9",
                    rusqlite::params![name, chat_base, key, m.price_in, m.price_out, m.currency, traffic, now, id],
                )?;
                updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO ai_models (name, provider, base_url, api_key, model_id, is_default, vision, thinking, \
                     effort, image_max_edge, source, service_base, price_in, price_out, price_currency, traffic_per_gb, \
                     created_at, updated_at) \
                     VALUES (?1, 'rein-online', ?2, ?3, ?4, 0, NULL, NULL, NULL, NULL, 'online', ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                    rusqlite::params![name, chat_base, key, m.id, base, m.price_in, m.price_out, m.currency, traffic, now],
                )?;
                added += 1;
            }
        }
    }

    let mut removed = 0usize;
    if prune.unwrap_or(true) {
        let keep: Vec<String> = wanted.iter().map(|m| m.id.clone()).collect();
        let placeholders = std::iter::repeat("?").take(keep.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM ai_models WHERE source = 'online' AND service_base = ? AND model_id NOT IN ({placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&base];
        for id in &keep {
            params.push(id);
        }
        removed = tx.execute(&sql, params.as_slice())?;
    }

    ensure_default_model(&tx, &base)?;

    let sql = format!(
        "SELECT {AI_MODEL_COLS} FROM ai_models WHERE source = 'online' AND service_base = ?1 ORDER BY id ASC"
    );
    let models = tx
        .prepare(&sql)?
        .query_map([&base], ai_model_from_row)?
        .collect::<rusqlite::Result<Vec<AiModel>>>()?;
    tx.commit()?;

    Ok(OnlineSyncResult {
        added,
        updated,
        removed,
        models,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::migrate_for_test;

    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    /// 插一条模型：online 的带 service_base，manual 的不带。
    fn add(conn: &Connection, model_id: &str, source: &str, service_base: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO ai_models (name, provider, base_url, api_key, model_id, source, service_base, created_at, updated_at) \
             VALUES (?1, 'rein-online', 'http://s/v1', 'k', ?2, ?3, ?4, 'now', 'now')",
            rusqlite::params![format!("n-{model_id}"), model_id, source, service_base],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn default_id(conn: &Connection) -> Option<i64> {
        conn.query_row("SELECT id FROM ai_models WHERE is_default = 1", [], |r| r.get(0))
            .ok()
    }

    /// 「客户端默认用服务端的 auto-model」这条承诺就落在这里。
    #[test]
    fn auto_model_wins_when_nothing_is_default_yet() {
        let conn = fresh();
        add(&conn, "deepseek-v4.1-flash", "online", Some("http://s"));
        let alias = add(&conn, "auto-model", "online", Some("http://s"));
        ensure_default_model(&conn, "http://s").unwrap();
        assert_eq!(default_id(&conn), Some(alias), "默认应落在 auto-model 上");
    }

    /// 服务端没配默认模型时（清单里没有别名）不能没有默认：退回最早一条。
    #[test]
    fn falls_back_to_the_earliest_row_without_the_alias() {
        let conn = fresh();
        let first = add(&conn, "glm-5.3-flash", "online", Some("http://s"));
        add(&conn, "deepseek-v4.1-flash", "online", Some("http://s"));
        ensure_default_model(&conn, "http://s").unwrap();
        assert_eq!(default_id(&conn), Some(first), "没有别名就退回最早一条");
    }

    /// 用户自己选过的默认不该被一次同步抢走。
    #[test]
    fn an_existing_default_is_never_stolen() {
        let conn = fresh();
        let manual = add(&conn, "local-model", "manual", None);
        add(&conn, "auto-model", "online", Some("http://s"));
        conn.execute("UPDATE ai_models SET is_default = 1 WHERE id = ?1", [manual])
            .unwrap();
        ensure_default_model(&conn, "http://s").unwrap();
        assert_eq!(default_id(&conn), Some(manual), "已有默认时同步不该动手");
    }

    /// 别名带服务地址：换了服务端要重新跟随，别把别人的别名当成自己的。
    #[test]
    fn the_alias_of_another_service_does_not_count() {
        let conn = fresh();
        let mine = add(&conn, "glm-5.3-flash", "online", Some("http://mine"));
        add(&conn, "auto-model", "online", Some("http://other"));
        ensure_default_model(&conn, "http://mine").unwrap();
        assert_eq!(default_id(&conn), Some(mine), "别的服务地址下的别名不算数");
    }
}
