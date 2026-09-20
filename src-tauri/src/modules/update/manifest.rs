//! 清单解析与候选挑选。
//!
//! 认两种形态（与 tauri-plugin-updater 的 RemoteRelease 对齐）：
//!   · static：`{ version, notes, pub_date, platforms: { "windows-x86_64": { url, signature, … } } }`
//!     —— Rein 在线服务与 GitHub Release 都发这个
//!   · dynamic：`{ version, url, signature }` —— 单平台动态接口
//!
//! 平台键找不到时，还会再试一次「带安装器后缀」的键（`windows-x86_64-nsis`），
//! 因为那是官方客户端的第一顺位，第三方若按官方规范发布，我们也得能认。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::Candidate;
use crate::error::{ReinError, Result};

/// 一个平台条目。未知字段忽略，所以服务端加扩展字段不会把老客户端打挂。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlatformEntry {
    pub url: String,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// 低于此版本不允许用这条更新（服务端预留，客户端只做提示）
    #[serde(default, alias = "minVersion", alias = "min_version")]
    pub min_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<serde_json::Value>,
    #[serde(default, rename = "pub_date", alias = "pubDate")]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub mandatory: Option<bool>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformEntry>,
    /// dynamic 形态的单平台字段
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

impl Manifest {
    pub fn notes_text(&self) -> Option<String> {
        match &self.notes {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Null) | None => None,
            Some(other) => Some(other.to_string()),
        }
    }

    /// 取当前平台的条目：先试裸键，再试带安装器后缀的键。
    pub fn entry_for(&self, target: &str) -> Option<PlatformEntry> {
        if let Some(e) = self.platforms.get(target) {
            return Some(e.clone());
        }
        let suffix = if cfg!(target_os = "windows") {
            "nsis"
        } else if cfg!(target_os = "android") {
            "apk"
        } else if cfg!(target_os = "macos") {
            "app"
        } else {
            "appimage"
        };
        self.platforms.get(&format!("{target}-{suffix}")).cloned()
    }

    /// 归一化成候选（dynamic 形态在这里折成 static 的一条）。
    ///
    /// `target` 只用于查表，不再存进候选：它是个全局常量（`platform_key()`），
    /// 放进候选只会多一份可能过期的副本。
    pub fn to_candidate(&self, target: &str, source_id: &str, source_name: &str) -> Result<Candidate> {
        let entry = self.entry_for(target).or_else(|| {
            // dynamic 形态：整份清单就是一个平台
            self.url.as_ref().map(|url| PlatformEntry {
                url: url.clone(),
                signature: self.signature.clone(),
                sha256: self.sha256.clone(),
                size: self.size,
                mirrors: Vec::new(),
                name: None,
                min_version: None,
            })
        });

        let entry = entry.ok_or_else(|| {
            ReinError::Message(format!("清单里没有 {target} 的安装包条目"))
        })?;

        let signature = entry
            .signature
            .clone()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| ReinError::Message("清单条目缺少签名，客户端拒绝安装".into()))?;

        let name = entry
            .name
            .clone()
            .or_else(|| {
                entry
                    .url
                    .split('?')
                    .next()
                    .and_then(|u| u.rsplit('/').next())
                    .map(|s| s.to_string())
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Rein-{}-{target}", self.version));

        Ok(Candidate {
            version: self.version.clone(),
            url: sanitize_url(&entry.url)?,
            mirrors: entry
                .mirrors
                .iter()
                .filter_map(|m| sanitize_url(m).ok())
                .collect(),
            signature,
            sha256: entry.sha256.clone(),
            size: entry.size,
            name: sanitize_file_name(&name),
            source_id: source_id.to_string(),
            source_name: source_name.to_string(),
        })
    }
}

fn sanitize_url(raw: &str) -> Result<String> {
    let parsed = url::Url::parse(raw).map_err(|_| ReinError::Message(format!("清单里的地址非法：{raw}")))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ReinError::Message(format!("清单里的地址协议不支持：{scheme}")));
    }
    Ok(parsed.to_string())
}

/// 文件名收敛：只留 basename，去掉任何路径分隔与控制字符（清单来自网络）。
pub fn sanitize_file_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>();
    if base.is_empty() || base == "." || base == ".." || base.starts_with('.') {
        "rein-update.bin".to_string()
    } else {
        base
    }
}

