//! 模态层（kb_assets）：一个逻辑文件，多种模态。
//!
//! 规范见 `docs/ai-workspace.md` §2。三条不变量：
//!
//! 1. **本体与文本分离**：音频/视频/图片/二进制的字节只以引用登记（fs 相对路径或 inline 文本），
//!    绝不进检索正文；能派生文本的（转录 / 描述）以 text 模态参与索引。
//! 2. **降级永远发生**：请求的模态拿不到时回退到文本并说明原因（`degraded` + `degrade_reason`），
//!    不报错、不空转。
//! 3. **一份文件一棵模态树**：同一件事的文本 / 音频 / 视频 / 截图是同一个节点的不同模态，
//!    不是四个文件。
//!
//! 模态本体有三个来源：
//! - `kb_assets`：上传到工作区的多模态文件（storage=fs，落在应用数据目录 `workspace/media/`）；
//! - 源表本体：语音纪要的 wav（`voice_memos.audio_path`）；
//! - 附件本体：待办 / 对话消息里的 image/audio/file（JSON 里的 data URL）。

use std::path::Path;

use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};

use crate::error::{ReinError, Result};

use super::files;
use super::index;
use super::models::*;
use super::source::sanitize;

/// 内联进 data URL 的本体上限。超过只回元信息（`too_large`），由 UI 提示从磁盘取。
pub const DATA_URL_CAP: i64 = 16 * 1024 * 1024;
/// 上传本体的大小上限（base64 解码后的字节数）。
pub const UPLOAD_CAP: i64 = 64 * 1024 * 1024;

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// mime → 模态。文本类（text/*、json、markdown）都归 text，其余二进制归 binary。
pub fn modal_of_mime(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.starts_with("image/") {
        MODAL_IMAGE
    } else if m.starts_with("audio/") {
        MODAL_AUDIO
    } else if m.starts_with("video/") {
        MODAL_VIDEO
    } else if m.starts_with("text/")
        || m.contains("json")
        || m.contains("markdown")
        || m.contains("xml")
        || m.contains("csv")
    {
        MODAL_TEXT
    } else {
        MODAL_BINARY
    }
}

/// 按扩展名兜底猜 mime（前端给不出 mime 时）。
pub fn mime_of_name(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "" => "application/octet-stream",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 模态标签（描述行与 UI 用）。
pub fn modal_label(modal: &str) -> &'static str {
    match modal {
        MODAL_TEXT => "文本",
        MODAL_IMAGE => "图片",
        MODAL_AUDIO => "音频",
        MODAL_VIDEO => "视频",
        _ => "文件",
    }
}

/// 一条模态的新增入参（字段多，用结构体避免 8 个位置参数）。
#[derive(Debug, Clone, Default)]
pub struct NewAsset {
    pub modal: String,
    pub mime: String,
    /// inline | fs
    pub storage: String,
    pub ref_: String,
    pub bytes: i64,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub transcript_state: String,
    pub derived_from: Option<String>,
}

impl NewAsset {
    /// 文件本体（fs 落盘）。
    pub fn fs(modal: &str, mime: &str, ref_: &str, bytes: i64) -> Self {
        Self {
            modal: modal.to_string(),
            mime: mime.to_string(),
            storage: "fs".into(),
            ref_: ref_.to_string(),
            bytes,
            transcript_state: transcript_state_for(modal),
            ..Default::default()
        }
    }
}

/// 音频/视频默认「未转写」；其他模态没有转写概念，直接记 done。
fn transcript_state_for(modal: &str) -> String {
    match modal {
        MODAL_AUDIO | MODAL_VIDEO => TRANSCRIPT_NONE.to_string(),
        _ => TRANSCRIPT_DONE.to_string(),
    }
}

