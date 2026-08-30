/** 健康方案域类型 · 与 Rust `modules/program` 及前端引擎 programEngine 对应 */

import type { MealType } from './diet'
import type { DailyTargets, Equipment, Goal } from './nutrition'

/** 方案档位：保守 / 均衡 / 进取（热量缺口、蛋白配比与训练频率递进） */
export type ProgramTier = 'conservative' | 'balanced' | 'aggressive'

export const PROGRAM_TIERS: ProgramTier[] = ['conservative', 'balanced', 'aggressive']

/** 方案开始参数：开始日 + 首练课程 + 反解出的周模板相位（向导 → 方案页） */
export interface ProgramStart {
  /** next=下周一（默认）/ today / tomorrow */
  startMode: 'next' | 'today' | 'tomorrow'
  /** 首个训练日课程 id；null = 按模板默认顺序 */
  firstCourseId: string | null
  /** 周模板序列相位（0-6）：startDate 当天取模板第 phase 位 */
  phase: number
  startDate: string
}

/** 方案营养与结构参数（一次调整 = 生成一份新 params） */
export interface ProgramParams {
  /** 相对 TDEE 的每日热量偏移（负 = 缺口减脂，正 = 盈余增肌） */
  kcalDelta: number
  /** 蛋白质 g/kg 体重 */
  proteinPerKg: number
  /** 计算得到的每日目标（含 BMR/TDEE 快照，供复盘对比） */
  targets: DailyTargets
  bmr: number
  tdee: number
  /** 每日餐次数：3 | 4 | 5 */
  mealsCount: number
  /** 每周训练天数（已按用户可用时间钳制） */
  trainingDays: number
  /** 选用的周计划模板 id */
  weekTemplateId: string
  /** 生成时依据的器械条件 */
  equipment: Equipment | null
  /** 周模板相位（0-6）：方案第 i 天的课程 = 模板序列第 (phase+i)%7 位。
   * 让方案接续用户当前的训练节奏（如今天刚练拉，首练接腿），不再死绑周一。 */
  phase: number
}

/** 单餐安排：食谱模板按热量比例缩放后的展示结果 */
export interface ProgramMeal {
  /** 餐次归类：与 diet 记录的 mealType 同一枚举，供打卡/统计直接比对 */
  mealType: MealType
  /** 餐次展示名：早餐 / 午餐 / 下午加餐…（仅展示，不参与逻辑判断） */
  slot: string
  name: string
  items: string[]
  kcal: number
  protein: number
  carb: number
  fat: number
}

/** 方案中的一天：训练 + 菜单 + 当日注意（禁忌） */
export interface ProgramDay {
  date: string
  /** 从方案起始日起的天序（0 起） */
  dayIndex: number
  /** 是否休息日（无训练课） */
  rest: boolean
  courseId: string | null
  courseName: string | null
  /** 课程预估时长（分钟），日程排布用；null = 未标注（回退默认值） */
  courseDurationMin: number | null
  meals: ProgramMeal[]
  rules: string[]
}

/** 方案内容快照：programs.params_json 的结构 */
export interface ProgramBlob {
  params: ProgramParams
  days: ProgramDay[]
}

/** 引擎生成的方案草稿（未落库；三档对比选择用） */
export interface ProgramPlan {
  goal: Goal
  tier: ProgramTier
  tierLabel: string
  tierDesc: string
  weeks: number
  startDate: string
  /** 身体数据缺失等硬性原因导致不可启用 */
  feasible: boolean
  issues: string[]
  /** 生成时的适配说明（如按可用时间降频） */
  notes: string[]
  params: ProgramParams
  days: ProgramDay[]
}

/** 一条调整记录：programs.adjustments_json 数组元素 */
export interface ProgramAdjustment {
  version: number
  at: string
  /** 一句话说明本次调整原因 */
  summary: string
  changes: ProgramChange[]
  /** 来源：ai 复盘 / 手动改参 */
  source: 'ai' | 'manual'
}

export interface ProgramChange {
  field: string
  label: string
  before: string
  after: string
}

/** programs 表行镜像（paramsJson 由调用方解析为 ProgramBlob） */
export interface ProgramRecord {
  id: number
  goal: Goal
  tier: ProgramTier
  status: 'active' | 'archived'
  version: number
  weeks: number
  paramsJson: string
  adjustmentsJson: string
  createdAt: string
  activatedAt: string
  updatedAt: string
}

/** 创建方案入参 */
export interface ProgramCreateInput {
  goal: Goal
  tier: ProgramTier
  weeks: number
  paramsJson: string
}

/** 方案日程待办批量写入项（todos 子集；programId 由后端注入） */
export interface ScheduleTodoInput {
  title: string
  notes?: string | null
  date?: string | null
  startMin?: number | null
  durationMin?: number | null
  category?: string
  priority?: number
}

/** 某天 AI 菜单缓存（program_meals 表行镜像；mealsJson 为 ProgramMeal-like 数组） */
export interface ProgramDayMeals {
  programId: number
  date: string
  mealsJson: string
  updatedAt: string
}

/** 采购清单勾选状态（shopping_checks 表行镜像；清单由菜单实时聚合，这里只存已买标记） */
export interface ShoppingCheck {
  itemKey: string
  checkedAt: string
}
