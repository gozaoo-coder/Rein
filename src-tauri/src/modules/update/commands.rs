//! 更新域的 Tauri 命令 · 前端契约见 `src/services/updateService.ts`。
//!
//! 三条纪律（与 campus 域同款）：
//! 1. **慢网络不持锁**：所有联网都在 `spawn_blocking` 里做，读设置与写设置各自短锁进出。
//! 2. **候选只认一份**：检查阶段挑出的候选存进 `UpdateHub`，下载/安装都从它取，
//!    杜绝「检查到 A 版本、下载了 B 地址」这种错配。
//! 3. **安装前再验一次**：下载时验过不等于装的时候还是那个文件（磁盘上的东西可以被换），
//!    所以 `update_install` 会重新算摘要 + 验签，通过才交给安装器。

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::install;
// InstallMode 只在桌面/Windows 分支存在（Android 走系统安装器，没有「静默模式」这回事）
#[cfg(not(target_os = "android"))]
use super::install::InstallMode;
use super::manifest::{self, Manifest};
use super::verify;
use super::{
    install_platform_hint, install_supported, platform_key, Phase, SourceReport, UpdateCheck,
    UpdateHub, UpdateSettings, UpdateSource, PROGRESS_EVENT,
};
use crate::error::{ReinError, Result};
use crate::state::AppState;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const MANIFEST_MAX_BYTES: u64 = 2 * 1024 * 1024;
const USER_AGENT: &str = concat!("Rein/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub current_version: String,
    pub platform: String,
    pub install_supported: bool,
    pub install_hint: String,
    pub settings: UpdateSettings,
    pub check: Option<UpdateCheck>,
    pub download: super::DownloadState,
    /// 已下载且验证通过、随时可安装
    pub ready_to_install: bool,
}

/// 设置的部分更新。
///
/// 关于 `ignored_version`：serde 会把 JSON `null` 当成「未提供」（外层 Option 先吃掉 null），
/// 所以**清除跳过标记要传空字符串** `""`，不能传 null —— 这条约定写在类型上也写在文档里，
/// 免得前端传了 null 却以为清掉了。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub enabled: Option<bool>,
    pub channel: Option<String>,
    pub auto_check: Option<bool>,
    pub check_interval_hours: Option<i64>,
    pub ignored_version: Option<Option<String>>,
    pub allow_http: Option<bool>,
    pub silent_install: Option<bool>,
    pub sources: Option<Vec<UpdateSource>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
    /// Windows 安装器起来后本进程会自行退出，前端据此显示「正在安装并重启」
    pub will_exit: bool,
}

fn settings_of(state: &AppState) -> UpdateSettings {
    let conn = state.db.lock().unwrap();
    super::load_settings(&conn)
}

fn snapshot(app: &AppHandle, state: &AppState, hub: &UpdateHub) -> UpdateSnapshot {
    let settings = settings_of(state);
    UpdateSnapshot {
        current_version: app.package_info().version.to_string(),
        platform: platform_key(),
        install_supported: install_supported(),
        install_hint: install_platform_hint().to_string(),
        settings,
        check: hub.last_check(),
        download: hub.state(),
        ready_to_install: hub.verified_file().is_some(),
    }
}

fn updates_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ReinError::Message(format!("无法定位应用数据目录：{e}")))?
        .join("updates");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 当前状态快照（设置 + 上次检查结果 + 下载进度）。
#[tauri::command]
pub fn update_status(
    app: AppHandle,
    state: State<AppState>,
    hub: State<UpdateHub>,
) -> Result<UpdateSnapshot> {
    Ok(snapshot(&app, &state, &hub))
}

/// 把补丁合进设置。纯函数（不碰数据库、不发网络），因此可以逐条单测 ——
/// 这一段全是校验规则，正是最该被测试钉住的地方。
fn apply_patch(mut settings: UpdateSettings, patch: SettingsPatch) -> Result<UpdateSettings> {
    if let Some(v) = patch.enabled {
        settings.enabled = v;
    }
    if let Some(v) = patch.channel {
        let v = v.trim().to_lowercase();
        if v.is_empty() {
            return Err(ReinError::Message("通道名不能为空".into()));
        }
        settings.channel = v;
    }
    if let Some(v) = patch.auto_check {
        settings.auto_check = v;
    }
    if let Some(v) = patch.check_interval_hours {
        settings.check_interval_hours = v.clamp(1, 24 * 30);
    }
    if let Some(v) = patch.allow_http {
        settings.allow_http = v;
    }
    if let Some(v) = patch.ignored_version {
        settings.ignored_version = v.filter(|s| !s.trim().is_empty());
    }
    if let Some(v) = patch.silent_install {
        settings.silent_install = v;
    }
    if let Some(v) = patch.sources {
        for s in &v {
            let url = s.url.trim();
            if url.is_empty() {
                return Err(ReinError::Message(format!("更新源「{}」地址为空", s.name)));
            }
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err(ReinError::Message(format!(
                    "更新源「{}」必须是 http(s) 地址",
                    s.name
                )));
            }
            if url.starts_with("http://") && !settings.allow_http {
                return Err(ReinError::Message(format!(
                    "更新源「{}」使用明文 http，请先允许 http 源",
                    s.name
                )));
            }
        }
        settings.sources = v;
    }
    Ok(settings)
}