/// 登记一条模态表示。**一个节点同一模态只有一份表示**（读到什么就是这一份）：
/// 同 (file, modal) 再次登记即替换（如重新转写、换更清晰的本体）。
pub fn add(conn: &Connection, file_id: i64, a: &NewAsset) -> Result<i64> {
    if a.modal.trim().is_empty() {
        return Err(ReinError::Message("模态不能为空".into()));
    }
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM kb_assets WHERE file_id = ?1 AND modal = ?2",
            rusqlite::params![file_id, a.modal],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE kb_assets SET mime = ?2, storage = ?3, ref = ?4, bytes = ?5, duration_ms = ?6,
                    width = ?7, height = ?8, transcript_state = ?9, derived_from = ?10
             WHERE id = ?1",
            rusqlite::params![
                id,
                a.mime,
                a.storage,
                a.ref_,
                a.bytes,
                a.duration_ms,
                a.width,
                a.height,
                a.transcript_state,
                a.derived_from
            ],
        )?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO kb_assets(file_id, modal, mime, storage, ref, bytes, duration_ms, width, height,
                               transcript_state, derived_from, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, datetime('now'))",
        rusqlite::params![
            file_id,
            a.modal,
            a.mime,
            a.storage,
            a.ref_,
            a.bytes,
            a.duration_ms,
            a.width,
            a.height,
            a.transcript_state,
            a.derived_from
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_asset(r: &rusqlite::Row) -> rusqlite::Result<KbAsset> {
    Ok(KbAsset {
        id: r.get(0)?,
        file_id: r.get(1)?,
        modal: r.get(2)?,
        mime: r.get(3)?,
        storage: r.get(4)?,
        ref_: r.get(5)?,
        bytes: r.get(6)?,
        duration_ms: r.get(7)?,
        width: r.get(8)?,
        height: r.get(9)?,
        transcript_state: r.get(10)?,
        derived_from: r.get(11)?,
        created_at: r.get(12)?,
    })
}

const ASSET_COLS: &str =
    "id, file_id, modal, mime, storage, ref, bytes, duration_ms, width, height, transcript_state, derived_from, created_at";

pub fn list(conn: &Connection, file_id: i64) -> Result<Vec<KbAsset>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ASSET_COLS} FROM kb_assets WHERE file_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([file_id], row_to_asset)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 该文件节点的全部模态（不含文本正文判定——由 read 决定）。
pub fn modals_for_file(conn: &Connection, file_id: i64) -> Result<Vec<KbModalInfo>> {
    Ok(list(conn, file_id)?
        .into_iter()
        .map(|a| KbModalInfo {
            modal: a.modal,
            mime: a.mime,
            bytes: a.bytes,
            duration_ms: a.duration_ms,
            transcript_state: a.transcript_state,
            derived_from: a.derived_from,
            source: "asset".into(),
        })
        .collect())
}

/// 节点的模态清单：把三类本体来源（kb_assets / 语音纪要 / 附件）统一成一张表。
/// `root=None` 时不做磁盘探测（只列模态名，供 kb_read 的轻量响应使用）。
pub fn modals_for_source(
    conn: &Connection,
    root: Option<&Path>,
    source_type: &str,
    source_id: &str,
    text_chars: i64,
) -> Result<Vec<KbModalInfo>> {
    let mut out: Vec<KbModalInfo> = Vec::new();
    if text_chars > 0 {
        out.push(KbModalInfo {
            modal: MODAL_TEXT.into(),
            mime: "text/markdown".into(),
            bytes: text_chars,
            duration_ms: None,
            transcript_state: TRANSCRIPT_DONE.into(),
            derived_from: None,
            source: "text".into(),
        });
    }

    match source_type {
        "note" => {
            if let Ok(fid) = source_id.parse::<i64>() {
                out.extend(modals_for_file(conn, fid)?);
            }
        }
        "voice_memo" => {
            if let Some(info) = voice_audio_info(conn, root, source_id)? {
                out.push(info);
            }
        }
        "todo_attachment" => {
            if let Some(info) = todo_attachment_info(conn, source_id)? {
                out.push(info);
            }
        }
        "chat_attachment" => {
            if let Some(info) = chat_attachment_info(conn, source_id)? {
                out.push(info);
            }
        }
        _ => {}
    }
    Ok(out)
}

