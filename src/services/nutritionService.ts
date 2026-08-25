/** 营养域 IPC 封装 · 对应 modules/nutrition/commands.rs */

import type { BodyMetric, BodyMetricInput, CalcState, DailySummary, DailyTargets, Profile } from '@/types'
import { invoke } from './transport'

export const nutritionService = {
  /** 当日摄入聚合 + 目标 + 运动消耗 */
  getDailySummary: (date: string) => invoke<DailySummary>('get_daily_summary', { date }),

  /** date 为 null 时返回资料默认目标 */
  getTargets: (date?: string | null) => invoke<DailyTargets>('get_targets', { date: date ?? null }),

  /** date 为 null 时写入资料默认目标；否则只覆盖该天 */
  setTargets: (targets: DailyTargets, date?: string | null) =>
    invoke<void>('set_targets', { targets, date: date ?? null }),

  getProfile: () => invoke<Profile>('get_profile'),

  updateProfile: (profile: Profile) => invoke<Profile>('update_profile', { profile }),

  /* ---- 方案计算器参数快照 ---- */

  /** 从未保存过时返回 null */
  getCalcState: () => invoke<CalcState | null>('get_calc_state'),

  saveCalcState: (s: CalcState) => invoke<CalcState>('save_calc_state', { s }),

  /* ---- 体重 / 身高追踪 ---- */

  listBodyMetrics: (limit?: number) => invoke<BodyMetric[]>('list_body_metrics', { limit: limit ?? null }),

  recordBodyMetric: (metric: BodyMetricInput) => invoke<BodyMetric>('record_body_metric', { metric }),

  deleteBodyMetric: (id: number) => invoke<void>('delete_body_metric', { id }),
}