/// 「这条更新还算不算数」的两个派生判断：用户跳过、疑似降级。
///
/// 它们取决于**设置**（ignoredVersion / lastSeenVersion）而不是网络结果，所以每次
/// 设置变化都要拿新设置重算一遍缓存里的检查结果 —— 否则会出现「点了跳过，卡片还在」
/// 这种前后端各说各话的状态。
fn recompute_derived(check: &mut UpdateCheck, settings: &UpdateSettings) {
    check.ignored = matches!(
        (&check.latest_version, &settings.ignored_version),
        (Some(v), Some(i)) if v == i
    );
    check.downgrade_blocked = match (check.latest_version.as_deref(), settings.last_seen_version.as_deref())
    {
        (Some(latest), Some(seen)) => manifest::compare_versions(seen, latest).is_gt(),
        _ => false,
    };
    check.install_supported = install_supported();
    check.install_hint = install_platform_hint().to_string();
}

/// 保存设置（部分字段）。返回保存后的快照，前端不必再拉一次。
#[tauri::command]
pub fn update_settings_set(
    app: AppHandle,
    state: State<AppState>,
    hub: State<UpdateHub>,
    patch: SettingsPatch,
) -> Result<UpdateSnapshot> {
    let settings = apply_patch(settings_of(&state), patch)?;
    {
        let conn = state.db.lock().unwrap();
        super::save_settings(&conn, &settings)?;
    }
    if let Some(mut check) = hub.last_check() {
        recompute_derived(&mut check, &settings);
        hub.set_last_check(check);
    }
    Ok(snapshot(&app, &state, &hub))
}

/// 单源拉取结果。
struct SourceFetch {
    manifest: Manifest,
    manifest_signed: bool,
}

/// 读一段有上限的文本响应（清单不该有几 MB，超了就是异常）。
fn read_limited(reader: impl Read, limit: u64) -> std::result::Result<String, String> {
    let mut out = String::new();
    reader
        .take(limit)
        .read_to_string(&mut out)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    Ok(out)
}

/// 拉一个源的清单（Rein 源顺带验清单签名）。
fn fetch_source(source: &UpdateSource, allow_http: bool) -> std::result::Result<SourceFetch, String> {
    let url = source.url.trim();
    if url.starts_with("http://") && !allow_http {
        return Err("该源使用明文 http，已在设置里关闭 http 源".into());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(CHECK_TIMEOUT)
        .redirects(8)
        .user_agent(USER_AGENT)
        .build();

    let response = agent
        .get(url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("请求失败：{e}"))?;
    let text = read_limited(response.into_reader(), MANIFEST_MAX_BYTES)?;

    // 清单签名：有 `.sig` 就验，验不过直接判这个源不可信。
    // 安装包签名是第二道防线，不是替代品 —— 换了版本号/摘要的清单也该被拦。
    let mut manifest_signed = false;
    if matches!(source.kind, super::SourceKind::Rein) {
        match agent.get(&format!("{url}.sig")).timeout(CHECK_TIMEOUT).call() {
            Ok(resp) => {
                let sig = read_limited(resp.into_reader(), 64 * 1024).unwrap_or_default();
                if !sig.trim().is_empty() {
                    verify::verify_bytes(text.as_bytes(), sig.trim(), super::keys::UPDATE_PUBKEY)
                        .map_err(|e| format!("清单签名校验失败：{e}"))?;
                    manifest_signed = true;
                }
            }
            // 没有伴随签名：只依赖安装包签名（服务端镜像来的版本就是这个形态）
            Err(ureq::Error::Status(404, _)) => {}
            Err(e) => return Err(format!("清单签名拉取失败：{e}")),
        }
    }

    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("清单格式错误：{e}"))?;
    Ok(SourceFetch {
        manifest,
        manifest_signed,
    })
}

