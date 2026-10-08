//! 提供商（供应商）账号与模型目录：`ai_providers` + `ai_provider_models`。
//!
//! **为什么要这一层**：以前「配一个模型」= 手填 名称 + 地址 + Key + 模型 ID 四件套，
//! 每换一个模型就要重填一遍。真实世界里的最小单位其实是**提供商的账号**（一个适配器
//! + 一份凭据），模型只是这个账号下可用的清单 —— 拉一次 `/models` 就能看到全部，
//! 挑一个启用即可。所以这里存账号与目录，启用时再把选中的模型落到真正的执行位
//! （LLM → `ai_models`；ASR → 语音配置；向量 → 知识库设置）。
//!
//! **适配器是静态注册表**（[`ADAPTERS`]）：一个适配器声明自己的接入方式（style，如
//! 方舟的「模型 API / Agent Plan API」）、默认地址、支持哪几类模型、内置参考目录
//! 与专属凭据字段。前端把 [`AdapterInfo`] 直接渲染成选择器，**不在 TS 里再抄一份**。
//!
//! **目录来源三态**（`ai_provider_models.origin`）：`api` = 从 `/models` 拉到（权威）、
//! `preset` = 适配器内置参考（接口不可用时兜底）、`manual` = 用户手填。拉取成功时
//! 以接口清单为准清掉过期的 `api` 行，`manual` 行永远保留。
//!
//! **密钥只在这里**：目录行不重复存密钥；启用模型时才把 `ai_providers.api_key`
//! 写进对应的执行位（前端做这一步，因为那三处的写入口都在前端 store 里）。

use std::time::Instant;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;

use super::online::{agent, message_of_error_body, read_json, str_at};

/* ---------- 适配器静态注册表 ---------- */

/// 适配器支持的一种接入方式（用户可见的「API 计划」选项）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStyle {
    pub id: &'static str,
    pub label: &'static str,
    /// 默认网关地址（用户可改；改错时用「恢复默认」一键回来）
    pub base_url: &'static str,
    pub note: &'static str,
}

/// 适配器专属凭据字段（如豆包语音的 App ID / Access Token）。
/// 前端按 `secret` 决定用哪种输入组件（密钥输入 vs 普通文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterField {
    pub key: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub secret: bool,
    pub placeholder: &'static str,
}

/// 内置参考目录里的一条模型（接口不可用时兜底显示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetModel {
    pub id: &'static str,
    /// llm | vision | asr | embedding | tts
    pub kind: &'static str,
    pub dim: Option<i64>,
    pub note: &'static str,
}

/// 一个提供商适配器（IPC 投影，前端直接渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// 默认昵称（模型名前缀与折叠分组都用它，用户可改）
    pub nickname: &'static str,
    pub hint: &'static str,
    pub docs: &'static str,
    pub key_hint: &'static str,
    /// 模型清单接口路径（空 = 该适配器没有 /models 接口，只能手填或内置目录）
    pub models_path: &'static str,
    pub styles: &'static [AdapterStyle],
    /// 支持的模型类别（顺序即 UI 展示顺序）
    pub kinds: &'static [&'static str],
    pub extra_fields: &'static [AdapterField],
    pub preset: &'static [PresetModel],
}

