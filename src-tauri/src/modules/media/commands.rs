//! HEIF/HEIC → JPEG 命令。
//!
//! 只在前端嗅探出 HEIF 容器时被调用（普通 JPEG/PNG/WebP 由 WebView 自己解，
//! 没必要多绕一次 IPC）。失败时前端会降级到内置解码器，故这里的错误文案要能
//! 说清「哪一步解不了」，便于定位是文件本身还是平台缺解码器。

use base64::Engine;
use serde::Serialize;

use crate::error::{ReinError, Result};

/// 转码结果。`jpegBase64` 不带 `data:` 前缀，宽高是缩放后的实际像素。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeifDecodeResult {
    pub jpeg_base64: String,
    pub width: u32,
    pub height: u32,
}

/// 把 HEIF/HEIC 原理解成 JPEG。
/// - `maxEdge`：最长边上限（等比缩小，小于该值不放大）
/// - `quality`：JPEG 质量 0–100
#[tauri::command]
pub fn image_decode_heif(
    webview: tauri::Webview<tauri::Wry>,
    data_base64: String,
    max_edge: u32,
    quality: u32,
) -> Result<HeifDecodeResult> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine
        .decode(data_base64.trim())
        .map_err(|e| ReinError::Message(format!("图片数据不是合法 base64：{e}")))?;
    let max_edge = max_edge.clamp(16, 8192);
    let quality = quality.clamp(30, 100);
    let (jpeg, width, height) = super::decode_platform(&webview, &bytes, max_edge, quality)?;
    Ok(HeifDecodeResult {
        jpeg_base64: engine.encode(&jpeg),
        width,
        height,
    })
}
