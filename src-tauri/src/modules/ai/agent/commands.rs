//! agent 内核的 Tauri 命令：探测（Phase 1）+ agent run / 取消 / 工具结果回传。
//!
//! 流式事件走 `app.emit("ai://agent")`（仿 `voice://asr` 先例，事件名是前后端契约）；
//! 工具在过渡期由前端执行（Rust 发 [`AgentEvent::ToolStarted`]，前端经
//! `ai_agent_tool_result` 回传结果），session 域迁移完成后该桥接常驻，其余工具
//! 逐步改为 Rust 注册表内部执行。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, State};

use crate::error::{ReinError, Result};
use crate::modules::ai::commands::{ai_model_from_row, AI_MODEL_COLS};
use crate::state::AppState;

use super::hub::{AgentHub, ToolBridge};
use super::llm::{ImageData, LlmBackend, LlmToolDef, LlmUsage, OpenAiCompatBackend, StreamDelta};
use super::turn::{run_turn, RunContext, ToolExecutor, TurnHooks, TurnInput};
use super::models::{AgentEvent, AgentRunParams, ToolOutcome, AGENT_EVENT};
use super::probe::{probe_model, AgentProbeResult};

/// 前端工具执行超时（web_search / web_fetch 等慢工具要留足时间）
const TOOL_RESULT_TIMEOUT: Duration = Duration::from_secs(120);

/// 读取模型配置行（探测与 run 共用）
fn load_model(state: &State<'_, AppState>, model_id: i64) -> Result<crate::modules::ai::models::AiModel> {
    let conn = state.db.lock();
    conn.query_row(
        &format!("SELECT {AI_MODEL_COLS} FROM ai_models WHERE id = ?1"),
        [model_id],
        ai_model_from_row,
    )
    .optional()
    .map_err(ReinError::from)?
    .ok_or_else(|| ReinError::coded("not_found", "模型不存在或已删除"))
}

// ---------------------------------------------------------
// 探测
// ---------------------------------------------------------

/// 对指定模型执行六发能力探测（请求在 Rust 侧发起，不再依赖 WebView 环境）。
#[tauri::command]
pub async fn ai_probe(state: State<'_, AppState>, model_id: i64) -> Result<AgentProbeResult> {
    let config = load_model(&state, model_id)?;
    let backend = OpenAiCompatBackend::new(config.base_url, config.api_key, config.model_id);
    Ok(probe_model(&backend).await)
}

// ---------------------------------------------------------
// agent run
// ---------------------------------------------------------

/// 过渡期工具执行器：等前端把结果送回来（含早到缓冲与超时兜底）
struct BridgeExecutor {
    bridge: Arc<ToolBridge>,
    timeout: Duration,
}

#[async_trait::async_trait]
impl ToolExecutor for BridgeExecutor {
    async fn execute(&self, call_id: &str, _name: &str, _args: &serde_json::Value) -> ToolOutcome {
        self.bridge.wait(call_id, self.timeout).await
    }
}

/// 把循环的结构化进度映射为前端事件
struct EmitHooks {
    app: AppHandle,
    run_id: String,
}

impl EmitHooks {
    fn emit(&self, ev: AgentEvent) {
        let _ = self.app.emit(AGENT_EVENT, ev);
    }
}

impl TurnHooks for EmitHooks {
    fn on_thinking_end(&self, content: &str) {
        self.emit(AgentEvent::ThinkingEnd {
            run_id: self.run_id.clone(),
            content: content.to_string(),
        });
    }

    fn on_step_retry(&self, attempt: u32, delay: Duration) {
        self.emit(AgentEvent::StepRetry {
            run_id: self.run_id.clone(),
            attempt,
            delay_ms: delay.as_millis() as u64,
        });
    }

    fn on_tool_started(&self, call_id: &str, name: &str, args: &serde_json::Value) {
        self.emit(AgentEvent::ToolStarted {
            run_id: self.run_id.clone(),
            call_id: call_id.to_string(),
            name: name.to_string(),
            args: args.clone(),
        });
    }

    fn on_tool_completed(&self, call_id: &str, name: &str, outcome: &ToolOutcome) {
        self.emit(AgentEvent::ToolCompleted {
            run_id: self.run_id.clone(),
            call_id: call_id.to_string(),
            name: name.to_string(),
            is_error: outcome.is_error,
            content: outcome.content.clone(),
        });
    }

    fn on_usage(&self, usage: &LlmUsage) {
        self.emit(AgentEvent::Usage { run_id: self.run_id.clone(), usage: *usage });
    }
}

