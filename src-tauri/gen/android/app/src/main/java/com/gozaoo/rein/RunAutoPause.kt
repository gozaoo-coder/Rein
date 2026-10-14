package com.gozaoo.rein

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt
import java.util.Locale

/**
 * 跑步采集的判定核心（纯 Kotlin object，无 Android 依赖）。
 *
 * 为什么单独一个文件：契约 K/L 的数值表只有一份运行时实现，必须能被 selfTest()
 * 用向量表独立验证（真机 `adb logcat -s ReinRunTrack` 看 `apvector pass/fail`），
 * 所以这里不掺 Android API、不做 IO —— 服务只负责「喂 fix / 拿 Outcome / 落盘推送」。
 *
 * 同一张向量表镜像在 Rust `modules/tracking/model.rs::spec`（`cargo test --lib tracking`），
 * 两边的数值必须一起改。
 *
 * 口径速览（细节见各处注释）：
 *  · 精度门 30m → 被接受 fix = 精度门 + dt≤10s + 单跳 ≤ max(40, 8×dt)
 *  · >10s 空窗走 slow/fast/drop 三分支（slow/drop 不计时不计距）
 *  · 自动暂停：W10 弦速 <1000/enter 连成 3 次进入；Wrec 弦速 ≥1000/exit 连成 2 次且
 *    最近两次单步速度达标、离锚点 ≥10m 退出
 *  · 4 点方向防抖：最近 4 个被接受点、三段航向累计转角 >90° → 最早 3 点取均值压成
 *    一个有效点（把原地漂移的之字形抹平）。距离/瞬时配速/自动暂停都只吃这条防抖后的流，
 *    代价是所有判定滞后约 3 个点（1Hz 下约 3s）
 *  · 常驻计时口径：每段墙钟只落进 elapsed / manualPause / autoPause / gap 四个桶之一
 *  · 快通道 dispM（显示专用低滞后估计）：与稳通道 distM 并行、每 fix 更新，只喂 hero
 *    距离数字（首帧 1s 内即出数）；不落盘、不参与判定/结算/成绩单。distM 仍是唯一权威。
 */

/* ---------- K/L 唯一数值表（改这里必须同步改 Rust model.rs::spec） ---------- */

/** 精度门：所有 fix 共用，>30m 丢弃、不参与任何判定/落盘 */
private const val ACC_GATE_M = 30.0
/** 被接受 fix 的最大间隔 */
private const val DT_ACCEPT_SEC = 10.0
/** 单跳上限 max(40, 8×dt) */
private const val DMAX_MIN_M = 40.0
private const val DMAX_DT_FACTOR = 8.0
/** 距上一个 fix >5s：本次判定跳过（暂停中保持暂停、未暂停不进入） */
private const val STALE_SKIP_SEC = 5.0
/** >10s 空窗走三分支 */
private const val GAP_MIN_SEC = 10.0
/** 空窗 slow/fast 分界 1.6667 m/s（=300 s/km，与 autoPauseOn 无关） */
private const val GAP_SLOW_MPS = 1.6667
/** 空窗 drop 判定的自适应上限 vMax = clamp(max(6.0, 1.5×vPrev60), 6.0, 10.0) */
private const val VMAX_FLOOR_MPS = 6.0
private const val VMAX_CEIL_MPS = 10.0
private const val VMAX_FACTOR = 1.5
private const val VMAX_BACK_SEC = 60.0
/** 常规路径 1s 窗口的距离地板（只滤距离，不滤时间） */
private const val DIST_FLOOR_MPS = 0.5
/** 瞬时配速（L5）：W10 可用 且 入账距离 ≥2m 且弦速 ≥0.8333 m/s */
private const val PACE_MIN_MPS = 0.8333
private const val PACE_MIN_DIST_M = 2.0
private const val PACE_STALE_SEC = 15.0
/** 进入判定（W10） */
private const val ENTER_WINDOW_SEC = 10.0
private const val ENTER_HOLD_SEC = 8.0
private const val ENTER_MIN_FIXES = 3
private const val ENTER_MIN_SPAN_SEC = 6.0
private const val ENTER_STREAK = 3
/** 退出判定（Wrec：自锚点起、独立窗口、不含暂停前的点） */
private const val EXIT_WINDOW_SEC = 6.0
private const val EXIT_MIN_FIXES = 2
private const val EXIT_MIN_SPAN_SEC = 3.0
private const val EXIT_HOLD_SEC = 5.0
private const val EXIT_STREAK = 2
private const val EXIT_ANCHOR_M = 10.0
private const val EXIT_CREDIT_MAX_M = 60.0
/**
 * 4 点方向防抖（用户口径）：最近 4 个被接受 fix 连成 3 段，各段航向转角之和
 * > 90° 即判为异常抖动（原地漂移的之字形），触发自动校正 ——
 * 最早 3 点取均值压成一个有效点（这一步把之字形抹平），只留「均值点 + 最后一点」，
 * 等下一个点继续算距离。距离、瞬时配速、自动暂停都吃这条防抖后的流。
 */
private const val JITTER_WINDOW = 4
private const val JITTER_MAX_TURN_DEG = 90.0

/* ---------- 快通道 / 呈现常量（不参与稳通道的任何判定） ---------- */

/** hero 显示非零门：dispM ≥ 1m 才显数位（呈现层用作「首个非零」的判据） */
private const val DISP_MIN_M = 1.0

/** hero 呈现阈值：<100m 显整数米、≥100m 显 km 两位小数（同一规则实现在 RunPage.vue 的 heroDist） */
private const val HERO_METER_MAX_M = 100.0

/** 与前端 utils/geo.ts 同式（R=6371000） */
internal fun haversineM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
  val r = 6_371_000.0
  val rad = Math.PI / 180.0
  val dLat = (lat2 - lat1) * rad
  val dLon = (lon2 - lon1) * rad
  val a = sin(dLat / 2).pow(2) + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLon / 2).pow(2)
  return 2 * r * asin(sqrt(a))
}

/** 一个定位点（精度门之前的原始输入） */
data class Fix(val t: Long, val lat: Double, val lon: Double, val acc: Double)

enum class GapKind { SLOW, FAST, DROP }

/** 一次 fix 的完整结论（字段与 Rust model.rs::spec::Outcome 一一对应） */
class Outcome {
  /** 精度门未过：不判定、不落盘 */
  var dropped = false

  /** 单跳 d>dMax 丢弃（jumpCount++） */
  var jumped = false

  /** 被接受 fix：落点 + 写轨迹 + 计距离时长 */
  var accepted = false

  /** 该点 brk=true（空窗后 / 自动暂停恢复后的第一个点） */
  var brk = false
  var gap: GapKind? = null

  /** 本段空窗墙钟（进对应 gap 桶） */
  var gapBucketMs = 0L

  /** 空窗均速（logcat 的 gapSpeed=） */
  var gapSpeedMps = 0.0

  /** fast 空窗补记的距离 */
  var gapCreditM = 0.0
  var autoPaused = false
  var entered = false
  var exited = false

  /** 退出一次性补距（clamp 到 0..60） */
  var exitCreditM = 0.0

  /** 退出时结账的自动暂停墙钟 */
  var autoPauseSettleMs = 0L

  /** 瞬时配速（口径见 L5） */
  var paceSecPerKm: Double? = null

  /** 累计量（含本次） */
  var distM = 0.0
  var elapsedMs = 0L

  /**
   * 快通道显示距离的搬运副本：恒等于 RunCore.dispM（onFix 的每条返回路径都赋值）。
   * 显示层读它（live JSON 的 dispM）；权威读数仍是 RunCore.dispM。
   */
  var dispM = 0.0

  /** 本次入账量 */
  var distDeltaM = 0.0
  var elapsedDeltaMs = 0L

  /** 本次 fix 与上一个通过精度门 fix 的直线距离（logcat 的 d=） */
  var stepM = 0.0

  /** 判定取证（apcheck 行用） */
  var chordMps = 0.0
  var inStreak = 0
  var outStreak = 0
  var step2Mps = 0.0
  var anchorM = 0.0

  /** 4 点方向防抖：本次窗口三段累计转角（度）与是否触发了校正（logcat jt=/jc=） */
  var jitterTurnDeg = 0.0
  var jitterCorrected = false
}

