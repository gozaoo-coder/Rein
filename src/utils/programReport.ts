/** 方案执行报告：方案归档后按执行数据汇总（进度/完成率/摄入/体重变化/调整次数）。 */

import { dietService } from '@/services/dietService'
import { exerciseService } from '@/services/exerciseService'
import { nutritionService } from '@/services/nutritionService'
import { todoService } from '@/services/todoService'
import { diffDays } from '@/utils/date'
import { parseBlob } from '@/utils/programEngine'
import { aggregateWorkouts, trainedDates, trainingExec, type WorkoutAgg } from '@/utils/programExec'
import type { ProgramRecord, Todo } from '@/types'
import { mealKcal } from '@/config/domain'

export interface ProgramReport {
  startDate: string
  endDate: string
  plannedDays: number
  targetKcal: number
  adjustmentsCount: number
  /** 方案日程待办：计划 / 完成（原始条目口径，保留供追溯） */
  schedule: { planned: number; done: number }
  /** 计划训练日 vs 兑现（有运动记录或勾了日程的并集口径） */
  training: { planned: number; done: number }
  /** 区间内真实运动记录（含课程会话 / 补录 / 手环同步） */
  actual: WorkoutAgg
  /** 方案期内训练打卡日（运动记录 ∪ 日程完成，升序去重） */
  trainedDates: string[]
  /** 有记录日内的平均摄入；完全没有记录时为 null */
  avgIntake: number | null
  recordedDays: number
  weightDeltaKg: number | null
}

function countStatus(todos: Todo[]): { planned: number; done: number } {
  return { planned: todos.length, done: todos.filter((t) => t.status === 'done').length }
}

/** 汇总一份归档方案的执行报告（只读：全部来自现有查询接口） */
export async function buildProgramReport(record: ProgramRecord): Promise<ProgramReport> {
  const blob = parseBlob(record)
  const startDate = blob.days[0]?.date ?? ''
  const endDate = blob.days.at(-1)?.date ?? startDate
  const plannedDays = blob.days.length

  let adjustmentsCount = 0
  try {
    const arr = JSON.parse(record.adjustmentsJson) as unknown
    if (Array.isArray(arr)) adjustmentsCount = arr.length
  } catch {
    /* 忽略损坏的调整历史 */
  }

  const all = await todoService.listAllTodos()
  const mine = all.filter((t) => t.programId === record.id)
  const schedule = countStatus(mine)

  const [workouts, mealsRange, metrics] = await Promise.all([
    exerciseService.listWorkouts(startDate, endDate),
    dietService.listMealsRange(startDate, endDate),
    nutritionService.listBodyMetrics(100),
  ])
  const actual = aggregateWorkouts(workouts, startDate, endDate)
  const exec = trainingExec(blob, startDate, endDate, workouts, all, record.id)
  const training = { planned: exec.planned, done: exec.done }

  const recordedDays = new Set(mealsRange.map((m) => m.date)).size
  const intakeSum = mealsRange.reduce((s, m) => s + (mealKcal(m) ?? 0), 0)
  const avgIntake = recordedDays > 0 ? Math.round(intakeSum / recordedDays) : null

  const inRange = metrics
    .filter((m) => m.weightKg != null && m.date >= startDate && m.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date))
  let weightDeltaKg: number | null = null
  if (inRange.length >= 2) {
    weightDeltaKg = Math.round((inRange.at(-1)!.weightKg! - inRange[0]!.weightKg!) * 10) / 10
  }

  return {
    startDate,
    endDate,
    plannedDays,
    targetKcal: Math.round(blob.params.targets.kcal),
    adjustmentsCount,
    schedule,
    training,
    actual,
    trainedDates: trainedDates(startDate, endDate, workouts, all, record.id),
    avgIntake,
    recordedDays,
    weightDeltaKg,
  }
}

/** 报告期跨度文案，如「31 天」 */
export function reportSpanDays(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0
  return diffDays(startDate, endDate) + 1
}

/** 体重变化方向文案 */
export function fmtWeightDelta(delta: number | null): string {
  if (delta == null) return '—'
  return `${delta > 0 ? '+' : ''}${delta} kg`
}

/** 完成率百分数 */
export function fmtRate(done: number, planned: number): string {
  return planned === 0 ? '—' : `${Math.round((done / planned) * 100)}%`
}
