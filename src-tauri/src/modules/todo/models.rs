//! 待办域数据模型 · 与前端 `src/types/todo.ts` 对应。

use serde::{Deserialize, Serialize};

/// 重复规则（存 todos.rec_rule，JSON）。展开策略：模板行保持 rec_rule，
/// 实例行写 rec_key = "模板id:日期"，由 `sync_recurrences` 幂等物化到滚动窗口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecRule {
    /// daily | weekly | interval
    pub freq: String,
    /// weekly 专用：周一=0 … 周日=6
    #[serde(default)]
    pub weekdays: Vec<i64>,
    /// interval 专用：每 N 天
    #[serde(default)]
    pub interval_days: i64,
    /// 结束日期（含），null = 永不
    #[serde(default)]
    pub end_date: Option<String>,
}

/// 子任务清单（存 todos.subtasks，JSON 数组）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSubtask {
    pub title: String,
    #[serde(default)]
    pub done: bool,
}

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
    /// 来源健康方案 id；NULL = 用户手动创建（update 不写此列，保持来源不变）
    #[serde(default)]
    pub program_id: Option<i64>,
    /// 重复规则；NULL = 不重复。模板行的 rec_key 为 "id:自己的日期"
    #[serde(default)]
    pub rec_rule: Option<RecRule>,
    /// 重复实例键 "模板id:日期"；NULL = 非重复实例
    #[serde(default)]
    pub rec_key: Option<String>,
    /// 子任务清单；NULL/空 = 无
    #[serde(default)]
    pub subtasks: Option<Vec<TodoSubtask>>,
}