/**
 * 采集核心：K/L 口径的唯一运行时实现。
 * 线程约束：只在定位回调所在的 HandlerThread 上调用（服务串行喂点）。
 */
class RunCore(
  private val enterSecPerKm: Int,
  private val exitSecPerKm: Int,
  baselineElapsedMs: Long = 0L,
  baselineDistanceM: Double = 0.0,
) {
  val enabled = enterSecPerKm > 0

  /* 累计量（真源） */
  var elapsedMs = max(0L, baselineElapsedMs)
    private set
  var distM = max(0.0, baselineDistanceM)
    private set

  /**
   * 快通道（显示专用低滞后距离）：单调不减、恒 ≤ 1Hz 折线长度。
   * 只喂 hero 距离数字；不落盘、不参与判定/结算/成绩单。权威仍是 distM。
   * 初值与 distM 同 clamp（恢复续跑时等于基线距离）。
   */
  var dispM = max(0.0, baselineDistanceM)
    private set

  var autoPaused = false
    private set
  var paceSecPerKm: Double? = null
    private set

  /* 计数器（四类桶逐段互斥，见 H） */
  var autoPauseCount = 0
    private set
  var autoPauseMs = 0L
    private set
  var gapMs = 0L
    private set
  var gapSlowCount = 0
    private set
  var gapFastCount = 0
    private set
  var gapDropCount = 0
    private set
  var gapSlowMs = 0L
    private set
  var gapFastMs = 0L
    private set
  var gapDropMs = 0L
    private set
  var jumpCount = 0
    private set

  val gapCount: Int get() = gapSlowCount + gapFastCount + gapDropCount

  /* 内部状态 */
  private class WinFix(val t: Long, val d: Double, val credit: Double, val accepted: Boolean)
  private class Judge(val t: Long, val ok: Boolean)
  private class Recent(val t: Long, val credit: Double)

  private var lastAcc: Fix? = null
  private val win = ArrayDeque<WinFix>()
  private val judgeIn = ArrayDeque<Judge>()
  private val judgeOut = ArrayDeque<Judge>()
  private val steps = ArrayDeque<Double>()
  private var anchor: Fix? = null
  private val recent = ArrayDeque<Recent>()
  private var pendingD = 0.0
  private var pendingT0: Long? = null
  private var lastMoveMs = 0L
  private var pendingBrk = false
  private var manualPaused = false

  /** 快通道的当前 running 段锚点（显示专用）；null = 需要在新一段的第一个 accepted fix 落座 */
  private var segAnchor: GuardPoint? = null

  /* 4 点方向防抖：待确认点（还不是有效路径的一部分）+ 上一个已确认的有效点 */
  private class GuardPoint(val t: Long, val lat: Double, val lon: Double)

  private class GuardStep(val m: Double, val dtSec: Double, val atMs: Long)

  private val guard = ArrayDeque<GuardPoint>()
  private var validTail: GuardPoint? = null

  /** 方向防抖触发校正的次数（logcat jc=） */
  var jitterCorrections = 0
    private set

  private fun dMax(dtSec: Double): Double = max(DMAX_MIN_M, DMAX_DT_FACTOR * dtSec)

  /**
   * 窗口内三段航向的累计转角（度）：各段转角归一化到 (-180,180] 后求和。
   * 零位移段不计航向 —— 两个 fix 重合（或几乎重合）时航向纯属噪声，
   * 把它算进去会让「站着不动」永远判成抖动之外的随机值。
   */
  private fun guardTurnDeg(): Double {
    var total = 0.0
    var prev: Double? = null
    for (i in 0 until guard.size - 1) {
      val a = guard[i]
      val b = guard[i + 1]
      val north = b.lat - a.lat
      val east = (b.lon - a.lon) * cos(Math.toRadians((a.lat + b.lat) / 2.0))
      if (north == 0.0 && east == 0.0) continue
      val brg = Math.toDegrees(Math.atan2(east, north)) // 0=正北，顺时针为正
      val p = prev
      if (p != null) {
        var diff = brg - p
        while (diff > 180.0) diff -= 360.0
        while (diff < -180.0) diff += 360.0
        total += if (diff < 0.0) -diff else diff
      }
      prev = brg
    }
    return total
  }

  /** 把一个点确认为有效点：返回「上一个有效点 → 它」的步长与真实间隔 */
  private fun commitValid(p: GuardPoint): GuardStep {
    val prev = validTail
    validTail = p
    if (prev == null) return GuardStep(0.0, 0.0, p.t)
    return GuardStep(
      m = haversineM(prev.lat, prev.lon, p.lat, p.lon),
      dtSec = max(0.0, (p.t - prev.t) / 1000.0),
      atMs = p.t,
    )
  }

  /**
   * 4 点方向防抖：喂进一个被接受 fix，返回这一段有效步长（dt=0 = 还在攒窗口，别当距离用）。
   *
   * · 转角 ≤90°：窗口最早那点被确认为有效点，窗口滑一格。
   * · 转角 >90°：最早 3 点取均值压成一个有效点（把之字形抹平），窗口只留
   *   「均值点 + 最后一点」，等下一个点继续 —— 用户口径原文即此。
   */
  private fun guardStep(f: Fix, out: Outcome): GuardStep {
    guard.addLast(GuardPoint(f.t, f.lat, f.lon))
    while (guard.size > JITTER_WINDOW) guard.removeFirst()
    if (guard.size < JITTER_WINDOW) return GuardStep(0.0, 0.0, f.t)

    val turn = guardTurnDeg()
    out.jitterTurnDeg = turn
    if (turn > JITTER_MAX_TURN_DEG) {
      val a = guard[0]
      val b = guard[1]
      val c = guard[2]
      val last = guard[3]
      val mean =
        GuardPoint(
          t = last.t,
          lat = (a.lat + b.lat + c.lat) / 3.0,
          lon = (a.lon + b.lon + c.lon) / 3.0,
        )
      guard.clear()
      guard.addLast(mean)
      guard.addLast(last)
      jitterCorrections++
      out.jitterCorrected = true
      return commitValid(mean)
    }
    return commitValid(guard.removeFirst())
  }

  /** 复位防抖窗口；seed 非空时以它为新的有效起点（暂停/空窗后接管位移基准） */
  private fun resetGuard(seed: Fix?) {
    guard.clear()
    validTail = seed?.let { GuardPoint(it.t, it.lat, it.lon) }
  }

  /** 防抖步长并进「最近两次单步速度」；dt=0 的攒窗口期不产生速度 */
  private fun applyGuardStep(gs: GuardStep, out: Outcome) {
    if (gs.dtSec <= 0.0) return
    steps.addLast(gs.m / gs.dtSec)
    while (steps.size > 2) steps.removeFirst()
    out.step2Mps = step2()
  }

  /**
   * 更新快通道（只在 fix 被接受时调用，且必须落在「本分支对 pendingD 的最后一次写
   * 之后、win 入队之前」）：
   *   steady = distM + pendingD          （稳通道已入账 + 已确认未提交段）
   *   net    = haversine(segAnchor, fix) （当前 running 段的弦长下界）
   *   dispM  = max(dispM, net, steady)   （单调不减；两项都是真路径长度的下界）
   * 段锚点复位：brk=true / 段内第一个 accepted fix（segAnchor==null）落座；
   * setManualPaused(true) 与 settleAutoPause() 置 null；enter() 不动（进入后无 accepted fix，
   * 退出由 brk 覆盖）。
   */
  private fun fastChannel(f: Fix, brk: Boolean) {
    if (brk) segAnchor = null
    val a = segAnchor ?: GuardPoint(f.t, f.lat, f.lon).also { segAnchor = it }
    val net = haversineM(a.lat, a.lon, f.lat, f.lon)
    val steady = distM + pendingD
    val v = if (net > steady) net else steady
    if (v > dispM) dispM = v
  }

  private fun vEnter(): Double = 1000.0 / max(1, enterSecPerKm)
  private fun vExit(): Double = 1000.0 / max(1, exitSecPerKm)

  /** 最近两次单步速度的较小值（apcheck 的 step2；全无取 0） */
  private fun step2(): Double = steps.minOrNull() ?: 0.0

  /** 连续满足的判定数（从队尾往回数）——即 apcheck 的 in=/out= */
  private fun streak(q: ArrayDeque<Judge>): Int {
    var n = 0
    for (i in q.indices.reversed()) {
      if (q[i].ok) n++ else break
    }
    return n
  }

  private fun trimWindows(now: Long) {
    while (true) {
      val w = win.firstOrNull() ?: break
      if ((now - w.t) / 1000.0 > ENTER_WINDOW_SEC) win.removeFirst() else break
    }
    while (true) {
      val j = judgeIn.firstOrNull() ?: break
      if ((now - j.t) / 1000.0 > ENTER_HOLD_SEC) judgeIn.removeFirst() else break
    }
    while (true) {
      val j = judgeOut.firstOrNull() ?: break
      if ((now - j.t) / 1000.0 > EXIT_HOLD_SEC) judgeOut.removeFirst() else break
    }
  }

  private fun pushRecent(t: Long, credit: Double) {
    recent.addLast(Recent(t, credit))
    while (true) {
      val r = recent.firstOrNull() ?: break
      if ((t - r.t) / 1000.0 > VMAX_BACK_SEC) recent.removeFirst() else break
    }
  }

  /** 空窗前 60s 内被接受 fix 的平均速度（无数据则 0）——vMax 自适应的输入 */
  private fun vPrev60(beforeT: Long): Double {
    val lo = beforeT - (VMAX_BACK_SEC * 1000).toLong()
    val it = recent.filter { it.t >= lo }
    if (it.size < 2) return 0.0
    val span = (it.last().t - it.first().t) / 1000.0
    if (span <= 0.0) return 0.0
    return it.sumOf { r -> r.credit } / span
  }

  /** 进入判定窗口：墙钟最近 10s 内、被接受的 fix（含当前） */
  private fun w10(now: Long): List<WinFix> {
    val lo = now - (ENTER_WINDOW_SEC * 1000).toLong()
    return win.filter { it.accepted && it.t >= lo }
  }

  /**
   * 一次 fix 的完整处理。顺序即契约顺序：精度门 → 手动暂停 → 自动暂停 →
   * 空窗三分支 → 常规路径（L1/L4/L5 + 进入判定）。
   */
  fun onFix(f: Fix): Outcome {
    val out = Outcome()
    out.autoPaused = autoPaused
    out.distM = distM
    out.dispM = dispM
    out.elapsedMs = elapsedMs
    out.paceSecPerKm = paceSecPerKm

    // 精度门（NaN 也落这里）
    if (!(f.acc <= ACC_GATE_M)) {
      out.dropped = true
      out.dispM = dispM
      return out
    }
    val prev = lastAcc
    val dtSec = if (prev != null) (f.t - prev.t) / 1000.0 else 0.0
    val d = if (prev != null) haversineM(prev.lat, prev.lon, f.lat, f.lon) else 0.0
    val stale = prev != null && dtSec > STALE_SKIP_SEC
    out.stepM = d
    out.step2Mps = step2()
    // L5：距上一个被接受 fix >15s，瞬时配速失效
    if (lastMoveMs > 0 && f.t - lastMoveMs > (PACE_STALE_SEC * 1000).toLong()) {
      paceSecPerKm = null
    }

    // 手动暂停：全部判定跳过（链/锚点已由 setManualPaused 清），只让窗口自然滑动
    if (manualPaused) {
      win.addLast(WinFix(f.t, d, 0.0, false))
      trimWindows(f.t)
      lastAcc = f
      out.paceSecPerKm = paceSecPerKm
      out.dispM = dispM
      return out
    }

    // 自动暂停中：不是被接受 fix（不落点/不写文件/不进 W10），通过精度门者进 Wrec
    if (autoPaused) {
      val gs = guardStep(f, out)
      applyGuardStep(gs, out)
      // credit 只给退出判定用（防抖后的流）；暂停期的入账恒为 0，不进 distM
      win.addLast(WinFix(f.t, d, gs.m, false))
      trimWindows(f.t)
      if (!stale && enabled) evalExit(f, out)
      lastAcc = f
      out.autoPaused = autoPaused
      out.distM = distM
      out.dispM = dispM
      out.elapsedMs = elapsedMs
      out.paceSecPerKm = paceSecPerKm
      return out
    }

    // >10s 空窗：不走 L1，走三分支（d=两端直线距离、gapSpeed=d/dt）
    if (prev != null && dtSec > GAP_MIN_SEC) {
      handleGap(f, prev, dtSec, d, out)
      return out
    }

    // 单跳 d>dMax：丢弃该 fix（契约字面「丢弃」——参考点不跟进；漂移是瞬时的，
    // 下一个真实 fix 若回到附近会照常入账）
    if (prev != null && d > dMax(dtSec)) {
      jumpCount++
      out.jumped = true
      out.dispM = dispM
      return out
    }

    // —— 常规路径：被接受 fix（距离/配速/判定都只吃 4 点防抖后的步长）——
    val gs = guardStep(f, out)
    applyGuardStep(gs, out)
    if (prev != null) {
      val dtMs = (dtSec * 1000.0).roundToLong()
      elapsedMs += dtMs
      out.elapsedDeltaMs = dtMs
      // L4：攒满 1s 提交一次；窗口均速 ≥0.5 m/s 才入账距离（地板只滤距离）。
      // 窗口的起止都取「有效点」的时间轴，免得防抖的 3 点预热把窗口拉长、把均速摊薄。
      if (gs.dtSec > 0.0) {
        val t0 = pendingT0 ?: (gs.atMs - (gs.dtSec * 1000.0).roundToLong()).also { pendingT0 = it }
        pendingD += gs.m
        val winSec = (gs.atMs - t0) / 1000.0
        if (winSec >= 1.0) {
          if (pendingD / winSec >= DIST_FLOOR_MPS) {
            out.distDeltaM = pendingD
            distM += pendingD
            lastMoveMs = gs.atMs
          }
          pendingD = 0.0
          pendingT0 = null
        }
      }
    }
    out.accepted = true
    out.brk = pendingBrk.also { pendingBrk = false }
    // 快通道：pendingD 已更新完（上面 L4 段）、win 入队之前 —— 唯一插入点
    fastChannel(f, out.brk)
    win.addLast(WinFix(f.t, d, out.distDeltaM, true))
    pushRecent(f.t, out.distDeltaM)
    trimWindows(f.t)

    // L5 + 进入判定共用同一个 W10 弦速
    if (!stale) {
      val w = w10(f.t)
      if (w.size >= ENTER_MIN_FIXES) {
        val span = (w.last().t - w.first().t) / 1000.0
        if (span >= ENTER_MIN_SPAN_SEC) {
          val sum = w.sumOf { it.credit }
          val chord = sum / span
          out.chordMps = chord
          if (sum >= PACE_MIN_DIST_M && chord >= PACE_MIN_MPS) {
            val inst = 1000.0 / chord
            val p = paceSecPerKm
            paceSecPerKm = if (p == null) inst else p * 0.7 + inst * 0.3
          }
          if (enabled) judgeIn.addLast(Judge(f.t, chord < vEnter()))
        }
      }
    }
    out.inStreak = streak(judgeIn)
    if (enabled && !stale && streak(judgeIn) >= ENTER_STREAK) enter(f, out)
    lastAcc = f
    out.autoPaused = autoPaused
    out.distM = distM
    out.dispM = dispM
    out.elapsedMs = elapsedMs
    out.paceSecPerKm = paceSecPerKm
    return out
  }

  private fun handleGap(f: Fix, p: Fix, dtSec: Double, d: Double, out: Outcome) {
    val gapMs = f.t - p.t
    val gapSpeed = if (dtSec > 0.0) d / dtSec else 0.0
    val vmax = min(max(VMAX_FACTOR * vPrev60(p.t), VMAX_FLOOR_MPS), VMAX_CEIL_MPS)
    val kind =
      when {
        gapSpeed < GAP_SLOW_MPS -> GapKind.SLOW
        gapSpeed <= vmax -> GapKind.FAST
        else -> GapKind.DROP
      }
    this.gapMs += gapMs
    when (kind) {
      GapKind.SLOW -> {
        // 不计时不计距，只进 gap 桶（与 autoPauseOn 无关）
        gapSlowCount++
        gapSlowMs += gapMs
      }
      GapKind.FAST -> {
        val credit = min(d, dMax(dtSec))
        gapFastCount++
        gapFastMs += gapMs
        distM += credit
        elapsedMs += gapMs
        lastMoveMs = f.t
        out.distDeltaM = credit
        out.elapsedDeltaMs = gapMs
        out.gapCreditM = credit
      }
      GapKind.DROP -> {
        gapDropCount++
        gapDropMs += gapMs
      }
    }
    out.gap = kind
    out.gapBucketMs = gapMs
    out.gapSpeedMps = gapSpeed
    out.accepted = true
    out.brk = true
    pendingD = 0.0
    pendingT0 = null
    pendingBrk = false
    resetGuard(f) // 空窗是新一段的起点：防抖窗口从它重新攒
    // 快通道：pendingD 已清零（上面）之后、win 入队之前 —— 空窗必 brk，段锚点在此重落座
    fastChannel(f, true)
    win.addLast(WinFix(f.t, d, out.distDeltaM, true))
    pushRecent(f.t, out.distDeltaM)
    trimWindows(f.t)
    lastAcc = f
    out.autoPaused = autoPaused
    out.distM = distM
    out.dispM = dispM
    out.elapsedMs = elapsedMs
    out.paceSecPerKm = paceSecPerKm
  }

  private fun enter(f: Fix, out: Outcome) {
    autoPaused = true
    autoPauseCount++
    anchor = f
    pendingD = 0.0
    pendingT0 = null
    // 暂停点即新的有效起点：退出判定的位移从它起算（防抖窗口也在这里重新攒）
    resetGuard(f)
    // 翻转后两条链都从头累计，防旧判定把状态立刻推回去
    judgeIn.clear()
    judgeOut.clear()
    out.entered = true
  }

  private fun evalExit(f: Fix, out: Outcome) {
    val a = anchor ?: return
    val lo = f.t - (EXIT_WINDOW_SEC * 1000).toLong()
    val w = win.filter { it.t >= a.t && it.t >= lo }
    val anchorM = haversineM(a.lat, a.lon, f.lat, f.lon)
    out.anchorM = anchorM
    if (w.size >= EXIT_MIN_FIXES) {
      val span = (w.last().t - w.first().t) / 1000.0
      if (span >= EXIT_MIN_SPAN_SEC) {
        val sum = w.sumOf { it.credit } // credit = 防抖后的步长（暂停期照样在算，只是不入 distM）
        val chord = sum / span
        out.chordMps = chord
        judgeOut.addLast(Judge(f.t, chord >= vExit()))
      }
    }
    out.outStreak = streak(judgeOut)
    val cond1 = streak(judgeOut) >= EXIT_STREAK
    val cond2 = steps.size >= 2 && steps.all { it >= vExit() }
    val cond3 = anchorM >= EXIT_ANCHOR_M
    if (cond1 && cond2 && cond3) {
      // 一次性补距：暂停期累计量是冻结的，字面「累计距离_now − 锚点累计距离」恒为 0；
      // 按契约意图补「暂停段位移」（clamp 0..60），即 2 m/s 走 5s → 10m。
      val credit = min(max(anchorM, 0.0), EXIT_CREDIT_MAX_M)
      distM += credit
      val settle = max(0L, f.t - a.t)
      autoPauseMs += settle
      out.exitCreditM = credit
      out.autoPauseSettleMs = settle
      out.distDeltaM = credit
      autoPaused = false
      anchor = null
      pendingBrk = true // 恢复后的第一个点 brk=true
      judgeIn.clear()
      judgeOut.clear()
      out.exited = true
    }
    out.autoPaused = autoPaused
  }

  /** 结账当前自动暂停段（退出之外的路径：手动暂停 / 结束 / 服务停）：返回结账墙钟 */
  fun settleAutoPause(nowMs: Long): Long {
    if (!autoPaused) return 0
    val ms = anchor?.let { max(0L, nowMs - it.t) } ?: 0L
    autoPauseMs += ms
    autoPaused = false
    anchor = null
    judgeIn.clear()
    judgeOut.clear()
    pendingD = 0.0
    pendingT0 = null
    resetGuard(null)
    segAnchor = null // 快通道：结账后新一段的第一个 accepted fix 重新落座
    return ms
  }

  /**
   * 手动相位（B4）：暂停 = 判定全跳过 + 链清零 + 锚点清空 + autoPaused 置 false；
   * 继续 = 判定器复位（W10/Wrec 按滑动自然刷新）。
   */
  fun setManualPaused(paused: Boolean) {
    manualPaused = paused
    if (paused) {
      autoPaused = false
      anchor = null
      segAnchor = null // 快通道：手动暂停期间不记距，恢复后新一段重新落座
    }
    judgeIn.clear()
    judgeOut.clear()
    steps.clear()
    pendingD = 0.0
    pendingT0 = null
    resetGuard(null)
  }
}

