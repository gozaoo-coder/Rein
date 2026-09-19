//! 语音共享层：命令/事件模型、识别会话循环（驱动 `asr::AsrAdapter`）、音频落盘、TTS。
//!
//! 会话循环对适配器协议无感知：Audio → send_audio，Finish → finish_input，
//! 下行帧 → on_frame → 归一化事件（partial/final）emit `voice://asr`；
//! is_done 后包装 WAV 并发 ended。未 Finish 的异常断开保留 .pcm 供恢复。
//!
//! TTS（seed-tts-2.0 同步接口）：HTTP POST /api/v3/plan/tts/unidirectional，
//! 请求/响应格式已于 2026-09-12 用真实凭据实测钉准（见 tts_http_synth 注释）。

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::asr::{AnyAsrAdapter, AsrAdapter, AsrAdapterKind, AsrSessionParams, NormEvent};
use super::models::VoiceConfig;
use crate::error::{ReinError, Result};

pub const ASR_EVENT: &str = "voice://asr";
pub const TTS_EVENT: &str = "voice://tts";

/// 音频采样字节率：16000 samples/s × 2 bytes
const PCM_BYTES_PER_SEC: usize = 32_000;

/// 下行帧（适配器解析用）
pub enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// 发给识别任务的命令（经 VoiceHub 通道转交 WS 任务）
pub enum AsrCmd {
    Audio(Vec<u8>),
    Finish,
    Cancel,
}

/// 回给前端的识别事件（Tauri event `voice://asr`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrEvent {
    pub session_id: String,
    /// partial | final | ended | error
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AsrEvent {
    fn sentence(session_id: &str, kind: &str, text: &str, start: i64, end: i64) -> Self {
        Self {
            session_id: session_id.into(),
            kind: kind.into(),
            text: Some(text.into()),
            start_ms: Some(start),
            end_ms: Some(end),
            audio_path: None,
            duration_ms: None,
            message: None,
        }
    }

    fn ended(session_id: &str, audio_path: String, duration_ms: i64) -> Self {
        Self {
            session_id: session_id.into(),
            kind: "ended".into(),
            text: None,
            start_ms: None,
            end_ms: None,
            audio_path: Some(audio_path),
            duration_ms: Some(duration_ms),
            message: None,
        }
    }

    fn error(session_id: &str, message: String) -> Self {
        Self {
            session_id: session_id.into(),
            kind: "error".into(),
            text: None,
            start_ms: None,
            end_ms: None,
            audio_path: None,
            duration_ms: None,
            message: Some(message),
        }
    }
}

pub fn voice_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ReinError::Message(format!("应用数据目录不可用：{e}")))?
        .join("voice_sessions");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn emit_asr(app: &tauri::AppHandle, ev: AsrEvent) {
    use tauri::Emitter;
    let _ = app.emit(ASR_EVENT, &ev);
}

/// 启动一次识别会话：spawn 会话任务并返回命令发送端。
/// 音频字节在转发给厂商的同时追加写本地 .pcm（崩溃后可恢复原声）。
pub fn spawn_asr_session(
    app: tauri::AppHandle,
    session_id: String,
    kind: AsrAdapterKind,
    params: AsrSessionParams,
) -> Result<UnboundedSender<AsrCmd>> {
    let (tx, rx) = unbounded_channel::<AsrCmd>();
    let app_err = app.clone();
    let sid_err = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_asr_session(app, session_id, kind, params, rx).await {
            emit_asr(
                &app_err,
                AsrEvent::error(&sid_err, format!("语音识别中断：{e}")),
            );
        }
    });
    Ok(tx)
}

