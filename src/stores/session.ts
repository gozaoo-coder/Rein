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
  SessionSetSlot,
  SessionSnapshotState,
  StrengthLastWeight,
  StrengthSetRow,
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
  /** 激活热身组间休息：倒计时结束回到热身（或进入第一个正式组），不推进正式组数 */
  const restWarmup = ref(false)
  /** 「再加一组」追加的组数（动作 id → 追加数），随快照落盘 */
  const extraSets = ref<Record<string, number>>({})
  /**
   * 已跳过的正式组：动作 id → 被跳过的组号（1-based）。
   * 跳过 = 未做 = 不统计：不写 doneSets，但仍占据全课组位（进度分母不变）。
   */
  const skippedSets = ref<Record<string, number[]>>({})
  /** 各动作「最近一次做组重量」（开始课程时批量查询），预填用 */
  const lastWeights = ref<Record<string, StrengthLastWeight>>({})
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
      restWarmup: restWarmup.value,
      extraSets: extraSets.value,
      skippedSets: skippedSets.value,
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

  /** 某动作已完成的激活热身组数 */
  function warmupDone(e: PlanExercise): number {
    return (doneSets.value[e.id] ?? []).filter((d) => d.warmup).length
  }

  /** 该动作是否还有待做的激活热身组 */
  function warmupPending(e: PlanExercise): boolean {
    return e.kind === 'strength' && !!e.warmups?.length && warmupDone(e) < e.warmups.length
  }

  const doneCount = computed(() => {
    let n = 0
    for (const arr of Object.values(doneSets.value)) n += arr.filter((d) => !d.warmup).length
    return n
  })

  const totalCount = computed(() =>
    plan.value ? plan.value.exercises.reduce((s, e) => s + effSets(e), 0) : 0,
  )

  const totalVolume = computed(() => {
    let v = 0
    for (const ex of plan.value?.exercises ?? []) {
      if (ex.kind !== 'strength') continue
      const reps = ex.reps ?? 0
      for (const d of doneSets.value[ex.id] ?? []) {
        if (d.warmup) continue // 激活热身不计入训练容量
        v += (d.weight ?? 0) * reps
      }
    }
    return Math.round(v)
  })

  /**
   * 当前「待做 / 正在做」的组在全课组清单中的下标（0-based）；全部完成时为 length。
   * 休息中的推进方向决定游标：临时休息与热身组间停在原组，其余按已完成 +1 或进入下一动作。
   */
  const cursorIndex = computed<number>(() => {
    const p = plan.value
    if (!p) return 0
    let base = 0
    for (let i = 0; i < exIndex.value; i++) base += effSets(p.exercises[i]!)
    const cur = p.exercises[exIndex.value]
    if (!cur) return base
    switch (phase.value) {
      case 'idle':
        return base
      case 'summary':
        return totalCount.value
      case 'rest':
        // 临时休息 / 热身组间：不推进，游标仍停在当前组
        if (restIsTemp.value || restWarmup.value) return base + setIndex.value - 1
        // restTargetIsNextSet 时 setIndex 是刚做完的那一组，游标落到下一组
        return restTargetIsNextSet.value ? base + setIndex.value : base + effSets(cur)
      default:
        return base + setIndex.value - 1
    }
  })

  /**
   * 全课扁平化组清单（动作 × 组号），含每格状态。
   * 状态由「游标 + 跳过记录」唯一决定：游标之前的格子非完成即跳过，游标之后的都是待做。
   * 顶部进度格条与全课抽屉共用这一份数据，避免两处各算一套。
   */
  const setSlots = computed<SessionSetSlot[]>(() => {
    const p = plan.value
    if (!p) return []
    const cursor = cursorIndex.value
    const out: SessionSetSlot[] = []
    p.exercises.forEach((ex, exIdx) => {
      const skipped = skippedSets.value[ex.id]
      // 完成登记按完成顺序对齐：游标之前的非跳过的格子依次对应 nonWarmup 记录
      const nonWarm = (doneSets.value[ex.id] ?? []).filter((d) => !d.warmup)
      let k = 0
      for (let setNo = 1; setNo <= effSets(ex); setNo++) {
        const idx = out.length
        let state: SessionSetSlot['state'] = 'pending'
        if (idx < cursor) state = skipped?.includes(setNo) ? 'skipped' : 'done'
        else if (idx === cursor) state = 'current'
        const rec = state === 'done' ? (nonWarm[k] ?? null) : null
        if (state === 'done') k++
        out.push({
          exIdx,
          exId: ex.id,
          exName: ex.name,
          kind: ex.kind,
          setNo,
          state,
          done: rec ? { weight: rec.weight, sec: rec.sec } : null,
        })
      }
    })
    return out
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

  /** 批量拉取各动作「上次做组重量」；失败静默为空（预填退回计划重量） */
  async function loadLastWeights(names: string[]): Promise<void> {
    if (!names.length) return
    try {
      const rows = await sessionService.strengthLastWeights(names)
      const map: Record<string, StrengthLastWeight> = {}
      for (const r of rows) map[r.name] = r
      lastWeights.value = map
    } catch (e) {
      console.warn('[session] 上次重量查询失败', e)
      lastWeights.value = {}
    }
  }

  /** 重量预填：上次实际做组重量优先（渐进超负荷对照），无历史退回计划建议值 */
  function weightFor(e: PlanExercise): number {
    return lastWeights.value[e.name]?.weightKg ?? e.weightKg ?? 0
  }

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
    // 深拷贝动作列表：会话内允许临时换动作，不能直接改 planStore 里那份课程
    plan.value = { ...p, exercises: p.exercises.map(cloneExercise) }
    sessionId.value = null
    startedAtIso.value = new Date().toISOString()
    exIndex.value = 0
    setIndex.value = 1
    doneSets.value = {}
    extraSets.value = {}
    skippedSets.value = {}
    restIsTemp.value = false
    restWarmup.value = false
    await loadLastWeights(p.exercises.map((e) => e.name))
    weight.value = p.exercises[0] ? weightFor(p.exercises[0]) : 0
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

  /** 动作浅拷贝（热身组与肌群表也复制一层，保证会话内改动不外溢到课程库） */
  function cloneExercise(e: PlanExercise): PlanExercise {
    return {
      ...e,
      warmups: e.warmups?.map((w) => ({ ...w })),
      muscles: e.muscles ? { ...e.muscles } : undefined,
    }
  }

  function beginExercise(): void {
    stopTimer()
    const ex = currentEx.value
    if (!ex || !plan.value) return endLocal()
    restWarmup.value = false
    phase.value = warmupPending(ex) ? 'warmup' : ex.kind === 'strength' ? 'exercise' : 'timed-ready'
    touch()
  }

  function completeSet(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'exercise') return
    unmarkSkipped(ex.id, setIndex.value) // 跳过后又重做并完成的组，不再是「已跳过」
    ;(doneSets.value[ex.id] ??= []).push({ weight: weight.value, sec: null })
    startRest(setIndex.value >= effSets(ex))
  }

  /** 完成一组激活热身：按热身定义重量登记，随后 45 秒短休息 */
  function completeWarmup(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'warmup') return
    const idx = warmupDone(ex)
    const def = ex.warmups?.[idx]
    if (!def) return
    ;(doneSets.value[ex.id] ??= []).push({ weight: def.weightKg, sec: null, warmup: true })
    // 热身组间固定短休息；结束回热身（还有剩余组）或进入第一个正式组
    restWarmup.value = true
    phase.value = 'rest'
    restTotal.value = 45
    restLeft.value = restTotal.value
    startRestTimer()
    touch()
  }

  /** 跳过剩余热身，直接开始正式组 */
  function skipWarmup(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'warmup') return
    restWarmup.value = false
    phase.value = 'exercise'
    flashOverlay(`开始第 1 组`, ex.reps != null ? `${ex.reps} 次` : '')
    touch()
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

    // 热身组间休息：还有剩余热身组回热身，否则进入第一个正式组
    if (restWarmup.value) {
      restWarmup.value = false
      if (warmupPending(ex)) {
        phase.value = 'warmup'
        touch()
        return
      }
      // 恢复正式组预填重量（热身定义重量不应带进正式组）
      weight.value = weightFor(ex)
      phase.value = 'exercise'
      flashOverlay(`开始第 1 组`, ex.reps != null ? `${ex.reps} 次` : '')
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
    weight.value = weightFor(next)
    phase.value = warmupPending(next)
      ? 'warmup'
      : next.kind === 'strength'
        ? 'exercise'
        : 'timed-ready'
    if (next.kind === 'strength') {
      flashOverlay(
        `下一个：${next.name}`,
        warmupPending(next)
          ? '先做激活热身'
          : `${effSets(next)} 组${next.reps != null ? ` × ${next.reps} 次` : ''}`,
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
    unmarkSkipped(ex.id, setIndex.value)
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

  /**
   * 直接设定当前重量（页面上的「上次 62.5kg」等快捷 chip 走这里）。
   * 必须由 store 写入并 touch()，否则快照不落盘、进程被杀后恢复回预填值。
   */
  function setWeight(kg: number): void {
    if (!Number.isFinite(kg) || kg < 0) return
    weight.value = Math.round(kg * 10) / 10
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
   * 上一组：撤销最近完成的一组正式组并回到该组重做（可能跳回上一个动作）。
   * 激活热身组不可重做；返回 false = 没有可重做的组。
   */
  function redoLastSet(): boolean {
    if (!plan.value) return false
    let idx = -1
    for (let i = exIndex.value; i >= 0; i--) {
      const arr = doneSets.value[plan.value.exercises[i].id]
      if (arr?.some((d) => !d.warmup)) {
        idx = i
        break
      }
    }
    if (idx < 0) return false

    const ex = plan.value.exercises[idx]
    const arr = doneSets.value[ex.id]!
    for (let k = arr.length - 1; k >= 0; k--) {
      if (!arr[k]!.warmup) {
        arr.splice(k, 1)
        break
      }
    }

    stopTimer()
    restIsTemp.value = false
    restWarmup.value = false
    exIndex.value = idx
    setIndex.value = Math.min(effSets(ex), arr.filter((d) => !d.warmup).length + 1)
    clearSkippedFrom(idx, setIndex.value) // 回退后该区间重新变成待做
    weight.value = ex.kind === 'strength' ? weightFor(ex) : 0
    phase.value = ex.kind === 'strength' ? 'exercise' : 'timed-ready'
    flashOverlay(`${ex.name} · 重做`, `第 ${setIndex.value} 组`)
    touch()
    return true
  }

  /* ---------- 跳过：跳过 = 未做 = 不统计 ---------- */

  /** 某动作已完成（且计入统计）的正式组数 */
  function exDoneCount(exId: string): number {
    return (doneSets.value[exId] ?? []).filter((d) => !d.warmup).length
  }

  function markSkipped(exId: string, setNo: number): void {
    const arr = (skippedSets.value[exId] ??= [])
    if (!arr.includes(setNo)) arr.push(setNo)
  }

  function unmarkSkipped(exId: string, setNo: number): void {
    const arr = skippedSets.value[exId]
    if (!arr) return
    const i = arr.indexOf(setNo)
    if (i >= 0) arr.splice(i, 1)
  }

  /**
   * 清除 (exIdx, fromSetNo) 及其之后的所有跳过登记。
   * 回退进度（上一组重做）后该区间重新变成待做，留着旧标记会让「重新完成过的组」
   * 被误判成已跳过 —— 跳过登记必须与「游标之前的格子非完成即跳过」这条不变量一致。
   */
  function clearSkippedFrom(exIdx: number, fromSetNo: number): void {
    const p = plan.value
    if (!p) return
    for (let i = p.exercises.length - 1; i > exIdx; i--) {
      const ex = p.exercises[i]
      if (ex) delete skippedSets.value[ex.id]
    }
    const ex = p.exercises[exIdx]
    if (!ex) return
    const arr = skippedSets.value[ex.id]
    if (!arr) return
    const kept = arr.filter((n) => n < fromSetNo)
    if (kept.length) skippedSets.value[ex.id] = kept
    else delete skippedSets.value[ex.id]
  }

  /**
   * 跳过当前组：不写 doneSets（不计入完成数与总容量），只登记跳过并推进流程。
   * 推进规则与「完成一组」完全一致（最后一组 → 下一动作 / 总结），
   * 保证跳过不会把状态机留在非法位置；返回 false = 当前阶段没有可跳过的组。
   */
  function skipCurrentSet(): boolean {
    const ex = currentEx.value
    if (!ex) return false
    const p = phase.value
    if (p !== 'exercise' && p !== 'timed-ready' && p !== 'timed-run') return false
    if (p === 'timed-run') stopTimer()
    markSkipped(ex.id, setIndex.value)
    startRest(setIndex.value >= effSets(ex))
    return true
  }

  /**
   * 跳至该组：把当前组到目标组之间（不含目标）的所有组登记为跳过，然后定位到目标组。
   * 只允许向前跳到「未做」的组（含当前待做组）——回跳会抹掉已完成的真实记录，不提供。
   * 目标动作仍有未完成的热身组时直接跳过热身，因为「跳至该组」的语义就是立刻开始这一组。
   */
  function skipToSet(exIdx: number, setNo: number): boolean {
    const p = plan.value
    if (!p) return false
    const target = p.exercises[exIdx]
    if (!target) return false
    if (setNo < 1 || setNo > effSets(target)) return false

    const slots = setSlots.value
    const targetIdx = slots.findIndex((s) => s.exIdx === exIdx && s.setNo === setNo)
    if (targetIdx < 0 || targetIdx < cursorIndex.value) return false

    stopTimer()
    for (let i = cursorIndex.value; i < targetIdx; i++) {
      const slot = slots[i]!
      markSkipped(slot.exId, slot.setNo)
    }
    unmarkSkipped(target.id, setNo)

    restIsTemp.value = false
    restWarmup.value = false
    exIndex.value = exIdx
    setIndex.value = setNo
    weight.value = target.kind === 'strength' ? weightFor(target) : 0
    phase.value = target.kind === 'strength' ? 'exercise' : 'timed-ready'
    flashOverlay(
      `跳至 ${target.name}`,
      `第 ${setNo} 组${target.reps != null ? ` · ${target.reps} 次` : ''}`,
    )
    touch()
    return true
  }

  /* ---------- 临时更换未做的动作 ---------- */

  /** 该动作是否还没做任何一组（含跳过但一组未完成的情形）——可换动作的前提 */
  function canSwapExercise(exIdx: number): boolean {
    const ex = plan.value?.exercises[exIdx]
    return !!ex && exDoneCount(ex.id) === 0
  }

  /**
   * 临时把某个未做的动作换成另一个动作：只换动作本体（名称 / 要点 / 肌群），
   * 组数、次数、休息、热身组等编排全部沿用本课程原动作——全课组数不变，
   * 因此不会打乱已有进度与全课组清单的下标。仅允许换成同类型动作。
   */
  function swapExercise(exIdx: number, src: PlanExercise): boolean {
    const p = plan.value
    if (!p) return false
    const cur = p.exercises[exIdx]
    if (!cur || cur.kind !== src.kind || !canSwapExercise(exIdx)) return false
    p.exercises[exIdx] = {
      ...cur,
      name: src.name,
      tips: src.tips || cur.tips,
      muscles: src.muscles,
    }
    if (exIdx === exIndex.value) {
      weight.value = cur.kind === 'strength' ? weightFor(p.exercises[exIdx]!) : 0
    }
    touch()
    return true
  }

  /* ---------- 结束（用户显式操作） ---------- */

  /** 把最终快照展开为逐组明细行（session_finish 事务内写入 workout_sets，重量曲线数据源） */
  function buildSetRows(): StrengthSetRow[] {
    const rows: StrengthSetRow[] = []
    for (const ex of plan.value?.exercises ?? []) {
      const list = doneSets.value[ex.id]
      if (!list?.length) continue
      let warmNo = 0
      let setNo = 0
      for (const d of list) {
        if (d.warmup) warmNo++
        else setNo++
        rows.push({
          exerciseKey: ex.id,
          exerciseName: ex.name,
          kind: ex.kind,
          setNo: d.warmup ? warmNo : setNo,
          weightKg: d.weight,
          reps: d.warmup ? (ex.warmups?.[warmNo - 1]?.reps ?? null) : ex.reps,
          sec: d.sec,
          warmup: !!d.warmup,
        })
      }
    }
    return rows
  }

  /** 结束并保存：后端事务内写训练记录 + 逐组明细 + 关闭会话（允许提前结束，保存已完成进度） */
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
      sets: buildSetRows(),
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
    restWarmup.value = false
    extraSets.value = {}
    skippedSets.value = {}
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
    plan.value = { ...p, exercises: p.exercises.map(cloneExercise) }
    exIndex.value = Math.min(rec.exIndex, p.exercises.length - 1)
    setIndex.value = Math.max(1, rec.setIndex)
    weight.value = rec.weightKg
    doneSets.value = rec.state.doneSets ?? {}
    extraSets.value = rec.state.extraSets ?? {}
    skippedSets.value = rec.state.skippedSets ?? {}
    restIsTemp.value = false
    restWarmup.value = rec.state.restWarmup ?? false
    restTargetIsNextSet.value = rec.state.restTargetIsNextSet ?? true
    timedTotal.value = rec.state.timedTotal ?? 0
    timedElapsed.value = 0
    void loadLastWeights(p.exercises.map((e) => e.name)) // 供后续动作的重量预填

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
      case 'warmup':
        // 激活热身中被打断：原地续做（已完成的组保留在 doneSets）
        phase.value = 'warmup'
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
    restWarmup,
    lastWeights,
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
    cursorIndex,
    setSlots,
    skippedSets,
    durationMin,
    estimateKcalValue,
    isActive,
    start,
    completeSet,
    completeWarmup,
    skipWarmup,
    warmupDone,
    warmupPending,
    addRest,
    skipRest,
    startTempRest,
    addExtraSet,
    redoLastSet,
    effSets,
    exDoneCount,
    skipCurrentSet,
    skipToSet,
    canSwapExercise,
    swapExercise,
    onOverlayDone,
    prepareTimed,
    finishTimed,
    abortTimed,
    bumpWeight,
    setWeight,
    finishAndSave,
    discard,
    discardById,
    hydrateFromServer,
  }
})
