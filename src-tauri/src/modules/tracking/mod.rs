//! 跑步保活域：无数据库、无模型。Android 上经 `with_webview` →
//! `PlatformWebview::jni_handle().exec` 调 Kotlin TrackingBridge，
//! 拉起/停掉前台定位服务（锁屏后维持 GPS 与计时）；桌面端为空操作。
//! 契约见前端 `services/trackingService.ts`。
//!
//! exec 没有返回值通道：Kotlin 的状态经 snapshot 快照写进下方静态缓存，
//! 命令返回缓存值，前端轮询自然收敛到真值。

pub mod commands;

/// true = 定位权限已授予
#[cfg(target_os = "android")]
static GRANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// true = 权限弹窗待答，或快照尚未首次同步（避免把「未同步」误判成「用户拒绝」）
#[cfg(target_os = "android")]
static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[cfg(target_os = "android")]
mod android_imp {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JNIEnv;

    const BRIDGE_CLASS: &str = "com.gozaoo.rein.TrackingBridge";

    /// 在 WebView 主线程执行一段 JNI 调用。exec 是发后不管的，错误只能记日志。
    pub(super) fn dispatch<F>(webview: &tauri::Webview<tauri::Wry>, f: F)
    where
        F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
    {
        if let Err(e) = webview.with_webview(move |platform| platform.jni_handle().exec(f)) {
            eprintln!("[tracking] with_webview 失败：{e}");
        }
    }

    /// 通过 Activity.getAppClass 找应用类（Android 上裸 FindClass 可能落在
    /// 系统类加载器上找不到应用类，wry 自己也走这条路）。
    fn find_app_class<'a>(
        env: &mut JNIEnv<'a>,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<JClass<'a>> {
        let name = env.new_string(BRIDGE_CLASS)?;
        let class = env
            .call_method(
                activity,
                "getAppClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?;
        Ok(class.into())
    }

    pub(super) fn call_enable_disable(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        enable: bool,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let method = if enable { "enable" } else { "disable" };
        env.call_static_method(
            class,
            method,
            "(Landroid/content/Context;)V",
            &[JValue::Object(activity)],
        )?;
        refresh_state(env, activity)
    }

    /// 调用 Kotlin snapshot() -> [granted, busy]，刷新静态缓存
    pub(super) fn refresh_state(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
    ) -> jni::errors::Result<()> {
        let class = find_app_class(env, activity)?;
        let arr = env
            .call_static_method(
                class,
                "snapshot",
                "(Landroid/content/Context;)[Z",
                &[JValue::Object(activity)],
            )?
            .l()?;
        let arr: jni::objects::JBooleanArray = arr.into();
        let mut buf = [0u8; 2]; // jboolean 即 u8
        env.get_boolean_array_region(&arr, 0, &mut buf)?;
        super::GRANTED.store(buf[0] != 0, std::sync::atomic::Ordering::Relaxed);
        super::BUSY.store(buf[1] != 0, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

/// 拉起/停掉保活服务并顺带刷新一次状态缓存（异步分发）
#[cfg(target_os = "android")]
pub(crate) fn android_bridge_enable(webview: &tauri::Webview<tauri::Wry>, enable: bool) {
    android_imp::dispatch(webview, move |env, activity, _| {
        if let Err(e) = android_imp::call_enable_disable(env, activity, enable) {
            eprintln!("[tracking] bridge({enable}) 失败：{e}");
        }
    });
}

/// 异步触发一次状态快照刷新
#[cfg(target_os = "android")]
pub(crate) fn android_refresh_status(webview: &tauri::Webview<tauri::Wry>) {
    android_imp::dispatch(webview, |env, activity, _| {
        if let Err(e) = android_imp::refresh_state(env, activity) {
            eprintln!("[tracking] snapshot 失败：{e}");
        }
    });
}

/// 读缓存快照：(granted, busy)
#[cfg(target_os = "android")]
pub(crate) fn android_status() -> (bool, bool) {
    use std::sync::atomic::Ordering;
    (GRANTED.load(Ordering::Relaxed), BUSY.load(Ordering::Relaxed))
}