/// 语音纪要的 wav 本体（fs，应用数据目录内相对路径）。
fn voice_audio_info(
    conn: &Connection,
    root: Option<&Path>,
    id: &str,
) -> Result<Option<KbModalInfo>> {
    let row: Option<(Option<String>, i64)> = conn
        .query_row(
            "SELECT audio_path, duration_ms FROM voice_memos WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((Some(path), duration_ms)) = row else {
        return Ok(None);
    };
    let bytes = root
        .and_then(|r| std::fs::metadata(r.join(&path)).ok())
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    Ok(Some(KbModalInfo {
        modal: MODAL_AUDIO.into(),
        mime: "audio/wav".into(),
        bytes,
        duration_ms: Some(duration_ms),
        transcript_state: TRANSCRIPT_DONE.into(),
        derived_from: None,
        source: "voice".into(),
    }))
}

/// 待办附件本体（base64 data URL 存在 todos.attachments[id:idx] 里）。
fn todo_attachment_info(conn: &Connection, source_id: &str) -> Result<Option<KbModalInfo>> {
    let Some((todo_id, idx_raw)) = source_id.split_once(':') else {
        return Ok(None);
    };
    let Ok(idx) = idx_raw.parse::<usize>() else {
        return Ok(None);
    };
    let row: Option<(Option<String>,)> = conn
        .query_row(
            "SELECT attachments FROM todos WHERE id = ?1",
            [todo_id],
            |r| Ok((r.get(0)?,)),
        )
        .optional()?;
    let Some((Some(raw),)) = row else {
        return Ok(None);
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Ok(None);
    };
    let Some(item) = items.get(idx) else {
        return Ok(None);
    };
    let kind = item
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or(MODAL_BINARY);
    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(Some(KbModalInfo {
        modal: kind.to_string(),
        mime: mime_of_name(name),
        bytes: size,
        duration_ms: None,
        transcript_state: transcript_state_for(kind),
        derived_from: None,
        source: "attachment".into(),
    }))
}

