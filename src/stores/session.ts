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
import { useToast } from '@/composables/useToast'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { usePlanStore } from '@/stores/plan'
import { todayStr } from '@/utils/date'
import { computeTrainingAdvice, type ExerciseAdvice, type TrainingAdvice } from '@/utils/trainingAdvice'
import { setVolumeKg } from '@/utils/sessionSummary'
import { warmupPlan, type WarmupPrescription } from '@/utils/warmup'
import { RUN_PLAN_ID } from '@/types'
import type {
  DoneSet,
  GatewaySessionFinish,
  PlanExercise,
  PlanExerciseOverride,
  SessionPhase,
  SessionRecord,
  SessionSetSlot,
  SessionSnapshotState,
  StrengthLastWeight,
  StrengthSetRow,
  SwapCandidate,
  WarmupSet,
  WorkoutPlan,
} from '@/types'

/** 结束并保存的返回值（写完训练记录后立即展示用） */
export interface SessionFinishResult {
  durationMin: number
  kcal: number
  volume: number
  done: number
}

/**
 * 恢复一场进行中的会话的结果（`applyRecord`）：
 *  · `'restored'` 恢复成功，本 store 已接续这一场；
 *  · `'deleted'`  库里确实没有这门课 —— 会话已作废（`discardById`），调用方可以继续开新课；
 *  · `'retry'`    课程列表暂时拉不到，**会话仍保留在服务端**，等下一轮（回前台 / 下次启动）再试。
 *
 * 为什么必须显式返回：以前「拉不到课程列表」与「课程被删」并进同一个作废分支，而调用方
 * 没有任何信号能区分二者 —— `phase === 'idle'` 在两种情况下都成立（`'retry'` 时 phase
 * 同样是 idle）。冲突分支的判定（是否还要弹「请先接续」、是否可以直接开新课）依赖它。
 */
export type ApplyRecordResult = 'restored' | 'deleted' | 'retry'