/* ---------- K 向量表（同一张表镜像在 Rust model.rs::spec；selfTest 在 debug 启动跑） ---------- */

class VectorResult(val name: String, val ok: Boolean, val detail: String)

class SelfTestResult(val pass: Int, val fail: Int, val lines: List<String>)

/** 真机量级的 epoch ms */
private const val START_T = 1_760_000_000_000L
private const val LAT0 = 31.2301
private const val LON0 = 121.4702

/**
 * 站立抖动（≤1m，相邻位移 0.6~0.8m —— 真机常见量级：
 * 步长低于 L4 的 0.5 m/s 地板时距离不入账，退出窗口的弦速也会晚一步跨过阈值）
 */
private val JITTER = doubleArrayOf(0.0, 0.8, 0.1, 0.9, 0.2, 0.8, 0.0, 0.7)

/** 站立游走 ±3m（相邻位移 ≤1.3m） */
private val WANDER =
  doubleArrayOf(
    0.0, 0.9, 1.8, 2.7, 1.9, 1.0, 0.2, -0.7, -1.6, -2.5, -3.0, -2.1, -1.2, -0.3, 0.6, 1.5,
    2.4, 3.0, 2.2, 1.3, 0.4, -0.5, -1.4, -2.3, -1.4, -0.5, 0.4, 1.3,
  )

