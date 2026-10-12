//! 语音域数据结构 · 与前端 `types/voice.ts` 镜像（camelCase）。

use serde::{Deserialize, Serialize};

/// 朗读（豆包 TTS）独立凭据。app_key 为空时视为未启用，回退继承识别凭据。
/// 识别配百炼（DashScope 凭据）时，朗读必须在此单独给出豆包凭据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TtsCredential {
    /// "legacy" | "new"
    pub mode: String,
    /// legacy = App ID（X-Api-App-Key）；new = API Key（X-Api-Key）
    pub app_key: String,
    /// legacy = Access Token；new 模式留空
    pub access_key: String,
}

impl Default for TtsCredential {
    fn default() -> Self {
        Self {
            mode: "legacy".into(),
            app_key: String::new(),
            access_key: String::new(),
        }
    }
}

/// 豆包语音服务凭据与偏好（存 app_meta JSON，单条配置）。
/// 凭据两种模式（对应火山新旧控制台）：legacy = App ID + Access Token；new = 仅 API Key。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    /// "legacy" | "new"
    pub mode: String,
    /// legacy = App ID（X-Api-App-Key）；new = API Key（X-Api-Key）
    pub app_key: String,
    /// legacy = Access Token（X-Api-Access-Key）；new 模式留空
    pub access_key: String,
    /// ASR Resource-Id（豆包流式语音识别 2.0 小时版：volc.seedasr.sauc.duration）；
    /// 百炼适配器下此字段 = 模型名（如 paraformer-realtime-v2）
    pub asr_resource_id: String,
    /// ASR 适配器：auto（按 baseURL/模型关键词自动识别）| doubao | bailian
    /// （历史值 qwen 与 bailian 同义，都走百炼/DashScope 协议）
    pub asr_adapter: String,
    /// 适配器是否由用户手动选定（false = 程序自动替选，UI 保持第一层自动行为）
    pub asr_adapter_user_picked: bool,
    /// ASR WebSocket baseURL；空 = 用适配器默认端点（可指向代理/私有化网关）
    pub asr_base_url: String,
    /// 朗读（豆包 TTS）独立凭据；None 或 Key 空 = 继承识别凭据（豆包）
    pub tts_credential: Option<TtsCredential>,
    /// TTS Resource-Id（豆包语音合成模型 2.0：seed-tts-2.0）
    pub tts_resource_id: String,
    /// TTS 音色（如 zh_female_cancan）
    pub voice_name: String,
    /// 语速 0.2~3.0，默认 1.0
    pub speed: f64,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            mode: "legacy".into(),
            app_key: String::new(),
            access_key: String::new(),
            asr_resource_id: "volc.seedasr.sauc.duration".into(),
            asr_adapter: "auto".into(),
            asr_adapter_user_picked: false,
            asr_base_url: String::new(),
            tts_credential: None,
            tts_resource_id: "seed-tts-2.0".into(),
            voice_name: String::new(),
            speed: 1.0,
        }
    }
}

/// 配置状态摘要（voice_config_status 结构化返回，供入口灰置与 AI 诊断）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// 识别（ASR）凭据已配置
    pub asr_ready: bool,
    /// 识别实际走的适配器（auto 按关键词解析后：doubao | bailian）
    pub asr_adapter: String,
    /// 朗读（TTS）凭据与音色已齐，可合成
    pub tts_ready: bool,
    /// 朗读是否使用独立凭据（false = 继承识别凭据）
    pub tts_standalone: bool,
}

impl VoiceConfig {
    /// 识别（ASR）凭据是否已配置（百炼适配器单 API Key 即可；豆包按两种模式判定）
    pub fn configured(&self) -> bool {
        if self.is_key_only_adapter() {
            return !self.app_key.trim().is_empty();
        }
        match self.mode.as_str() {
            "new" => !self.app_key.trim().is_empty(),
            _ => !self.app_key.trim().is_empty() && !self.access_key.trim().is_empty(),
        }
    }

    /// 单凭据（API Key）适配器：百炼/DashScope（'qwen' 为历史值）
    pub fn is_key_only_adapter(&self) -> bool {
        matches!(self.asr_adapter.as_str(), "bailian" | "qwen")
    }

    /// 朗读（TTS）生效凭据：(mode, app_key, access_key)。
    /// 独立凭据（tts_credential.Key 非空）优先；否则继承识别凭据。
    pub fn tts_effective(&self) -> (String, String, String) {
        if let Some(t) = &self.tts_credential {
            if !t.app_key.trim().is_empty() {
                return (
                    t.mode.clone(),
                    t.app_key.trim().to_string(),
                    t.access_key.trim().to_string(),
                );
            }
        }
        (
            self.mode.clone(),
            self.app_key.trim().to_string(),
            self.access_key.trim().to_string(),
        )
    }