export const useSessionStore = defineStore('session', () => {  const sessionId = ref<number | null>(null)
  const startedAtIso = ref('')
  const plan = ref<WorkoutPlan | null>(null)
  const phase = ref<SessionPhase>('idle')
  const exIndex = ref(0)
  const setIndex = ref(1) // 展示用，1-based
  const weight = ref(0)
  /**
   * 当前组的现场次数：力量动作可临时改写（实际做了 7 次就记 7），完成即登记到该组。
   * 进入新动作时回落到课程定义；null = 该动作未配次数（此时页面显示占位，用户可自行键入）。
   */
  const reps = ref<number | null>(null)
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
  /**
   * 会话内临时换掉的动作（键 = 课程条目 id）。必须随快照落盘：恢复路径是按 planId
   * 从课程库重建 plan 的，只存在内存里的换动作会被抹掉，而 `doneSets` 的键仍是课程条目
   * id —— 那批组就会以**原动作**的身份落进 workout_sets（曲线聚合键），事后不可逆。
   */
  const exerciseOverrides = ref<Record<string, PlanExerciseOverride>>({})
  /** 各动作「最近一次做组重量」（开始课程时批量查询，键 = 动作库 id），预填用 */
  const lastWeights = ref<Record<string, StrengthLastWeight>>({})
  /** 今日训练建议（纯函数引擎算出的预填与依据）；null = 尚未计算 */
  const advice = ref<TrainingAdvice | null>(null)
  /** 今日状态自评 1..5；null = 未自评（建议引擎纯自动推断） */
  const readiness = ref<number | null>(null)
  const timedTotal = ref(0)
  const timedElapsed = ref(0)

  const overlay = ref({ show: false, label: '', sub: '', countFrom: 3 })
  const overlayLeadsToRun = ref(false)

  /** 最近一次落盘失败（SessionPage 顶部显示警示，不阻塞训练） */
  const persistError = ref('')
  /**
   * 最近一次结束/放弃动作本身失败（写库未成功）。与 persistError 同族：
   * 失败原样抛给调用点 toast 原因，本地**不**收尾 —— 层与总结态保留、会话
   * 仍 active，用户可原样重试（同一 sessionId）。
   */
  const finishError = ref('')

  /** 检测到 active 会话但不属于训练课（如跑步）时，指引用户前往的正确页面 */
  const foreignRoute = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null
  /** 休息倒数的截止墙钟：剩余秒一律由它推导。interval 触发只做「感知」，
   *  不做「累计」——被系统节流 / WebView 挂起后恢复的第一拍立即校正到
   *  真实剩余，不会出现递减式计时那种异常过长的休息。 */
  let restDeadlineMs = 0

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
      reps: reps.value,
      extraSets: extraSets.value,
      skippedSets: skippedSets.value,
      readiness: readiness.value,
      exerciseOverrides: exerciseOverrides.value,
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

  /* ---------- 运行态上报（contract §14.2） ---------- */

  /** 上报周期（毫秒）：活跃会话每秒对一次当前快照，**变了才写**。 */
  const REPORT_INTERVAL_MS = 1000
  let reportTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次上报的载荷（JSON）：与它相同就不发。 */
  let lastReported = ''

  function stopReporter(): void {
    if (reportTimer) {
      clearInterval(reportTimer)
      reportTimer = null
    }
    lastReported = ''
  }

  function startReporter(): void {
    reportTimer ??= setInterval(reportTick, REPORT_INTERVAL_MS)
  }

  /** 每秒对一次快照：`elapsed_sec` 由服务端按两次快照的间隔累加，安静相位不必每秒刷。
   *  休息倒计时（`state.restLeft`）逐秒变，所以休息期间自然每秒落一盘。 */
  function reportTick(): void {
    if (!sessionId.value) {
      stopReporter()
      return
    }
    const payload = {
      id: sessionId.value,
      exIndex: exIndex.value,
      setIndex: setIndex.value,
      weightKg: weight.value,
      state: snapshotState(),
    }
    const key = JSON.stringify(payload)
    if (key === lastReported) return
    lastReported = key
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
    const rx = warmupsFor(e)
    return rx.length > 0 && warmupDone(e) < rx.length
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
      for (const d of doneSets.value[ex.id] ?? []) {
        if (d.warmup) continue // 激活热身不计入训练容量
        // 口径走全端唯一的 setVolumeKg（次数按 逐组登记 → 课程处方 → 1 回落），
        // 与总结页、运动详情抽屉是同一份 —— 这三处曾经各算一套、同一节课给出两个总容量
        v += setVolumeKg(d.weight, d.reps ?? null, ex.reps)
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
          done: rec ? { weight: rec.weight, sec: rec.sec, reps: rec.reps } : null,
        })
      }
    })
    return out
  })

  /**
   * 单个动作的激活热身组格子。
   * 状态判定：已完成的按登记值，当前动作的「下一个待做热身」为 current，
   * 已经越过该动作（或热身已跳过 / 已结束）仍未做的热身组记为 skipped——不再补做。
   */
  function warmupSlotsFor(ex: PlanExercise, exIdx: number): SessionSetSlot[] {
    const rx = warmupsFor(ex)
    if (ex.kind !== 'strength' || !rx.length) return []
    const wd = warmupDone(ex)
    const recs = (doneSets.value[ex.id] ?? []).filter((d) => d.warmup)
    const isCur = exIdx === exIndex.value
    const inWarmup = isCur && (phase.value === 'warmup' || (phase.value === 'rest' && restWarmup.value))
    return rx.map((def, i): SessionSetSlot => {
      let state: SessionSetSlot['state'] = 'pending'
      if (i < wd) state = 'done'
      else if (inWarmup) state = i === wd ? 'current' : 'pending'
      else if (isCur) state = 'skipped' // 热身已跳过或已结束
      else if (exIdx < exIndex.value) state = 'skipped'
      const rec = state === 'done' ? (recs[i] ?? null) : null
      return {
        exIdx,
        exId: ex.id,
        exName: ex.name,
        kind: ex.kind,
        setNo: i + 1,
        warmup: true,
        state,
        done: rec ? { weight: rec.weight, sec: rec.sec, reps: rec.reps ?? def.reps } : null,
      }
    })
  }

  /**
   * 全课组清单 + 激活热身组：全课程进度抽屉的唯一数据源。
   * 游标（cursorIndex）只按正式组推进，因此热身格在这里单独拼装，
   * 不进 setSlots —— 否则会污染进度格条与「跳至该组」的下标语义。
   */
  const courseSlots = computed<SessionSetSlot[]>(() => {
    const p = plan.value
    if (!p) return []
    const formal = setSlots.value
    const out: SessionSetSlot[] = []
    let k = 0
    p.exercises.forEach((ex, exIdx) => {
      out.push(...warmupSlotsFor(ex, exIdx))
      while (k < formal.length && formal[k]!.exIdx === exIdx) out.push(formal[k++]!)
    })
    return out
  })

  /** 会话墙钟时长（跨重启仍准确，因为 startedAt 持久化） */
  const durationMin = computed(() =>
    startedAtIso.value ? Math.max(1, Math.round((Date.now() - Date.parse(startedAtIso.value)) / 60_000)) : 0,
  )

  /**
   * 墙钟秒数（同一份 startedAt 推导，不另存）。
   * 总结页要它是因为「每组耗时」是秒级的：拿 durationMin（且至少 1 分钟）
   * 去除，会把 45 秒的快节奏课算成 60 秒/组 —— 分钟级的取整在这里是失真的。
   * 未开始时返回 0（不是 60）：调用方据此不渲染，而不是渲染出一个假的数。
   */
  const durationSec = computed(() => {
    if (!startedAtIso.value) return 0
    const t = Date.parse(startedAtIso.value)
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.round((Date.now() - t) / 1000))
  })

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

  /* ---------- 建议引擎（平均状态 × 今日状态 → 今日处方） ---------- */

  /**
   * 拉取近 42 天做组记录 + 动作库，算一份训练建议。
   * 引擎是纯函数（utils/trainingAdvice），这里只负责取数与组装；失败静默降级为「无建议」，
   * 预填退回上次重量 / 课程建议值 —— 建议永远不能阻塞训练。
   */
  async function loadAdvice(): Promise<void> {
    if (!plan.value) {
      advice.value = null
      return
    }
    try {
      const lib = useExerciseLibStore()
      await lib.ensureLoaded()
      const sets = await sessionService.strengthRecentSets(42)
      advice.value = computeTrainingAdvice({
        sets,
        library: lib.list,
        planExercises: plan.value.exercises,
        today: todayStr(),
        selfRating: readiness.value,
      })
    } catch (e) {
      console.warn('[session] 训练建议计算失败', e)
      advice.value = null
    }
  }

  /** 某动作的今日建议（键 = 动作库 id，回落课程条目 id / 动作名） */
  function adviceFor(e: PlanExercise): ExerciseAdvice | null {
    const a = advice.value
    if (!a) return null
    return a.perExercise[e.exerciseId] ?? a.perExercise[e.name] ?? null
  }

  /** 今日状态自评：写入后重算建议（引擎里自评是 readiness 的一个乘项） */
  function setReadiness(v: number | null): void {
    readiness.value = v
    // 自评会改变推荐重量 → 热身处方随之变化；还没开做的热身要把预填对齐过去
    if (plan.value) void loadAdvice().then(() => resyncWarmupPrefill())
    touch()
  }

  /** 批量拉取各动作「上次做组重量」（按动作库 id）；失败静默为空（预填退回建议值/计划重量） */
  async function loadLastWeights(ids: string[]): Promise<void> {
    const keys = ids.filter((k) => !!k)
    if (!keys.length) return
    try {
      const rows = await sessionService.strengthLastWeights(keys)
      const map: Record<string, StrengthLastWeight> = {}
      for (const r of rows) map[r.exerciseId] = r
      lastWeights.value = map
    } catch (e) {
      console.warn('[session] 上次重量查询失败', e)
      lastWeights.value = {}
    }
  }

  /**
   * 定向补取若干动作的「上次做组重量」并**合并**进现有表。
   *
   * 与 `loadLastWeights` 的区别只在写入方式：那个是整表替换（开局一次性拉全部动作，
   * 替换是对的），而中途补一个动作时替换会把其它动作的上次重量**全部清空** ——
   * 那一刻若建议引擎恰好不可用，后面每个动作的预填都会退化成课程重量。
   */
  async function mergeLastWeights(ids: string[]): Promise<void> {
    const keys = ids.filter((k) => !!k)
    if (!keys.length) return
    try {
      const rows = await sessionService.strengthLastWeights(keys)
      const next = { ...lastWeights.value }
      for (const r of rows) next[r.exerciseId] = r
      lastWeights.value = next
    } catch (e) {
      console.warn('[session] 上次重量补取失败', e)
    }
  }

  /**
   * 重量预填优先级：今日建议（引擎）→ 上次实际做组重量 → 课程建议值。
   * 建议已经包含「上次重量 + 双重渐进 / 今日状态降载」的判断，所以排在最前；
   * 引擎不可用（无模型无历史等异常）时逐级回落，行为与改造前一致。
   */
  function weightFor(e: PlanExercise): number {
    const suggested = adviceFor(e)?.suggestedWeight
    if (suggested != null && suggested > 0) return suggested
    return lastWeights.value[e.exerciseId]?.weightKg ?? e.weightKg ?? 0
  }

  /**
   * 当前动作的工作重量（正式组那一档）——与 weightFor 同源，单独暴露给界面
   * 与 AI 工具：热身处方的换算说明要显示「按多少 kg 算的」。
   */
  function workingWeightFor(e: PlanExercise): number {
    return weightFor(e)
  }

  /**
   * 某动作的激活热身处方：以「当天推荐重量」为基准实时换算（见 `utils/warmup.ts`）。
   *
   * 这里是热身重量的**唯一真源** —— 推荐重量一变（渐进超负荷加档 / 低状态日降载 /
   * 用户改今日自评），热身就跟着变，不再是课程里按旧重量编死的两档。
   * 课程条目里的 `warmups` 只在拿不到工作重量（无建议引擎 / 无历史 / 无计划重量）时
   * 作回落，保证首次训练与离线场景仍能热身。
   */
  function warmupPlanFor(e: PlanExercise): WarmupPrescription | null {
    if (e.kind !== 'strength') return null
    const w = weightFor(e)
    if (w <= 0) return { sets: e.warmups ?? [], usedBaseline: false }
    // 百分比乘的是**当天的估算极限（e1RM）**，不是工作重量 —— 见 utils/warmup.ts 顶部
    // 「百分比乘错基准」那段。拿不到极限（新动作 / 换器械 / 无历史）时函数内部自己回落
    // 绝对阈值；`usedBaseline` 随处方一起交出来，界面脚注与 AI 输出才能如实写出基准，
    // 而不是一律写「按推荐重量换算」—— 那样有基线时文案就在说谎。
    return warmupPlan(w, { e1rm: adviceFor(e)?.todayCeiling ?? null })
  }

  function warmupsFor(e: PlanExercise): WarmupSet[] {
    return warmupPlanFor(e)?.sets ?? []
  }

  /**
   * 进入某动作时的重量预填：还在做激活热身 → 取当前热身组的处方重量，
   * 否则用正式组重量（上次实际 / 计划建议）。热身态与正式态共用同一个 weight 状态，
   * 两个阶段都支持现场调整，切换阶段时必须重新预填，否则热身的小重量会带进正式组。
   */
  function weightForPhase(e: PlanExercise): number {
    if (warmupPending(e)) return warmupsFor(e)[warmupDone(e)]?.weightKg ?? weightFor(e)
    return e.kind === 'strength' ? weightFor(e) : 0
  }

  /**
   * 建议变化后（今日自评重算 / 恢复会话异步取到建议）把预填重量对齐到新处方。
   * 只在「还一组热身都没做」时动 —— 已经做过热身再改预填会把现场登记值抹掉。
   */
  function resyncWarmupPrefill(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'warmup') return
    if (warmupDone(ex) > 0) return
    weight.value = weightForPhase(ex)
    touch()
  }

  /** 现场次数回落：新动作取课程定义，非力量动作无次数 */
  function syncReps(e: PlanExercise): void {
    reps.value = e.kind === 'strength' ? e.reps : null
  }

  /**
   * 开始新训练。已有进行中会话时返回 'conflict'（conflictRoute 指向应接续的
   * 页面：训练课 /session 或跑步 /session/run），由调用方给出「前往继续」。
   *
   * 失败回执：本函数内可抛的 await 有三处（getActive / 建议与上次重量 /
   * session_start），统一在此 toast 一条「开课失败：<原因>」再原样抛出 ——
   * 提示方式由 store 决定、service 层不吞错（ARCHITECTURE §3）；调用方只需
   * catch 复位按钮，无需各自再提示。
   */
  async function start(
    p: WorkoutPlan,
    /** 外部下行控制（`workout.sessionStart` 载荷，contract §14.3）带入：起始时刻与初始快照。
     *  省略时 = 本地此刻起跑 + 空进度，与不含参数时行为一致。 */
    opts?: { startedAt?: string; state?: SessionSnapshotState },
  ): Promise<'ok' | 'conflict'> {
    try {
      const existing = await sessionService.getActive()
      if (existing) {
        if (existing.planId === RUN_PLAN_ID) {
          foreignRoute.value = '/session/run'
          return 'conflict'
        }
        // 走到这里说明服务端那条 active 行不是跑步，而 `foreignRoute` 可能还留着上一次跑步
        // 写进去的 `/session/run`（跑步正常结束走 run store，不会碰这个字段）—— 不清掉的话
        // 「前往继续」会把人送到跑步页。跑步分支在上面就已经 return，不会被这里误清。
        foreignRoute.value = null
        const restored = await applyRecord(existing)
        // 'deleted'：课程确已被删、`applyRecord` 已作废该会话 —— 不该再弹「请先接续」这条
        //           对已作废会话的伪提示，继续往下正常开课。
        // 'restored' / 'retry'：都返回冲突。'retry' 尤其**不能**继续往下走 ——
        //           `session_start` 会把服务端那条 active 行标成 aborted，正好销毁掉
        //           我们想保留的会话（保留它就是 'retry' 存在的意义）。
        if (restored !== 'deleted') return 'conflict'
      }
      // 深拷贝动作列表：会话内允许临时换动作，不能直接改 planStore 里那份课程
      plan.value = { ...p, exercises: p.exercises.map(cloneExercise) }
      sessionId.value = null
      // 起始时刻：载荷给了可用值就用它（时长 / 记录以它为准），否则本地此刻
      const seedStartedAt = opts?.startedAt
      startedAtIso.value =
        seedStartedAt && !Number.isNaN(Date.parse(seedStartedAt)) ? seedStartedAt : new Date().toISOString()
      exIndex.value = 0
      setIndex.value = 1
      doneSets.value = {}
      extraSets.value = {}
      skippedSets.value = {}
      restIsTemp.value = false
      restWarmup.value = false
      readiness.value = null
      advice.value = null
      finishError.value = ''
      await Promise.all([
        loadAdvice(), // 建议要在预填之前算好（weightFor 以它为先）
        loadLastWeights(p.exercises.map((e) => e.exerciseId)),
      ])
      weight.value = p.exercises[0] ? weightFor(p.exercises[0]) : 0
      const seed = opts?.state
      const rec = await sessionService.start({
        planId: p.id,
        planName: p.name,
        startedAt: startedAtIso.value,
        // 初始快照：载荷给了就用它，否则空进度（相位以第一个动作的类型为准，见 beginExercise）
        state: seed ?? { doneSets: {}, exIndex: 0, setIndex: 1, weight: weight.value, phase: 'exercise' },
      })
      sessionId.value = rec.id
      if (seed) {
        // 外部载入的进度必须同时接管**本地**状态机：紧接着的落盘会把本地内存态当写入源，
        // 不同步就会在下一拍用空进度把外部给的状态冲掉（与 sessionSnapshot 同一条路径）。
        await applyExternalSnapshot({
          id: rec.id,
          exIndex: Math.min(Math.max(0, Math.trunc(seed.exIndex)), Math.max(0, p.exercises.length - 1)),
          setIndex: Math.max(1, Math.trunc(seed.setIndex)),
          weightKg: seed.weight,
          state: seed,
        })
      } else {
        beginExercise()
        await persist()
      }
      void usePlanStore().touch(p.id) // 维护「最近使用」排序
      return 'ok'
    } catch (e: unknown) {
      // 只发一次、成功路径不发；写库未开始/已开始都不构成残留（session_start 未返回即无 active 行）
      useToast().toast(`开课失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
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
    weight.value = weightForPhase(ex)
    syncReps(ex)
    touch()
  }

  function completeSet(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'exercise') return
    unmarkSkipped(ex.id, setIndex.value) // 跳过后又重做并完成的组，不再是「已跳过」
    ;(doneSets.value[ex.id] ??= []).push({
      weight: weight.value,
      sec: null,
      reps: reps.value ?? ex.reps,
    })
    startRest(setIndex.value >= effSets(ex))
  }

  /** 完成一组激活热身：按现场（可调整过的）重量登记，随后 45 秒短休息 */
  function completeWarmup(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'warmup') return
    const idx = warmupDone(ex)
    const def = warmupsFor(ex)[idx]
    if (!def) return
    ;(doneSets.value[ex.id] ??= []).push({
      weight: weight.value,
      sec: null,
      reps: def.reps,
      warmup: true,
    })
    // 热身组间固定短休息；结束回热身（还有剩余组）或进入第一个正式组
    restWarmup.value = true
    phase.value = 'rest'
    restTotal.value = 45
    restLeft.value = restTotal.value
    startRestTimer()
    touch()
  }

  /** 跳过剩余热身，直接开始正式组（重量必须从小重量切回正式重量） */
  function skipWarmup(): void {
    const ex = currentEx.value
    if (!ex || phase.value !== 'warmup') return
    restWarmup.value = false
    phase.value = 'exercise'
    weight.value = weightFor(ex)
    flashOverlay(`开始第 1 组`, reps.value != null ? `${reps.value} 次` : '')
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
    restDeadlineMs = Date.now() + restLeft.value * 1000
    // 高频轮询只为及时感知归零；秒数本身从 deadline 推导，节流不丢时
    timer = setInterval(tickRest, 250)
  }

  function tickRest(): void {
    const left = Math.ceil((restDeadlineMs - Date.now()) / 1000)
    if (left === restLeft.value) return
    restLeft.value = left
    if (left <= 0) restOver()
  }

  function addRest(sec = 15): void {
    if (phase.value !== 'rest') return
    restLeft.value += sec
    restDeadlineMs += sec * 1000
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
        flashOverlay(`继续第 ${setIndex.value} 组`, reps.value != null ? `${reps.value} 次` : '')
      }
      touch()
      return
    }

    // 热身组间休息：还有剩余热身组回热身，否则进入第一个正式组
    if (restWarmup.value) {
      restWarmup.value = false
      if (warmupPending(ex)) {
        phase.value = 'warmup'
        weight.value = weightForPhase(ex) // 预填下一个热身组的重量
        touch()
        return
      }
      // 恢复正式组预填重量（热身定义重量不应带进正式组）
      weight.value = weightFor(ex)
      phase.value = 'exercise'
      flashOverlay(`开始第 1 组`, reps.value != null ? `${reps.value} 次` : '')
      touch()
      return
    }

    if (restTargetIsNextSet.value) {
      setIndex.value++
      // 下一组仍按动作类型分流：计时/有氧回准备页（倒数后开跑），力量直接进做组
      phase.value = ex.kind === 'strength' ? 'exercise' : 'timed-ready'
      if (ex.kind === 'strength') {
        // 同一动作内保留用户的次数改写（改做 6 次就连着 6 次），重量同理保留
        flashOverlay(`开始第 ${setIndex.value} 组`, reps.value != null ? `${reps.value} 次` : '')
      }
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
    weight.value = weightForPhase(next)
    syncReps(next)
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
    // 秒表锚定墙钟：elapsed 由 (now - anchor) 推导；临时休息冻结期间
    // ticker 停转，恢复时以旧 elapsed 重设锚点续走，节流挂起均不丢时
    const anchorMs = Date.now() - timedElapsed.value * 1000
    timer = setInterval(() => {
      timedElapsed.value = (Date.now() - anchorMs) / 1000
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

  /**
   * 直接设定当前重量（页面大数字键入与「上次 / 计划」快捷 chip 都走这里）。
   * 必须由 store 写入并 touch()，否则快照不落盘、进程被杀后恢复回预填值。
   */
  function setWeight(kg: number): void {
    if (!Number.isFinite(kg) || kg < 0) return
    weight.value = Math.round(kg * 10) / 10
    touch()
  }

  /**
   * 直接设定当前组的次数（页面大数字键入走这里）。
   * 传 null = 清空（该动作本就没配次数时用）；负数按 0 处理。
   */
  function setReps(n: number | null): void {
    reps.value = n == null || !Number.isFinite(n) ? null : Math.max(0, Math.round(n))
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
    weight.value = weightForPhase(ex)
    syncReps(ex)
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
    // 跳至某组 = 直接开打正式组：热身一并跳过，重量回到正式组预填值
    weight.value = target.kind === 'strength' ? weightFor(target) : 0
    syncReps(target)
    phase.value = target.kind === 'strength' ? 'exercise' : 'timed-ready'
    flashOverlay(
      `跳至 ${target.name}`,
      `第 ${setNo} 组${reps.value != null ? ` · ${reps.value} 次` : ''}`,
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
   * 临时把某个未做的动作换成另一个动作：只换动作本体（名称 / 要点 / 肌群 / 库内默认重量），
   * 组数、次数、休息、热身组等编排全部沿用本课程原动作——全课组数不变，
   * 因此不会打乱已有进度与全课组清单的下标。仅允许换成同类型动作。
   *
   * ⚠️ **重量必须一起换**：`{...cur}` 会把**被换掉那个动作**的课程处方重量留在新动作上
   * （卧推 60kg 换成划船，划船也是 60kg）。而新动作此刻既不在建议表里、也不在上次重量表里，
   * `weightFor` 的三级回落会一路落到这个错的值上。所以这里显式改取**新动作**在库内的
   * 默认重量，并异步补上它的建议与上次做组重量。
   */
  function swapExercise(exIdx: number, src: SwapCandidate): boolean {
    const p = plan.value
    if (!p) return false
    const cur = p.exercises[exIdx]
    if (!cur || !canSwapExercise(exIdx)) return false
    if (src.exerciseId && src.exerciseId === cur.exerciseId) return false
    const isCurrent = exIdx === exIndex.value
    const nextWeightKg = useExerciseLibStore().get(src.exerciseId)?.defaultWeightKg ?? null
    p.exercises[exIdx] = {
      ...cur,
      exerciseId: src.exerciseId,
      name: src.name,
      tips: src.tips || cur.tips,
      muscles: src.muscles,
      // 库内没有这个动作（或它没配默认重量）时置空而不是留着旧值 ——
      // 「不知道」比「一个别的动作的重量」诚实，后续回落链自己会处理
      weightKg: nextWeightKg,
    }
    // 登记覆盖，随快照落盘：否则中断接管会把它抹回原动作（见 exerciseOverrides 的注释）
    exerciseOverrides.value = {
      ...exerciseOverrides.value,
      [cur.id]: {
        exerciseId: src.exerciseId,
        name: src.name,
        tips: src.tips || cur.tips,
        muscles: src.muscles,
        weightKg: nextWeightKg,
      },
    }
    let auto = 0
    if (isCurrent) {
      auto = weightForPhase(p.exercises[exIdx]!)
      weight.value = auto
      syncReps(p.exercises[exIdx]!)
    }
    touch()
    // 建议表与上次重量表都还指着旧动作：异步补齐，落地后若用户还没动过重量就把预填升级为
    // 个性化值（`weightFor` 以建议为先，此时它才第一次能给出新动作的「今日建议」那一行）。
    void Promise.all([mergeLastWeights([src.exerciseId]), loadAdvice()]).then(() => {
      const swapped = plan.value?.exercises[exIdx]
      if (!swapped || swapped.exerciseId !== src.exerciseId) return // 期间又换了一次
      if (!isCurrent || weight.value !== auto) return // 非当前动作，或用户已手改过重量
      const refreshed = weightForPhase(swapped)
      if (refreshed !== auto) {
        weight.value = refreshed
        touch()
      }
    })
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
          exerciseId: ex.exerciseId,
          exerciseName: ex.name,
          kind: ex.kind,
          setNo: d.warmup ? warmNo : setNo,
          weightKg: d.weight,
          // 逐组登记值优先：课程可能事后被编辑或删除，回读定义会让已保存的记录失真
          reps: d.reps ?? (d.warmup ? (warmupsFor(ex)[warmNo - 1]?.reps ?? null) : ex.reps),
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
    try {
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
    } catch (e) {
      // 写库本身失败：记态并原样抛，调用点 toast 原因；本地不收尾，会话仍 active 可重试
      finishError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
    finishError.value = ''
    const result = { durationMin: duration, kcal, volume, done }
    const exStore = useExerciseStore()
    try {
      await Promise.all([
        exStore.loadWeek(todayStr()),
        useNutritionStore().loadSummary(todayStr()),
      ])
      exStore.bumpStrength() // 力量曲线卡失效缓存重拉（页面常驻后不再靠重挂载刷新）
    } catch (e) {
      // 结束语义已达成（记录已落库）：刷新失败只给非阻塞提示，绝不阻断本地收尾
      console.warn('[session] 保存后刷新失败', e)
      useToast().toast('已保存，但统计刷新失败')
    }
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
    try {
      await sessionService.abort(id)
    } catch (e) {
      // 同 finishAndSave：放弃失败也保留会话与总结态，供原样重试
      finishError.value = e instanceof Error ? e.message : String(e)
      throw e
    }
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
    reps.value = null
    extraSets.value = {}
    skippedSets.value = {}
    exerciseOverrides.value = {}
    finishError.value = ''
  }

  /* ---------- 外部控制（contract §14.3） ---------- */

  /**
   * 外部客户端送来的快照：落到**本地状态机**再由既有落盘路径写库。
   *
   * 为什么不直接写库：本地内存态是下一次 `touch()` 的写入源，绕过它写库会在下一拍被旧值
   * 静默覆盖（contract §14.3 的原话）。所以外部驱动时，本地机器要跟着外部走。
   * `id` 必须是本机在跑的那一场；不是则不动（外部自持状态时可自行调 `session_snapshot`）。
   */
  async function applyExternalSnapshot(p: {
    id: number
    exIndex: number
    setIndex: number
    weightKg: number
    state: SessionSnapshotState
  }): Promise<boolean> {
    if (sessionId.value !== p.id) return false
    const st = p.state
    exIndex.value = p.exIndex
    setIndex.value = p.setIndex
    weight.value = p.weightKg
    doneSets.value = st.doneSets ?? {}
    extraSets.value = st.extraSets ?? {}
    skippedSets.value = st.skippedSets ?? {}
    readiness.value = st.readiness ?? null
    reps.value = st.reps ?? null
    // 外部也可能换过动作（AI 工具的 swap_exercise 或外部客户端自持状态）：身份要跟着落回
    // 本地 plan，否则下一拍 touch() 会用本地那份「没换过」的 plan 把外部状态写回去。
    exerciseOverrides.value = st.exerciseOverrides ?? {}
    applyExerciseOverrides(st.exerciseOverrides)
    restIsTemp.value = st.restIsTemp ?? false
    restWarmup.value = st.restWarmup ?? false
    restTargetIsNextSet.value = st.restTargetIsNextSet ?? true
    timedTotal.value = st.timedTotal ?? 0
    // 相位与休息倒计时：只有换了相位才重建计时器，免得打断本地正走的同一段休息
    if (st.phase !== phase.value) {
      stopTimer()
      phase.value = st.phase
      if (st.phase === 'rest') {
        restLeft.value = Math.max(0, Math.round(st.restLeft ?? 0))
        restTotal.value = Math.max(restLeft.value, Math.round(st.restLeft ?? restLeft.value))
        startRestTimer()
      }
    } else if (st.phase === 'rest') {
      restLeft.value = Math.max(0, Math.round(st.restLeft ?? restLeft.value))
    }
    await persist()
    return true
  }

  /**
   * 外部送来的结束载荷（contract §14.3）：
   * - 本机正是这一场 → 走既有 `finishAndSave()`（本地权威，含收尾与统计刷新）；
   * - 否则只把这条记录写进去（外部自持状态机，本机没有会话要收尾）。
   */
  async function finishFromExternal(input: GatewaySessionFinish): Promise<boolean> {
    if (sessionId.value === input.id) {
      await finishAndSave()
      return true
    }
    // 可空字段补成显式 null：IPC 走 JSON，`undefined` 会把键整个丢掉（Rust 侧是 Option，缺键不安全）
    await sessionService.finish({
      ...input,
      intensity: input.intensity ?? null,
      note: input.note ?? null,
    })
    return true
  }

  /* ---------- 中断恢复 ---------- */

  /**
   * 主页/运动页/会话页共用：从服务端恢复进行中的会话。
   * 返回 true = 本 store 已接续一场训练课；false = 无训练课
   * （可能存在跑步会话，此时 foreignRoute 指向 /session/run）。
   */
  async function hydrateFromServer(): Promise<boolean> {
    let rec: SessionRecord | null
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
    let result: ApplyRecordResult
    try {
      result = await applyRecord(rec)
    } catch (e) {
      // 记录损坏：按中断脏数据作废，避免卡死状态机
      console.warn('[session] 恢复失败，已作废该会话', e)
      try {
        await discardById(rec.id)
      } catch {
        // 作废本身也失败（多半是后端不可用）：不往上抛，免得变成未处理的 Promise 拒绝。
        // 会话仍留在服务端，下次启动还会再走一遍这条路径。
      }
      return false
    }
    // 'deleted' 会话已作废、'retry' 这一次没拉起来 —— 两者都不算「已接续」。
    // 但 'retry' 不等于「会话不存在」：它 still active 在服务端，只是本轮拿不到。
    return result === 'restored'
  }

  /**
   * 把快照里的「换动作覆盖」重放回本会话那份 plan（深拷贝，改它不外溢到课程库）。
   *
   * 刻意**不走**公开的 `swapExercise`：那条路径带「该动作一组都没做」的前置校验
   * （`canSwapExercise`），而恢复时 `doneSets` 可能已经赋值 —— 走它会让「换过动作且已做组」
   * 这个主场景被静默拒绝。这里直接按覆盖表写 plan，与恢复的字段顺序无关。
   * 课程里找不到对应条目（会话期间被编辑掉了）时跳过，不凭空造动作。
   */
  function applyExerciseOverrides(overrides: Record<string, PlanExerciseOverride> | undefined): void {
    const p = plan.value
    if (!p || !overrides) return
    for (const [id, ov] of Object.entries(overrides)) {
      const ex = p.exercises.find((e) => e.id === id)
      if (!ex) continue
      ex.exerciseId = ov.exerciseId
      ex.name = ov.name
      ex.tips = ov.tips
      ex.muscles = ov.muscles
      ex.weightKg = ov.weightKg
    }
  }

  /**
   * 把恢复回来的进度**对齐到当前课程**：丢掉不属于当前课程的动作的登记，
   * 并把每个动作的登记裁到它自己的组数。
   *
   * 为什么必须做：恢复是按 planId 重新从课程库取 plan 的，而课程可能在会话进行中被编辑过
   * —— 删掉一个动作、或把某个动作的组数调小。此时两个口径会错位：`doneCount` 遍历
   * `doneSets` 的**全部键**，而 `buildSetRows` / `totalVolume` 只遍历当前课程的动作。
   * 于是界面会出现「5/4 组完成」（分子大于分母），而那些多出来的组在保存时又被静默丢掉
   * —— 计数说它们算，记录里却没有它们。对齐之后两处遍历的是同一批动作、同一批组。
   *
   * 正常恢复（课程没被改过）时它是个恒等操作：每个键都在课程里、每组数都不越界。
   */
  function alignProgressToPlan(): void {
    const p = plan.value
    if (!p) return
    const nextDone: Record<string, DoneSet[]> = {}
    const nextExtra: Record<string, number> = {}
    const nextSkipped: Record<string, number[]> = {}
    for (const ex of p.exercises) {
      const list = doneSets.value[ex.id]
      if (list?.length) {
        // 热身组与正式组分开裁：正式组裁到该动作**当前**的实际组数（热身不占正式组号）
        const warm = list.filter((d) => d.warmup)
        const work = list.filter((d) => !d.warmup).slice(0, effSets(ex))
        nextDone[ex.id] = [...warm, ...work]
      }
      const extra = extraSets.value[ex.id]
      if (extra) nextExtra[ex.id] = extra
      const skipped = skippedSets.value[ex.id]
      if (skipped) nextSkipped[ex.id] = skipped.filter((n) => n >= 1 && n <= effSets(ex))
    }
    doneSets.value = nextDone
    extraSets.value = nextExtra
    skippedSets.value = nextSkipped
  }

  /**
   * 组号钳到当前动作的**实际组数**：课程在会话期间被调小组数时，旧快照里的 setIndex 会越界，
   * 界面就会读出「第 5/1 组」。上界与下界都要有 —— 从前只钳了下界（`Math.max(1, …)`）。
   */
  function clampSetIndex(v: number): number {
    const ex = currentEx.value
    const cap = ex ? effSets(ex) : 1
    const n = Math.trunc(v)
    return Math.min(Math.max(1, Number.isFinite(n) ? n : 1), Math.max(1, cap))
  }

  async function applyRecord(rec: SessionRecord): Promise<ApplyRecordResult> {
    const planStore = usePlanStore()
    let p = planStore.byId(rec.planId)
    if (!p) {
      try {
        await planStore.ensureLoaded()
        p = planStore.byId(rec.planId)
      } catch (e) {
        // 「列表没拉起来」≠「课程被删了」。以前两者并进同一个作废分支：一次后端 / 网络抖动
        // 就会把整场会话连同已完成组的**唯一副本**（state_json）一起丢掉，而用户看不到任何
        // 提示（浮条根本不出现）。这里保留会话，等下一轮（回前台 / 下次启动）再试。
        console.warn('[session] 课程列表拉取失败，保留会话待重试', e)
        return 'retry'
      }
    }
    if (!p) {
      // 加载成功、库里确实没有这门课 —— 这才是真的被删了，按中断脏数据作废
      await discardById(rec.id)
      return 'deleted'
    }
    sessionId.value = rec.id
    startedAtIso.value = rec.startedAt
    plan.value = { ...p, exercises: p.exercises.map(cloneExercise) }
    // 换动作的身份必须先重放：下面 `reps.value` 的回落链要读重建后的 plan
    applyExerciseOverrides(rec.state.exerciseOverrides)
    exIndex.value = Math.min(Math.max(0, Math.trunc(rec.exIndex)), Math.max(0, p.exercises.length - 1))
    weight.value = rec.weightKg
    doneSets.value = rec.state.doneSets ?? {}
    extraSets.value = rec.state.extraSets ?? {}
    skippedSets.value = rec.state.skippedSets ?? {}
    // 进度先对齐到**当前课程**（裁掉已删动作的登记、把每个动作的登记裁到它的实际组数），
    // 再据此钳组号 —— 两件事都要用「对齐后」的 extraSets 算 effSets，所以顺序是死的
    alignProgressToPlan()
    setIndex.value = clampSetIndex(rec.setIndex)
    reps.value = rec.state.reps ?? p.exercises[exIndex.value]?.reps ?? null
    restIsTemp.value = false
    restWarmup.value = rec.state.restWarmup ?? false
    restTargetIsNextSet.value = rec.state.restTargetIsNextSet ?? true
    timedTotal.value = rec.state.timedTotal ?? 0
    timedElapsed.value = 0
    readiness.value = rec.state.readiness ?? null
    // 恢复后重算建议（自评随快照一起恢复）；建议是异步的，到了再对齐热身预填
    void loadAdvice().then(() => resyncWarmupPrefill())
    // 取上次重量要按**重放覆盖之后**的动作 id —— 用下面那个尚未覆盖的 `p` 会让换进来的
    // 动作查不到历史（weightFor 的回落就此少一级）
    void loadLastWeights(plan.value.exercises.map((e) => e.exerciseId))

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
      case 'warmup': {
        // 激活热身中被打断：原地续做（已完成的组保留在 doneSets）。
        // ⚠️ 处方按推荐重量实时换算，隔一段时间回来重量可能已经变了 ——
        // 该动作此刻可能已经没有热身（重量降到 <12kg）或热身已做完，
        // 这时绝不能再停在热身相位，否则用户会卡在一个没有可完成组的界面里。
        const cur = currentEx.value
        if (cur && warmupPending(cur)) {
          phase.value = 'warmup'
        } else {
          phase.value = cur && cur.kind !== 'strength' ? 'timed-ready' : 'exercise'
          // 快照里的重量是热身的小重量，切回正式组必须重新预填
          if (cur && phase.value === 'exercise') weight.value = weightFor(cur)
        }
        break
      }
      default: {
        // 快照阶段必须与当前动作类型一致：旧版快照（或课程中途被改成计时）
        // 可能把计时动作记成做组态 —— 回准备页重做该组，别留在力量界面
        const cur = currentEx.value
        phase.value = cur && cur.kind !== 'strength' ? 'timed-ready' : 'exercise'
      }
    }
    return 'restored'
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

  // 会话一建立就起「每秒对快照」的上报，会话结束（endLocal / 服务端关闭）即停（contract §14.2）
  watch(sessionId, (id) => {
    if (id) startReporter()
    else stopReporter()
  })

  // 后台 / 最小化期间 interval 会被节流：回到可见瞬间立即校正剩余休息，
  // 该归零的当场归零（会话恢复路径 applyRecord 已按真实流逝补偿过一次）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && phase.value === 'rest') tickRest()
  })

  return {
    sessionId,
    plan,
    phase,
    exIndex,
    setIndex,
    weight,
    reps,
    doneSets,
    restLeft,
    restTotal,
    restTargetIsNextSet,
    restIsTemp,
    restWarmup,
    lastWeights,
    advice,
    readiness,
    timedTotal,
    timedElapsed,
    overlay,
    persistError,
    finishError,
    foreignRoute,
    currentEx,
    exDoneSets,
    isLastExercise,
    doneCount,
    totalCount,
    totalVolume,
    cursorIndex,
    setSlots,
    courseSlots,
    skippedSets,
    durationMin,
    durationSec,
    estimateKcalValue,
    isActive,
    start,
    completeSet,
    completeWarmup,
    skipWarmup,
    warmupDone,
    warmupPending,
    warmupPlanFor,
    warmupsFor,
    workingWeightFor,
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
    setWeight,
    setReps,
    setReadiness,
    adviceFor,
    loadAdvice,
    finishAndSave,
    discard,
    discardById,
    hydrateFromServer,
    applyExternalSnapshot,
    finishFromExternal,
  }
})
