/** 领域展示元数据：标签、图标色、MET 表。UI 文案统一从这里取，避免散落硬编码。 */

import type { Component } from 'vue'
import { Apple, Coffee, Utensils } from 'lucide-vue-next'

import type { Goal, ActivityLevel, DailyTargets } from '@/types/nutrition'
import type { MealLog, MealType } from '@/types/diet'
import type { Intensity, WorkoutType } from '@/types/exercise'
import type { TodoCategory } from '@/types/todo'

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
}

export const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack']

/**
 * 餐次展示名 → MealType。方案菜单的槽位名比 MEAL_LABELS 更细
 * （「上午加餐 / 下午加餐」都对不上 MEAL_LABELS.snack 的「加餐」），
 * 所以用包含匹配而非相等比较，且必须先判「加餐」再判「午」，否则
 * 「上午加餐」会被 '午' 命中成午餐。未识别的一律归为加餐。
 */
export function mealTypeOfSlot(slot: string): MealType {
  if (slot.includes('加餐')) return 'snack'
  if (slot.includes('早')) return 'breakfast'
  if (slot.includes('午')) return 'lunch'
  if (slot.includes('晚')) return 'dinner'
  return 'snack'
}

/** 各餐次展示元数据：图标与主题色（一日脊柱、饮食历史共用） */
export const MEAL_META: Record<MealType, { icon: Component; colorVar: string }> = {
  breakfast: { icon: Coffee, colorVar: 'var(--led-food)' },
  lunch: { icon: Utensils, colorVar: 'var(--c-protein)' },
  dinner: { icon: Utensils, colorVar: 'var(--cat-study)' },
  snack: { icon: Apple, colorVar: 'var(--c-carb)' },
}

/** 单笔记录热量：每 100g 营养 × 克重 ÷ 100；food 未 join 时返回 null */
export function mealKcal(log: MealLog): number | null {
  if (!log.food) return null
  return Math.round((log.food.kcal * log.grams) / 100)
}

/** 桌面工作台断点：视口 ≥ 此宽度启用三窗格壳（导航轨）与主页双视图（便当总览/一日脊柱） */
export const DESKTOP_MIN = 1100

/** 按当前时间推荐餐次（聊天解析卡与拍照识别弹层共用） */
export function suggestMeal(): MealType {
  const h = new Date().getHours()
  if (h < 10) return 'breakfast'
  if (h < 14) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

export const CATEGORY_META: Record<TodoCategory, { label: string; colorVar: string }> = {
  general: { label: '日常', colorVar: '--cat-general' },
  workout: { label: '运动', colorVar: '--cat-workout' },
  health: { label: '健康', colorVar: '--cat-health' },
  study: { label: '学习', colorVar: '--cat-study' },
  work: { label: '工作', colorVar: '--cat-work' },
}

/** 重要程度三档（priority 数值含义）：普通 / 重要 / 紧急 */
export const PRIORITY_META: { value: number; label: string; colorVar: string }[] = [
  { value: 0, label: '普通', colorVar: '--text-3' },
  { value: 1, label: '重要', colorVar: '--c-carb' },
  { value: 2, label: '紧急', colorVar: '--danger' },
]

export function priorityMeta(value: number): { value: number; label: string; colorVar: string } {
  return PRIORITY_META.find((p) => p.value === value) ?? PRIORITY_META[0]!
}

export const INTENSITY_LABELS: Record<Intensity, string> = {
  low: '低强度',
  moderate: '中强度',
  high: '高强度',
}

export const ACTIVITY_LEVEL_LABELS: Record<ActivityLevel, string> = {
  sedentary: '久坐',
  light: '轻度活动',
  moderate: '中度活动',
  active: '高度活动',
}

export const GOAL_LABELS: Record<Goal, string> = {
  cut: '减脂',
  keep: '保持',
  bulk: '增肌',
}

/** 偏好运动时段 / 器械条件 / 训练经验的展示标签（「我」页约束卡与方案页共用） */
export const TIME_SLOT_LABELS: Record<string, string> = {
  morning: '早晨',
  noon: '午间',
  evening: '晚间',
}

export const EQUIPMENT_LABELS: Record<string, string> = {
  gym: '健身房',
  home: '居家徒手',
  mixed: '都可以',
}

export const EXPERIENCE_LABELS: Record<string, string> = {
  beginner: '新手',
  intermediate: '有基础',
  advanced: '进阶',
}

/** 可编辑目标字段元数据：标签 / 单位（计算器差异、AI 建议卡共用） */
export const TARGET_FIELD_META: { key: keyof DailyTargets; label: string; unit: string }[] = [
  { key: 'kcal', label: '能量', unit: '大卡' },
  { key: 'protein', label: '蛋白质', unit: 'g' },
  { key: 'carb', label: '碳水', unit: 'g' },
  { key: 'fat', label: '脂肪', unit: 'g' },
  { key: 'sodiumMg', label: '钠', unit: 'mg' },
  { key: 'waterMl', label: '饮水', unit: 'ml' },
]

/** 各运动的 MET 值（Ainsworth Compendium 近似），按强度分档 */
export const WORKOUT_META: Record<
  WorkoutType,
  { label: string; met: Record<Intensity, number> }
> = {
  walk: { label: '快走', met: { low: 2.8, moderate: 3.5, high: 4.3 } },
  run: { label: '跑步', met: { low: 8.0, moderate: 9.8, high: 11.5 } },
  cycle: { label: '骑行', met: { low: 5.0, moderate: 7.5, high: 10.0 } },
  swim: { label: '游泳', met: { low: 6.0, moderate: 8.3, high: 10.5 } },
  strength: { label: '力量训练', met: { low: 3.5, moderate: 5.0, high: 6.5 } },
  hiit: { label: 'HIIT', met: { low: 7.0, moderate: 10.0, high: 12.0 } },
  yoga: { label: '瑜伽', met: { low: 2.5, moderate: 3.0, high: 4.0 } },
  ball: { label: '球类', met: { low: 4.5, moderate: 6.5, high: 8.0 } },
  other: { label: '其他', met: { low: 3.5, moderate: 5.0, high: 6.5 } },
}

/** 每日运动消耗目标（大卡），对应三环中的绿环 */
export const EXERCISE_KCAL_GOAL = 300

/** MET → 千卡估算：kcal = MET × 3.5 × 体重kg ÷ 200 × 分钟 */
export function estimateKcal(
  type: WorkoutType,
  intensity: Intensity,
  minutes: number,
  weightKg: number,
): number {
  const met = WORKOUT_META[type].met[intensity]
  return Math.round(((met * 3.5 * weightKg) / 200) * minutes)
}
