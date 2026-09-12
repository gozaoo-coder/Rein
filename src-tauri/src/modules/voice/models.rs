//! 语音域数据结构 · 与前端 `types/voice.ts` 镜像（camelCase）。

use serde::{Deserialize, Serialize};

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
    /// Qwen 适配器下此字段 = 模型名（如 qwen-audio-3.0-asr-flash-streaming）
    pub asr_resource_id: String,
    /// ASR 适配器：auto（按 baseURL/模型关键词自动识别）| doubao | qwen
    pub asr_adapter: String,
    /// 适配器是否由用户手动选定（false = 程序自动替选，UI 保持第一层自动行为）
    pub asr_adapter_user_picked: bool,
    /// ASR WebSocket baseURL；空 = 用适配器默认端点（可指向代理/私有化网关）
    pub asr_base_url: String,
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
            tts_resource_id: "seed-tts-2.0".into(),
            voice_name: String::new(),
            speed: 1.0,
        }
    }
}

impl VoiceConfig {
    /// 凭据是否已配置（Qwen 适配器单 API Key 即可；豆包按两种模式判定）
    pub fn configured(&self) -> bool {
        if self.asr_adapter == "qwen" {
            return !self.app_key.trim().is_empty();
        }
        match self.mode.as_str() {
            "new" => !self.app_key.trim().is_empty(),
            _ => !self.app_key.trim().is_empty() && !self.access_key.trim().is_empty(),
        }
    }

    /// ASR/TTS 请求的鉴权头（键, 值）列表
    pub fn auth_headers(&self) -> Vec<(String, String)> {
        let mut hs = Vec::new();
        match self.mode.as_str() {
            "new" => hs.push(("X-Api-Key".into(), self.app_key.trim().to_string())),
            _ => {
                hs.push(("X-Api-App-Key".into(), self.app_key.trim().to_string()));
                hs.push(("X-Api-Access-Key".into(), self.access_key.trim().to_string()));
            }
        }
        hs
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
