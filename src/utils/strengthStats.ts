/**
 * 动作历史与 PR（纯函数）。
 *
 * 数据源：`strength_history(exerciseId)` 的逐组记录（含热身标记）。
 * 口径与 `utils/strength.ts` 的曲线一致：只看正式组（热身不计容量），
 * 估算 1RM 复用 trainingAdvice 的 Epley/Brzycki —— 同一套公式全端只有一份。
 */

import { estimateOneRepMax } from './trainingAdvice'
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
    let bestE1rm = 0
    let volumeKg = 0
    for (const s of working) {
      const w = s.weightKg ?? 0
      const reps = s.reps ?? 0
      if (w > topWeightKg) {
        topWeightKg = w
        topReps = s.reps ?? null
      }
      volumeKg += w * reps
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
      warmups: sets.length - working.length,
    })
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.workoutId - b.workoutId))

  const prs: ExercisePrs = { weight: null, e1rm: null, volume: null }
  for (const s of sessions) {
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
