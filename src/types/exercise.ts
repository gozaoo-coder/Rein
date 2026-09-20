/** 运动域类型 · 与 Rust `modules/exercise` / `modules/exercise_lib` 对应 */

import type { ActivationMap } from '@/config/muscles'

export const WORKOUT_TYPES = [
  'walk',
  'run',
  'cycle',
  'swim',
  'strength',
  'hiit',
  'yoga',
  'ball',
  'other',
] as const

export type WorkoutType = (typeof WORKOUT_TYPES)[number]
export type Intensity = 'low' | 'moderate' | 'high'

/* ---------------- 动作库（迁移 0025：全部运动动作的唯一真源） ---------------- */

export type ExerciseKind = 'strength' | 'timed' | 'cardio'

/** 浏览分组（动作库页的分类筛选） */
export type ExerciseCategory = 'push' | 'pull' | 'legs' | 'core' | 'cardio' | 'mobility' | 'other'

/** 器材：决定建议重量的取整步进（杠铃 2.5 / 哑铃 2 …） */
export type ExerciseEquipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'band'
  | 'cardio'
  | 'other'

/** 库内动作（含使用统计）。内置动作 isCustom=false 只读；自建动作可改可删 */
export interface ExerciseRecord {
  id: string
  name: string
  /** 别名：仅用于把旧数据（自由命名）匹配到库内动作 */
  aliases: string[]
  kind: ExerciseKind
  category: ExerciseCategory
  equipment: ExerciseEquipment | null
  /** 肌群激活表（显式数据；自建动作缺省时前端按名称规则兜底展示） */
  muscles: ActivationMap
  tips: string
  defaultSets: number
  defaultReps: number | null
  defaultWeightKg: number | null
  defaultTargetSec: number | null
  defaultDurationMin: number | null
  defaultRestSec: number
  /** 建议重量取整步进 kg；0 = 自重动作不加重量 */
  weightStep: number
  isCustom: boolean
  hidden: boolean
  /** 有做组记录的训练次数 */
  sessions: number
  /** 最近一次做组的训练日期 */
  lastUsedAt: string | null
}

/** 自建动作的新建 / 更新提交体（内置动作提交会被后端拒绝） */
export interface ExerciseInput {
  id?: string
  name: string
  aliases?: string[]
  kind: ExerciseKind
  category: ExerciseCategory
  equipment?: ExerciseEquipment | null
  muscles?: ActivationMap
  tips?: string
  defaultSets?: number
  defaultReps?: number | null
  defaultWeightKg?: number | null
  defaultTargetSec?: number | null
  defaultDurationMin?: number | null
  defaultRestSec?: number
  weightStep?: number
}

export interface Workout {
  id: number
  name: string
  type: WorkoutType
  date: string
  startMin: number | null
  durationMin: number
  kcal: number
  intensity: Intensity
  note: string | null
  /** 来源会话（训练课/跑步保存时落关联）；手动添加为 null */
  sessionId: number | null
  createdAt: string
}

export interface WorkoutInput {
  name: string
  type: WorkoutType
  date: string
  startMin?: number | null
  durationMin: number
  intensity: Intensity
  kcal: number
  note?: string | null
}
