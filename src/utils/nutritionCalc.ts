/**
 * 营养参数计算 · 纯函数。
 * BMR 用 Mifflin-St Jeor 公式；TDEE = BMR × 活动系数；
 * 按目标加减热量缺口后，蛋白质按体重配比、脂肪按供能占比、碳水补足剩余热量。
 */

import type { ActivityLevel, DailyTargets, Goal, Sex } from '@/types'

/** 计算输入：身体数据 + 目标（age 由生日换算或直接输入） */
export interface CalcParams {
  sex: Sex
  age: number
  heightCm: number
  weightKg: number
  activityLevel: ActivityLevel
  goal: Goal
}

export interface CalcResult {
  /** 基础代谢（大卡/天） */
  bmr: number
  /** 每日总消耗（大卡/天） */
  tdee: number
  /** 推荐每日目标 */
  targets: DailyTargets
}

/** TDEE 活动系数 */
const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
}

/** 目标热量偏移：减脂温和缺口、增肌可控盈余 */
const GOAL_KCAL_DELTA: Record<Goal, number> = { cut: -400, keep: 0, bulk: 300 }

/** 蛋白质 g/kg 体重：减脂期更高以保留肌肉 */
const PROTEIN_PER_KG: Record<Goal, number> = { cut: 1.8, keep: 1.2, bulk: 1.6 }

/** 脂肪供能占比（膳食指南建议 20%~30%） */
const FAT_ENERGY_SHARE = 0.25

/** 热量安全下限，避免推荐值过低 */
export const KCAL_FLOOR = 1200

/** 覆盖默认公式的可调参数（方案引擎按档位传入不同缺口 / 蛋白配比） */
export interface TargetOverrides {
  /** 覆盖按目标取的默认热量偏移 */
  kcalDelta?: number
  /** 覆盖按目标取的默认蛋白 g/kg */
  proteinPerKg?: number
}

export function calcTargetsWith(p: CalcParams, o: TargetOverrides = {}): CalcResult {
  const sexOffset = p.sex === 'male' ? 5 : -161
  const bmr = Math.round(10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + sexOffset)
  const tdee = Math.round(bmr * ACTIVITY_FACTORS[p.activityLevel])
  const kcal = Math.max(
    KCAL_FLOOR,
    Math.round((tdee + (o.kcalDelta ?? GOAL_KCAL_DELTA[p.goal])) / 10) * 10,
  )
  const protein = Math.round(p.weightKg * (o.proteinPerKg ?? PROTEIN_PER_KG[p.goal]))
  const fat = Math.round((kcal * FAT_ENERGY_SHARE) / 9)
  const carb = Math.max(50, Math.round((kcal - protein * 4 - fat * 9) / 4))
  return {
    bmr,
    tdee,
    targets: {
      kcal,
      protein,
      carb,
      fat,
      sodiumMg: 1500,
      waterMl: Math.round((p.weightKg * 30) / 100) * 100,
    },
  }
}

export function calcTargets(p: CalcParams): CalcResult {
  return calcTargetsWith(p)
}
