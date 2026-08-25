/** 营养域类型 · 与 Rust `modules/nutrition` 对应 */

/** 每日目标（可按天覆盖，未设置时回落到资料默认值） */
export interface DailyTargets {
  kcal: number
  protein: number
  carb: number
  fat: number
  sodiumMg: number
  waterMl: number
}

/** 当日实际摄入聚合（与 Food 的每 100g 字段同名同义） */
export interface NutrientIntake {
  kcal: number
  protein: number
  carb: number
  fat: number
  fiber: number
  sugar: number
  sodiumMg: number
  potassiumMg: number
  calciumMg: number
  ironMg: number
  zincMg: number
  magnesiumMg: number
  vitAUg: number
  vitCMg: number
  vitDUg: number
  vitEMg: number
  vitB12Ug: number
  folateUg: number
}

export interface DailySummary {
  date: string
  intake: NutrientIntake
  targets: DailyTargets
  /** 当日运动消耗（来自 modules/exercise） */
  exerciseKcal: number
}

export type Sex = 'male' | 'female'
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active'
export type Goal = 'cut' | 'keep' | 'bulk'

export interface Profile {
  nickname: string
  sex: Sex | null
  birthday: string | null
  heightCm: number | null
  weightKg: number | null
  targetWeightKg: number | null
  activityLevel: ActivityLevel
  goal: Goal
  targets: DailyTargets
}

/** 方案计算器参数快照：savedAt 为 null 表示从未保存过 */
export interface CalcState {
  sex: Sex | null
  age: number | null
  heightCm: number | null
  weightKg: number | null
  activityLevel: ActivityLevel
  goal: Goal
  savedAt: string | null
}

/** 一条体重 / 身高记录（按天一条，两项至少一项有值） */
export interface BodyMetric {
  id: number
  date: string
  weightKg: number | null
  heightCm: number | null
  createdAt: string
}

/** 补录入参：同日再记只覆盖提供的项 */
export interface BodyMetricInput {
  date: string
  weightKg?: number | null
  heightCm?: number | null
}