/// 对话附件本体（图片在 image_base64，文档全文在消息正文里）。
fn chat_attachment_info(conn: &Connection, source_id: &str) -> Result<Option<KbModalInfo>> {
    let Some((msg_id, what)) = source_id.rsplit_once(':') else {
        return Ok(None);
    };
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT kind, text, image_base64 FROM ai_chat_messages WHERE id = ?1",
            [msg_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((kind, text, image)) = row else {
        return Ok(None);
    };
    match what {
        "img" => {
            let Some(img) = image else { return Ok(None) };
            let bytes = (img.len() as i64) * 3 / 4;
            Ok(Some(KbModalInfo {
                modal: MODAL_IMAGE.into(),
                mime: if img.starts_with("data:image/png") {
                    "image/png"
                } else if img.starts_with("data:image/webp") {
                    "image/webp"
                } else {
                    "image/jpeg"
                }
                .into(),
                bytes,
                duration_ms: None,
                transcript_state: TRANSCRIPT_DONE.into(),
                derived_from: None,
                source: "attachment".into(),
            }))
        }
        "doc" => {
            let chars = text.map(|t| t.chars().count() as i64).unwrap_or(0);
            Ok(Some(KbModalInfo {
                modal: MODAL_TEXT.into(),
                mime: "text/markdown".into(),
                bytes: chars,
                duration_ms: None,
                transcript_state: TRANSCRIPT_DONE.into(),
                derived_from: None,
                source: "attachment".into(),
            }))
        }
        _ => Ok(None),
    }
    .map(|opt| {
        opt.map(|mut info| {
            // 文档附件保留 kind 便于排查，但模态已归一
            if kind == "doc" {
                info.modal = MODAL_TEXT.into();
            }
            info
        })
    })
}

/// 读一次模态。`requested=None` 只回清单；给了模态就走「可用则给本体、不可用则降级文本」。
pub fn read(
    conn: &Connection,
    root: &Path,
    doc_id: i64,
    requested: Option<&str>,
) -> Result<KbMedia> {
    let row: Option<(String, String, Option<String>, String, String, String)> = conn
        .query_row(
            "SELECT source_type, source_id, path, title, kind, body FROM kb_docs WHERE id = ?1",
            [doc_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((source_type, source_id, path, title, kind, body)) = row else {
        return Err(ReinError::Message(format!(
            "知识库条目不存在：id={doc_id}（先用 search_knowledge 查 id）"
        )));
    };

    // 文本模态的正文：note 直读 kb_files 真源，其余用派生正文
    let text_body: String = if source_type == "note" {
        source_id
            .parse::<i64>()
            .ok()
            .and_then(|fid| {
                conn.query_row("SELECT content FROM kb_files WHERE id = ?1", [fid], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .ok()
                .flatten()
            })
            .unwrap_or(body.clone())
    } else {
        body.clone()
    };
    let chars = text_body.chars().count() as i64;

    let mut modalities = modals_for_source(conn, Some(root), &source_type, &source_id, chars)?;

    let base = KbMedia {
        doc_id,
        path: path.clone(),
        title: title.clone(),
        kind: kind.clone(),
        modalities: Vec::new(),
        requested: requested.map(|s| s.to_string()),
        degraded: false,
        degrade_reason: None,
        mime: None,
        data_url: None,
        too_large: false,
        text: None,
        hint: None,
    };

    let Some(want) = requested.filter(|s| !s.trim().is_empty()) else {
        return Ok(KbMedia {
            modalities: std::mem::take(&mut modalities),
            hint: Some(format!(
                "该节点可用模态：{}；需要本体时用 modal 指定",
                modalities
                    .iter()
                    .map(|m| m.modal.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            )),
            ..base
        });
    };

    // 请求文本：直接给正文（note 为全文；派生文档为索引缓存正文）
    if want == MODAL_TEXT {
        let has_text = modalities.iter().any(|m| m.modal == MODAL_TEXT);
        if !has_text {
            let desc = format!("【{}】{}（本体不在工作区，只有元信息）", kind, title);
            return Ok(KbMedia {
                modalities,
                degraded: true,
                degrade_reason: Some("该节点没有文本模态".into()),
                text: Some(desc),
                ..base
            });
        }
        return Ok(KbMedia {
            modalities,
            text: Some(text_body),
            ..base
        });
    }

    // 请求本体：先看清单里有没有
    let available = modalities.iter().any(|m| m.modal == want);
    if !available {
        let reason = degrade_reason(want, &modalities);
        return Ok(KbMedia {
            modalities,
            degraded: true,
            degrade_reason: Some(reason),
            text: Some(text_body),
            hint: Some("已降级为文本模态；本体确实不存在时不要反复重试".into()),
            ..base
        });
    }

    // 有本体：inline / fs / attachment 三路取字节
    let info = modalities
        .iter()
        .find(|m| m.modal == want)
        .cloned()
        .expect("上面已确认存在");
    let mut out = KbMedia {
        modalities: std::mem::take(&mut modalities),
        mime: Some(info.mime.clone()),
        ..base
    };
    if info.transcript_state == TRANSCRIPT_PENDING {
        out.hint = Some("转写进行中，稍后可再取文本模态".into());
    } else if info.transcript_state == TRANSCRIPT_FAILED {
        out.hint = Some("转写失败；如需文本模态可重试转写".into());
    } else if info.transcript_state == TRANSCRIPT_NONE
        && (want == MODAL_AUDIO || want == MODAL_VIDEO)
    {
        out.hint = Some("该本体尚未转写，暂不提供派生文本".into());
    }

    let payload = match info.source.as_str() {
        "asset" => {
            if want_asset_is_inline(conn, doc_id, &source_type, &source_id, want)? {
                inline_asset_text(conn, &source_id, want)?
            } else {
                fs_payload(conn, root, &source_id, want, &info)?
            }
        }
        "voice" => voice_payload(conn, root, &source_id)?,
        "attachment" => attachment_payload(conn, &source_type, &source_id, want)?,
        _ => None,
    };

    match payload {
        Some(Payload::Text(t)) => out.text = Some(t),
        Some(Payload::Bytes(mime, bytes)) => {
            if bytes.len() as i64 > DATA_URL_CAP {
                out.too_large = true;
                out.hint = Some("本体过大，未内联；可在文件管理器里播放 / 导出".into());
            } else {
                out.data_url = Some(format!(
                    "data:{};base64,{}",
                    if mime.is_empty() {
                        info.mime.as_str()
                    } else {
                        mime.as_str()
                    },
                    b64().encode(&bytes)
                ));
            }
        }
        None => {
            out.degraded = true;
            out.degrade_reason = Some("本体不可读（文件可能已被移动或删除）".into());
            out.text = Some(text_body);
        }
    }
    Ok(out)
}

enum Payload {
    Text(String),
    Bytes(String, Vec<u8>),
}

fn want_asset_is_inline(
    conn: &Connection,
    _doc_id: i64,
    source_type: &str,
    source_id: &str,
    modal: &str,
) -> Result<bool> {
    if source_type != "note" {
        return Ok(false);
    }
    let Ok(fid) = source_id.parse::<i64>() else {
        return Ok(false);
    };
    let storage: Option<String> = conn
        .query_row(
            "SELECT storage FROM kb_assets WHERE file_id = ?1 AND modal = ?2 LIMIT 1",
            rusqlite::params![fid, modal],
            |r| r.get(0),
        )
        .optional()?;
    Ok(storage.as_deref() == Some("inline"))
}

fn inline_asset_text(conn: &Connection, source_id: &str, modal: &str) -> Result<Option<Payload>> {
    let Ok(fid) = source_id.parse::<i64>() else {
        return Ok(None);
    };
    let text: Option<String> = conn
        .query_row(
            "SELECT ref FROM kb_assets WHERE file_id = ?1 AND modal = ?2 LIMIT 1",
            rusqlite::params![fid, modal],
            |r| r.get(0),
        )
        .optional()?;
    Ok(text.map(Payload::Text))
}

fn fs_payload(
    conn: &Connection,
    root: &Path,
    source_id: &str,
    modal: &str,
    info: &KbModalInfo,
) -> Result<Option<Payload>> {
    let Ok(fid) = source_id.parse::<i64>() else {
        return Ok(None);
    };
    let ref_: Option<String> = conn
        .query_row(
            "SELECT ref FROM kb_assets WHERE file_id = ?1 AND modal = ?2 AND storage = 'fs' LIMIT 1",
            rusqlite::params![fid, modal],
            |r| r.get(0),
        )
        .optional()?;
    let Some(rel) = ref_ else { return Ok(None) };
    match std::fs::read(root.join(&rel)) {
        Ok(bytes) => Ok(Some(Payload::Bytes(info.mime.clone(), bytes))),
        Err(_) => Ok(None),
    }
}

fn voice_payload(conn: &Connection, root: &Path, source_id: &str) -> Result<Option<Payload>> {
    let path: Option<String> = conn
        .query_row(
            "SELECT audio_path FROM voice_memos WHERE id = ?1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(rel) = path else { return Ok(None) };
    match std::fs::read(root.join(&rel)) {
        Ok(bytes) => Ok(Some(Payload::Bytes("audio/wav".into(), bytes))),
        Err(_) => Ok(None),
    }
}

fn attachment_payload(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    modal: &str,
) -> Result<Option<Payload>> {
    if source_type == "todo_attachment" {
        let Some((todo_id, idx_raw)) = source_id.split_once(':') else {
            return Ok(None);
        };
        let Ok(idx) = idx_raw.parse::<usize>() else {
            return Ok(None);
        };
        let raw: Option<String> = conn
            .query_row(
                "SELECT attachments FROM todos WHERE id = ?1",
                [todo_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(raw) = raw else { return Ok(None) };
        let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
            return Ok(None);
        };
        let Some(item) = items.get(idx) else {
            return Ok(None);
        };
        if let Some(content) = item.get("content").and_then(|v| v.as_str()) {
            if content.starts_with("data:") {
                return Ok(data_url_payload(content));
            }
            if modal == MODAL_TEXT {
                return Ok(Some(Payload::Text(content.to_string())));
            }
        }
        return Ok(None);
    }

    // chat_attachment：img 在 image_base64，doc 的全文在消息正文
    let Some((msg_id, what)) = source_id.rsplit_once(':') else {
        return Ok(None);
    };
    match what {
        "img" => {
            let img: Option<String> = conn
                .query_row(
                    "SELECT image_base64 FROM ai_chat_messages WHERE id = ?1",
                    [msg_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            Ok(img.as_deref().and_then(data_url_payload))
        }
        "doc" => {
            let text: Option<String> = conn
                .query_row(
                    "SELECT text FROM ai_chat_messages WHERE id = ?1",
                    [msg_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            Ok(text.map(Payload::Text))
        }
        _ => Ok(None),
    }
}

/// 把 data URL 拆成 (mime, bytes)。体积超限时返回 None 交给上层 too_large 逻辑。
fn data_url_payload(src: &str) -> Option<Payload> {
    let (head, data) = src.split_once(',')?;
    if !head.contains("base64") {
        return None;
    }
    let mime = head
        .strip_prefix("data:")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    let bytes = b64().decode(data.trim()).ok()?;
    Some(Payload::Bytes(mime, bytes))
}

fn degrade_reason(requested: &str, infos: &[KbModalInfo]) -> String {
    if let Some(info) = infos
        .iter()
        .find(|i| matches!(i.modal.as_str(), MODAL_AUDIO | MODAL_VIDEO))
    {
        return match info.transcript_state.as_str() {
            TRANSCRIPT_NONE => format!(
                "{}本体尚未转写，已降级为文本",
                if info.modal == MODAL_AUDIO {
                    "音频"
                } else {
                    "视频"
                }
            ),
            TRANSCRIPT_PENDING => "转写进行中，已降级为文本".into(),
            TRANSCRIPT_FAILED => "转写失败，已降级为文本".into(),
            _ => format!("该节点没有 {requested} 模态，已降级为文本"),
        };
    }
    format!("该节点没有 {requested} 模态，已降级为文本")
}

/* ---------- 写入（上传 / AI 产出） ---------- */

fn decode_data_url(raw: &str) -> Result<Vec<u8>> {
    let payload = match raw.split_once(',') {
        Some((head, data)) if head.starts_with("data:") => data,
        _ => raw,
    };
    b64()
        .decode(payload.trim())
        .map_err(|e| ReinError::Message(format!("本体不是合法的 base64：{e}")))
}

/// 把 base64 本体写进工作区，并登记一个多模态节点（文本模态 = 描述或调用方给的文本）。
/// 返回新节点 id。
pub fn write_media(conn: &Connection, root: &Path, input: &KbMediaInput) -> Result<i64> {
    let bytes = decode_data_url(&input.data_base64)?;
    if bytes.is_empty() {
        return Err(ReinError::Message("本体为空".into()));
    }
    if bytes.len() as i64 > UPLOAD_CAP {
        return Err(ReinError::Message(format!(
            "本体超过上传上限（{} MB）",
            UPLOAD_CAP / 1024 / 1024
        )));
    }

    let name = input
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            input
                .path
                .rsplit('/')
                .next()
                .unwrap_or("未命名")
                .to_string()
        });
    let mime = if input.mime.trim().is_empty() {
        mime_of_name(&name)
    } else {
        input.mime.clone()
    };
    let modal = modal_of_mime(&mime);

    // 本体落盘：workspace/media/{时间戳}-{净化名}
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    let safe = sanitize(&name, 60);
    let rel = format!("workspace/media/{stamp}-{safe}");
    let abs = root.join(&rel);
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| ReinError::Message(format!("创建媒体目录失败：{e}")))?;
    }
    std::fs::write(&abs, &bytes).map_err(|e| ReinError::Message(format!("写入本体失败：{e}")))?;

    // 文本模态：调用方给的优先；否则自动描述行（保证可检索，§2.3）
    let text = input
        .text
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "【{}】{name}（{mime}，{}）",
                modal_label(modal),
                human_size(bytes.len() as i64)
            )
        });

    let path = files::normalize_media_path(&input.path, &name)?;
    let file_id = files::write_media_row(conn, &path, &text, FILE_KIND_MULTIMODAL)?;
    add(
        conn,
        file_id,
        &NewAsset::fs(modal, &mime, &rel, bytes.len() as i64),
    )?;
    index::mark_dirty(conn, "note", &file_id.to_string())?;
    Ok(file_id)
}

fn human_size(bytes: i64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// 节点的本体文件相对路径清单（删除节点时一并清理磁盘）。
pub fn fs_refs(conn: &Connection, file_id: i64) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT ref FROM kb_assets WHERE file_id = ?1 AND storage = 'fs'")?;
    let rows = stmt.query_map([file_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::kb::{files, index};
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_test(&conn).unwrap();
        conn
    }

    /// 每个测试一个独立临时目录（避免并行测试互相踩）。
    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rein-kb-assets-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mime_mapping_covers_the_five_modals() {
        assert_eq!(modal_of_mime("image/png"), MODAL_IMAGE);
        assert_eq!(modal_of_mime("audio/wav"), MODAL_AUDIO);
        assert_eq!(modal_of_mime("video/mp4"), MODAL_VIDEO);
        assert_eq!(modal_of_mime("text/markdown"), MODAL_TEXT);
        assert_eq!(modal_of_mime("application/pdf"), MODAL_BINARY);
        assert_eq!(mime_of_name("会议.mp4"), "video/mp4");
    }

    #[test]
    fn write_media_creates_node_and_asset_and_is_searchable() {
        let conn = db();
        let root = temp_root("write");
        let payload = b64().encode(b"fake-mp4-bytes");
        let id = write_media(
            &conn,
            &root,
            &KbMediaInput {
                path: "视频/会议录像.mp4".into(),
                name: Some("会议录像.mp4".into()),
                mime: "video/mp4".into(),
                data_base64: payload,
                text: Some("周一站会的录屏，讨论了排班。".into()),
            },
        )
        .unwrap();

        let f = files::get(&conn, id).unwrap();
        assert_eq!(f.path, "视频/会议录像.mp4");
        assert_eq!(f.kind, FILE_KIND_MULTIMODAL);

        let assets = list(&conn, id).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].modal, MODAL_VIDEO);
        assert_eq!(assets[0].storage, "fs");
        assert_eq!(assets[0].transcript_state, TRANSCRIPT_NONE);
        assert!(root.join(&assets[0].ref_).exists(), "本体必须落盘");

        // 文本模态（描述/转录）进索引，本体不进
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        let body: String = conn
            .query_row(
                "SELECT body FROM kb_docs WHERE source_type='note' AND source_id=?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(body.contains("排班"));
        assert!(!body.contains("base64"), "本体绝不能进索引正文");
    }

    #[test]
    fn read_degrades_to_text_when_requested_modal_missing() {
        let conn = db();
        let root = temp_root("degrade");
        let id = files::write(&conn, "笔记/膝盖.md", "避免深蹲超过 60 公斤。").unwrap();
        index::apply_one(&conn, "note", &id.to_string()).unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type='note' AND source_id=?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .unwrap();

        let m = read(&conn, &root, doc_id, Some(MODAL_AUDIO)).unwrap();
        assert!(m.degraded, "没有音频本体时必须降级");
        assert!(m.degrade_reason.unwrap().contains("没有"));
        assert!(m.text.unwrap().contains("深蹲"));

        // 请求文本是正常路径，不算降级
        let t = read(&conn, &root, doc_id, Some(MODAL_TEXT)).unwrap();
        assert!(!t.degraded);
        assert!(t.text.unwrap().contains("深蹲"));

        // 不带 modal：只回清单
        let list = read(&conn, &root, doc_id, None).unwrap();
        assert_eq!(list.modalities.len(), 1);
        assert_eq!(list.modalities[0].modal, MODAL_TEXT);
    }

    #[test]
    fn read_returns_uploaded_body_within_cap_and_flags_oversize() {
        let conn = db();
        let root = temp_root("cap");
        let small = write_media(
            &conn,
            &root,
            &KbMediaInput {
                path: "未分类数据/小音频.wav".into(),
                name: Some("小音频.wav".into()),
                mime: "audio/wav".into(),
                data_base64: b64().encode(b"RIFF....WAVE"),
                text: None,
            },
        )
        .unwrap();
        index::apply_one(&conn, "note", &small.to_string()).unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type='note' AND source_id=?1",
                [small.to_string()],
                |r| r.get(0),
            )
            .unwrap();

        let m = read(&conn, &root, doc_id, Some(MODAL_AUDIO)).unwrap();
        assert!(!m.degraded);
        assert!(m.data_url.unwrap().starts_with("data:audio/wav;base64,"));
        assert!(!m.too_large);
        // 未转写要有提示，但不阻塞本体读取
        assert!(m.hint.unwrap().contains("转写"));

        // 超过内联上限：只给元信息
        let big_ref = "workspace/media/big.wav";
        std::fs::create_dir_all(root.join("workspace/media")).unwrap();
        std::fs::write(root.join(big_ref), vec![0u8; (DATA_URL_CAP + 16) as usize]).unwrap();
        add(
            &conn,
            small,
            &NewAsset::fs(MODAL_AUDIO, "audio/wav", big_ref, DATA_URL_CAP + 16),
        )
        .unwrap();
        let m2 = read(&conn, &root, doc_id, Some(MODAL_AUDIO)).unwrap();
        assert!(m2.too_large, "超限的本体不得内联进响应");
        assert!(m2.data_url.is_none());
    }

    #[test]
    fn voice_memo_audio_is_readable_as_fs_asset() {
        let conn = db();
        let root = temp_root("voice");
        std::fs::create_dir_all(root.join("voice")).unwrap();
        std::fs::write(root.join("voice/a.wav"), b"RIFF").unwrap();
        conn.execute(
            "INSERT INTO voice_memos(id, chat_id, title, audio_path, duration_ms, sentences, summary, created_at)
             VALUES ('m1','c1','晨会','voice/a.wav',32000,'[{\"text\":\"早上好\"}]','[]','2026-09-19T08:00:00Z')",
            [],
        )
        .unwrap();
        index::apply_one(&conn, "voice_memo", "m1").unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type='voice_memo' AND source_id='m1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let m = read(&conn, &root, doc_id, Some(MODAL_AUDIO)).unwrap();
        assert!(!m.degraded, "语音纪要的音频本体应可直接取");
        assert_eq!(m.mime.as_deref(), Some("audio/wav"));
        assert!(m.data_url.unwrap().starts_with("data:audio/wav;base64,"));
    }

    #[test]
    fn todo_attachment_image_can_be_read_without_leaking_into_text() {
        let conn = db();
        let root = temp_root("attach");
        let img = format!("data:image/jpeg;base64,{}", b64().encode(b"jpegbytes"));
        conn.execute(
            "INSERT INTO todos(id, title, date, category, priority, status, created_at, subtasks, attachments)
             VALUES (1,'拍膝盖','2026-09-19','general',0,'todo','2026-09-19','[]',?1)",
            [format!(r#"[{{"kind":"image","name":"膝盖.jpg","content":"{img}","size":9}}]"#)],
        )
        .unwrap();
        index::apply_one(&conn, "todo_attachment", "1:0").unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM kb_docs WHERE source_type='todo_attachment' AND source_id='1:0'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        let m = read(&conn, &root, doc_id, Some(MODAL_IMAGE)).unwrap();
        assert!(!m.degraded);
        assert!(m.data_url.unwrap().starts_with("data:image/jpeg;base64,"));

        // 降级路径：要音频 → 文本（编目描述行）
        let d = read(&conn, &root, doc_id, Some(MODAL_AUDIO)).unwrap();
        assert!(d.degraded);
        assert!(d.text.unwrap().contains("膝盖.jpg"));
    }

    #[test]
    fn deleting_node_cascades_assets_and_reports_fs_refs() {
        let conn = db();
        let root = temp_root("delete");
        let id = write_media(
            &conn,
            &root,
            &KbMediaInput {
                path: "未分类数据/a.png".into(),
                name: Some("a.png".into()),
                mime: "image/png".into(),
                data_base64: b64().encode(b"png"),
                text: None,
            },
        )
        .unwrap();
        let refs = fs_refs(&conn, id).unwrap();
        assert_eq!(refs.len(), 1);

        files::delete(&conn, id).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM kb_assets WHERE file_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "删除节点必须级联清掉模态行");
    }
}
