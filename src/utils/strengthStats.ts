/**
 * 动作历史与 PR（纯函数）。
 *
 * 数据源：`strength_history(exerciseId)` 的逐组记录（含热身标记）。
 * 口径与 `utils/strength.ts` 的曲线一致：只看正式组（热身不计容量），
 * 估算 1RM 复用 trainingAdvice 的 Epley/Brzycki —— 同一套公式全端只有一份。
 */

import { estimateOneRepMax } from './trainingAdvice'
import { setVolumeKg } from './sessionSummary'
import type { StrengthSetRecord } from '@/types'

export interface ExerciseSession {
  workoutId: number
  date: string
  /** 正式组数（不含热身） */
  sets: number
  topWeightKg: number
  topReps: number | null
  /** 本次最佳估算 1RM */
  bestE1rm: number
  /** 本次容量 = Σ 重量 × 次数 */
  volumeKg: number
  /**
   * 本次**单组最多次数**：自重动作的「最高组」。
   * 有重量的动作也照算（不展示），自重动作则靠它判 PR —— 引体 10 → 15 个是实打实的
   * 进步，而 weight / e1rm 两路对 `weightKg = null` 恒为空。
   */
  topSetReps: number | null
  /** 本次**总次数** Σ reps：自重动作的容量，量纲是「次」而不是 kg */
  totalReps: number
  warmups: number
}

export interface ExercisePrRecord {
  value: number
  date: string
  /** 重量 PR 才有：达成时做了几次 */
  reps?: number | null
}

export interface ExercisePrs {
  weight: ExercisePrRecord | null
  e1rm: ExercisePrRecord | null
  volume: ExercisePrRecord | null
  /** 单组最多次数 PR（自重动作的「最大重量」位；有配重的动作不填） */
  reps: ExercisePrRecord | null
  /** 单场总次数 PR（自重动作的「单场训练量」位；有配重的动作不填） */
  repsVolume: ExercisePrRecord | null
}

export interface ExerciseHistory {
  /** 按日期升序（同一天多次训练按 workoutId 升序） */
  sessions: ExerciseSession[]
  prs: ExercisePrs
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** 逐组记录 → 按训练场次聚合 + 三项 PR */
export function buildExerciseHistory(rows: StrengthSetRecord[]): ExerciseHistory {
  const byWorkout = new Map<number, StrengthSetRecord[]>()
  for (const r of rows) {
    const list = byWorkout.get(r.workoutId)
    if (list) list.push(r)
    else byWorkout.set(r.workoutId, [r])
  }

  const sessions: ExerciseSession[] = []
  for (const [workoutId, sets] of byWorkout) {
    const working = sets.filter((s) => !s.warmup)
    if (!working.length) continue
    const date = working[0]?.date ?? sets[0]?.date ?? ''
    let topWeightKg = 0
    let topReps: number | null = null
    let topSetReps: number | null = null
    let totalReps = 0
    let bestE1rm = 0
    let volumeKg = 0
    for (const s of working) {
      const w = s.weightKg ?? 0
      const reps = s.reps ?? 0
      if (reps > 0) {
        totalReps += reps
        if (topSetReps == null || reps > topSetReps) topSetReps = reps
      }
      if (w > topWeightKg) {
        topWeightKg = w
        topReps = s.reps ?? null
      }
      // 容量走全端唯一那份口径（次数缺失时按 1 次兜底）—— 这里从前算的是 `w * reps`，
      // reps 缺省为 0，于是这一组会从容量 PR 里静默消失
      volumeKg += setVolumeKg(s.weightKg, s.reps, null)
      bestE1rm = Math.max(bestE1rm, estimateOneRepMax(w, reps))
    }
    sessions.push({
      workoutId,
      date,
      sets: working.length,
      topWeightKg: round1(topWeightKg),
      topReps,
      bestE1rm: round1(bestE1rm),
      volumeKg: Math.round(volumeKg),
      topSetReps,
      totalReps,
      warmups: sets.length - working.length,
    })
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.workoutId - b.workoutId))

  const prs: ExercisePrs = { weight: null, e1rm: null, volume: null, reps: null, repsVolume: null }
  for (const s of sessions) {
    /**
     * 自重动作只有次数可看：`topWeightKg` 为 0 时 weight / e1rm / volume 三路恒空，
     * 「10 个引体 → 15 个引体」在旧口径里不记任何 PR。次数是自重的原生量纲，
     * 有配重的动作（topWeightKg > 0）仍走原来的重量口径，两套不混。
     */
    if (s.topWeightKg <= 0) {
      if (s.topSetReps != null && (!prs.reps || s.topSetReps > prs.reps.value)) {
        prs.reps = { value: s.topSetReps, date: s.date }
      }
      if (s.totalReps > 0 && (!prs.repsVolume || s.totalReps > prs.repsVolume.value)) {
        prs.repsVolume = { value: s.totalReps, date: s.date }
      }
    }
    if (s.topWeightKg > 0 && (!prs.weight || s.topWeightKg > prs.weight.value)) {
      prs.weight = { value: s.topWeightKg, date: s.date, reps: s.topReps }
    }
    if (s.bestE1rm > 0 && (!prs.e1rm || s.bestE1rm > prs.e1rm.value)) {
      prs.e1rm = { value: s.bestE1rm, date: s.date }
    }
    if (s.volumeKg > 0 && (!prs.volume || s.volumeKg > prs.volume.value)) {
      prs.volume = { value: s.volumeKg, date: s.date }
    }
  }

  return { sessions, prs }
}
