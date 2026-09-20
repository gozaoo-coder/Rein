//! 安装包下载：断点续传 + 镜像回落 + 边下边校验。
//!
//! 三件事都围绕一个前提：**下载可能失败很多次**。国内直连 GitHub 的失败率高，
//! 手机端还会在切后台时被掐断 —— 所以「断了能接着下」不是优化，是这个功能能不能用的分水岭。
//!
//! 校验顺序（与 verify.rs 的分层一致）：大小 → sha256 → Ed25519 签名。
//! 只有全过了才把 `.part` 改名成正式文件；任何一步失败都会删掉半成品，
//! 免得留下一个「看起来下好了、装上去是坏的」文件。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::verify::{sha256_file, verify_artifact};
use super::{Candidate, Phase, UpdateHub, PROGRESS_EVENT};
use crate::error::{ReinError, Result};

const CHUNK: usize = 64 * 1024;
/// 进度事件节流：太快会把 WebView 的 IPC 打满，反而让界面卡顿
const EMIT_INTERVAL: Duration = Duration::from_millis(180);
const USER_AGENT: &str = concat!("Rein-Updater/", env!("CARGO_PKG_VERSION"));

fn client() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(90))
        .redirects(10)
        .user_agent(USER_AGENT)
        .build()
}

/// 下载并校验到可信为止：主地址失败换镜像，镜像全挂才报错。
pub fn fetch_verified(
    app: &AppHandle,
    hub: &UpdateHub,
    candidate: &Candidate,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let final_path = dir.join(&candidate.name);
    let part_path = dir.join(format!("{}.part", candidate.name));

    let mut urls: Vec<String> = vec![candidate.url.clone()];
    for m in &candidate.mirrors {
        if !urls.contains(m) {
            urls.push(m.clone());
        }
    }

    let mut failures: Vec<String> = Vec::new();
    for (attempt, url) in urls.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled_error());
        }
        if attempt > 0 {
            let state = hub.update_state(|s| {
                s.phase = Phase::Preparing;
                s.error = Some(format!("主源不可用，改用镜像：{url}"));
            });
            let _ = app.emit(PROGRESS_EVENT, &state);
        }

        match fetch_one(app, hub, candidate, url, &part_path, &cancel) {
            Ok(size) => {
                let state = hub.update_state(|s| {
                    s.phase = Phase::Verifying;
                    s.received = size;
                    s.total = size;
                    s.percent = 100.0;
                    s.error = None;
                });
                let _ = app.emit(PROGRESS_EVENT, &state);

                match verify_artifact(
                    &part_path,
                    candidate.sha256.as_deref(),
                    candidate.size,
                    &candidate.signature,
                    super::keys::UPDATE_PUBKEY,
                ) {
                    Ok(_) => {
                        // 校验通过才改名：正式文件名存在 == 这个包是可信的
                        if final_path.exists() {
                            let _ = fs::remove_file(&final_path);
                        }
                        fs::rename(&part_path, &final_path)?;
                        return Ok(final_path);
                    }
                    Err(e) => {
                        let _ = fs::remove_file(&part_path);
                        failures.push(format!("{url} → 校验失败：{e}"));
                        continue;
                    }
                }
            }
            Err(e) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(cancelled_error());
                }
                failures.push(format!("{url} → {e}"));
            }
        }
    }

    Err(ReinError::Message(format!(
        "所有下载地址都失败了：\n{}",
        failures.join("\n")
    )))
}

fn cancelled_error() -> ReinError {
    ReinError::Message("已取消下载".into())
}

