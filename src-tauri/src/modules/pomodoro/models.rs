//! 番茄钟域数据模型 · 与前端 `src/types/pomodoro.ts` 对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroSession {
    pub id: i64,
    pub todo_id: Option<i64>,
    pub started_at: String,
    pub ended_at: String,
    pub focus_min: f64,
    pub break_min: f64,
    pub completed: bool,
}

/// 前端提交体（无 id）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroSessionInput {
    pub todo_id: Option<i64>,
    pub started_at: String,
    pub ended_at: String,
    pub focus_min: f64,
    pub break_min: f64,
    pub completed: bool,
}
