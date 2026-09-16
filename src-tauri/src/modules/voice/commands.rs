//! voice 域命令 · 对应前端 `voiceService.ts`。
//!
//! 三组：①语音服务配置（app_meta JSON 单条）；②流式识别会话（命令通道 → WS 任务，
//! 结果经 `voice://asr` 事件回流）；③纪要 CRUD（voice_memos 表）与崩溃恢复草稿。

use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager, State};

use super::asr::{AsrAdapter, AsrAdapterKind, AsrSessionParams};
use super::models::{TtsCredential, VoiceConfig, VoiceMemo, VoiceMemoInput, VoiceStatus};
use super::protocol::{self, AsrCmd, TtsResult};
use crate::error::{ReinError, Result};
use crate::state::{AppState, VoiceHub};

const META_CONFIG: &str = "voice_config";
const META_DRAFT: &str = "voice_draft";

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/* ---------------- 配置 ---------------- */

#[tauri::command]
pub async fn voice_config_get(state: State<'_, AppState>) -> Result<VoiceConfig> {
    let conn = state.db.lock().unwrap();
    let raw = meta_get(&conn, META_CONFIG).unwrap_or_default();
    if raw.is_empty() {
        return Ok(VoiceConfig::default());
    }
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

#[tauri::command]
pub async fn voice_config_save(state: State<'_, AppState>, config: VoiceConfig) -> Result<()> {
    let conn = state.db.lock().unwrap();
    meta_set(&conn, META_CONFIG, &serde_json::to_string(&config)?)?;
    Ok(())
}

/// 配置状态摘要（结构化）：识别/朗读各自是否就绪 + 实际适配器 + 朗读是否独立凭据
#[tauri::command]
pub async fn voice_config_status(state: State<'_, AppState>) -> Result<VoiceStatus> {
    let conn = state.db.lock().unwrap();
    let raw = meta_get(&conn, META_CONFIG).unwrap_or_default();
    let cfg: VoiceConfig = if raw.is_empty() {
        VoiceConfig::default()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    };
    drop(conn);
    let asr_adapter = match cfg.asr_adapter.as_str() {
        "doubao" => "doubao".into(),
        "qwen" => "qwen".into(),
        _ => AsrAdapterKind::detect(&cfg.asr_base_url, &cfg.asr_resource_id)
            .map(|k| {
                if k == AsrAdapterKind::Qwen {
                    "qwen"
                } else {
                    "doubao"
                }
            })
            .unwrap_or("doubao")
            .into(),
    };
    Ok(VoiceStatus {
        asr_ready: cfg.configured(),
        asr_adapter,
        tts_ready: cfg.tts_configured(),
        tts_standalone: cfg.tts_standalone(),
    })
}

/// 前端统一从本函数读配置（避免两处解析逻辑漂移）
pub fn config_from_meta(state: &State<'_, AppState>) -> VoiceConfig {
    let conn = state.db.lock().unwrap();
    let raw = meta_get(&conn, META_CONFIG).unwrap_or_default();
    if raw.is_empty() {
        VoiceConfig::default()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    }
}

/* ---------------- 连通性探测（AI 辅助配置与手动调试共用） ---------------- */

/// TTS 探测：用给定音色合成一句短文本（不入库），返回音频路径供前端试听。
/// 不传音色时用配置里的当前音色 —— 用于「试听音色」与配置后的连通验证。
#[tauri::command]
pub async fn voice_tts_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    voice_name: Option<String>,
) -> Result<TtsResult> {
    let mut cfg = config_from_meta(&state);
    if let Some(vn) = voice_name {
        let vn = vn.trim().to_string();
        if vn.is_empty() {
            return Err(ReinError::Message("音色 ID 不能为空".into()));
        }
        cfg.voice_name = vn;
    }
    let speak_id = format!("probe{}", chrono::Utc::now().timestamp_millis());
    protocol::tts_http_synth(
        &app,
        &cfg,
        &speak_id,
        "你好，我是 Rein 的语音助手，很高兴为你服务。",
    )
    .await
}

