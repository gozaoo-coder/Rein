/**
 * 体重趋势诊断 · 纯函数：从近期体重记录判定「连续异常」，用于主页自动提醒复盘。
 *
 * 这个函数只回答一个问题：**要不要请用户复盘**。所以它宁可少报 ——
 * 常报的提醒等于没有提醒，还会让人把趋势曲线当成随机数。
 */

import type { BodyMetric, Goal } from '@/types'
import { diffDays } from '@/utils/date'

export interface WeightAlert {
  reason: string
}

interface Pt {
  date: string
  kg: number
}

/** 周趋势（kg/周）；点不足 2 个或跨度为 0 天返回 null */
function weeklyRate(pts: Pt[]): number | null {
  if (pts.length < 2) return null
  const days = diffDays(pts[0]!.date, pts.at(-1)!.date)
  if (days <= 0) return null
  return ((pts.at(-1)!.kg - pts[0]!.kg) / days) * 7
}

/** 报给用户的速率取整到 0.5：日内水分就有 ±1kg，报「+0.47」是假精度 */
function roundHalf(v: number): number {
  return Math.round(v * 2) / 2
}

/** 中位数（偶数点取中间两个的均值）：做参照体重比首尾单点稳 */
function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** 带符号显示的速率（+0.5 / -0.5 / 0.0） */
function fmtRate(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

/**
 * 近 8 条体重记录 → 异常判定。
 *
 * 门槛：**至少 4 个点、跨度至少 10 天**（从前是 3 个点 / 4 天）。
 * 3 点 4 天算出的周斜率标准误约 ±1.1 kg/周 —— 一次称重的 ±1kg 水分、秤本身的
 * 0.1kg 重复性都会直接进斜率，而异常带本身只有 0.5~1.0 kg/周：等于拿噪声撞阈值。
 *
 * 另外要求**前后两段同向**：把窗口对半，前半段与后半段的周趋势必须同号。
 * 单点异常（某天的水分、一顿大餐）只会把整条斜率推一下，不会让两段都同向；
 * 真正的「连续异常」在两段里都留得下方向。
 */
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

  if (pts.length < 4) return null
  const days = diffDays(pts[0]!.date, pts.at(-1)!.date)
  if (days < 10) return null

  const first = pts[0]!.kg
  const last = pts.at(-1)!.kg
  const weekly = ((last - first) / days) * 7

  // 前后两段同向才算「连续」（见函数注释）
  const mid = Math.floor(pts.length / 2)
  const early = weeklyRate(pts.slice(0, mid + 1))
  const late = weeklyRate(pts.slice(mid))
  const continuous =
    early != null && late != null && Math.sign(early) === Math.sign(late) && Math.sign(late) !== 0

  // 异常带的参照体重：档案体重优先（跨窗口可比），没填就用窗口内中位数 ——
  // 从前用「最后一条记录」，于是最新那次称重的水分会同时抬高参照带与斜率，两处一起动。
  const ref = weightKg ?? median(pts.map((p) => p.kg))
  const rate = fmtRate(roundHalf(weekly))

  // 目标相关的异常带（kg/周）：cut 掉秤过快/反向增重；bulk 涨太快/反向掉秤；keep 波动过大
  const cut = { fastLoss: 0.011 * ref, gain: 0.5 }
  const bulk = { fastGain: 0.012 * ref, loss: 0.3 }
  const keep = { swing: 0.008 * ref }

  let reason: string | null = null
  if (goal === 'cut') {
    if (continuous && weekly > cut.gain) {
      reason = `近 ${days} 天体重反向上升（周趋势 ${rate} kg），与减脂目标相反 —— 先核对这几天的记录，再决定要不要收热量`
    } else if (continuous && weekly < -cut.fastLoss) {
      reason = `近 ${days} 天掉秤过快（周趋势 ${rate} kg），建议收小缺口或复查记录`
    } else if (Math.abs(last - first) < 0.3) {
      reason = `体重近 ${days} 天几乎不动，可能存在停滞，建议复盘调整`
    }
  } else if (goal === 'bulk') {
    if (continuous && weekly < -bulk.loss) {
      reason = `近 ${days} 天体重反向下降（周趋势 ${rate} kg），与增肌目标相反 —— 先核对这几天的记录，再决定要不要加盈余`
    } else if (continuous && weekly > bulk.fastGain) {
      reason = `近 ${days} 天增重过快（周趋势 ${rate} kg），建议控制盈余`
    } else if (Math.abs(last - first) < 0.3) {
      reason = `体重近 ${days} 天几乎不动，增肌停滞，建议复盘调整`
    }
  } else {
    if (continuous && Math.abs(weekly) > keep.swing) {
      reason = `近 ${days} 天体重波动偏大（周趋势 ${rate} kg）`
    }
  }

  return reason ? { reason } : null
}