/// 适配器注册表。加一个服务商 = 在这里加一条；前端与工具都自动认识它。
pub static ADAPTERS: &[AdapterInfo] = &[
    AdapterInfo {
        id: "volc-ark",
        label: "火山方舟",
        nickname: "火山方舟",
        hint: "方舟模型 API / Agent Plan 套餐：LLM、视觉、向量、语音识别都能从这一个账号取",
        docs: "https://www.volcengine.com/docs/82379",
        key_hint: "方舟 API Key（控制台 › API Key 管理）",
        models_path: "/models",
        styles: &[
            AdapterStyle {
                id: "ark",
                label: "方舟模型 API",
                base_url: "https://ark.cn-beijing.volces.com/api/v3",
                note: "按量计费：Key 取自方舟控制台 › API Key 管理",
            },
            AdapterStyle {
                id: "agent-plan",
                label: "Agent Plan API",
                base_url: "https://ark.cn-beijing.volces.com/api/v3",
                note: "套餐/计划：填套餐签发的 Key；网关地址与按量一致，若服务商给了专用域名请直接改地址",
            },
        ],
        kinds: &["llm", "vision", "embedding", "asr"],
        extra_fields: &[
            AdapterField {
                key: "appId",
                label: "语音 App ID",
                hint: "只给「启用语音识别模型」用：火山语音控制台的 App ID（旧版凭据）",
                secret: false,
                placeholder: "选填",
            },
            AdapterField {
                key: "accessToken",
                label: "语音 Access Token",
                hint: "旧版凭据的 Access Token；填了就走旧版鉴权，不填则用上面的 API Key（新版）",
                secret: true,
                placeholder: "选填",
            },
        ],
        preset: &[
            PresetModel { id: "doubao-seed-1.6", kind: "llm", dim: None, note: "方舟主力对话模型" },
            PresetModel { id: "doubao-seed-1.6-thinking", kind: "llm", dim: None, note: "带思考链的对话模型" },
            PresetModel { id: "doubao-seed-1.6-vision", kind: "vision", dim: None, note: "看图/多模态" },
            PresetModel { id: "doubao-embedding-text-240715", kind: "embedding", dim: None, note: "方舟文本向量（维度见服务商文档）" },
            PresetModel { id: "volc.seedasr.sauc.duration", kind: "asr", dim: None, note: "豆包流式语音识别 2.0（小时版 Resource-Id）" },
        ],
    },
    AdapterInfo {
        id: "dashscope",
        label: "阿里云百炼",
        nickname: "百炼",
        hint: "通义千问系列：对话、视觉、向量与语音识别",
        docs: "https://help.aliyun.com/zh/model-studio/",
        key_hint: "DASHSCOPE_API_KEY",
        models_path: "/models",
        styles: &[AdapterStyle {
            id: "compatible",
            label: "OpenAI 兼容模式",
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            note: "百炼的 OpenAI 兼容端点；Key 即 DASHSCOPE_API_KEY",
        }],
        kinds: &["llm", "vision", "embedding", "asr"],
        extra_fields: &[],
        preset: &[
            PresetModel { id: "qwen3-max", kind: "llm", dim: None, note: "通义千问旗舰对话模型" },
            PresetModel { id: "qwen-plus", kind: "llm", dim: None, note: "均衡档对话模型" },
            PresetModel { id: "qwen-vl-max", kind: "vision", dim: None, note: "视觉理解" },
            PresetModel { id: "text-embedding-v4", kind: "embedding", dim: Some(1024), note: "文本向量（可降维）" },
            PresetModel { id: "qwen-audio-3.0-asr-flash-streaming", kind: "asr", dim: None, note: "流式语音识别" },
        ],
    },
    AdapterInfo {
        id: "deepseek",
        label: "DeepSeek",
        nickname: "DeepSeek",
        hint: "官方 API：对话与视觉模型",
        docs: "https://api-docs.deepseek.com/",
        key_hint: "sk-…",
        models_path: "/models",
        styles: &[AdapterStyle {
            id: "openai",
            label: "官方 API",
            base_url: "https://api.deepseek.com/v1",
            note: "OpenAI 兼容；不带 /v1 也能用，这里统一带上",
        }],
        kinds: &["llm", "vision"],
        extra_fields: &[],
        preset: &[
            PresetModel { id: "deepseek-flash", kind: "llm", dim: None, note: "轻量快档" },
            PresetModel { id: "deepseek-v4-pro", kind: "llm", dim: None, note: "高质档" },
            PresetModel { id: "deepseek-v4-flash-vision-exp", kind: "vision", dim: None, note: "视觉实验模型（拍照识别可用）" },
        ],
    },
    AdapterInfo {
        id: "siliconflow",
        label: "硅基流动",
        nickname: "硅基流动",
        hint: "聚合网关：对话、视觉、向量与语音识别",
        docs: "https://docs.siliconflow.cn/",
        key_hint: "sk-…",
        models_path: "/models",
        styles: &[AdapterStyle {
            id: "openai",
            label: "OpenAI 兼容",
            base_url: "https://api.siliconflow.cn/v1",
            note: "聚合网关地址；模型 ID 形如 组织/模型",
        }],
        kinds: &["llm", "vision", "embedding"],
        extra_fields: &[],
        preset: &[
            PresetModel { id: "deepseek-ai/DeepSeek-V3", kind: "llm", dim: None, note: "第三方托管的 DeepSeek V3" },
            PresetModel { id: "Qwen/Qwen3-8B", kind: "llm", dim: None, note: "小体积对话模型" },
            PresetModel { id: "BAAI/bge-m3", kind: "embedding", dim: Some(1024), note: "多语向量（1024 维）" },
        ],
    },
    AdapterInfo {
        id: "openai-compatible",
        label: "自定义（OpenAI 兼容）",
        nickname: "自定义",
        hint: "任何 OpenAI 兼容网关：地址自己填，模型清单从 /models 拉",
        docs: "",
        key_hint: "服务商给的 Key",
        models_path: "/models",
        styles: &[AdapterStyle {
            id: "openai",
            label: "OpenAI 兼容",
            base_url: "",
            note: "填服务商给的 base 地址（通常以 /v1 结尾）",
        }],
        kinds: &["llm", "vision", "embedding"],
        extra_fields: &[],
        preset: &[],
    },
];

pub fn adapter(id: &str) -> Option<&'static AdapterInfo> {
    ADAPTERS.iter().find(|a| a.id == id)
}

/// 适配器的默认 style（找不到时取第一个；自定义适配器没有默认地址）。
fn style_of(a: &AdapterInfo, style_id: &str) -> &'static AdapterStyle {
    a.styles
        .iter()
        .find(|s| s.id == style_id)
        .unwrap_or(&a.styles[0])
}