/// ASR 探测：用配置凭据建一次识别连接并立即结束（不推音频），
/// 验证凭据/端点/资源 ID 是否可用。快速失败并返回具体错误（鉴权、模型名、网络等）。
#[tauri::command]
pub async fn voice_asr_probe(app: AppHandle) -> Result<()> {
    let cfg: VoiceConfig = {
        let st = app.state::<AppState>();
        let conn = st.db.lock().unwrap();
        let raw = meta_get(&conn, META_CONFIG).unwrap_or_default();
        if raw.is_empty() {
            VoiceConfig::default()
        } else {
            serde_json::from_str(&raw).unwrap_or_default()
        }
    };
    if !cfg.configured() {
        return Err(ReinError::Message("尚未配置识别凭据".into()));
    }
    let kind = match cfg.asr_adapter.as_str() {
        "doubao" => AsrAdapterKind::Doubao,
        "qwen" => AsrAdapterKind::Qwen,
        _ => AsrAdapterKind::detect(&cfg.asr_base_url, &cfg.asr_resource_id)
            .unwrap_or(AsrAdapterKind::Doubao),
    };
    let url = {
        let trimmed = cfg.asr_base_url.trim();
        if trimmed.is_empty() {
            kind.default_url().to_string()
        } else {
            trimmed.to_string()
        }
    };
    let params = AsrSessionParams {
        url,
        app_key: cfg.app_key.trim().to_string(),
        access_key: cfg.access_key.trim().to_string(),
        credential_mode: cfg.mode.clone(),
        model: cfg.asr_resource_id.trim().to_string(),
    };
    let mut adapter = match kind {
        AsrAdapterKind::Doubao => {
            super::asr::AnyAsrAdapter::Doubao(super::asr::DoubaoAdapter::new(params))
        }
        AsrAdapterKind::Qwen => {
            super::asr::AnyAsrAdapter::Qwen(super::asr::QwenAdapter::new(params))
        }
    };
    // 建连 + 首控包；有误直接抛具体错误（鉴权/资源 ID/网络）
    adapter.connect().await?;
    adapter.finish_input().await?;
    // 拉一次下行帧：拿到响应即认为连通（内容不重要，超时/错误帧都会抛）
    let deadline = tokio::time::Duration::from_secs(10);
    match tokio::time::timeout(deadline, adapter.next_frame()).await {
        Ok(Some(Ok(_))) => Ok(()),
        Ok(Some(Err(e))) => Err(e),
        Ok(None) => Ok(()), // 连接被服务端正常关闭也算建连成功
        Err(_) => Err(ReinError::Message("识别服务响应超时（10s）".into())),
    }
}

/// 保存朗读独立凭据（供 AI 工具用：只改 TTS 部分，不动识别配置）
#[tauri::command]
pub async fn voice_tts_credential_save(
    state: State<'_, AppState>,
    tts_credential: Option<TtsCredential>,
) -> Result<()> {
    let mut cfg = config_from_meta(&state);
    cfg.tts_credential = tts_credential;
    let conn = state.db.lock().unwrap();
    meta_set(&conn, META_CONFIG, &serde_json::to_string(&cfg)?)?;
    Ok(())
}

/* ---------------- 流式识别会话 ---------------- */

/// 启动识别会话：spawn WS 任务，之后经 voice_asr_audio 推 200ms PCM 包。
#[tauri::command]
pub async fn voice_asr_start(
    app: AppHandle,
    hub: State<'_, VoiceHub>,
    session_id: String,
) -> Result<()> {
    if session_id.is_empty() {
        return Err(ReinError::Message("sessionId 不能为空".into()));
    }
    let cfg: VoiceConfig = {
        let st = app.state::<AppState>();
        let conn = st.db.lock().unwrap();
        let raw = meta_get(&conn, META_CONFIG).unwrap_or_default();
        if raw.is_empty() {
            VoiceConfig::default()
        } else {
            serde_json::from_str(&raw).unwrap_or_default()
        }
    };
    // 适配器解析：显式选择优先；auto 按 baseURL/模型关键词识别，识别不出回落豆包
    let kind = match cfg.asr_adapter.as_str() {
        "doubao" => AsrAdapterKind::Doubao,
        "qwen" => AsrAdapterKind::Qwen,
        _ => AsrAdapterKind::detect(&cfg.asr_base_url, &cfg.asr_resource_id)
            .unwrap_or(AsrAdapterKind::Doubao),
    };
    let url = {
        let trimmed = cfg.asr_base_url.trim();
        if trimmed.is_empty() {
            kind.default_url().to_string()
        } else {
            trimmed.to_string()
        }
    };
    let params = AsrSessionParams {
        url,
        app_key: cfg.app_key.trim().to_string(),
        access_key: cfg.access_key.trim().to_string(),
        credential_mode: cfg.mode.clone(),
        model: cfg.asr_resource_id.trim().to_string(),
    };
    let tx = protocol::spawn_asr_session(app, session_id.clone(), kind, params)?;
    hub.sessions.lock().unwrap().insert(session_id, tx);
    Ok(())
}

/// 推送一包 16k/16bit/mono PCM 音频（约 200ms，base64 编码）
#[tauri::command]
pub async fn voice_asr_audio(
    hub: State<'_, VoiceHub>,
    session_id: String,
    audio_b64: String,
) -> Result<()> {
    let tx = hub
        .sessions
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| ReinError::Message("识别会话不存在".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_b64)
        .map_err(|e| ReinError::Message(format!("音频解码失败：{e}")))?;
    let _ = tx.send(AsrCmd::Audio(bytes));
    Ok(())
}

/// 结束识别：发负包，等服务端最终响应后包装 WAV 并发 ended 事件
#[tauri::command]
pub async fn voice_asr_finish(hub: State<'_, VoiceHub>, session_id: String) -> Result<()> {
    if let Some(tx) = hub.sessions.lock().unwrap().get(&session_id).cloned() {
        let _ = tx.send(AsrCmd::Finish);
    }
    Ok(())
}

