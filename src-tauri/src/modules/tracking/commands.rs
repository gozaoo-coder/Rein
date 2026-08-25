//! 跑步保活命令。仅 Android 有实际行为（经 JNI 调 TrackingBridge），
//! 桌面端空操作——WebView2/WKWebView 前台 geolocation 不需要额外保活。

use serde::Serialize;

use crate::error::Result;

/// 拉起（enable=true）/停掉跑步前台保活服务。Android 上为异步分发：
/// 首次未授权会弹系统授权框，授权后服务自动拉起；前端随后轮询
/// `tracking_status` 等待收敛。
#[tauri::command]
pub fn tracking_keepalive(webview: tauri::Webview<tauri::Wry>, enable: bool) -> Result<()> {
    #[cfg(target_os = "android")]
    super::android_bridge_enable(&webview, enable);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, enable);
    }
    Ok(())
}

/// 保活状态快照：granted=定位权限已授予；busy=权限弹窗待答或状态尚未同步。
#[derive(Serialize)]
pub struct TrackingStatus {
    pub granted: bool,
    pub busy: bool,
}

#[tauri::command]
pub fn tracking_status(webview: tauri::Webview<tauri::Wry>) -> Result<TrackingStatus> {
    #[cfg(target_os = "android")]
    {
        // 每次轮询顺带触发一次异步刷新，缓存很快收敛到真值
        super::android_refresh_status(&webview);
        let (granted, busy) = super::android_status();
        Ok(TrackingStatus { granted, busy })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
        Ok(TrackingStatus {
            granted: true,
            busy: false,
        })
    }
}
