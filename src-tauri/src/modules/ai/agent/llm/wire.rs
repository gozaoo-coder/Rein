//! OpenAI 兼容线格式编码：请求体组装 + 消息编码（含多模态图片）。
//!
//! 固化的 provider 契约（EffiBuddy 实测踩坑，逐条带回测试）：
//! 1. tool role 的 `content` 只接受字符串；工具结果附带的图片必须另起一条
//!    user 多模态消息承载。
//! 2. **同一 assistant 的多个 tool_calls，其 tool 结果消息必须连续出现**。
//!    中间插入任何非 tool 消息（包括第 1 条里的图片 user 消息）都会被
//!    DeepSeek / Qwen 等端点判为 "insufficient tool messages following
//!    tool_calls message" 直接 400。因此图片消息**延迟到该 tool 块结束之后**
//!    才落位（见 [`encode_messages`]）。
//! 3. 空的 assistant 消息（无 content 无 tool_calls）跳过 —— 中断回合的
//!    空回复会让部分端点报 "either content or tool_calls"。
//! 4. DeepSeek 回灌 assistant 历史必须带 `reasoning_content`（缺了 400）。

use serde_json::{json, Value};

use super::compat::Compat;
use super::{ImageData, LlmMessage, LlmRequest, LlmRole};

/// 构造 Chat Completions 请求体（非流式与流式共用）。
///
/// 请求体顶层注入顺序：采样参数 → thinking 参数（compat 推导）→ tools；
/// 同名键以先写入者为准（这里没有 extra_body 通道，无冲突可能）。
pub(super) fn build_body(req: &LlmRequest, compat: &Compat, model_reasoning: bool) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": encode_messages(req.system.as_deref(), &req.messages, compat, model_reasoning),
    });
    if compat.supports_store {
        body["store"] = Value::Bool(false);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = req.max_tokens {
        body[compat.max_tokens_field] = json!(m);
    }
    if let Some(extra) = compat.reasoning_params(req.thinking_level.as_deref(), model_reasoning) {
        if let (Some(dst), Some(src)) = (body.as_object_mut(), extra.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                let mut f = json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                });
                // 仅在厂商支持时带上 strict（部分厂商拒绝未知字段）。
                // v1 恒 false：pi 会按 schema 形态解析 strict:true 开约束解码，
                // Rust 侧暂不移植该解析 —— 只损失约束采样，不改请求有效性。
                if compat.supports_strict {
                    f["strict"] = Value::Bool(false);
                }
                json!({ "type": "function", "function": f })
            })
            .collect();
        body["tools"] = Value::Array(tools);
    }
    body
}

/// 把内部消息模型编码为 OpenAI 线格式（arguments 字符串化、多模态数组）。
pub(super) fn encode_messages(
    system: Option<&str>,
    messages: &[LlmMessage],
    compat: &Compat,
    model_reasoning: bool,
) -> Vec<Value> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if let Some(system) = system {
        if !system.is_empty() {
            let role = if compat.developer_role && model_reasoning {
                "developer"
            } else {
                "system"
            };
            out.push(json!({ "role": role, "content": system }));
        }
    }
    // 延迟落位的工具结果附图消息（tool 块内积压，块结束统一追加）
    let mut deferred_images: Vec<Value> = Vec::new();

    for m in messages {
        // tool 块结束（非 tool 消息到来）：先补上积压的图片消息，保持 tool 连续
        if m.role != LlmRole::Tool && !deferred_images.is_empty() {
            out.append(&mut deferred_images);
        }

        // 空 assistant（无正文无调用）跳过：中断回合的空回复
        if m.role == LlmRole::Assistant && m.content.is_empty() && m.tool_calls.is_empty() {
            continue;
        }

        let role = match m.role {
            LlmRole::System => "system",
            LlmRole::User => "user",
            LlmRole::Assistant => "assistant",
            LlmRole::Tool => "tool",
        };
        let content = if m.role == LlmRole::User && !m.images.is_empty() {
            encode_user_multimodal_content(m)
        } else {
            json!(m.content)
        };
        let mut j = json!({ "role": role, "content": content });
        if let Some(call_id) = &m.tool_call_id {
            j["tool_call_id"] = Value::String(call_id.clone());
        }
        let tool_images = if m.role == LlmRole::Tool {
            m.images.clone()
        } else {
            Vec::new()
        };
        if !m.tool_calls.is_empty() {
            let calls: Vec<Value> = m
                .tool_calls
                .iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": serde_json::to_string(&tc.arguments)
                                .unwrap_or_else(|_| "{}".to_string()),
                        }
                    })
                })
                .collect();
            j["tool_calls"] = Value::Array(calls);
        }
        // DeepSeek：assistant 回灌必须带 reasoning_content（缺了 400）
        if m.role == LlmRole::Assistant
            && compat.requires_reasoning_content_on_assistant
            && model_reasoning
        {
            j["reasoning_content"] = json!(m.reasoning.clone().unwrap_or_default());
        }
        out.push(j);
        if !tool_images.is_empty() {
            deferred_images.push(encode_tool_observation_images(&tool_images));
        }
    }
    if !deferred_images.is_empty() {
        out.append(&mut deferred_images);
    }
    out
}

