/**
 * 训练总结的派生口径（纯函数，无 IPC、无 store 依赖）。
 *
 * 总结页要回答一个此前从没回答过的问题：**这次练得怎么样**。
 * 原先只有一行总量（n/N 组 · 总容量 · 用时 · 大卡），它说得清"做了多少"，
 * 说不清"做得如何" —— 同样的 480 kg，有人是 5 组 × 96，有人是 2 组 × 240，
 * 前者耐力后者力量，训练含义完全不同。所以这里把一次会话拆成三层：
 *
 *  1. **完成层**（完成环 / 跳过 / 加练）：`buildCompletion`。
 *     口径与 store 严格一致 —— 只有真正登记进 doneSets 的正式组才计入完成数，
 *     跳过 = 未做 = 不统计（仍占分母），激活热身组完全不进分子也不进分母。
 *  2. **成绩层**（逐动作分解）：`buildExerciseRows`。
 *     每个动作一行：完成组数、容量、最高组、以及与上次的逐项差。
 *     「最高组」取本次该动作**最大重量**的那一组（不是最后一组）—— 力量训练
 *     的信息量在峰值而不在收尾，渐进超负荷的达成与否也只看这一组。
 *  3. **进步层**（PR）：`buildPrRows` + `mergeHistoryPr`。
 *     两级口径，**这是本文件唯一需要解释的设计**：
 *     · 即时级：拿 `lastWeights`（上次实际做组重量）与上次 e1RM 当场比，零请求、
 *       总结页秒开。代价是基线只是"上一次"，上次恰是巅峰时会低估真实进步。
 *     · 校正级：异步拉 `strength_history` 全量历史后调 `mergeHistoryPr` 覆盖，
 *       判定变为「本次 > 历史全部记录」，口径与 utils/strengthStats 的 PR 一致。
 *     UI 上二者必须**视觉可区分**（校正级多一枚实心标记），否则用户会以为
 *     那个数字一直是准的 —— 汇总口径的可信度是这类页面最容易被悄悄破坏的东西。
 *
 * 所有「取不到」的情形都返回 null 而不是 0 / 空串：分母缺失时进度环该空着，
 * 容量缺失时不该显示 0 kg。上层据此选择不渲染，而不是渲染出一个假的 0。
 */

import { estimateOneRepMax } from './trainingAdvice'
import { SCORE_GROUP_OF, SCORE_GROUPS, type ActivationMap, type Level, type MuscleKey, type ScoreGroupKey } from '@/config/muscles'
import type { PlanExerciseKind, SessionSetSlot, StrengthLastWeight, StrengthSetRecord } from '@/types'