    /// 朗读（TTS）是否可用：生效凭据齐 + 已设音色。
    /// 注意识别配百炼（DashScope）时继承凭据是百炼的，不能用于豆包 TTS——
    /// 此时必须配独立凭据，否则此函数返回 false（继承凭据 mode 会带过去，需额外判别）。
    pub fn tts_configured(&self) -> bool {
        let (mode, app_key, access_key) = self.tts_effective();
        // 继承场景：识别配了百炼（凭据是 DashScope 的）→ 继承凭据对豆包 TTS 无效
        let inherited_from_key_only = self
            .tts_credential
            .as_ref()
            .map(|t| t.app_key.trim().is_empty())
            .unwrap_or(true)
            && self.is_key_only_adapter();
        if inherited_from_key_only {
            return false;
        }
        let cred = match mode.as_str() {
            "new" => !app_key.is_empty(),
            _ => !app_key.is_empty() && !access_key.is_empty(),
        };
        cred && !self.voice_name.trim().is_empty()
    }

    /// 朗读是否使用独立凭据（false = 继承识别凭据）
    pub fn tts_standalone(&self) -> bool {
        self.tts_credential
            .as_ref()
            .map(|t| !t.app_key.trim().is_empty())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bailian() -> VoiceConfig {
        VoiceConfig {
            asr_adapter: "bailian".into(),
            mode: "new".into(),
            app_key: "sk-ws-demo".into(),
            voice_name: "zh_female_cancan_uranus_bigtts".into(),
            ..Default::default()
        }
    }

    /// 百炼是单凭据适配器：只填 API Key 就算配好（历史值 qwen 同样认）
    #[test]
    fn key_only_adapter_configured_with_single_key() {
        assert!(bailian().configured());
        let legacy = VoiceConfig {
            asr_adapter: "qwen".into(),
            app_key: "sk-demo".into(),
            ..Default::default()
        };
        assert!(legacy.configured(), "历史值 qwen 要与 bailian 同等对待");
        assert!(legacy.is_key_only_adapter() && bailian().is_key_only_adapter());
        // 豆包仍按两种模式判定：新版权限 Key 单凭据可用
        let doubao_new = VoiceConfig {
            asr_adapter: "doubao".into(),
            mode: "new".into(),
            app_key: "ark-demo".into(),
            ..Default::default()
        };
        assert!(doubao_new.configured() && !doubao_new.is_key_only_adapter());
    }

    /// 朗读继承语义：识别配百炼时继承凭据对豆包 TTS 无效 —— 必须独立凭据 + 音色才 ready。
    /// 这条守住「切到百炼后朗读静默失效」这个最隐蔽的坑（apply 脚本会把豆包凭据搬进 ttsCredential）。
    #[test]
    fn tts_inheritance_breaks_on_key_only_adapter_until_standalone() {
        let mut cfg = bailian();
        assert!(!cfg.tts_configured(), "百炼继承凭据不能再拿去调豆包 TTS");
        cfg.tts_credential = Some(TtsCredential {
            mode: "new".into(),
            app_key: "ark-demo".into(),
            access_key: String::new(),
        });
        assert!(cfg.tts_configured(), "独立豆包凭据 + 音色齐 = 朗读可用");
        assert!(cfg.tts_standalone());
        // 豆包适配器下继承本身是合法的
        let doubao = VoiceConfig {
            asr_adapter: "doubao".into(),
            mode: "new".into(),
            app_key: "ark-demo".into(),
            voice_name: "zh_female_cancan_uranus_bigtts".into(),
            ..Default::default()
        };
        assert!(doubao.tts_configured() && !doubao.tts_standalone());
    }
}

/// 一条纪要（voice_memos 行）。句子与总结是前端约定的 JSON 文本列：
/// sentences = [{idx,text,startMs,endMs}]，summary = [{kind,text,note,refs,written}]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMemo {
    pub id: String,
    pub chat_id: String,
    pub message_id: Option<String>,
    pub title: String,
    pub audio_path: Option<String>,
    pub duration_ms: i64,
    pub words: i64,
    pub sentences: String,
    pub summary: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMemoInput {
    pub id: String,
    pub chat_id: String,
    pub message_id: Option<String>,
    pub title: Option<String>,
    pub audio_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub words: Option<i64>,
    pub sentences_json: Option<String>,
    pub summary_json: Option<String>,
}
