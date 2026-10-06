//! 模型能力探测：全部以 max_tokens=1 的最小请求验证。
//!
//! 六发协议与判定语义**逐字对齐前端 `src/ai/probe.ts`**（迁移后前端改薄调用）：
//! ① 基础连通（纯文本）② 多模态（文本 + 1×1 PNG）③ thinking 开/关 ④ effort 低/高。
//!
//! 判定规则（按 DeepSeek 文档实测）：
//! - 请求成功（200）＝该能力支持；
//! - 错误消息含 "not support" 等 ＝ 明确不支持；
//! - 错误消息仅抱怨 token 预算（thinking 开启时 max_tokens=1 过小）＝
//!   参数已被接受，视为支持（原文写入 notes 供人工复核）；
//! - 认证类错误 ＝ 中止整轮探测（结果置 null）。

use serde::Serialize;

use super::llm::{ImageData, LlmBackend, LlmMessage, LlmRequest};

/// 1×1 透明 PNG，图片探测的最小载荷
pub const TINY_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/// 错误分类（前端 probe.ts 的 classify 正则的等价实现，无 regex 依赖）。
/// budget 的双方向正则这里收敛为「关键词共现」：消息很短，等价成立。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Classify {
    Ok,
    Unsupported,
    Auth,
    Budget,
    Unknown,
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|k| haystack.contains(k))
}

fn classify(err: &str) -> Classify {
    let e = err.to_lowercase();
    if contains_any(
        &e,
        &[
            "unauthorized",
            "authentication",
            "invalid api key",
            "invalid key",
            "401",
            "403",
            "forbidden",
            "api key incorrect",
        ],
    ) {
        return Classify::Auth;
    }
    if contains_any(
        &e,
        &[
            "not support",
            "doesn't support",
            "doesnt support",
            "unsupported",
            "cannot accept",
            "仅支持文字",
            "不支持",
        ],
    ) {
        return Classify::Unsupported;
    }
    if contains_any(&e, &["token", "max_tokens", "budget", "字数", "长度"])
        && contains_any(&e, &["insufficient", "minimum", "too small", "too few", "limited", "exceed"])
    {
        return Classify::Budget;
    }
    Classify::Unknown
}

/// 单发探测结果
struct Outcome {
    ok: bool,
    err: String,
    cls: Classify,
}

/// 单发：一条 max_tokens=1 的非流式请求
async fn probe_once(
    backend: &dyn LlmBackend,
    content: impl Into<String>,
    images: Vec<ImageData>,
    thinking: Option<&str>,
) -> Outcome {
    let req = LlmRequest {
        model: backend.model().to_string(),
        system: None,
        messages: vec![LlmMessage::user_with_images(content, images)],
        tools: Vec::new(),
        temperature: None,
        max_tokens: Some(1),
        thinking_level: thinking.map(str::to_string),
    };
    match backend.complete(&req).await {
        Ok(_) => Outcome { ok: true, err: String::new(), cls: Classify::Ok },
        Err(e) => {
            let msg = e.to_string();
            let cls = classify(&msg);
            Outcome { ok: false, err: msg, cls }
        }
    }
}

/// 合并某能力的探测结果（1~2 次请求）。语义对齐前端 `capability()`：
/// - 任何 auth 错误 → 中止整轮（结果 null）
/// - 任何 unsupported → 明确不支持（false）
/// - 全部成功 → 支持（true）
/// - 全部为 token 预算抱怨（参数已接受）→ 视为支持（true，附注原文）
/// - 其余（网络超时等未知错误）→ 结论未知（null，附注原文）
fn capability(outs: &[Outcome]) -> (Option<bool>, bool, Vec<String>) {
    let mut notes: Vec<String> = Vec::new();
    for o in outs {
        match o.cls {
            Classify::Auth => return (None, true, vec![o.err.clone()]),
            Classify::Unsupported => return (Some(false), false, vec![o.err.clone()]),
            Classify::Budget => notes.push(format!("参数已接受（预算报错）：{}", o.err)),
            Classify::Unknown => notes.push(o.err.clone()),
            Classify::Ok => {}
        }
    }
    if !outs.is_empty() && outs.iter().all(|o| o.cls == Classify::Ok) {
        return (Some(true), false, notes);
    }
    if !outs.is_empty() && outs.iter().all(|o| o.cls == Classify::Budget) {
        return (Some(true), false, notes);
    }
    (None, false, notes)
}

/// 一轮探测的结论（对齐前端 `AiProbeResult`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbeResult {
    pub vision: Option<bool>,
    pub thinking: Option<bool>,
    pub effort: Option<bool>,
    pub error: Option<String>,
}