struct BestSource {
    candidate: super::Candidate,
    source_name: String,
    notes: Option<String>,
    published_at: Option<String>,
    mandatory: bool,
}

/// 检查更新：多源取清单 → 验清单签名 → 挑出最高且可安装的版本。
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<UpdateCheck> {
    let settings = settings_of(&state);
    let force = force.unwrap_or(false);
    if !settings.enabled && !force {
        return Err(ReinError::Message("更新检查已在设置里关闭".into()));
    }

    let target = platform_key();
    let current = app.package_info().version.to_string();
    let sources = settings.active_sources();
    let allow_http = settings.allow_http;
    let channel = settings.channel.clone();
    let ignored_version = settings.ignored_version.clone();
    let last_seen = settings.last_seen_version.clone();

    let (check, candidate) = tauri::async_runtime::spawn_blocking(move || {
        let mut reports: Vec<SourceReport> = Vec::new();
        let mut best: Option<BestSource> = None;

        for source in &sources {
            let started = Instant::now();
            match fetch_source(source, allow_http) {
                Ok(fetched) => {
                    let version = fetched.manifest.version.clone();
                    let report_base = |ok: bool, error: Option<String>, signed: bool| SourceReport {
                        id: source.id.clone(),
                        name: source.name.clone(),
                        kind: source.kind,
                        url: source.url.clone(),
                        ok,
                        version: Some(version.clone()),
                        manifest_signed: signed,
                        error,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    };

                    // 通道不符的源直接跳过：stable 用户不该被 beta 清单顶上去
                    if let Some(declared) = fetched.manifest.channel.as_deref() {
                        if !declared.is_empty() && declared != channel {
                            reports.push(report_base(
                                false,
                                Some(format!("该源发布的是 {declared} 通道，与当前通道 {channel} 不符")),
                                fetched.manifest_signed,
                            ));
                            continue;
                        }
                    }

                    match fetched
                        .manifest
                        .to_candidate(&target, &source.id, &source.name)
                    {
                        Ok(c) => {
                            let better = best
                                .as_ref()
                                .map(|b| manifest::compare_versions(&c.version, &b.candidate.version).is_gt())
                                .unwrap_or(true);
                            if better {
                                best = Some(BestSource {
                                    candidate: c,
                                    source_name: source.name.clone(),
                                    notes: fetched.manifest.notes_text(),
                                    published_at: fetched.manifest.pub_date.clone(),
                                    mandatory: fetched.manifest.mandatory.unwrap_or(false),
                                });
                            }
                            reports.push(report_base(true, None, fetched.manifest_signed));
                        }
                        Err(e) => {
                            reports.push(report_base(false, Some(e.to_string()), fetched.manifest_signed))
                        }
                    }
                }
                Err(err) => reports.push(SourceReport {
                    id: source.id.clone(),
                    name: source.name.clone(),
                    kind: source.kind,
                    url: source.url.clone(),
                    ok: false,
                    version: None,
                    manifest_signed: false,
                    error: Some(err),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                }),
            }
        }

        let latest = best.as_ref().map(|b| b.candidate.version.clone());
        let available = latest
            .as_deref()
            .map(|v| manifest::is_newer(v, &current))
            .unwrap_or(false);
        let ignored = matches!((&latest, &ignored_version), (Some(v), Some(i)) if v == i);
        // 见过更高版本却又收到更低的清单：十有八九是中间人在回放旧版本
        let downgrade_blocked = match (latest.as_deref(), last_seen.as_deref()) {
            (Some(l), Some(s)) => manifest::compare_versions(s, l).is_gt(),
            _ => false,
        };

        let check = UpdateCheck {
            checked_at: Utc::now().to_rfc3339(),
            current_version: current.clone(),
            platform: target.clone(),
            available,
            latest_version: latest,
            notes: best.as_ref().and_then(|b| b.notes.clone()),
            published_at: best.as_ref().and_then(|b| b.published_at.clone()),
            size_bytes: best.as_ref().and_then(|b| b.candidate.size),
            source_id: best.as_ref().map(|b| b.candidate.source_id.clone()),
            source_name: best.as_ref().map(|b| b.source_name.clone()),
            sources: reports,
            mandatory: best.as_ref().map(|b| b.mandatory).unwrap_or(false),
            install_supported: install_supported(),
            install_hint: install_platform_hint().to_string(),
            ignored,
            downgrade_blocked,
        };
        (check, best.map(|b| b.candidate))
    })
    .await
    .map_err(|e| ReinError::Message(format!("检查更新任务失败：{e}")))?;

    {
        let hub = app.state::<UpdateHub>();
        if let Some(c) = candidate {
            hub.set_candidate(c);
        }
        hub.set_last_check(check.clone());

        let mut settings = settings_of(&state);
        settings.last_check_at = Some(check.checked_at.clone());
        if let Some(v) = check.latest_version.clone() {
            let higher = settings
                .last_seen_version
                .as_deref()
                .map(|seen| manifest::compare_versions(&v, seen).is_gt())
                .unwrap_or(true);
            if higher {
                settings.last_seen_version = Some(v);
            }
        }
        let conn = state.db.lock().unwrap();
        super::save_settings(&conn, &settings)?;
    }

    Ok(check)
}