/* ---------- IPC 数据形状 ---------- */

/// 一条提供商账号（含已拉取的模型目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: i64,
    pub adapter: String,
    pub name: String,
    pub base_url: String,
    /// 明文回传：本机设置页要能编辑/回显（与 ai_models.apiKey 同一约定，不出本机）
    pub api_key: String,
    pub api_style: String,
    /// 适配器专属字段 JSON（如 {"appId":"…"}）
    pub extra: Option<String>,
    pub last_error: Option<String>,
    pub last_sync_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub models: Vec<AiProviderModel>,
}

/// 提供商目录里的一条模型。`enabled` 不在 Rust 判定 —— 启用状态由前端按
/// 「ai_models / 语音配置 / 知识库设置」的当前值推导（那三处才是真源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderModel {
    pub provider_id: i64,
    pub model_id: String,
    /// llm | vision | asr | embedding | tts
    pub kind: String,
    /// api | preset | manual
    pub origin: String,
    /// 附加元信息 JSON（维度、单价、说明）
    pub meta: Option<String>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInput {
    /// 有 id = 改这一条；没有 = 新建（同 adapter + 同地址已存在时改那一条，避免重复账号）
    pub id: Option<i64>,
    pub adapter: String,
    #[serde(default)]
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_style: String,
    #[serde(default)]
    pub extra: Option<String>,
}

/// 一次「拉模型目录」的结果。`from_preset` = 接口没通、列的是内置参考目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub ok: bool,
    /// ready | unauthorized | forbidden | not_found | unreachable | error | preset_only
    pub status: String,
    pub endpoint: String,
    pub error: Option<String>,
    pub models: Vec<AiProviderModel>,
    pub elapsed_ms: u64,
    pub from_preset: bool,
    pub fetched_at: String,
}

/// 界面偏好（角色绑定 + 模型列表渲染声明）。与语音/在线服务设置一样存 app_meta。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiModelPrefs {
    /// 多模态备选绑定：'' 或 auto = 自动，off = 不另配，model:<ai_models.id> = 指定模型
    pub vision_ref: String,
    /// ASR 绑定（展示与来源）：'' 或 voice = 用语音服务里配的那套，provider:<pid>:<model>
    pub asr_ref: String,
    /// 向量绑定：'' = 按知识库设置显示，local:<模型 id>，cloud:<pid>:<model>
    pub embedding_ref: String,
    /// 模型名前是否加提供商昵称（provider name display）
    pub provider_name_display: bool,
    /// 是否按提供商折叠分组（provider name folder）
    pub provider_name_folder: bool,
}

impl Default for AiModelPrefs {
    fn default() -> Self {
        Self {
            vision_ref: "auto".into(),
            asr_ref: "voice".into(),
            embedding_ref: String::new(),
            provider_name_display: true,
            provider_name_folder: true,
        }
    }
}

/* ---------- 模型类别推断 ---------- */

/// 从模型 ID 与接口给的提示字段猜类别（不关心适配器支不支持）。
///
/// 词表刻意保守：宁可把不确定的当 llm（用户可以手改类别），也不要错判成向量/识别
/// —— 错判会让「启用」落到错误的执行位。
pub fn guess_kind(model_id: &str, hint: &str) -> &'static str {
    let s = format!("{} {}", model_id, hint).to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| s.contains(w));
    if has(&["embed", "bge", "gte-", "text-embedding", "vector"]) {
        "embedding"
    } else if has(&["asr", "whisper", "sensevoice", "paraformer", "sauc", "seedasr", "speech-to-text", "transcription"]) {
        "asr"
    } else if has(&["tts", "speech-synthesis", "text-to-speech", "voice-clone"]) {
        "tts"
    } else if has(&["vision", "-vl", "vl-", "omni", "visual", "multimodal"]) {
        "vision"
    } else {
        "llm"
    }
}