/// 单地址下载（含断点续传）。返回落盘的字节数（不含已存在的部分）。
///
/// `candidate` 目前只在 416 递归重试时透传（续传位置已作废、重新整包下载时
/// 签名/摘要等元数据不能丢）；递归深度固定为 1，不会因透传而无限下钻。
#[allow(clippy::only_used_in_recursion)]
fn fetch_one(
    app: &AppHandle,
    hub: &UpdateHub,
    candidate: &Candidate,
    url: &str,
    part_path: &Path,
    cancel: &AtomicBool,
) -> Result<u64> {
    let existing = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);

    let mut request = client().get(url).set("Accept", "application/octet-stream");
    if existing > 0 {
        request = request.set("Range", &format!("bytes={existing}-"));
    }
    let response = match request.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) if code == 416 && existing > 0 => {
            // 服务端认为范围越界：说明本地那份已经是完整的（或超过总长），从头来
            let _ = fs::remove_file(part_path);
            return fetch_one(app, hub, candidate, url, part_path, cancel);
        }
        Err(e) => return Err(ReinError::Message(format!("请求失败：{e}"))),
    };

    let status = response.status();
    let resumed = status == 206 && existing > 0;
    let (mut received, total) = if resumed {
        let total = response
            .header("content-range")
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0);
        (existing, total)
    } else {
        let total = response
            .header("content-length")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        // 服务端不认 Range（回了 200）：本地那份作废，从头写
        (0, total)
    };

    if total > super::MAX_ARTIFACT_BYTES {
        return Err(ReinError::Message(format!(
            "安装包超出上限（{} 字节）",
            super::MAX_ARTIFACT_BYTES
        )));
    }

    let mut file = if resumed {
        fs::OpenOptions::new().append(true).open(part_path)?
    } else {
        fs::File::create(part_path)?
    };

    hub.update_state(|s| {
        s.phase = Phase::Downloading;
        s.received = received;
        s.total = total;
        s.percent = if total > 0 { received as f64 / total as f64 * 100.0 } else { 0.0 };
    });

    let mut reader = response.into_reader();
    let mut buf = vec![0u8; CHUNK];
    let mut last_emit = Instant::now();
    let mut last_bytes = received;
    let mut last_instant = Instant::now();

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled_error());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        received += n as u64;

        if last_emit.elapsed() >= EMIT_INTERVAL {
            let elapsed = last_instant.elapsed().as_secs_f64().max(0.001);
            let speed = ((received - last_bytes) as f64 / elapsed) as u64;
            last_emit = Instant::now();
            last_bytes = received;
            last_instant = Instant::now();
            let state = hub.update_state(|s| {
                s.phase = Phase::Downloading;
                s.received = received;
                s.total = total;
                s.percent = if total > 0 {
                    (received as f64 / total as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };
                s.bytes_per_sec = speed;
            });
            let _ = app.emit(PROGRESS_EVENT, &state);
        }
    }

    file.flush()?;
    drop(file);

    let state = hub.update_state(|s| {
        s.received = received;
        s.total = if total > 0 { total } else { received };
        s.percent = 100.0;
    });
    let _ = app.emit(PROGRESS_EVENT, &state);

    if total > 0 && received < total {
        return Err(ReinError::Message(format!(
            "下载不完整：{received}/{total} 字节（已保留，可继续续传）"
        )));
    }

    Ok(received)
}

/// 清理某候选留下的半成品与正式文件（用户选择「丢弃重下」时用）。
pub fn purge(dir: &Path, candidate: &Candidate) {
    let _ = fs::remove_file(dir.join(&candidate.name));
    let _ = fs::remove_file(dir.join(format!("{}.part", candidate.name)));
}

/// 已经落盘且校验通过的文件（用于恢复「上次下载好了但没装」的场景）。
pub fn existing_verified(dir: &Path, candidate: &Candidate) -> Option<PathBuf> {
    let path = dir.join(&candidate.name);
    if !path.exists() {
        return None;
    }
    let (sha, _) = sha256_file(&path).ok()?;
    if let Some(want) = &candidate.sha256 {
        if !want.eq_ignore_ascii_case(&sha) {
            return None;
        }
    }
    verify_artifact(
        &path,
        candidate.sha256.as_deref(),
        candidate.size,
        &candidate.signature,
        super::keys::UPDATE_PUBKEY,
    )
    .ok()?;
    Some(path)
}

/// 校验一个已存在的文件（安装前复核用，避免与下载竞争同一文件）。
pub fn verify_existing(path: &Path, candidate: &Candidate) -> Result<()> {
    verify_artifact(
        path,
        candidate.sha256.as_deref(),
        candidate.size,
        &candidate.signature,
        super::keys::UPDATE_PUBKEY,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::update::manifest::sanitize_file_name;

    fn candidate(name: &str) -> Candidate {
        Candidate {
            version: "1.0.0".into(),
            url: "https://example.com/a.exe".into(),
            mirrors: vec![],
            signature: "s".into(),
            sha256: None,
            size: None,
            name: sanitize_file_name(name),
            source_id: "t".into(),
            source_name: "t".into(),
        }
    }

    #[test]
    fn purge_removes_both_states() {
        let dir = std::env::temp_dir().join("rein-update-test-purge");
        fs::create_dir_all(&dir).unwrap();
        let c = candidate("x.bin");
        fs::write(dir.join("x.bin"), b"full").unwrap();
        fs::write(dir.join("x.bin.part"), b"part").unwrap();
        purge(&dir, &c);
        assert!(!dir.join("x.bin").exists());
        assert!(!dir.join("x.bin.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_verified_rejects_file_with_wrong_digest() {
        let dir = std::env::temp_dir().join("rein-update-test-verify");
        fs::create_dir_all(&dir).unwrap();
        let mut c = candidate("y.bin");
        fs::write(dir.join("y.bin"), b"content").unwrap();
        // 摘要对不上：绝不能把磁盘上的东西当成可信包
        c.sha256 = Some("00".repeat(32));
        assert!(existing_verified(&dir, &c).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_verified_returns_none_when_absent() {
        let dir = std::env::temp_dir().join("rein-update-test-absent");
        assert!(existing_verified(&dir, &candidate("z.bin")).is_none());
    }
}
