//! 请求线格式兼容探测：按 baseUrl 自动决定字段名与 thinking 注入方式。
//!
//! 行为基准是 pi-ai `openai-completions.js` 的 `detectCompat`（Rein 现网行为），
//! 这里只移植影响请求正确性的子集：
//! - `max_tokens` vs `max_completion_tokens` 字段名（探测协议 max_tokens=1 依赖）
//! - thinking 注入格式：DeepSeek（`thinking:{type}` + `reasoning_effort`）与
//!   OpenAI 风格（仅 `reasoning_effort`）。zai/together/openrouter 等格式未移植，
//!   统一按 OpenAI 风格处理 —— 这些厂商在 pi-ai 里本就 `supportsReasoningEffort`
//!   = false（不发送任何推理参数），此处行为一致，仅缺「thinking 开关对象」；
//! - system 是否用 `developer` 角色、`store:false`、tools `strict:false`；
//! - DeepSeek 回灌 assistant 历史必须带 `reasoning_content`（缺了 400）。

use serde_json::{json, Map, Value};

/// 思考参数注入格式（v1 仅实现 DeepSeek / OpenAI 两种）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingFormat {
    /// DeepSeek：`thinking:{type:enabled|disabled}` + `reasoning_effort`
    Deepseek,
    /// OpenAI 风格：仅 `reasoning_effort`（o 系）；不支持时什么都不发
    Openai,
}

/// 与请求线格式相关的兼容行为子集
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Compat {
    /// maxTokens 参数的线格式字段名
    pub max_tokens_field: &'static str,
    pub thinking_format: ThinkingFormat,
    /// 是否可发送 `reasoning_effort`
    pub supports_reasoning_effort: bool,
    /// 是否可发送 `store:false`
    pub supports_store: bool,
    /// 是否可发送 tools `strict` 字段（部分厂商拒绝未知字段）
    pub supports_strict: bool,
    /// 回灌 assistant 消息是否必须带 `reasoning_content`（DeepSeek 400 实坑）
    pub requires_reasoning_content_on_assistant: bool,
    /// system 提示词是否用 `developer` 角色（OpenAI 推理模型）
    pub developer_role: bool,
}

impl Compat {
    /// 对齐 pi-ai `detectCompat(model)`。Rein 的 provider 列是用户自由命名，
    /// 不能当厂商判据，全部按 URL 识别（与 `src/ai/runtime.ts` 的口径一致）。
    pub fn detect(base_url: &str) -> Self {
        let u = base_url;
        let ul = base_url.to_ascii_lowercase();
        let is_zai = u.contains("api.z.ai") || u.contains("open.bigmodel.cn");
        let is_together = u.contains("api.together.ai") || u.contains("api.together.xyz");
        let is_moonshot = u.contains("api.moonshot.");
        let is_openrouter = u.contains("openrouter.ai");
        let is_cf_gateway = u.contains("gateway.ai.cloudflare.com");
        let is_nvidia = u.contains("integrate.api.nvidia.com");
        let is_antling = u.contains("api.ant-ling.com");
        let is_deepseek = ul.contains("deepseek.com");
        let is_chutes = u.contains("chutes.ai");
        let is_xai = u.contains("api.x.ai");
        let is_cerebras = u.contains("cerebras.ai");
        let is_opencode = u.contains("opencode.ai");
        let is_cf_wai = u.contains("api.cloudflare.com");
        let is_nonstandard = is_nvidia
            || is_cerebras
            || is_xai
            || is_together
            || is_chutes
            || is_deepseek
            || is_zai
            || is_moonshot
            || is_opencode
            || is_cf_wai
            || is_cf_gateway
            || is_antling;
        let use_max_tokens = is_chutes
            || is_deepseek
            || is_moonshot
            || is_cf_gateway
            || is_together
            || is_nvidia
            || is_antling
            || is_zai;
        Self {
            max_tokens_field: if use_max_tokens {
                "max_tokens"
            } else {
                "max_completion_tokens"
            },
            // zai/together/openrouter/antling 未移植专用格式，按 OpenAI 风格处理
            //（它们 supports_reasoning_effort=false，注入行为与 pi-ai 等效）
            thinking_format: if is_deepseek {
                ThinkingFormat::Deepseek
            } else {
                ThinkingFormat::Openai
            },
            supports_reasoning_effort: !(is_xai || is_zai || is_moonshot || is_together
                || is_cf_gateway || is_nvidia || is_antling),
            supports_store: !is_nonstandard,
            supports_strict: !(is_moonshot || is_together || is_cf_gateway || is_nvidia),
            requires_reasoning_content_on_assistant: is_deepseek,
            developer_role: !is_nonstandard && !is_openrouter,
        }
    }