/** 沿经线位移：haversine 沿经线恰为 R×Δφ，用它生成的点距离可控 */
private fun moveLat(lat: Double, northM: Double): Double =
  lat + northM / 6_371_000.0 * (180.0 / Math.PI)

/** 匀速直线：fix i 在 startLat 往北 i×speed×dt 米处；返回 (fixes, 末尾继续沿该方向的下一纬度) */
private fun runFixes(
  t0: Long,
  dtMs: Long,
  n: Int,
  speedMps: Double,
  startLat: Double,
  acc: Double = 5.0,
): Pair<List<Fix>, Double> {
  val stepM = speedMps * (dtMs / 1000.0)
  val out = ArrayList<Fix>(n)
  for (i in 0 until n) {
    out.add(Fix(t0 + i * dtMs, moveLat(startLat, stepM * i), LON0, acc))
  }
  return out to moveLat(startLat, stepM * n)
}

/** 站立：按固定偏移表在中心附近游走 */
private fun standFixes(
  t0: Long,
  dtMs: Long,
  n: Int,
  offsets: DoubleArray,
  centerLat: Double,
): List<Fix> = (0 until n).map { i -> Fix(t0 + i * dtMs, moveLat(centerLat, offsets[i % offsets.size]), LON0, 5.0) }

/* ---------- 快通道向量表用的 2D 生成器（逐位复刻 .zcode/tmp 的 JS 参考内核） ---------- */

/** 向量表的拓扑时间尺度：1Hz、N 点、3 m/s */
private const val VEC_N = 101
private const val VEC_V = 3.0

/**
 * 局部 ENU → WGS84（与 JS 参考内核 enuToLatLon 逐字同式）：
 * lat 用 north 推、lon 再用推出来的 lat 算 cos 修正。
 */
