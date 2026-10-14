package com.gozaoo.rein

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileWriter
import java.util.Locale
import org.json.JSONObject

/**
 * 跑步前台采集服务。
 *
 * **原生采集是运动真源**：页面不可见（锁屏/切后台）会让 WebView 注销
 * navigator.geolocation，所以取点、按 K/L 口径累计、落轨迹文件都在这里做；
 * 前端只消费快照（live/trackTake 走 pull，另有一条 evaluateJavascript push 做秒级平滑）。
 * 服务同时负责常驻通知的渲染与刷新（载荷由前端按 G 组好，原生只渲染、不判断）。
 *
 * 两类用途共用 NOTIFICATION_ID=41：
 *  · mode='location'：跑步/户外采集（location 前台服务类型，需定位权限）；
 *  · mode='specialUse'：训练课常驻通知（不取定位，Android 14+ 用 specialUse 类型）。
 *
 * fix 处理串行在定位回调所在的 HandlerThread 上（RunCore 不是线程安全的），
 * 轨迹文件缓冲 3 行或 1.5s flush；服务被杀/stopSelf/onTaskRemoved 都走同一套收尾。
 */
class RunTrackingService : Service() {
  companion object {
    /** logcat tag（契约固定；`adb logcat -s ReinRunTrack` 取证用） */
    const val TAG = "ReinRunTrack"
    const val CHANNEL_ID = "rein_tracking"
    const val NOTIFICATION_ID = 41
    private const val TRACK_DIR = "rein-run"
    /** 动作键「继续」：服务内动态注册的接收器派发 rein-workout-resume */
    private const val ACTION_RESUME = "com.gozaoo.rein.RUN_RESUME"
    const val EXTRA_MODE = "mode"
    const val EXTRA_RUN_ID = "runId"
    const val EXTRA_ENTER_SEC = "enterSecPerKm"
    const val EXTRA_EXIT_SEC = "exitSecPerKm"
    const val EXTRA_BASE_ELAPSED = "baselineElapsedMs"
    const val EXTRA_BASE_DIST = "baselineDistanceM"
    const val MODE_LOCATION = "location"
    const val MODE_SPECIAL_USE = "specialUse"
    private const val RESUME_TITLE = "继续"
    /** WakeLock 上限 8h：防异常路径下永久持有；正常由 stopService 释放 */
    private const val WAKELOCK_TIMEOUT_MS = 8L * 60 * 60 * 1000
    private const val FLUSH_LINES = 3
    private const val FLUSH_MS = 1_500L
    private const val LOG_FIX_EVERY = 5
    private const val LOG_AP_EVERY = 5

    /** 服务实例（通知渲染要它；空 = 没在跑，updateNotification 只缓存 payload） */
    @Volatile
    var instance: RunTrackingService? = null
      private set

    /** live 快照（pull 用；键序与契约 D 一致） */
    @Volatile
    var liveJson: String? = null
      private set

    /** 采集在跑（交付轨迹后能否删文件的判据） */
    @Volatile
    var collecting = false
      private set

    fun start(context: Context, intent: Intent): Unit =
      ContextCompat.startForegroundService(context, intent)

    fun stop(context: Context) {
      context.stopService(Intent(context, RunTrackingService::class.java))
    }

    /** 24h GC：删掉 rein-run 下除本次 runId 外、mtime 早于 24h 的文件 */
    fun gcTrackDir(filesDir: File, keepRunId: String) {
      val dir = File(filesDir, TRACK_DIR)
      val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
      dir.listFiles()?.forEach { f ->
        if (f.name != "$keepRunId.jsonl" && f.lastModified() < cutoff) f.delete()
      }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private var thread: HandlerThread? = null
  private var collectHandler: Handler? = null
  private var listener: LocationListener? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var mode = MODE_LOCATION

  private var core: RunCore? = null
  private var provider = ""
  private var lastFix: Fix? = null
  private var fixCount = 0
  private var judgeCount = 0

  private val ioLock = Any()
  private var writer: FileWriter? = null
  private val pending = ArrayList<String>(FLUSH_LINES)
  private val flushTick =
    object : Runnable {
      override fun run() {
        flushTrack()
        if (collecting) main.postDelayed(this, FLUSH_MS)
      }
    }

  private var lastPayload: String? = null
  private var laterRunnable: Runnable? = null

  /** 『继续』动作：服务内动态注册（必须 NOT_EXPORTED，防止外部应用伪造广播） */
  private val resumeReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != ACTION_RESUME) return
        pushJs("window.dispatchEvent(new CustomEvent('rein-workout-resume'))")
      }
    }

  private val locationListener =
    object : LocationListener {
      override fun onLocationChanged(location: Location) {
        try {
          handleFix(location)
        } catch (e: Exception) {
          // 采集不能因为一次异常停摆：记日志继续
          Log.w(TAG, "fix 处理失败", e)
        }
      }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel =
        NotificationChannel(
          CHANNEL_ID,
          "运动中",
          NotificationManager.IMPORTANCE_LOW, // 静默常驻，不打断跑步
        )
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
    ContextCompat.registerReceiver(
      this,
      resumeReceiver,
      IntentFilter(ACTION_RESUME),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    // 判定逻辑的规格取证：向量表跑一遍，失败会以 FAIL 行暴露在 logcat。
    // 唯一调用点（服务启动时一次，绝不在 fix 路径上跑）；debug/release 都跑，真机靠
    // `adb logcat -s ReinRunTrack` 看 apvector 行取证。放后台线程，不阻塞服务启动。
    Thread({
      val r = RunAutoPause.selfTest()
      r.lines.forEach { Log.i(TAG, it) }
      Log.i(TAG, "apvector pass=${r.pass} fail=${r.fail}")
    }, "rein-run-selftest").start()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    mode = intent?.getStringExtra(EXTRA_MODE) ?: MODE_LOCATION
    acquireWakeLock()
    // 竞态兜底：没等到新 payload 就先渲染上一份（lastPayload 在 run_begin 时被清过）
    lastPayload = TrackingBridge.lastPayload() ?: lastPayload
    val payload = lastPayload
    postForeground(payload?.let { build(it) } ?: defaultNotification())
    if (payload != null) {
      // 初始帧也走一次 render：payload 里的 later（如「休息结束」）需要调度
      renderNotification(payload)
    }
    if (mode == MODE_LOCATION) {
      val rid = intent?.getStringExtra(EXTRA_RUN_ID)
      if (rid != null) {
        startRun(
          rid,
          intent.getIntExtra(EXTRA_ENTER_SEC, 600),
          intent.getIntExtra(EXTRA_EXIT_SEC, 540),
          intent.getLongExtra(EXTRA_BASE_ELAPSED, 0L),
          intent.getDoubleExtra(EXTRA_BASE_DIST, 0.0),
        )
      } else {
        // 只拉起保活：默认阈值先采着，run_begin 到了再用基线/阈值重建（那一刻前的点会被截断丢弃）
        if (core == null) core = RunCore(600, 540)
        startUpdates()
      }
    }
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // 用户从最近任务划掉：写中断标记（下次进应用提示「那次跑步被中断」），收尾停服务
    try {
      val marker = File(cacheDir, "workout_interrupted")
      marker.writeText(
        """{"kind":"${if (mode == MODE_LOCATION) "run" else "course"}","atMs":${System.currentTimeMillis()}}""",
      )
    } catch (e: Exception) {
      Log.w(TAG, "写中断标记失败", e)
    }
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    instance = null
    // onCreate 注册的「继续」动作接收器必须成对注销，否则服务销毁时抛
    // IntentReceiverLeaked（真机实测：19:46:17 ActivityThread 的 E 行）
    try {
      unregisterReceiver(resumeReceiver)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "resumeReceiver 注销失败（未注册）", e)
    }
    shutdown()
    super.onDestroy()
  }

  /* ---------- 采集 ---------- */

  private fun startRun(
    rid: String,
    enterSecPerKm: Int,
    exitSecPerKm: Int,
    baselineElapsedMs: Long,
    baselineDistanceM: Double,
  ) {
    core = RunCore(enterSecPerKm, exitSecPerKm, baselineElapsedMs, baselineDistanceM)
    // 同 runId 且带基线（恢复续跑）→ 追加；否则新建/截断
    val dir = File(filesDir, TRACK_DIR).apply { mkdirs() }
    gcTrackDir(filesDir, rid)
    val file = File(dir, "$rid.jsonl")
    synchronized(ioLock) {
      try {
        writer?.close()
      } catch (e: Exception) {
        Log.w(TAG, "旧轨迹文件关闭失败", e)
      }
      pending.clear()
      writer = FileWriter(file, file.exists() && baselineElapsedMs > 0)
    }
    startUpdates()
    publishLive()
  }

  private fun startUpdates() {
    if (collecting) return
    val lm = getSystemService(LocationManager::class.java) ?: return
    val t = HandlerThread("rein-run-loc").also { it.start() }
    thread = t
    val h = Handler(t.looper)
    collectHandler = h
    val l = locationListener
    listener = l
    try {
      if (Build.VERSION.SDK_INT >= 31 && lm.allProviders.contains(LocationManager.FUSED_PROVIDER)) {
        // 只有 Builder(long) 这一个可用构造（(quality, interval) 那个不在 android.jar 里），
        // 质量用 setQuality 单独给：fused 优先，退化时下面走 GPS 的老接口
        val req =
          android.location.LocationRequest.Builder(1_000L)
            .setQuality(android.location.LocationRequest.QUALITY_HIGH_ACCURACY)
            .setMinUpdateIntervalMillis(500L)
            .build()
        // LocationRequest 重载只收 Executor（没有 Looper 版）：用它把回调按序投到采集线程
        lm.requestLocationUpdates(
          LocationManager.FUSED_PROVIDER,
          req,
          java.util.concurrent.Executor { r -> h.post(r) },
          l,
        )
        provider = "fused"
      } else {
        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1_000L, 0f, l, t.looper)
        provider = "gps"
      }
      collecting = true
      main.postDelayed(flushTick, FLUSH_MS)
    } catch (e: SecurityException) {
      // 无定位权限：服务留着（通知/保活仍在），但采集不可用
      Log.w(TAG, "无定位权限，采集未启动", e)
      collecting = false
      stopUpdates()
    }
  }

  private fun stopUpdates() {
    val lm = getSystemService(LocationManager::class.java)
    listener?.let { l ->
      try {
        lm.removeUpdates(l)
      } catch (e: Exception) {
        Log.w(TAG, "removeUpdates 失败", e)
      }
    }
    listener = null
    collecting = false
    main.removeCallbacks(flushTick)
    thread?.quitSafely()
    thread = null
    collectHandler = null
  }

  /** 相位切换（B4）：暂停时先结账自动暂停段；继续时判定器复位 */
  fun setPhase(newPhase: String) {
    val h = collectHandler
    if (h == null) return
    h.post {
      val c = core ?: return@post
      if (newPhase == "paused") {
        val settled = c.settleAutoPause(System.currentTimeMillis())
        c.setManualPaused(true)
        if (settled > 0) Log.i(TAG, "ap-settle ms=$settled（手动暂停结账）")
      } else {
        c.setManualPaused(false)
      }
      publishLive()
    }
  }

  /** 结束：停定位更新 → 结账自动暂停段 → 刷盘 → 停服务（通知消失、Wakelock 释放） */
  fun finishRun() {
    val h = collectHandler
    val finish = {
      core?.let { c ->
        val settled = c.settleAutoPause(System.currentTimeMillis())
        if (settled > 0) Log.i(TAG, "ap-settle ms=$settled（结束结账）")
      }
      stopUpdates()
      flushTrack()
      closeWriter()
      publishLive()
    }
    if (h == null) finish() else h.post(finish)
    stopSelf()
  }

  /* ---------- fix 处理（K/L 口径全在 RunCore） ---------- */

  private fun handleFix(loc: Location) {
    val c = core ?: return
    if (loc.time <= 0L) return
    val acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 99.0
    val fix = Fix(loc.time, loc.latitude, loc.longitude, acc)
    val out = c.onFix(fix)
    if (out.dropped) return // 精度门未过：不判定、不落盘、不推送

    provider = providerOf(loc)
    lastFix = fix
    if (out.accepted) {
      fixCount++
      val line = pointLine(loc, out)
      appendTrack(line)
      pushJs("window.__reinRunPoint && window.__reinRunPoint($line)")
      if (fixCount % LOG_FIX_EVERY == 0) {
        Log.i(
          TAG,
          "seq=$fixCount provider=$provider lat=${f6(fix.lat)} lon=${f6(fix.lon)} " +
            "acc=${f1(acc)} d=${f1(out.stepM)} dist=${f1(c.distM)} dispM=${f1(c.dispM)} " +
            "elapsed=${c.elapsedMs} ap=${c.autoPaused} " +
            "jt=${f1(out.jitterTurnDeg)} jc=${c.jitterCorrections}",
        )
      }
    }
    // 4 点方向防抖触发校正：逐次留证（seq= 每 5 个 fix 才打一条，抖动判定要看每一次）
    if (out.jitterCorrected) {
      Log.i(
        TAG,
        "jitter turn=${f1(out.jitterTurnDeg)} jc=${c.jitterCorrections} " +
          "step=${f1(out.stepM)} dist=${f1(c.distM)}",
      )
    }
    out.gap?.let { g ->
      val name =
        when (g) {
          GapKind.SLOW -> "slow"
          GapKind.FAST -> "fast"
          GapKind.DROP -> "drop"
        }
      Log.i(
        TAG,
        "gap=$name dt=${out.gapBucketMs} gapSpeed=${f2(out.gapSpeedMps)} d=${f1(out.stepM)} " +
          "dist=${f1(c.distM)} elapsed=${c.elapsedMs}",
      )
    }
    if (out.chordMps > 0.0) {
      judgeCount++
      if (judgeCount % LOG_AP_EVERY == 0 || out.entered || out.exited) {
        Log.i(
          TAG,
          "apcheck chord=${f2(out.chordMps)} in=${out.inStreak}/3 out=${out.outStreak}/2 " +
            "step2=${f2(out.step2Mps)} anchor=${f1(out.anchorM)} autoPaused=${c.autoPaused} jc=${c.jitterCorrections}",
        )
      }
    }
    publishLive()
  }

  /** 一行轨迹点（契约 E）：t=落账时刻的运动毫秒、acc=水平精度、alt/altAcc 缺失为 null */
  private fun pointLine(loc: Location, out: Outcome): String {
    val alt = if (loc.hasAltitude()) jnum(loc.altitude) else "null"
    val altAcc =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && loc.hasVerticalAccuracy()) {
        jnum(loc.verticalAccuracyMeters.toDouble())
      } else {
        "null"
      }
    return """{"t":${out.elapsedMs},"lat":${jnum(loc.latitude)},"lon":${jnum(loc.longitude)},"acc":${jnum(if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0)},"alt":$alt,"altAcc":$altAcc,"brk":${out.brk}}"""
  }

  /* ---------- 轨迹文件 ---------- */

  private fun appendTrack(line: String) {
    synchronized(ioLock) {
      pending.add(line)
      if (pending.size >= FLUSH_LINES) flushLocked()
    }
  }

  private fun flushTrack() {
    synchronized(ioLock) { flushLocked() }
  }

  private fun flushLocked() {
    val w = writer ?: return
    if (pending.isEmpty()) return
    try {
      pending.forEach {
        w.write(it)
        w.write("\n")
      }
      w.flush()
    } catch (e: Exception) {
      Log.w(TAG, "轨迹写盘失败", e)
    } finally {
      pending.clear()
    }
  }

  private fun closeWriter() {
    synchronized(ioLock) {
      flushLocked()
      try {
        writer?.close()
      } catch (e: Exception) {
        Log.w(TAG, "轨迹文件关闭失败", e)
      }
      writer = null
    }
  }

  /** 供 Rust trackTake 读取：整份文件原文（不存在 → 空串） */
  fun trackText(rid: String): String =
    try {
      val f = File(File(filesDir, TRACK_DIR), "$rid.jsonl")
      if (f.exists()) f.readText() else ""
    } catch (e: Exception) {
      Log.w(TAG, "读轨迹文件失败", e)
      ""
    }

  /** 交付后删除（Rust 侧在「采集未在跑 + 读到非空」时调） */
  fun dropTrack(rid: String) {
    try {
      File(File(filesDir, TRACK_DIR), "$rid.jsonl").delete()
    } catch (e: Exception) {
      Log.w(TAG, "删轨迹文件失败", e)
    }
  }

  /* ---------- live 快照 + JS 推送 ---------- */

  private fun publishLive() {
    val c = core ?: return
    val f = lastFix
    val pace = c.paceSecPerKm
    val json =
      buildString {
        append("""{"active":$collecting,"autoPaused":${c.autoPaused}""")
        append(""","elapsedMs":${c.elapsedMs},"distanceM":${jnum(c.distM)}""")
        append(""","paceSecPerKm":${pace?.let { jnum(it) } ?: "null"}""")
        append(""","lastFixMs":${f?.t ?: 0},"accM":${jnum(f?.acc ?: 0.0)}""")
        append(""","lat":${jnum(f?.lat ?: 0.0)},"lon":${jnum(f?.lon ?: 0.0)},"provider":"$provider"""")
        append(""","gapSlowCount":${c.gapSlowCount},"gapFastCount":${c.gapFastCount}""")
        append(""","gapDropCount":${c.gapDropCount},"gapSlowMs":${c.gapSlowMs}""")
        append(""","gapFastMs":${c.gapFastMs},"gapDropMs":${c.gapDropMs}""")
        append(""","gapCount":${c.gapCount},"gapMs":${c.gapMs}""")
        // 快通道显示距离（低滞后、单调不减）：只喂 hero 数字，权威仍是 distanceM
        append(""","dispM":${jnum(c.dispM)}}""")
      }
    liveJson = json
    pushJs("window.__reinRunLive && window.__reinRunLive($json)")
  }

  /** 主线程 evaluateJavascript 推送（WebView 找不到就静默：pull 会兜底） */
  private fun pushJs(js: String) {
    main.post {
      try {
        val act = MainActivity.current ?: return@post
        MainActivity.findWebView(act.window.decorView)?.evaluateJavascript(js, null)
      } catch (e: Exception) {
        Log.w(TAG, "推送页面失败（pull 兜底）", e)
      }
    }
  }

  /* ---------- 通知（G：只渲染，不判断） ---------- */

  private fun startForegroundCompat(n: Notification) {
    val type =
      when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> 0
        mode == MODE_SPECIAL_USE && Build.VERSION.SDK_INT >= 34 ->
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        mode == MODE_LOCATION -> ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        // Android 10~13 平台没有 specialUse 型：已持定位权限时借用 location 型，否则退化为普通通知
        hasLocationPermission() -> ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        else -> 0
      }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
    } catch (e: SecurityException) {
      Log.w(TAG, "startForeground 被拒（类型/权限不匹配），降级为普通通知", e)
    }
  }

  private fun postForeground(n: Notification) {
    if (Looper.myLooper() == Looper.getMainLooper()) startForegroundCompat(n)
    else main.post { startForegroundCompat(n) }
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    val held = wakeLock
    if (held != null && held.isHeld) return
    wakeLock =
      pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rein:run_tracking").also {
        it.setReferenceCounted(false)
        it.acquire(WAKELOCK_TIMEOUT_MS)
      }
  }

  private fun releaseWakeLock() {
    val held = wakeLock ?: return
    wakeLock = null
    if (held.isHeld) held.release()
  }

  /** 收尾：停采集 → 刷盘 → 释放 Wakelock → 取消通知（轨迹文件保留） */
  private fun shutdown() {
    try {
      stopUpdates()
      closeWriter()
      releaseWakeLock()
      getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
      main.removeCallbacks(flushTick)
      laterRunnable?.let { main.removeCallbacks(it) }
      laterRunnable = null
    } catch (e: Exception) {
      Log.w(TAG, "服务收尾失败", e)
    }
  }

  private fun defaultNotification(): Notification =
    buildBody(JSONObject("""{"kind":"run","phase":"running","title":"Rein · 户外跑"}""")).build()

  private fun build(payload: String): Notification =
    try {
      buildBody(JSONObject(payload)).build()
    } catch (e: Exception) {
      Log.w(TAG, "通知载荷解析失败，用默认文案", e)
      defaultNotification()
    }

  private fun buildBody(o: JSONObject): NotificationCompat.Builder {
    val b =
      NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE) // 锁屏只给脱敏副文
        .setPublicVersion(publicVersion())
        .setContentIntent(openIntent(o.optString("kind", "run")))
    b.setContentTitle(o.optString("title").ifEmpty { "Rein · 户外跑" })
    o.optString("text").takeIf { it.isNotEmpty() }?.let { b.setContentText(it) }
    o.optString("sub").takeIf { it.isNotEmpty() }?.let { b.setSubText(it) }
    o.optJSONObject("progress")?.let { p -> b.setProgress(p.optInt("max", 0), p.optInt("cur", 0), false) }
    o.optJSONObject("action")?.let { a ->
      if (a.optBoolean("resume", false)) {
        b.addAction(0, RESUME_TITLE, resumeIntent())
      }
    }
    // 逐相位 chronometer（G）：跑步正计时；自动/手动暂停停表（时长改由 text 冻结承载）
    when (o.optString("phase", "running")) {
      "running" -> {
        b.setUsesChronometer(true)
        b.setWhen(System.currentTimeMillis() - elapsedOf(o))
      }
      "autopause", "paused" -> {
        // 冻结时长 + 当前公里数：载荷没有距离字段，距离取原生真源
        b.setUsesChronometer(false)
        b.setContentText("${clock(elapsedOf(o))} · ${kmText()} km")
      }
      "summary" -> {
        b.setUsesChronometer(false)
        b.setContentText(o.optString("text").ifEmpty { "已完成 · 待保存" })
      }
      "rest" ->
        if (o.optBoolean("countdown", false)) {
          b.setUsesChronometer(true)
          b.setChronometerCountDown(true)
          b.setWhen(o.optLong("whenMs", System.currentTimeMillis()))
        } else b.setUsesChronometer(false)
      else -> b.setUsesChronometer(false)
    }
    // Android 16 的推广常驻通知：只写 extra（旧系统忽略未知 extra），不写断言
    b.addExtras(
      Bundle().apply {
        putBoolean("android.requestPromotedOngoing", true)
        putCharSequence("android.shortCriticalText", "跑步中")
      },
    )
    return b
  }

  /** 载荷优先（前端按冻结值下发），没有就用原生累计量 */
  private fun elapsedOf(o: JSONObject): Long =
    if (o.has("elapsedMs")) o.optLong("elapsedMs") else (core?.elapsedMs ?: 0L)

  private fun kmText(): String = "%.2f".format(Locale.US, (core?.distM ?: 0.0) / 1000.0)

  /** 锁屏可见的脱敏副文（不含坐标/配速细节） */
  private fun publicVersion(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle("Rein · 运动中")
      .setContentText("正在记录，解锁查看详情")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()

  /** 渲染一份载荷：写入通知 + 调度 one-shot later（替换 text/sub） */
  fun render(o: JSONObject) {
    if (o.optString("kind", "none") == "none") {
      // kind='none' 只撤通知、不动服务（本轮跑步/课程结束都走 runEnd / setKeepalive(false)）
      getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
      return
    }
    val n = buildBody(o).build()
    getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, n)
    scheduleLater(o.optJSONObject("later"))
  }

  /** 渲染一份前端组好的载荷（TrackingBridge 调用；解析失败只记日志，绝不让采集停摆） */
  fun renderNotification(payload: String) {
    lastPayload = payload
    try {
      render(JSONObject(payload))
    } catch (e: Exception) {
      Log.w(TAG, "通知载荷解析失败，丢弃", e)
    }
  }

  private fun scheduleLater(later: JSONObject?) {
    laterRunnable?.let { main.removeCallbacks(it) }
    laterRunnable = null
    if (later == null) return
    val delay = (later.optLong("whenMs", 0L) - System.currentTimeMillis()).coerceAtLeast(0L)
    val r =
      Runnable {
        val base = lastPayload ?: return@Runnable
        try {
          val o = JSONObject(base)
          o.put("text", later.optString("text", ""))
          o.put("sub", later.optString("sub", ""))
          render(o)
        } catch (e: Exception) {
          Log.w(TAG, "later 替换失败", e)
        }
      }
    laterRunnable = r
    main.postDelayed(r, delay)
  }

  /** 点通知回前台：带上 rein_open，MainActivity 落 SharedPreferences + pendingOpen */
  private fun openIntent(kind: String): PendingIntent {
    val i =
      Intent(this, MainActivity::class.java)
        .setAction(Intent.ACTION_MAIN)
        .addCategory(Intent.CATEGORY_LAUNCHER)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(TrackingBridge.EXTRA_OPEN, kind)
    return PendingIntent.getActivity(
      this,
      0,
      i,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun resumeIntent(): PendingIntent =
    PendingIntent.getBroadcast(
      this,
      1,
      Intent(ACTION_RESUME).setPackage(packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  /* ---------- 数值/字符串工具 ---------- */

  /**
   * JSON 数值：定点 + 去尾零（不用 Double.toString —— 它可能吐 1.0E-4 这种 JSON 合法但
   * 下游按字符串处理的写法；也不走默认 Locale —— 某些区域的小数点是逗号）。
   */
  private fun jnum(v: Double): String {
    if (!v.isFinite()) return "0"
    val s = "%.6f".format(Locale.US, v).trimEnd('0').trimEnd('.')
    return if (s.isEmpty() || s == "-") "0" else s
  }

  private fun f1(v: Double): String = "%.1f".format(Locale.US, v)

  private fun f2(v: Double): String = "%.2f".format(Locale.US, v)

  private fun f6(v: Double): String = "%.6f".format(Locale.US, v)

  private fun hasLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED

  private fun providerOf(loc: Location): String =
    when (loc.provider) {
      LocationManager.FUSED_PROVIDER -> "fused"
      LocationManager.GPS_PROVIDER -> "gps"
      LocationManager.NETWORK_PROVIDER -> "network"
      else -> ""
    }

  private fun clock(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(Locale.US, h, m, s)
    else "%02d:%02d".format(Locale.US, m, s)
  }
}
