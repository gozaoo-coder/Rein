/**
 * 训练课状态机 v2（纯前端会话，后端持久化会话记录用于中断恢复）。
 *
 * 落盘规则：每一个状态事件（开始/做组/休息/跳过/计时/重量调整/阶段推进）
 * 都会异步调用 session_snapshot；服务端按快照间隔自动累加 elapsed_sec。
 *
 * 结束语义：只有 `finishAndSave`/`discard`（用户经「结束键 + 二级确认」触发）
 * 会关闭会话；其余任何离开方式（切页/退出应用）都保留 active 会话，
 * 由主页「恢复卡」提示接续。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { sessionService } from '@/services/sessionService'
import { estimateKcal } from '@/config/domain'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { usePlanStore } from '@/stores/plan'
import { todayStr } from '@/utils/date'
import { RUN_PLAN_ID } from '@/types'
import type {
  DoneSet,
  PlanExercise,
  SessionPhase,
  SessionRecord,
  SessionSnapshotState,
  WorkoutPlan,
} from '@/types'

/** 结束并保存的返回值（写完训练记录后立即展示用） */
export interface SessionFinishResult {
  durationMin: number
  kcal: number
  volume: number
  done: number
}

export const useSessionStore = defineStore('session', () => {  const sessionId = ref<number | null>(null)
  const startedAtIso = ref('')
  const plan = ref<WorkoutPlan | null>(null)
  const phase = ref<SessionPhase>('idle')
  const exIndex = ref(0)
  const setIndex = ref(1) // 展示用，1-based
  const weight = ref(0)
  const doneSets = ref<Record<string, DoneSet[]>>({})

  const restLeft = ref(0)
  const restTotal = ref(0)
  /** true = 同动作下一组，false = 下一个动作 */
  const restTargetIsNextSet = ref(true)
  /** 临时休息：不推进流程，倒计时结束回到 resumePhase */
  const restIsTemp = ref(false)
  const resumePhase = ref<'exercise' | 'timed-ready' | 'timed-run'>('exercise')
  /** 「再加一组」追加的组数（动作 id → 追加数），随快照落盘 */
  const extraSets = ref<Record<string, number>>({})
  const timedTotal = ref(0)
  const timedElapsed = ref(0)

  const overlay = ref({ show: false, label: '', sub: '', countFrom: 3 })
  const overlayLeadsToRun = ref(false)

  /** 最近一次落盘失败（SessionPage 顶部显示警示，不阻塞训练） */
  const persistError = ref('')

  /** 检测到 active 会话但不属于训练课（如跑步）时，指引用户前往的正确页面 */
  const foreignRoute = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  /* ---------- 落盘 ---------- */

  function snapshotState(): SessionSnapshotState {
    return {
      doneSets: doneSets.value,
      exIndex: exIndex.value,
      setIndex: setIndex.value,
      weight: weight.value,
      phase: (phase.value === 'idle' ? 'exercise' : phase.value) as SessionSnapshotState['phase'],
      restLeft: restLeft.value,
      restTargetIsNextSet: restTargetIsNextSet.value,
      timedTotal: timedTotal.value,
      restIsTemp: restIsTemp.value,
      resumePhase: resumePhase.value,
      extraSets: extraSets.value,
    }
  }

  async function persist(): Promise<void> {
    const id = sessionId.value
    if (!id) return
    try {
      await sessionService.snapshot({
        id,
        exIndex: exIndex.value,
        setIndex: setIndex.value,
        weightKg: weight.value,
        state: snapshotState(),
      })
      persistError.value = ''
    } catch (e) {
      console.warn('[session] 快照落盘失败', e)
      persistError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 每个状态事件后的落盘触发点 */
  function touch(): void {
    void persist()
  }

  /* ---------- 派生 ---------- */

  const currentEx = computed<PlanExercise | null>(() => plan.value?.exercises[exIndex.value] ?? null)

  const exDoneSets = computed<DoneSet[]>(() =>
    currentEx.value ? (doneSets.value[currentEx.value.id] ?? []) : [],
  )

  const isLastExercise = computed(
    () => plan.value != null && exIndex.value >= plan.value!.exercises.length - 1,
  )

  /** 「再加一组」后的实际组数 = 计划组数 + 追加 */
  function effSets(e: PlanExercise): number {
    return e.sets + (extraSets.value[e.id] ?? 0)
  }

  const doneCount = computed(() =>
    Object.values(doneSets.value).reduce((s, arr) => s + arr.length, 0),
  )

  const totalCount = computed(() =>
    plan.value ? plan.value.exercises.reduce((s, e) => s + effSets(e), 0) : 0,
  )

  const totalVolume = computed(() => {
    let v = 0
    for (const ex of plan.value?.exercises ?? []) {
      if (ex.kind !== 'strength') continue
      const reps = ex.reps ?? 0
      for (const d of doneSets.value[ex.id] ?? []) v += (d.weight ?? 0) * reps
    }
    return Math.round(v)
  })

  /** 会话墙钟时长（跨重启仍准确，因为 startedAt 持久化） */
  const durationMin = computed(() =>
    startedAtIso.value ? Math.max(1, Math.round((Date.now() - Date.parse(startedAtIso.value)) / 60_000)) : 0,
  )

  const estimateKcalValue = computed(() =>
    plan.value
      ? estimateKcal(
          plan.value.workoutType,
          'moderate',
          durationMin.value || 1,
          useNutritionStore().profile?.weightKg ?? 70,
        )
      : 0,
  )

  const isActive = computed(() => phase.value !== 'idle' && plan.value != null)

  /* ---------- 流程 ---------- */

  /**
   * 开始新训练。已有进行中会话时返回 'conflict'（conflictRoute 指向应接续的
   * 页面：训练课 /session 或跑步 /session/run），由调用方给出「前往继续」。
   */
  async function start(p: WorkoutPlan): Promise<'ok' | 'conflict'> {
    const existing = await sessionService.getActive()
    if (existing) {
      if (existing.planId === RUN_PLAN_ID) {
        foreignRoute.value = '/session/run'
        return 'conflict'
      }
      await applyRecord(existing)
      return 'conflict'
    }
    plan.value = p
    sessionId.value = null
    startedAtIso.value = new Date().toISOString()
    exIndex.value = 0
    setIndex.value = 1
    doneSets.value = {}
    extraSets.value = {}
    restIsTemp.value = false
    weight.value = p.exercises[0]?.weightKg ?? 0
    const rec = await sessionService.start({
      planId: p.id,
      planName: p.name,
      startedAt: startedAtIso.value,
      state: { doneSets: {}, exIndex: 0, setIndex: 1, weight: weight.value, phase: 'exercise' },
    })
    sessionId.value = rec.id
    beginExercise()
    await persist()
    void usePlanStore().touch(p.id) // 维护「最近使用」排序
    return 'ok'
  }

  function beginExercise(): void {
    stopTimer()
    const ex = currentEx.value
    if (!ex || !plan.value) return endLocal()
    phase.value = ex.kind === 'strength' ? 'exercise' : 'timed-ready'
    touch()
  }

  function completeSet(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'exercise') return
    ;(doneSets.value[ex.id] ??= []).push({ weight: weight.value, sec: null })
    startRest(setIndex.value >= effSets(ex))
  }

  function startRest(toNext: boolean): void {
    const ex = currentEx.value
    if (!ex) return endLocal()
    restTargetIsNextSet.value = !toNext
    phase.value = 'rest'
    restTotal.value = toNext && ex.restSec < 45 ? 45 : ex.restSec
    restLeft.value = restTotal.value
    startRestTimer()
    touch()
  }

  function startRestTimer(): void {
    stopTimer()
    timer = setInterval(() => {
      restLeft.value--
      if (restLeft.value <= 0) restOver()
    }, 1000)
  }

  function addRest(sec = 15): void {
    if (phase.value !== 'rest') return
    restLeft.value += sec
    touch()
  }

  /**
   * 临时休息：立刻进入指定分钟的倒计时，不推进流程；
   * 结束（或跳过）后回到进入前的阶段——力量做组原地继续，
   * 计时准备回到准备页，计时中续走秒表。
   */
  function startTempRest(min: number): boolean {
    if (phase.value !== 'exercise' && phase.value !== 'timed-ready' && phase.value !== 'timed-run') {
      return false
    }
    resumePhase.value = phase.value
    restIsTemp.value = true
    phase.value = 'rest'
    stopTimer()
    restTotal.value = Math.max(1, Math.round(min * 60))
    restLeft.value = restTotal.value
    startRestTimer()
    touch()
    return true
  }

  function skipRest(): void {
    if (phase.value === 'rest') {
      restLeft.value = 0
      restOver()
    }
  }

  function restOver(): void {
    stopTimer()
    const ex = currentEx.value
    if (!ex || !plan.value) return endLocal()

    // 临时休息：回到进入前的阶段，不推进任何进度
    if (restIsTemp.value) {
      restIsTemp.value = false
      phase.value = resumePhase.value
      if (resumePhase.value === 'timed-run') startTimedTicker()
      else if (resumePhase.value === 'exercise') {
        flashOverlay(`继续第 ${setIndex.value} 组`, ex.reps != null ? `${ex.reps} 次` : '')
      }
      touch()
      return
    }

    if (restTargetIsNextSet.value) {
      setIndex.value++
      phase.value = 'exercise'
      flashOverlay(`开始第 ${setIndex.value} 组`, ex.reps != null ? `${ex.reps} 次` : '')
      touch()
      return
    }

    if (isLastExercise.value) {
      phase.value = 'summary'
      touch()
      return
    }
    exIndex.value++
    setIndex.value = 1
    const next = currentEx.value!
    weight.value = next.weightKg ?? 0
    phase.value = next.kind === 'strength' ? 'exercise' : 'timed-ready'
    if (next.kind === 'strength') {
      flashOverlay(
        `下一个：${next.name}`,
        `${effSets(next)} 组${next.reps != null ? ` × ${next.reps} 次` : ''}`,
      )
    }
    touch()
  }

  function flashOverlay(label: string, sub: string): void {
    overlay.value = { show: true, label, sub, countFrom: 0 }
  }

  function onOverlayDone(): void {
    const leadsToRun = overlayLeadsToRun.value
    overlay.value = { show: false, label: '', sub: '', countFrom: 3 }
    overlayLeadsToRun.value = false
    if (leadsToRun) runTimed()
  }

  function prepareTimed(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'timed-ready') return
    overlayLeadsToRun.value = true
    overlay.value = { show: true, label: '', sub: `${ex.name} · 准备`, countFrom: 3 }
  }

  function startTimedTicker(): void {
    stopTimer()
    timer = setInterval(() => {
      timedElapsed.value = Math.round((timedElapsed.value + 0.1) * 10) / 10
    }, 100)
  }

  function runTimed(): void {
    const ex = currentEx.value
    if (!ex) return
    phase.value = 'timed-run'
    timedTotal.value = ex.targetSec ?? (ex.durationMin ?? 1) * 60
    timedElapsed.value = 0
    startTimedTicker()
    touch()
  }

  function finishTimed(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'timed-run') return
    stopTimer()
    ;(doneSets.value[ex.id] ??= []).push({ weight: null, sec: Math.round(timedElapsed.value) })
    startRest(setIndex.value >= effSets(ex))
  }

  function abortTimed(): void {
    stopTimer()
    phase.value = 'timed-ready'
    touch()
  }

  function bumpWeight(delta: number): void {
    weight.value = Math.max(0, Math.round((weight.value + delta) * 10) / 10)
    touch()
  }

  /** 再加一组：当前动作追加一组加量训练；休息若已流向下一动作则拉回本动作续打 */
  function addExtraSet(): void {
    const ex = currentEx.value
    if (!ex || phase.value === 'summary') return
    extraSets.value[ex.id] = (extraSets.value[ex.id] ?? 0) + 1
    if (phase.value === 'rest' && !restIsTemp.value && !restTargetIsNextSet.value) {
      restTargetIsNextSet.value = true
      flashOverlay(`加练 · ${ex.name}`, `第 ${setIndex.value + 1} 组`)
    }
    touch()
  }

  /**
   * 上一组：撤销最近完成的一组并回到该组重做（可能跳回上一个动作）。
   * 返回 false = 没有可重做的组。
   */
  function redoLastSet(): boolean {
    if (!plan.value) return false
    let idx = -1
    for (let i = exIndex.value; i >= 0; i--) {
      const arr = doneSets.value[plan.value.exercises[i].id]
      if (arr?.length) {
        idx = i
        break
      }
    }
    if (idx < 0) return false

    const ex = plan.value.exercises[idx]
    const arr = doneSets.value[ex.id]!
    arr.pop()

    stopTimer()
    restIsTemp.value = false
    exIndex.value = idx
    setIndex.value = Math.min(effSets(ex), arr.length + 1)
    weight.value = ex.weightKg ?? 0
    phase.value = ex.kind === 'strength' ? 'exercise' : 'timed-ready'
    flashOverlay(`${ex.name} · 重做`, `第 ${setIndex.value} 组`)
    touch()
    return true
  }

  /* ---------- 结束（用户显式操作） ---------- */

  /** 结束并保存：后端事务内写训练记录 + 关闭会话（允许提前结束，保存已完成进度） */
  async function finishAndSave(): Promise<SessionFinishResult | null> {
    if (!plan.value || !sessionId.value) return null
    const duration = durationMin.value
    const kcal = estimateKcalValue.value
    const volume = totalVolume.value
    const done = doneCount.value
    const total = totalCount.value
    const noteParts = [`${done}/${total} 组完成`]
    if (done < total) noteParts.push('提前结束')
    if (volume > 0) noteParts.push(`总容量约 ${volume} kg`)
    await sessionService.finish({
      id: sessionId.value,
      name: plan.value.name,
      workoutType: plan.value.workoutType,
      date: todayStr(),
      durationMin: duration,
      intensity: 'moderate',
      kcal,
      note: noteParts.join(' · '),
    })
    const result = { durationMin: duration, kcal, volume, done }
    await Promise.all([
      useExerciseStore().loadWeek(todayStr()),
      useNutritionStore().loadSummary(todayStr()),
    ])
    endLocal()
    return result
  }

  /** 放弃本次训练（已确认）：关闭会话，不写记录 */
  async function discard(): Promise<void> {
    const id = sessionId.value
    if (id) await discardById(id)
  }

  /** 外部放弃（如主页恢复卡） */
  async function discardById(id: number): Promise<void> {
    await sessionService.abort(id)
    if (sessionId.value === id) endLocal()
  }

  /** 本地重置（会话已由后端关闭） */
  function endLocal(): void {
    stopTimer()
    overlay.value = { show: false, label: '', sub: '', countFrom: 3 }
    overlayLeadsToRun.value = false
    sessionId.value = null
    startedAtIso.value = ''
    phase.value = 'idle'
    plan.value = null
    restIsTemp.value = false
    extraSets.value = {}
  }

  /* ---------- 中断恢复 ---------- */

  /**
   * 主页/运动页/会话页共用：从服务端恢复进行中的会话。
   * 返回 true = 本 store 已接续一场训练课；false = 无训练课
   * （可能存在跑步会话，此时 foreignRoute 指向 /session/run）。
   */
  async function hydrateFromServer(): Promise<boolean> {
    let rec: SessionRecord | null = null
    try {
      rec = await sessionService.getActive()
    } catch {
      rec = null
    }
    if (!rec) {
      if (phase.value === 'idle') return false
      return true // 本地已在训练中（服务端竞态），视为已恢复
    }
    if (rec.planId === RUN_PLAN_ID) {
      // 跑步会话归 run store 管：不吸收进课程状态机，仅指路
      foreignRoute.value = '/session/run'
      return phase.value !== 'idle' // 本地正在上训练课则保持现状
    }
    foreignRoute.value = null
    try {
      await applyRecord(rec)
    } catch (e) {
      // 记录损坏：按中断脏数据作废，避免卡死状态机
      console.warn('[session] 恢复失败，已作废该会话', e)
      await discardById(rec.id)
      return false
    }
    return true
  }

  async function applyRecord(rec: SessionRecord): Promise<void> {
    const planStore = usePlanStore()
    let p = planStore.byId(rec.planId)
    if (!p) {
      try {
        await planStore.ensureLoaded()
        p = planStore.byId(rec.planId)
      } catch {
        p = undefined
      }
    }
    if (!p) {
      // 课程已被删除：视为中断脏数据，直接作废
      await discardById(rec.id)
      return
    }
    sessionId.value = rec.id
    startedAtIso.value = rec.startedAt
    plan.value = p
    exIndex.value = Math.min(rec.exIndex, p.exercises.length - 1)
    setIndex.value = Math.max(1, rec.setIndex)
    weight.value = rec.weightKg
    doneSets.value = rec.state.doneSets ?? {}
    extraSets.value = rec.state.extraSets ?? {}
    restIsTemp.value = false
    restTargetIsNextSet.value = rec.state.restTargetIsNextSet ?? true
    timedTotal.value = rec.state.timedTotal ?? 0
    timedElapsed.value = 0

    const st = rec.state
    switch (st.phase) {
      case 'rest': {
        // 休息倒计时按真实流逝补偿（秒级）
        const delta = Math.max(0, (Date.now() - updatedAtMs(rec.updatedAt)) / 1000)
        const left = Math.max(0, Math.round((st.restLeft ?? 0) - delta))
        phase.value = 'rest'
        restLeft.value = left
        restTotal.value = Math.max(left, st.restLeft ?? left)
        // 临时休息被打断：保留回跳目标；计时中被打断则降级整组重做
        if (st.restIsTemp) {
          restIsTemp.value = true
          resumePhase.value =
            st.resumePhase === 'timed-run' ? 'timed-ready' : (st.resumePhase ?? 'exercise')
        }
        startRestTimer() // 归零后自动 restOver，保留被打断的流向
        break
      }
      case 'timed-run':
      case 'timed-ready':
        // 计时被打断：该组重做（避免按墙钟补时长的怪体验）
        phase.value = 'timed-ready'
        break
      case 'summary':
        phase.value = 'summary'
        break
      default:
        phase.value = 'exercise'
    }
  }

  /** SQLite "YYYY-MM-DD HH:MM:SS"(UTC) → 毫秒时间戳；容忍任意字符串/数字（mock 与未来格式） */
  function updatedAtMs(v: unknown): number {
    const raw = String(v ?? '')
    const t = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? Date.now() : ms
  }

  watch(phase, (p) => {
    if (p === 'idle') stopTimer()
  })

  return {
    sessionId,
    plan,
    phase,
    exIndex,
    setIndex,
    weight,
    doneSets,
    restLeft,
    restTotal,
    restTargetIsNextSet,
    restIsTemp,
    timedTotal,
    timedElapsed,
    overlay,
    persistError,
    foreignRoute,
    currentEx,
    exDoneSets,
    isLastExercise,
    doneCount,
    totalCount,
    totalVolume,
    durationMin,
    estimateKcalValue,
    isActive,
    start,
    completeSet,
    addRest,
    skipRest,
    startTempRest,
    addExtraSet,
    redoLastSet,
    effSets,
    onOverlayDone,
    prepareTimed,
    finishTimed,
    abortTimed,
    bumpWeight,
    finishAndSave,
    discard,
    discardById,
    hydrateFromServer,
  }
})
