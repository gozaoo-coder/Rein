//! agent 工具循环：请求 → 流式增量 → 收 tool_calls → 执行 → 回灌 → 直到无调用。
//!
//! 骨架移植自 EffiBuddy `kernel::agent::run_turn_opts`（MIT，同作者），按 Rein 形态裁剪：
//! - **不移植 JSONL 账本**：消息历史用每 run 内存 `Vec<LlmMessage>`（Rein 的持久化
//!   口径不变 —— `ai_chat_messages` 存 UI 记录，工具中间轮不跨会话回放）；
//! - 工具执行走 [`ToolExecutor`] 缝：过渡期实现为「事件回前端、命令回传结果」的
//!   桥接（session 域常驻），工具迁移完成后换成 Rust 注册表；
//! - 保留 EffiBuddy 的硬纪律：子任务 panic / 取消时**对账补齐错误结果**（否则下一步
//!   prompt 缺 tool 消息，provider 直接 400）。工具并发不设上限（用户要求去掉
//!   EffiBuddy 的 4 并发闸）：执行器各自有超时与取消语义，徒增排队延迟。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value;

use crate::error::{ReinError, Result};

use super::llm::{
    DeltaTx, ImageData, LlmBackend, LlmMessage, LlmRequest, LlmToolCall, LlmToolDef, LlmUsage,
};
use super::models::ToolOutcome;
use super::retry::{plan_retry, RetryPlan};

/// 单次 run 的步数上限（防模型陷入工具循环）
pub const MAX_STEPS: u32 = 32;

/// run 级上下文：每步 completion 前读取一次。
///
/// 放在共享句柄里而不是 [`TurnInput`] 里，是为了支持**运行中热更新**：
/// 前端执行 `load_tools` 后把新工具组与重算的系统提示词推给 Rust（`ai_agent_update_context`），
/// 下一步立即生效（chat 的动态装载语义，与 pi 的 `prepareNextTurnWithContext` 等价）。
#[derive(Debug, Clone, Default)]
pub struct RunContext {
    pub system: Option<String>,
    pub tools: Vec<LlmToolDef>,
}

/// 一轮 run 的输入
#[derive(Debug, Clone, Default)]
pub struct TurnInput {
    pub prompt: String,
    pub images: Vec<ImageData>,
    pub thinking_level: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// 一轮 run 的结果
#[derive(Debug, Clone, Default)]
pub struct TurnResult {
    pub content: String,
    pub reasoning: Option<String>,
    pub usage: Option<LlmUsage>,
    /// `stop`（模型自然收尾）| `max_steps`（达步数上限）
    pub stop_reason: String,
    pub steps: u32,
    pub tools: u32,
    pub duration_ms: u64,
}

/// 工具执行缝：过渡期＝前端桥接，工具迁移完成后＝Rust 注册表
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn execute(&self, call_id: &str, name: &str, args: &Value) -> ToolOutcome;
}

/// 结构化进度回调（token 增量走 [`DeltaTx`] 热路径，这里只走每步一次的进度）
pub trait TurnHooks: Send + Sync {
    /// 单步思考结束（该步累计思考全文，对齐 pi 的 thinking_end 契约）
    fn on_thinking_end(&self, _content: &str) {}
    /// 某步因瞬态错误即将重试（前端应重置本步累积，避免重复显示）
    fn on_step_retry(&self, _attempt: u32, _delay: Duration) {}
    /// 模型请求执行工具（桥接期＝前端立即执行）
    fn on_tool_started(&self, _call_id: &str, _name: &str, _args: &Value) {}
    fn on_tool_completed(&self, _call_id: &str, _name: &str, _outcome: &ToolOutcome) {}
    fn on_usage(&self, _usage: &LlmUsage) {}
}

/// 空回调（测试 / 无 UI 场景）
pub struct NoHooks;
impl TurnHooks for NoHooks {}

