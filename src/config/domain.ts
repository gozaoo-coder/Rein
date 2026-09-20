/** 领域展示元数据：标签、图标色、MET 表。UI 文案统一从这里取，避免散落硬编码。 */

import type { Component } from 'vue'
import { Apple, Coffee, Utensils } from 'lucide-vue-next'

import type { Goal, ActivityLevel, DailyTargets } from '@/types/nutrition'
import type { MealLog, MealType } from '@/types/diet'
import type { Intensity, WorkoutType, ExerciseCategory, ExerciseEquipment, ExerciseKind } from '@/types/exercise'
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
  // 课表派生行专用；不在 TODO_CATEGORIES 里，用户与 AI 都选不到它
  class: { label: '课程', colorVar: '--cat-class' },
}

/**
 * 优先级四象限（重要 × 紧急）：0 普通（不重要不紧急）/ 1 重要不紧急 / 2 紧急不重要 / 3 重要且紧急。
 * 旧三档（普通/重要/紧急）数值语义不变，编辑器以四象限选择，排序仍按 value 降序。
 */
export const PRIORITY_META: { value: number; label: string; colorVar: string }[] = [
  { value: 0, label: '普通', colorVar: '--text-3' },
  { value: 1, label: '重要不紧急', colorVar: '--c-carb' },
  { value: 2, label: '紧急不重要', colorVar: '--c-fat' },
  { value: 3, label: '重要且紧急', colorVar: '--danger' },
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

/* ---------------- 动作库展示元数据（action library：分类 / 器材 / 类型） ---------------- */

/** 动作分类（动作库页分组与筛选的顺序即此数组顺序） */
export const EXERCISE_CATEGORY_META: { key: ExerciseCategory; label: string }[] = [
  { key: 'push', label: '推' },
  { key: 'pull', label: '拉' },
  { key: 'legs', label: '腿' },
  { key: 'core', label: '核心' },
  { key: 'cardio', label: '有氧' },
  { key: 'mobility', label: '柔韧' },
  { key: 'other', label: '其他' },
]

export const EXERCISE_CATEGORY_LABELS: Record<ExerciseCategory, string> = Object.fromEntries(
  EXERCISE_CATEGORY_META.map((c) => [c.key, c.label]),
) as Record<ExerciseCategory, string>

export const EXERCISE_EQUIPMENT_LABELS: Record<ExerciseEquipment, string> = {
  barbell: '杠铃',
  dumbbell: '哑铃',
  machine: '器械',
  cable: '绳索',
  bodyweight: '自重',
  band: '弹力带',
  cardio: '有氧器械',
  other: '其他',
}

export const EXERCISE_KIND_LABELS: Record<ExerciseKind, string> = {
  strength: '力量',
  timed: '计时',
  cardio: '有氧',
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

/**
 * 跑步热量：ACSM 跑步代谢方程（平地，坡度按 0 计）。
 * VO2 (ml/kg/min) = 0.2 × v + 3.5，v 为平均速度 (m/min)；
 * 千卡 = VO2(L/min) × 5 kcal/L → 化简为 (0.2v + 3.5) × 体重kg × 分钟 ÷ 200。
 * 相比配速三档 MET，热量随平均配速连续变化，长距离误差显著更小。
 * km 缺失（跑步机未补填 / GPS 不可用）时退回 MET 中档估算。
 */
export function estimateRunKcal(
  km: number | null,
  elapsedSec: number,
  weightKg: number,
): number {
  const minutes = Math.max(1, elapsedSec / 60)
  if (km == null || km <= 0.01) return estimateKcal('run', 'moderate', minutes, weightKg)
  const v = (km * 1000) / minutes // 平均速度 m/min
  return Math.round(((0.2 * v + 3.5) * weightKg * minutes) / 200)
}
