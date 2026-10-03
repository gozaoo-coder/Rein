package com.gozaoo.rein

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 健康数据用途说明页。
 *
 * **为什么必须有这一页**：`android.permission.health.*` 在 Android 14+ 是系统级
 * 健康权限，清单里必须声明一个处理 `VIEW_PERMISSION_USAGE` +
 * `HEALTH_PERMISSIONS` 的 activity，否则系统判定应用的「健康权限状态」不完整 ——
 * 授权页拉起来会秒退、读写全部被 HC 拒绝。实测的错误原文：
 * `Incorrect health permission state, likely because the calling application's
 * manifest does not specify handling android.intent.action.VIEW_PERMISSION_USAGE
 * with android.intent.category.HEALTH_PERMISSIONS`。
 *
 * 所以这不是「可选的引导文案」，而是权限能不能用的**前提**。内容刻意做成
 * 一张静态说明卡：将来要做更完整的引导，替换这一页的内容即可，
 * 清单里的 intent-filter 不用动。
 *
 * 布局用代码写而不是 XML：这一页只有一个滚动 + 几段字 + 一个按钮，
 * 为它引入 layout 资源不值得；主题钉在浅色 Material 上，跟应用一致的观感，
 * 也不依赖项目里的令牌（原生侧拿不到那些 CSS 变量）。
 */
class HealthRationaleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setTheme(android.R.style.Theme_Material_Light_NoActionBar)

    val pad = (resources.displayMetrics.density * 24).toInt()

    fun label(text: String, size: Float, bold: Boolean, color: Int): TextView {
      return TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setLineSpacing(resources.displayMetrics.density * 4f, 1f)
      }
    }

    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, pad, pad, pad)
      background = GradientDrawable().apply {
        cornerRadius = resources.displayMetrics.density * 20
        setColor(Color.WHITE)
      }
    }

    card.addView(label("Rein 如何使用你的健康数据", 20f, true, Color.parseColor("#1C1C1E")))
    card.addView(
      label(
        "Rein 通过 Android 系统的 Health Connect 读取你的运动记录" +
          "（时长、消耗、距离、心率），用来计算运动强度与每日消耗。",
        15f, false, Color.parseColor("#3C3C43")
      )
    )
    card.addView(
      label(
        "只有在你打开「把 Rein 的运动回写出去」之后，Rein 才会把你记录的运动" +
          "写回 Health Connect；不开就只读不写。",
        15f, false, Color.parseColor("#3C3C43")
      )
    )
    card.addView(
      label(
        "这些数据只保存在你的设备上，Rein 不会上传到任何服务器；" +
          "你随时可以在系统设置的 Health Connect 里撤销授权。",
        15f, false, Color.parseColor("#3C3C43")
      )
    )

    val done = Button(this).apply {
      text = "知道了"
      isAllCaps = false
      setOnClickListener { finish() }
    }

    val root = ScrollView(this).apply {
      setBackgroundColor(Color.parseColor("#F2F2F7"))
      addView(
        LinearLayout(this@HealthRationaleActivity).apply {
          orientation = LinearLayout.VERTICAL
          gravity = Gravity.CENTER_HORIZONTAL
          setPadding(pad, pad * 2, pad, pad)
          addView(card)
          addView(
            done,
            ViewGroup.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.WRAP_CONTENT
            )
          )
        }
      )
    }
    setContentView(root)
  }
}
