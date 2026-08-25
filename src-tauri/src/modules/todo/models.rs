//! 待办域数据模型 · 与前端 `src/types/todo.ts` 对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub notes: Option<String>,
    /// 计划日期，null = 无日期（收件箱）
    pub date: Option<String>,
    /// 距 00:00 的分钟数；有值出现在日时间线
    pub start_min: Option<i64>,
    pub duration_min: Option<i64>,
    pub category: String,
    pub priority: i64,
    /// todo | doing | done
    pub status: String,
    pub completed_at: Option<String>,
    pub created_at: String,
}