/// 猜出来的类别在不在适配器能提供的范围里；不在就丢掉这条模型。
///
/// 为什么是「丢掉」而不是回落 llm：适配器不支持语音/向量时，把 `tts-1`、
/// `text-embedding-3-small` 之类当成对话模型列出来，只会让用户点了「启用」才发现
/// 用不了。视觉是例外 —— 视觉模型本身就是对话模型，没有视觉槽时按 llm 收下。
fn accept_kind(guess: &'static str, kinds: &[&str]) -> Option<&'static str> {
    if kinds.contains(&guess) {
        return Some(guess);
    }
    if (guess == "llm" || guess == "vision") && kinds.contains(&"llm") {
        return Some("llm");
    }
    None
}

/* ---------- 拉取模型清单 ---------- */

/// 解析 `/models` 响应：兼容 `{data:[…]}`（OpenAI 标准）、`{models:[…]}` 与顶层数组。
fn parse_items(body: &serde_json::Value) -> Vec<serde_json::Value> {
    for key in ["data", "models", "result"] {
        if let Some(arr) = body.get(key).and_then(|v| v.as_array()) {
            return arr.clone();
        }
    }
    body.as_array().cloned().unwrap_or_default()
}

/// 一条模型在接口响应里的类别提示（不同网关用的字段名不一样，都收一遍）。
fn kind_hint(item: &serde_json::Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for key in ["kind", "type", "task", "modality", "object", "owned_by", "description"] {
        match item.get(key) {
            Some(serde_json::Value::String(s)) => parts.push(s.clone()),
            Some(serde_json::Value::Array(arr)) => {
                parts.extend(arr.iter().filter_map(|x| x.as_str().map(str::to_string)))
            }
            _ => {}
        }
    }
    parts.join(" ")
}

/// 元信息 JSON：维度、单价（元/百万 tokens）、说明。拿不到就 None。
fn meta_of(item: &serde_json::Value) -> Option<String> {
    let mut map = serde_json::Map::new();
    for key in ["dim", "dimension", "embeddingDim", "embedding_dim"] {
        if let Some(n) = item.get(key).and_then(|v| v.as_i64()) {
            map.insert("dim".into(), serde_json::Value::from(n));
            break;
        }
    }
    // OpenRouter 风格 pricing：每 token 美元 → 元/百万 tokens 只做数量级换算，币种原样记
    if let Some(p) = item.get("pricing") {
        let pick = |k: &str| p.get(k).and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
        let (i, o) = (pick("prompt"), pick("completion"));
        if i.is_some() || o.is_some() {
            map.insert("priceInPerToken".into(), serde_json::Value::from(i.unwrap_or(0.0)));
            map.insert("priceOutPerToken".into(), serde_json::Value::from(o.unwrap_or(0.0)));
        }
    }
    if let Some(note) = item
        .get("description")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("owned_by").and_then(|v| v.as_str()))
    {
        let note: String = note.chars().take(80).collect();
        if !note.trim().is_empty() {
            map.insert("note".into(), serde_json::Value::from(note));
        }
    }
    if map.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::Value::Object(map)).ok()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn preset_rows(a: &AdapterInfo) -> Vec<AiProviderModel> {
    let at = now();
    a.preset
        .iter()
        .map(|p| AiProviderModel {
            provider_id: 0,
            model_id: p.id.to_string(),
            kind: p.kind.to_string(),
            origin: "preset".into(),
            meta: p.dim.map(|d| format!("{{\"dim\":{d},\"note\":\"{}\"}}", p.note)),
            fetched_at: at.clone(),
        })
        .collect()
}

/// 拉一次模型清单（阻塞；调用方负责 spawn_blocking）。
fn fetch_catalog(
    adapter_id: &str,
    base_url: &str,
    api_key: &str,
) -> (bool, String, String, Option<String>, Vec<AiProviderModel>, bool) {
    let Some(a) = adapter(adapter_id) else {
        return (false, "error".into(), String::new(), Some(format!("未知适配器：{adapter_id}")), Vec::new(), false);
    };
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return (false, "error".into(), String::new(), Some("先填服务地址".into()), Vec::new(), false);
    }
    if a.models_path.is_empty() {
        return (false, "preset_only".into(), base, Some("该适配器没有模型清单接口，用内置参考目录".into()), preset_rows(a), true);
    }
    let endpoint = format!("{base}{}", a.models_path);
    if api_key.trim().is_empty() {
        return (
            false,
            "unauthorized".into(),
            endpoint,
            Some("还没有填该提供商的密钥，模型清单需要密钥才能取到".into()),
            preset_rows(a),
            true,
        );
    }

    let result = agent()
        .get(&endpoint)
        .set("Accept", "application/json")
        .set("Authorization", &format!("Bearer {}", api_key.trim()))
        .call();

    match result {
        Ok(resp) => match read_json(resp) {
            Ok(body) => {
                let at = now();
                let mut seen: Vec<String> = Vec::new();
                let mut models: Vec<AiProviderModel> = Vec::new();
                for item in parse_items(&body) {
                    let Some(id) = str_at(&item, "id")
                        .or_else(|| str_at(&item, "model"))
                        .or_else(|| str_at(&item, "name"))
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    if seen.contains(&id) {
                        continue;
                    }
                    // 适配器不提供的类别（如百炼清单里的 tts-1）不进目录
                    let Some(kind) = accept_kind(guess_kind(&id, &kind_hint(&item)), a.kinds) else {
                        continue;
                    };
                    seen.push(id.clone());
                    models.push(AiProviderModel {
                        provider_id: 0,
                        model_id: id,
                        kind: kind.to_string(),
                        origin: "api".into(),
                        meta: meta_of(&item),
                        fetched_at: at.clone(),
                    });
                }
                if models.is_empty() {
                    // 接口通了但一条都没有：多半是这个账号还没开通任何模型
                    return (
                        false,
                        "ready".into(),
                        endpoint,
                        Some("接口连通，但这个账号下没有任何可用模型（可能还没开通/未授权）".into()),
                        preset_rows(a),
                        true,
                    );
                }
                (true, "ready".into(), endpoint, None, models, false)
            }
            Err(e) => (false, "error".into(), endpoint, Some(e), preset_rows(a), true),
        },
        Err(ureq::Error::Status(code, resp)) => {
            let body = read_json(resp).unwrap_or(serde_json::Value::Null);
            let status = match code {
                401 => "unauthorized",
                403 => "forbidden",
                404 => "not_found",
                _ => "error",
            };
            let msg = message_of_error_body(&body)
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| {
                    if code == 404 {
                        "该地址没有 /models 接口：确认地址是否带 /v1（或直接手填模型 ID）".into()
                    } else {
                        format!("服务端返回 HTTP {code}")
                    }
                });
            (false, status.into(), endpoint, Some(msg), preset_rows(a), true)
        }
        Err(e) => {
            let msg = format!("无法连接 {endpoint}：{e}");
            (false, "unreachable".into(), endpoint, Some(msg), preset_rows(a), true)
        }
    }
}

