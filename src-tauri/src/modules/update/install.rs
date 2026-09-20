//! 安装：把**已经验签通过**的包交给平台安装器。
//!
//! Windows：官方 NSIS 安装包的参数约定照抄 tauri-plugin-updater（`/P|/S /UPDATE /R`），
//! 否则会出现「装上了但没重启」「更新被当成新装、旧版本没被替换」这类难查的问题。
//! 安装器要替换正在运行的可执行文件，所以进程必须退出 —— 这里留给 IPC 一点时间先回包。
//!
//! Android：官方插件在移动端是空实现（它假设更新走应用商店）。Rein 是自建 APK 分发，
//! 所以走系统安装器：Kotlin 侧把包复制进应用私有缓存 → FileProvider 出 URI →
//! ACTION_VIEW 交给系统；Android 8+ 未授予「安装未知应用」时会先跳系统设置页。

use std::path::Path;

use crate::error::{ReinError, Result};

/// 安装方式（Windows 用）：被动模式显示进度条，静默模式完全无界面。
#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    Passive,
    Silent,
}

#[cfg(not(target_os = "android"))]
impl InstallMode {
    pub fn from_flag(silent_install: bool) -> Self {
        if silent_install {
            InstallMode::Silent
        } else {
            InstallMode::Passive
        }
    }

    #[cfg(target_os = "windows")]
    fn nsis_flag(self) -> &'static str {
        match self {
            InstallMode::Passive => "/P",
            InstallMode::Silent => "/S",
        }
    }
}

#[cfg(target_os = "windows")]
pub fn install(path: &Path, mode: InstallMode) -> Result<()> {
    use std::process::Command;

    if !path.exists() {
        return Err(ReinError::Message("安装包不存在，请重新下载".into()));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "exe" {
        return Err(ReinError::Message(format!(
            "Windows 安装包应为 .exe，实际是 .{ext}（请手动安装）"
        )));
    }

    // 参数集与官方 updater 一致：
    //   /P 被动（显示进度条）或 /S 完全静默 · /UPDATE 走更新分支 · /R 装完重启应用
    Command::new(path)
        .args([mode.nsis_flag(), "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| ReinError::Message(format!("启动安装器失败：{e}")))?;

    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub fn install(_path: &Path, _mode: InstallMode) -> Result<()> {
    Err(ReinError::Message(
        "当前平台不支持应用内安装：请到更新页复制下载地址手动安装".into(),
    ))
}

/// Android 安装结果（exec 是发后不管的，只能给一个「已交给系统」的确定性说明）。
#[cfg(target_os = "android")]
pub struct AndroidInstallOutcome {
    pub handed_off: bool,
    pub message: String,
}

#[cfg(target_os = "android")]
mod android_imp {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JNIEnv;

    const BRIDGE_CLASS: &str = "com.gozaoo.rein.UpdateBridge";

    /// 在 WebView 主线程执行一段 JNI 调用（exec 是发后不管的，错误只能记日志）。
    pub(super) fn dispatch<F>(webview: &tauri::Webview<tauri::Wry>, f: F)
    where
        F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
    {
        if let Err(e) = webview.with_webview(move |platform| platform.jni_handle().exec(f)) {
            eprintln!("[update] with_webview 失败：{e}");
        }
    }

    /// 通过 Activity.getAppClass 找应用类（裸 FindClass 可能落在系统类加载器上找不到）。
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

    /// 清掉 pending Java 异常。
    ///
    /// JNI 规范：异常挂起后继续调用其他 JNI 函数是未定义行为，Android 上表现为
    /// 进程崩溃（闪退）。安装桥失败只是「这次没装上」，绝不该升级成崩溃——
    /// 典型触发场景就是 R8 把桥接类裁掉后的 NoSuchMethodError（keep 规则见
    /// gen/android/app/proguard-rules.pro）。
    fn clear_exception(env: &mut JNIEnv) {
        if matches!(env.exception_check(), Ok(true)) {
            let _ = env.exception_clear();
        }
    }

    pub(super) fn call_install(
        env: &mut JNIEnv,
        activity: &JObject<'_>,
        path: &str,
    ) -> jni::errors::Result<()> {
        let class = match find_app_class(env, activity) {
            Ok(c) => c,
            Err(e) => {
                clear_exception(env);
                return Err(e);
            }
        };
        let jpath = match env.new_string(path) {
            Ok(p) => p,
            Err(e) => {
                clear_exception(env);
                return Err(e);
            }
        };
        if let Err(e) = env.call_static_method(
            class,
            "install",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(activity), JValue::Object(&jpath)],
        ) {
            clear_exception(env);
            return Err(e);
        }
        Ok(())
    }
}

/// 交给系统安装器安装一个已验签的 APK。
#[cfg(target_os = "android")]
pub fn install_android(
    webview: &tauri::Webview<tauri::Wry>,
    path: &Path,
) -> Result<AndroidInstallOutcome> {
    if !path.exists() {
        return Err(ReinError::Message("安装包不存在，请重新下载".into()));
    }
    let path_str = path.to_string_lossy().to_string();

    android_imp::dispatch(webview, move |env, activity, _| {
        if let Err(e) = android_imp::call_install(env, activity, &path_str) {
            eprintln!("[update] Android 安装桥调用失败：{e}");
        }
    });

    Ok(AndroidInstallOutcome {
        handed_off: true,
        message: "已交给系统安装器。若没有弹出安装界面，请在系统设置里允许 Rein「安装未知应用」后重试。"
            .to_string(),
    })
}

/// 安装之后本进程该不该退出：Windows 必须退（安装器要替换 exe），Android 不必。
pub fn requires_exit_after_install() -> bool {
    cfg!(target_os = "windows")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "android"))]
    #[test]
    fn mode_from_flag_maps_to_expected_nsis_behavior() {
        assert_eq!(InstallMode::from_flag(true), InstallMode::Silent);
        assert_eq!(InstallMode::from_flag(false), InstallMode::Passive);
    }

    #[test]
    fn only_windows_needs_process_exit() {
        assert_eq!(requires_exit_after_install(), cfg!(target_os = "windows"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    #[test]
    fn unsupported_platform_reports_clearly_instead_of_silently_doing_nothing() {
        let err = install(Path::new("/tmp/nonexistent"), InstallMode::Passive).unwrap_err();
        assert!(err.to_string().contains("手动安装"));
    }
}
