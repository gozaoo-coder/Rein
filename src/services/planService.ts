/** 训练课程 IPC 封装 · 对应 modules/plan/commands.rs */

import type { PlanSeedStatus, WorkoutPlanInput, WorkoutPlanRecord } from '@/types'
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

  /** 内置课程种子升级状态：currentVersion 落后 latestVersion 即有新版本待决策 */
  seedStatus: () => invoke<PlanSeedStatus>('plan_seed_status_cmd'),

  /** 兼容合并：新种子按动作字段级合并进本地内置课，不覆盖用户设置 */
  seedMigrate: () => invoke<PlanSeedStatus>('apply_plan_seed_migrate'),

  /** 使用新版本：内置课内容整体替换为新种子 */
  seedOverride: () => invoke<PlanSeedStatus>('apply_plan_seed_override'),

  /** 保留我的：本版本不再刷新内置课内容，只结清提示 */
  seedKeep: () => invoke<PlanSeedStatus>('apply_plan_seed_keep'),
}
