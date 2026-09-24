/**
 * 跑步会话状态机 v1。
 *
 * 落盘复用 workout_sessions（plan_id = RUN_PLAN_ID），与训练课共用同一套
 * 「active 行 = 未正常结束」不变量：只有保存/放弃（结束键 + 二级确认）
 * 会关闭会话；其余一切离开方式按异常中断处理，恢复时强制进入暂停态，
 * 由用户核对后续跑。
 *
 * GPS：navigator.geolocation.watchPosition 累加距离（精度与跳变过滤）；
 * 不可用（桌面常见）时退化为纯计时，距离在总结页手动补填（跑步机同理）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { EXERCISE_KCAL_GOAL, estimateRunKcal } from '@/config/domain'
import { sessionService } from '@/services/sessionService'
import { trackingService } from '@/services/trackingService'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { todayStr } from '@/utils/date'
import { haversineM } from '@/utils/geo'
import { RUN_PLAN_ID } from '@/types'
import type { Intensity, RunGoalKind, RunSnapshot, RunTrackPoint, SessionRecord } from '@/types'

export type RunPhase = 'idle' | 'ready' | 'running' | 'paused' | 'summary'
export type GpsStatus = 'off' | 'acquiring' | 'active' | 'unavailable'

export const useRunStore = defineStore('run', () => {
  const phase = ref<RunPhase>('idle')
  const goalKind = ref<RunGoalKind>('open')
  const goalTimeMin = ref(30)
  const goalDistanceKm = ref(5)

  const sessionId = ref<number | null>(null)
  const startedAtIso = ref('')
  /** 已累计运动毫秒（不含当前 running 段） */
  const accumMs = ref(0)
  /** 当前 running 段起点（epoch ms） */
  let segStartedMs = 0

  const distanceM = ref(0)
  const gpsStatus = ref<GpsStatus>('off')
  const persistError = ref('')
  /** 服务端存在进行中的训练课（非跑步）→ RunPage 弹「前往继续」 */
  const courseConflict = ref(false)
  /** 轨迹面包屑（仅 running 时记录；t=累计运动毫秒、alt=GPS 海拔，供详情页分段配速/爬升） */
  const trackPoints = ref<RunTrackPoint[]>([])
  /** 瞬时配速（秒/公里，EMA 平滑）；停跑过久或无定位时为 null */
  const paceInstantSecPerKm = ref<number | null>(null)

  /** 响应式时钟：running 时 250ms 一跳，驱动所有时间派生值 */
  const nowTick = ref(Date.now())

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let persistTimer: ReturnType<typeof setInterval> | null = null
  let watchId: number | null = null
  let lastPos: { lat: number; lon: number; t: number } | null = null
  /** 最近一次有效移动的时刻：超过 15s 无移动则瞬时配速失效 */
  let lastMoveT = 0

  function stopTimers(): void {
    if (tickTimer) clearInterval(tickTimer)
    if (persistTimer) clearInterval(persistTimer)
    tickTimer = null
    persistTimer = null
  }

  /* ---------- 派生 ---------- */

  const elapsedMs = computed(() =>
    phase.value === 'running' ? accumMs.value + (nowTick.value - segStartedMs) : accumMs.value,
  )
  const elapsedSec = computed(() => Math.floor(elapsedMs.value / 1000))
  const km = computed(() => distanceM.value / 1000)
  /** 平均配速（秒/公里）；距离太短时不显示 */
  const paceSecPerKm = computed(() =>
    km.value > 0.05 && elapsedSec.value > 10 ? Math.round(elapsedSec.value / km.value) : null,
  )
  const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'ready')
  const weightKg = computed(() => useNutritionStore().profile?.weightKg ?? 70)

  /** 按配速分档强度：≤5'30"/km 高，≤7'30" 中，其余低；无距离按中 */
  const intensity = computed<Intensity>(() => {
    const p = paceSecPerKm.value
    if (p == null) return 'moderate'
    if (p <= 330) return 'high'
    if (p <= 450) return 'moderate'
    return 'low'
  })

  /** ACSM 速度连续模型：有 GPS 距离按平均配速精确计算，无距离退回 MET 中档 */
  const kcal = computed(() => estimateRunKcal(km.value, elapsedSec.value, weightKg.value))

  const goalProgress = computed(() => {
    if (goalKind.value === 'time')
      return Math.min(elapsedSec.value / Math.max(1, goalTimeMin.value * 60), 1)
    if (goalKind.value === 'distance')
      return Math.min(km.value / Math.max(0.5, goalDistanceKm.value), 1)
    return Math.min(kcal.value / EXERCISE_KCAL_GOAL, 1)
  })

  /* ---------- 落盘 ---------- */

  /** 轨迹落盘抽稀上限（点）：控制 state_json 体积（800 点 ≈ 2 小时跑步） */
  const MAX_SNAPSHOT_POINTS = 800

  function decimatedPoints(): RunTrackPoint[] {
    const pts = trackPoints.value
    if (pts.length <= MAX_SNAPSHOT_POINTS) return pts
    const step = Math.ceil(pts.length / MAX_SNAPSHOT_POINTS)
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
  }

  function snapshot(): RunSnapshot {
    const running = phase.value === 'running'
    return {
      kind: 'run',
      phase: phase.value === 'summary' ? 'summary' : running ? 'running' : 'paused',
      goalKind: goalKind.value,
      goalTimeMin: goalTimeMin.value,
      goalDistanceKm: goalDistanceKm.value,
      accumMs: running ? accumMs.value + (Date.now() - segStartedMs) : accumMs.value,
      segStartedAt: running ? new Date(segStartedMs).toISOString() : null,
      distanceM: distanceM.value,
      points: decimatedPoints(),
    }
  }

  async function persist(): Promise<void> {
    const id = sessionId.value
    if (!id) return
    try {
      await sessionService.snapshot({ id, exIndex: 0, setIndex: 1, weightKg: 0, state: snapshot() })
      persistError.value = ''
    } catch (e) {
      console.warn('[run] 快照落盘失败', e)
      persistError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /* ---------- GPS ---------- */

  /** 轨迹点附加信息：记录时刻的累计运动毫秒 + GPS 海拔（详情页分段配速/爬升用） */
  function pointMeta(pos: GeolocationPosition): Omit<RunTrackPoint, 'lat' | 'lon'> {
    const meta: Omit<RunTrackPoint, 'lat' | 'lon'> = { t: accumMs.value + (Date.now() - segStartedMs) }
    if (typeof pos.coords.altitude === 'number') meta.alt = pos.coords.altitude
    return meta
  }

  function startGps(): void {
    if (!('geolocation' in navigator)) {
      gpsStatus.value = 'unavailable'
      return
    }
    stopGps()
    gpsStatus.value = 'acquiring'
    lastPos = null
    lastMoveT = 0
    // 距离入账窗口：攒满 1s 提交一次。部分机型 3~5Hz 吐点，单步位移 <1m，
    // 旧的「单步 >1m 且 dt≥1s」过滤在高频下会把距离全滤没。
    let pendingD = 0
    let pendingT0 = 0
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (gpsStatus.value !== 'active') gpsStatus.value = 'active'
        if (phase.value !== 'running') return // 暂停时不累加
        const lat = pos.coords.latitude
        const lon = pos.coords.longitude
        const t = pos.timestamp
        if (pos.coords.accuracy != null && pos.coords.accuracy > 30) return // 精度太差
        if (lastMoveT > 0 && t - lastMoveT > 15_000) paceInstantSecPerKm.value = null
        if (lastPos) {
          const d = haversineM(lastPos.lat, lastPos.lon, lat, lon)
          // 过滤漂移：单步 ≤100m，亚米级抖动直接丢弃
          if (d > 0.5 && d <= 100) {
            if (pendingT0 === 0) pendingT0 = lastPos.t
            pendingD += d
            const winSec = (t - pendingT0) / 1000
            if (winSec >= 1) {
              // 窗口均速 ≥0.4 m/s 才算真实移动，滤除原地 GPS 抖动
              if (pendingD / winSec >= 0.4) {
                distanceM.value += pendingD
                lastMoveT = t
                trackPoints.value.push({ lat, lon, ...pointMeta(pos) })
                // 瞬时配速 EMA 平滑，避免 GPS 抖动导致数字跳变
                const inst = (winSec / pendingD) * 1000
                const prev = paceInstantSecPerKm.value
                paceInstantSecPerKm.value = prev == null ? inst : prev * 0.7 + inst * 0.3
              }
              pendingD = 0
              pendingT0 = 0
            }
          }
        } else {
          trackPoints.value.push({ lat, lon, ...pointMeta(pos) }) // 首个定位点：轨迹起点
        }
        lastPos = { lat, lon, t }
      },
      () => {
        gpsStatus.value = 'unavailable'
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    )
  }

  function stopGps(): void {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId)
      watchId = null
    }
    lastPos = null
  }

  /**
   * 安卓开跑前先拉起前台保活（首次未授权会弹系统授权框，授权后服务自动启动）。
   * 锁屏后 WebView 的 GPS/计时器随进程冻结而停摆——没有这一步，跑步几分钟
   * 后定位丢失、进程被系统回收，用户感知为崩溃。最多等 20s，用户拒绝则立即
   * 放行，走 GPS 自身的不可用降级（总结页补填距离）。
   */
  async function armKeepalive(): Promise<void> {
    await trackingService.setKeepalive(true)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const st = await trackingService.status()
      if (!st.granted) {
        if (!st.busy) return // 用户明确拒绝，立即降级
        await new Promise((resolve) => setTimeout(resolve, 400))
        continue
      }
      // 权限就绪：若等待期间授权框被别处（如 WebView 自身提示）代答，
      // 保活服务可能尚未拉起，再发一次 enable（已授权时是直接启动服务的幂等操作）
      await trackingService.setKeepalive(true)
      return
    }
  }

  /* ---------- 流程 ---------- */

  /** 进入准备页（新的一次跑步） */
  function enterReady(): void {
    resetLocal()
    phase.value = 'ready'
    goalKind.value = 'open'
    goalTimeMin.value = 30
    goalDistanceKm.value = 5
  }

  /**
   * 3·2·1 倒数结束后正式开跑：创建后端会话并开始计时。
   * 服务端已有进行中会话时返回 'conflict'（课程 → courseConflict，跑步 → 已恢复）。
   */
  async function begin(): Promise<'ok' | 'conflict'> {
    const existing = await sessionService.getActive()
    if (existing) {
      if (existing.planId === RUN_PLAN_ID) {
        await applyRecord(existing)
        return 'conflict' // 已恢复为暂停态，页面直接展示
      }
      courseConflict.value = true
      return 'conflict'
    }
    courseConflict.value = false
    startedAtIso.value = new Date().toISOString()
    accumMs.value = 0
    distanceM.value = 0
    trackPoints.value = []
    paceInstantSecPerKm.value = null
    const rec = await sessionService.start({
      planId: RUN_PLAN_ID,
      planName: '户外跑',
      startedAt: startedAtIso.value,
      state: snapshot(),
    })
    sessionId.value = rec.id
    await armKeepalive() // 起表前先确保保活/授权，弹框等待不计入运动时长
    phase.value = 'running'
    segStartedMs = Date.now()
    nowTick.value = Date.now()
    startGps()
    startTimers()
    await persist()
    return 'ok'
  }

  function startTimers(): void {
    stopTimers()
    tickTimer = setInterval(() => {
      nowTick.value = Date.now()
    }, 250)
    // 运行中每 10s 落盘一次：崩溃/退出后距离与时长最多回退 10s
    persistTimer = setInterval(() => void persist(), 10_000)
  }

  function pause(): void {
    if (phase.value !== 'running') return
    accumMs.value += Date.now() - segStartedMs
    nowTick.value = Date.now()
    phase.value = 'paused'
    void persist()
  }

  function resume(): void {
    if (phase.value !== 'paused') return
    segStartedMs = Date.now()
    nowTick.value = Date.now()
    phase.value = 'running'
    void trackingService.setKeepalive(true) // 恢复跑同样需要前台保活
    if (gpsStatus.value !== 'unavailable') startGps()
    void persist()
  }

  /** 结束并保存前：冻结时长，进入总结页（可手动修正距离） */
  function enterSummary(): void {
    if (phase.value === 'running') {
      accumMs.value += Date.now() - segStartedMs
      nowTick.value = Date.now()
    }
    phase.value = 'summary'
    stopTimers()
    stopGps()
    void trackingService.setKeepalive(false) // 总结页停留时不再占用前台服务与 WakeLock
    void persist()
  }

  /** 保存训练记录并关闭会话。manualKm = 总结页确认后的公里数（跑步机补填）。 */
  async function save(
    manualKm: number | null,
  ): Promise<{ durationMin: number; kcal: number; km: number | null; paceSec: number | null }> {
    const durationMin = Math.max(1, Math.round(elapsedMs.value / 60_000))
    const finalKm = manualKm != null && manualKm > 0 ? manualKm : km.value > 0.01 ? km.value : null
    const paceSec =
      finalKm != null && finalKm > 0.05 ? Math.round(elapsedSec.value / finalKm) : null
    const tier: Intensity =
      paceSec == null ? 'moderate' : paceSec <= 330 ? 'high' : paceSec <= 450 ? 'moderate' : 'low'
    const kcalFinal = estimateRunKcal(finalKm, elapsedSec.value, weightKg.value)
    const noteParts: string[] = []
    if (finalKm != null) noteParts.push(`${finalKm.toFixed(2)} km`)
    if (paceSec != null) noteParts.push(`配速 ${fmtPace(paceSec)}`)
    if (manualKm != null && finalKm !== km.value) noteParts.push('距离手动补填')
    if (sessionId.value) {
      await sessionService.finish({
        id: sessionId.value,
        name: '户外跑',
        workoutType: 'run',
        date: todayStr(),
        durationMin,
        intensity: tier,
        kcal: kcalFinal,
        note: noteParts.length > 0 ? noteParts.join(' · ') : null,
        sets: [], // 跑步无逐组重量
      })
    }
    await Promise.all([
      useExerciseStore().loadWeek(todayStr()),
      useNutritionStore().loadSummary(todayStr()),
    ])
    resetLocal()
    return { durationMin, kcal: kcalFinal, km: finalKm, paceSec }
  }

  /** 放弃本次跑步（已确认）：关闭会话，不写记录 */
  async function discard(): Promise<void> {
    const id = sessionId.value
    if (id) await sessionService.abort(id)
    resetLocal()
  }

  async function discardById(id: number): Promise<void> {
    await sessionService.abort(id)
    if (sessionId.value === id) resetLocal()
  }

  function resetLocal(): void {
    stopTimers()
    stopGps()
    void trackingService.setKeepalive(false) // 未运行时为无害空操作
    sessionId.value = null
    startedAtIso.value = ''
    accumMs.value = 0
    segStartedMs = 0
    distanceM.value = 0
    trackPoints.value = []
    paceInstantSecPerKm.value = null
    gpsStatus.value = 'off'
    persistError.value = ''
    courseConflict.value = false
    phase.value = 'idle'
  }

  /* ---------- 中断恢复 ---------- */

  /** RunPage 挂载时调用：恢复进行中的跑步会话（强制暂停态） */
  async function hydrateFromServer(): Promise<boolean> {
    courseConflict.value = false
    let rec: SessionRecord | null
    try {
      rec = await sessionService.getActive()
    } catch {
      rec = null
    }
    if (!rec) return false
    if (rec.planId !== RUN_PLAN_ID) {
      courseConflict.value = true
      return false
    }
    try {
      await applyRecord(rec)
    } catch (e) {
      console.warn('[run] 恢复失败，已作废该会话', e)
      await discardById(rec.id)
      return false
    }
    return true
  }

  async function applyRecord(rec: SessionRecord): Promise<void> {
    const st = rec.state as unknown
    if (typeof st !== 'object' || st === null || (st as RunSnapshot).kind !== 'run') {
      throw new Error('非跑步会话状态')
    }
    const s = st as RunSnapshot
    sessionId.value = rec.id
    startedAtIso.value = rec.startedAt
    goalKind.value = s.goalKind ?? 'open'
    goalTimeMin.value = s.goalTimeMin ?? 30
    goalDistanceKm.value = s.goalDistanceKm ?? 5
    accumMs.value = Math.max(0, s.accumMs ?? 0)
    distanceM.value = Math.max(0, s.distanceM ?? 0)
    trackPoints.value = Array.isArray(s.points) ? s.points : [] // 旧快照无轨迹，按空处理
    nowTick.value = Date.now()
    stopTimers()
    stopGps()
    // 恢复强制暂停：被打断的当前段丢弃（时间不补），用户核对后续跑
    phase.value = s.phase === 'summary' ? 'summary' : 'paused'
  }

  return {
    phase,
    goalKind,
    goalTimeMin,
    goalDistanceKm,
    sessionId,
    distanceM,
    gpsStatus,
    persistError,
    courseConflict,
    trackPoints,
    paceInstantSecPerKm,
    elapsedMs,
    elapsedSec,
    km,
    paceSecPerKm,
    isActive,
    intensity,
    kcal,
    goalProgress,
    enterReady,
    begin,
    pause,
    resume,
    enterSummary,
    save,
    discard,
    discardById,
    hydrateFromServer,
    startGps,
  }
})

/** 配速格式化：378 → 6'18"（先取整避免出现 6'60"） */
export function fmtPace(secPerKm: number): string {
  const t = Math.round(secPerKm)
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, '0')}"`
}

/** 时长格式化：3785 → 1:03:05；75 → 01:15 */
export function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