    /// 把思考档位映射为请求体顶层注入字段（对齐 pi-ai 的 reasoning 分支）。
    ///
    /// - DeepSeek：level 非 off → `thinking:enabled`（支持时附 `reasoning_effort`）；
    ///   off / None → `thinking:disabled`（显式关闭默认思考的模型）
    /// - OpenAI 风格：level 非 off 且支持 → `reasoning_effort`；off / None 不发
    ///
    /// `model_reasoning` 对应 pi 的 `model.reasoning`（Rein 运行时恒 true）。
    pub fn reasoning_params(&self, level: Option<&str>, model_reasoning: bool) -> Option<Value> {
        let requested = level.filter(|l| !l.is_empty() && *l != "off");
        match self.thinking_format {
            ThinkingFormat::Deepseek if model_reasoning => {
                let mut m = Map::new();
                if requested.is_some() {
                    m.insert("thinking".into(), json!({ "type": "enabled" }));
                    if self.supports_reasoning_effort {
                        if let Some(l) = requested {
                            m.insert("reasoning_effort".into(), json!(l));
                        }
                    }
                } else {
                    m.insert("thinking".into(), json!({ "type": "disabled" }));
                }
                Some(Value::Object(m))
            }
            ThinkingFormat::Openai => match requested {
                Some(l) if model_reasoning && self.supports_reasoning_effort => {
                    Some(json!({ "reasoning_effort": l }))
                }
                _ => None,
            },
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_urls_get_deepseek_format_and_max_tokens_field() {
        let c = Compat::detect("https://api.deepseek.com/v1");
        assert_eq!(c.max_tokens_field, "max_tokens");
        assert_eq!(c.thinking_format, ThinkingFormat::Deepseek);
        assert!(c.supports_reasoning_effort);
        assert!(!c.developer_role, "DeepSeek 是 non-standard，system 不换 developer");
        assert!(!c.supports_store);
        assert!(c.requires_reasoning_content_on_assistant);
        // 大小写不敏感（pi 同款 toLowerCase 判定）
        assert_eq!(Compat::detect("https://DeepSeek.COM").max_tokens_field, "max_tokens");
    }

    #[test]
    fn unknown_urls_get_openai_style_with_max_completion_tokens() {
        let c = Compat::detect("https://llm.example.net/v1");
        assert_eq!(c.max_tokens_field, "max_completion_tokens");
        assert_eq!(c.thinking_format, ThinkingFormat::Openai);
        assert!(c.developer_role);
        assert!(c.supports_store);
        assert!(!c.requires_reasoning_content_on_assistant);
    }

    #[test]
    fn known_vendor_urls_keep_field_and_effort_rules() {
        // 火山方舟 / moonshot：max_tokens 字段但不支持 reasoning_effort
        let c = Compat::detect("https://ark.cn-beijing.volces.com/api/v3");
        assert_eq!(c.max_tokens_field, "max_completion_tokens");
        let m = Compat::detect("https://api.moonshot.cn/v1");
        assert_eq!(m.max_tokens_field, "max_tokens");
        assert!(!m.supports_reasoning_effort);
        // 智谱 / open.bigmodel.cn：max_tokens 字段、无 effort、无专用 thinking 格式
        let z = Compat::detect("https://open.bigmodel.cn/api/paas/v4");
        assert_eq!(z.max_tokens_field, "max_tokens");
        assert!(!z.supports_reasoning_effort);
    }

    #[test]
    fn deepseek_reasoning_params_match_pi_mapping() {
        let c = Compat::detect("https://api.deepseek.com");
        // 档位开：enabled + effort
        assert_eq!(
            c.reasoning_params(Some("low"), true).unwrap(),
            json!({ "thinking": { "type": "enabled" }, "reasoning_effort": "low" })
        );
        // off：显式 disabled（探测协议第④发依赖这条）
        assert_eq!(
            c.reasoning_params(Some("off"), true).unwrap(),
            json!({ "thinking": { "type": "disabled" } })
        );
        // None（入口未设置档位）：同样显式 disabled（pi 的 thinkingLevelMap?.off !== null 分支）
        assert_eq!(
            c.reasoning_params(None, true).unwrap(),
            json!({ "thinking": { "type": "disabled" } })
        );
    }

    #[test]
    fn openai_style_reasoning_params_only_send_effort() {
        let c = Compat::detect("https://llm.example.net/v1");
        assert_eq!(
            c.reasoning_params(Some("high"), true).unwrap(),
            json!({ "reasoning_effort": "high" })
        );
        assert_eq!(c.reasoning_params(Some("off"), true), None);
        assert_eq!(c.reasoning_params(None, true), None);
        // 不支持 effort 的厂商（如 moonshot）：什么都不发，与 pi 等效
        let m = Compat::detect("https://api.moonshot.cn/v1");
        assert_eq!(m.reasoning_params(Some("high"), true), None);
    }
}
