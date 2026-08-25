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
}
