use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use rig_core::client::BearerAuth;
use rig_core::client::CompletionClient;
use rig_core::completion::message::Message;
use rig_core::completion::CompletionModel;
use rig_core::providers::deepseek;
use rig_core::telemetry::ProviderResponseExt;

use crate::{AppConfig, new_id, now_ms};

// ============================================================
// 记忆数据结构
// ============================================================

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AgentMemory {
    pub agent_id: String,
    #[serde(default)]
    pub lore: Vec<LoreEntry>,
    #[serde(default)]
    pub core: Vec<CoreMemory>,
    #[serde(default)]
    pub summaries: Vec<Summary>,
    #[serde(default)]
    pub episodic: Vec<EpisodicMemory>,
    #[serde(default)]
    pub marks: Vec<SessionMark>,
    #[serde(default)]
    pub last_extract_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LoreEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub keys: Vec<String>,
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub constant: bool,
    #[serde(default)]
    pub insertion_order: i32,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl LoreEntry {
    pub fn new(id: String, name: String, keys: Vec<String>, content: String, constant: bool) -> Self {
        let t = now_ms();
        Self {
            id,
            name,
            keys,
            content,
            enabled: true,
            constant,
            insertion_order: 0,
            created_at: t,
            updated_at: t,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CoreMemory {
    pub id: String,
    #[serde(default)]
    pub category: String,
    pub content: String,
    #[serde(default)]
    pub importance: u8,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub accessed_at: i64,
}

impl CoreMemory {
    pub fn new(id: String, category: String, content: String, importance: u8) -> Self {
        let t = now_ms();
        Self {
            id,
            category,
            content,
            importance,
            created_at: t,
            updated_at: t,
            accessed_at: t,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Summary {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub from_ts: i64,
    #[serde(default)]
    pub to_ts: i64,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EpisodicMemory {
    pub id: String,
    #[serde(default)]
    pub session_id: String,
    pub condensed: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub importance: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionMark {
    pub session_id: String,
    pub msg_count: usize,
    #[serde(default)]
    pub summary_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MemoryConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub embedding_model: String,
}

fn default_true() -> bool {
    true
}

// ============================================================
// 持久化
// ============================================================

fn memory_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("memory")
}

fn memory_path(app: &AppHandle, agent_id: &str) -> PathBuf {
    memory_dir(app).join(format!("{agent_id}.json"))
}

pub fn load_memory(app: &AppHandle, agent_id: &str) -> AgentMemory {
    std::fs::read_to_string(memory_path(app, agent_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| AgentMemory {
            agent_id: agent_id.to_string(),
            ..Default::default()
        })
}

pub fn save_memory(app: &AppHandle, mem: &AgentMemory) {
    let dir = memory_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        memory_path(app, &mem.agent_id),
        serde_json::to_string_pretty(mem).unwrap_or_default(),
    );
}

pub fn delete_memory(app: &AppHandle, agent_id: &str) {
    let _ = std::fs::remove_file(memory_path(app, agent_id));
}

/// 会话没有绑定智能体时，记忆挂在默认键下（主智能体）
pub fn memory_key(agent_id: &Option<String>) -> String {
    match agent_id {
        Some(id) if !id.is_empty() => id.clone(),
        _ => "__default__".to_string(),
    }
}

// ============================================================
// 配置解析
// ============================================================

pub fn memory_llm_config(cfg: &AppConfig) -> MemoryConfig {
    if !cfg.memory_model.trim().is_empty() {
        MemoryConfig {
            provider: if cfg.memory_provider.trim().is_empty() {
                cfg.provider.clone()
            } else {
                cfg.memory_provider.clone()
            },
            base_url: if cfg.memory_base_url.trim().is_empty() {
                cfg.base_url.clone()
            } else {
                cfg.memory_base_url.clone()
            },
            api_key: if cfg.memory_api_key.trim().is_empty() {
                cfg.api_key.clone()
            } else {
                cfg.memory_api_key.clone()
            },
            model: cfg.memory_model.trim().to_string(),
            embedding_model: cfg.embedding_model.trim().to_string(),
        }
    } else {
        MemoryConfig {
            provider: cfg.provider.clone(),
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            model: cfg.model.clone(),
            embedding_model: cfg.embedding_model.trim().to_string(),
        }
    }
}

fn build_llm_client(mc: &MemoryConfig) -> Result<deepseek::Client, String> {
    let base = if mc.base_url.trim().is_empty() {
        "https://api.deepseek.com".to_string()
    } else {
        mc.base_url.trim().to_string()
    };
    deepseek::Client::builder()
        .api_key(BearerAuth::from(mc.api_key.trim()))
        .base_url(&base)
        .build()
        .map_err(|e| format!("构建记忆模型客户端失败: {e}"))
}

async fn llm_complete(mc: &MemoryConfig, system: &str, user: &str, max_tokens: u64) -> Result<String, String> {
    let client = build_llm_client(mc)?;
    let model = client.completion_model(mc.model.clone());
    let request = model
        .completion_request(Message::user(user))
        .preamble(system.to_string())
        .max_tokens(max_tokens)
        .build();
    let resp = model
        .completion(request)
        .await
        .map_err(|e| format!("记忆模型调用失败: {e}"))?;
    resp.raw_response
        .get_text_response()
        .ok_or_else(|| "记忆模型返回为空".to_string())
}

// ============================================================
// 嵌入向量（OpenAI 兼容 / Ollama）
// ============================================================

pub async fn embed_texts(mc: &MemoryConfig, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if mc.embedding_model.is_empty() {
        return Err("未配置嵌入模型".into());
    }
    let client = reqwest::Client::new();
    let base = mc.base_url.trim().trim_end_matches('/');

    if mc.provider == "ollama" {
        // Ollama 原生接口：POST /api/embed
        let resp = client
            .post(format!("{base}/api/embed"))
            .json(&serde_json::json!({ "model": mc.embedding_model, "input": texts }))
            .send()
            .await
            .map_err(|e| format!("嵌入请求失败: {e}"))?;
        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("嵌入响应解析失败: {e}"))?;
        if !status.is_success() {
            return Err(format!("嵌入接口错误 {status}: {body}"));
        }
        let arr = body["embeddings"]
            .as_array()
            .ok_or_else(|| "嵌入响应缺少 embeddings".to_string())?;
        Ok(arr
            .iter()
            .map(|v| {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
                    .unwrap_or_default()
            })
            .collect())
    } else {
        // OpenAI 兼容：POST /embeddings
        let url = format!("{base}/embeddings");
        let mut req = client
            .post(&url)
            .json(&serde_json::json!({ "model": mc.embedding_model, "input": texts }));
        if !mc.api_key.trim().is_empty() {
            req = req.bearer_auth(mc.api_key.trim());
        }
        let resp = req.send().await.map_err(|e| format!("嵌入请求失败: {e}"))?;
        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("嵌入响应解析失败: {e}"))?;
        if !status.is_success() {
            return Err(format!("嵌入接口错误 {status}: {body}"));
        }
        let arr = body["data"]
            .as_array()
            .ok_or_else(|| "嵌入响应缺少 data".to_string())?;
        Ok(arr
            .iter()
            .map(|v| {
                v["embedding"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
                    .unwrap_or_default()
            })
            .collect())
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na <= 0.0 || nb <= 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

// ============================================================
// 关键词（中英文）提取与相似度（嵌入不可用时的兜底）
// ============================================================

fn extract_words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut latin = String::new();
    let mut cjk = String::new();
        let flush = |latin: &mut String, cjk: &mut String, out: &mut Vec<String>| {        let l = latin.trim().to_lowercase();
        if l.len() >= 2 {
            out.push(l);
        }
        if cjk.chars().count() >= 2 {
            out.push(cjk.clone());
        }
        latin.clear();
        cjk.clear();
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            flush(&mut latin, &mut cjk, &mut out);
            latin.push(ch);
        } else if ch as u32 >= 0x4E00 && ch as u32 <= 0x9FFF {
            flush(&mut latin, &mut cjk, &mut out);
            cjk.push(ch);
        } else {
            flush(&mut latin, &mut cjk, &mut out);
        }
    }
    flush(&mut latin, &mut cjk, &mut out);
    out.sort();
    out.dedup();
    out
}

pub fn extract_keywords(text: &str) -> Vec<String> {
    let words = extract_words(text);
    // 中文双字词也加入关键词，提升检索命中率
    let mut kw = words.clone();
    for w in &words {
        let chars: Vec<char> = w.chars().collect();
        if chars.len() >= 3 && chars.iter().all(|c| (*c as u32) >= 0x4E00 && (*c as u32) <= 0x9FFF) {
            for pair in chars.windows(2) {
                kw.push(pair.iter().collect());
            }
        }
    }
    kw.sort();
    kw.dedup();
    kw.retain(|k| k.len() >= 2);
    kw
}

fn keyword_score(query_words: &[String], target: &str) -> f32 {
    let target = target.to_lowercase();
    query_words
        .iter()
        .filter(|w| target.contains(w.as_str()))
        .count() as f32
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        let mut t: String = chars.into_iter().take(max).collect();
        t.push('…');
        t
    }
}

// ============================================================
// 上下文组装：记忆档案
// ============================================================

const PROFILE_BUDGET: usize = 4000;

/// 检索相关记忆并组装成提示词档案。
/// `context` 为用户最新消息 + 最近对话，用于关键词/向量检索。
pub async fn build_memory_profile(
    app: &AppHandle,
    mc: &MemoryConfig,
    agent_id: &str,
    context: &str,
) -> String {
    let mem = load_memory(app, agent_id);
    let mut sections: Vec<(&str, Vec<String>)> = Vec::new();

    // L1 世界观：常驻 + 关键词命中
    let ctx_low = context.to_lowercase();
    let mut lore_lines: Vec<String> = Vec::new();
    let mut lore_entries: Vec<&LoreEntry> = mem.lore.iter().filter(|e| e.enabled).collect();
    lore_entries.sort_by(|a, b| {
        b.constant
            .cmp(&a.constant)
            .then(a.insertion_order.cmp(&b.insertion_order))
            .then(a.created_at.cmp(&b.created_at))
    });
    for e in lore_entries {
        let hit = e.constant
            || e.keys
                .iter()
                .any(|k| !k.trim().is_empty() && ctx_low.contains(&k.trim().to_lowercase()));
        if hit {
            lore_lines.push(format!(
                "- {}：{}",
                if e.name.trim().is_empty() { "设定" } else { &e.name },
                truncate(&e.content, 500)
            ));
        }
    }
    sections.push(("世界观设定", lore_lines));

    // L2 核心记忆：按重要度 + 新鲜度排序
    let mut cores: Vec<CoreMemory> = mem.core.clone();
    let now = now_ms();
    cores.sort_by(|a, b| {
        let sa = a.importance as i64 * 2 + (now - a.accessed_at).min(3_600_000 * 24 * 30) / (3_600_000 * 24);
        let sb = b.importance as i64 * 2 + (now - b.accessed_at).min(3_600_000 * 24 * 30) / (3_600_000 * 24);
        sb.cmp(&sa)
    });
    let mut core_lines: Vec<String> = Vec::new();
    let core_budget = PROFILE_BUDGET / 4;
    let mut used = 0usize;
    for c in cores {
        let line = format!("- [{}] {}（重要度 {}/10）", c.category, truncate(&c.content, 300), c.importance);
        used += line.chars().count();
        if used > core_budget && !core_lines.is_empty() {
            break;
        }
        core_lines.push(line);
    }
    sections.push(("永久记忆", core_lines));

    // L3 滚动摘要：最近两条
    let mut sums: Vec<Summary> = mem.summaries.clone();
    sums.sort_by(|a, b| b.to_ts.cmp(&a.to_ts));
    let sum_lines: Vec<String> = sums
        .iter()
        .take(2)
        .map(|s| format!("- {}", truncate(&s.content, 600)))
        .collect();
    sections.push(("近期事件摘要", sum_lines));

    // L4 情景记忆：向量检索 top-K（失败则关键词兜底）
    let mut epi_lines: Vec<String> = Vec::new();
    if !mem.episodic.is_empty() {
        let q_words = extract_keywords(context);
        let query_embed: Option<Vec<f32>> = if mc.embedding_model.is_empty() {
            None
        } else {
            embed_texts(mc, &[context.to_string()]).await.ok().and_then(|v| v.into_iter().next())
        };
        let mut scored: Vec<(f32, &EpisodicMemory)> = Vec::new();
        for ep in mem.episodic.iter() {
            let s = if let (Some(q), Some(e)) = (&query_embed, &ep.embedding) {
                cosine(q, e)
            } else {
                keyword_score(&q_words, &ep.condensed) * 0.5
            };
            if s > 0.1 {
                scored.push((s, ep));
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, ep) in scored.into_iter().take(3) {
            epi_lines.push(format!("- {}", truncate(&ep.condensed, 400)));
        }
    }
    sections.push(("相关往事", epi_lines));

    let mut parts: Vec<String> = Vec::new();
    for (title, lines) in sections {
        if lines.is_empty() {
            continue;
        }
        let mut block = format!("【{title}】\n");
        let mut used = block.chars().count();
        for l in lines {
            let add = l.chars().count() + 1;
            if used + add > PROFILE_BUDGET {
                break;
            }
            block.push_str(&l);
            block.push('\n');
            used += add;
        }
        parts.push(block.trim_end().to_string());
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n【记忆档案】\n以下是你的长期记忆信息，请自然地运用，不要逐条复述。\n{}\n",
            parts.join("\n")
        )
    }
}

// ============================================================
// 记忆维护流水线（回复完成后异步执行）
// ============================================================

pub async fn run_maintenance(
    app: &AppHandle,
    mc: &MemoryConfig,
    agent_id: &str,
    session_id: &str,
    user_text: &str,
    reply_text: &str,
) -> Result<(), String> {
    let mut mem = load_memory(app, agent_id);

    // 1. 情景记忆：压缩一轮对话并（尽力）嵌入
    let condensed = format!(
        "用户：{}\n智能体：{}",
        truncate(user_text, 300),
        truncate(reply_text, 300)
    );
    let embedding = if mc.embedding_model.is_empty() {
        None
    } else {
        embed_texts(mc, &[condensed.clone()]).await.ok().and_then(|v| v.into_iter().next())
    };
    mem.episodic.push(EpisodicMemory {
        id: new_id(),
        session_id: session_id.to_string(),
        keywords: extract_keywords(&condensed),
        embedding,
        condensed,
        ts: now_ms(),
        importance: 5,
    });
    // 情景索引上限，超限丢最旧的
    if mem.episodic.len() > 2000 {
        mem.episodic.sort_by(|a, b| a.ts.cmp(&b.ts));
        mem.episodic.drain(0..(mem.episodic.len() - 2000));
    }

    // 2. 事实抽取（节流：5 分钟一次）
    let now = now_ms();
    if now - mem.last_extract_at > 5 * 60 * 1000 {
        mem.last_extract_at = now;
        if let Ok(facts) = extract_facts(app, mc, session_id).await {
            for f in facts {
                if !core_has_similar(&mem.core, &f.content) {
                    mem.core.push(CoreMemory::new(
                        new_id(),
                        f.category,
                        f.content,
                        f.importance.clamp(1, 10),
                    ));
                }
            }
            // 核心记忆上限
            if mem.core.len() > 200 {
                mem.core.sort_by(|a, b| b.importance.cmp(&a.importance));
                mem.core.drain(200..);
            }
        }
    }

    // 3. 滚动摘要：同一会话每 20 条消息压缩一段
    let chunk = 20usize;
    let mark_idx = mem.marks.iter().position(|m| m.session_id == session_id);
    let msg_count = crate::session_msg_count(app, session_id);
    let need_summarize = match mark_idx {
        Some(i) => msg_count - mem.marks[i].msg_count >= chunk,
        None => msg_count >= chunk,
    };
    if need_summarize {
        let from_count = mark_idx.map(|i| mem.marks[i].msg_count).unwrap_or(0);
        if let Ok(text) = summarize_chunk(app, mc, session_id, from_count, msg_count).await {
            let summary = Summary {
                id: new_id(),
                content: text,
                from_ts: now_ms(),
                to_ts: now_ms(),
                created_at: now_ms(),
            };
            mem.summaries.push(summary);
            if mem.summaries.len() > 12 {
                mem.summaries.sort_by(|a, b| a.created_at.cmp(&b.created_at));
                mem.summaries.drain(0..(mem.summaries.len() - 12));
            }
            if let Some(i) = mark_idx {
                mem.marks[i].msg_count = msg_count;
                mem.marks[i].summary_id = Some(mem.summaries.last().map(|s| s.id.clone()).unwrap_or_default());
            } else {
                mem.marks.push(SessionMark {
                    session_id: session_id.to_string(),
                    msg_count,
                    summary_id: mem.summaries.last().map(|s| s.id.clone()),
                });
            }
        }
    }

    save_memory(app, &mem);
    Ok(())
}

fn core_has_similar(core: &[CoreMemory], content: &str) -> bool {
    let a: Vec<String> = extract_keywords(content);
    core.iter().any(|c| {
        let b: Vec<String> = extract_keywords(&c.content);
        let common = a.iter().filter(|w| b.contains(w)).count();
        common as f32 >= a.len().max(2) as f32 * 0.6
    })
}

async fn extract_facts(
    app: &AppHandle,
    mc: &MemoryConfig,
    session_id: &str,
) -> Result<Vec<ExtractedFact>, String> {
    let msgs = crate::session_recent_messages(app, session_id, 8);
    if msgs.is_empty() {
        return Ok(Vec::new());
    }
    let mut transcript = String::new();
    for m in msgs.iter().rev().take(8).rev() {
        let who = if m.role == "user" { "用户" } else { "智能体" };
        transcript.push_str(&format!("{who}：{}\n", truncate(&m.content, 500)));
    }
    let system = "你是记忆管理员。阅读这段对话，提取未来对话仍值得记住的长期事实（用户的身份、偏好、习惯、关系、重大事件、约定等）。不要提取一次性闲聊。只输出 JSON，格式：{\"facts\":[{\"category\":\"user_info|preference|relationship|event|fact\",\"content\":\"事实描述\",\"importance\":1到10的整数}]}。不要输出任何其他内容。";
    let raw = llm_complete(mc, system, &transcript, 1024).await?;
    parse_facts_json(&raw)
}

fn parse_facts_json(raw: &str) -> Result<Vec<ExtractedFact>, String> {
    let start = raw.find('{').ok_or_else(|| "事实响应缺少 JSON".to_string())?;
    let end = raw.rfind('}').ok_or_else(|| "事实响应缺少 JSON".to_string())?;
    let body: serde_json::Value =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("事实解析失败: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = body["facts"].as_array() {
        for v in arr {
            let content = v["content"].as_str().unwrap_or("").trim().to_string();
            if content.is_empty() {
                continue;
            }
            out.push(ExtractedFact {
                category: v["category"].as_str().unwrap_or("fact").to_string(),
                content: truncate(&content, 300),
                importance: v["importance"].as_u64().unwrap_or(5) as u8,
            });
        }
    }
    Ok(out)
}

struct ExtractedFact {
    category: String,
    content: String,
    importance: u8,
}

async fn summarize_chunk(
    app: &AppHandle,
    mc: &MemoryConfig,
    session_id: &str,
    from_count: usize,
    to_count: usize,
) -> Result<String, String> {
    let msgs = crate::session_msg_slice(app, session_id, from_count, to_count);
    if msgs.is_empty() {
        return Ok(String::new());
    }
    let mut transcript = String::new();
    for m in msgs {
        let who = if m.role == "user" { "用户" } else { "智能体" };
        transcript.push_str(&format!("{who}：{}\n", truncate(&m.content, 400)));
    }
    if transcript.chars().count() > 4000 {
        transcript = truncate(&transcript, 4000);
    }
    let system = "把下面的对话压缩成简洁的中文摘要，200 字以内，保留：人物、关系、关键事实、用户偏好、未完成事项。只输出摘要正文，不要其他内容。";
    llm_complete(mc, system, &transcript, 600).await
}

// ============================================================
// 供 Tauri 命令使用的检索
// ============================================================

pub fn recall_episodic(mem: &AgentMemory, query: &str, k: usize) -> Vec<EpisodicMemory> {
    let q_words = extract_keywords(query);
    let mut scored: Vec<(f32, &EpisodicMemory)> = mem
        .episodic
        .iter()
        .map(|ep| {
            (
                keyword_score(&q_words, &ep.condensed) + keyword_score(&q_words, &ep.keywords.join(" ")),
                ep,
            )
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(_, e)| e.clone()).collect()
}
