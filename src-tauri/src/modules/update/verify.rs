//! 更新链路的信任根：Ed25519(minisign) 验签 + sha256 摘要。
//!
//! 用 `minisign-verify` 而不是自己接 ed25519 库：这正是 tauri-plugin-updater
//! 内部用的那个 crate，验签行为与官方客户端逐字节一致 —— 发布侧用的是官方 CLI
//! 的签名实现，两边对上才不会出现「本地能验、发布出去装不上」。
//!
//! 签名字段的格式有两代，必须都认：
//!   · 老 tauri CLI：`.sig` 文件是 minisign 明文（untrusted comment / payload / trusted comment）
//!   · 新 tauri CLI：`.sig` 文件是 base64(上面那份明文)
//! 清单里的 `signature` 字段两种都可能出现（取决于发布时用的 CLI 版本），
//! 所以这里先按明文解，失败再 base64 解一层。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use base64::engine::general_purpose::{
    GeneralPurpose, STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD,
};
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

use crate::error::{ReinError, Result};

/// base64 解码的宽松版：发布侧可能带或不带 padding，也可能是 url-safe 表。
/// （`Engine` 不是 dyn 兼容的，所以这里用具体类型 `GeneralPurpose` 逐个试。）
fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let cleaned: String = text.split_whitespace().collect();
    if cleaned.is_empty() {
        return None;
    }
    let engines: [GeneralPurpose; 4] = [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD];
    for engine in engines {
        if let Ok(bytes) = engine.decode(cleaned.as_bytes()) {
            return Some(bytes);
        }
    }
    None
}

/// 解析 tauri/minisign 公钥（`tauri.conf.json > plugins.updater.pubkey` 的格式：base64(公钥文件全文)）。
pub fn decode_public_key(pubkey: &str) -> Result<PublicKey> {
    let raw = b64_decode(pubkey)
        .ok_or_else(|| ReinError::Message("更新公钥不是合法 base64".into()))?;
    let text = String::from_utf8(raw)
        .map_err(|_| ReinError::Message("更新公钥解出来不是文本".into()))?;
    PublicKey::decode(&text).map_err(|e| ReinError::Message(format!("更新公钥格式错误：{e}")))
}

/// 解析签名（两种代际都吃，见模块头注释）。
pub fn decode_signature(field: &str) -> Result<Signature> {
    if let Ok(sig) = Signature::decode(field) {
        return Ok(sig);
    }
    let raw = b64_decode(field)
        .ok_or_else(|| ReinError::Message("更新签名不是合法 base64".into()))?;
    let text = String::from_utf8(raw)
        .map_err(|_| ReinError::Message("更新签名解出来不是文本".into()))?;
    Signature::decode(&text).map_err(|e| ReinError::Message(format!("更新签名格式错误：{e}")))
}

/// 校验一段字节。`allow_legacy = true` 与官方实现保持一致（兼容老的纯 Ed 模式）。
pub fn verify_bytes(data: &[u8], signature_field: &str, pubkey: &str) -> Result<()> {
    let key = decode_public_key(pubkey)?;
    let sig = decode_signature(signature_field)?;
    key.verify(data, &sig, true)
        .map_err(|e| ReinError::Message(format!("安装包签名校验失败：{e}")))
}

/// 流式 sha256（大文件不进内存）。
pub fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

/// 完整校验：大小 → sha256 → 签名。任何一步不过都不返回 Ok。
///
/// 三道检查是有层次的：大小能挡住截断的下载，sha256 能挡住内容被换，
/// 而签名才是**可信**的那一道 —— 前两者都写在清单里，清单本身可被中间人改写。
pub fn verify_artifact(
    path: &Path,
    expected_sha256: Option<&str>,
    expected_size: Option<u64>,
    signature: &str,
    pubkey: &str,
) -> Result<u64> {
    let (sha256, size) = sha256_file(path)?;

    if let Some(want) = expected_size {
        if want != 0 && want != size {
            return Err(ReinError::Message(format!(
                "安装包大小不符：清单声明 {want} 字节，实际 {size} 字节"
            )));
        }
    }
    if let Some(want) = expected_sha256 {
        if !want.eq_ignore_ascii_case(&sha256) {
            // 只取前 16 个字符提示，且按字符切（清单里的值来自网络，不能假设它是 ASCII）
            let head: String = want.chars().take(16).collect();
            return Err(ReinError::Message(format!(
                "安装包摘要不符：清单声明 {head}…，实际 {sha256}"
            )));
        }
    }

    // Ed25519 是「整段消息」签名（官方 CLI 走预哈希 ED 模式，但 API 仍要完整字节），
    // 所以这里把文件读进内存。上限在调用侧拦过（512MB），不会无限吃内存。
    let data = std::fs::read(path)?;
    verify_bytes(&data, signature, pubkey)?;

    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::update::keys::UPDATE_PUBKEY;

    /// 真机夹具：用 `tauri signer sign`（官方 CLI，新格式：.sig 文件为 base64 明文）
    /// 对固定消息签出的签名。它是跨实现互操作的回归锚点 ——
    /// 一旦哪天换库或改解析，这条测试会先炸，而不是等用户装不上更新才发现。
    const FIXTURE_MESSAGE: &[u8] = b"rein-update-verify-fixture-v1\n";
    const FIXTURE_SIGNATURE: &str = include_str!("fixtures/signature.txt");

    #[test]
    fn public_key_decodes() {
        let key = decode_public_key(UPDATE_PUBKEY).expect("内置公钥应能解析");
        // 解析成功即为「格式与官方一致」，keyId 由 minisign 内部持有，不额外断言
        let _ = format!("{key:?}");
    }

    #[test]
    fn official_cli_signature_verifies() {
        verify_bytes(FIXTURE_MESSAGE, FIXTURE_SIGNATURE.trim(), UPDATE_PUBKEY)
            .expect("官方 CLI 的签名必须验得过（否则真机更新会全线失败）");
    }

    #[test]
    fn tampered_message_is_rejected() {
        let mut bad = FIXTURE_MESSAGE.to_vec();
        bad[0] ^= 0xff;
        assert!(verify_bytes(&bad, FIXTURE_SIGNATURE.trim(), UPDATE_PUBKEY).is_err());
    }

    #[test]
    fn garbage_signature_is_rejected_without_panic() {
        assert!(verify_bytes(FIXTURE_MESSAGE, "not-a-signature", UPDATE_PUBKEY).is_err());
        assert!(verify_bytes(FIXTURE_MESSAGE, "", UPDATE_PUBKEY).is_err());
    }

    #[test]
    fn base64_wrapped_signature_also_verifies() {
        // 老格式（明文）与新格式（base64 明文）都要认
        let decoded = b64_decode(FIXTURE_SIGNATURE.trim()).expect("夹具本身应是 base64(明文)");
        let plain = String::from_utf8(decoded).expect("解出来应是文本");
        verify_bytes(FIXTURE_MESSAGE, &plain, UPDATE_PUBKEY).expect("明文形态的签名也要能验");
    }
}