/// 执行整轮探测（6 个 max_tokens=1 请求）
pub async fn probe_model(backend: &dyn LlmBackend) -> AgentProbeResult {
    // ① 基础连通（纯文本）
    let text = probe_once(backend, "hi", Vec::new(), None).await;
    if !text.ok && text.cls == Classify::Auth {
        return AgentProbeResult { vision: None, thinking: None, effort: None, error: Some(text.err) };
    }

    // ② 多模态：文本 + 1×1 图片
    let vision = probe_once(
        backend,
        "说明这张图片里有什么",
        vec![ImageData { data: TINY_PNG.to_string(), mime: "image/png".to_string() }],
        None,
    )
    .await;

    // ③ thinking 开关（enabled / disabled 各一次）
    let think_on = probe_once(backend, "hi", Vec::new(), Some("high")).await;
    let think_off = probe_once(backend, "hi", Vec::new(), Some("off")).await;

    // ④ effort 档位（low / high 各一次）
    let effort_low = probe_once(backend, "hi", Vec::new(), Some("low")).await;
    let effort_high = probe_once(backend, "hi", Vec::new(), Some("high")).await;

    let cap_vision = capability(&[vision]);
    let cap_thinking = capability(&[think_on, think_off]);
    let cap_effort = capability(&[effort_low, effort_high]);

    if cap_vision.1 || cap_thinking.1 || cap_effort.1 {
        let err = [cap_vision.2, cap_thinking.2, cap_effort.2]
            .concat()
            .into_iter()
            .find(|s| !s.is_empty());
        return AgentProbeResult {
            vision: None,
            thinking: None,
            effort: None,
            error: Some(err.unwrap_or_else(|| "认证失败".to_string())),
        };
    }

    let notes = [cap_vision.2, cap_thinking.2, cap_effort.2].concat().join("\n");
    AgentProbeResult {
        vision: cap_vision.0,
        thinking: cap_thinking.0,
        effort: cap_effort.0,
        error: if notes.is_empty() { None } else { Some(notes.chars().take(500).collect()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Result;
    use crate::modules::ai::agent::llm::{LlmRequest, LlmResponse, LlmUsage, OpenAiCompatBackend};
    use std::sync::Mutex;

    /// 确定性假后端：按预设脚本逐发返回 Ok / Err
    struct ScriptBackend {
        model: String,
        script: Mutex<Vec<Result<LlmResponse>>>,
    }

    impl ScriptBackend {
        fn new(results: Vec<Result<LlmResponse>>) -> Self {
            Self {
                model: "mock-model".into(),
                script: Mutex::new(results),
            }
        }
    }

    #[async_trait::async_trait]
    impl LlmBackend for ScriptBackend {
        fn model(&self) -> &str {
            &self.model
        }
        async fn complete(&self, _req: &LlmRequest) -> Result<LlmResponse> {
            self.script
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| Ok(LlmResponse { usage: Some(LlmUsage::default()), ..Default::default() }))
        }
    }

    fn ok_resp() -> Result<LlmResponse> {
        Ok(LlmResponse { usage: Some(LlmUsage::default()), ..Default::default() })
    }

    fn err_resp(msg: &str) -> Result<LlmResponse> {
        Err(crate::error::ReinError::Message(msg.to_string()))
    }

    #[test]
    fn classify_matches_probe_ts_semantics() {
        assert_eq!(classify("401 Unauthorized"), Classify::Auth);
        assert_eq!(classify("Invalid API key provided"), Classify::Auth);
        assert_eq!(classify("this model does not support image input"), Classify::Unsupported);
        assert_eq!(classify("仅支持文字输入"), Classify::Unsupported);
        assert_eq!(classify("不支持图片"), Classify::Unsupported);
        // 预算抱怨：参数已被接受，视为支持
        assert_eq!(classify("max_tokens is too small"), Classify::Budget);
        assert_eq!(classify("token limit insufficient"), Classify::Budget);
        assert_eq!(classify("token budget exceeded"), Classify::Budget);
        assert_eq!(classify("network timeout"), Classify::Unknown);
        assert_eq!(classify("max_tokens must be at least 128"), Classify::Unknown, "与 TS 正则同判：无 budget 关键词不算预算抱怨");
    }

    #[test]
    fn capability_merge_matches_probe_ts() {
        let ok = || Outcome { ok: true, err: String::new(), cls: Classify::Ok };
        let unsup = || Outcome { ok: false, err: "不支持".into(), cls: Classify::Unsupported };
        let auth = || Outcome { ok: false, err: "401".into(), cls: Classify::Auth };
        let budget = || Outcome { ok: false, err: "too small".into(), cls: Classify::Budget };

        assert_eq!(capability(&[ok()]), (Some(true), false, vec![]));
        assert_eq!(capability(&[unsup()]), (Some(false), false, vec!["不支持".into()]));
        assert_eq!(
            capability(&[budget(), budget()]),
            (Some(true), false, vec![
                "参数已接受（预算报错）：too small".into(),
                "参数已接受（预算报错）：too small".into()
            ])
        );
        assert_eq!(capability(&[budget(), ok()]).0, None, "混合结果 → 未知");
        assert_eq!(capability(&[ok(), ok()]).1, false);
        assert_eq!(capability(&[auth()]).1, true, "auth 中止整轮");
        assert_eq!(capability(&[]).0, None);
    }

    #[tokio::test]
    async fn auth_error_on_first_shot_aborts_whole_round() {
        let backend = ScriptBackend::new(vec![err_resp("401 Unauthorized")]);
        let r = probe_model(&backend).await;
        assert_eq!(r.vision, None);
        assert_eq!(r.thinking, None);
        assert_eq!(r.effort, None);
        assert_eq!(r.error.as_deref(), Some("401 Unauthorized"));
    }

    #[tokio::test]
    async fn full_round_all_ok() {
        // ①文本 ②视觉 ③④⑤⑥ thinking/effort 四发
        let backend = ScriptBackend::new(vec![
            ok_resp(), ok_resp(), ok_resp(), ok_resp(), ok_resp(), ok_resp(),
        ]);
        let r = probe_model(&backend).await;
        assert_eq!(r.vision, Some(true));
        assert_eq!(r.thinking, Some(true));
        assert_eq!(r.effort, Some(true));
        assert_eq!(r.error, None);
    }

    #[tokio::test]
    async fn vision_unsupported_but_thinking_budget_counts_as_supported() {
        let backend = ScriptBackend::new(vec![
            ok_resp(),                                    // ④effort high
            ok_resp(),                                    // ④effort low
            err_resp("max_tokens too small"),             // ③thinking off
            err_resp("max_tokens too small"),             // ③thinking on
            err_resp("does not support image input"),     // ②vision
            ok_resp(),                                    // ①text
        ]);
        let r = probe_model(&backend).await;
        assert_eq!(r.vision, Some(false));
        assert_eq!(r.thinking, Some(true), "预算抱怨 = 参数已接受 = 支持");
        assert_eq!(r.effort, Some(true));
        assert!(r.error.unwrap().contains("参数已接受"));
    }

    #[tokio::test]
    async fn probe_requests_carry_max_tokens_one_and_thinking_level() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct InspectBackend {
            seen: Mutex<Vec<LlmRequest>>,
            calls: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl LlmBackend for InspectBackend {
            fn model(&self) -> &str {
                "m"
            }
            async fn complete(&self, req: &LlmRequest) -> Result<LlmResponse> {
                self.seen.lock().unwrap().push(req.clone());
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(LlmResponse { usage: Some(LlmUsage::default()), ..Default::default() })
            }
        }
        let backend = Arc::new(InspectBackend { seen: Mutex::new(Vec::new()), calls: AtomicUsize::new(0) });
        let r = probe_model(backend.as_ref()).await;
        assert_eq!(r.vision, Some(true));
        let seen = backend.seen.lock().unwrap();
        assert_eq!(seen.len(), 6, "六发协议");
        for (i, req) in seen.iter().enumerate() {
            assert_eq!(req.max_tokens, Some(1), "第 {} 发必须 max_tokens=1", i + 1);
            assert_eq!(req.messages.len(), 1);
        }
        assert_eq!(seen[0].thinking_level, None, "①纯文本不带思考参数");
        assert!(seen[1].messages[0].images.len() == 1, "②带 1×1 图片");
        assert_eq!(seen[2].thinking_level.as_deref(), Some("high"), "③thinking 开");
        assert_eq!(seen[3].thinking_level.as_deref(), Some("off"), "③thinking 关");
        assert_eq!(seen[4].thinking_level.as_deref(), Some("low"), "④effort 低");
        assert_eq!(seen[5].thinking_level.as_deref(), Some("high"), "④effort 高");
    }

    #[tokio::test]
    async fn openai_compat_backend_builds_valid_request() {
        // 冒烟：真实后端类型能构造、compat 探测在 new 时完成
        let b = OpenAiCompatBackend::new("https://api.deepseek.com/v1", "sk-test", "deepseek-chat");
        assert_eq!(b.model(), "deepseek-chat");
        let req = LlmRequest {
            model: "deepseek-chat".into(),
            system: None,
            messages: vec![LlmMessage::user("hi")],
            tools: Vec::new(),
            temperature: None,
            max_tokens: Some(1),
            thinking_level: None,
        };
        let _ = &req; // 构造无 panic 即可；网络请求不在单测覆盖（见 e2e）
    }
}
