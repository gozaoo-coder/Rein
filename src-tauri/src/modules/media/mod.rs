//! HEIF/HEIC 解码域：无数据库、无模型。
//!
//! WebView（Chromium 家族）没有 HEVC 解码器，iPhone 拍出来的 HEIC/HEIF 在这里
//! 借用**系统**解码器转成 JPEG，再回给前端走它既有的「压缩 → 发模型 / 展示」链路。
//! 前端只在**嗅探到 HEIF 容器**时才来敲这个门（见 `src/utils/image.ts`），
//! 失败会降级到内置解码器，所以这里每条失败路径只要说清「为什么解不了」就够了。
//!
//! 平台实现两处：
//! - `android.rs`：经 `with_webview` → `jni_handle().exec` 直接调框架类
//!   `android.graphics.BitmapFactory`（API 28 起原生支持 HEIF）。
//! - `wic.rs`：Windows 影像组件（WIC）解码 + JPEG 编码，要求系统装了 HEIF 解码器
//!   （Microsoft Store 的「HEIF 图片扩展」，Win10/11 多数机器已带）。
//!
//! 契约见前端 `services/mediaService.ts`。

pub mod commands;

#[cfg(target_os = "android")]
pub(crate) mod android;
#[cfg(target_os = "windows")]
pub(crate) mod wic;

use crate::error::{ReinError, Result};

/// 平台不可用/无法解码的机器可读判据（前端只看 `code`，不解析文案）。
/// Android 这条支路不会用到它（那边没有「平台不支持」这回事，只会失败），放行。
#[allow(dead_code)]
pub(crate) const CODE_UNSUPPORTED: &str = "heif_unsupported";

/// HEIF → JPEG：分派到平台实现，返回 `(jpeg 字节, 宽, 高)`。
#[allow(unused_variables)]
pub(crate) fn decode_platform(
    webview: &tauri::Webview<tauri::Wry>,
    bytes: &[u8],
    max_edge: u32,
    quality: u32,
) -> Result<(Vec<u8>, u32, u32)> {
    #[cfg(target_os = "android")]
    {
        android::decode(webview, bytes, max_edge, quality).map_err(ReinError::Message)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = webview;
        wic::decode(bytes, max_edge, quality).map_err(|e| ReinError::coded(CODE_UNSUPPORTED, e))
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    {
        Err(ReinError::coded(
            CODE_UNSUPPORTED,
            "当前平台没有可用的原生 HEIF 解码支持",
        ))
    }
}