async fn run_asr_session(
    app: tauri::AppHandle,
    session_id: String,
    kind: AsrAdapterKind,
    params: AsrSessionParams,
    mut rx: UnboundedReceiver<AsrCmd>,
) -> Result<()> {
    let mut adapter = match kind {
        AsrAdapterKind::Doubao => AnyAsrAdapter::Doubao(super::asr::DoubaoAdapter::new(params)),
        AsrAdapterKind::Qwen => AnyAsrAdapter::Qwen(super::asr::QwenAdapter::new(params)),
    };

    // 音频落盘文件（pcm → 结束后包装 wav）
    let dir = voice_dir(&app)?;
    let pcm_path = dir.join(format!("{session_id}.pcm"));
    let wav_path = dir.join(format!("{session_id}.wav"));
    let mut pcm_file = std::fs::File::create(&pcm_path)?;
    let mut pcm_bytes: usize = 0;

    if let Err(e) = adapter.connect().await {
        emit_asr(&app, AsrEvent::error(&session_id, e.to_string()));
        return Ok(());
    }

    let mut finishing = false;
    let mut cancelled = false;
    let result: Result<()> = loop {
        tokio::select! {
            cmd = rx.recv() => {
                match cmd {
                    Some(AsrCmd::Audio(bytes)) => {
                        if !finishing {
                            if let Err(e) = adapter.send_audio(&bytes).await {
                                break Err(e);
                            }
                            pcm_file.write_all(&bytes)?;
                            pcm_bytes += bytes.len();
                        }
                    }
                    Some(AsrCmd::Finish) => {
                        finishing = true;
                        if let Err(e) = adapter.finish_input().await {
                            break Err(e);
                        }
                    }
                    // 取消：静默退出，删除音频，不发 ended
                    Some(AsrCmd::Cancel) | None => {
                        cancelled = true;
                        break Ok(());
                    }
                }
            }
            frame = adapter.next_frame() => {
                match frame {
                    Some(Ok(f)) => {
                        for ev in adapter.on_frame(f).await? {
                            match ev {
                                NormEvent::Final { text, start_ms, end_ms } => {
                                    emit_asr(&app, AsrEvent::sentence(&session_id, "final", &text, start_ms, end_ms));
                                }
                                NormEvent::Partial { text, start_ms } => {
                                    emit_asr(&app, AsrEvent::sentence(&session_id, "partial", &text, start_ms, start_ms));
                                }
                            }
                        }
                    }
                    Some(Err(e)) => break Err(e),
                    None => break Ok(()), // 连接关闭视为结束（未 Finish 则保留 .pcm）
                }
            }
        }
        if adapter.is_done() {
            break Ok(());
        }
    };

    drop(adapter); // 关闭 WS
    drop(pcm_file);
    if cancelled {
        let _ = std::fs::remove_file(&pcm_path);
        return Ok(());
    }
    if let Err(e) = result {
        emit_asr(&app, AsrEvent::error(&session_id, e.to_string()));
        return Ok(());
    }
    if !finishing {
        // 连接异常断开（未走 Finish）：保留 .pcm，前端据此提示恢复原声
        return Ok(());
    }
    match wrap_wav(&pcm_path, &wav_path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&pcm_path);
            emit_asr(
                &app,
                AsrEvent::ended(
                    &session_id,
                    wav_path.to_string_lossy().to_string(),
                    (pcm_bytes / 32) as i64,
                ),
            );
        }
        Err(e) => emit_asr(
            &app,
            AsrEvent::error(&session_id, format!("音频包装失败：{e}")),
        ),
    }
    Ok(())
}

