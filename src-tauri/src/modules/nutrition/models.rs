//! 营养域数据模型 · 与前端 `src/types/nutrition.ts` 对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTargets {
    pub kcal: f64,
    pub protein: f64,
    pub carb: f64,
    pub fat: f64,
    pub sodium_mg: f64,
    pub water_ml: f64,
}

/// 当日实际摄入聚合（字段语义同 Food 的每 100g 值）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutrientIntake {
    pub kcal: f64,
    pub protein: f64,
    pub carb: f64,
    pub fat: f64,
    pub fiber: f64,
    pub sugar: f64,
    pub sodium_mg: f64,
    pub potassium_mg: f64,
    pub calcium_mg: f64,
    pub iron_mg: f64,
    pub zinc_mg: f64,
    pub magnesium_mg: f64,
    pub vit_a_ug: f64,
    pub vit_c_mg: f64,
    pub vit_d_ug: f64,
    pub vit_e_mg: f64,
    pub vit_b12_ug: f64,
    pub folate_ug: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySummary {
    pub date: String,
    pub intake: NutrientIntake,
    pub targets: DailyTargets,
    /// 当日运动消耗（来自 exercise 模块）
    pub exercise_kcal: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub nickname: String,
    pub sex: Option<String>,
    pub birthday: Option<String>,
    pub height_cm: Option<f64>,
    pub weight_kg: Option<f64>,
    pub target_weight_kg: Option<f64>,
    pub activity_level: String,
    pub goal: String,
    pub targets: DailyTargets,
    /// 每周可训练天数（方案生成的频率上限）；NULL = 未设置
    pub training_days_per_week: Option<i64>,
    /// 偏好运动时段（morning/noon/evening 子集，JSON 文本列）
    pub preferred_time_slots: Option<Vec<String>>,
    /// 器械条件：gym（健身房）/ home（居家徒手）/ mixed；NULL = 未设置
    pub equipment: Option<String>,
    /// 忌口 / 过敏关键词列表（JSON 文本列），方案生成时过滤食谱
    pub diet_restrictions: Option<Vec<String>>,
    /// 训练经验：beginner / intermediate / advanced
    pub experience: Option<String>,
}

/// 方案计算器参数快照：`saved_at` 为 NULL 表示从未保存过（前端回落到资料推导）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcState {
    pub sex: Option<String>,
    pub age: Option<i64>,
    pub height_cm: Option<f64>,
    pub weight_kg: Option<f64>,
    pub activity_level: String,
    pub goal: String,
    pub saved_at: Option<String>,
}

/// 一条体重 / 身高记录（按天一条；两项均可为空，至少一项有值）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyMetric {
    pub id: i64,
    pub date: String,
    pub weight_kg: Option<f64>,
    pub height_cm: Option<f64>,
    pub created_at: String,
}

/// 补录入参：同日再记时只覆盖提供的项
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyMetricInput {
    pub date: String,
    pub weight_kg: Option<f64>,
    pub height_cm: Option<f64>,
}