/// 跑一轮完整对话（含内部工具调用循环）。
///
/// `context` 每步重新读取（支持运行中热更新，见 [`RunContext`]）。
pub async fn run_turn(
    backend: &dyn LlmBackend,
    executor: &Arc<dyn ToolExecutor>,
    context: Arc<Mutex<RunContext>>,
    mut messages: Vec<LlmMessage>,
    input: TurnInput,
    deltas: DeltaTx,
    hooks: &dyn TurnHooks,
) -> Result<TurnResult> {
    let started = Instant::now();
    messages.push(LlmMessage::user_with_images(input.prompt.clone(), input.images.clone()));

    let mut steps: u32 = 0;
    let mut tools: u32 = 0;
    let mut usage_acc: Option<LlmUsage> = None;
    let mut content = String::new();
    let mut reasoning: Option<String> = None;
    let mut stop_reason = "stop";

    loop {
        // 先判上限再计数：`steps` 只统计真正发出的 completion 次数
        if steps >= MAX_STEPS {
            stop_reason = "max_steps";
            break;
        }
        steps += 1;

        let (system, tool_defs) = {
            let ctx = context.lock().unwrap();
            (ctx.system.clone(), ctx.tools.clone())
        };
        let req = LlmRequest {
            model: backend.model().to_string(),
            system,
            messages: messages.clone(),
            tools: tool_defs,
            temperature: input.temperature,
            max_tokens: input.max_tokens,
            thinking_level: input.thinking_level.clone(),
        };

        // 一步 completion（瞬态错误退避重试；重试会把该步增量重新发一遍，
        // 故经 on_step_retry 通知前端重置本步累积）
        let resp = {
            let mut attempt: usize = 0;
            loop {
                match backend.stream_complete(&req, deltas.clone()).await {
                    Ok(r) => break r,
                    Err(e) => {
                        let msg = e.to_string();
                        match plan_retry(&msg, attempt) {
                            RetryPlan::Retry(delay) => {
                                attempt += 1;
                                hooks.on_step_retry(attempt as u32, delay);
                                tokio::time::sleep(delay).await;
                            }
                            RetryPlan::Fail => return Err(ReinError::Message(msg)),
                        }
                    }
                }
            }
        };

        if let Some(u) = &resp.usage {
            hooks.on_usage(u);
            add_usage(&mut usage_acc, u);
        }
        if let Some(r) = &resp.reasoning {
            hooks.on_thinking_end(r);
        }
        content = resp.content.clone();
        reasoning = resp.reasoning.clone();

        if !resp.has_tool_calls() {
            let mut asst = LlmMessage::assistant(resp.content.clone());
            asst.reasoning = resp.reasoning.clone();
            messages.push(asst);
            break;
        }

        // 模型要调用工具：先落 assistant（含 content / reasoning / tool_calls）
        let mut asst = LlmMessage::assistant(resp.content.clone());
        asst.reasoning = resp.reasoning.clone();
        asst.tool_calls = resp.tool_calls.clone();
        messages.push(asst);

        tools += resp.tool_calls.len() as u32;
        for tc in &resp.tool_calls {
            hooks.on_tool_started(&tc.id, &tc.name, &tc.arguments);
        }

        let results = execute_tools(executor, &resp.tool_calls).await;
        for (tc, outcome) in &results {
            hooks.on_tool_completed(&tc.id, &tc.name, outcome);
        }
        // tool 结果按「调用顺序」回灌（确定性；provider 要求紧随 tool_calls 且连续）
        for (tc, outcome) in results {
            messages.push(if outcome.images.is_empty() {
                LlmMessage::tool(tc.id, outcome.content)
            } else {
                LlmMessage::tool_with_images(tc.id, outcome.content, outcome.images)
            });
        }
    }

    Ok(TurnResult {
        content,
        reasoning,
        usage: usage_acc,
        stop_reason: stop_reason.to_string(),
        steps,
        tools,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn add_usage(acc: &mut Option<LlmUsage>, u: &LlmUsage) {
    let a = acc.get_or_insert_with(LlmUsage::default);
    a.input += u.input;
    a.output += u.output;
    a.cache_read += u.cache_read;
    a.cache_write += u.cache_write;
    a.reasoning += u.reasoning;
    a.total += u.total;
}

/// 并发执行一批工具调用（不设并发上限），按调用顺序返回结果。
///
/// 子任务 panic / 取消时其结果永不抵达通道 —— 此处对账补一条错误结果，
/// 保证「assistant 的每个 tool_call 都有配对 tool 消息」这一 provider 硬要求
/// 在任何子任务命运下都成立（缺了下一步 prompt 直接 400）。
async fn execute_tools(
    executor: &Arc<dyn ToolExecutor>,
    calls: &[LlmToolCall],
) -> Vec<(LlmToolCall, ToolOutcome)> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(usize, ToolOutcome)>();
    let mut set = tokio::task::JoinSet::new();

    for (idx, tc) in calls.iter().enumerate() {
        let executor = Arc::clone(executor);
        let tc = tc.clone();
        let tx = tx.clone();
        set.spawn(async move {
            let outcome = executor.execute(&tc.id, &tc.name, &tc.arguments).await;
            let _ = tx.send((idx, outcome));
        });
    }
    drop(tx);

    let mut slots: Vec<Option<ToolOutcome>> = vec![None; calls.len()];
    while let Some((idx, outcome)) = rx.recv().await {
        slots[idx] = Some(outcome);
    }
    // 收割句柄：panic 的子任务在这里被观察到（其结果槽位保持 None）
    let mut panicked = 0usize;
    while let Some(joined) = set.join_next().await {
        if joined.is_err() {
            panicked += 1;
        }
    }
    if panicked > 0 {
        eprintln!("[ai-agent] {panicked} 个工具执行子任务异常终止，已补记错误结果");
    }

    calls
        .iter()
        .enumerate()
        .map(|(i, tc)| {
            let outcome = slots[i]
                .take()
                .unwrap_or_else(|| ToolOutcome::error("[内部错误] 工具执行任务异常终止"));
            (tc.clone(), outcome)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::agent::llm::mock::{err_step, tool_call_response, MockBackend};
    use crate::modules::ai::agent::llm::{LlmResponse, StreamDelta};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// 记录调用并返回固定结果的执行器
    struct RecordingExecutor {
        calls: Mutex<Vec<(String, String, Value)>>,
        outcome: fn(&str) -> ToolOutcome,
    }

    impl RecordingExecutor {
        fn ok() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                outcome: |name| ToolOutcome::ok(format!("{name} 的结果")),
            })
        }
    }

    #[async_trait]
    impl ToolExecutor for RecordingExecutor {
        async fn execute(&self, call_id: &str, name: &str, args: &Value) -> ToolOutcome {
            self.calls
                .lock()
                .unwrap()
                .push((call_id.to_string(), name.to_string(), args.clone()));
            (self.outcome)(name)
        }
    }

    /// 记录并发峰值与 hook 事件的执行器
    struct ConcurrencyExecutor {
        limit_seen: AtomicUsize,
        active: AtomicUsize,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ToolExecutor for ConcurrencyExecutor {
        async fn execute(&self, _call_id: &str, name: &str, _args: &Value) -> ToolOutcome {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.limit_seen.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            self.calls.fetch_add(1, Ordering::SeqCst);
            ToolOutcome::ok(name)
        }
    }

    /// 指定 call_id 直接 panic 的执行器
    struct PanicExecutor {
        boom_id: String,
    }

    #[async_trait]
    impl ToolExecutor for PanicExecutor {
        async fn execute(&self, call_id: &str, name: &str, _args: &Value) -> ToolOutcome {
            if call_id == self.boom_id {
                panic!("模拟工具执行崩溃");
            }
            ToolOutcome::ok(format!("{name} ok"))
        }
    }

    /// 记录结构化回调的 hooks
    #[derive(Default)]
    struct RecordingHooks {
        thinking_ends: Mutex<Vec<String>>,
        retries: Mutex<Vec<(u32, u64)>>,
        tool_started: Mutex<Vec<String>>,
        tool_completed: Mutex<Vec<(String, bool)>>,
    }

    impl TurnHooks for RecordingHooks {
        fn on_thinking_end(&self, content: &str) {
            self.thinking_ends.lock().unwrap().push(content.to_string());
        }
        fn on_step_retry(&self, attempt: u32, delay: Duration) {
            self.retries.lock().unwrap().push((attempt, delay.as_millis() as u64));
        }
        fn on_tool_started(&self, _call_id: &str, name: &str, _args: &Value) {
            self.tool_started.lock().unwrap().push(name.to_string());
        }
        fn on_tool_completed(&self, _call_id: &str, name: &str, outcome: &ToolOutcome) {
            self.tool_completed
                .lock()
                .unwrap()
                .push((name.to_string(), outcome.is_error));
        }
    }

    fn input() -> TurnInput {
        TurnInput { prompt: "你好".into(), ..Default::default() }
    }

    fn ctx(tools: Vec<LlmToolDef>) -> Arc<Mutex<RunContext>> {
        Arc::new(Mutex::new(RunContext { system: None, tools }))
    }

    /// 具体执行器 → trait 对象（保留具体绑定以便断言其内部记录）
    fn dyn_exec<T: ToolExecutor + 'static>(e: &Arc<T>) -> Arc<dyn ToolExecutor> {
        Arc::clone(e) as Arc<dyn ToolExecutor>
    }

    fn tool(name: &str) -> LlmToolDef {
        LlmToolDef {
            name: name.into(),
            description: format!("{name} 描述"),
            parameters: serde_json::json!({ "type": "object" }),
        }
    }

    fn drain(mut rx: tokio::sync::mpsc::UnboundedReceiver<StreamDelta>) -> Vec<StreamDelta> {
        let mut out = Vec::new();
        while let Ok(d) = rx.try_recv() {
            out.push(d);
        }
        out
    }

    #[tokio::test]
    async fn single_shot_turn_without_tools() {
        let backend = MockBackend::text("m", "答案是 42");
        let exec = RecordingExecutor::ok();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(
            &backend,
            &dyn_exec(&exec),
            ctx(Vec::new()),
            Vec::new(),
            input(),
            tx,
            &NoHooks,
        )
        .await
        .unwrap();
        assert_eq!(res.content, "答案是 42");
        assert_eq!(res.steps, 1);
        assert_eq!(res.tools, 0);
        assert_eq!(res.stop_reason, "stop");
        assert_eq!(drain(rx), vec![StreamDelta::Text("答案是 42".into())]);
        assert!(exec.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn tool_round_trip_orders_messages_and_continues_to_final() {
        let backend = MockBackend::new(
            "m",
            vec![
                Ok(tool_call_response("c1", "search_food", serde_json::json!({"query":"鸡蛋"}))),
                Ok(LlmResponse { content: "找到鸡蛋了".into(), ..Default::default() }),
            ],
        );
        let exec = RecordingExecutor::ok();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(
            &backend,
            &dyn_exec(&exec),
            ctx(vec![tool("search_food")]),
            Vec::new(),
            input(),
            tx,
            &NoHooks,
        )
        .await
        .unwrap();
        assert_eq!(res.content, "找到鸡蛋了");
        assert_eq!(res.steps, 2);
        assert_eq!(res.tools, 1);
        assert_eq!(exec.calls.lock().unwrap().len(), 1);
        assert_eq!(exec.calls.lock().unwrap()[0].1, "search_food");

        // 第二次请求的消息序列：user → assistant(tool_calls) → tool(结果)
        let reqs = backend.requests();
        assert_eq!(reqs.len(), 2);
        let msgs = &reqs[1].messages;
        let roles: Vec<&str> = msgs.iter().map(|m| match m.role {
            crate::modules::ai::agent::llm::LlmRole::User => "user",
            crate::modules::ai::agent::llm::LlmRole::Assistant => "assistant",
            crate::modules::ai::agent::llm::LlmRole::Tool => "tool",
            crate::modules::ai::agent::llm::LlmRole::System => "system",
        }).collect();
        assert_eq!(roles, vec!["user", "assistant", "tool"]);
        assert_eq!(msgs[1].tool_calls[0].id, "c1");
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(msgs[2].content, "search_food 的结果");
        // 工具定义随每步请求发出
        assert_eq!(reqs[1].tools.len(), 1);
    }

    #[tokio::test]
    async fn tools_run_fully_parallel_without_cap() {
        let calls: Vec<LlmToolCall> = (0..6)
            .map(|i| LlmToolCall {
                id: format!("c{i}"),
                name: "slow_tool".into(),
                arguments: serde_json::json!({}),
            })
            .collect();
        let backend = MockBackend::new(
            "m",
            vec![
                Ok(LlmResponse { tool_calls: calls, ..Default::default() }),
                Ok(LlmResponse { content: "完成".into(), ..Default::default() }),
            ],
        );
        let exec = Arc::new(ConcurrencyExecutor {
            limit_seen: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
        });
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(
            &backend,
            &dyn_exec(&exec),
            ctx(vec![tool("slow_tool")]),
            Vec::new(),
            input(),
            tx,
            &NoHooks,
        )
        .await
        .unwrap();
        assert_eq!(res.tools, 6);
        assert_eq!(exec.calls.load(Ordering::SeqCst), 6);
        let peak = exec.limit_seen.load(Ordering::SeqCst);
        assert_eq!(peak, 6, "不设并发上限：6 个慢工具应全部同时跑（实测峰值 {peak}）");
    }

    #[tokio::test]
    async fn panicked_tool_is_reconciled_with_error_result_and_loop_continues() {
        let backend = MockBackend::new(
            "m",
            vec![
                Ok(LlmResponse {
                    tool_calls: vec![
                        LlmToolCall { id: "a".into(), name: "t1".into(), arguments: serde_json::json!({}) },
                        LlmToolCall { id: "boom".into(), name: "t2".into(), arguments: serde_json::json!({}) },
                    ],
                    ..Default::default()
                }),
                Ok(LlmResponse { content: "继续完成".into(), ..Default::default() }),
            ],
        );
        let exec: Arc<dyn ToolExecutor> = Arc::new(PanicExecutor { boom_id: "boom".into() });
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(&backend, &exec, ctx(vec![tool("t1"), tool("t2")]), Vec::new(), input(), tx, &NoHooks)
            .await
            .unwrap();
        assert_eq!(res.content, "继续完成", "崩溃的工具不应打断整轮");
        assert_eq!(res.tools, 2);

        // 配对不变量：assistant 的两个 tool_call 都有 tool 结果（崩溃的补错误）
        let reqs = backend.requests();
        let msgs = &reqs[1].messages;
        let tool_msgs: Vec<_> = msgs.iter().filter(|m| m.tool_call_id.is_some()).collect();
        assert_eq!(tool_msgs.len(), 2);
        let boom = tool_msgs.iter().find(|m| m.tool_call_id.as_deref() == Some("boom")).unwrap();
        assert!(boom.content.contains("内部错误"), "崩溃结果应可读: {}", boom.content);
    }

    #[tokio::test]
    async fn transient_error_retries_then_succeeds() {
        let backend = MockBackend::new(
            "m",
            vec![
                err_step("LLM 请求发送失败: error sending request: connection refused"),
                Ok(LlmResponse { content: "重试成功".into(), ..Default::default() }),
            ],
        );
        let exec = RecordingExecutor::ok();
        let hooks = RecordingHooks::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(&backend, &dyn_exec(&exec), ctx(Vec::new()), Vec::new(), input(), tx, &hooks)
            .await
            .unwrap();
        assert_eq!(res.content, "重试成功");
        let retries = hooks.retries.lock().unwrap();
        assert_eq!(retries.len(), 1, "应有且仅有一次重试通知");
        assert_eq!(retries[0].0, 1);
        assert!(retries[0].1 <= 400, "短退避（不等真实网络尺度）");
        assert_eq!(backend.requests().len(), 2);
    }

    #[tokio::test]
    async fn non_transient_error_fails_fast_without_retry() {
        let backend = MockBackend::new("m", vec![err_step("LLM 请求失败（401 Unauthorized）: bad key")]);
        let exec = RecordingExecutor::ok();
        let hooks = RecordingHooks::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let err = run_turn(&backend, &dyn_exec(&exec), ctx(Vec::new()), Vec::new(), input(), tx, &hooks)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("401"));
        assert!(hooks.retries.lock().unwrap().is_empty());
        assert_eq!(backend.requests().len(), 1);
    }

    #[tokio::test]
    async fn max_steps_guard_stops_runaway_loop() {
        // 后端每步都要调工具：循环必须在 MAX_STEPS 处收敛而不是无限跑
        struct AlwaysTools;
        #[async_trait]
        impl ToolExecutor for AlwaysTools {
            async fn execute(&self, _c: &str, name: &str, _a: &Value) -> ToolOutcome {
                ToolOutcome::ok(name)
            }
        }
        // 用 40 步工具脚本喂满上限
        let script: Vec<_> = (0..MAX_STEPS + 4)
            .map(|i| Ok(tool_call_response(format!("c{i}"), "loop_tool", serde_json::json!({}))))
            .collect();
        let backend = MockBackend::new("m", script);
        let exec: Arc<dyn ToolExecutor> = Arc::new(AlwaysTools);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(&backend, &exec, ctx(vec![tool("loop_tool")]), Vec::new(), input(), tx, &NoHooks)
            .await
            .unwrap();
        assert_eq!(res.stop_reason, "max_steps");
        assert_eq!(res.steps, MAX_STEPS);
        assert_eq!(backend.requests().len(), MAX_STEPS as usize);
    }

    #[tokio::test]
    async fn thinking_and_usage_flow_through_hooks() {
        let backend = MockBackend::new(
            "m",
            vec![Ok(LlmResponse {
                content: "答".into(),
                reasoning: Some("想过".into()),
                usage: Some(LlmUsage { input: 10, output: 2, total: 12, ..Default::default() }),
                ..Default::default()
            })],
        );
        let exec = RecordingExecutor::ok();
        let hooks = RecordingHooks::default();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(&backend, &dyn_exec(&exec), ctx(Vec::new()), Vec::new(), input(), tx, &hooks)
            .await
            .unwrap();
        assert_eq!(hooks.thinking_ends.lock().unwrap().as_slice(), ["想过"]);
        assert_eq!(res.usage.map(|u| u.total), Some(12));
        let deltas = drain(rx);
        assert!(deltas.contains(&StreamDelta::Reasoning("想过".into())));
        assert!(deltas.contains(&StreamDelta::Text("答".into())));
    }

    #[tokio::test]
    async fn mid_run_context_update_applies_to_next_step() {
        // 模拟 chat 的 load_tools：工具执行时（前端桥接期）把新工具组与
        // 重算的系统提示词推回 Rust，下一步请求立即生效
        struct ContextUpdater {
            ctx: Arc<Mutex<RunContext>>,
        }
        #[async_trait]
        impl ToolExecutor for ContextUpdater {
            async fn execute(&self, _c: &str, _n: &str, _a: &Value) -> ToolOutcome {
                let mut c = self.ctx.lock().unwrap();
                c.system = Some("装载后的系统提示".into());
                c.tools = vec![LlmToolDef {
                    name: "loaded_tool".into(),
                    description: "新装载的工具".into(),
                    parameters: serde_json::json!({ "type": "object" }),
                }];
                ToolOutcome::ok("已装载 diet 组")
            }
        }

        let backend = MockBackend::new(
            "m",
            vec![
                Ok(tool_call_response("c1", "load_tools", serde_json::json!({"groups":["diet"]}))),
                Ok(LlmResponse { content: "装载后完成".into(), ..Default::default() }),
            ],
        );
        let context = ctx(vec![tool("load_tools")]);
        let exec: Arc<dyn ToolExecutor> = Arc::new(ContextUpdater { ctx: Arc::clone(&context) });
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(
            &backend,
            &exec,
            context,
            Vec::new(),
            input(),
            tx,
            &NoHooks,
        )
        .await
        .unwrap();
        assert_eq!(res.content, "装载后完成");
        let reqs = backend.requests();
        assert_eq!(reqs[0].tools.len(), 1);
        assert_eq!(reqs[0].tools[0].name, "load_tools");
        assert_eq!(reqs[1].system.as_deref(), Some("装载后的系统提示"));
        assert_eq!(reqs[1].tools[0].name, "loaded_tool", "下一步应看到新装载的工具");
    }

    #[tokio::test]
    async fn history_images_and_tool_hooks_are_observed() {
        let backend = MockBackend::new(
            "m",
            vec![
                Ok(tool_call_response("c1", "zoom_image", serde_json::json!({}))),
                Ok(LlmResponse { content: "看完了".into(), ..Default::default() }),
            ],
        );
        // 带图工具结果：images 应随 tool 消息回灌
        struct ImageExecutor;
        #[async_trait]
        impl ToolExecutor for ImageExecutor {
            async fn execute(&self, _c: &str, _n: &str, _a: &Value) -> ToolOutcome {
                ToolOutcome {
                    content: "放大完成".into(),
                    is_error: false,
                    images: vec![ImageData { data: "aWNv".into(), mime: "image/png".into() }],
                }
            }
        }
        let exec: Arc<dyn ToolExecutor> = Arc::new(ImageExecutor);
        let hooks = RecordingHooks::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let res = run_turn(&backend, &exec, ctx(vec![tool("zoom_image")]), Vec::new(), input(), tx, &hooks)
            .await
            .unwrap();
        assert_eq!(res.content, "看完了");
        assert_eq!(hooks.tool_started.lock().unwrap().as_slice(), ["zoom_image"]);
        assert_eq!(
            hooks.tool_completed.lock().unwrap().as_slice(),
            [("zoom_image".to_string(), false)]
        );
        let reqs = backend.requests();
        let tool_msg = reqs[1]
            .messages
            .iter()
            .find(|m| m.tool_call_id.is_some())
            .unwrap();
        assert_eq!(tool_msg.images.len(), 1, "工具结果附图随消息回灌");
    }
}
