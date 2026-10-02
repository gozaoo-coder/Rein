/**
 * 练够分（《练够分 Lite》产品规范 V1.0）· 纯函数引擎（无 IPC、不落库）。
 *
 * 回答一句话：**这个肌群，练够了吗？**（100 分 = 运动充分）
 *
 * 只吃 4 类已有数据（与规范一致）：
 *  · 频率时间戳 —— `workout_sets` 的 date / workoutId
 *  · 强度        —— 组数 + 重量（weightKg）+ 单组次数（reps）
 *  · 体感        —— 训练会话的「今日状态自评」readiness（5、4 良好 / 3 一般 / 1、2 差）
 *  · 目标        —— `profile.goal`（cut → 减脂；bulk / keep → 增肌）
 *
 * 计算（规范第 3 节）：
 *   练够分   = 频率分 × 频率权重 + 强度分 × 强度权重 + 体感分 × 体感权重（封顶 100，四舍五入）
 *   强度分   = 组数分 × 40% + 次数分 × 30% + 重量分 × 30%
 *   增肌权重 = 30% / 50% / 20%；减脂权重 = 35% / 35% / 30%
 *
 * ---------- 与规范的两处「按软件实况」适配（都在下面注明） ----------
 *  1. **组数 / 次数按肌群激活档位折算**（主攻 1 / 辅助 0.5 / 稳定 0.25），而不是
 *     「一次训练只针对一个肌群」。规范假设每次只练一个肌群，本应用一堂课会同时刺激多块肌肉；
 *     沿用全应用既有口径（trainingAdvice 的 ACTIVATION_WEIGHT），否则卧推那一组
 *     会把胸、三头、前束各记满 1 组（即所谓"脏容量"）。
 *  2. **频率只在激活 ≥2（辅助及以上）时才计一次**。稳定肌群（复合动作里打酱油的腹直肌）
 *     不该被算作「今天专门练过核心」，否则频率虚高、把真正的"没练"掩盖掉。
 *
 * 评估粒度是规范的 **10 个肌群**（`config/muscles` 的 SCORE_GROUPS）：39 个肌束没有对应规范，
 * 而规范的建议话术本来就是按这 10 组给的（「胸本周 7 组偏少」）。
 */

import { addDays } from '@/utils/date'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { ACTIVATION_WEIGHT } from '@/utils/trainingAdvice'
import {
  SCORE_GROUPS,
  SCORE_GROUP_LABELS,
  SCORE_GROUP_OF,
  type HeatLevel,
  type Level,
  type MuscleKey,
  type ScoreGroupKey,
} from '@/config/muscles'
import type { ExerciseRecord, Goal, StrengthSetRecord } from '@/types'

/* ---------------- 常量与口径表（全部照规范抄录，便于复核） ---------------- */

/** 统计窗口：最近 7 天滚动（规范第 1.4 节） */
export const SCORE_WEEK_DAYS = 7
/** 「过去 4 周」基线窗口（重量分对比用，规范第 5.3 节） */
export const SCORE_BASE_DAYS = 28

/** 规范里只有增肌 / 减脂两套表；`keep`（保持）按增肌处理 —— 训练充分度的口径本就一致 */
export type ScoreGoal = 'bulk' | 'cut'

export function scoreGoalOf(goal: Goal | null | undefined): ScoreGoal {
  return goal === 'cut' ? 'cut' : 'bulk'
}

/** 目标权重（规范第 3.1 节） */
export const SCORE_WEIGHTS: Record<ScoreGoal, { frequency: number; intensity: number; feeling: number }> = {
  bulk: { frequency: 0.3, intensity: 0.5, feeling: 0.2 },
  cut: { frequency: 0.35, intensity: 0.35, feeling: 0.3 },
}

/** 强度分内部权重（规范第 5 节）：组数 40% / 次数 30% / 重量 30% */
const INTENSITY_SUB = { sets: 0.4, reps: 0.3, weight: 0.3 } as const

/** 体感三档 → 分（规范第 1.3 / 6 节） */
export type Feeling = 'good' | 'fair' | 'poor'
export const FEELING_SCORE: Record<Feeling, number> = { good: 100, fair: 60, poor: 20 }
export const FEELING_LABEL: Record<Feeling, string> = { good: '良好', fair: '一般', poor: '差' }
/** 没填体感时的默认分（规范第 6 节）+ 降置信度 */
const FEELING_DEFAULT = 60

