//! 第三方健康数据同步域：与 Android **Health Connect** 双向同步运动记录。
//!
//! 数据链：小米手环 → 小米运动健康（写入方）→ Health Connect → Rein（读取方）。
//! 手机厂商的运动 App 把数据写进系统的 Health Connect，各家（小米/华为/三星）
//! 的差异在系统那一层已经被抹平，所以这一域只认 Health Connect 一种协议 ——
//! 不去对接任何厂商私有接口。
//!
//! ## 职责边界
//!
//! - **Kotlin 侧**（`HealthConnectBridge.kt`）：只做 HC 的读/写/授权与时间窗配对，
//!   不认识 Rein 的业务字段；产出物是一份 JSON 文件。
//! - **本域 [`adapter`]**：纯函数翻译层，两侧字段语义的差异全部收在这里。
//! - **本域 [`commands`]**：同步算法与落库，只做「比对 → 增/改/删」。
//!
//! ## 为什么数据走文件而不是 JNI 返回值
//!
//! `PlatformWebview::jni_handle().exec` 是**发后不管**的（见 `modules/tracking`），
//! 而 HC 的读取是协程异步的，结果不可能在调用栈里返回。所以沿用分享收件箱
//! （`modules/share`）那套：Kotlin 把结果写进 `cacheDir/health_sync/*.json`，
//! Rust 读同一个目录 —— Tauri 的 `app_cache_dir()` 就是 Android 的 `cacheDir`。
//! JNI 只用来「下达指令」，不含数据回传。
//!
//! ## 桌面端
//!
//! 一律空操作：`supported = false`，前端据此显示为桌面不可用。命令签名两端一致，
//! 与 `modules/tracking` 同形。

pub mod adapter;
pub mod commands;
pub mod models;

use std::path::PathBuf;

/// 与 Kotlin 交换文件的目录名（`cacheDir/health_sync/`）
const BRIDGE_DIR: &str = "health_sync";

/// Kotlin 写的状态文件：可用性 / 授权 / 忙闲 / 上一轮结果类型
pub(crate) const STATE_FILE: &str = "state.json";
/// Kotlin 写：读回来的 HC 记录（`HcReadPayload`）
pub(crate) const PULL_FILE: &str = "pull.json";
/// Rust 写、Kotlin 读：要写进 HC 的记录（`HcWritePayload`）
pub(crate) const WRITE_FILE: &str = "push-request.json";
/// Kotlin 写：写入结果（clientRecordId → recordId）
pub(crate) const PUSH_FILE: &str = "push-result.json";

/// 一次同步的进行态。前端每轮 `health_sync_step` 推进一步，直到 `done`。
pub(crate) struct Pending {
    pub stage: Stage,
    pub report: models::SyncReport,
    /// 用户在这一轮里是否开着「回写 HC」
    pub push: bool,
    /// 估算最大心率（`220 - 年龄`），给适配层反推强度用
    pub max_hr: Option<f64>,
    /// 用户当前的 UTC 偏移（秒），导出方向把墙上时间折算成 Instant 用
    pub utc_offset_seconds: i64,
    /// 本轮起草时刻：Kotlin 侧要是崩了不会有文件落地，靠它超时收场
    pub started: std::time::Instant,
}

pub(crate) enum Stage {
    /// 等 Kotlin 把 HC 记录读出来
    PollPull,
    /// 等 Kotlin 把本地记录写进 HC
    PollPush,
    /// 收工，下一次 step 取走报告并清空
    Done,
}

pub(crate) static PENDING: std::sync::Mutex<Option<Pending>> = std::sync::Mutex::new(None);

