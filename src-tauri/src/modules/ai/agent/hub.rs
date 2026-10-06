//! run 会话管理：取消句柄 + 桥接期工具结果通道。
//!
//! 形态照抄 voice 的 `VoiceHub`（`state.rs` 的会话表 + channel 控制）。
//! 本模块刻意不依赖 Tauri：取消用注入的闭包（命令层传 `JoinHandle::abort`），
//! 因此 hub / 桥接的语义都能用纯单测覆盖。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use super::llm::LlmToolDef;
use super::models::ToolOutcome;
use super::turn::RunContext;

/// 单次 run 的工具结果桥：等待前端回传结果。
///
/// **早到缓冲**：前端可能在 Rust 侧注册等待之前就把结果送回来（本地工具的
/// 「事件 → 执行 → 命令」往返只有毫秒级，与注册存在竞态）。早到的结果先入
/// `early` 缓冲，注册时优先消费，避免「结果丢了、白等超时」。
pub struct ToolBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<ToolOutcome>>>,
    early: Mutex<HashMap<String, ToolOutcome>>,
}

impl ToolBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { pending: Mutex::new(HashMap::new()), early: Mutex::new(HashMap::new()) })
    }

    /// 等待某个工具调用的结果（超时返回错误结果，不 panic）
    pub async fn wait(&self, call_id: &str, timeout: Duration) -> ToolOutcome {
        if let Some(outcome) = self.early.lock().unwrap().remove(call_id) {
            return outcome;
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(call_id.to_string(), tx);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => ToolOutcome::error("[内部错误] 工具结果通道中断"),
            Err(_) => {
                self.pending.lock().unwrap().remove(call_id);
                ToolOutcome::error(format!("工具执行超时（{}s）", timeout.as_secs()))
            }
        }
    }

    /// 回传结果：命中等待者直接送达；否则缓冲给稍后的注册方。
    /// 返回是否命中等待者（缓冲也算已受理）。
    pub fn deliver(&self, call_id: &str, outcome: ToolOutcome) -> bool {
        if let Some(tx) = self.pending.lock().unwrap().remove(call_id) {
            let _ = tx.send(outcome);
            return true;
        }
        self.early.lock().unwrap().insert(call_id.to_string(), outcome);
        true
    }

    /// run 结束时清空（丢弃未被消费的早到结果，防泄漏）
    pub fn clear(&self) {
        self.pending.lock().unwrap().clear();
        self.early.lock().unwrap().clear();
    }
}

/// 活跃 run 句柄
pub struct RunHandle {
    cancel: Box<dyn Fn() + Send + Sync>,
    bridge: Arc<ToolBridge>,
    /// run 级上下文（系统提示词 + 工具集）：前端执行 load_tools 后热更新
    context: Arc<Mutex<RunContext>>,
}

/// run 会话表（`AppState` 之外单独 manage，避免与领域状态耦合）
#[derive(Default)]
pub struct AgentHub {
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl AgentHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一次 run；`cancel` 由命令层注入（`JoinHandle::abort`）
    pub fn register(
        &self,
        run_id: impl Into<String>,
        cancel: impl Fn() + Send + Sync + 'static,
        bridge: Arc<ToolBridge>,
        context: Arc<Mutex<RunContext>>,
    ) {
        self.runs.lock().unwrap().insert(
            run_id.into(),
            RunHandle { cancel: Box::new(cancel), bridge, context },
        );
    }

    /// 热更新 run 上下文（系统提示词 + 工具集），下一步 completion 生效。
    /// 未知 run 返回 false。
    pub fn update_context(
        &self,
        run_id: &str,
        system: Option<String>,
        tools: Vec<LlmToolDef>,
        groups: Vec<String>,
    ) -> bool {
        let runs = self.runs.lock().unwrap();
        match runs.get(run_id) {
            Some(handle) => {
                let mut ctx = handle.context.lock().unwrap();
                ctx.system = system;
                ctx.tools = tools;
                ctx.groups = groups;
                true
            }
            None => false,
        }
    }

    /// 取消一次 run（未知 run 返回 false）
    pub fn cancel(&self, run_id: &str) -> bool {
        match self.runs.lock().unwrap().remove(run_id) {
            Some(handle) => {
                (handle.cancel)();
                handle.bridge.clear();
                true
            }
            None => false,
        }
    }