/** 训练页「今日状态自评」1..5 → 体感三档（5、4 良好 / 3 一般 / 1、2 差） */
export function feelingOfReadiness(v: number | null | undefined): Feeling | null {
  if (v == null || !Number.isFinite(v)) return null
  if (v >= 4) return 'good'
  if (v === 3) return 'fair'
  return 'poor'
}

/** 频率分（规范第 4 节）：0→-, 1..4 逐档, ≥5 取尾档 */
const FREQ_SCORES: Record<ScoreGoal, number[]> = {
  bulk: [0, 55, 100, 100, 85],
  cut: [0, 60, 90, 100, 100],
}
const FREQ_TAIL: Record<ScoreGoal, number> = { bulk: 70, cut: 85 }

function freqScoreOf(goal: ScoreGoal, count: number): number {
  if (count <= 0) return 0
  if (count >= 5) return FREQ_TAIL[goal]
  return FREQ_SCORES[goal][count] ?? FREQ_TAIL[goal]
}

/**
 * 组数分（规范第 5.1 节）。原表的区间是**闭区间**，且折算后的组数常带小数
 * （辅助动作记 0.5 组），所以这里记的是每个档位的**上界**并用 `<=` 判：
 * 增肌 [1,4]→30 [5,9]→60 [10,14]→85 [15,20]→100 [21,24]→85 >24→60
 * 减脂 [1,3]→30 [4,7]→60 [8,12]→85 [13,18]→100 [19,22]→85 >22→60
 *
 * 上界必须写成 4/9/14/20/24 配 `<=`。曾在末尾三个档位上用 `<` + 上界 5/10/15…，
 * 那是把 20 组（规范应得 100）判成了 85 —— 满分区间的上界恰好就是最常落在的那一格。
 *
 * 规范表末行「24 → 60」与「21–24 → 85」互相冲突（24 落进两个区间），
 * 按「>24 → 60」解：末档是给堆量过头的人降档，不是给 24 组再打一次折。减脂同理解作 >22。
 */
const SETS_STEPS: Record<ScoreGoal, [number, number][]> = {
  bulk: [
    [4, 30],
    [9, 60],
    [14, 85],
    [20, 100],
    [24, 85],
  ],
  cut: [
    [3, 30],
    [7, 60],
    [12, 85],
    [18, 100],
    [22, 85],
  ],
}
function setsScoreOf(goal: ScoreGoal, sets: number): number {
  if (sets <= 0) return 0
  for (const [max, score] of SETS_STEPS[goal]) if (sets <= max) return score
  return 60
}

/** 组数分的「满分区间」（建议话术判方向用） */
const SETS_SWEET: Record<ScoreGoal, [number, number]> = { bulk: [15, 20], cut: [13, 18] }
/** 次数分的「满分区间」 */
const REPS_SWEET: Record<ScoreGoal, [number, number]> = { bulk: [6, 12], cut: [13, 20] }

/** 次数分（规范第 5.2 节）：增肌 ≤5→50, ≤12→100, ≤20→85, ≤30→60, >30→40 */
function repsScoreOf(goal: ScoreGoal, avgReps: number): number {
  if (avgReps <= 5) return goal === 'bulk' ? 50 : 40
  if (avgReps <= 12) return goal === 'bulk' ? 100 : 80
  if (avgReps <= 20) return goal === 'bulk' ? 85 : 100
  if (avgReps <= 30) return goal === 'bulk' ? 60 : 85
  return goal === 'bulk' ? 40 : 60
}

/** 重量分（规范第 5.3 节）：等级型（本应用只能识别"自重"）/ 数字型两分支 */
const WEIGHT_BODYWEIGHT = 50
const WEIGHT_NO_BASELINE = 70
function weightScoreOf(avgWeight: number | null, baseAvg: number | null): number {
  if (avgWeight == null || avgWeight <= 0) return WEIGHT_BODYWEIGHT
  if (baseAvg == null || baseAvg <= 0) return WEIGHT_NO_BASELINE
  const ratio = avgWeight / baseAvg
  if (ratio >= 1.05) return 100
  if (ratio >= 0.95) return 80
  if (ratio >= 0.85) return 60
  return 40
}

