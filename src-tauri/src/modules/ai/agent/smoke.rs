//! 真实 provider 冒烟（`#[ignore]`，手动运行）。
//!
//! 运行（PowerShell/Git Bash 均可，密钥只经环境变量，不落仓库）：
//! ```text
//! REIN_SMOKE_BASE_URL=https://opencode.ai/zen/v1 \
//! REIN_SMOKE_API_KEY=oc_sk_… \
//! REIN_SMOKE_MODEL=mimo-v2.6-flash-free \
//! cargo test --lib modules::ai::agent::smoke -- --ignored --nocapture
//! ```
//!
//! 三项：六发能力探测（真实判定语义）、流式聊天（真实 SSE 解析）、
//! 工具循环（真实工具调用轮次，模型行为非确定 —— 只断言「跑完且形态合法」）。

use std::sync::Arc;

use super::llm::{
    LlmBackend, LlmMessage, LlmRequest, LlmToolDef, OpenAiCompatBackend, StreamDelta,
};
use super::models::ToolOutcome;
use super::probe::probe_model;
use super::turn::{run_turn, NoHooks, ToolExecutor, TurnInput};

fn backend() -> OpenAiCompatBackend {
    let base = std::env::var("REIN_SMOKE_BASE_URL").expect("缺 REIN_SMOKE_BASE_URL");
    let key = std::env::var("REIN_SMOKE_API_KEY").expect("缺 REIN_SMOKE_API_KEY");
    let model = std::env::var("REIN_SMOKE_MODEL").expect("缺 REIN_SMOKE_MODEL");
    OpenAiCompatBackend::new(base, key, model)
}

/// Rust 注册表端到端：真实模型 → web 组工具（Rust 执行真实必应搜索）→ 终稿
#[tokio::test(flavor = "current_thread")]
#[ignore = "真实网络冒烟：设好 REIN_SMOKE_* 环境变量后 --ignored --nocapture 手动运行"]
async fn smoke_tool_registry_web() {
    struct RegistryExecutor;
    #[async_trait::async_trait]
    impl ToolExecutor for RegistryExecutor {
        async fn execute(&self, _c: &str, name: &str, args: &serde_json::Value) -> ToolOutcome {
            // 与 HybridExecutor 同路径：注册表优先（此处直接走实现体，无需 AppHandle）
            match super::tools::web::run_impl(name, args).await {
                Ok(v) => ToolOutcome::ok(v.to_string()),
                Err(e) => ToolOutcome::error(e.to_string()),
            }
        }
    }

    let b = Arc::new(backend());
    let executor: Arc<dyn ToolExecutor> = Arc::new(RegistryExecutor);
    let context = Arc::new(std::sync::Mutex::new(super::turn::RunContext {
        system: Some("你是 Rein 的测试助手。应用外的事实先联网搜再答，并在回复里给出来源。".into()),
        tools: Vec::new(),
        groups: vec!["web".into()],
    }));
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let res = run_turn(
        b.as_ref(),
        &executor,
        context,
        Vec::new(),
        TurnInput {
            prompt: "搜一下可乐每100g的热量，用一句话告诉我数字和来源。".into(),
            images: Vec::new(),
            thinking_level: Some("low".into()),
            temperature: None,
            max_tokens: None,
        },
        tx,
        &NoHooks,
    )
    .await
    .expect("注册表工具循环失败");
    println!(
        "注册表循环：steps={} tools={} 终稿={}字",
        res.steps,
        res.tools,
        res.content.chars().count()
    );
    assert!(res.tools >= 1, "模型应调用 web 组工具");
    assert!(!res.content.is_empty());
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "真实网络冒烟：设好 REIN_SMOKE_* 环境变量后 --ignored --nocapture 手动运行"]
async fn smoke_probe() {
    let b = backend();
    let r = probe_model(&b).await;
    println!(
        "探测结果 vision={:?} thinking={:?} effort={:?} error={:?}",
        r.vision, r.thinking, r.effort, r.error
    );
    assert!(
        r.error.is_none() || r.vision.is_some() || r.thinking.is_some() || r.effort.is_some(),
        "整轮探测全部未知且带错误：{}",
        r.error.unwrap_or_default()
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "真实网络冒烟：设好 REIN_SMOKE_* 环境变量后 --ignored --nocapture 手动运行"]
async fn smoke_stream_chat() {
    let b = backend();
    let req = LlmRequest {
        model: b.model().to_string(),
        system: Some("你是 Rein 的测试助手，回复用中文，一句话即可。".into()),
        messages: vec![LlmMessage::user("用一句话介绍你自己。")],
        tools: Vec::new(),
        temperature: None,
        max_tokens: None,
        thinking_level: Some("low".into()),
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let resp = b.stream_complete(&req, tx).await.expect("流式请求失败");
    let mut text_deltas = 0usize;
    let mut reasoning_deltas = 0usize;
    while let Ok(d) = rx.try_recv() {
        match d {
            StreamDelta::Text(_) => text_deltas += 1,
            StreamDelta::Reasoning(_) => reasoning_deltas += 1,
        }
    }
    println!(
        "流式：text_delta={text_deltas} reasoning_delta={reasoning_deltas} 终稿={}字 usage={:?}",
        resp.content.chars().count(),
        resp.usage
    );
    assert!(!resp.content.is_empty(), "终稿不应为空");
    assert!(text_deltas > 0, "应收到正文增量");
}

struct EchoExecutor;

#[async_trait::async_trait]
impl ToolExecutor for EchoExecutor {
    async fn execute(&self, _call_id: &str, name: &str, args: &serde_json::Value) -> ToolOutcome {
        println!("工具被调用：{name} {args}");
        ToolOutcome::ok(format!("{{\"ok\":true,\"tool\":\"{name}\",\"now\":\"2026-10-07T10:00:00\"}}"))
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "真实网络冒烟：设好 REIN_SMOKE_* 环境变量后 --ignored --nocapture 手动运行"]
async fn smoke_tool_loop() {
    let b = Arc::new(backend());
    let executor: Arc<dyn ToolExecutor> = Arc::new(EchoExecutor);
    let tools = vec![LlmToolDef {
        name: "get_time".into(),
        description: "查询当前时间，返回 ISO-8601 字符串。需要知道现在时间时必须调用它。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "timezone": { "type": "string", "description": "IANA 时区名，可缺省" } },
        }),
    }];
    let context = Arc::new(std::sync::Mutex::new(super::turn::RunContext {
        system: Some("你是 Rein 的测试助手。需要时间信息时调用 get_time 工具。".into()),
        tools: tools.clone(),
        groups: Vec::new(),
    }));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let res = run_turn(
        b.as_ref(),
        &executor,
        context,
        Vec::new(),
        TurnInput {
            prompt: "现在几点了？请查一下再回答。".into(),
            images: Vec::new(),
            thinking_level: Some("low".into()),
            temperature: None,
            max_tokens: None,
        },
        tx,
        &NoHooks,
    )
    .await
    .expect("工具循环失败");
    let mut deltas = 0usize;
    while let Ok(_) = rx.try_recv() {
        deltas += 1;
    }
    println!(
        "工具循环：steps={} tools={} 终稿={}字 增量={deltas} usage={:?}",
        res.steps,
        res.tools,
        res.content.chars().count(),
        res.usage
    );
    assert_eq!(res.stop_reason, "stop");
    assert!(!res.content.is_empty());
}