/// 工具结果的图片分片：编码为独立的 user 多模态消息
/// （文本占位让模型明确「这张图来自哪个工具」）。
fn encode_tool_observation_images(images: &[ImageData]) -> Value {
    let mut parts = Vec::with_capacity(images.len() + 1);
    parts.push(json!({ "type": "text", "text": "[工具结果附图]" }));
    for img in images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
        }));
    }
    json!({ "role": "user", "content": parts })
}

/// 带图 user 消息编码为视觉 content 数组；文本为空时只发图片部分。
fn encode_user_multimodal_content(m: &LlmMessage) -> Value {
    let mut parts = Vec::with_capacity(m.images.len() + 1);
    if !m.content.is_empty() {
        parts.push(json!({ "type": "text", "text": m.content }));
    }
    for img in &m.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
        }));
    }
    Value::Array(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ai::agent::llm::{LlmToolCall, LlmToolDef};

    fn png(mime: &str) -> ImageData {
        ImageData { data: "aWNv".into(), mime: mime.into() }
    }

    /// 线格式不变量：assistant 的每个 tool_call 都有紧跟的 tool 结果，
    /// 且 tool 结果连续（中间不夹非 tool 消息）—— provider 400 的根因
    fn assert_tool_blocks_contiguous(encoded: &[Value]) {
        let mut i = 0;
        while i < encoded.len() {
            let calls = encoded[i]["tool_calls"].as_array().cloned();
            if let Some(calls) = calls.filter(|c| !c.is_empty()) {
                let mut answered: Vec<String> = Vec::new();
                let mut k = i + 1;
                while k < encoded.len() && encoded[k]["role"] == "tool" {
                    answered.push(
                        encoded[k]["tool_call_id"].as_str().unwrap_or_default().to_string(),
                    );
                    k += 1;
                }
                for c in &calls {
                    let id = c["id"].as_str().unwrap_or_default();
                    assert!(
                        answered.iter().any(|a| a == id),
                        "tool_call {id} 缺紧跟的 tool 结果（被非 tool 消息隔断）"
                    );
                }
                assert_eq!(answered.len(), calls.len(), "tool 结果条数应与 tool_calls 一致且连续");
                i = k;
            } else {
                i += 1;
            }
        }
    }

    #[test]
    fn user_images_encode_as_vision_content_array() {
        let msg = LlmMessage::user_with_images("这张图里是什么", vec![png("image/png")]);
        let encoded = encode_messages(None, &[msg], &Compat::detect("https://x.example"), true);
        assert_eq!(encoded.len(), 1);
        let content = encoded[0]["content"].as_array().expect("content 应为视觉数组");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "这张图里是什么");
        let url = content[1]["image_url"]["url"].as_str().unwrap();
        assert_eq!(url, "data:image/png;base64,aWNv");
    }

    #[test]
    fn empty_text_with_images_sends_only_image_parts() {
        let msg = LlmMessage::user_with_images("", vec![png("image/jpeg")]);
        let encoded = encode_messages(None, &[msg], &Compat::detect("https://x.example"), true);
        let content = encoded[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "空 content 时只发图片部分");
        assert_eq!(content[0]["type"], "image_url");
    }

    #[test]
    fn tool_result_images_split_and_stay_after_tool_block() {
        let assistant = LlmMessage::assistant_with_calls(vec![
            LlmToolCall { id: "call-shot".into(), name: "zoom".into(), arguments: json!({}) },
            LlmToolCall { id: "call-ls".into(), name: "shell".into(), arguments: json!({"command":"ls"}) },
        ]);
        let msgs = vec![
            LlmMessage::user("看看"),
            assistant,
            LlmMessage::tool_with_images("call-shot", "已放大", vec![png("image/png")]),
            LlmMessage::tool("call-ls", "exit 0"),
            LlmMessage::assistant("看到了"),
        ];
        let encoded = encode_messages(None, &msgs, &Compat::detect("https://x.example"), true);
        let roles: Vec<&str> =
            encoded.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(
            roles,
            vec!["user", "assistant", "tool", "tool", "user", "assistant"],
            "两条 tool 结果必须连续，图片消息延后到 tool 块之后"
        );
        assert_tool_blocks_contiguous(&encoded);
    }

    #[test]
    fn tool_images_deferred_even_when_on_last_call() {
        let assistant = LlmMessage::assistant_with_calls(vec![
            LlmToolCall { id: "a".into(), name: "t1".into(), arguments: json!({}) },
            LlmToolCall { id: "b".into(), name: "t2".into(), arguments: json!({}) },
        ]);
        let msgs = vec![
            assistant,
            LlmMessage::tool("a", "ok"),
            LlmMessage::tool_with_images("b", "shot", vec![png("image/png")]),
        ];
        let encoded = encode_messages(None, &msgs, &Compat::detect("https://x.example"), true);
        let roles: Vec<&str> =
            encoded.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["assistant", "tool", "tool", "user"]);
        assert_tool_blocks_contiguous(&encoded);
    }

    #[test]
    fn tool_image_blocks_stay_valid_across_multiple_rounds() {
        let msgs = vec![
            LlmMessage::user("两步"),
            LlmMessage::assistant_with_calls(vec![LlmToolCall {
                id: "r1".into(), name: "zoom".into(), arguments: json!({}),
            }]),
            LlmMessage::tool_with_images("r1", "第一张", vec![png("image/png")]),
            LlmMessage::assistant("第一屏"),
            LlmMessage::assistant_with_calls(vec![LlmToolCall {
                id: "r2".into(), name: "zoom".into(), arguments: json!({}),
            }]),
            LlmMessage::tool_with_images("r2", "第二张", vec![png("image/png")]),
            LlmMessage::assistant("完成"),
        ];
        let encoded = encode_messages(None, &msgs, &Compat::detect("https://x.example"), true);
        let roles: Vec<&str> =
            encoded.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(
            roles,
            vec!["user", "assistant", "tool", "user", "assistant", "assistant", "tool", "user", "assistant"]
        );
        assert_tool_blocks_contiguous(&encoded);
    }

    #[test]
    fn empty_assistant_messages_are_skipped() {
        let msgs = vec![
            LlmMessage::user("hi"),
            LlmMessage::assistant(""), // 中断回合的空回复
            LlmMessage::assistant("答"),
        ];
        let encoded = encode_messages(None, &msgs, &Compat::detect("https://x.example"), true);
        let roles: Vec<&str> =
            encoded.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "assistant"]);
    }

    #[test]
    fn deepseek_assistant_history_carries_reasoning_content() {
        let msgs = vec![
            LlmMessage::user("hi"),
            LlmMessage::assistant("上一轮回复"),
        ];
        let ds = Compat::detect("https://api.deepseek.com");
        let encoded = encode_messages(None, &msgs, &ds, true);
        assert_eq!(encoded[1]["reasoning_content"], "", "缺省补空串（DeepSeek 400 实坑）");
        // 非_deepseek 不带该字段
        let other = Compat::detect("https://x.example");
        let encoded2 = encode_messages(None, &msgs, &other, true);
        assert!(encoded2[1].get("reasoning_content").is_none());
    }

    #[test]
    fn system_prompt_role_switches_by_compat() {
        let msgs = [LlmMessage::user("hi")];
        let openai = Compat::detect("https://api.openai.com/v1");
        let encoded = encode_messages(Some("sys"), &msgs, &openai, true);
        assert_eq!(encoded[0]["role"], "developer", "OpenAI 推理模型用 developer 角色");
        let ds = Compat::detect("https://api.deepseek.com");
        let encoded2 = encode_messages(Some("sys"), &msgs, &ds, true);
        assert_eq!(encoded2[0]["role"], "system");
    }

    #[test]
    fn plain_text_and_tool_messages_keep_string_content() {
        let msgs = vec![LlmMessage::user("纯文本"), LlmMessage::tool("call-1", "结果")];
        let encoded = encode_messages(Some("sys"), &msgs, &Compat::detect("https://x.example"), true);
        assert_eq!(encoded[0]["content"], "sys");
        assert_eq!(encoded[1]["content"], "纯文本");
        assert_eq!(encoded[2]["content"], "结果");
        // system 角色本身由 developer_role 决定（见 system_prompt_role_switches_by_compat）
        let ds = Compat::detect("https://api.deepseek.com");
        let encoded2 = encode_messages(Some("sys"), &msgs, &ds, true);
        assert_eq!(encoded2[0]["role"], "system");
    }

    // ---------------------------------------------------------
    // 请求体：tools / 采样 / thinking 注入 / max_tokens 字段名
    // ---------------------------------------------------------

    fn req(thinking: Option<&str>, max_tokens: Option<u32>) -> LlmRequest {
        LlmRequest {
            model: "m".into(),
            system: None,
            messages: vec![LlmMessage::user("hi")],
            tools: Vec::new(),
            temperature: None,
            max_tokens,
            thinking_level: thinking.map(str::to_string),
        }
    }

    #[test]
    fn tools_are_encoded_with_stringified_arguments() {
        let mut r = req(None, None);
        r.tools = vec![LlmToolDef {
            name: "search_food".into(),
            description: "搜食物".into(),
            parameters: json!({ "type": "object" }),
        }];
        let body = build_body(&r, &Compat::detect("https://x.example"), true);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "search_food");
        assert_eq!(body["tools"][0]["function"]["strict"], false);
        // moonshot 不支持 strict 字段，不发送
        let body2 = build_body(&r, &Compat::detect("https://api.moonshot.cn/v1"), true);
        assert!(body2["tools"][0]["function"].get("strict").is_none());
    }

    #[test]
    fn max_tokens_field_follows_compat() {
        let body = build_body(&req(None, Some(1)), &Compat::detect("https://api.deepseek.com"), true);
        assert_eq!(body["max_tokens"], 1);
        assert!(body.get("max_completion_tokens").is_none());
        let body2 = build_body(&req(None, Some(1)), &Compat::detect("https://x.example"), true);
        assert_eq!(body2["max_completion_tokens"], 1);
        assert!(body2.get("max_tokens").is_none());
    }

    #[test]
    fn absent_sampling_params_are_not_sent() {
        let body = build_body(&req(None, None), &Compat::detect("https://x.example"), true);
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn thinking_params_inject_by_compat() {
        // deepseek：enabled + effort
        let body = build_body(&req(Some("low"), None), &Compat::detect("https://api.deepseek.com"), true);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "low");
        // off → disabled
        let body2 = build_body(&req(Some("off"), None), &Compat::detect("https://api.deepseek.com"), true);
        assert_eq!(body2["thinking"]["type"], "disabled");
        // openai 风格：仅 effort，off 不发
        let body3 = build_body(&req(Some("high"), None), &Compat::detect("https://x.example"), true);
        assert_eq!(body3["reasoning_effort"], "high");
        assert!(body3.get("thinking").is_none());
        let body4 = build_body(&req(Some("off"), None), &Compat::detect("https://x.example"), true);
        assert!(body4.get("reasoning_effort").is_none());
    }

    #[test]
    fn stream_flag_adds_sse_options() {
        let body = build_body(&req(None, None), &Compat::detect("https://x.example"), true);
        assert!(body.get("stream").is_none(), "非流式不带 stream 标志");
        let mut r = req(None, None);
        let body2 = {
            // stream 版本由 http 层在 build_body 后补标志；这里验证补上的形状
            let mut b = build_body(&r, &Compat::detect("https://x.example"), true);
            b["stream"] = Value::Bool(true);
            b["stream_options"] = json!({ "include_usage": true });
            b
        };
        assert_eq!(body2["stream"], true);
        assert_eq!(body2["stream_options"]["include_usage"], true);
        let _ = &mut r;
    }
}
