/** 课程展示辅助：时长估算与动作摘要文案（最近卡片 / 详情页 / 编辑页共用）。 */

import { WORKOUT_META } from '@/config/domain'
import type { PlanExercise, WorkoutPlan } from '@/types'

/** 粗估课程时长：力量每组按 45s（热身组 30s），计时按目标秒，有氧按分钟数；含组间休息 */
export function estimatePlanMinutes(plan: WorkoutPlan): number {
  let s = 0
  for (const e of plan.exercises) {
    if (e.kind === 'cardio') s += (e.durationMin ?? 0) * 60
    else {
      const per = e.kind === 'timed' ? (e.targetSec ?? 30) : 45
      s += e.sets * (per + e.restSec)
      if (e.kind === 'strength') s += (e.warmups?.length ?? 0) * 45
    }
  }
  return Math.max(1, Math.round(s / 60))
}

/** 动作行摘要：如「4×8 @60kg · 休息 90s」；配激活热身组时追加标注 */
export function exerciseSub(e: PlanExercise): string {
  if (e.kind === 'strength')
    return `${e.sets}×${e.reps}${e.weightKg ? ` @${e.weightKg}kg` : '（自重）'} · 休息 ${e.restSec}s${e.warmups?.length ? ` · 热身 ${e.warmups.length} 组` : ''}`
  if (e.kind === 'timed') return `${e.sets}×${e.targetSec}s · 组间休息 ${e.restSec}s`
  return `${e.durationMin} 分钟 · 有氧放松`
}

/** 动作类型徽标文案 */
export function exerciseBadge(e: PlanExercise): string {
  if (e.kind === 'timed') return '计时 ⏱'
  if (e.kind === 'cardio') return '有氧'
  return ''
}

/** 课程可选的运动类型（用于卡路里估算与保存记录），避开纯户外项 */
export const PLAN_TYPE_OPTIONS = ['strength', 'hiit', 'yoga', 'ball', 'other'] as const

export function planTypeLabel(t: WorkoutPlan['workoutType']): string {
  return WORKOUT_META[t]?.label ?? t
}
