//! 健康方案域数据模型 · 与前端 `src/types/program.ts` 对应。

use serde::{Deserialize, Serialize};

/// 一条方案记录。内容快照（params_json）与调整历史（adjustments_json）由前端
/// 引擎生成/解析，Rust 按文本原样存取，不做结构校验。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramRecord {
    pub id: i64,
    /// cut | keep | bulk
    pub goal: String,
    /// conservative | balanced | aggressive
    pub tier: String,
    /// active | archived；同一时刻至多一个 active
    pub status: String,
    pub version: i64,
    pub weeks: i64,
    pub params_json: String,
    pub adjustments_json: String,
    pub created_at: String,
    pub activated_at: String,
    pub updated_at: String,
}

/// 创建（= 启用）方案：前端引擎算好内容后整体提交；已有 active 方案自动归档。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramCreateInput {
    pub goal: String,
    pub tier: String,
    pub weeks: i64,
    pub params_json: String,
}

/// 调整方案内容（AI 建议经用户确认 / 手动改参）：整体替换快照，版本号由后端自增。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramUpdateInput {
    pub params_json: String,
    pub adjustments_json: String,
}

/// 方案日程待办批量写入项（todos 表子集；program_id 由命令统一注入）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTodoInput {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub start_min: Option<i64>,
    #[serde(default)]
    pub duration_min: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
}

/// 某天的 AI 生成菜单缓存（meals_json 结构由前端 types 约束，Rust 原样存取）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramDayMeals {
    pub program_id: i64,
    pub date: String,
    pub meals_json: String,
    pub updated_at: String,
}

/// 采购清单勾选状态（清单由前端实时聚合，这里只存「已买」标记）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingCheck {
    pub item_key: String,
    pub checked_at: String,
}