/// pcm_s16le 16k mono → 追加 44 字节 WAV 头
fn wrap_wav(pcm: &PathBuf, wav: &PathBuf) -> Result<()> {
    use std::io::Read;
    let mut data = Vec::new();
    std::fs::File::open(pcm)?.read_to_end(&mut data)?;
    let mut out = Vec::with_capacity(data.len() + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((data.len() + 36) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
    out.extend_from_slice(&(PCM_BYTES_PER_SEC as u32).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    std::fs::write(wav, out)?;
    Ok(())
}

/* ---------------- TTS 同步合成 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsResult {
    /// 音频文件绝对路径（前端 convertFileSrc 转可播放 URL）
    pub audio_path: String,
}

/// 同步合成一段语音并落盘（HTTP POST unidirectional）。
/// 2026-09-12 真实凭据实测钉准：请求体 = user + req_params{text, speaker, audio_params}；
/// 响应为 ndjson 行流，每行 {code, message, data?}，data 为 base64 音频块需顺序解码拼接；
/// 语速字段 speech_rate 为百分比制（0 正常 / 100 两倍 / -50 半速），speed_ratio 无效。
/// 音色须为 2.0 音色 ID（如 zh_female_cancan_uranus_bigtts），1.0 音色报资源不匹配。
pub async fn tts_http_synth(
    app: &tauri::AppHandle,
    cfg: &VoiceConfig,
    speak_id: &str,
    text: &str,
) -> Result<TtsResult> {
    if !cfg.configured() {
        return Err(ReinError::Message("尚未配置豆包语音服务".into()));
    }
    if cfg.voice_name.trim().is_empty() {
        return Err(ReinError::Message("尚未设置朗读音色".into()));
    }
    if !cfg.tts_configured() {
        // 已配音色但凭据不可用：最常见是识别配了 Qwen、朗读凭据未单独配豆包
        return Err(ReinError::Message(
            "朗读凭据不可用：豆包 TTS 需要豆包凭据（识别配了 Qwen 时请在朗读独立凭据里填入）"
                .into(),
        ));
    }
    let speech_rate = ((cfg.speed.clamp(0.2, 3.0) - 1.0) * 100.0)
        .round()
        .clamp(-50.0, 100.0) as i32;
    let body = serde_json::json!({
        "user": { "uid": "rein" },
        "req_params": {
            "text": text,
            "speaker": cfg.voice_name.trim(),
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": speech_rate,
            },
        },
    });

    let dir = voice_dir(app)?;
    let out_path = dir.join(format!("tts_{speak_id}.mp3"));
    // TTS 用生效凭据：独立凭据优先，否则继承识别凭据（含凭据模式）
    let (tts_mode, app_key, access_key) = cfg.tts_effective();
    let mode = tts_mode;
    let resource = cfg.tts_resource_id.trim().to_string();
    let payload = serde_json::to_vec(&body)?;
    let out = out_path.clone();

    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<(), ReinError> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .build();
        let mut req = agent
            .post("https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional")
            .set("Content-Type", "application/json")
            // ureq 不支持 brotli：显式声明可接受的压缩，避免服务端返回 br 致解析失败
            .set("Accept-Encoding", "identity");
        match mode.as_str() {
            "new" => req = req.set("X-Api-Key", &app_key),
            _ => {
                req = req.set("X-Api-App-Key", &app_key);
                req = req.set("X-Api-Access-Key", &access_key);
            }
        }
        req = req.set("X-Api-Resource-Id", &resource);
        req = req.set("X-Api-Request-Id", &uuid::Uuid::new_v4().to_string());
        let resp = req
            .send_bytes(&payload)
            .map_err(|e| ReinError::Message(format!("TTS 请求失败：{e}")))?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut bytes)?;

        // ndjson 行流：data 块拼接；行内 code 非 0 视为失败
        let mut audio: Vec<u8> = Vec::new();
        for line in bytes.split(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v = match serde_json::from_str::<serde_json::Value>(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            // 20000000 = 流结束的成功终止行（message "OK"，无音频数据），不是错误
            if code != 0 && code != 20000000 {
                let msg = v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(ReinError::Message(format!(
                    "TTS 合成失败（code {code}）：{msg}"
                )));
            }
            if let Some(b64) = v.get("data").and_then(|d| d.as_str()) {
                let chunk = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| ReinError::Message(format!("TTS 音频解码失败：{e}")))?;
                audio.extend_from_slice(&chunk);
            }
        }
        if audio.is_empty() {
            // 防御：整体为二进制音频体时直接落盘
            if is_audio(&bytes) {
                audio = bytes;
            } else {
                let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).to_string();
                return Err(ReinError::Message(format!("TTS 响应缺少音频数据：{head}")));
            }
        }
        std::fs::write(&out, &audio)?;
        Ok(())
    })
    .await
    .map_err(|e| ReinError::Message(format!("TTS 任务失败：{e}")))??;

    Ok(TtsResult {
        audio_path: out_path.to_string_lossy().to_string(),
    })
}

/// 粗判二进制音频：mp3(ID3/帧头) / wav(RIFF) / ogg
fn is_audio(b: &[u8]) -> bool {
    if b.len() < 4 {
        return false;
    }
    b.starts_with(b"ID3")
        || b.starts_with(b"RIFF")
        || b.starts_with(b"OggS")
        || (b[0] == 0xff && (b[1] & 0xe0) == 0xe0)
}