/** 重量显示：整数不带小数，62.5 保留一位 */
export function fmtKg(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

const round1 = (v: number) => Math.round(v * 10) / 10

/* ---------------- 完成层 ---------------- */

export interface Completion {
  /** 已完成正式组（计入统计） */
  done: number
  /** 全课组位（计划 + 加练；跳过的组仍占位） */
  total: number
  /** 跳过的正式组（未做，不计入 done） */
  skipped: number
  /** 完成的激活热身组（不进分子也不进分母） */
  warmups: number
  /** 「再加一组」追加的组数 */
  extra: number
  /** 完成率 0..1；total 为 0 时 null（不返回 0，避免"0%"被读成"一组没做"） */
  ratio: number | null
  /** 提前结束（done < total） */
  earlyEnd: boolean
}

/**
 * 完成层：按 state 统计组格。
 * `slots` 用 store 的 courseSlots（含热身格）。热身格按 warmup 标记分流，
 * 不与正式组混算 —— 这条不变量 store 已在游标语义上保证，这里只做呈现分流。
 */
export function buildCompletion(slots: SessionSetSlot[], extra: number): Completion {
  let done = 0
  let skipped = 0
  let warmups = 0
  let total = 0
  for (const s of slots) {
    if (s.warmup) {
      if (s.state === 'done') warmups++
      continue
    }
    total++
    if (s.state === 'done') done++
    else if (s.state === 'skipped') skipped++
  }
  return {
    done,
    total,
    skipped,
    warmups,
    extra,
    ratio: total > 0 ? done / total : null,
    earlyEnd: done < total,
  }
}

/* ---------------- 成绩层 ---------------- */

/** 逐动作建议（来自训练建议引擎；非力量动作为 null） */
export interface ExerciseAdviceLite {
  suggestedWeight: number | null
  suggestedReps: number | null
}

export interface ExerciseRow {
  exId: string
  /**
   * 历史聚合键：`strength_history` / `strength_last_weights` 认的键。
   * 动作库 id 优先，缺省回落**展示名** —— 种子课程的 `exerciseId` 整列为空
   * （见 resources/workout_plans.json），而这两个命令都兼容按名称命中
   * （sessionService 的注释与 mock 的 `resolveExerciseId` 都写明了这一点）。
   * 只传课程条目 id（`ppl-push-bench` 这类）会一条历史都查不到 ——
   * 那会让「进步」整块永远空着，而空着看起来像"没进步"，是这里最坏的失败方式。
   */
  historyKey: string
  name: string
  kind: PlanExerciseKind
  /** 完成的正式组数 */
  doneCount: number
  /** 该动作组位（计划 + 加练） */
  plannedCount: number
  skippedCount: number
  /** 力量：Σ 重量×次数；计时/有氧为 0 */
  volumeKg: number
  /** 计时/有氧：累计秒数；力量为 0 */
  totalSec: number
  /** 力量：本次最高组重量（null = 没做力量组） */
  topWeightKg: number | null
  /** 力量：最高组的次数（与 topWeightKg 同一组） */
  topReps: number | null
  /** 力量：本次最佳估算 1RM；无有效组时 null */
  bestE1rm: number | null
  /** 该动作的组间休息编排值（秒；平均组间用） */
  restSec: number
  /** 上次实际做组重量（无历史时 null） */
  lastWeightKg: number | null
  lastReps: number | null
  /** 最高组重量 − 上次重量；任一缺失时 null */
  weightDelta: number | null
  /** 本次最佳 e1RM − 上次 e1RM（上次 e1RM 由 lastWeight×lastReps 现场算）；缺历史时 null */
  e1rmDelta: number | null
  /** 下次建议（引擎未给或非力量动作为 null） */
  suggestedWeight: number | null
  suggestedReps: number | null
  /** 肌群激活（汇总卡用） */
  muscles: ActivationMap | null
}

/** 逐动作编排数据：组间休息与库内展示名/肌群都从这里取（store 里没有，调用方从 plan 拼） */
export interface ExerciseMeta {
  restSec: number
  name?: string
  muscles?: ActivationMap | null
  /** 动作库 id；种子课程为空 → 回落展示名作为历史聚合键 */
  exerciseId?: string | null
}

/**
 * 组格 → 逐动作行。同一个 exId 落在同一行（课程里动作不重复，键稳）。
 * `meta` 提供组间休息、展示名与历史聚合键；`adviceOf` 给该动作的下次建议。
 */
export function buildExerciseRows(
  slots: SessionSetSlot[],
  lastWeights: Record<string, StrengthLastWeight>,
  meta: Record<string, ExerciseMeta>,
  adviceOf: (exId: string) => ExerciseAdviceLite | null,
): ExerciseRow[] {
  const order: string[] = []
  const byEx = new Map<string, ExerciseRow>()

  for (const s of slots) {
    if (s.warmup) continue // 热身组不进成绩行（不计入容量与最高组）
    let row = byEx.get(s.exId)
    if (!row) {
      order.push(s.exId)
      const m = meta[s.exId] ?? {}
      const name = m.name || s.exName
      const historyKey = m.exerciseId || name
      // 上次重量按 historyKey 取：store 载入时也是用动作库 id 批量查的，
      // 种子课程那批键是空串 → lastWeights 落空 → 这次是唯一能命中它的机会
      const last = lastWeights[historyKey] ?? lastWeights[s.exId] ?? null
      const adv = adviceOf(s.exId)
      row = {
        exId: s.exId,
        historyKey,
        name,
        kind: s.kind,
        doneCount: 0,
        plannedCount: 0,
        skippedCount: 0,
        volumeKg: 0,
        totalSec: 0,
        topWeightKg: null,
        topReps: null,
        bestE1rm: null,
        restSec: m.restSec ?? 0,
        lastWeightKg: last?.weightKg ?? null,
        lastReps: last?.reps ?? null,
        weightDelta: null,
        e1rmDelta: null,
        suggestedWeight: adv?.suggestedWeight ?? null,
        suggestedReps: adv?.suggestedReps ?? null,
        muscles: m.muscles ?? null,
      }
      byEx.set(s.exId, row)
    }
    row.plannedCount++
    if (s.state === 'skipped') {
      row.skippedCount++
      continue
    }
    if (s.state !== 'done') continue
    row.doneCount++

    const d = s.done
    if (d?.sec != null) {
      // 计时组：秒数累加；weight 为 null，不参与最高组
      row.totalSec += d.sec
      continue
    }
    if (d?.weight == null) continue
    const reps = d.reps ?? 0
    row.volumeKg += d.weight * reps
    const e1 = estimateOneRepMax(d.weight, reps)
    if (e1 > 0 && (row.bestE1rm == null || e1 > row.bestE1rm)) row.bestE1rm = e1
    // 最高组：**同重量时取次数多的那一组** —— 60kg×8 比 60kg×5 更接近真实能力上限
    if (row.topWeightKg == null || d.weight > row.topWeightKg) {
      row.topWeightKg = d.weight
      row.topReps = reps
    } else if (d.weight === row.topWeightKg && reps > (row.topReps ?? 0)) {
      row.topReps = reps
    }
  }

  const rows = order.map((id) => byEx.get(id)!)
  for (const r of rows) {
    r.volumeKg = Math.round(r.volumeKg)
    r.bestE1rm = r.bestE1rm == null ? null : round1(r.bestE1rm)
    if (r.topWeightKg != null && r.lastWeightKg != null) {
      r.weightDelta = round1(r.topWeightKg - r.lastWeightKg)
    }
    if (r.bestE1rm != null && r.lastWeightKg != null && r.lastReps) {
      r.e1rmDelta = round1(r.bestE1rm - estimateOneRepMax(r.lastWeightKg, r.lastReps))
    }
  }
  return rows
}

/* ---------------- 进步层 ---------------- */

export type PrKind = 'weight' | 'e1rm'

/** 进步判定可信度：instant = 与上次比（零请求）；verified = 与全量历史比（已校正） */
export type PrConfidence = 'instant' | 'verified'

export interface PrRow {
  exId: string
  name: string
  kind: PrKind
  /** 本次值（重量 PR = 最高组重量；e1RM PR = 最佳估算 1RM） */
  value: number
  /** 增量（value − 基线），恒为正 */
  delta: number
  /** 对比的基线值：instant = 上次；verified = 历史最优 */
  prevBest: number | null
  confidence: PrConfidence
}

/**
 * 即时 PR：与 `lastWeights`（上次实际重量）及由它推出的上次 e1RM 比。
 * 零请求，总结页打开即有内容。**只有正向才算进步** —— 负增量不是 PR，
 * 展示层不该在这里把"没练到"说成 PR；退步属于另一套措辞（下次建议里给）。
 */
export function buildPrRows(rows: ExerciseRow[]): PrRow[] {
  const out: PrRow[] = []
  for (const r of rows) {
    if (r.topWeightKg != null && r.lastWeightKg != null && r.weightDelta != null && r.weightDelta > 0) {
      out.push({
        exId: r.exId,
        name: r.name,
        kind: 'weight',
        value: r.topWeightKg,
        delta: r.weightDelta,
        prevBest: r.lastWeightKg,
        confidence: 'instant',
      })
    }
    if (r.bestE1rm != null && r.e1rmDelta != null && r.e1rmDelta > 0 && r.lastWeightKg != null && r.lastReps) {
      out.push({
        exId: r.exId,
        name: r.name,
        kind: 'e1rm',
        value: r.bestE1rm,
        delta: r.e1rmDelta,
        prevBest: round1(estimateOneRepMax(r.lastWeightKg, r.lastReps)),
        confidence: 'instant',
      })
    }
  }
  return sortPr(out)
}

/** 增量降序；增量相同时重量 PR 排前（重量比 e1RM 更"实在"） */
function sortPr(list: PrRow[]): PrRow[] {
  return list.sort((a, b) => (b.delta === a.delta ? (a.kind === 'weight' ? -1 : 1) : b.delta - a.delta))
}

/**
 * 校正级 PR：用 `strength_history` 的全量历史覆盖即时判定。
 *
 * 为什么必须校正：即时口径的基线只是"上一次"，不等于历史最强。
 * 上次恰是巅峰时，本次真实超越历史最优会被误判成"没进步"；反之上次状态一般，
 * 本次只是回到常态，也会被误报成 PR。历史到手后改判为「本次 > 历史全部记录」，
 * 与 utils/strengthStats 的 PR 口径一致。
 *
 * 严格大于而非 >=：历史里若已含本次（同一 workoutId 被重放 / 用户先保存过一次），
 * `>=` 会让本次永远等于自己、PR 恒真。
 */
export function mergeHistoryPr(rows: ExerciseRow[], history: Map<string, StrengthSetRecord[]>): PrRow[] {
  const out: PrRow[] = []
  for (const r of rows) {
    const recs = history.get(r.historyKey) ?? []
    if (!recs.length) continue // 没历史 → 保留（即时判定里它本来也不会有 PR）

    let bestWeight = 0
    let bestE1rm = 0
    for (const rec of recs) {
      if (rec.warmup) continue
      const w = rec.weightKg ?? 0
      const e = estimateOneRepMax(w, rec.reps ?? 0)
      if (w > bestWeight) bestWeight = w
      if (e > bestE1rm) bestE1rm = e
    }

    if (r.topWeightKg != null && bestWeight > 0 && r.topWeightKg > bestWeight) {
      out.push({
        exId: r.exId,
        name: r.name,
        kind: 'weight',
        value: r.topWeightKg,
        delta: round1(r.topWeightKg - bestWeight),
        prevBest: round1(bestWeight),
        confidence: 'verified',
      })
    }
    if (r.bestE1rm != null && bestE1rm > 0 && r.bestE1rm > bestE1rm) {
      out.push({
        exId: r.exId,
        name: r.name,
        kind: 'e1rm',
        value: r.bestE1rm,
        delta: round1(r.bestE1rm - bestE1rm),
        prevBest: round1(bestE1rm),
        confidence: 'verified',
      })
    }
  }
  return sortPr(out)
}

/* ---------------- 肌群汇总 ---------------- */

/**
 * 汇总到**评估组**（胸/背/肩/二头…共 10 个），不是细肌束。
 *
 * 为什么折叠：动作的激活表细到 39 个肌束，一次推日就能点出 8 块不同的小肌群
 * （「胸大肌上束」「胸大肌下束」各占一格），用户读下来是两张一样的标签，
 * 既读不出「今天练了哪里」，也读不出主次。折叠到评估组后，
 * 「胸 主攻 / 肩 主攻 / 背 辅助 / 三头 辅助」才是能指导下次安排的一句话。
 * 折叠口径复用 `SCORE_GROUP_OF`（由 config/muscles 的 SCORE_GROUPS 派生）——
 * 全端唯一一份，换一处就要改一处的那种重复正是这里要避免的。
 *
 * 档位仍取各细肌束的最大值，不做加权或求和（理由同前：档位是语义不是数量）。
 */
export interface MuscleTally {
  group: ScoreGroupKey
  label: string
  /** 该组内达到的最高激活档 */
  level: Level
}

const LEVEL_LABEL: Record<Level, string> = { 1: '稳定', 2: '辅助', 3: '主攻' }

export function levelLabel(lv: Level): string {
  return LEVEL_LABEL[lv]
}

export function tallyMuscles(rows: ExerciseRow[]): MuscleTally[] {
  const map = new Map<ScoreGroupKey, Level>()
  for (const r of rows) {
    if (!r.muscles || r.doneCount === 0) continue // 没做的动作不计入（跳过/未做不算激活）
    for (const [m, lv] of Object.entries(r.muscles) as [MuscleKey, Level][]) {
      const g = SCORE_GROUP_OF[m]
      if (!g) continue // 未登记的键（脏数据）直接丢，不让它污染统计
      const cur = map.get(g)
      if (cur == null || lv > cur) map.set(g, lv)
    }
  }
  return SCORE_GROUPS.filter((g) => map.has(g.key)).map((g) => ({
    group: g.key,
    label: g.label,
    level: map.get(g.key)!,
  }))
}

/* ---------------- 节奏层 ---------------- */

export interface Rhythm {
  /** 平均组间休息（秒，按课程编排的 restSec 加权）；null = 无可算的组间 */
  avgRestSec: number | null
  /** 每组平均耗时（秒）：用时 / 完成组数 */
  secPerSet: number | null
}

/**
 * 节奏：平均组间 + 每组耗时。
 *
 * 平均组间**用课程编排的 restSec**，不是实测耗时 —— 倒计时被跳过、被临时休息
 * 打断都会让实测不可得，而 restSec 是全程一致且用户自己编排过的那个值。
 * 只统计「组位 ≥2 的动作内相邻组间」；一个动作只做 1 组时它内部没有组间，
 * 不参与平均（否则单组动作会把均值拉低）。
 *
 * 每组耗时低于 `MIN_SEC_PER_SET` 时返回 null：秒级取整下，
 * 任何在一分钟内跑完整节课的情况（自动化 e2e、误触连点）都会算出 0，
 * 而「每组耗时 0 秒」是个既荒谬又刺眼的数 —— 与其显示它，不如承认这一项不成立。
 *
 * 口径写在这里而不是让调用方各自拍：两组"平均组间"若一个是编排值一个是实测值，
 * 同一节课会给出两个数，那比不给更糟。
 */
export const MIN_SEC_PER_SET = 5

export function buildRhythm(rows: ExerciseRow[], durationSec: number, done: number): Rhythm {
  let restSum = 0
  let restGaps = 0
  for (const r of rows) {
    if (r.plannedCount < 2 || r.restSec <= 0) continue
    const gaps = r.plannedCount - 1
    restSum += r.restSec * gaps
    restGaps += gaps
  }
  const perSet = done > 0 ? Math.round(durationSec / done) : null
  return {
    avgRestSec: restGaps > 0 ? Math.round(restSum / restGaps) : null,
    secPerSet: perSet != null && perSet >= MIN_SEC_PER_SET ? perSet : null,
  }
}
