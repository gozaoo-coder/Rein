/** 训练课程域类型 · 与 Rust `modules/plan` 对应 */

import type { PlanExercise, WorkoutPlan } from './session'

/** 数据库中的完整课程记录（含审计与最近使用字段） */
export interface WorkoutPlanRecord extends WorkoutPlan {
  /** 最近一次开始训练的时间（后端 UTC 时间串）；从未使用为 null */
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 新建 / 更新提交体：id 由前端生成（新建用 crypto.randomUUID()） */
export interface WorkoutPlanInput {
  id: string
  name: string
  subtitle: string
  workoutType: WorkoutPlan['workoutType']
  exercises: PlanExercise[]
}

/** 跑步会话在 workout_sessions 中使用的虚拟 planId */
export const RUN_PLAN_ID = '__run__'
