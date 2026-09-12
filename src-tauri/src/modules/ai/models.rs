//! AI 域数据模型 · 与前端 `src/types/ai.ts` 对应。

use serde::{Deserialize, Serialize};

/// 一条从文字/照片解析出的食物估计
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFoodItem {
    /// 命中食物库时的 id；未命中为 null（前端不写入记录）
    pub food_id: Option<i64>,
    pub food_name: String,
    pub grams: f64,
    pub kcal_estimate: f64,
    /// 0~1；关键词解析给低置信度，接入 LLM 后提高
    pub confidence: f64,
    pub note: Option<String>,
}

use crate::modules::nutrition::models::DailyTargets;

/// 目标调整建议中的单项变更（展示 old → new）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetChange {
    pub field: String,
    pub label: String,
    pub unit: String,
    pub from: f64,
    pub to: f64,
}

/// AI 目标调整建议：完整新目标 + 变更清单 + 面向用户的解释
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetAdjustProposal {
    pub targets: DailyTargets,
    pub changes: Vec<TargetChange>,
    pub reply: String,
}

/* ---------- 模型配置（用户添加，前端 pi-ai 运行时使用） ---------- */

/// 一条用户添加的 AI 模型配置，含能力探测结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: i64,
    pub name: String,
    /// UI 预设标识（deepseek | openai-compatible），请求格式按 base_url 自动探测
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub is_default: bool,
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub effort: Option<bool>,
    /// 发给模型的图片最长边（像素）；NULL 用前端默认
    pub image_max_edge: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 添加/编辑模型表单
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInput {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub is_default: bool,
    pub image_max_edge: Option<i64>,
}

/// max_tokens=1 探测包结果：三项能力均需两次探测全过才算支持；error 记录整轮失败原因
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProbeResult {
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub effort: Option<bool>,
    pub error: Option<String>,
}

/* ---------- 聊天历史 ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChat {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 一条聊天消息；图片保存为压缩缩略图（前端渲染与多轮上下文复用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub id: String,
    pub chat_id: String,
    pub seq: i64,
    pub role: String,
    /// text | photo | food-parse | analysis
    pub kind: String,
    pub text: Option<String>,
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    /// food-parse 等结构化消息的 JSON
    pub payload: Option<String>,
    pub created_at: String,
}

/// 追加消息（id 为前端生成的唯一串，重复调用幂等）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessageInput {
    pub id: String,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub image_base64: Option<String>,
    pub mime: Option<String>,
    pub payload: Option<String>,
}

/// 跨会话搜索命中（含所属会话标题，供 AI 工具「搜索全部上下文」）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchHit {
    pub chat_id: String,
    pub chat_title: String,
    pub seq: i64,
    pub role: String,
    pub kind: String,
    pub text: Option<String>,
    pub created_at: String,
}
