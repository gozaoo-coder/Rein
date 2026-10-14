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
  // brk 点起新子路径：空窗/自动暂停处没有几何连续性，连弦等于画了一条没走过的直线
  let d = ''
  for (let i = 0; i < proj.length; i++) {
    const q = to(proj[i]!)
    d += i === 0 || sampled[i]!.brk ? ` M ${q.x} ${q.y}` : ` L ${q.x} ${q.y}`
  }
  return { d: d.trim(), start, last: to(proj[proj.length - 1]!) }
}

/* ---------- 分段配速 ---------- */

export interface TrackSplit {
  /** 展示标签：完整公里为序号「1」…，不足一公里的末段为实际距离如「0.6」 */
  label: string
  /** 该段每公里用时（秒）；末段按实际距离折算 */
  paceSec: number
  /** 该段起点在 pts 里的索引（本段从该点之后开始计量） */
  startPt: number
  /** 该段终点在 pts 里的索引 */
  endPt: number
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

/** 末段长度下限（米）：不足它并入上一段，不单列一个没有意义的短段 */
const LAST_SPLIT_MIN_M = 200

/**
 * 按公里切分轨迹推算分段配速。
 * @param totalDistanceM 记录的总距离（入账值，比轨迹沿线距离更可信）；
 *   轨迹里程按比例缩放到该总距离，使各段之和与记录一致。传 0 时直接用轨迹里程。
 *   末段不足一公里且 ≥200m 时按实际距离折算为一段。
 */
export function trackSplits(pts: RunTrackPoint[], totalDistanceM: number): TrackSplit[] | null {
  const base = timedPoints(pts)
  if (!base) return null
  const { cum, ts } = base
  const trackTotal = cum[cum.length - 1]!
  const goal = totalDistanceM > 0 ? totalDistanceM : trackTotal
  const scale = goal / trackTotal // 轨迹米 → 入账米的换算系数
  const totalTime = ts[ts.length - 1]!

  /** 距离入账口径下 d 米处对应的轨迹索引与运动时刻（毫秒），线性插值 */
  function at(m: number): { idx: number; t: number } {
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
    return { idx: i, t: ts[i - 1]! + segT * f }
  }

  const out: TrackSplit[] = []
  const fullKm = Math.floor(goal / 1000)
  let prevT = 0
  let prevIdx = 0
  for (let k = 1; k <= fullKm; k++) {
    const last = k === fullKm && fullKm * 1000 >= goal * 0.999
    const { idx, t } = last ? { idx: pts.length - 1, t: totalTime } : at(k * 1000)
    out.push({ label: String(k), paceSec: (t - prevT) / 1000, startPt: prevIdx, endPt: idx })
    prevT = t
    prevIdx = idx
  }
  const restM = goal - fullKm * 1000
  if (restM >= LAST_SPLIT_MIN_M) {
    out.push({
      label: (restM / 1000).toFixed(1),
      paceSec: (totalTime - prevT) / 1000 / (restM / 1000),
      startPt: prevIdx,
      endPt: pts.length - 1,
    })
  }
  return out.length > 0 ? out : null
}

/* ---------- 累计爬升 ---------- */

/** 高程精度门（米）：比它还差的 alt 比噪声更离谱，直接丢点 */
const ALT_ACC_MAX_M = 20
/** 采样间隔（米）：按水平距离每 50m 取一个采样点，先压掉密点噪声 */
const ASCENT_SAMPLE_M = 50
/** 中值窗半径（采样点）：前后各 2，共 5 点 */
const ASCENT_MEDIAN_RADIUS = 2
/** 迟滞阈值（米）：从当前低点回升不足它的一律算噪声（平路必须读 0） */
const ASCENT_HYSTERESIS_M = 5/** 单段弦长上限（米）：相邻有效点跳这么远，说明这段根本没有高程数据 */
const ASCENT_MAX_CHORD_M = 200
/** 有效高程点下限：点太少时任何「爬升」都只是噪声的排列组合 */
const ASCENT_MIN_VALID_PTS = 20

export interface AscentEstimate {
  /** 累计爬升（米）；一个有效海拔点都没有时为 null（「没测到」≠「平路」） */
  m: number | null
  /** 估计是否可用：有效点 ≥20 且没有 >200m 的数据断档 */
  ok: boolean
}

/**
 * 滤波后的累计爬升：丢 altAcc>20m / 缺 alt 的点 → 每 50m 重采样（首尾必留）→
 * 中值窗 5 平滑 → 迟滞 5m。
 *
 * 为什么是这四层：GPS 高程噪声可达 ±10m 量级，直接差分累加正增量会把平路
 * 跑成几十米「爬升」（历史 bug）；单靠迟滞挡不住连续同向漂移（采样+中值压幅值），
 * 单靠平滑又挡不住缓慢的噪声台阶（迟滞兜底）。断档（>200m 无点）时
 * 两端高程没有任何中间数据，ok=false 让视图说「数据不足」而不是编一个数。
 */
export function trackAscentFiltered(pts: RunTrackPoint[]): AscentEstimate {
  const valid: { alt: number; lat: number; lon: number }[] = []
  for (const p of pts) {
    if (typeof p.alt !== 'number') continue
    if (typeof p.altAcc === 'number' && p.altAcc > ALT_ACC_MAX_M) continue
    valid.push({ alt: p.alt, lat: p.lat, lon: p.lon })
  }
  if (valid.length === 0) return { m: null, ok: false }
  let maxChord = 0
  for (let i = 1; i < valid.length; i++) {
    const d = haversineM(valid[i - 1]!.lat, valid[i - 1]!.lon, valid[i]!.lat, valid[i]!.lon)
    if (d > maxChord) maxChord = d
  }
  const ok = valid.length >= ASCENT_MIN_VALID_PTS && maxChord <= ASCENT_MAX_CHORD_M

  // 按水平距离每 50m 重采样（首尾必留）：尾点丢了，缓坡的收尾会被中值窗吃掉
  // 约两个采样点的爬升 —— 一条 20m 缓坡会因此长期读成 12m 而不是 15m。
  const samples: number[] = [valid[0]!.alt]
  const lastValid = valid[valid.length - 1]!
  let acc = 0
  for (let i = 1; i < valid.length; i++) {
    acc += haversineM(valid[i - 1]!.lat, valid[i - 1]!.lon, valid[i]!.lat, valid[i]!.lon)
    if (acc >= ASCENT_SAMPLE_M && i < valid.length - 1) {
      samples.push(valid[i]!.alt)
      acc = 0
    }
  }
  if (valid.length > 1) samples.push(lastValid.alt)

  const smooth = medianWindow(samples)
  let ref = smooth[0]!
  let ascent = 0
  for (let i = 1; i < smooth.length; i++) {
    const v = smooth[i]!
    const rise = v - ref
    if (rise >= ASCENT_HYSTERESIS_M) {
      // 只记满档的 5m 整数倍：噪声尖峰过冲的那几米不记账，
      // 余量留给下一次回升（否则一次 +9m 的尖峰会把 9m 全记成爬升）。
      const steps = ASCENT_HYSTERESIS_M * Math.floor(rise / ASCENT_HYSTERESIS_M)
      ascent += steps
      ref += steps
    } else if (v < ref) {
      ref = v
    }
  }
  return { m: Math.round(ascent), ok }
}

/** 中值窗 5（半径 2，边界用可用窗口）：比均值更能压住单点跳变 */
function medianWindow(values: number[]): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - ASCENT_MEDIAN_RADIUS)
    const hi = Math.min(values.length - 1, i + ASCENT_MEDIAN_RADIUS)
    const win = values.slice(lo, hi + 1).sort((a, b) => a - b)
    const mid = win.length >> 1
    return win.length % 2 === 1 ? win[mid]! : (win[mid - 1]! + win[mid]!) / 2
  })
}

/**
 * 迟滞法估累计爬升（米）；轨迹点缺海拔或断档过大时返回 null。
 * 内部委托 trackAscentFiltered —— 详情抽屉与总结页必须同口径（旧实现各算各的，
 * 同一份轨迹会出现两个爬升值）。
 */
export function trackAscentM(pts: RunTrackPoint[]): number | null {
  const r = trackAscentFiltered(pts)
  return r.ok ? r.m : null
}

/** 沿轨迹的累计里程（米）：仅作展示参考，入账以窗口化 GPS 距离为准 */
export function trackLengthM(pts: RunTrackPoint[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) {
    sum += haversineM(pts[i - 1]!.lat, pts[i - 1]!.lon, pts[i]!.lat, pts[i]!.lon)
  }
  return sum
}