private fun enuToLatLon(east: Double, north: Double): Pair<Double, Double> {
  val r = 6_371_000.0
  val r2d = 180.0 / Math.PI
  val lat = LAT0 + north / r * r2d
  val lon = LON0 + east / (r * cos(lat * Math.PI / 180.0)) * r2d
  return lat to lon
}

/**
 * mulberry32 PRNG（逐位复刻 JS：Int 按 32 位回绕即 Math.imul 语义）。
 * 种子与调用序必须与 .zcode/tmp 的脚本一致，否则 seed 族数值对不上。
 */
private class Mulberry32(seed: Int) {
  private var a = seed

  fun next(): Double {
    a += 0x6D2B79F5
    var t = (a xor (a ushr 15)) * (1 or a)
    t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
    return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4_294_967_296.0
  }
}

/** 5m 折返：沿正北来回，每 A/V 秒掉头一次 */
private fun genTurnback(amp: Double): List<DoubleArray> {
  val legT = amp / VEC_V
  return (0 until VEC_N).map { i ->
    val cyc = i / legT
    val k = floor(cyc).toInt()
    val f = cyc - k
    doubleArrayOf(0.0, if (k % 2 == 0) amp * f else amp * (1.0 - f))
  }
}

/** 绕圈：半径 r，角速度 V/r */
private fun genCircle(radius: Double): List<DoubleArray> {
  val w = VEC_V / radius
  return (0 until VEC_N).map { i ->
    val th = w * i
    doubleArrayOf(radius * sin(th), radius * (1.0 - cos(th)))
  }
}

/** 400m 标准场：直道 84.39m + 两个半径 36.5m 的半圆 */
private fun genTrack(): List<DoubleArray> {
  val l = 84.39
  val rr = 36.5
  val lap = 2 * l + 2 * Math.PI * rr
  return (0 until VEC_N).map { i ->
    val s = (VEC_V * i) % lap
    when {
      s < l -> doubleArrayOf(0.0, s)
      s < l + Math.PI * rr -> {
        val a = (s - l) / rr
        doubleArrayOf(rr * (1.0 - cos(a)), l + rr * sin(a))
      }
      s < 2 * l + Math.PI * rr -> doubleArrayOf(2 * rr, l - (s - (l + Math.PI * rr)))
      else -> {
        val a = (s - (2 * l + Math.PI * rr)) / rr
        doubleArrayOf(2 * rr * cos(a), -rr * sin(a))
      }
    }
  }
}

/** 直线 3 m/s */
private fun genStraight(): List<DoubleArray> = (0 until VEC_N).map { i -> doubleArrayOf(0.0, VEC_V * i) }

/** 自由跑：航向随机游走（±sd°/s），步长恒 V */
private fun genRandom(seed: Int, sd: Double): List<DoubleArray> {
  val rnd = Mulberry32(seed)
  var hd = 0.0
  var e = 0.0
  var n = 0.0
  val pts = ArrayList<DoubleArray>(VEC_N)
  pts.add(doubleArrayOf(0.0, 0.0))
  for (i in 1 until VEC_N) {
    hd += (rnd.next() - 0.5) * 2.0 * sd
    e += VEC_V * sin(hd * Math.PI / 180.0)
    n += VEC_V * cos(hd * Math.PI / 180.0)
    pts.add(doubleArrayOf(e, n))
  }
  return pts
}

/** V18 下界性搜索用的走位：航向随机游走 + 偶发大转角 + 步长抖动 */
private fun genBound(seed: Int, sd: Double, turnProb: Double): List<DoubleArray> {
  val rnd = Mulberry32(seed)
  var hd = 0.0
  var e = 0.0
  var n = 0.0
  val pts = ArrayList<DoubleArray>(VEC_N)
  pts.add(doubleArrayOf(0.0, 0.0))
  for (i in 1 until VEC_N) {
    hd += (rnd.next() - 0.5) * 2.0 * sd
    if (rnd.next() < turnProb) hd += 180.0 * (if (rnd.next() < 0.5) -1.0 else 1.0)
    val step = VEC_V * (0.5 + rnd.next())
    e += step * sin(hd * Math.PI / 180.0)
    n += step * cos(hd * Math.PI / 180.0)
    pts.add(doubleArrayOf(e, n))
  }
  return pts
}

/** ENU 点列 → 1Hz fix 列 */
private fun fixesEnu(t0: Long, dtMs: Long, pts: List<DoubleArray>, acc: Double = 5.0): List<Fix> =
  pts.mapIndexed { i, p ->
    val (lat, lon) = enuToLatLon(p[0], p[1])
    Fix(t0 + i * dtMs, lat, lon, acc)
  }

/** 1Hz 采样折线长度（dispM 的恒上界） */
private fun polylineM(fixes: List<Fix>): Double {
  var s = 0.0
  for (i in 1 until fixes.size) {
    s += haversineM(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon)
  }
  return s
}

object RunAutoPause {
  /** 向量 detail 的定点格式（与 RunTrackingService 的 f1/f2 同式） */
  private fun f1(v: Double): String = "%.1f".format(Locale.US, v)

  private fun f2(v: Double): String = "%.2f".format(Locale.US, v)

  private fun f3(v: Double): String = "%.3f".format(Locale.US, v)

  /** V1/V2 的公共前缀：跑 3 m/s 20s → 回到起点附近静止抖动 25s */
  private fun stopPrefix(): Triple<RunCore, Long, Double> {
    val core = RunCore(600, 540)
    val (run, _) = runFixes(START_T, 1000, 20, 3.0, LAT0)
    val lastLat = run.last().lat
    run.forEach { core.onFix(it) }
    val stopT = START_T + 20_000
    standFixes(stopT, 1000, 25, JITTER, lastLat).forEach { core.onFix(it) }
    return Triple(core, stopT, lastLat)
  }

  /** V1 跑 3 m/s 20s → 静止（抖动 ≤1m）→ 8~12s 进入 */
  fun v1(): VectorResult {
    val core = RunCore(600, 540)
    val (run, _) = runFixes(START_T, 1000, 20, 3.0, LAT0)
    val lastLat = run.last().lat
    run.forEach { core.onFix(it) }
    val stopT = START_T + 20_000
    var enterAt: Long? = null
    standFixes(stopT, 1000, 25, JITTER, lastLat).forEach { if (core.onFix(it).entered) enterAt = it.t }
    val delay = enterAt?.let { it - stopT }
    val ok = delay != null && delay in 8_000..12_000
    return VectorResult("V1 停跑 3m/s→静止 8~12s 进入", ok, "enterDelay=$delay ms autoPaused=${core.autoPaused}")
  }

  /** V2 接 V1 走 2 m/s → 位移 ≥10m 且在 11s 内退出（防抖把确认滞后了约 3 个点） */
  fun v2(): VectorResult {
    val (core, _stopT, lastLat) = stopPrefix()
    val entered = core.autoPaused
    val walkStartT = START_T + 20_000 + 25_000
    val moveT0 = walkStartT - 1000 // 走动从上一个静止点起算
    var exitAt: Long? = null
    var credit = 0.0
    runFixes(walkStartT, 1000, 12, 2.0, moveLat(lastLat, 2.0)).first.forEach {
      val o = core.onFix(it)
      if (o.exited) {
        exitAt = it.t
        credit = o.exitCreditM
      }
    }
    val delay = exitAt?.let { it - moveT0 }
    val ok = entered && delay != null && delay <= 11_000 && credit in 10.0..60.0
    return VectorResult("V2 2m/s 走动 位移≥10m 且 ≤11s 退出", ok, "entered=$entered exitDelay=$delay ms exitCredit=$credit m")
  }

  /** V3 运行中 6s 无 fix → 不进不出 */
  fun v3(): VectorResult {
    val core = RunCore(600, 540)
    val (a, afterA) = runFixes(START_T, 1000, 10, 3.0, LAT0)
    var entered = false
    var exited = false
    a.forEach {
      val o = core.onFix(it)
      entered = entered || o.entered
      exited = exited || o.exited
    }
    // 6s 无 fix 后继续跑（位移连续：最后一格在 afterA - 3m，6s 后到 afterA + 15m）
    val tGap = START_T + 10_000 + 6_000
    val gapLat = moveLat(afterA, 15.0)
    val o = core.onFix(Fix(tGap, gapLat, LON0, 5.0))
    entered = entered || o.entered
    exited = exited || o.exited
    runFixes(tGap + 1000, 1000, 20, 3.0, gapLat).first.forEach {
      val r = core.onFix(it)
      entered = entered || r.entered
      exited = exited || r.exited
    }
    return VectorResult("V3 运行中 6s 无 fix → 不进不出", !entered && !exited, "entered=$entered exited=$exited")
  }

