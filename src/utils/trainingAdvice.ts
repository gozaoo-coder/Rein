/**
 * 训练建议引擎（纯数据 + 纯函数，无 IPC、不落库）。
 *
 * 回答两个问题：
 *  1. 今天这个动作练多重、多少组多少次（`perExercise`）——由「平均状态」与「今日极限状态」共同决定；
 *  2. 这周各肌群的容量够不够（`muscleLoad`）——按每肌群周组数地标判定。
 *
 * 科学依据（写在代码里，便于复核与调整）：
 *  - 1RM 估算：Epley `w×(1+r/30)`；次数 > 12 时换 Brzycki `w×36/(37−r)`（高次数下 Epley 高估）。
 *    Epley 1985；Brzycki 1993。
 *  - RIR ↔ %1RM：RIR 0=100% / 1=97.5% / 2=95% / 3=92.5% / 4=90% / 5=87.5%（Zourdos 等 2016 RPE 表）。
 *    增肌训练的目标强度取 RIR 1–3。
 *  - 容量地标：每肌群每周组数的 MEV（最小有效容量）/ MAV（最佳适应区间）/ MRV（可恢复上限），
 *    Israetel 等《Scientific Principles of Hypertrophy Training》；剂量-反应证据见 Schoenfeld 等 2017。
 *  - 恢复窗口：同一肌群力量恢复约需 48–72 小时，故 48h 内重复训练降载、72h 后视为恢复完全（Damas 等 2016）。
 *  - 渐进超负荷：双重渐进（先做满次数再加重量），上肢 +2.5kg / 下肢 更大幅度，取整到器材步进；
 *    低状态日允许回退到上次的 85% 保底（ACSM 渐进原则 + 自体调节 autoregulation）。
 *
 * 间接刺激计半组以上的折算：动作肌群激活档位 3=主攻（1 组）/2=辅助（0.5 组）/1=稳定（0.25 组）。
 * 日期只有「天」粒度（工作簿存 YYYY-MM-DD），恢复小时数按整天 × 24 近似 —— 对小重量多次数的
 * 日常训练足够，不引入额外的时间戳存储。
 */

import { MUSCLE_LABELS, resolveActivation, type Level, type MuscleKey } from '@/config/muscles'
import type { ExerciseRecord, PlanExercise, StrengthSetRecord } from '@/types'

/* ---------------- 科学依据数据表 ---------------- */

/** 每肌群每周组数地标（MEV / MAV / MRV），针对力量训练的中等强度容量。
 *  细化到肌束后，同一大肌群各束地标之和与整块肌群的地标相当。 */
export const MUSCLE_VOLUME_TARGETS: Record<MuscleKey, { mev: number; mav: number; mrv: number }> = {
  'chest-up': { mev: 4, mav: 9, mrv: 14 },
  'chest-low': { mev: 4, mav: 9, mrv: 14 },
  lats: { mev: 8, mav: 16, mrv: 22 },
  'traps-up': { mev: 2, mav: 8, mrv: 14 },
  'traps-mid': { mev: 4, mav: 10, mrv: 16 },
  'traps-low': { mev: 2, mav: 8, mrv: 14 },
  'delt-ant': { mev: 4, mav: 10, mrv: 16 },
  'delt-lat': { mev: 4, mav: 12, mrv: 18 },
  'delt-post': { mev: 4, mav: 10, mrv: 16 },
  'lower-back': { mev: 4, mav: 10, mrv: 16 },
  'glute-max': { mev: 4, mav: 12, mrv: 20 },
  'glute-med': { mev: 2, mav: 8, mrv: 14 },
  biceps: { mev: 6, mav: 14, mrv: 20 },
  triceps: { mev: 6, mav: 14, mrv: 20 },
  forearm: { mev: 2, mav: 8, mrv: 14 },
  'quads-lat': { mev: 4, mav: 10, mrv: 16 },
  'quads-rec': { mev: 4, mav: 10, mrv: 16 },
  'quads-med': { mev: 2, mav: 8, mrv: 14 },
  adductors: { mev: 2, mav: 8, mrv: 14 },
  hamstrings: { mev: 6, mav: 14, mrv: 20 },
  calves: { mev: 6, mav: 14, mrv: 20 },
  soleus: { mev: 4, mav: 10, mrv: 16 },
  tibialis: { mev: 2, mav: 8, mrv: 14 },
  abs: { mev: 4, mav: 12, mrv: 20 },
  obliques: { mev: 2, mav: 8, mrv: 14 },
  scm: { mev: 2, mav: 6, mrv: 10 },
}