/* ---------- 落库 ---------- */

fn models_of(conn: &rusqlite::Connection, provider_id: i64) -> Result<Vec<AiProviderModel>> {
    let mut stmt = conn.prepare(
        "SELECT provider_id, model_id, kind, origin, meta, fetched_at FROM ai_provider_models \
         WHERE provider_id = ?1 ORDER BY kind ASC, model_id ASC",
    )?;
    let rows = stmt
        .query_map([provider_id], |r| {
            Ok(AiProviderModel {
                provider_id: r.get(0)?,
                model_id: r.get(1)?,
                kind: r.get(2)?,
                origin: r.get(3)?,
                meta: r.get(4)?,
                fetched_at: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiProvider> {
    Ok(AiProvider {
        id: row.get(0)?,
        adapter: row.get(1)?,
        name: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        api_style: row.get(5)?,
        extra: row.get(6)?,
        last_error: row.get(7)?,
        last_sync_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        models: Vec::new(),
    })
}

const PROVIDER_COLS: &str =
    "id, adapter, name, base_url, api_key, api_style, extra, last_error, last_sync_at, created_at, updated_at";

/// 写目录：`ok` 时以接口清单为准（清掉过期的 api 行，manual 行保留）；
/// 失败时只补内置参考行，已有的 api 行不动 —— 一次网络抖动不该把目录清空。
fn persist_models(
    conn: &rusqlite::Connection,
    provider_id: i64,
    models: &[AiProviderModel],
    ok: bool,
) -> Result<()> {
    for m in models {
        if ok {
            conn.execute(
                "INSERT INTO ai_provider_models (provider_id, model_id, kind, origin, meta, fetched_at) \
                 VALUES (?1, ?2, ?3, 'api', ?4, ?5) \
                 ON CONFLICT(provider_id, model_id) DO UPDATE SET kind = excluded.kind, \
                 origin = 'api', meta = COALESCE(excluded.meta, ai_provider_models.meta), fetched_at = excluded.fetched_at",
                rusqlite::params![provider_id, m.model_id, m.kind, m.meta, m.fetched_at],
            )?;
        } else {
            // 兜底目录：只在「没有这条」时补，绝不覆盖已拉到的 api 行或用户手填行
            conn.execute(
                "INSERT INTO ai_provider_models (provider_id, model_id, kind, origin, meta, fetched_at) \
                 VALUES (?1, ?2, ?3, 'preset', ?4, ?5) ON CONFLICT(provider_id, model_id) DO NOTHING",
                rusqlite::params![provider_id, m.model_id, m.kind, m.meta, m.fetched_at],
            )?;
        }
    }
    if ok {
        let keep: Vec<&str> = models.iter().map(|m| m.model_id.as_str()).collect();
        let placeholders = std::iter::repeat("?").take(keep.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM ai_provider_models WHERE provider_id = ? AND origin = 'api' AND model_id NOT IN ({placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&provider_id];
        for id in &keep {
            params.push(id);
        }
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

/* ---------- 命令 ---------- */

/// 适配器注册表（前端渲染选择器用；不在 TS 里再抄一份）。
#[tauri::command]
pub fn ai_provider_adapters() -> Vec<AdapterInfo> {
    ADAPTERS.to_vec()
}

/// 全部提供商账号 + 各自的模型目录。
#[tauri::command]
pub fn ai_provider_list(state: State<AppState>) -> Result<Vec<AiProvider>> {
    let conn = state.db.lock();
    let sql = format!("SELECT {PROVIDER_COLS} FROM ai_providers ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let mut providers = stmt
        .query_map([], provider_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for p in providers.iter_mut() {
        p.models = models_of(&conn, p.id)?;
    }
    Ok(providers)
}

/// 保存提供商：同 adapter + 同地址视为同一个账号（改凭据而不是又建一条）。
#[tauri::command]
pub fn ai_provider_save(state: State<AppState>, input: AiProviderInput) -> Result<AiProvider> {
    let Some(a) = adapter(input.adapter.trim()) else {
        return Err(ReinError::Message(format!("未知适配器：{}", input.adapter)));
    };
    let base = input.base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(ReinError::Message("服务地址不能为空".into()));
    }
    // 接入方式按注册表归一：认不出的 id 回落该适配器的第一个（前端表单只给合法选项，
    // 但工具/旧数据可能传别的进来）
    let style = style_of(a, input.api_style.trim()).id.to_string();
    let name = {
        let n = input.name.trim();
        if n.is_empty() { a.nickname.to_string() } else { n.to_string() }
    };
    let at = now();
    let conn = state.db.lock();

    let target: Option<i64> = match input.id {
        Some(id) => Some(id),
        None => conn
            .query_row(
                "SELECT id FROM ai_providers WHERE adapter = ?1 AND base_url = ?2",
                rusqlite::params![a.id, base],
                |r| r.get(0),
            )
            .optional()?,
    };

    let id = match target {
        Some(id) => {
            conn.execute(
                "UPDATE ai_providers SET adapter = ?1, name = ?2, base_url = ?3, api_key = ?4, api_style = ?5, \
                 extra = ?6, updated_at = ?7 WHERE id = ?8",
                rusqlite::params![a.id, name, base, input.api_key.trim(), style, input.extra, at, id],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO ai_providers (adapter, name, base_url, api_key, api_style, extra, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![a.id, name, base, input.api_key.trim(), style, input.extra, at],
            )?;
            conn.last_insert_rowid()
        }
    };

    let mut p = conn.query_row(
        &format!("SELECT {PROVIDER_COLS} FROM ai_providers WHERE id = ?1"),
        [id],
        provider_from_row,
    )?;
    p.models = models_of(&conn, id)?;
    Ok(p)
}

/// 删除提供商（连同它的模型目录；已启用的模型不受影响 —— 那些已经落到
/// ai_models / 语音配置 / 知识库设置里了，删账号不该把正在用的模型也弄没）。
#[tauri::command]
pub fn ai_provider_delete(state: State<AppState>, id: i64) -> Result<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM ai_provider_models WHERE provider_id = ?1", [id])?;
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", [id])?;
    Ok(())
}

/// 拉模型清单：`id` 有值时顺带落库并更新该账号的同步态；没有值时只拉不存
/// （表单里「先测一下」用）。
#[tauri::command]
pub async fn ai_provider_fetch(
    state: State<'_, AppState>,
    id: Option<i64>,
    adapter_id: String,
    base_url: String,
    api_key: String,
) -> Result<ProviderCatalog> {
    let started = Instant::now();
    let (ok, status, endpoint, error, models, from_preset) =
        tauri::async_runtime::spawn_blocking(move || fetch_catalog(&adapter_id, &base_url, &api_key))
            .await
            .map_err(|e| ReinError::Message(format!("拉取模型清单失败：{e}")))?;

    if let Some(pid) = id {
        let conn = state.db.lock();
        persist_models(&conn, pid, &models, ok)?;
        conn.execute(
            "UPDATE ai_providers SET last_error = ?1, last_sync_at = ?2, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![error, now(), pid],
        )?;
    }

    let models = match id {
        Some(pid) => {
            let conn = state.db.lock();
            models_of(&conn, pid)?
        }
        None => models,
    };

    Ok(ProviderCatalog {
        ok,
        status,
        endpoint,
        error,
        models,
        elapsed_ms: started.elapsed().as_millis() as u64,
        from_preset,
        fetched_at: now(),
    })
}

/// 手填一条模型（接口清单里没有、或该服务商没有 /models 接口时用）。
#[tauri::command]
pub fn ai_provider_model_add(
    state: State<AppState>,
    provider_id: i64,
    model_id: String,
    kind: String,
    meta: Option<String>,
) -> Result<AiProviderModel> {
    let id = model_id.trim().to_string();
    if id.is_empty() {
        return Err(ReinError::Message("模型 ID 不能为空".into()));
    }
    let conn = state.db.lock();
    let adapter_id: String = conn
        .query_row("SELECT adapter FROM ai_providers WHERE id = ?1", [provider_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| ReinError::Message("提供商不存在".into()))?;
    let a = adapter(&adapter_id).ok_or_else(|| ReinError::Message("提供商适配器未知".into()))?;
    // 用户显式给类别就听用户的（工具/表单会传）；给的不合法才回到猜测
    let kind = if a.kinds.contains(&kind.as_str()) {
        kind
    } else {
        accept_kind(guess_kind(&id, ""), a.kinds)
            .unwrap_or("llm")
            .to_string()
    };
    let at = now();
    conn.execute(
        "INSERT INTO ai_provider_models (provider_id, model_id, kind, origin, meta, fetched_at) \
         VALUES (?1, ?2, ?3, 'manual', ?4, ?5) \
         ON CONFLICT(provider_id, model_id) DO UPDATE SET kind = excluded.kind, origin = 'manual', \
         meta = COALESCE(excluded.meta, ai_provider_models.meta), fetched_at = excluded.fetched_at",
        rusqlite::params![provider_id, id, kind, meta, at],
    )?;
    Ok(AiProviderModel {
        provider_id,
        model_id: id,
        kind,
        origin: "manual".into(),
        meta,
        fetched_at: at,
    })
}

/// 从目录里删掉一条模型（api 拉到的行下次同步会回来；manual 行删了就没了）。
#[tauri::command]
pub fn ai_provider_model_remove(state: State<AppState>, provider_id: i64, model_id: String) -> Result<()> {
    let conn = state.db.lock();
    conn.execute(
        "DELETE FROM ai_provider_models WHERE provider_id = ?1 AND model_id = ?2",
        rusqlite::params![provider_id, model_id],
    )?;
    Ok(())
}

/* ---------- 界面偏好（角色绑定 + 列表渲染声明） ---------- */

const PREFS_KEY: &str = "ai_model_prefs_v1";

#[tauri::command]
pub fn ai_model_prefs_get(state: State<AppState>) -> Result<AiModelPrefs> {
    let conn = state.db.lock();
    Ok(crate::db::meta_get(&conn, PREFS_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub fn ai_model_prefs_save(state: State<AppState>, prefs: AiModelPrefs) -> Result<AiModelPrefs> {
    let conn = state.db.lock();
    crate::db::meta_set(
        &conn,
        PREFS_KEY,
        &serde_json::to_string(&prefs).map_err(|e| ReinError::Message(e.to_string()))?,
    )?;
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_for_test;

    fn fresh() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate_for_test(&conn).unwrap();
        conn
    }

    fn add_provider(conn: &rusqlite::Connection, adapter_id: &str, base: &str) -> i64 {
        conn.execute(
            "INSERT INTO ai_providers (adapter, name, base_url, api_key, api_style, created_at, updated_at) \
             VALUES (?1, 'n', ?2, 'k', 'ark', 'now', 'now')",
            rusqlite::params![adapter_id, base],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn row(model_id: &str, kind: &str, origin: &str) -> AiProviderModel {
        AiProviderModel {
            provider_id: 0,
            model_id: model_id.into(),
            kind: kind.into(),
            origin: origin.into(),
            meta: None,
            fetched_at: "now".into(),
        }
    }

    #[test]
    fn adapter_registry_is_sane() {
        let mut ids: Vec<_> = ADAPTERS.iter().map(|a| a.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), ADAPTERS.len(), "适配器 id 不得重复");
        for a in ADAPTERS {
            assert!(!a.styles.is_empty(), "{} 至少要有一个接入方式", a.id);
            assert!(!a.kinds.is_empty(), "{} 必须声明支持的模型类别", a.id);
            assert!(!a.nickname.is_empty() && !a.label.is_empty());
        }
        assert!(adapter("volc-ark").unwrap().kinds.contains(&"asr"), "火山方舟要能提供识别模型");
        assert!(adapter("nope").is_none());
    }

    /// 类别推断：宁可把不确定的当 llm，也不能错判到别的执行位上。
    #[test]
    fn kind_inference_is_conservative() {
        let ark = adapter("volc-ark").unwrap().kinds;
        assert_eq!(accept_kind(guess_kind("bge-m3", ""), ark), Some("embedding"));
        assert_eq!(accept_kind(guess_kind("text-embedding-v4", ""), ark), Some("embedding"));
        assert_eq!(accept_kind(guess_kind("volc.seedasr.sauc.duration", ""), ark), Some("asr"));
        assert_eq!(accept_kind(guess_kind("whisper-large-v3", ""), ark), Some("asr"));
        assert_eq!(accept_kind(guess_kind("doubao-seed-1.6-vision", ""), ark), Some("vision"));
        assert_eq!(accept_kind(guess_kind("qwen-vl-max", ""), ark), Some("vision"));
        assert_eq!(accept_kind(guess_kind("doubao-seed-1.6", ""), ark), Some("llm"));
        assert_eq!(accept_kind(guess_kind("some-unknown-model", ""), ark), Some("llm"));
        // 接口提示字段也算数（有的网关只在 type 里写）
        assert_eq!(accept_kind(guess_kind("xyz", "audio.transcription"), ark), Some("asr"));
        // 适配器不提供的类别直接丢掉：不能把语音合成/向量当成对话模型列出来
        assert_eq!(accept_kind(guess_kind("tts-1", ""), ark), None);
        // 没有视觉槽时，视觉模型按对话模型收下（它本来就能对话）
        let ds = adapter("deepseek").unwrap().kinds;
        assert_eq!(accept_kind(guess_kind("bge-m3", ""), ds), None);
        assert_eq!(accept_kind(guess_kind("text-embedding-3-small", ""), ds), None);
        assert_eq!(accept_kind(guess_kind("qwen-vl-max", ""), ds), Some("vision"));
        let no_vision: &[&str] = &["llm", "embedding"];
        assert_eq!(accept_kind(guess_kind("qwen-vl-max", ""), no_vision), Some("llm"));
    }

    #[test]
    fn parse_items_accepts_three_shapes() {
        let openai = serde_json::json!({"data": [{"id": "a"}]});
        let alt = serde_json::json!({"models": [{"id": "a"}, {"id": "b"}]});
        let arr = serde_json::json!([{"id": "a"}]);
        assert_eq!(parse_items(&openai).len(), 1);
        assert_eq!(parse_items(&alt).len(), 2);
        assert_eq!(parse_items(&arr).len(), 1);
        assert!(parse_items(&serde_json::json!({"nope": 1})).is_empty());
    }

    /// 拉取成功：以接口清单为准，过期的 api 行清掉，manual 行留着。
    #[test]
    fn successful_fetch_prunes_stale_api_rows_but_keeps_manual() {
        let conn = fresh();
        let pid = add_provider(&conn, "volc-ark", "https://ark/api/v3");
        persist_models(&conn, pid, &[row("old-model", "llm", "api")], true).unwrap();
        conn.execute(
            "INSERT INTO ai_provider_models (provider_id, model_id, kind, origin, fetched_at) \
             VALUES (?1, 'mine', 'llm', 'manual', 'now')",
            [pid],
        )
        .unwrap();

        persist_models(
            &conn,
            pid,
            &[row("doubao-seed-1.6", "llm", "api"), row("bge-m3", "embedding", "api")],
            true,
        )
        .unwrap();

        let models = models_of(&conn, pid).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.model_id.as_str()).collect();
        assert!(ids.contains(&"doubao-seed-1.6") && ids.contains(&"bge-m3"));
        assert!(!ids.contains(&"old-model"), "接口已下架的 api 行要清掉");
        assert!(ids.contains(&"mine"), "手填行不能被同步清掉");
    }

    /// 拉取失败：只补内置参考，已有的 api 行不动（一次网络抖动不该清空目录）。
    #[test]
    fn failed_fetch_keeps_existing_rows_and_adds_presets() {
        let conn = fresh();
        let pid = add_provider(&conn, "volc-ark", "https://ark/api/v3");
        persist_models(&conn, pid, &[row("fetched-before", "llm", "api")], true).unwrap();

        persist_models(&conn, pid, &preset_rows(adapter("volc-ark").unwrap()), false).unwrap();

        let models = models_of(&conn, pid).unwrap();
        let by_id = |id: &str| models.iter().find(|m| m.model_id == id).cloned();
        assert_eq!(by_id("fetched-before").unwrap().origin, "api", "已拉到的目录要留着");
        assert_eq!(by_id("doubao-seed-1.6").unwrap().origin, "preset");
        // 内置参考不覆盖已有行的 origin
        persist_models(&conn, pid, &preset_rows(adapter("volc-ark").unwrap()), false).unwrap();
        assert_eq!(by_id("doubao-seed-1.6").unwrap().origin, "preset");
    }

    /// 拉取成功后，原先的 preset 行会被提升成 api（接口确认存在）。
    #[test]
    fn fetched_rows_promote_preset_rows_to_api() {
        let conn = fresh();
        let pid = add_provider(&conn, "volc-ark", "https://ark/api/v3");
        persist_models(&conn, pid, &[row("doubao-seed-1.6", "llm", "preset")], false).unwrap();
        persist_models(&conn, pid, &[row("doubao-seed-1.6", "llm", "api")], true).unwrap();
        let models = models_of(&conn, pid).unwrap();
        assert_eq!(models[0].origin, "api");
    }

    #[test]
    fn prefs_default_to_auto_vision_and_prefixed_names() {
        let p = AiModelPrefs::default();
        assert_eq!(p.vision_ref, "auto");
        assert_eq!(p.asr_ref, "voice");
        assert!(p.provider_name_display && p.provider_name_folder);
        // 老库没有这条 meta 时也要能读出来（默认值）
        let conn = fresh();
        assert!(crate::db::meta_get(&conn, PREFS_KEY).is_none());
        // 反序列化缺字段的旧 JSON：补默认而不是报错
        let parsed: AiModelPrefs = serde_json::from_str("{\"visionRef\":\"model:3\"}").unwrap();
        assert_eq!(parsed.vision_ref, "model:3");
        assert_eq!(parsed.asr_ref, "voice");
        assert!(parsed.provider_name_folder);
    }

    #[test]
    fn style_falls_back_to_first_when_unknown() {
        let a = adapter("volc-ark").unwrap();
        assert_eq!(style_of(a, "agent-plan").label, "Agent Plan API");
        assert_eq!(style_of(a, "nope").id, a.styles[0].id);
    }
}
