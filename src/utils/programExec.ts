/**
 * 方案执行口径 · 纯函数：把「计划训练日」与「真实执行」对齐。
 *
 * 执行 = 当天有运动记录（课程会话 / 手动补录 / 手环同步都算）**或**方案日程已勾。
 * 这两个信号互为补充：勾日程代表「我按计划做了」，运动记录代表「我真的动了」；
 * 复盘、执行报告、结营成绩单共用同一口径，不再各数各的待办勾选。
 */

import type { ProgramBlob, Todo, Workout } from '@/types'

/** 区间内真实运动记录的聚合（不区分来源：本地课程 / 补录 / 手环导入） */
export interface WorkoutAgg {
  count: number
  /** 有运动记录的独立天数 */
  days: number
  /** 课程会话次数（sessionId 非空 = 从沉浸课保存的记录） */
  sessions: number
  minutes: number
  kcal: number
}

export function aggregateWorkouts(workouts: Workout[], from: string, to: string): WorkoutAgg {
  const inRange = workouts.filter((w) => w.date >= from && w.date <= to)
  return {
    count: inRange.length,
    days: new Set(inRange.map((w) => w.date)).size,
    sessions: inRange.filter((w) => w.sessionId != null).length,
    minutes: Math.round(inRange.reduce((s, w) => s + (w.durationMin ?? 0), 0)),
    kcal: Math.round(inRange.reduce((s, w) => s + w.kcal, 0)),
  }
}

/** 计划训练日（非休息且有课程的日子） */
export function plannedTrainingDates(blob: ProgramBlob, from: string, to: string): string[] {
  return blob.days
    .filter((d) => !d.rest && d.courseId && d.date >= from && d.date <= to)
    .map((d) => d.date)
}

export interface TrainingExec {
  planned: number
  done: number
  /** 兑现方式里「有真实运动记录」的天数（其余靠勾日程兑现） */
  doneByRecord: number
  missedDates: string[]
}

/** 计划 vs 兑现：done = 计划日里「有运动记录 ∪ 方案日程已勾」的并集 */
export function trainingExec(
  blob: ProgramBlob,
  from: string,
  to: string,
  workouts: Workout[],
  todos: Todo[],
  programId: number,
): TrainingExec {
  const planned = plannedTrainingDates(blob, from, to)
  const recordDates = new Set(
    workouts.filter((w) => w.date >= from && w.date <= to).map((w) => w.date),
  )
  const todoDates = new Set(
    todos
      .filter(
        (t) =>
          t.programId === programId &&
          t.category === 'workout' &&
          t.status === 'done' &&
          t.date != null,
      )
      .map((t) => t.date as string),
  )
  const missed = planned.filter((d) => !recordDates.has(d) && !todoDates.has(d))
  return {
    planned: planned.length,
    done: planned.length - missed.length,
    doneByRecord: planned.filter((d) => recordDates.has(d)).length,
    missedDates: missed,
  }
}

/** 方案期内的训练打卡日（并集）：连续打卡 / 徽章共用 */
export function trainedDates(
  from: string,
  to: string,
  workouts: Workout[],
  todos: Todo[],
  programId: number,
): string[] {
  const set = new Set<string>()
  for (const w of workouts) if (w.date >= from && w.date <= to) set.add(w.date)
  for (const t of todos) {
    if (t.programId === programId && t.status === 'done' && t.date != null && t.date >= from && t.date <= to) {
      set.add(t.date)
    }
  }
  return [...set].sort()
}
