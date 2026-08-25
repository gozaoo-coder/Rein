/**
 * 轨迹几何工具：投影描线、按时间戳推每公里分段配速、GPS 海拔估累计爬升。
 * 供跑步沉浸页（实时轨迹）与运动详情抽屉（历史快照）共用。
 */

import type { RunTrackPoint } from '@/types'

/** 两点球面距离（米） */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/* ---------- 轨迹投影：经纬度 → SVG 视口（等距圆柱近似 + 等比缩放居中） ---------- */

export interface ProjectedPt {
  x: number
  y: number
}

export interface ProjectedRoute {
  /** 完整 path 的 d 属性；单点或空轨迹为 null */
  d: string | null
  start: ProjectedPt | null
  last: ProjectedPt | null
}

/** 抽稀上限：长轨迹保持渲染轻量 */
const MAX_RENDER_POINTS = 400

export function projectTrack(
  pts: RunTrackPoint[],
  viewW: number,
  viewH: number,
  pad: number,
): ProjectedRoute {
  if (pts.length === 0) return { d: null, start: null, last: null }
  const center = { x: viewW / 2, y: viewH / 2 }
  if (pts.length === 1) return { d: null, start: center, last: center }
  const step = Math.max(1, Math.ceil(pts.length / MAX_RENDER_POINTS))
  const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
  const midLat = sampled.reduce((sum, p) => sum + p.lat, 0) / sampled.length
  const kx = Math.cos((midLat * Math.PI) / 180)
  const proj = sampled.map((p) => ({ x: p.lon * kx, y: -p.lat }))
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of proj) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const spanX = Math.max(1e-9, maxX - minX)
  const spanY = Math.max(1e-9, maxY - minY)
  const scale = Math.min((viewW - pad * 2) / spanX, (viewH - pad * 2) / spanY)
  const offX = (viewW - spanX * scale) / 2
  const offY = (viewH - spanY * scale) / 2
  const to = (p: { x: number; y: number }): ProjectedPt => ({
    x: Math.round((offX + (p.x - minX) * scale) * 10) / 10,
    y: Math.round((offY + (p.y - minY) * scale) * 10) / 10,
  })
  const start = to(proj[0]!)
  let d = `M ${start.x} ${start.y}`
  for (let i = 1; i < proj.length; i++) {
    const q = to(proj[i]!)
    d += ` L ${q.x} ${q.y}`
  }
  return { d, start, last: to(proj[proj.length - 1]!) }
}

/* ---------- 分段配速 ---------- */

export interface TrackSplit {
  /** 展示标签：完整公里为序号「1」…，不足一公里的末段为实际距离如「0.6」 */
  label: string
  /** 该段每公里用时（秒）；末段按实际距离折算 */
  paceSec: number
}

/** 轨迹沿线的累计距离与时刻插值需要的时间戳；缺失时无法分段 */
function timedPoints(pts: RunTrackPoint[]): { cum: number[]; ts: number[] } | null {
  if (pts.length < 2) return null
  const cum: number[] = [0]
  const ts: number[] = []
  for (const p of pts) {
    if (typeof p.t !== 'number') return null
    ts.push(p.t)
  }
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + haversineM(pts[i - 1]!.lat, pts[i - 1]!.lon, pts[i]!.lat, pts[i]!.lon))
  }
  // 时间必须单调不减（暂停恢复后仍成立）
  for (let i = 1; i < ts.length; i++) if (ts[i]! < ts[i - 1]!) ts[i] = ts[i - 1]!
  if (cum[cum.length - 1]! <= 0 || ts[ts.length - 1]! <= 0) return null
  return { cum, ts }
}

/**
 * 按公里切分轨迹推算分段配速。
 * @param totalDistanceM 记录的总距离（入账值，比轨迹沿线距离更可信）；
 *   轨迹里程按比例缩放到该总距离，使各段之和与记录一致。传 0 时直接用轨迹里程。
 *   末段不足一公里且 ≥250m 时按实际距离折算为一段。
 */
export function trackSplits(pts: RunTrackPoint[], totalDistanceM: number): TrackSplit[] | null {
  const base = timedPoints(pts)
  if (!base) return null
  const { cum, ts } = base
  const trackTotal = cum[cum.length - 1]!
  const goal = totalDistanceM > 0 ? totalDistanceM : trackTotal
  const scale = goal / trackTotal // 轨迹米 → 入账米的换算系数
  const totalTime = ts[ts.length - 1]!

  /** 距离入账口径下 d 米处对应的运动时刻（毫秒），线性插值 */
  function timeAt(m: number): number {
    const target = m / scale
    // 二分找第一个 cum[i] >= target 的段
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! < target) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const segD = cum[i]! - cum[i - 1]!
    const segT = ts[i]! - ts[i - 1]!
    const f = segD > 0 ? Math.min(1, Math.max(0, (target - cum[i - 1]!) / segD)) : 0
    return ts[i - 1]! + segT * f
  }

  const out: TrackSplit[] = []
  const fullKm = Math.floor(goal / 1000)
  let prevT = 0
  for (let k = 1; k <= fullKm; k++) {
    const t = k === fullKm && fullKm * 1000 >= goal * 0.999 ? totalTime : timeAt(k * 1000)
    out.push({ label: String(k), paceSec: (t - prevT) / 1000 })
    prevT = t
  }
  const restM = goal - fullKm * 1000
  if (restM >= 250) {
    out.push({ label: (restM / 1000).toFixed(1), paceSec: (totalTime - prevT) / 1000 / (restM / 1000) })
  }
  return out.length > 0 ? out : null
}

/* ---------- 累计爬升 ---------- */

/** GPS 海拔噪声大：只有从当前低点回升超过该阈值才计为爬升（迟滞滤波） */
const ASCENT_HYSTERESIS_M = 2

/** 迟滞法估累计爬升（米）；轨迹点缺海拔时返回 null */
export function trackAscentM(pts: RunTrackPoint[]): number | null {
  let ref: number | null = null
  let ascent = 0
  for (const p of pts) {
    if (typeof p.alt !== 'number') continue
    if (ref == null) {
      ref = p.alt
      continue
    }
    if (p.alt - ref >= ASCENT_HYSTERESIS_M) {
      ascent += p.alt - ref
      ref = p.alt
    } else if (p.alt < ref) {
      ref = p.alt
    }
  }
  return ref == null ? null : Math.round(ascent)
}

/** 沿轨迹的累计里程（米）：仅作展示参考，入账以窗口化 GPS 距离为准 */
export function trackLengthM(pts: RunTrackPoint[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) {
    sum += haversineM(pts[i - 1]!.lat, pts[i - 1]!.lon, pts[i]!.lat, pts[i]!.lon)
  }
  return sum
}
