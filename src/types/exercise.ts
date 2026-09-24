/** 运动域类型 · 与 Rust `modules/exercise` / `modules/exercise_lib` 对应 */

import type { ActivationMap, MuscleKey } from '@/config/muscles'

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
  /** 动作要领：分步说明（空数组 = 未收录） */
  steps: string[]
  /** 用户收藏（置顶展示；种子刷新不覆盖） */
  favorite: boolean
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
  /** 动作要领：分步说明（清洗：最多 12 条、单条 200 字） */
  steps?: string[]
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

/* ---------------- 动作库筛选（动作库页与动作选择器共用） ---------------- */

/** 排序口径：最近使用 / 名称 / 训练次数（收藏永远置顶） */
export type ExerciseSort = 'recent' | 'name' | 'sessions'

export interface ExerciseFilterState {
  kind: ExerciseKind | ''
  category: ExerciseCategory | ''
  equipment: ExerciseEquipment | ''
  /** 肌群多选：命中任一即算（按展示用肌群表判断） */
  muscles: MuscleKey[]
  onlyFavorite: boolean
  sort: ExerciseSort
}

export const EMPTY_EXERCISE_FILTER: ExerciseFilterState = {
  kind: '',
  category: '',
  equipment: '',
  muscles: [],
  onlyFavorite: false,
  sort: 'recent',
}

/** 除分类外的筛选条件个数（角标用；分类在页面上是主浏览轴，单独一行） */
export function filterBadgeCount(f: ExerciseFilterState): number {
  return (
    (f.kind ? 1 : 0) +
    (f.equipment ? 1 : 0) +
    (f.muscles.length ? 1 : 0) +
    (f.onlyFavorite ? 1 : 0) +
    (f.sort !== 'recent' ? 1 : 0)
  )
}