/** 肌群激活档位 → 计组权重（辅助/稳定肌群的间接刺激按比例折算） */
export const ACTIVATION_WEIGHT: Record<Level, number> = { 1: 0.25, 2: 0.5, 3: 1 }

/** 增肌目标强度：留 2 次余量（RIR 2 ≈ RPE 8，对应约 95% 的当日极限） */
export const DEFAULT_TARGET_RIR = 2

/** 自评 1..5 → readiness 系数 */
const SELF_FACTOR: Record<number, number> = { 1: 0.9, 2: 0.95, 3: 1.0, 4: 1.02, 5: 1.04 }

/* ---------------- 基础工具 ---------------- */

/** 估算 1RM：次数 ≤12 用 Epley，>12 用 Brzycki；次数 ≤0 视为无效 */
export function estimateOneRepMax(weightKg: number, reps: number): number {
  if (!Number.isFinite(weightKg) || !Number.isFinite(reps) || weightKg <= 0 || reps <= 0) return 0
  if (reps > 12) return (weightKg * 36) / (37 - reps)
  return weightKg * (1 + reps / 30)
}

/** 按器材步进取整（向下取整到步进，避免建议重量超出今日能力）；step ≤ 0 = 不取整 */
export function roundToStep(kg: number, step: number): number {
  if (!Number.isFinite(kg)) return kg
  if (!(step > 0)) return Math.round(kg * 10) / 10
  return Math.round(Math.floor(kg / step + 1e-6) * step * 10) / 10
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 日期差（YYYY-MM-DD，本地日历天）：b - a */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  if (!ay || !by) return 0
  const ta = Date.UTC(ay, am - 1, ad)
  const tb = Date.UTC(by, bm - 1, bd)
  return Math.round((tb - ta) / 86_400_000)
}

/* ---------------- 输入 ---------------- */

export interface TrainingAdviceInput {
  /** 近 N 天逐组记录（`strength_recent_sets`），含热身组 */
  sets: StrengthSetRecord[]
  /** 动作库（肌群表、重量步进、默认处方） */
  library: ExerciseRecord[]
  /** 今日课程的处方（可为空：只算周容量） */
  planExercises?: PlanExercise[]
  /** 本地今天（YYYY-MM-DD） */
  today: string
  /** 今日状态自评 1..5；null/缺省 = 未自评（纯自动推断） */
  selfRating?: number | null
  /** 每周可训练天数（健康方案）：缩放每肌群周组数目标，缺省按 4 练 */
  trainingDaysPerWeek?: number | null
  /** 容量统计窗口（天），默认 7 */
  volumeDays?: number
}

/* ---------------- 输出 ---------------- */

export interface ExerciseAdvice {
  exerciseId: string
  name: string
  kind: PlanExercise['kind']
  suggestedWeight: number | null
  suggestedReps: number | null
  suggestedSets: number
  /** 目标余力（RIR）；力量动作为 2，其余为 null */
  targetRir: number | null
  weightStep: number
  /** 平均状态：近几次训练的 e1RM 加权基线 */
  baselineE1rm: number | null
  /** 今日极限状态：基线 × readiness */
  todayCeiling: number | null
  /** 该动作的今日状态系数（0.85~1.06） */
  readiness: number
  lastWeight: number | null
  lastReps: number | null
  lastDate: string | null
  hasHistory: boolean
  /** 逐条中文依据（沉浸页「为什么」展开） */
  rationale: string[]
}

