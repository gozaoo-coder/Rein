package com.gozaoo.rein

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 跑步前台保活服务。
 *
 * 只负责保活，不自己采集坐标——定位仍由 WebView 的 navigator.geolocation 完成。
 * 有了 location 类型的前台服务 + partial WakeLock，锁屏后进程不会被降级为缓存进程
 * （冻结/回收），WebView 的 GPS watch、计时器和每 10s 的快照落盘才能持续运行；
 * 否则锁屏几分钟后整个应用会被系统杀掉，用户感知为「无法获取定位然后崩溃」。
 */
class RunTrackingService : Service() {
  companion object {
    private const val CHANNEL_ID = "rein_tracking"
    private const val NOTIFICATION_ID = 41
    /** WakeLock 上限 8h：防异常路径下永久持有；正常由 stopService 释放 */
    private const val WAKELOCK_TIMEOUT_MS = 8L * 60 * 60 * 1000

    fun start(context: Context): Unit {
      ContextCompat.startForegroundService(
        context,
        Intent(context, RunTrackingService::class.java),
      )
    }

    fun stop(context: Context): Unit {
      context.stopService(Intent(context, RunTrackingService::class.java))
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel =
        NotificationChannel(
          CHANNEL_ID,
          "运动中",
          NotificationManager.IMPORTANCE_LOW, // 静默常驻，不打断跑步
        )
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setContentTitle("Rein · 正在记录户外跑")
        .setContentText("定位与轨迹将在后台持续记录")
        .setOngoing(true)
        .build()
    // API 34+ 要求启动时即声明类型且已持定位权限（TrackingBridge 保证先授权再拉起）
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      } else {
        0
      },
    )
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock =
      pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rein:run_tracking").also {
        it.setReferenceCounted(false)
        it.acquire(WAKELOCK_TIMEOUT_MS)
      }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.release()
    wakeLock = null
    super.onDestroy()
  }
}