/** 规范第 0 节的分档（六段，文字用）；热力颜色用五档粗分 */
export function scoreBandOf(score: number): { label: string; hint: string } {
  if (score >= 100) return { label: '运动充分', hint: '当前目标下已经练够，维持即可' }
  if (score >= 90) return { label: '高度充分', hint: '很够，可小幅渐进' }
  if (score >= 75) return { label: '足够', hint: '基本够，有短板' }
  if (score >= 60) return { label: '基本够', hint: '需要补一项或两项' }
  if (score >= 40) return { label: '不够', hint: '刺激不足或体感拖后腿' }
  return { label: '明显不足', hint: '优先查频率、强度或体感' }
}

/**
 * 分数 → 热力档位（MuscleMap 只认 5 档）。未练（0 组）单独占 0 档（灰）——
 * 「没有数据」与「练了但只有 20 分」必须在颜色上分开，前者不是值、后者是。
 */
export function heatLevelOf(score: number, sets: number): HeatLevel {
  if (sets <= 0) return 0
  if (score >= 90) return 4
  if (score >= 75) return 3
  if (score >= 60) return 2
  return 1
}

/* ---------------- 输出结构 ---------------- */

export type Confidence = 'high' | 'mid' | 'low'
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: '高', mid: '中', low: '低' }

/** 最低分项（建议依据） */
export type WeakKey = 'frequency' | 'sets' | 'reps' | 'weight' | 'feeling'
export const WEAK_LABEL: Record<WeakKey, string> = {
  frequency: '频率',
  sets: '组数',
  reps: '次数',
  weight: '重量',
  feeling: '体感',
}

/** 一个计分维度：原始分 + 权重 + 加权贡献（抽屉里的分解图直接用这三个数） */
export interface Dimension {
  key: 'frequency' | 'intensity' | 'feeling'
  label: string
  /** 原始维度分 0..100 */
  score: number
  /** 目标下的权重 0..1 */
  weight: number
  /** 加权贡献 = score × weight */
  contribution: number
  /** 一句话依据 */
  note: string
}

/** 强度分内部的三个子项（抽屉展开用） */
export interface SubScore {
  key: 'sets' | 'reps' | 'weight'
  label: string
  score: number
  weight: number
  contribution: number
  note: string
}

export interface GroupScore {
  group: ScoreGroupKey
  label: string
  /** 练够分 0..100 */
  score: number
  /** 规范六段档名 */
  band: string
  bandHint: string
  /** 热力档位（0..4） */
  level: HeatLevel
  /** 本周训练次数（同日合并为 1 次；激活 ≥2 才计） */
  freqCount: number
  /** 本周加权正式组数（激活折算） */
  sets: number
  /** 组数分的满分区间（补弱加练按它的下沿算缺口） */
  setsTarget: [number, number]
  /** 本周平均每组次数；null = 本周没有可用的次数数据 */
  avgReps: number | null
  /** 本周平均单组重量 kg；null = 自重 / 无重量记录 */
  avgWeight: number | null
  /** 过去 4 周同组平均单组重量；null = 无基线 */
  baseWeight: number | null
  frequency: Dimension
  intensity: Dimension
  setsScore: SubScore
  repsScore: SubScore
  weightScore: SubScore
  feeling: Dimension
  /** 本周有自评的会话数 */
  feelingSamples: number
  /** 体感缺失（规范：默认 60 分并降置信度） */
  feelingMissing: boolean
  confidence: Confidence
  /** 最低分项（卡片/抽屉显示「短板：强度」用） */
  weakest: WeakKey
  /** 建议（规范第 10 节） */
  advice: string[]
  /** 本周该组没有任何刺激 */
  idle: boolean
}

export interface TrainingScoreResult {
  goal: ScoreGoal
  weights: { frequency: number; intensity: number; feeling: number }
  groups: GroupScore[]
  /** 有记录的组平均分（0..100）；无记录为 0 */
  average: number
  trainedCount: number
  totalCount: number
  /** 卡片一句话结论 */
  summary: string
  /** 完全没有训练记录（整卡隐藏用） */
  empty: boolean
}

export interface TrainingScoreInput {
  /** 近 N 天逐组记录（`strength_recent_sets`，含热身组与 readiness） */
  sets: StrengthSetRecord[]
  /** 动作库（肌群表兜底） */
  library: ExerciseRecord[]
  /** 本地今天（YYYY-MM-DD） */
  today: string
  /** 用户当前目标 */
  goal: Goal | null | undefined
}