export interface MuscleLoadRow {
  muscle: MuscleKey
  label: string
  /** 近 volumeDays 天的加权组数 */
  sets: number
  mev: number
  mav: number
  mrv: number
  status: 'low' | 'ok' | 'high' | 'over'
  /** 最近一次练到该肌群的日期（含间接刺激） */
  lastDate: string | null
}

export interface ReadinessFactor {
  key: 'recovery' | 'volume' | 'trend' | 'self'
  label: string
  value: number
  note: string
}

export interface TrainingAdvice {
  /** 全局今日状态（供页面展示）：score + 逐项分解 */
  readiness: { score: number; factors: ReadinessFactor[] }
  perExercise: Record<string, ExerciseAdvice>
  muscleLoad: MuscleLoadRow[]
  /** 一句话总结（页面直接用） */
  summary: string
}

/* ---------------- 内部结构 ---------------- */

interface SessionPerf {
  workoutId: number
  date: string
  /** 该次训练的最大重量正式组 */
  topWeight: number
  topReps: number
  e1rm: number
  /** 正式组列表（重量/次数） */
  working: { weightKg: number; reps: number }[]
}

interface ExerciseStat {
  id: string
  name: string
  sessions: SessionPerf[]
}

function musclesOfExercise(ex: ExerciseRecord | undefined, name: string): Partial<Record<MuscleKey, Level>> {
  if (ex && Object.keys(ex.muscles ?? {}).length) return ex.muscles
  return resolveActivation(name) ?? {}
}

/* ---------------- 主入口 ---------------- */

