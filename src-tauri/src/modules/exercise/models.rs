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
    /// 客观档位（配速/逐组重量反推）。手动补录写入的是从 `effort` 派生的档位，
    /// 见 db.rs MIGRATION_0035 的说明。
    pub intensity: String,
    /// 体感强度 1–5：手动补录由用户口述；课程/跑步路径为 None
    pub effort: Option<i64>,
    pub note: Option<String>,
    /// 来源会话（session_finish 落关联）；手动添加为 NULL
    pub session_id: Option<i64>,
    pub created_at: String,
}