  /** V4 手动暂停 30s → 不进 */
  fun v4(): VectorResult {
    val core = RunCore(600, 540)
    val (run, after) = runFixes(START_T, 1000, 20, 3.0, LAT0)
    run.forEach { core.onFix(it) }
    core.setManualPaused(true)
    var entered = false
    standFixes(START_T + 20_000, 1000, 30, JITTER, moveLat(after, -3.0)).forEach {
      entered = entered || core.onFix(it).entered
    }
    return VectorResult("V4 手动暂停 30s → 不进", !entered && !core.autoPaused, "entered=$entered autoPaused=${core.autoPaused}")
  }

  /** V5 站立 ±3m 游走 120s → 0 次退出 */
  fun v5(): VectorResult {
    val core = RunCore(600, 540)
    var enters = 0
    var exits = 0
    standFixes(START_T, 1000, 120, WANDER, LAT0).forEach {
      val o = core.onFix(it)
      if (o.entered) enters++
      if (o.exited) exits++
    }
    return VectorResult("V5 站立 ±3m 游走 120s → 0 次退出", exits == 0 && enters > 0, "enters=$enters exits=$exits")
  }

  /** V6 起步即停（收点稀疏 3s）→ 约 12s 进入 */
  fun v6(): VectorResult {
    val core = RunCore(600, 540)
    var enterAt: Long? = null
    standFixes(START_T, 3000, 20, JITTER, LAT0).forEach { if (core.onFix(it).entered) enterAt = it.t }
    val delay = enterAt?.let { it - START_T }
    val ok = delay != null && delay in 11_000..13_000
    return VectorResult("V6 起步即停（3s 收点）约 12s 进入", ok, "enterDelay=$delay ms")
  }

  /** V7 站立 ±3m 游走 120s → 距离被 4 点方向防抖抹平（旧行为会把之字形一路累加） */
  fun v7(): VectorResult {
    val core = RunCore(600, 540)
    standFixes(START_T, 1000, 120, WANDER, LAT0).forEach { core.onFix(it) }
    val ok = core.distM <= 6.0 && core.jitterCorrections > 0
    return VectorResult(
      "V7 站立 ±3m 游走 120s → 距离≤6m（防抖抹平之字形）",
      ok,
      "dist=${core.distM} jc=${core.jitterCorrections}",
    )
  }

  /** V8 直线 3m/s 30 点 → 距离≈26 段（只丢窗口预热的第 1 段），0 次校正 */
  fun v8(): VectorResult {
    val core = RunCore(600, 540)
    runFixes(START_T, 1000, 30, 3.0, LAT0).first.forEach { core.onFix(it) }
    val expect = 3.0 * (30 - 4) // 30 个点 = 29 段；防抖窗口要 4 点才确认，故少 3 段
    val ok = core.distM in (expect * 0.9)..(expect * 1.05) && core.jitterCorrections == 0
    return VectorResult("V8 直线 3m/s 30 点 → 距离≈${expect}m 且 0 次校正", ok, "dist=${core.distM} jc=${core.jitterCorrections}")
  }

  /**
   * 跑整张向量表（Rust model.rs::spec::run_vectors 的镜像）。
   * V1..V8 = 稳通道冻结口径；V9..V21 = 快通道（显示专用）时效/五拓扑/静止族/段首复位/不回归锁。
   */
  fun runVectors(): List<VectorResult> =
    listOf(
      v1(), v2(), v3(), v4(), v5(), v6(), v7(), v8(),
      v9(), v10(), v11(), v12(), v13(), v14(), v15(), v16(), v17(), v18(), v19(), v20(), v21(),
    )

  /* ---------- 快通道向量 V9..V21（与 JS 参考内核 .zcode/tmp 及 Rust mirror 同表同值） ---------- */

  /** 喂完整段序列，返回 core（读 core.dispM / core.distM） */
  private fun feed(fixes: List<Fix>): RunCore {
    val core = RunCore(600, 540)
    fixes.forEach { core.onFix(it) }
    return core
  }

  /** 喂完整段序列并统计 dispM 的值变化次数（初值 -1，故首帧也计一次；与 JS distinct 同口径） */
  private fun feedDistinct(fixes: List<Fix>): Int {
    val core = RunCore(600, 540)
    var distinct = 0
    var last = -1.0
    fixes.forEach {
      core.onFix(it)
      if (core.dispM != last) {
        distinct++
        last = core.dispM
      }
    }
    return distinct
  }

  /** 2D 圆盘/跳变族的一轮统计 */
  private class DiskStat(
    val over6Steady: Int,
    val over6Disp: Int,
    val maxSteady: Double,
    val maxDisp: Double,
    val jumped: Int,
  )

  /**
   * 静止族：每 seed 生成 steps 个 2D 圆盘点（半径 radius 内均匀）。
   * jump=true 时每 20s 叠一次 +25m(acc25) / +22m(acc28) 的位置跳变（分别过 30m 精度门与单跳门）。
   */
  private fun diskRun(
    radius: Double,
    seedBase: Int,
    mult: Int,
    nSeeds: Int,
    steps: Int,
    jump: Boolean,
  ): DiskStat {
    var oS = 0
    var oD = 0
    var mS = 0.0
    var mD = 0.0
    var jc = 0
    for (s in 0 until nSeeds) {
      val rnd = Mulberry32(seedBase + s * mult + 1)
      val core = RunCore(600, 540)
      for (i in 0 until steps) {
        val ang = rnd.next() * 2.0 * Math.PI
        val rad = radius * sqrt(rnd.next())
        var e = rad * cos(ang)
        var n = rad * sin(ang)
        var acc = 5.0
        if (jump) {
          if (i > 0 && i % 20 == 0) {
            e += 25.0
            acc = 25.0
          } else if (i > 0 && i % 20 == 10) {
            n += 22.0
            acc = 28.0
          }
        }
        val (lat, lon) = enuToLatLon(e, n)
        core.onFix(Fix(START_T + i * 1000L, lat, lon, acc))
      }
      if (core.distM > 6.0) oS++
      if (core.dispM > 6.0) oD++
      if (core.distM > mS) mS = core.distM
      if (core.dispM > mD) mD = core.dispM
      jc += core.jumpCount
    }
    return DiskStat(oS, oD, mS, mD, jc)
  }

  /** dispM 与 1Hz 折线长度（V18 下界性用） */
  private fun dispVsPoly(pts: List<DoubleArray>): Pair<Double, Double> {
    val fixes = fixesEnu(START_T, 1000, pts)
    val core = RunCore(600, 540)
    fixes.forEach { core.onFix(it) }
    return core.dispM to polylineM(fixes)
  }

  /** 空窗三分支（与 Rust tracking_gap_branches_slow_fast_drop 同断言） */
  private fun gapBranchesOk(): Boolean {
    run {
      val core = RunCore(0, 0)
      val (run, _) = runFixes(START_T, 1000, 6, 3.0, LAT0)
      val last = run.last()
      run.forEach { core.onFix(it) }
      val bd = core.distM
      val be = core.elapsedMs
      val o = core.onFix(Fix(last.t + 20_000, moveLat(last.lat, 3.0), LON0, 5.0))
      if (o.gap != GapKind.SLOW || core.distM != bd || core.elapsedMs != be || core.gapSlowCount != 1 || !o.brk) {
        return false
      }
    }
    run {
      val core = RunCore(0, 0)
      val (run, _) = runFixes(START_T, 1000, 6, 3.0, LAT0)
      val last = run.last()
      run.forEach { core.onFix(it) }
      val be = core.elapsedMs
      val o = core.onFix(Fix(last.t + 20_000, moveLat(last.lat, 40.0), LON0, 5.0))
      if (o.gap != GapKind.FAST || abs(o.gapCreditM - 40.0) >= 1.0 || core.elapsedMs - be != 20_000L || core.gapFastCount != 1) {
        return false
      }
    }
    run {
      val core = RunCore(0, 0)
      val (run, _) = runFixes(START_T, 1000, 6, 3.0, LAT0)
      val last = run.last()
      run.forEach { core.onFix(it) }
      val bd = core.distM
      val be = core.elapsedMs
      val o = core.onFix(Fix(last.t + 20_000, moveLat(last.lat, 300.0), LON0, 5.0))
      if (o.gap != GapKind.DROP || core.distM != bd || core.elapsedMs != be || core.gapDropCount != 1 || core.jumpCount != 0) {
        return false
      }
    }
    return true
  }

