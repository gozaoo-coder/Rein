/** 体重趋势诊断 · 纯函数：从近期体重记录判定「连续异常」，用于主页自动提醒复盘。 */

import type { BodyMetric, Goal } from '@/types'
import { diffDays } from '@/utils/date'

export interface WeightAlert {
  reason: string
}

interface Pt {
  date: string
  kg: number
}

/** 近 8 条体重记录 → 异常判定（少于 3 个有效点或跨度 < 4 天视为数据不足，不提醒） */
export function weightTrendAlert(
  metrics: BodyMetric[],
  goal: Goal,
  weightKg: number | null,
): WeightAlert | null {
  const pts: Pt[] = metrics
    .filter((m): m is BodyMetric & { weightKg: number } => m.weightKg != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-8)
    .map((m) => ({ date: m.date, kg: m.weightKg }))

  if (pts.length < 3) return null
  const days = diffDays(pts[0]!.date, pts.at(-1)!.date)
  if (days < 4) return null

  const first = pts[0]!.kg
  const last = pts.at(-1)!.kg
  const ref = weightKg ?? last
  const weekly = ((last - first) / days) * 7

  // 目标相关的异常带（kg/周）：cut 掉秤过快/反向增重；bulk 涨太快/反向掉秤；keep 波动过大
  const cut = { fastLoss: 0.011 * ref, gain: 0.5 }
  const bulk = { fastGain: 0.012 * ref, loss: 0.3 }
  const keep = { swing: 0.008 * ref }

  let reason: string | null = null
  if (goal === 'cut') {
    if (weekly > cut.gain) reason = `近 ${days} 天体重反向上升（周趋势 +${weekly.toFixed(1)} kg），与减脂目标相反`
    else if (weekly < -cut.fastLoss) reason = `近 ${days} 天掉秤过快（周趋势 ${weekly.toFixed(1)} kg），建议收小缺口或复查记录`
    else if (days >= 7 && Math.abs(last - first) < 0.3) reason = '体重近一周几乎不动，可能存在停滞，建议复盘调整'
  } else if (goal === 'bulk') {
    if (weekly < -bulk.loss) reason = `近 ${days} 天体重反向下降（周趋势 ${weekly.toFixed(1)} kg），与增肌目标相反`
    else if (weekly > bulk.fastGain) reason = `近 ${days} 天增重过快（周趋势 +${weekly.toFixed(1)} kg），建议控制盈余`
    else if (days >= 7 && Math.abs(last - first) < 0.3) reason = '体重近一周几乎不动，增肌停滞，建议复盘调整'
  } else {
    if (Math.abs(weekly) > keep.swing) reason = `近 ${days} 天体重波动偏大（周趋势 ${weekly > 0 ? '+' : ''}${weekly.toFixed(1)} kg）`
  }

  return reason ? { reason } : null
}
