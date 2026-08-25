/** 训练课程 IPC 封装 · 对应 modules/plan/commands.rs */

import type { WorkoutPlanInput, WorkoutPlanRecord } from '@/types'
import { invoke } from './transport'

export const planService = {
  /** 最近使用的在前 */
  list: () => invoke<WorkoutPlanRecord[]>('list_workout_plans'),

  get: (id: string) => invoke<WorkoutPlanRecord>('get_workout_plan', { id }),

  upsert: (p: WorkoutPlanInput) =>
    invoke<WorkoutPlanRecord>('upsert_workout_plan', {
      input: {
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        workoutType: p.workoutType,
        exercises: p.exercises,
      },
    }),

  remove: (id: string) => invoke<void>('delete_workout_plan', { id }),

  /** 开始训练时调用，维护「最近使用」排序 */
  touch: (id: string) => invoke<void>('touch_workout_plan', { id }),
}