/* ---------------- 主入口 ---------------- */

/** 每组累加器（week = 本周窗口；base = 过去 4 周基线） */
interface Acc {
  sets: number
  rawSets: number
  numericRawSets: number
  repsSum: number
  repsW: number
  weightSum: number
  weightW: number
  days: Set<string>
  /** 本周该组的会话 → 自评值（同一天多次训练也只算一个体感样本） */
  sessionFeel: Map<number, number | null>
}

function emptyAcc(): Acc {
  return {
    sets: 0,
    rawSets: 0,
    numericRawSets: 0,
    repsSum: 0,
    repsW: 0,
    weightSum: 0,
    weightW: 0,
    days: new Set(),
    sessionFeel: new Map(),
  }
}

export function computeTrainingScore(input: TrainingScoreInput): TrainingScoreResult {
  const goal = scoreGoalOf(input.goal)
  const weights = SCORE_WEIGHTS[goal]
  const libById = new Map(input.library.map((e) => [e.id, e]))

  // 窗口：本周 = [today-6, today]；基线 = 本周之前的 28 天
  const weekStart = addDays(input.today, -(SCORE_WEEK_DAYS - 1))
  const baseStart = addDays(weekStart, -SCORE_BASE_DAYS)

  const week = new Map<ScoreGroupKey, Acc>()
  const base = new Map<ScoreGroupKey, { sum: number; n: number }>()
  for (const g of SCORE_GROUPS) {
    week.set(g.key, emptyAcc())
    base.set(g.key, { sum: 0, n: 0 })
  }

  for (const s of input.sets) {
    if (s.warmup) continue
    if (s.weightKg == null && s.reps == null && s.sec == null) continue
    const ex = s.exerciseId ? libById.get(s.exerciseId) : undefined
    const map = musclesOf(ex, s.exerciseName)
    const entries = Object.entries(map) as [MuscleKey, Level][]
    if (!entries.length) continue

    // 同一组里，一个评估组只按**最高**激活档计一次（胸上束 2 + 胸下束 3 → 胸按主攻算）
    const byGroup = new Map<ScoreGroupKey, Level>()
    for (const [m, lv] of entries) {
      const g = SCORE_GROUP_OF[m]
      if (!g) continue
      const cur = byGroup.get(g)
      if (!cur || lv > cur) byGroup.set(g, lv)
    }

    const inWeek = s.date >= weekStart
    const inBase = s.date >= baseStart && s.date < weekStart
    if (!inWeek && !inBase) continue

    for (const [g, lv] of byGroup) {
      const w = ACTIVATION_WEIGHT[lv] ?? 0.5
      if (inWeek) {
        const acc = week.get(g)!
        acc.sets += w
        acc.rawSets += 1
        if (s.weightKg != null && s.weightKg > 0) {
          acc.weightSum += w * s.weightKg
          acc.weightW += w
          acc.numericRawSets += 1
        }
        if (s.reps != null && s.reps > 0) {
          acc.repsSum += w * s.reps
          acc.repsW += w
        }
        // 频率与体感只看「真练到」的会话（辅助及以上）
        if (lv >= 2) {
          acc.days.add(s.date)
          acc.sessionFeel.set(s.workoutId, s.readiness ?? null)
        }
      } else if (s.weightKg != null && s.weightKg > 0) {
        const b = base.get(g)!
        b.sum += s.weightKg
        b.n += 1
      }
    }
  }

  const groups: GroupScore[] = SCORE_GROUPS.map((g) =>
    scoreGroup(g.key, g.label, goal, weights, week.get(g.key)!, base.get(g.key)!),
  )

  const trained = groups.filter((g) => !g.idle)
  const average = trained.length ? Math.round(trained.reduce((n, g) => n + g.score, 0) / trained.length) : 0

  return {
    goal,
    weights,
    groups,
    average,
    trainedCount: trained.length,
    totalCount: groups.length,
    summary: summarize(groups, trained, average),
    empty: trained.length === 0,
  }
}

