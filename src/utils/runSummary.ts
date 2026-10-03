/**
 * 跑步总结的派生口径（纯函数，无 store / 无 IPC）。
 *
 * 训练课总结（utils/sessionSummary）回答的是「每组练得怎么样」，
 * 跑步这一边能回答的完全不同：**配速怎么分布、爬了多少、心率如何**。
 * 原来跑步总结只有一行 `时长 · 距离 · 配速 · 大卡`，等于把一次跑步里
 * 唯一有分析价值的两个维度（分段配速与爬升）全丢了 ——
 * 而这两个恰好是「为什么这次这么快/这么慢」的唯一答案。
 *
 * 两块数据：
 *  1. **分段配速**（`buildSplits`）：逐公里。每段给配速、耗时、爬升。
 *     为什么每公里而不是每 400m：每公里是跑者唯一在表盘上能对上的刻度，
 *     400m 分段读起来像实验室数据，没人会拿它决定今天要不要加练。
 *  2. **爬升**（累计 `ascentM`）：由轨迹点的 `alt` 差分累加，**只计正增量**。
 *     为什么只计正：GPS 高程噪声 ±3m，向下也算会把平路跑出 50m 假爬升；
 *     越野跑的上坡下坡相抵是事实，累计爬升的定义就是「上坡总量」。
 *
 * 关键取舍：**手动补填距离时，分段配速整体失效**（`buildSplits` 返回空数组）。
 * 那时轨迹的累计距离与用户填的距离不一致，强行按用户值切段会给出
 * 与实际路线不符的配速 —— 那种数字比没有更糟（用户会照它调整训练）。
 * UI 上对应「配速分段不可用 · 已手动填距离」的一句说明，而不是画一张假表。
 */

import { haversineM } from './geo'
import type { RunTrackPoint } from '@/types'

export interface SplitRow {
  /** 第几公里（1-based） */
  index: number
  /** 该公里耗时（秒） */
  sec: number
  /** 该公里配速（秒/公里） */
  paceSecPerKm: number
  /** 该段爬升（米，只计正） */
  ascentM: number
}

export interface RunSummary {
  /** 逐公里分段；距离不足 1km 或无轨迹时为空数组 */
  splits: SplitRow[]
  /** 累计爬升（米）；无高程数据时 null（不是 0 —— 「没测到」与「平路」要分得开） */
  ascentM: number | null
  /**
   * 分段是否可用：false = 距离是手动补填的或轨迹不足，
   * 此时 splits 必为空。UI 据此决定「画表」还是「说一句为什么没有」。
   */
  splitsAvailable: boolean
  /** 最快的一公里（1-based）；不足 1km 时 null */
  fastestKm: SplitRow | null
  /** 最慢的一公里（1-based）；不足 1km 时 null */
  slowestKm: SplitRow | null
  /** 快慢差（秒/公里）；不足 2km 时 null —— 只跑了一公里谈不上「稳定性」 */
  paceSpread: number | null
}

/** 配速显示：秒/公里 → 「5'30"」 */
export function fmtPace(secPerKm: number): string {
  const t = Math.round(secPerKm)
  return `${Math.floor(t / 60)}'${String(t % 60).padStart(2, '0')}"`
}

/** 时长显示：秒 → 「3 分 20 秒」/「45 秒」 */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}

/** 高程噪声阈值（米）：小于它的高程变化一律当作 GPS 抖动，不计爬升 */
const ALT_NOISE_M = 3

/**
 * 轨迹点 → 逐公里分段 + 爬升。
 *
 * `manualKm != null` 表示用户手动补填了距离（跑步机 / GPS 丢失）。
 * 这时**不算分段**：轨迹累计距离与填入值对不上，切出来的配速与实际路线无关。
 */
