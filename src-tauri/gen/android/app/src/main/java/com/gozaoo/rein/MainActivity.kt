package com.gozaoo.rein

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Android 系统 WebView 的 env(safe-area-inset-*) 只报告状态栏、不报告底部导航条，
 * 也不报告左右边缘返回手势带（详见前端 tokens.css --safe-* 注释）。这里监听真实
 * WindowInsets，把四向安全区注入为页面 CSS 变量 --safe-*-native；左右取
 * systemGestures（手势导航的返回手势带宽度，按钮导航时为 0，由前端兜底下限接管）。
 * WebView 在 Activity 布局完成前不存在、页面文档随后才加载，故每次 inset 变化后
 * 以 300ms 间隔重试 12s（写变量是幂等的，落在哪个文档上都无害）。
 */
class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())
  private val maxRetries = 40
  private var retries = 0
  private var topInset = 0 // 已换算成 CSS px
  private var bottomInset = 0
  private var leftInset = 0
  private var rightInset = 0

  companion object {
    /** 递归查找 WebView（ShareReceiver 派发 rein-share 事件也要用） */
    fun findWebView(view: View?): WebView? {
      if (view == null) return null
      if (view is WebView) return view
      if (view is ViewGroup) {
        for (i in 0 until view.childCount) {
          findWebView(view.getChildAt(i))?.let { return it }
        }
      }
      return null
    }
  }

  private val inject = object : Runnable {
    override fun run() {
      if (topInset + bottomInset + leftInset + rightInset > 0) {
        findWebView(window.decorView)?.evaluateJavascript(
          "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--safe-top-native','${topInset}px');" +
            "s.setProperty('--safe-bottom-native','${bottomInset}px');" +
            "s.setProperty('--safe-left-native','${leftInset}px');" +
            "s.setProperty('--safe-right-native','${rightInset}px')})()",
          null,
        )
      }
      if (--retries > 0) handler.postDelayed(this, 300L)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 注册跑步保活桥的权限弹窗回调（ActivityResultLauncher 必须在 Activity 创建后注册）
    TrackingBridge.register(this)
    // 系统分享/打开的文件（冷启动 intent 可能自带）：落收件箱 + 通知前端
    ShareReceiver.handle(this, intent)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      // WindowInsets 是物理像素；CSS 像素 = 物理像素 / density，直接塞会放大 2~3 倍
      val density = resources.displayMetrics.density
      topInset = (insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout(),
      ).top / density).toInt()
      bottomInset = (insets.getInsets(
        WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout(),
      ).bottom / density).toInt()
      val gesture = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
      leftInset = (gesture.left / density).toInt()
      rightInset = (gesture.right / density).toInt()
      // 每次安全区变化（旋转/键盘等）重新推一轮，也覆盖页面重载后变量丢失的情况
      retries = maxRetries
      handler.removeCallbacks(inject)
      handler.post(inject)
      insets
    }
  }

  /** 运行中被分享唤起（singleTask，不重建）：把新 intent 交给分享接收 */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    ShareReceiver.handle(this, intent)
  }

  private fun findWebView(view: View?): WebView? {
    return Companion.findWebView(view)
  }
}