  /** 手动暂停 30s → 不进自动暂停 */
  private fun manualNoEnter(): Boolean {
    val core = RunCore(600, 540)
    val (run, after) = runFixes(START_T, 1000, 20, 3.0, LAT0)
    run.forEach { core.onFix(it) }
    core.setManualPaused(true)
    var entered = false
    standFixes(START_T + 20_000, 1000, 30, JITTER, moveLat(after, -3.0)).forEach {
      entered = entered || core.onFix(it).entered
    }
    return !entered && !core.autoPaused
  }

  /** V9 快通道起步时效（直线 3m/s,1Hz,acc5）→ 1000ms 首个非零 */
  fun v9(): VectorResult {
    val core = RunCore(600, 540)
    val fixes = runFixes(START_T, 1000, 6, 3.0, LAT0).first
    var firstNonZero: Long? = null
    var firstGe1: Long? = null
    val byT = HashMap<Long, Double>()
    for (f in fixes) {
      core.onFix(f)
      val dt = f.t - START_T
      if (firstNonZero == null && core.dispM > 0.0) firstNonZero = dt
      if (firstGe1 == null && core.dispM >= DISP_MIN_M) firstGe1 = dt
      byT[dt] = core.dispM
    }
    val d1 = byT[1000L] ?: -1.0
    val d2 = byT[2000L] ?: -1.0
    val d3 = byT[3000L] ?: -1.0
    val ok =
      firstNonZero == 1000L && firstGe1 == 1000L &&
        abs(d1 - 3.0) < 0.5 && abs(d2 - 6.0) < 0.5 && abs(d3 - 9.0) < 0.5
    return VectorResult(
      "V9 快通道起步时效 直线3m/s 1Hz → 1000ms 首个非零",
      ok,
      "firstDisplay=${firstNonZero}ms first≥${DISP_MIN_M}m=${firstGe1}ms t=1/2/3s=${f2(d1)}/${f2(d2)}/${f2(d3)}",
    )
  }

  /** V10 快通道五拓扑 100s 末值（折返5.0/绕圈286.7/跑道291.1/直线300.0/随便跑291.0） */
  fun v10(): VectorResult {
    val turnback = feed(fixesEnu(START_T, 1000, genTurnback(5.0))).dispM
    val circle = feed(fixesEnu(START_T, 1000, genCircle(5.0))).dispM
    val track = feed(fixesEnu(START_T, 1000, genTrack())).dispM
    val straight = feed(fixesEnu(START_T, 1000, genStraight())).dispM
    val random = feed(fixesEnu(START_T, 1000, genRandom(1, 15.0))).dispM
    val ok =
      circle in 285.0..315.0 && track in 285.0..315.0 && random in 285.0..315.0 &&
        abs(straight - 300.0) < 1.0 && turnback < 30.0 && abs(turnback - 5.0) < 1.0
    return VectorResult(
      "V10 快通道五拓扑 100s 末值（折返5.0/绕圈286.7/跑道291.1/直线300.0/随便跑291.0）",
      ok,
      "折返=${f1(turnback)} 绕圈=${f1(circle)} 跑道=${f1(track)} 直线=${f1(straight)} 随便跑=${f1(random)}",
    )
  }

  /** V11 稳通道四拓扑 ≤5%（acc5,clean,100s：绕圈286.7/跑道291.1/直线291.0/随便跑291.0） */
  fun v11(): VectorResult {
    val circle = feed(fixesEnu(START_T, 1000, genCircle(5.0))).distM
    val track = feed(fixesEnu(START_T, 1000, genTrack())).distM
    val straight = feed(fixesEnu(START_T, 1000, genStraight())).distM
    val random = feed(fixesEnu(START_T, 1000, genRandom(1, 15.0))).distM
    val ok = listOf(circle, track, straight, random).all { it in 285.0..315.0 }
    return VectorResult(
      "V11 稳通道四拓扑 ≤5%（100s）",
      ok,
      "绕圈=${f1(circle)} 跑道=${f1(track)} 直线=${f1(straight)} 随便跑=${f1(random)}",
    )
  }

  /** V12 折返 5m@3m/s 100s（documented-fail：1Hz 折线 220.0m 上限） */
  fun v12(): VectorResult {
    val fixes = fixesEnu(START_T, 1000, genTurnback(5.0))
    val poly = polylineM(fixes)
    val core = RunCore(600, 540)
    var firstComm: Long? = null
    for (f in fixes) {
      core.onFix(f)
      if (firstComm == null && core.distM > 0.0) firstComm = f.t - START_T
    }
    val ok = core.distM < 30.0 && core.dispM < 30.0
    return VectorResult(
      "V12 折返 5m@3m/s 100s（documented-fail：1Hz 折线 ${f1(poly)}m 上限）",
      ok,
      "polyline1Hz=${f1(poly)}m 稳通道distM=${f1(core.distM)}m 快通道dispM=${f1(core.dispM)}m 稳通道首个入账=${firstComm}ms",
    )
  }

  /** V13 静止 1D WANDER ±3m 120s：稳0.0/快2.7/enters≥1 */
  fun v13(): VectorResult {
    val core = RunCore(600, 540)
    var enters = 0
    standFixes(START_T, 1000, 120, WANDER, LAT0).forEach { if (core.onFix(it).entered) enters++ }
    val ok = core.distM <= 6.0 && core.dispM <= 6.0 && enters >= 1
    return VectorResult(
      "V13 静止 1D WANDER ±3m 120s：稳≤6/快≤6/enters≥1",
      ok,
      "distM=${f1(core.distM)} dispM=${f1(core.dispM)} enters=$enters",
    )
  }

  /** V14 静止 2D r=3m 100s×100seed：稳>6=0/100 快>6=0/100 */
  fun v14(): VectorResult {
    val d = diskRun(3.0, 100000, 7, 100, 100, false)
    val ok = d.over6Steady == 0 && d.over6Disp == 0
    return VectorResult(
      "V14 静止 2D r=3m 100s×100seed：稳>6=0/100 快>6=0/100",
      ok,
      "稳>6=${d.over6Steady}/100(max ${f1(d.maxSteady)}) 快>6=${d.over6Disp}/100(max ${f1(d.maxDisp)})",
    )
  }

  /** V15 静止 2D r=8m 100s×100seed（documented-fail：断言「>6m 成立」） */
  fun v15(): VectorResult {
    val d = diskRun(8.0, 200000, 7, 100, 100, false)
    val ok = d.over6Steady > 0 && d.over6Disp > 0
    return VectorResult(
      "V15 静止 2D r=8m 100s×100seed（documented-fail）",
      ok,
      "稳>6=${d.over6Steady}/100(max ${f1(d.maxSteady)}) 快>6=${d.over6Disp}/100(max ${f1(d.maxDisp)})",
    )
  }

  /** V16 静止 2D r=8m+偶发跳变 ×50seed（documented-fail：>6 成立且 jumpCount=0） */
  fun v16(): VectorResult {
    val d = diskRun(8.0, 300000, 13, 50, 100, true)
    val ok = d.over6Steady > 0 && d.over6Disp > 0 && d.jumped == 0
    return VectorResult(
      "V16 静止 2D r=8m+偶发跳变 ×50seed（documented-fail）",
      ok,
      "稳>6=${d.over6Steady}/50(max ${f1(d.maxSteady)}) 快>6=${d.over6Disp}/50(max ${f1(d.maxDisp)}) jumpCount=${d.jumped}",
    )
  }