export function buildRunSummary(
  points: RunTrackPoint[],
  opts: { manualKm?: number | null } = {},
): RunSummary {
  const { manualKm = null } = opts
  // 手动补填的场合：**高程仍可给**（爬升与距离无关），
  // 但分段配速整体作废（见文件头说明）。
  const ascent = sumAscent(points)

  if (points.length < 2 || manualKm != null) {
    return { splits: [], ascentM: ascent, splitsAvailable: false, fastestKm: null, slowestKm: null, paceSpread: null }
  }

  // 逐段累计：每经过一个整公里就切一段。
  // **t（累计运动毫秒）是可选的**（RunTrackPoint 的定义如此）——
  // 轨迹是抽稀后落盘的，个别点可能缺 t。缺 t 的点仍参与距离与爬升，
  // 但不能当切段点（那会让这一段的耗时算错）。首个有 t 的点作为起点。
  const splits: SplitRow[] = []
  let segDistM = 0
  let segAscent = 0
  let lastAlt: number | null = null
  let segStartSec: number | null = null

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const cur = points[i]!
    if (typeof prev.t === 'number' && segStartSec == null) segStartSec = prev.t
    const d = haversineM(prev.lat, prev.lon, cur.lat, cur.lon)
    if (d < 0) continue
    segDistM += d

    // 爬升只计正增量，且低于噪声阈值的跳过（否则平路会跑出几十米假爬升）
    if (typeof cur.alt === 'number') {
      if (lastAlt != null) {
        const rise = cur.alt - lastAlt
        if (rise > ALT_NOISE_M) segAscent += rise
      }
      lastAlt = cur.alt
    }

    // 凑满一公里才切；缺 t 或还没确立起点时继续攒（等下一个有 t 的切点）
    if (segDistM < 1000) continue
    if (typeof cur.t !== 'number' || segStartSec == null) continue

    const sec = (cur.t - segStartSec) / 1000
    if (sec <= 0) continue // 时序异常（补录/乱序）：不产出无意义的段
    const row: SplitRow = {
      index: splits.length + 1,
      sec: Math.round(sec),
      paceSecPerKm: sec > 0 ? Math.round((sec / segDistM) * 1000) : 0,
      ascentM: Math.round(segAscent),
    }
    splits.push(row)
    // 切段后从当前点重新起算；**累计爬升不重置**（它属于整条路线）
    segStartSec = cur.t
    segDistM = 0
    segAscent = 0
  }

  const hasFullKm = splits.length > 0
  /**
   * 最快 / 最慢：**全等速时返回 null**，不制造差异。
   *
   * `reduce` 不给初值时，全等速数组会一路返回第一项 —— 结果是
   * 「第 1 公里」同时被标成最快和最慢（踩过：等速合成轨迹上
   * fast=1 且 slow=1，叠在同一个格子上）。那样的标记是在编造信息：
   * 用户会以为第 1 公里有某种特殊性，而真相是四段一模一样。
   * 只有存在**真实差异**（最快 ≠ 最慢）才标；「相差」同理。
   */
  let fastest: SplitRow | null = null
  let slowest: SplitRow | null = null
  if (hasFullKm) {
    for (const row of splits) {
      if (fastest == null || row.paceSecPerKm < fastest.paceSecPerKm) fastest = row
      if (slowest == null || row.paceSecPerKm > slowest.paceSecPerKm) slowest = row
    }
    if (fastest && slowest && fastest.index === slowest.index) {
      fastest = null
      slowest = null
    }
  }
  return {
    splits,
    ascentM: ascent,
    // 不足一公里：没有可比的分段，同样按「不可用」处理
    splitsAvailable: hasFullKm,
    fastestKm: fastest,
    slowestKm: slowest,
    paceSpread: fastest && slowest ? slowest.paceSecPerKm - fastest.paceSecPerKm : null,
  }
}

/** 累计爬升（米）。轨迹里一个 alt 都没有时返回 null（区别于「平路 = 0」）。 */
export function sumAscent(points: RunTrackPoint[]): number | null {
  let any = false
  let sum = 0
  let last: number | null = null
  for (const p of points) {
    if (typeof p.alt !== 'number') continue
    any = true
    if (last != null) {
      const rise = p.alt - last
      if (rise > ALT_NOISE_M) sum += rise
    }
    last = p.alt
  }
  return any ? Math.round(sum) : null
}