/// 取消识别：丢弃音频与结果
#[tauri::command]
pub async fn voice_asr_cancel(
    app: AppHandle,
    hub: State<'_, VoiceHub>,
    session_id: String,
) -> Result<()> {
    if let Some(tx) = hub.sessions.lock().unwrap().remove(&session_id) {
        let _ = tx.send(AsrCmd::Cancel);
    }
    // 兜底清理可能残留的临时文件
    if let Ok(dir) = protocol::voice_dir(&app) {
        let _ = std::fs::remove_file(dir.join(format!("{session_id}.pcm")));
    }
    Ok(())
}

/* ---------------- TTS ---------------- */

/// 同步合成一段语音（纪要朗读），返回音频文件路径（前端 convertFileSrc 播放）
#[tauri::command]
pub async fn voice_tts_speak(
    app: AppHandle,
    state: State<'_, AppState>,
    speak_id: String,
    text: String,
) -> Result<TtsResult> {
    let cfg = config_from_meta(&state);
    protocol::tts_http_synth(&app, &cfg, &speak_id, &text).await
}

/* ---------------- 纪要 CRUD ---------------- */

fn row_to_memo(r: &rusqlite::Row) -> rusqlite::Result<VoiceMemo> {
    Ok(VoiceMemo {
        id: r.get(0)?,
        chat_id: r.get(1)?,
        message_id: r.get(2)?,
        title: r.get(3)?,
        audio_path: r.get(4)?,
        duration_ms: r.get(5)?,
        words: r.get(6)?,
        sentences: r.get(7)?,
        summary: r.get(8)?,
        created_at: r.get(9)?,
    })
}

const MEMO_COLS: &str = "id, chat_id, message_id, title, audio_path, duration_ms, words, sentences, summary, created_at";

#[tauri::command]
pub async fn voice_memo_create(
    state: State<'_, AppState>,
    input: VoiceMemoInput,
) -> Result<VoiceMemo> {
    let conn = state.db.lock().unwrap();
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO voice_memos (id, chat_id, message_id, title, audio_path, duration_ms, words, sentences, summary, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            input.id,
            input.chat_id,
            input.message_id,
            input.title.unwrap_or_default(),
            input.audio_path,
            input.duration_ms.unwrap_or(0),
            input.words.unwrap_or(0),
            input.sentences_json.unwrap_or_else(|| "[]".into()),
            input.summary_json.unwrap_or_else(|| "[]".into()),
            created_at,
        ],
    )?;
    drop(conn);
    voice_memo_get_inner(&state, &input.id)
}

fn voice_memo_get_inner(state: &State<'_, AppState>, id: &str) -> Result<VoiceMemo> {
    let conn = state.db.lock().unwrap();
    conn.query_row(
        &format!("SELECT {MEMO_COLS} FROM voice_memos WHERE id = ?1"),
        [id],
        row_to_memo,
    )
    .optional()?
    .ok_or_else(|| ReinError::Message("纪要不存在".into()))
}

#[tauri::command]
pub async fn voice_memo_get(state: State<'_, AppState>, id: String) -> Result<VoiceMemo> {
    voice_memo_get_inner(&state, &id)
}

#[tauri::command]
pub async fn voice_memo_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<VoiceMemo>> {
    let conn = state.db.lock().unwrap();
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMO_COLS} FROM voice_memos ORDER BY created_at DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit], row_to_memo)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 仅更新总结列（写入状态变更：summary 内 written 标记）
#[tauri::command]
pub async fn voice_memo_set_summary(
    state: State<'_, AppState>,
    id: String,
    summary_json: String,
) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE voice_memos SET summary = ?1 WHERE id = ?2",
        params![summary_json, id],
    )?;
    Ok(())
}

/// 标题改名（AI 生成失败后的手动兜底）
#[tauri::command]
pub async fn voice_memo_rename(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE voice_memos SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn voice_memo_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM voice_memos WHERE id = ?1", [id])?;
    Ok(())
}

/* ---------------- 崩溃恢复草稿 ---------------- */

/// 转写过程中的逐句落盘草稿（崩溃后可恢复继续/补交/丢弃）
#[tauri::command]
pub async fn voice_draft_save(state: State<'_, AppState>, draft_json: String) -> Result<()> {
    let conn = state.db.lock().unwrap();
    meta_set(&conn, META_DRAFT, &draft_json)?;
    Ok(())
}

#[tauri::command]
pub async fn voice_draft_get(state: State<'_, AppState>) -> Result<Option<String>> {
    let conn = state.db.lock().unwrap();
    Ok(meta_get(&conn, META_DRAFT))
}

#[tauri::command]
pub async fn voice_draft_clear(state: State<'_, AppState>) -> Result<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM app_meta WHERE key = ?1", [META_DRAFT])?;
    Ok(())
}
