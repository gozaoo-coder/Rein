//! 跑步采集命令族。Android 上经 JNI 调 Kotlin（原生前台服务＝运动真源），
//! 桌面端全部空操作/兜底常量——WebView2/WKWebView 前台 geolocation 够用。
//!
//! 命令面统一「缓存 + 异步刷新」：exec 没有回执通道，命令返回上次缓存值，
//! 调用方按 400ms 重试收敛（契约见前端 services/trackingService.ts）。

use serde::Serialize;

use crate::error::Result;

use super::model;

/// 拉起（enable=true）/停掉跑步前台服务。mode='location' 需定位权限（首次会弹
/// 系统授权框，授权后服务自动拉起）；'specialUse' 供训练课常驻通知用，不要定位权限。
#[tauri::command]
pub fn tracking_keepalive(
    webview: tauri::Webview<tauri::Wry>,
    enable: bool,
    mode: Option<String>,
) -> Result<()> {
    let mode = mode.unwrap_or_else(|| "location".to_string());
    #[cfg(target_os = "android")]
    super::android_keepalive(&webview, enable, mode);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, enable, mode);
    }
    Ok(())
}

/// 保活状态快照：granted=定位权限已授予；busy=权限弹窗待答或状态尚未同步；
/// notify=通知权限已授予；native=本端有原生采集（Android），前端据此决定真源。
#[derive(Serialize)]
pub struct TrackingStatus {
    pub granted: bool,
    pub busy: bool,
    pub notify: bool,
    pub native: bool,
}

#[tauri::command]
pub fn tracking_status(webview: tauri::Webview<tauri::Wry>) -> Result<TrackingStatus> {
    #[cfg(target_os = "android")]
    {
        // 每次轮询顺带触发一次异步刷新，缓存很快收敛到真值
        super::android_refresh_status(&webview);
        let (granted, busy, notify) = super::android_status();
        Ok(TrackingStatus {
            granted,
            busy,
            notify,
            native: true,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
        Ok(TrackingStatus {
            granted: true,
            busy: false,
            notify: true,
            native: false,
        })
    }
}

/// 开跑：初始化原生采集器。
/// baseline 用于恢复续跑（累计量初值 = 恢复出来的值）；阈值 enter<=0 表示关闭自动暂停。
/// 同 runId 的轨迹文件已存在且 baselineElapsedMs>0 → 追加，否则新建/截断（Kotlin 侧执行）。
#[tauri::command]
pub fn tracking_run_begin(
    webview: tauri::Webview<tauri::Wry>,
    run_id: String,
    auto_pause_enter_sec_per_km: i32,
    auto_pause_exit_sec_per_km: i32,
    baseline_elapsed_ms: i64,
    baseline_distance_m: f64,
) -> Result<()> {
    let (enter, exit) =
        model::normalize_auto_pause(auto_pause_enter_sec_per_km, auto_pause_exit_sec_per_km);
    let run_id = model::sanitize_run_id(&run_id);
    #[cfg(target_os = "android")]
    super::android_run_begin(
        &webview,
        run_id,
        enter,
        exit,
        baseline_elapsed_ms,
        baseline_distance_m,
    );
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, run_id, enter, exit, baseline_elapsed_ms, baseline_distance_m);
    }
    Ok(())
}

/// 相位同步：'running'|'paused'，其它值记日志丢弃（原生据此停/恢复累计与判定）
#[tauri::command]
pub fn tracking_run_phase(webview: tauri::Webview<tauri::Wry>, phase: String) -> Result<()> {
    if phase != "running" && phase != "paused" {
        eprintln!("[tracking] 未知相位 {phase}，丢弃");
        return Ok(());
    }
    #[cfg(target_os = "android")]
    super::android_run_phase(&webview, phase);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, phase);
    }
    Ok(())
}

/// 结束：停定位更新 → 结账自动暂停段 → 停服务（通知消失）；轨迹文件保留待 trackTake
#[tauri::command]
pub fn tracking_run_end(webview: tauri::Webview<tauri::Wry>) -> Result<()> {
    #[cfg(target_os = "android")]
    super::android_run_end(&webview);
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
    }
    Ok(())
}

/// 上次缓存的 live 快照（本命令顺带触发一次异步刷新）；无缓存/桌面 → 兜底常量
#[tauri::command]
pub fn tracking_live(webview: tauri::Webview<tauri::Wry>) -> Result<String> {
    #[cfg(target_os = "android")]
    {
        super::android_live(&webview);
        let cached = super::live_cached();
        Ok(if cached.is_empty() {
            super::FALLBACK_LIVE_JSON.to_string()
        } else {
            cached
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
        Ok(super::FALLBACK_LIVE_JSON.to_string())
    }
}

/// 取走轨迹文件分片 `{lines,data}`。异步刷新语义：读到非空才覆盖缓存；只有
/// 「采集未在跑 + 本次读到非空且已入缓存」才删文件（交付后删除）。文件不存在 → 返回缓存原值。
#[tauri::command]
pub fn tracking_track_take(webview: tauri::Webview<tauri::Wry>, run_id: String) -> Result<String> {
    let run_id = model::sanitize_run_id(&run_id);
    #[cfg(target_os = "android")]
    {
        super::android_track_take(&webview, run_id);
        let cached = super::track_cached();
        Ok(if cached.is_empty() {
            super::EMPTY_TRACK_JSON.to_string()
        } else {
            cached
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, run_id);
        Ok(super::EMPTY_TRACK_JSON.to_string())
    }
}

/// 推送通知载荷（JSON 对象 ≤8192 字节；不合法记日志丢弃）。原生只渲染、不判断。
#[tauri::command]
pub fn tracking_notify(webview: tauri::Webview<tauri::Wry>, payload: String) -> Result<()> {
    let Some(valid) = model::validate_notify_payload(&payload) else {
        eprintln!("[tracking] 通知载荷不合法（{} 字节），丢弃", payload.len());
        return Ok(());
    };
    let valid = valid.to_string();
    #[cfg(target_os = "android")]
    super::android_notify(&webview, valid);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, valid);
    }
    Ok(())
}

/// 冷启动待办：''|'run'|'course'（点通知进应用时落下，读走即清）
#[tauri::command]
pub fn tracking_open_pending(webview: tauri::Webview<tauri::Wry>) -> Result<String> {
    #[cfg(target_os = "android")]
    {
        super::android_open_pending(&webview);
        Ok(super::take_open_pending())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
        Ok(String::new())
    }
}
