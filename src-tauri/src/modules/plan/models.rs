//! 训练课程数据模型 · 与前端 `src/types/plan.ts` 对应。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    /// 保存训练记录时使用的运动类型（strength / hiit / yoga…）
    pub workout_type: String,
    /// 动作数组：结构由前端 `PlanExercise` 约束，此处原样透传
    pub exercises: Value,
    /// 最近一次开始训练的时间（SQLite datetime，UTC）；从未使用为 NULL
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建 / 更新课程提交体（id 由前端生成：新建用 randomUUID）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default = "default_workout_type")]
    pub workout_type: String,
    #[serde(default)]
    pub exercises: Value,
}

fn default_workout_type() -> String {
    "strength".into()
}
