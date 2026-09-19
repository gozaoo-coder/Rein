//! 训练课会话数据模型 · 与前端 `src/types/session.ts` 对应。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub plan_id: String,
    pub plan_name: String,
    /// active | finished | aborted
    pub status: String,
    pub started_at: String,
    /// SQLite datetime('now')，UTC
    pub updated_at: String,
    pub ex_index: i64,
    pub set_index: i64,
    pub weight_kg: f64,
    /// 快照间自动累加的真实流逝秒数（服务端计算）
    pub elapsed_sec: f64,
    /// 前端状态快照（doneSets / phase 等，见 stores/session.ts）
    pub state: Value,
}

/// 正常结束（用户确认保存）时的提交体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishInput {
    pub id: i64,
    pub name: String,
    pub workout_type: String,
    pub date: String,
    pub duration_min: f64,
    pub intensity: Option<String>,
    pub kcal: f64,
    pub note: Option<String>,
    /// 逐组做组明细（session_finish 事务内展开写入 workout_sets）；旧客户端缺省 = 空
    #[serde(default)]
    pub sets: Vec<FinishSet>,
}

/// 一行逐组记录 · 与前端 `StrengthSetRow` 对应
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishSet {
    pub exercise_key: String,
    pub exercise_name: String,
    /// 动作库 id（课程条目携带）；缺省时服务端按名称兜底解析
    #[serde(default)]
    pub exercise_id: Option<String>,
    pub kind: String,
    pub set_no: i64,
    pub weight_kg: Option<f64>,
    pub reps: Option<i64>,
    pub sec: Option<i64>,
    #[serde(default)]
    pub warmup: bool,
}

/// 逐组记录查询行（JOIN workouts 取日期）· 重量曲线与训练建议引擎的数据源。
/// `exerciseId` 是聚合键；`exerciseName` 只是历史快照（动作库改名不追溯）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthSetRecord {
    pub workout_id: i64,
    pub date: String,
    pub exercise_key: String,
    pub exercise_id: Option<String>,
    pub exercise_name: String,
    pub kind: String,
    pub set_no: i64,
    pub weight_kg: Option<f64>,
    pub reps: Option<i64>,
    pub sec: Option<i64>,
    pub warmup: bool,
}

/// 有力量记录的动作引用（按最近训练在前）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthExerciseRef {
    /// 动作库 id；老库未回填时为空字符串（前端回落 name 作键）
    pub exercise_id: String,
    /// 展示名：库内名优先（动作库改名后曲线卡跟着变）
    pub name: String,
    pub last_date: String,
    pub sessions: i64,
}

/// 某动作最近一次做组重量（沉浸页「上次重量」预填）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthLastWeight {
    pub exercise_id: String,
    pub name: String,
    pub weight_kg: f64,
    pub reps: Option<i64>,
    pub date: String,
}
