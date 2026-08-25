//! 运动域数据模型 · 与前端 `src/types/exercise.ts` 对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workout {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub date: String,
    pub start_min: Option<i64>,
    pub duration_min: f64,
    pub kcal: f64,
    pub intensity: String,
    pub note: Option<String>,
    /// 来源会话（session_finish 落关联）；手动添加为 NULL
    pub session_id: Option<i64>,
    pub created_at: String,
}