/// 启动下载（后台线程，进度走 `update://progress` 事件）。
#[tauri::command]
pub fn update_download(app: AppHandle) -> Result<super::DownloadState> {
    let hub = app.state::<UpdateHub>();
    if hub.is_busy() {
        return Err(ReinError::Message("已有下载在进行中".into()));
    }
    let candidate = hub
        .candidate()
        .ok_or_else(|| ReinError::Message("请先检查更新".into()))?;
    let dir = updates_dir(&app)?;

    // 已经下载并验过就不要再下一遍（用户在「检查 → 下载 → 安装」之间来回切页面很常见）
    if let Some(existing) = super::download::existing_verified(&dir, &candidate) {
        hub.set_verified(existing.to_string_lossy().to_string());
        let state = hub.state();
        let _ = app.emit(PROGRESS_EVENT, &state);
        return Ok(state);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    hub.begin_download(
        &candidate.version,
        &candidate.url,
        &candidate.source_name,
        cancel.clone(),
    );
    let initial = hub.state();
    let _ = app.emit(PROGRESS_EVENT, &initial);

    let app_bg = app.clone();
    std::thread::spawn(move || {
        let hub = app_bg.state::<UpdateHub>();
        match super::download::fetch_verified(&app_bg, &hub, &candidate, &dir, cancel) {
            Ok(path) => {
                hub.set_verified(path.to_string_lossy().to_string());
                hub.clear_cancel();
                let state = hub.state();
                let _ = app_bg.emit(PROGRESS_EVENT, &state);
            }
            Err(e) => {
                let cancelled = e.to_string().contains("已取消");
                let state = hub.update_state(|s| {
                    s.phase = if cancelled { Phase::Cancelled } else { Phase::Failed };
                    s.error = Some(e.to_string());
                    s.bytes_per_sec = 0;
                });
                hub.clear_cancel();
                let _ = app_bg.emit(PROGRESS_EVENT, &state);
            }
        }
    });

    Ok(initial)
}

#[tauri::command]
pub fn update_cancel(app: AppHandle) -> Result<bool> {
    Ok(app.state::<UpdateHub>().request_cancel())
}

/// 丢弃已下载的包（用户想重下或换版本时用）。
#[tauri::command]
pub fn update_discard(app: AppHandle) -> Result<()> {
    let hub = app.state::<UpdateHub>();
    if hub.is_busy() {
        return Err(ReinError::Message("下载进行中，请先取消".into()));
    }
    if let Some(candidate) = hub.candidate() {
        super::download::purge(&updates_dir(&app)?, &candidate);
    }
    hub.clear_verified();
    Ok(())
}

/// 安装：**重新验签**后才交给平台安装器。
#[tauri::command]
pub fn update_install(
    app: AppHandle,
    webview: tauri::Webview<tauri::Wry>,
    state: State<AppState>,
    hub: State<UpdateHub>,
) -> Result<InstallResult> {
    let file = hub
        .verified_file()
        .ok_or_else(|| ReinError::Message("还没有下载完成的安装包".into()))?;
    let candidate = hub
        .candidate()
        .ok_or_else(|| ReinError::Message("缺少更新候选信息，请重新检查更新".into()))?;
    let path = PathBuf::from(&file);

    // Android 分支用不到数据库（静默开关是 Windows 特有的），显式忽略避免未使用告警
    #[cfg(target_os = "android")]
    let _ = &state;

    // 安装是安全边界：文件可能在下完之后被替换，这里再验一次
    let state_verifying = hub.update_state(|s| {
        s.phase = Phase::Verifying;
        s.error = None;
    });
    let _ = app.emit(PROGRESS_EVENT, &state_verifying);

    if let Err(e) = super::download::verify_existing(&path, &candidate) {
        let state = hub.update_state(|s| {
            s.phase = Phase::Failed;
            s.verified = false;
            s.error = Some(format!("安装前复核失败：{e}"));
        });
        let _ = app.emit(PROGRESS_EVENT, &state);
        return Err(ReinError::Message(format!("安装包复核未通过，已阻止安装：{e}")));
    }

    let state_installing = hub.update_state(|s| {
        s.phase = Phase::Installing;
    });
    let _ = app.emit(PROGRESS_EVENT, &state_installing);

    #[cfg(target_os = "android")]
    {
        let outcome = install::install_android(&webview, &path)?;
        let state = hub.update_state(|s| {
            s.phase = Phase::Ready;
            s.error = None;
        });
        let _ = app.emit(PROGRESS_EVENT, &state);
        Ok(InstallResult {
            ok: outcome.handed_off,
            message: outcome.message,
            will_exit: false,
        })
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = &webview;
        let silent = {
            let conn = state.db.lock().unwrap();
            super::load_settings(&conn).silent_install
        };
        install::install(&path, InstallMode::from_flag(silent))?;
        let will_exit = install::requires_exit_after_install();
        if will_exit {
            // 先让 IPC 把结果送回去，再退出：安装器要替换正在运行的 exe
            let app_bg = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                app_bg.exit(0);
            });
        }
        Ok(InstallResult {
            ok: true,
            message: if will_exit {
                "安装器已启动，应用即将退出并自动重启到新版本".into()
            } else {
                "安装器已启动".into()
            },
            will_exit,
        })
    }
}

