package com.gozaoo.rein

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Parcelable
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.WebView
import java.io.File

/**
 * 系统分享/打开接收入口。
 *
 * AndroidManifest 给 MainActivity 注册了 ACTION_SEND / SEND_MULTIPLE / VIEW
 * 的 intent-filter（图片 / 文本 / Office 文档），外部应用把文件交给 Rein 时
 * 走到这里：把内容拷入 cacheDir/share_inbox/<ts>_<name>，然后 evaluateJavascript
 * 向页面派发 `rein-share` 事件，前端 shareInbox 运行时收到后经 IPC
 * （share_poll / share_read，见 Rust modules/share）取走并进入 AI 聊天。
 *
 * 为什么拷文件而不直接传 Uri：content:// Uri 只在本次授权内可读，且 WebView
 * 侧读取要走 JS bridge，不如在原生侧一次落盘简单可靠；inbox 文件由 Rust
 * share_read 读后即删，7 天残留自动清理。
 *
 * 通知采用「事件 + 启动轮询」双通道：
 * - 运行中收到分享（onNewIntent）：WebView 已就绪，evaluateJavascript 直达；
 * - 冷启动（onCreate 时 intent 已带文件）：页面可能未加载，事件丢失没关系，
 *   前端启动时 shareInbox.init() 会主动 poll 一次兜底。
 */
object ShareReceiver {
  private const val DIR = "share_inbox"
  /// 单文件拷贝上限（与 Rust share_read / 前端文档解析的 20MB 上限一致）
  private const val MAX_BYTES = 20L * 1024 * 1024
  private val main = Handler(Looper.getMainLooper())

  /** Activity 入口：onCreate 与 onNewIntent 都调这里 */
  fun handle(activity: Activity, intent: Intent?) {
    if (intent == null) return
    try {
      when (intent.action) {
        Intent.ACTION_SEND -> handleSend(activity, intent)
        Intent.ACTION_SEND_MULTIPLE -> {
          @Suppress("DEPRECATION")
          val streams = intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM)
          streams?.forEach { if (it is Uri) handleOne(activity, it) }
        }
        Intent.ACTION_VIEW -> intent.data?.let { handleOne(activity, it) }
      }
    } catch (e: Exception) {
      Log.e("ShareReceiver", "处理分享失败", e)
    }
  }

  private fun handleSend(activity: Activity, intent: Intent) {
    @Suppress("DEPRECATION")
    val stream = intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM)
    if (stream is Uri) {
      handleOne(activity, stream)
      return
    }
    // 纯文本分享（无附件）：落成 txt 进入同一管道
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    if (!text.isNullOrBlank()) {
      writeInbox(activity, "text-${System.currentTimeMillis()}.txt", text.toByteArray())
    }
  }

  private fun handleOne(activity: Activity, uri: Uri) {
    val resolver = activity.contentResolver
    val name = queryDisplayName(activity, uri) ?: "share-${System.currentTimeMillis()}"
    val safe = name.replace(Regex("[\\\\/:*?\"<>|\u0000-\u001f]"), "_").ifBlank { "share.bin" }
    val bytes = ByteArray(64 * 1024)
    try {
      resolver.openInputStream(uri)?.use { input ->
        // 先写入 .part，整体成功后改名，避免中断留下半个文件被前端取走
        val final = inboxFile(activity, "${System.currentTimeMillis()}_$safe")
        val part = File(final.parentFile, final.name + ".part")
        part.outputStream().use { out ->
          var total = 0L
          while (true) {
            val n = input.read(bytes)
            if (n < 0) break
            total += n
            if (total > MAX_BYTES) {
              part.delete()
              Log.w("ShareReceiver", "分享文件超过 20MB，丢弃：$name")
              return
            }
            out.write(bytes, 0, n)
          }
        }
        if (!part.renameTo(final)) {
          Log.e("ShareReceiver", "改名失败：$part -> $final")
          part.delete()
          return
        }
      } ?: Log.w("ShareReceiver", "无法打开分享内容：$uri")
    } catch (e: Exception) {
      Log.e("ShareReceiver", "拷贝分享文件失败：$name", e)
      return
    }
    notifyWebView(activity)
  }

  /** 向页面派发 rein-share 事件（WebView 未就绪时静默失败，启动轮询兜底） */
  private fun notifyWebView(activity: Activity) {
    main.post {
      try {
        val wv = MainActivity.findWebView(activity.window.decorView) ?: return@post
        wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('rein-share'))", null)
      } catch (e: Exception) {
        Log.w("ShareReceiver", "通知页面失败（将由启动轮询兜底）", e)
      }
    }
  }

  private fun inboxFile(activity: Activity, name: String): File {
    val dir = File(activity.cacheDir, DIR)
    dir.mkdirs()
    return File(dir, name)
  }

  private fun writeInbox(activity: Activity, name: String, data: ByteArray) {
    writeInboxFile(activity, name, data)
    notifyWebView(activity)
  }

  private fun writeInboxFile(activity: Activity, name: String, data: ByteArray): Boolean {
    return try {
      val final = inboxFile(activity, "${System.currentTimeMillis()}_$name")
      final.writeBytes(data)
      true
    } catch (e: Exception) {
      Log.e("ShareReceiver", "写入收件箱失败：$name", e)
      false
    }
  }

  private fun queryDisplayName(activity: Activity, uri: Uri): String? {
    return try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (e: Exception) {
      null
    }
  }
}