/// 桥目录（不存在则建）。桌面端也会建，只是没人写它。
pub(crate) fn bridge_dir(app: &tauri::AppHandle) -> crate::error::Result<PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::error::ReinError::Message(format!("无法定位应用缓存目录：{e}")))?
        .join(BRIDGE_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 读桥目录里的 JSON 文件；不存在/解析失败一律 `None`（调用方按「还没准备好」处理）
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(
    app: &tauri::AppHandle,
    name: &str,
) -> Option<T> {
    let path = bridge_dir(app).ok()?.join(name);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn write_json<T: serde::Serialize>(
    app: &tauri::AppHandle,
    name: &str,
    value: &T,
) -> crate::error::Result<()> {
    let path = bridge_dir(app)?.join(name);
    let text = serde_json::to_string(value)?;
    std::fs::write(path, text)?;
    Ok(())
}

pub(crate) fn remove_file(app: &tauri::AppHandle, name: &str) {
    if let Ok(dir) = bridge_dir(app) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/* ---------------- Android JNI 分发 ---------------- */

/// 向 Kotlin `HealthConnectBridge` 下达一条无返回值的指令。
///
/// 与 `modules/tracking` 同一套做法：经 `with_webview` → `jni_handle().exec`
/// 切到 WebView 主线程再调静态方法（HC 的协程与权限弹窗都必须在主线程发起）。
/// webview 由命令参数注入（不是从 AppHandle 里捞），与 tracking 一致 ——
/// 那条路是已经在真机上跑通的。
#[cfg(target_os = "android")]
pub(crate) fn dispatch(webview: &tauri::Webview<tauri::Wry>, method: &'static str, arg: Option<String>) {
    let dispatched = webview.with_webview(move |platform| {
        platform.jni_handle().exec(move |env, activity, _| {
            if let Err(e) = call_bridge(env, activity, method, arg.as_deref()) {
                eprintln!("[healthsync] bridge.{method} 失败：{e}");
            }
        });
    });
    if let Err(e) = dispatched {
        eprintln!("[healthsync] with_webview 失败：{e}");
    }

    /// 找应用类并调 `HealthConnectBridge.<method>`。
    ///
    /// 走 `Activity.getAppClass` 而不是裸 `FindClass`：Android 上裸 FindClass
    /// 可能落在系统类加载器上，找不到应用类（wry 自己也走这条路）。
    fn call_bridge(
        env: &mut jni::JNIEnv<'_>,
        activity: &jni::objects::JObject<'_>,
        method: &str,
        arg: Option<&str>,
    ) -> jni::errors::Result<()> {
        use jni::objects::JValue;
        let name = env.new_string("com.gozaoo.rein.HealthConnectBridge")?;
        let class: jni::objects::JClass<'_> = env
            .call_method(
                activity,
                "getAppClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?
            .into();
        let called = match arg {
            // deleteRecord(recordId)，以及 requestPermissions(mode) / startWrite(path)
            // —— 都走 (Context, String) 这一个签名，Kotlin 侧按方法名解释参数
            Some(text) => {
                let arg = env.new_string(text)?;
                env.call_static_method(
                    class,
                    method,
                    "(Landroid/content/Context;Ljava/lang/String;)V",
                    &[JValue::Object(activity), JValue::Object(&arg)],
                )
                .map(|_| ())
            }
            None => env
                .call_static_method(
                    class,
                    method,
                    "(Landroid/content/Context;)V",
                    &[JValue::Object(activity)],
                )
                .map(|_| ()),
        };
        if called.is_err() {
            // 兜底：JNI 调用抛出的 Java 异常会**挂**在 env 上，光记日志没用 ——
            // 控制权一回到 Java 层，它就在主线程上炸掉整个进程。
            // 实测过一次：Kotlin 漏写 @JvmStatic，方法不是静态的 → NoSuchMethodError
            // → 点开「第三方数据管理」直接闪退。清掉异常把「崩溃」降级成
            // 「这一次调用失败」（前端按错误/超时收场），同时日志里留得下原因。
            let _ = env.exception_clear();
        }
        called
    }
}

/// 非 Android：没有 Health Connect，指令一律丢弃（命令层已经按 `supported=false` 短路）
#[cfg(not(target_os = "android"))]
pub(crate) fn dispatch(_webview: &tauri::Webview<tauri::Wry>, method: &'static str, _arg: Option<String>) {
    eprintln!("[healthsync] 当前平台不支持 Health Connect，忽略 {method}");
}