/// 启动一次 agent run（异步循环在后台任务里跑，事件经 `ai://agent` 外发）。
/// 返回 `runId`；前端按它过滤事件、取消、回传工具结果。
#[tauri::command]
pub async fn ai_agent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, Arc<AgentHub>>,
    params: AgentRunParams,
) -> Result<String> {
    let config = load_model(&state, params.model_id)?;
    let backend: Arc<dyn LlmBackend> = Arc::new(OpenAiCompatBackend::new(
        config.base_url,
        config.api_key,
        config.model_id,
    ));

    let run_id = uuid::Uuid::new_v4().to_string();
    let bridge = ToolBridge::new();
    let executor: Arc<dyn ToolExecutor> = Arc::new(BridgeExecutor {
        bridge: Arc::clone(&bridge),
        timeout: TOOL_RESULT_TIMEOUT,
    });
    let hooks = EmitHooks { app: app.clone(), run_id: run_id.clone() };

    // 启动事件必须先于任何增量（前端据此初始化气泡/清空累积）
    let _ = app.emit(AGENT_EVENT, AgentEvent::Started { run_id: run_id.clone() });

    // token 增量热路径：通道 → 事件泵（循环本身与 Tauri 解耦，便于单测）
    let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel::<StreamDelta>();
    {
        let app = app.clone();
        let run_id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(d) = delta_rx.recv().await {
                let ev = match d {
                    StreamDelta::Text(delta) => AgentEvent::TextDelta { run_id: run_id.clone(), delta },
                    StreamDelta::Reasoning(delta) => {
                        AgentEvent::ThinkingDelta { run_id: run_id.clone(), delta }
                    }
                };
                let _ = app.emit(AGENT_EVENT, ev);
            }
        });
    }

    let input = TurnInput {
        prompt: params.prompt.clone(),
        images: params.images.clone(),
        thinking_level: params.thinking_level.clone(),
        temperature: params.temperature,
        max_tokens: params.max_tokens,
    };
    let messages = params.messages.clone();
    // 系统提示词与工具集放共享上下文：load_tools 装载后前端热更新，下一步生效
    let context = Arc::new(Mutex::new(RunContext {
        system: params.system_prompt.clone(),
        tools: params.tools.clone(),
    }));

    let hub_arc: Arc<AgentHub> = Arc::clone(&hub);
    let task_run_id = run_id.clone();
    let task_app = app.clone();
    let task_context = Arc::clone(&context);
    let handle = tauri::async_runtime::spawn(async move {
        let result = run_turn(
            backend.as_ref(),
            &executor,
            task_context,
            messages,
            input,
            delta_tx,
            &hooks,
        )
        .await;
        match result {
            Ok(res) => {
                let _ = task_app.emit(
                    AGENT_EVENT,
                    AgentEvent::Done {
                        run_id: task_run_id.clone(),
                        text: res.content,
                        thinking: res.reasoning,
                        usage: res.usage,
                        stop_reason: res.stop_reason,
                        steps: res.steps,
                        tools: res.tools,
                        duration_ms: res.duration_ms,
                    },
                );
            }
            Err(e) => {
                let _ = task_app.emit(
                    AGENT_EVENT,
                    AgentEvent::Error { run_id: task_run_id.clone(), message: e.to_string() },
                );
            }
        }
        hub_arc.finish(&task_run_id);
    });

    hub.register(
        run_id.clone(),
        move || handle.abort(),
        Arc::clone(&bridge),
        context,
    );
    Ok(run_id)
}

/// 热更新 run 的系统提示词与工具集（`load_tools` 动态装载：前端执行完装载工具后，
/// 把重算的提示词与工具清单推过来，下一步 completion 立即生效）
#[tauri::command]
pub fn ai_agent_update_context(
    hub: State<'_, Arc<AgentHub>>,
    run_id: String,
    system_prompt: String,
    tools: Vec<LlmToolDef>,
) -> Result<bool> {
    Ok(hub.update_context(&run_id, Some(system_prompt), tools))
}

/// 取消一次 run（中止后台循环任务；已产生的 UI 内容由前端自行处置）
#[tauri::command]
pub fn ai_agent_cancel(hub: State<'_, Arc<AgentHub>>, run_id: String) -> Result<bool> {
    Ok(hub.cancel(&run_id))
}

/// 前端回传一个工具调用的执行结果（过渡期桥接；未命中等待者会被缓冲）
#[tauri::command]
pub fn ai_agent_tool_result(
    hub: State<'_, Arc<AgentHub>>,
    run_id: String,
    call_id: String,
    content: String,
    is_error: bool,
    images: Option<Vec<ImageData>>,
) -> Result<bool> {
    let outcome = ToolOutcome {
        content,
        is_error,
        images: images.unwrap_or_default(),
    };
    Ok(hub.deliver_tool_result(&run_id, &call_id, outcome))
}