export function computeTrainingAdvice(input: TrainingAdviceInput): TrainingAdvice {
  const { sets, library, today } = input
  const volumeDays = input.volumeDays ?? 7
  const libById = new Map(library.map((e) => [e.id, e]))
  const nameOf = (id: string | null, fallback: string) => (id && libById.get(id)?.name) || fallback

  /* ---- 1. 按动作聚合历史（正式组） ---- */
  const stats = new Map<string, ExerciseStat>()
  for (const r of sets) {
    if (r.warmup || r.weightKg == null || r.reps == null) continue
    if (r.kind !== 'strength') continue
    const key = r.exerciseId ?? r.exerciseName
    const stat = stats.get(key) ?? { id: key, name: nameOf(r.exerciseId, r.exerciseName), sessions: [] }
    let perf = stat.sessions.find((s) => s.workoutId === r.workoutId)
    if (!perf) {
      perf = { workoutId: r.workoutId, date: r.date, topWeight: r.weightKg, topReps: r.reps, e1rm: 0, working: [] }
      stat.sessions.push(perf)
    }
    perf.working.push({ weightKg: r.weightKg, reps: r.reps })
    const oneRm = estimateOneRepMax(r.weightKg, r.reps)
    if (oneRm > perf.e1rm) {
      perf.e1rm = oneRm
      perf.topWeight = r.weightKg
      perf.topReps = r.reps
    }
    stats.set(key, stat)
  }
  for (const s of stats.values()) {
    s.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
  }

  /* ---- 2. 每肌群近 volumeDays 天加权组数 + 最近训练日期 ---- */
  const weekly = new Map<MuscleKey, number>()
  const lastTrained = new Map<MuscleKey, string>()
  const primaryLast = new Map<MuscleKey, string>()
  const windowStart = shiftDate(today, -volumeDays)
  for (const r of sets) {
    if (r.warmup) continue
    if (r.weightKg == null && r.reps == null && r.sec == null) continue
    const ex = r.exerciseId ? libById.get(r.exerciseId) : undefined
    const map = musclesOfExercise(ex, r.exerciseName)
    for (const [muscle, level] of Object.entries(map) as [MuscleKey, Level][]) {
      const weight = ACTIVATION_WEIGHT[level] ?? 0.5
      if (r.date >= windowStart) weekly.set(muscle, (weekly.get(muscle) ?? 0) + weight)
      const prev = lastTrained.get(muscle)
      if (!prev || r.date > prev) lastTrained.set(muscle, r.date)
      if (level === 3) {
        const prevPrimary = primaryLast.get(muscle)
        if (!prevPrimary || r.date > prevPrimary) primaryLast.set(muscle, r.date)
      }
    }
  }

  /* ---- 3. 目标区间（按每周可训练天数缩放） ---- */
  const trainingDays = input.trainingDaysPerWeek ?? 4
  const scale = clamp(0.5 + 0.1 * trainingDays, 0.7, 1.0)
  const targets = (muscle: MuscleKey) => {
    const t = MUSCLE_VOLUME_TARGETS[muscle]
    return {
      mev: Math.round(t.mev * scale),
      mav: Math.round(t.mav * scale),
      mrv: Math.round(t.mrv * scale),
    }
  }

  const muscleLoad: MuscleLoadRow[] = (Object.keys(MUSCLE_VOLUME_TARGETS) as MuscleKey[])
    .map((muscle) => {
      const setsDone = Math.round((weekly.get(muscle) ?? 0) * 10) / 10
      const t = targets(muscle)
      const status: MuscleLoadRow['status'] =
        setsDone > t.mrv ? 'over' : setsDone > t.mav ? 'high' : setsDone < t.mev ? 'low' : 'ok'
      return {
        muscle,
        label: MUSCLE_LABELS[muscle],
        sets: setsDone,
        ...t,
        status,
        lastDate: lastTrained.get(muscle) ?? null,
      }
    })
    .sort((a, b) => b.sets - a.sets)

  /* ---- 4. 逐动作建议 ---- */
  const selfFactor = input.selfRating ? (SELF_FACTOR[input.selfRating] ?? 1) : 1
  const readinessList: number[] = []
  let globalFactors: ReadinessFactor[] = []
  const perExercise: Record<string, ExerciseAdvice> = {}

  for (const item of input.planExercises ?? []) {
    const lib = libById.get(item.exerciseId)
    const key = item.exerciseId || item.name
    const stat = stats.get(key)
    const name = lib?.name ?? item.name
    const weightStep = lib?.weightStep && lib.weightStep > 0 ? lib.weightStep : 0
    const targetReps = item.reps ?? lib?.defaultReps ?? 8
    const targetSets = item.sets ?? lib?.defaultSets ?? 3
    const rationale: string[] = []

    if (item.kind !== 'strength') {
      perExercise[key] = {
        exerciseId: key,
        name,
        kind: item.kind,
        suggestedWeight: null,
        suggestedReps: null,
        suggestedSets: targetSets,
        targetRir: null,
        weightStep,
        baselineE1rm: null,
        todayCeiling: null,
        readiness: 1,
        lastWeight: null,
        lastReps: null,
        lastDate: null,
        hasHistory: false,
        rationale: [`${item.kind === 'timed' ? '计时' : '有氧'}动作不做重量建议`],
      }
      continue
    }

    const map = musclesOfExercise(lib, name)
    const primaries = (Object.entries(map) as [MuscleKey, Level][])
      .filter(([, lv]) => lv === 3)
      .map(([m]) => m)
    const relevant = primaries.length ? primaries : (Object.keys(map) as MuscleKey[])

    // 恢复项：同主攻肌群上次训练距今的小时数（整天 × 24 近似）
    let hoursSince = Infinity
    let recoveryMuscle: MuscleKey | null = null
    for (const m of relevant) {
      const d = primaryLast.get(m) ?? lastTrained.get(m)
      if (!d) continue
      const h = Math.max(0, daysBetween(d, today)) * 24
      if (h < hoursSince) {
        hoursSince = h
        recoveryMuscle = m
      }
    }
    const recoveryFactor =
      hoursSince < 24 ? 0.9 : hoursSince < 48 ? 0.95 : hoursSince < 72 ? 1.0 : hoursSince < 120 ? 1.02 : 0.98
    const recoveryNote =
      hoursSince === Infinity
        ? '该肌群近期无训练记录'
        : `${recoveryMuscle ? MUSCLE_LABELS[recoveryMuscle] : '肌群'}距上次训练 ${Math.round(hoursSince)}h（${
            recoveryFactor >= 1.02 ? '超量恢复窗口' : recoveryFactor >= 1 ? '已恢复' : '尚未恢复'
          }）`

    // 容量项：主攻肌群里「最接近/超出上限」的那个
    let volumeFactor = 1
    let volumeNote = '本周容量适中'
    let worst: MuscleLoadRow | null = null
    for (const m of relevant) {
      const row = muscleLoad.find((x) => x.muscle === m)
      if (!row) continue
      if (!worst || row.sets / row.mav > worst.sets / worst.mav) worst = row
    }
    if (worst) {
      volumeFactor = worst.sets > worst.mrv ? 0.92 : worst.sets > worst.mav ? 0.97 : 1.0
      volumeNote = `本周${worst.label} ${worst.sets} 组（目标 ${worst.mev}-${worst.mav}）${
        volumeFactor < 1 ? '，已接近/超出恢复上限' : ''
      }`
    }

    // 趋势项：上次 e1RM 相对基线的偏离
    const last = stat?.sessions[stat.sessions.length - 1] ?? null
    const baselineE1rm = stat ? weightedBaseline(stat.sessions) : null
    const trendFactor = last && baselineE1rm ? (last.e1rm < baselineE1rm * 0.95 ? 0.97 : 1.0) : 1.0
    const trendNote = last
      ? `上次 ${fmt(last.topWeight)}kg × ${last.topReps}（估算 1RM ${Math.round(last.e1rm)}kg）`
      : '暂无历史记录'

    const readiness = clamp(recoveryFactor * volumeFactor * trendFactor * selfFactor, 0.85, 1.06)
    const todayCeiling = baselineE1rm ? baselineE1rm * readiness : null

    rationale.push(trendNote)
    rationale.push(recoveryNote)
    if (worst) rationale.push(volumeNote)
    rationale.push(
      `今日状态 ×${readiness.toFixed(2)} = 恢复 ×${recoveryFactor.toFixed(2)} · 容量 ×${volumeFactor.toFixed(
        2,
      )} · 趋势 ×${trendFactor.toFixed(2)}${input.selfRating ? ` · 自评 ${input.selfRating}/5` : ''}`,
    )

    let suggestedWeight: number | null = null
    const suggestedReps: number | null = targetReps
    if (!stat || !last) {
      // 无历史：按课程/库内建议值起步
      suggestedWeight = item.weightKg ?? lib?.defaultWeightKg ?? null
      rationale.push(
        suggestedWeight != null
          ? `首次记录：按建议值 ${fmt(suggestedWeight)}kg 起步，完成几组后即可给出个性化建议`
          : '首次记录：自重动作按次数推进即可',
      )
    } else if (todayCeiling) {
      /**
       * 建议重量 = 负荷锚定 + 自体调节（不直接由 e1RM 反推绝对重量）：
       * 历史记录没有 RPE，e1RM 只能当相对趋势用（把它当「这组若力竭的理论 1RM」）；
       * 用它反推重量会系统性低于用户实际做过的重量（训练本来就该留余力）。
       * 因此：以上次重量为锚，做满计划次数就加一档（双重渐进）；今日状态差则降载；
       * 今日极限只用来封顶（且不低于上次已完成过的重量）。
       */
      const allSetsDone =
        last.working.length >= Math.max(1, targetSets) && last.working.every((w) => w.reps >= targetReps)
      let base = last.topWeight
      if (allSetsDone && weightStep > 0) {
        base += weightStep * (readiness >= 1.03 ? 2 : 1)
        rationale.push(
          `上次全部做满 ${targetReps} 次 → 递增${readiness >= 1.03 ? '两档（今日状态很好）' : '一个步进'}（+${fmt(
            weightStep * (readiness >= 1.03 ? 2 : 1),
          )}kg）`,
        )
      }
      if (readiness < 0.95) {
        base = last.topWeight * readiness
        rationale.push(`今日状态 ×${readiness.toFixed(2)} 明显偏低 → 主动降载（下限为上次的 85%）`)
      } else if (readiness < 0.98 && !allSetsDone) {
        base = last.topWeight
        rationale.push('今日状态略低 → 维持上次重量，不做递增')
      }
      // 今日极限封顶：目标次数下的等价重量；但不低于上次实际完成过的重量（已证明可行）
      const ceilingWeight = todayCeiling / (1 + targetReps / 30)
      const cap = Math.max(last.topWeight, ceilingWeight)
      const lo = Math.max(0, last.topWeight * 0.85)
      const clamped = clamp(base, lo, cap)
      suggestedWeight = weightStep > 0 ? roundToStep(clamped, weightStep) : Math.round(clamped * 10) / 10
      rationale.push(`建议 ${fmt(suggestedWeight)}kg × ${targetReps} × ${targetSets} 组 · 目标 RIR ${DEFAULT_TARGET_RIR}`)
    }

    // 全局状态：今日课程各动作 readiness 的均值（页面抬头展示），分解取首个动作
    readinessList.push(readiness)
    if (!globalFactors.length) {
      globalFactors = [
        { key: 'recovery', label: '恢复', value: recoveryFactor, note: recoveryNote },
        { key: 'volume', label: '容量', value: volumeFactor, note: volumeNote },
        { key: 'trend', label: '趋势', value: trendFactor, note: trendNote },
        {
          key: 'self',
          label: '自评',
          value: selfFactor,
          note: input.selfRating ? `${input.selfRating}/5` : '未自评',
        },
      ]
    }

    perExercise[key] = {
      exerciseId: key,
      name,
      kind: item.kind,
      suggestedWeight,
      suggestedReps,
      suggestedSets: targetSets,
      targetRir: DEFAULT_TARGET_RIR,
      weightStep,
      baselineE1rm,
      todayCeiling,
      readiness,
      lastWeight: last?.topWeight ?? null,
      lastReps: last?.topReps ?? null,
      lastDate: last?.date ?? null,
      hasHistory: !!last,
      rationale,
    }
  }

  const globalReadiness = readinessList.length
    ? readinessList.reduce((s, v) => s + v, 0) / readinessList.length
    : 1
  const lowCount = muscleLoad.filter((m) => m.status === 'low' && m.lastDate).length
  const overCount = muscleLoad.filter((m) => m.status === 'over').length
  const summary = overCount
    ? `${overCount} 个肌群本周容量超出恢复上限，建议减量或增加休息`
    : input.planExercises?.length
      ? `今日状态 ×${globalReadiness.toFixed(2)}，按建议重量训练即可${lowCount ? `；${lowCount} 个肌群容量偏低` : ''}`
      : lowCount
        ? `${lowCount} 个肌群本周容量偏低`
        : '本周各肌群容量都在合理区间'

  return {
    readiness: { score: globalReadiness, factors: globalFactors },
    perExercise,
    muscleLoad,
    summary,
  }
}

/** 近 3 次训练的 e1RM 加权基线（越近权重越高：0.2 / 0.3 / 0.5） */
function weightedBaseline(sessions: SessionPerf[]): number | null {
  const recent = sessions.slice(-3)
  if (!recent.length) return null
  const weights = recent.length === 3 ? [0.2, 0.3, 0.5] : recent.length === 2 ? [0.35, 0.65] : [1]
  let sum = 0
  let wsum = 0
  recent.forEach((s, i) => {
    const w = weights[i] ?? 0.5
    sum += s.e1rm * w
    wsum += w
  })
  return wsum > 0 ? sum / wsum : null
}

function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y!, m! - 1, d!) + deltaDays * 86_400_000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}
