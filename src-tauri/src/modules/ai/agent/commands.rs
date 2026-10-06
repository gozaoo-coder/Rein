//! agent 内核的 Tauri 命令。Phase 1 只有探测；Phase 2 起追加
//! `ai_agent_run` / `ai_agent_cancel` / `ai_agent_tool_result`。

use rusqlite::OptionalExtension;
use tauri::State;

use crate::error::{ReinError, Result};
use crate::state::AppState;

use crate::modules::ai::commands::{ai_model_from_row, AI_MODEL_COLS};
use super::llm::OpenAiCompatBackend;
use super::probe::{probe_model, AgentProbeResult};

/// 对指定模型执行六发能力探测（请求在 Rust 侧发起，不再依赖 WebView 环境）。
#[tauri::command]
pub async fn ai_probe(state: State<'_, AppState>, model_id: i64) -> Result<AgentProbeResult> {
    let config = {
        let conn = state.db.lock();
        conn.query_row(
            &format!("SELECT {AI_MODEL_COLS} FROM ai_models WHERE id = ?1"),
            [model_id],
            ai_model_from_row,
        )
        .optional()
        .map_err(ReinError::from)?
        .ok_or_else(|| ReinError::coded("not_found", "模型不存在或已删除"))?
    };

    let backend = OpenAiCompatBackend::new(config.base_url, config.api_key, config.model_id);
    Ok(probe_model(&backend).await)
}
