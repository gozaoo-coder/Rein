package com.gozaoo.rein

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Rust(jni_handle.exec) ↔ Kotlin 的跑步保活桥。
 *
 * exec 是发后不管的（无返回值通道），所以状态查询走 snapshot()：
 * Rust 命令把「上次快照」缓存进静态变量，前端轮询 tracking_status 收敛到真值。
 *
 * - enable：已持定位权限 → 直接拉起前台服务；否则发起系统授权弹窗，
 *   授权结果回来后自动补拉服务。弹窗期间 snapshot 的 busy 为 true，
 *   前端据此等待；用户拒绝后 busy 立即回 false，前端马上降级为无 GPS。
 * - disable：停服务（未运行时为无害空操作）。
 *
 * 权限弹窗 launch 与服务的启停都必须在主线程执行（exec 本身就在
 * WebView 所在的主线程上回调，post 只是保险）。
 */
object TrackingBridge {
  private val main = Handler(Looper.getMainLooper())
  private var permissionLauncher: ActivityResultLauncher<Array<String>>? = null

  /** true = 已发起权限弹窗且用户尚未作答 */
  private var pendingRequest = false

  /** MainActivity.onCreate 调用一次：注册权限申请回调（必须在 Activity 创建后注册） */
  fun register(activity: ComponentActivity) {
    permissionLauncher =
      activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        grants ->
        pendingRequest = false
        val locationGranted =
          grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (locationGranted) {
          RunTrackingService.start(activity.applicationContext)
        }
      }
  }

  @JvmStatic
  fun enable(context: Context) {
    val app = context.applicationContext
    if (hasLocationPermission(app)) {
      main.post { RunTrackingService.start(app) }
    } else {
      pendingRequest = true
      main.post {
        val perms =
          buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (android.os.Build.VERSION.SDK_INT >= 33) {
              add(Manifest.permission.POST_NOTIFICATIONS)
            }
          }
        val launcher = permissionLauncher
        if (launcher != null) {
          launcher.launch(perms.toTypedArray())
        } else {
          // register 未执行（理论不可达）：放弃申请，前端按超时降级为无 GPS
          pendingRequest = false
          Log.w("TrackingBridge", "permissionLauncher 未注册，无法申请定位权限")
        }
      }
    }
  }

  @JvmStatic
  fun disable(context: Context) {
    val app = context.applicationContext
    pendingRequest = false
    main.post { RunTrackingService.stop(app) }
  }

  /** [定位权限已授予, 弹窗待答]，供 Rust 侧缓存刷新 */
  @JvmStatic
  fun snapshot(context: Context): BooleanArray =
    booleanArrayOf(hasLocationPermission(context.applicationContext), pendingRequest)

  private fun hasLocationPermission(context: Context): Boolean =
    isGranted(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
      isGranted(context, Manifest.permission.ACCESS_COARSE_LOCATION)

  private fun isGranted(context: Context, perm: String): Boolean =
    ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
}
