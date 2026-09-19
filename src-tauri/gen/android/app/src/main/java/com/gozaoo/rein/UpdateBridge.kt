package com.gozaoo.rein

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * Rust(jni_handle.exec) ↔ Kotlin 的 APK 安装桥。
 *
 * 官方 tauri-plugin-updater 在移动端是空实现（它假设更新走应用商店）。Rein 是自建
 * APK 分发，所以这里直接对接系统安装器，路径是：
 *
 *   Rust 下载并验签（Ed25519）→ 应用私有目录 → 本桥复制进 cacheDir
 *   → FileProvider 换 content:// URI → ACTION_VIEW 交给系统安装器
 *
 * 为什么要复制而不是直接分享原文件：APK 在 app_data 目录（getDataDir()），
 * 而 FileProvider 的 <files-path>/<cache-path> 只覆盖各自子树，路径映射不确定。
 * 复制到 cacheDir 后，URI 的合法性是确定的（res/xml/file_paths.xml 已声明 cache-path）。
 * 60MB 级别的复制放在后台线程做，别在主线程上卡住 WebView。
 *
 * exec 没有返回值通道（与 TrackingBridge 同款约定），所以状态走 snapshot()：
 * Rust 侧把上次快照缓存进静态变量，前端据此提示「是否还需要去授权」。
 */
object UpdateBridge {
  private val main = Handler(Looper.getMainLooper())

  /** true = 已成功把包复制进缓存（系统安装器随时可读） */
  @Volatile private var copied = false

  /** true = 上次调用因缺少「安装未知应用」权限而跳去了设置页 */
  @Volatile private var needsPermission = false

  /**
   * 安装一个已经由 Rust 侧验签过的 APK。
   * 复制在后台线程；Intent 在主线程发（startActivity 必须在主线程）。
   */
  @JvmStatic
  fun install(context: Context, path: String) {
    val app = context.applicationContext
    val source = File(path)
    if (!source.exists() || !source.isFile) {
      Log.w("UpdateBridge", "安装包不存在：$path")
      return
    }
    copied = false

    Thread {
      try {
        val dir = File(app.cacheDir, "rein-update").apply { mkdirs() }
        // 只留一份：旧版本的包没有价值，还能省几十 MB 的缓存
        dir.listFiles()?.forEach { stale -> if (stale.name != source.name) stale.delete() }
        val target = File(dir, source.name)
        source.inputStream().use { input ->
          target.outputStream().use { output -> input.copyTo(output, DEFAULT_BUFFER_SIZE * 8) }
        }
        copied = true
        main.post { launchInstaller(app, target) }
      } catch (e: Exception) {
        Log.e("UpdateBridge", "复制安装包失败", e)
      }
    }.start()
  }

  private fun launchInstaller(app: Context, apk: File) {
    // Android 8+：安装未知应用是逐应用的授权，未授予时先跳系统设置页
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !app.packageManager.canRequestPackageInstalls()) {
      needsPermission = true
      try {
        app.startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${app.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        Log.w("UpdateBridge", "缺少「安装未知应用」权限，已跳转设置页")
      } catch (e: Exception) {
        Log.e("UpdateBridge", "跳转授权页失败", e)
      }
      return
    }

    try {
      val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", apk)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      app.startActivity(intent)
      needsPermission = false
    } catch (e: Exception) {
      Log.e("UpdateBridge", "启动系统安装器失败", e)
    }
  }

  /** [已复制到缓存, 因缺少授权而跳去了设置页]，供 Rust 侧缓存刷新。 */
  @JvmStatic
  fun snapshot(context: Context): BooleanArray {
    val app = context.applicationContext
    val canInstall =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || app.packageManager.canRequestPackageInstalls()
    return booleanArrayOf(copied && canInstall, needsPermission)
  }
}
