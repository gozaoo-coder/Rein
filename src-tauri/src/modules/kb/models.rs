//! 知识库域数据模型 · 与前端 `src/types/kb.ts` 对应。

use serde::{Deserialize, Serialize};

/// 可索引的来源类型。与 db.rs 迁移 0019 的触发器写入值必须一致。
/// `memory` 不是源表派生的，而由记忆层直接登记（见 memory.rs）。
pub const SOURCE_TYPES: &[&str] = &[
    "todo",
    "todo_attachment",
    "workout",
    "plan",
    "meal",
    "body_metric",
    "food",
    "program",
    "program_meal",
    "voice_memo",
    "chat",
    "chat_message",
    "chat_attachment",
    "memory",
    "note",
];

/// 附件等非正文内容的类型（kb_docs.kind）。决定前端如何渲染，也决定「本体在源数据里」。
pub const KIND_TEXT: &str = "text";
pub const KIND_IMAGE: &str = "image";
pub const KIND_FILE: &str = "file";
pub const KIND_AUDIO: &str = "audio";

/// 可写命名空间：用户笔记（规范见 docs/kb-vfs.md）。
pub const NOTE_ROOT: &str = "笔记";
/// 可写命名空间：上传文档的全文归档（发送时由前端自动写入）。
pub const DOC_ROOT: &str = "文档";
/// 系统文件命名空间：只读，不可新建/改名/删除。
pub const SPEC_ROOT: &str = "规范";
/// 规范文件路径：播种进知识库，供 AI 随时查阅自身约定。
pub const SPEC_PATH: &str = "规范/知识库规范.md";

/// 三档检索模式。
/// - `keyword`：纯 FTS5(trigram) + 结构化过滤，零依赖、全平台、默认。
/// - `local`：进程内 ONNX Runtime + 内置 int8 模型，数据不出设备。
/// - `cloud`：OpenAI 兼容 `/v1/embeddings`，走 Rust 侧 ureq（不受 WebView CSP 约束）。
pub const MODE_KEYWORD: &str = "keyword";
pub const MODE_LOCAL: &str = "local";
pub const MODE_CLOUD: &str = "cloud";

/// 读侧设置。`cloud_api_key` 不回传明文，只回尾四位供辨认。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSettings {
    pub embedding_mode: String,
    pub cloud_base_url: Option<String>,
    pub cloud_api_key_tail: Option<String>,
    pub cloud_model: Option<String>,
    pub cloud_dim: Option<i64>,
    /// 逐类开关，缺省视为开启。形如 `{"chat_message": false}`
    pub sources_enabled: serde_json::Value,
    pub auto_memory: bool,
    pub last_error: Option<String>,
    pub updated_at: String,
}

/// 写侧设置：只传要改的字段，缺省不动。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KbSettingsInput {
    pub embedding_mode: Option<String>,
    pub cloud_base_url: Option<String>,
    pub cloud_api_key: Option<String>,
    pub cloud_model: Option<String>,
    pub cloud_dim: Option<i64>,
    pub sources_enabled: Option<serde_json::Value>,
    pub auto_memory: Option<bool>,
}

/// 索引进度快照（后台线程写入，status/命令读取）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbProgress {
    /// idle | scanning | chunking | embedding | done | error
    pub phase: String,
    pub done: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbStatus {
    pub mode: String,
    pub docs: i64,
    pub chunks: i64,
    pub vectors: i64,
    /// 待处理脏标记数
    pub pending: i64,
    pub indexing: bool,
    pub progress: KbProgress,
    pub last_error: Option<String>,
    /// 本地模型是否可用（keyword 模式恒为 true；cloud 模式看配置是否齐全）
    pub embedder_ready: bool,
    /// 当前向量由哪个模型算出
    pub vec_model: Option<String>,
    pub enabled_sources: Vec<String>,
}

/// 检索命中。只回 L0 摘要级信息——正文要走 `kb_read` 显式取，避免工具结果撑爆上下文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbHit {
    pub id: i64,
    pub source_type: String,
    pub source_id: String,
    /// 虚拟路径，如 `日程/2026-09-10/腿部力量训练-42.md`
    pub path: Option<String>,
    /// 1 = 可编辑（笔记 / 记忆），0 = 只读派生文档
    pub editable: bool,
    /// 系统文件（规范）不可改不可删
    pub system: bool,
    /// 内容类型：text / image / file / audio（附件编目用）
    pub kind: String,
    pub title: String,
    /// 命中片段（围绕关键词截取，非全文）
    pub snippet: String,
    pub occurred_on: Option<String>,
    pub tags: Vec<String>,
    pub score: f64,
    /// fts | like | vector | hybrid —— 便于排查「为什么没搜到」
    pub matched: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunk {
    pub id: i64,
    pub ord: i64,
    pub text: String,
}

/// 分层读取结果。level: `l1` = 概览（摘要 + 块首），`l2` = 分块正文全文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbDocDetail {
    pub id: i64,
    pub source_type: String,
    pub source_id: String,
    pub path: Option<String>,
    pub editable: bool,
    pub system: bool,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub occurred_on: Option<String>,
    pub tags: Vec<String>,
    pub meta: serde_json::Value,
    pub updated_at: String,
    pub level: String,
    /// 该文档的总分块数。l1 只返回首块，据此让调用方知道「还有更多」。
    pub total_chunks: i64,
    /// 本次返回的起始块序（分页读取）
    pub offset: i64,
    pub has_more: bool,
    pub chunks: Vec<KbChunk>,
}

/// 检索入参（由 AI 工具或前端构造）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbQuery {
    pub query: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/* ---------- 记忆层 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMemory {
    pub id: i64,
    pub mem_type: String,
    pub topic: String,
    pub content: String,
    pub confidence: f64,
    pub active_count: i64,
    pub source_chat_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 记忆类型。对齐 OpenViking 的类型学，但收敛到健康场景真正用得上的六类。
pub const MEMORY_TYPES: &[&str] = &[
    "preference", // 偏好：喜欢/讨厌、风格倾向
    "constraint", // 约束：伤病、禁忌、时间限制
    "event",      // 事件：做过/发生过的事及其原因
    "entity",     // 实体：人、地点、器械、课程
    "profile",    // 稳定画像：作息、经验水平
    "pattern",    // 模式：反复出现的行为规律
];

/// 记忆抽取产出的单条变更，由前端（pi-ai）调用模型生成后交回 Rust 落库。
/// `op`: add | update | delete；update/delete 必须带 id。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidate {
    pub op: String,
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub mem_type: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryApplyResult {
    pub added: i64,
    pub updated: i64,
    pub deleted: i64,
    /// 因与已有记忆完全重复而跳过的条数（幂等性体现）
    pub skipped: i64,
}

/// 供 prompt 注入的紧凑认知块。刻意做得很短：它每轮都要进系统提示词。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbCognition {
    pub memories: Vec<KbMemory>,
    pub text: String,
}

/* ---------- 真实文件（kb_files，可写） ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFile {
    pub id: i64,
    pub path: String,
    pub content: String,
    pub system: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建 / 覆盖一个文件。路径会按规范净化与归位（见 files.rs::normalize_path）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileInput {
    pub path: String,
    #[serde(default)]
    pub content: String,
}

/// glob 命中。`*` 不跨目录、`**` 跨目录、`?` 单字符。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbGlobHit {
    pub id: i64,
    pub path: String,
    pub source_type: String,
    pub title: String,
    pub kind: String,
    pub editable: bool,
    pub system: bool,
    pub occurred_on: Option<String>,
}