/// 版本比较：能按语义化版本比就按语义化，比不了退回字符串比较（绝不 panic）。
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = semver::Version::parse(a.trim_start_matches('v'));
    let pb = semver::Version::parse(b.trim_start_matches('v'));
    match (pa, pb) {
        (Ok(va), Ok(vb)) => va.cmp(&vb),
        _ => a.trim_start_matches('v').cmp(b.trim_start_matches('v')),
    }
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) == std::cmp::Ordering::Greater
}

#[cfg(test)]
mod tests {
    use super::*;

    fn static_manifest() -> Manifest {
        serde_json::from_str(
            r#"{
              "version": "0.2.1",
              "notes": "修了几个 bug",
              "pub_date": "2026-09-19T10:00:00Z",
              "channel": "stable",
              "platforms": {
                "windows-x86_64": {
                  "url": "https://example.com/Rein_0.2.1_x64-setup.exe",
                  "signature": "sig-payload",
                  "sha256": "abc123",
                  "size": 12345,
                  "mirrors": ["https://mirror.example.com/Rein_0.2.1_x64-setup.exe"]
                },
                "android-aarch64": {
                  "url": "https://example.com/Rein-0.2.1-arm64.apk",
                  "signature": "sig-payload-2",
                  "name": "Rein-0.2.1-arm64.apk"
                }
              }
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn parses_static_manifest_and_notes() {
        let m = static_manifest();
        assert_eq!(m.version, "0.2.1");
        assert_eq!(m.notes_text().as_deref(), Some("修了几个 bug"));
        assert_eq!(m.channel.as_deref(), Some("stable"));
    }

    #[test]
    fn builds_candidate_with_sha_and_mirrors() {
        let m = static_manifest();
        let c = m.to_candidate("windows-x86_64", "rein-service", "Rein 在线服务").unwrap();
        assert_eq!(c.version, "0.2.1");
        assert_eq!(c.sha256.as_deref(), Some("abc123"));
        assert_eq!(c.size, Some(12345));
        assert_eq!(c.mirrors.len(), 1);
        assert_eq!(c.name, "Rein_0.2.1_x64-setup.exe");
        assert_eq!(c.source_name, "Rein 在线服务");
    }

    #[test]
    fn derives_name_from_url_when_missing() {
        let m = static_manifest();
        let c = m.to_candidate("android-aarch64", "g", "github").unwrap();
        assert_eq!(c.name, "Rein-0.2.1-arm64.apk");
    }

    #[test]
    fn missing_platform_is_an_error_not_a_silent_pass() {
        let m = static_manifest();
        let err = m.to_candidate("linux-x86_64", "g", "github").unwrap_err();
        assert!(err.to_string().contains("linux-x86_64"));
    }

    #[test]
    fn entry_without_signature_is_rejected() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"1.0.0","platforms":{"windows-x86_64":{"url":"https://e.com/a.exe"}}}"#,
        )
        .unwrap();
        let err = m.to_candidate("windows-x86_64", "g", "github").unwrap_err();
        assert!(err.to_string().contains("签名"), "错误应点明缺签名：{err}");
    }

    #[test]
    fn dynamic_manifest_shape_is_supported() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"2.0.0","url":"https://e.com/a.apk","signature":"s","sha256":"d","size":9}"#,
        )
        .unwrap();
        let c = m.to_candidate("android-aarch64", "x", "y").unwrap();
        assert_eq!(c.url, "https://e.com/a.apk");
        assert_eq!(c.version, "2.0.0");
    }

    #[test]
    fn installer_suffixed_target_key_is_accepted() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"1.0.0","platforms":{"windows-x86_64-nsis":{"url":"https://e.com/a.exe","signature":"s"}}}"#,
        )
        .unwrap();
        // 只有在当前平台是 windows 时才会命中带后缀的键
        let hit = m.entry_for("windows-x86_64").is_some();
        assert_eq!(hit, cfg!(target_os = "windows"));
    }

    #[test]
    fn version_compare_handles_prefix_and_ordering() {
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(is_newer("v0.3.0", "0.2.9"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        // 语义化版本能比较预发布：1.0.0-rc.1 < 1.0.0
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
    }

    #[test]
    fn file_name_sanitizer_strips_paths_and_control_chars() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("ok-name_1.2.3.apk"), "ok-name_1.2.3.apk");
        assert_eq!(sanitize_file_name("...."), "rein-update.bin");
        assert_eq!(sanitize_file_name(""), "rein-update.bin");
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"1.0.0","platforms":{"windows-x86_64":{"url":"file:///C:/evil.exe","signature":"s"}}}"#,
        )
        .unwrap();
        assert!(m.to_candidate("windows-x86_64", "x", "y").is_err());
    }
}
