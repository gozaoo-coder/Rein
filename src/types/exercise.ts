/** 运动域类型 · 与 Rust `modules/exercise` 对应 */

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