    /// 回传工具结果给指定 run
    pub fn deliver_tool_result(&self, run_id: &str, call_id: &str, outcome: ToolOutcome) -> bool {
        let runs = self.runs.lock().unwrap();
        match runs.get(run_id) {
            Some(handle) => handle.bridge.deliver(call_id, outcome),
            None => false,
        }
    }

    /// run 自然结束：移除并清空桥（幂等）
    pub fn finish(&self, run_id: &str) {
        if let Some(handle) = self.runs.lock().unwrap().remove(run_id) {
            handle.bridge.clear();
        }
    }

    /// 活跃 run 列表（诊断 / 测试）
    pub fn active_runs(&self) -> Vec<String> {
        self.runs.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn cancel_invokes_injected_closer_and_removes_run() {
        let hub = AgentHub::new();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        hub.register(
            "r1",
            move || {
                f.fetch_add(1, Ordering::SeqCst);
            },
            ToolBridge::new(),
            Arc::new(Mutex::new(RunContext::default())),
        );
        assert_eq!(hub.active_runs(), vec!["r1".to_string()]);

        assert!(hub.cancel("r1"));
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        assert!(hub.active_runs().is_empty());
        assert!(!hub.cancel("r1"), "重复取消返回 false");
    }

    #[tokio::test]
    async fn deliver_routes_to_waiter() {
        let hub = AgentHub::new();
        let bridge = ToolBridge::new();
        hub.register("r1", || {}, Arc::clone(&bridge), Arc::new(Mutex::new(RunContext::default())));

        let waiter = {
            let b = Arc::clone(&bridge);
            tokio::spawn(async move { b.wait("c1", Duration::from_secs(5)).await })
        };
        // 等注册完成
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(hub.deliver_tool_result("r1", "c1", ToolOutcome::ok("结果")));
        let outcome = waiter.await.unwrap();
        assert_eq!(outcome.content, "结果");
        assert!(!outcome.is_error);
    }

    #[tokio::test]
    async fn early_result_is_buffered_and_consumed_at_registration() {
        let bridge = ToolBridge::new();
        // 前端比 Rust 注册更早回传
        assert!(bridge.deliver("c1", ToolOutcome::ok("早到")));
        let outcome = bridge.wait("c1", Duration::from_secs(5)).await;
        assert_eq!(outcome.content, "早到", "早到结果不能被丢掉");
    }

    #[tokio::test]
    async fn wait_timeout_yields_error_outcome_and_cleans_pending() {
        let bridge = ToolBridge::new();
        let outcome = bridge.wait("c1", Duration::from_millis(30)).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("超时"));
        // 超时后 pending 已清理：迟到的回传走缓冲而不是悬空发送
        assert!(bridge.deliver("c1", ToolOutcome::ok("迟到")));
        let second = bridge.wait("c1", Duration::from_millis(10)).await;
        assert_eq!(second.content, "迟到");
    }

    #[tokio::test]
    async fn update_context_hot_swaps_system_and_tools() {
        let hub = AgentHub::new();
        let context = Arc::new(Mutex::new(RunContext {
            system: Some("旧提示".into()),
            tools: vec![],
            groups: Vec::new(),
        }));
        hub.register("r1", || {}, ToolBridge::new(), Arc::clone(&context));

        assert!(hub.update_context(
            "r1",
            Some("新提示".into()),
            vec![LlmToolDef {
                name: "loaded_tool".into(),
                description: "新工具".into(),
                parameters: serde_json::json!({}),
            }],
            vec!["diet".to_string()],
        ));
        assert_eq!(context.lock().unwrap().groups, vec!["diet".to_string()]);
        {
            let c = context.lock().unwrap();
            assert_eq!(c.system.as_deref(), Some("新提示"));
            assert_eq!(c.tools.len(), 1);
            assert_eq!(c.tools[0].name, "loaded_tool");
        }
        assert!(!hub.update_context("nope", None, vec![], vec![]), "未知 run 返回 false");
    }

    #[tokio::test]
    async fn deliver_to_unknown_run_is_rejected_and_finish_clears_bridge() {
        let hub = AgentHub::new();
        assert!(!hub.deliver_tool_result("nope", "c1", ToolOutcome::ok("x")));

        let bridge = ToolBridge::new();
        hub.register("r1", || {}, Arc::clone(&bridge), Arc::new(Mutex::new(RunContext::default())));
        hub.finish("r1");
        assert!(hub.active_runs().is_empty());
        assert!(!hub.deliver_tool_result("r1", "c1", ToolOutcome::ok("x")));
    }
}