/// 下载进度兜底查询（前端错过事件时拉一次）。
#[tauri::command]
pub fn update_progress(app: AppHandle) -> Result<super::DownloadState> {
    Ok(app.state::<UpdateHub>().state())
}

/// 清理下载目录里与当前候选无关的残留（版本换代后旧包会一直占着盘）。
#[tauri::command]
pub fn update_prune_cache(app: AppHandle) -> Result<u64> {
    let hub = app.state::<UpdateHub>();
    if hub.is_busy() {
        return Err(ReinError::Message("下载进行中，请稍后再清理".into()));
    }
    let dir = updates_dir(&app)?;
    let keep = hub.candidate().map(|c| c.name).unwrap_or_default();
    let mut freed = 0u64;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep.is_empty() && (name == keep || name == format!("{keep}.part")) {
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_file() {
            freed += meta.len();
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_snapshot_fields_are_documented_contract() {
        // 前端 service 依赖这些字段名（camelCase）；改了这里就要同步改 TS 类型
        let json = serde_json::to_string(&InstallResult {
            ok: true,
            message: "m".into(),
            will_exit: false,
        })
        .unwrap();
        assert!(json.contains("\"willExit\""));
    }

    #[test]
    fn settings_patch_accepts_camel_case_keys() {
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"autoCheck":false,"checkIntervalHours":24,"channel":"beta"}"#)
                .unwrap();
        assert_eq!(patch.auto_check, Some(false));
        assert_eq!(patch.check_interval_hours, Some(24));
        assert_eq!(patch.channel.as_deref(), Some("beta"));
    }

    #[test]
    fn clear_ignored_version_with_empty_string() {
        let patch: SettingsPatch = serde_json::from_str(r#"{"ignoredVersion":""}"#).unwrap();
        let mut base = UpdateSettings::default();
        base.ignored_version = Some("0.2.1".into());
        let after = apply_patch(base, patch).unwrap();
        assert_eq!(after.ignored_version, None, "空串应当清掉跳过标记");
    }

    #[test]
    fn json_null_means_field_not_provided() {
        // 这条是给前端的契约：传 null 不会清除，只会被忽略
        let patch: SettingsPatch = serde_json::from_str(r#"{"ignoredVersion":null}"#).unwrap();
        assert_eq!(patch.ignored_version, None);
    }

    #[test]
    fn channel_is_trimmed_and_lowercased() {
        let patch: SettingsPatch = serde_json::from_str(r#"{"channel":"  Beta "}"#).unwrap();
        let after = apply_patch(UpdateSettings::default(), patch).unwrap();
        assert_eq!(after.channel, "beta");
    }

    #[test]
    fn empty_channel_is_rejected() {
        let patch: SettingsPatch = serde_json::from_str(r#"{"channel":"   "}"#).unwrap();
        assert!(apply_patch(UpdateSettings::default(), patch).is_err());
    }

    #[test]
    fn check_interval_is_clamped_to_sane_range() {
        let after = apply_patch(
            UpdateSettings::default(),
            SettingsPatch {
                check_interval_hours: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.check_interval_hours, 1);
        let after = apply_patch(
            UpdateSettings::default(),
            SettingsPatch {
                check_interval_hours: Some(9999),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(after.check_interval_hours, 24 * 30);
    }

    #[test]
    fn non_http_source_url_is_rejected() {
        let patch = SettingsPatch {
            sources: Some(vec![UpdateSource {
                id: "x".into(),
                name: "自带源".into(),
                kind: super::super::SourceKind::Rein,
                url: "ftp://example.com/latest.json".into(),
                enabled: true,
                priority: 0,
            }]),
            ..Default::default()
        };
        let err = apply_patch(UpdateSettings::default(), patch).unwrap_err();
        assert!(err.to_string().contains("http(s)"));
    }

    #[test]
    fn plain_http_source_requires_explicit_opt_in() {
        let source = UpdateSource {
            id: "x".into(),
            name: "自建源".into(),
            kind: super::super::SourceKind::Rein,
            url: "http://47.100.36.179:8787/updates/latest.json".into(),
            enabled: true,
            priority: 0,
        };
        let mut closed = UpdateSettings::default();
        closed.allow_http = false;
        let err = apply_patch(
            closed,
            SettingsPatch {
                sources: Some(vec![source.clone()]),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("明文 http"));

        // 打开开关后同一份配置必须能存进去（自建服务器就是这个形态）
        let ok = apply_patch(
            UpdateSettings::default(),
            SettingsPatch {
                sources: Some(vec![source]),
                ..Default::default()
            },
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn empty_source_url_is_rejected() {
        let patch = SettingsPatch {
            sources: Some(vec![UpdateSource {
                id: "x".into(),
                name: "空源".into(),
                kind: super::super::SourceKind::TauriStatic,
                url: "   ".into(),
                enabled: true,
                priority: 0,
            }]),
            ..Default::default()
        };
        assert!(apply_patch(UpdateSettings::default(), patch).is_err());
    }

    fn sample_check(latest: &str) -> UpdateCheck {
        UpdateCheck {
            checked_at: "2026-09-19T00:00:00Z".into(),
            current_version: "0.2.0".into(),
            platform: platform_key(),
            available: true,
            latest_version: Some(latest.into()),
            notes: None,
            published_at: None,
            size_bytes: None,
            source_id: None,
            source_name: None,
            sources: Vec::new(),
            mandatory: false,
            install_supported: true,
            install_hint: String::new(),
            ignored: false,
            downgrade_blocked: false,
        }
    }

    #[test]
    fn skipping_a_version_hides_it_without_rechecking() {
        // 回归：曾经出现过「点了跳过、卡片还在」——检查结果缓存里的 ignored 是旧值
        let mut check = sample_check("0.2.1");
        let mut settings = UpdateSettings::default();
        settings.ignored_version = Some("0.2.1".into());
        recompute_derived(&mut check, &settings);
        assert!(check.ignored, "设置跳过后，缓存的检查结果必须立刻反映出来");
    }

    #[test]
    fn clearing_the_skip_restores_the_prompt() {
        let mut check = sample_check("0.2.1");
        let mut settings = UpdateSettings::default();
        settings.ignored_version = Some("0.2.1".into());
        recompute_derived(&mut check, &settings);
        assert!(check.ignored);

        settings.ignored_version = None;
        recompute_derived(&mut check, &settings);
        assert!(!check.ignored, "清掉跳过后应当重新提示");
    }

    #[test]
    fn skip_only_applies_to_the_exact_version() {
        let mut check = sample_check("0.2.2");
        let mut settings = UpdateSettings::default();
        settings.ignored_version = Some("0.2.1".into());
        recompute_derived(&mut check, &settings);
        assert!(!check.ignored, "跳过的版本号对不上就不该静默");
    }

    #[test]
    fn downgrade_is_flagged_when_seen_version_is_higher() {
        let mut check = sample_check("0.2.0");
        let mut settings = UpdateSettings::default();
        settings.last_seen_version = Some("0.3.0".into());
        recompute_derived(&mut check, &settings);
        assert!(check.downgrade_blocked, "见过更高的版本就该拦下旧清单");

        settings.last_seen_version = Some("0.1.0".into());
        recompute_derived(&mut check, &settings);
        assert!(!check.downgrade_blocked);
    }
}