function musclesOf(ex: ExerciseRecord | undefined, name: string) {
  if (ex && Object.keys(ex.muscles ?? {}).length) return ex.muscles
  return libraryMuscles(ex ?? { name, muscles: {} })
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** 本周完全没刺激的组：分数与全部维度都是 0（不做任何"中性默认"的补偿） */
function idleGroup(
  key: ScoreGroupKey,
  label: string,
  goal: ScoreGoal,
  weights: { frequency: number; intensity: number; feeling: number },
): GroupScore {
  const dim = (k: Dimension['key'], l: string, note: string): Dimension => ({
    key: k,
    label: l,
    score: 0,
    weight: weights[k],
    contribution: 0,
    note,
  })
  const sub = (k: SubScore['key'], l: string, note: string): SubScore => ({
    key: k,
    label: l,
    score: 0,
    weight: INTENSITY_SUB[k],
    contribution: 0,
    note,
  })
  return {
    group: key,
    label,
    score: 0,
    band: '明显不足',
    bandHint: '本周没有任何刺激',
    level: 0,
    freqCount: 0,
    sets: 0,
    setsTarget: SETS_SWEET[goal],
    avgReps: null,
    avgWeight: null,
    baseWeight: null,
    frequency: dim('frequency', '频率', '本周 0 次'),
    intensity: dim('intensity', '强度', '本周没有训练记录'),
    setsScore: sub('sets', '组数', '0 组'),
    repsScore: sub('reps', '次数', '无数据'),
    weightScore: sub('weight', '重量', '无数据'),
    feeling: dim('feeling', '体感', '无训练记录'),
    feelingSamples: 0,
    feelingMissing: true,
    confidence: 'low',
    weakest: 'frequency',
    advice: buildAdvice({ key: 'frequency' }, goal, 0, null, 0, true),
    idle: true,
  }
}

/** 单组评分：按规范逐项算，再把三项加权成强度分，最后合成练够分 */
function scoreGroup(
  key: ScoreGroupKey,
  label: string,
  goal: ScoreGoal,
  weights: { frequency: number; intensity: number; feeling: number },
  acc: Acc,
  baseW: { sum: number; n: number },
): GroupScore {
  const idle = acc.sets <= 0
  const sets = round1(acc.sets)
  const freqCount = acc.days.size

  // 未练：不给任何「中性默认值」留幻觉空间 —— 分数就是 0，档位就是未练。
  // （否则 0 组 + 次数/重量的占位分会让一个从没练过的肌群显示成 29 分）
  if (idle) return idleGroup(key, label, goal, weights)

  const avgReps = acc.repsW > 0 ? round1(acc.repsSum / acc.repsW) : null
  const avgWeight = acc.weightW > 0 ? round1(acc.weightSum / acc.weightW) : null
  const baseWeight = baseW.n > 0 ? round1(baseW.sum / baseW.n) : null

  const fScore = freqScoreOf(goal, freqCount)
  const sScore = setsScoreOf(goal, sets)
  // 没有次数数据（如纯计时动作）时给中性分，不因缺字段判"次数低"
  const rScore = avgReps == null ? FEELING_DEFAULT : repsScoreOf(goal, avgReps)
  const wScore = weightScoreOf(avgWeight, baseWeight)

  const intensityRaw = sScore * INTENSITY_SUB.sets + rScore * INTENSITY_SUB.reps + wScore * INTENSITY_SUB.weight

  const samples = [...acc.sessionFeel.values()].filter((v): v is number => typeof v === 'number')
  const feelingMissing = samples.length === 0
  const feelingRaw = feelingMissing
    ? FEELING_DEFAULT
    : samples.reduce((n, v) => n + FEELING_SCORE[feelingOfReadiness(v) ?? 'fair'], 0) / samples.length
  const poorFeeling = !feelingMissing && feelingRaw < 60

  const total = Math.min(
    100,
    Math.round(fScore * weights.frequency + intensityRaw * weights.intensity + feelingRaw * weights.feeling),
  )

  // 置信度（规范第 7 节）：空表或体感全缺 = 低；三项都齐 = 高
  const weightComplete = acc.rawSets === 0 || acc.numericRawSets === 0 || acc.numericRawSets === acc.rawSets
  const confidence: Confidence =
    freqCount === 0 || feelingMissing
      ? 'low'
      : freqCount >= 2 && samples.length >= 2 && weightComplete
        ? 'high'
        : 'mid'

  const weakest = pickWeakest(
    [
      { key: 'frequency', loss: weights.frequency * (100 - fScore) },
      { key: 'sets', loss: weights.intensity * INTENSITY_SUB.sets * (100 - sScore) },
      { key: 'reps', loss: weights.intensity * INTENSITY_SUB.reps * (100 - rScore) },
      { key: 'weight', loss: weights.intensity * INTENSITY_SUB.weight * (100 - wScore) },
      // 体感只在「差」时参与竞争 —— 一般(60) 是规范给的默认值，不该喧宾夺主
      { key: 'feeling', loss: poorFeeling ? weights.feeling * (100 - feelingRaw) : 0 },
    ],
    feelingMissing,
  )

  const band = scoreBandOf(total)

  const frequency: Dimension = {
    key: 'frequency',
    label: '频率',
    score: fScore,
    weight: weights.frequency,
    contribution: Math.round(fScore * weights.frequency * 10) / 10,
    note: `本周 ${freqCount} 次（同日合并计 1 次）`,
  }
  const intensity: Dimension = {
    key: 'intensity',
    label: '强度',
    score: Math.round(intensityRaw),
    weight: weights.intensity,
    contribution: Math.round(intensityRaw * weights.intensity * 10) / 10,
    note: `${sets} 组 · 每组约 ${avgReps ?? '—'} 次 · ${weightNote(avgWeight, baseWeight)}`,
  }
  const feeling: Dimension = {
    key: 'feeling',
    label: '体感',
    score: Math.round(feelingRaw),
    weight: weights.feeling,
    contribution: Math.round(feelingRaw * weights.feeling * 10) / 10,
    note: feelingMissing
      ? `${freqCount ? `${freqCount} 次训练均未自评` : '无训练记录'} · 按规范默认 60 分计`
      : `本周 ${samples.length} 次自评的平均分`,
  }

  const setsScore: SubScore = {
    key: 'sets',
    label: '组数',
    score: sScore,
    weight: INTENSITY_SUB.sets,
    contribution: Math.round((sScore * INTENSITY_SUB.sets + Number.EPSILON) * 10) / 10,
    note: `${sets} 组 · 满分区间 ${SETS_SWEET[goal][0]}–${SETS_SWEET[goal][1]} 组`,
  }
  const repsScore: SubScore = {
    key: 'reps',
    label: '次数',
    score: rScore,
    weight: INTENSITY_SUB.reps,
    contribution: Math.round((rScore * INTENSITY_SUB.reps + Number.EPSILON) * 10) / 10,
    note: avgReps == null ? '本周无次数数据 · 按中性计' : `每组约 ${avgReps} 次 · 满分区间 ${REPS_SWEET[goal][0]}–${REPS_SWEET[goal][1]} 次`,
  }
  const weightScore: SubScore = {
    key: 'weight',
    label: '重量',
    score: wScore,
    weight: INTENSITY_SUB.weight,
    contribution: Math.round((wScore * INTENSITY_SUB.weight + Number.EPSILON) * 10) / 10,
    note: weightNote(avgWeight, baseWeight),
  }

  return {
    group: key,
    label,
    score: total,
    band: band.label,
    bandHint: band.hint,
    level: heatLevelOf(total, acc.sets),
    freqCount,
    sets,
    setsTarget: SETS_SWEET[goal],
    avgReps,
    avgWeight,
    baseWeight,
    frequency,
    intensity,
    setsScore,
    repsScore,
    weightScore,
    feeling,
    feelingSamples: samples.length,
    feelingMissing,
    confidence,
    weakest: weakest.key,
    advice: buildAdvice(weakest, goal, sets, avgReps, total, idle),
    idle,
  }
}

function weightNote(avgWeight: number | null, baseWeight: number | null): string {
  if (avgWeight == null) return '自重 / 无重量记录'
  if (baseWeight == null) return `平均 ${avgWeight}kg · 无 4 周基线`
  const pct = Math.round((avgWeight / baseWeight) * 100)
  return `平均 ${avgWeight}kg · 为 4 周基线的 ${pct}%`
}

/** 取加权损失最大的分项；体感缺失时不让体感项占位（默认 60 是中性值，不是短板） */
function pickWeakest(items: { key: WeakKey; loss: number }[], feelingMissing: boolean): { key: WeakKey } {
  const pool = feelingMissing ? items.filter((i) => i.key !== 'feeling') : items
  let best = pool[0]!
  for (const it of pool) if (it.loss > best.loss) best = it
  return best
}

/** 建议（规范第 10 节）：按最低分项给，且区分「少了」与「多了」两个方向 */
function buildAdvice(
  weakest: { key: WeakKey },
  goal: ScoreGoal,
  sets: number,
  avgReps: number | null,
  total: number,
  idle: boolean,
): string[] {
  if (total >= 100) return ['已运动充分。保持当前训练，不要盲目加量。']
  if (idle) return ['本周该肌群没有训练记录，每周安排 1 次把它带起来。']

  switch (weakest.key) {
    case 'frequency':
      return ['每周增加 1 次该肌群训练。']
    case 'sets': {
      const [lo, hi] = SETS_SWEET[goal]
      return sets > hi
        ? [`本周 ${sets} 组偏多，可减量并提高强度。`]
        : [`每周加 2–4 组正式组（现 ${sets} 组，满分区间 ${lo}–${hi} 组）。`]
    }
    case 'reps': {
      const [lo, hi] = REPS_SWEET[goal]
      if (avgReps == null) return ['补记每组次数，才能判断次数是否合适。']
      return avgReps > hi
        ? ['每组次数过多，可加重量降次数。']
        : [`每组约 ${avgReps} 次偏少，可降重量加次数（满分区间 ${lo}–${hi} 次）。`]
    }
    case 'weight':
      return ['尝试加重，或提高重量等级。']
    case 'feeling':
      return goal === 'bulk'
        ? ['不要继续加量，保持频率，降低组数。']
        : ['保持频率，降低强度，增加低强度活动。']
  }
}

/** 卡片一句话结论：先说最该管的那件事 */
function summarize(groups: GroupScore[], trained: GroupScore[], average: number): string {
  if (!trained.length) return '本周还没有力量训练记录'
  const low = trained.filter((g) => g.score < 60)
  const idle = groups.length - trained.length
  if (low.length) return `${low.length} 个肌群练得不够，建议补量`
  if (idle && average >= 75) return `已练的肌群都够了 · ${idle} 个本周未练`
  if (average >= 90) return '各肌群都练得很充分'
  if (idle) return `${idle} 个肌群本周未练`
  return '各肌群基本练够，个别有短板'
}

/** 全 0 档（一片灰、没有信息）判定：整卡隐藏用 */
export function scoreAllIdle(result: TrainingScoreResult): boolean {
  return result.empty
}

/** 供热力图把「组分数」投影到 39 个细肌群（同组同色） */
export function groupLevelMap(result: TrainingScoreResult): Record<MuscleKey, HeatLevel> {
  const byGroup = new Map(result.groups.map((g) => [g.group, g.level]))
  const out = {} as Record<MuscleKey, HeatLevel>
  for (const g of SCORE_GROUPS) {
    const lv = byGroup.get(g.key) ?? 0
    for (const m of g.members) out[m] = lv
  }
  return out
}

/** 供热力图悬停副标：细肌群 → 「组名 · 分数 · 档名」 */
export function groupTooltipMap(result: TrainingScoreResult): Record<MuscleKey, string> {
  const byGroup = new Map(result.groups.map((g) => [g.group, g]))
  const out = {} as Record<MuscleKey, string>
  for (const g of SCORE_GROUPS) {
    const s = byGroup.get(g.key)
    for (const m of g.members) out[m] = s && !s.idle ? `${s.label} ${s.score} 分 · ${s.band}` : `${g.label} · 未练`
  }
  return out
}

/** 供卡片/抽屉：把组分数做成一份可直接渲染的列表（键用组名，避免细肌群重复 39 行） */
export function groupRows(result: TrainingScoreResult): {
  key: ScoreGroupKey
  label: string
  score: number
  level: HeatLevel
  band: string
  note: string
  idle: boolean
}[] {
  return result.groups.map((g) => ({
    key: g.group,
    label: SCORE_GROUP_LABELS[g.group],
    score: g.score,
    level: g.level,
    band: g.band,
    note: g.idle ? '本周未练' : `${g.sets} 组 · ${g.freqCount} 次 · 体感 ${g.feeling.score}`,
    idle: g.idle,
  }))
}