  /** V17 刷新节奏：100s 内 dispM 变化次数 ≥90（四拓扑；折返不列入） */
  fun v17(): VectorResult {
    val c = feedDistinct(fixesEnu(START_T, 1000, genCircle(5.0)))
    val t = feedDistinct(fixesEnu(START_T, 1000, genTrack()))
    val s = feedDistinct(fixesEnu(START_T, 1000, genStraight()))
    val r = feedDistinct(fixesEnu(START_T, 1000, genRandom(1, 15.0)))
    val ok = c >= 90 && t >= 90 && s >= 90 && r >= 90
    return VectorResult(
      "V17 刷新节奏：100s 内 dispM 变化次数 ≥90（四拓扑，折返除外）",
      ok,
      "绕圈=$c 跑道=$t 直线=$s 随便跑=$r",
    )
  }

  /** V18 快通道下界性：dispM ≤ 1Hz 折线长度（+5000 组随机走位搜索 0 反例） */
  fun v18(): VectorResult {
    val st = dispVsPoly(genStraight())
    val ci = dispVsPoly(genCircle(5.0))
    val tr = dispVsPoly(genTrack())
    val okTopo = st.first <= st.second + 1e-6 && ci.first <= ci.second + 1e-6 && tr.first <= tr.second + 1e-6
    var violations = 0
    var worst = -1e9
    for (sd in doubleArrayOf(10.0, 30.0, 60.0, 90.0, 140.0)) {
      for (tp in doubleArrayOf(0.0, 0.1, 0.25, 0.5, 0.75)) {
        for (seed in 1..200) {
          val p = dispVsPoly(genBound(seed, sd, tp))
          val delta = p.first - p.second
          if (delta > worst) worst = delta
          if (delta > 1e-6) violations++
        }
      }
    }
    val ok = okTopo && violations == 0
    return VectorResult(
      "V18 快通道下界性：dispM ≤ 1Hz 折线（+5000 组 0 反例）",
      ok,
      "直线 ${f1(st.first)}≤${f1(st.second)} 绕圈 ${f1(ci.first)}≤${f1(ci.second)} 跑道 ${f1(tr.first)}≤${f1(tr.second)} 反例=$violations 最大超出=${f3(worst)}",
    )
  }

  /** V19 acc 值无关/精度门：acc5=acc15=acc29.9 → 291.0；acc31 → 0.0 */
  fun v19(): VectorResult {
    val a = feed(runFixes(START_T, 1000, VEC_N, 3.0, LAT0, 5.0).first).distM
    val b = feed(runFixes(START_T, 1000, VEC_N, 3.0, LAT0, 15.0).first).distM
    val c = feed(runFixes(START_T, 1000, VEC_N, 3.0, LAT0, 29.9).first).distM
    val d = feed(runFixes(START_T, 1000, VEC_N, 3.0, LAT0, 31.0).first).distM
    val ok = a == b && b == c && a > 0.0 && d == 0.0
    return VectorResult(
      "V19 acc 值无关/精度门：acc5=15=29.9 → 291.0；acc31 → 0.0",
      ok,
      "acc5=${f1(a)} acc15=${f1(b)} acc29.9=${f1(c)} acc31=${f1(d)}",
    )
  }

  /** V20 回归锁：精度门/单跳/空窗三分支/手动暂停（与 model.rs::tracking_tests 同断言） */
  fun v20(): VectorResult {
    val c1 = RunCore(600, 540)
    val dropped = c1.onFix(Fix(START_T, LAT0, LON0, 80.0)).dropped
    val accepted = c1.onFix(Fix(START_T, LAT0, LON0, 8.0)).accepted
    val jumped = c1.onFix(Fix(START_T + 1000, moveLat(LAT0, 100.0), LON0, 8.0)).jumped
    val gateOk = dropped && accepted && jumped && c1.jumpCount == 1 && c1.distM == 0.0
    val gapOk = gapBranchesOk()
    val mpOk = manualNoEnter()
    val ok = gateOk && gapOk && mpOk
    return VectorResult(
      "V20 回归锁：精度门/单跳/空窗三分支/手动暂停",
      ok,
      "门drop=$dropped 单跳=$jumped 空窗=$gapOk 手动暂停=$mpOk",
    )
  }

  /** V21 快通道段首复位：自动暂停进入/退出、>10s 空窗 fast、手动暂停各路径无跨段重复计距 */
  fun v21(): VectorResult {
    // A) 自动暂停：跑 3m/s 20s → 静止抖动 25s → 走 2m/s 15s
    val core = RunCore(600, 540)
    val (run, _) = runFixes(START_T, 1000, 20, 3.0, LAT0)
    val lastLat = run.last().lat
    run.forEach { core.onFix(it) }
    var enterDisp = -1.0
    var enterComm = -1.0
    standFixes(START_T + 20_000, 1000, 25, JITTER, lastLat).forEach {
      val o = core.onFix(it)
      if (o.entered) {
        enterDisp = core.dispM
        enterComm = core.distM
      }
    }
    var brkDisp = -1.0
    var brkComm = -1.0
    runFixes(START_T + 45_000, 1000, 15, 2.0, moveLat(lastLat, 2.0)).first.forEach {
      val o = core.onFix(it)
      if (o.brk && brkDisp < 0.0) {
        brkDisp = core.dispM
        brkComm = core.distM
      }
    }
    val endDisp = core.dispM
    val endComm = core.distM
    // B) 空窗 fast：20s 空窗内位移 40m
    val core2 = RunCore(600, 540)
    val (run2, _) = runFixes(START_T, 1000, 6, 3.0, LAT0)
    val last2 = run2.last()
    run2.forEach { core2.onFix(it) }
    core2.onFix(Fix(last2.t + 20_000, moveLat(last2.lat, 40.0), LON0, 5.0))
    val gapDisp = core2.dispM
    val gapComm = core2.distM
    // C) 手动暂停 + 100m 跨段位移（暂停期不计距）
    val core3 = RunCore(600, 540)
    runFixes(START_T, 1000, 10, 3.0, LAT0).first.forEach { core3.onFix(it) }
    core3.setManualPaused(true)
    (0 until 10).forEach { i ->
      core3.onFix(Fix(START_T + (10 + i) * 1000L, moveLat(LAT0, 100.0 + i), LON0, 5.0))
    }
    core3.setManualPaused(false)
    runFixes(START_T + 20_000, 1000, 6, 3.0, moveLat(LAT0, 110.0)).first.forEach { core3.onFix(it) }
    val mpDisp = core3.dispM
    val mpComm = core3.distM

    val aOk = abs(enterDisp - 57.9) < 1.0 && abs(enterComm - 57.3) < 1.0
    val bOk =
      brkDisp > 0.0 && abs(brkDisp - brkComm) < 0.5 &&
        abs(endDisp - endComm) < 0.5 && abs(endDisp - 87.2) < 1.0
    val cOk = abs(gapDisp - gapComm) < 0.5 && abs(gapDisp - 46.0) < 1.0
    val dOk = mpDisp < 50.0 && mpComm < 50.0 && abs(mpDisp - 27.0) < 1.0 && abs(mpComm - 24.0) < 1.0
    val ok = aOk && bOk && cOk && dOk
    return VectorResult(
      "V21 快通道段首复位：自动暂停/空窗 fast/手动暂停无跨段重复计距",
      ok,
      "ENTER dispM=${f1(enterDisp)}/comm=${f1(enterComm)} 退出brk dispM=${f1(brkDisp)}/comm=${f1(brkComm)} " +
        "末 ${f1(endDisp)}/${f1(endComm)} 空窗 ${f1(gapDisp)}/${f1(gapComm)} 手停 ${f1(mpDisp)}/${f1(mpComm)}",
    )
  }

  /**
   * debug 构建启动时调用：跑向量表并把结果交给调用方打 logcat。
   * 这是「判定逻辑在真机上是否与规格一致」的唯一取证手段（cargo 覆盖的是 Rust 镜像）。
   */
  fun selfTest(): SelfTestResult {
    val results = runVectors()
    val lines = results.map { "${if (it.ok) "pass" else "FAIL"} ${it.name} — ${it.detail}" }
    return SelfTestResult(results.count { it.ok }, results.count { !it.ok }, lines)
  }
}
