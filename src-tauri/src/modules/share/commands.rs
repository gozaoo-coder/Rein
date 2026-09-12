//! 分享收件箱域：接收 Android 系统分享/打开的文件，供 AI 聊天消费。
//!
//! 数据流：外部应用「分享/打开方式」→ `ShareReceiver.kt` 把内容拷入
//! `cacheDir/share_inbox/<ts>_<name>`（并 evaluateJavascript 通知前端）→
//! 前端 `share_poll` 列出、`share_read` 取走（读后即删）。桌面端无收件箱，
//! poll 恒返回空，命令契约两端一致。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use tauri::Manager;

use crate::error::{ReinError, Result};

const INBOX_DIR: &str = "share_inbox";
/// 单文件上限（20MB，与前端文档解析上限一致）
const MAX_FILE: u64 = 20 * 1024 * 1024;
/// 收件箱文件保留期：超过 7 天的残留（前端取走失败遗留）在 poll 时清理
const KEEP_DAYS: u64 = 7;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFileMeta {
    /// inbox 内的原始文件名（`<ts>_<name>`，share_read 的入参）
    pub file: String,
    /// 剥离时间戳前缀后的展示名
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFileData {
    pub name: String,
    pub mime: String,
    /// 文件内容（base64，无 data: 前缀）
    pub data_base64: String,
}

/// 扩展名 → MIME（覆盖分享接入的格式面：图片 / 文本 / Office）
fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "doc" | "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" | "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" | "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn inbox_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| ReinError::Message(format!("无法定位缓存目录：{e}")))?
        .join(INBOX_DIR);
    Ok(dir)
}

/// 剥离 `<ts>_` 前缀得到展示名
fn display_name(raw: &str) -> String {
    match raw.split_once('_') {
        Some((ts, rest)) if ts.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() => {
            rest.to_string()
        }
        _ => raw.to_string(),
    }
}

/// 列出收件箱（按时间倒序），顺手清理超期残留
#[tauri::command]
pub async fn share_poll(app: tauri::AppHandle) -> Result<Vec<SharedFileMeta>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = inbox_dir(&app)?;
        let Ok(entries) = fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut files: Vec<(SystemTime, SharedFileMeta)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                // 超期残留：静默清理，不再出现在列表中
                if let Ok(modified) = meta.modified() {
                    let age = now.saturating_sub(
                        modified
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    );
                    if age > KEEP_DAYS * 86_400 {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                }
                let file = entry.file_name().to_string_lossy().to_string();
                let name = display_name(&file);
                let mime = mime_of(&name);
                files.push((
                    meta.modified().unwrap_or(UNIX_EPOCH),
                    SharedFileMeta {
                        file,
                        name,
                        mime,
                        size: meta.len(),
                    },
                ));
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(files.into_iter().map(|(_, m)| m).collect())
    })
    .await
    .map_err(|e| ReinError::Message(format!("分享收件箱任务失败：{e}")))?
}

/// 读取并删除一个收件箱文件（一次性消费；前端拿到数据即完成接手）
#[tauri::command]
pub async fn share_read(app: tauri::AppHandle, file: String) -> Result<SharedFileData> {
    tauri::async_runtime::spawn_blocking(move || {
        // 防路径穿越：只允许纯文件名（无分隔符、无 ..）
        if file.contains('/') || file.contains('\\') || file.contains("..") {
            return Err(ReinError::Message("非法的收件箱文件名".into()));
        }
        let dir = inbox_dir(&app)?;
        let path = dir.join(&file);
        let meta = fs::metadata(&path).map_err(|_| ReinError::Message("分享文件不存在或已被读取".into()))?;
        if meta.len() > MAX_FILE {
            let _ = fs::remove_file(&path);
            return Err(ReinError::Message(format!(
                "分享文件过大（{}MB），上限 20MB",
                meta.len() / 1024 / 1024
            )));
        }
        let bytes = fs::read(&path)
            .map_err(|e| ReinError::Message(format!("分享文件读取失败：{e}")))?;
        let _ = fs::remove_file(&path);
        let name = display_name(&file);
        let mime = mime_of(&name);
        Ok(SharedFileData {
            name,
            mime,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })
    })
    .await
    .map_err(|e| ReinError::Message(format!("分享收件箱任务失败：{e}")))?
}
