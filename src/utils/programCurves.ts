/**
 * 档位科学依据：训练频次 / 睡眠时长 / 社交时差 三条研究曲线。
 *
 * 定位：这些数值是运动医学与睡眠科学综述的**标准化图示**（相对增长 0-100），
 * 不落库、不参与方案计算，只用于在 setup 阶段向用户解释频次/睡眠/作息的依据。
 * 真正的方案参数仍由 programEngine 的 TIER_SPECS 决定——
 * 这里只是把已有的档位差异翻译成人能看懂的证据。
 *
 * 因此本文件是纯数据 + 纯函数：无 IPC、无 store 依赖，可独立测试。
 */

import type { ProgramTier } from '@/types'

/** 曲线上的一个采样点（横轴值 + 两项相对增长） */
export interface CurvePoint {
  /** 横轴值：训练次数 / 睡眠小时 / 社交时差小时 */
  x: number
  /** 力量相对增长 0-100 */
  strength: number
  /** 肌肉相对增长 0-100 */
  muscle: number
}

/** 曲线背景分区（图上色带与图例共用） */
export interface CurveBand {
  from: number
  to: number
  label: string
  /** 语义：best=最佳窗口 / good=可接受 / warn=递减或抵抗 / risk=明确损害 */
  tone: 'best' | 'good' | 'warn' | 'risk'
}

/** 曲线的完整定义 */
export interface CurveSpec {
  key: string
  title: string
  /** 横轴单位说明 */
  axisLabel: string
  /** 横轴刻度值 */
  ticks: number[]
  points: CurvePoint[]
  bands: CurveBand[]
  /** 图上额外竖线标记（如「2h 抑制阈值」） */
  markers?: { at: number; label: string }[]
  conclusion: string
}

/* ---------------- 一、训练频次 ---------------- */

/**
 * 关键形态：力量在 4-5 次接近平台（4 次 98、5 次 100，仅 +2），
 * 肌肉在 4 次达峰（84）后因恢复不足回落（5 次 80）。
 * 注意横轴是「同一肌群每周被练到的次数」——文献里的频次均指此定义；
 * 「每周去几次健身房」只是它的间接变量，分化安排（全身/上下/推拉腿）
 * 决定了每次去健身房时各肌群轮到几次。
 */
const FREQ_POINTS: CurvePoint[] = [
  { x: 0, strength: 0, muscle: 0 },
  { x: 1, strength: 47, muscle: 38 },
  { x: 2, strength: 72, muscle: 58 },
  { x: 3, strength: 85, muscle: 68 },
  { x: 4, strength: 98, muscle: 84 },
  { x: 5, strength: 100, muscle: 80 },
  { x: 6, strength: 97, muscle: 74 },
  { x: 7, strength: 93, muscle: 67 },
]

export const FREQ_CURVE: CurveSpec = {
  key: 'freq',
  title: '每个肌群一周练几次最划算？',
  axisLabel: '同一肌群 · 次 / 周',
  ticks: [0, 1, 2, 3, 4, 5, 6, 7],
  points: FREQ_POINTS,
  bands: [
    { from: 0, to: 2, label: '起始增益', tone: 'good' },
    { from: 2, to: 4, label: '最佳窗口', tone: 'best' },
    { from: 4, to: 5, label: '边际递减', tone: 'warn' },
    { from: 5, to: 7, label: '恢复不足风险', tone: 'risk' },
  ],
  conclusion:
    '文献中的「最佳频次 2~3 次/周」指同一肌群每周被直接练到的次数，不是一周去几次健身房。方案用分化保证它：全身×3、上下×2、推拉腿混排，每个大肌群每周都 ≥2 次；档位差异体现在热量与餐次结构上。',
}

/* ---------------- 二、睡眠时长 ---------------- */

/**
 * 关键形态：7-8h 为黄金窗口，8h 达峰；< 6h 进入合成代谢抵抗；
 * > 9h 出现 U 型右端回落（过长睡眠同样不利于恢复）。
 */
const SLEEP_POINTS: CurvePoint[] = [
  { x: 4, strength: 0, muscle: 0 },
  { x: 5, strength: 20, muscle: 15 },
  { x: 6, strength: 52, muscle: 38 },
  { x: 7, strength: 85, muscle: 65 },
  { x: 8, strength: 100, muscle: 85 },
  { x: 9, strength: 88, muscle: 72 },
  { x: 10, strength: 60, muscle: 52 },
  { x: 11, strength: 25, muscle: 18 },
]

export const SLEEP_CURVE: CurveSpec = {
  key: 'sleep',
  title: '每晚睡几小时最有利于练？',
  axisLabel: '小时 / 晚',
  ticks: [4, 5, 6, 7, 8, 9, 10, 11],
  points: SLEEP_POINTS,
  bands: [
    { from: 4, to: 5, label: '严重剥夺', tone: 'risk' },
    { from: 5, to: 6, label: '合成代谢抵抗', tone: 'warn' },
    { from: 7, to: 8, label: '黄金窗口', tone: 'best' },
    { from: 9, to: 11, label: '过长风险', tone: 'warn' },
  ],
  markers: [{ at: 8, label: '峰值' }],
  conclusion:
    '睡眠不足会直接压低训练收益：5h 时力量增长只有峰值的 20%，6h 也只有 52%。反过来睡太久（10h+）同样回落——这是 U 型曲线，不是「越多越好」。',
}

/* ---------------- 三、社交时差 ---------------- */

/**
 * 社交时差 = 工作日与休息日的「睡眠中点」之差。
 * 关键形态：≤1h 几乎无损失，2h 是抑制阈值（力量掉到 75、肌肉 60），
 * 3h 起进入显著损害区。
 */
const JETLAG_POINTS: CurvePoint[] = [
  { x: 0, strength: 100, muscle: 100 },
  { x: 1, strength: 98, muscle: 90 },
  { x: 2, strength: 75, muscle: 60 },
  { x: 3, strength: 30, muscle: 18 },
  { x: 4, strength: 5, muscle: 2 },
  { x: 5, strength: 0, muscle: 0 },
  { x: 6, strength: 0, muscle: 0 },
  { x: 7, strength: 0, muscle: 0 },
]

export const JETLAG_CURVE: CurveSpec = {
  key: 'jetlag',
  title: '睡眠规律性有多重要？',
  axisLabel: '时差 / 小时',
  ticks: [0, 1, 2, 3, 4, 5, 6, 7],
  points: JETLAG_POINTS,
  bands: [
    { from: 0, to: 1, label: '黄金（规律）', tone: 'best' },
    { from: 1, to: 2, label: '轻度偏移', tone: 'good' },
    { from: 2, to: 3, label: '中度失调', tone: 'warn' },
    { from: 3, to: 7, label: '显著损害', tone: 'risk' },
  ],
  markers: [{ at: 2, label: '抑制阈值' }],
  conclusion:
    '规律性比总时长更容易被忽视：即便每天睡够 8 小时，工作日与周末作息相差 2 小时，力量增长也会掉四分之一。高频方案对规律性的依赖更强。',
}

export const CURVES: CurveSpec[] = [FREQ_CURVE, SLEEP_CURVE, JETLAG_CURVE]

/* ---------------- 查询函数 ---------------- */

/**
 * 在曲线上按横轴值线性插值取值；超出范围时钳到端点（不抛错）。
 * 用于把用户的实际数据（如「每周练 3.5 次」）落到曲线上。
 */
export function sampleCurve(curve: CurveSpec, x: number): { strength: number; muscle: number } {
  const pts = curve.points
  if (pts.length === 0) return { strength: 0, muscle: 0 }
  if (x <= pts[0]!.x) return { strength: pts[0]!.strength, muscle: pts[0]!.muscle }
  const last = pts[pts.length - 1]!
  if (x >= last.x) return { strength: last.strength, muscle: last.muscle }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    if (x >= a.x && x <= b.x) {
      const span = b.x - a.x
      const t = span === 0 ? 0 : (x - a.x) / span
      return {
        strength: Math.round(a.strength + (b.strength - a.strength) * t),
        muscle: Math.round(a.muscle + (b.muscle - a.muscle) * t),
      }
    }
  }
  return { strength: last.strength, muscle: last.muscle }
}

/** 各档位对社交时差的耐受上限（小时）：频次越高，对规律性依赖越强 */
export const TIER_JETLAG_TOLERANCE: Record<ProgramTier, number> = {
  conservative: 2.5,
  balanced: 1.5,
  aggressive: 1.0,
}


/* ---------------- SVG 绘制辅助（与具体组件解耦） ---------------- */

export interface PlotBox {
  left: number
  top: number
  width: number
  height: number
}

export interface PlotAxis {
  xMin: number
  xMax: number
  /** 纵轴满值（默认 100） */
  yMax?: number
}

/** 横轴值 → 画布 x 坐标 */
export function toX(plot: PlotBox, axis: PlotAxis, x: number): number {
  const span = axis.xMax - axis.xMin
  const t = span === 0 ? 0 : (x - axis.xMin) / span
  return plot.left + t * plot.width
}

/** 数值 → 画布 y 坐标（0 在底部） */
export function toY(plot: PlotBox, yMax: number, v: number): number {
  const t = yMax === 0 ? 0 : Math.min(v / yMax, 1)
  return plot.top + (1 - t) * plot.height
}

/** 把曲线某一项映射成 SVG polyline 的 points 字符串 */
export function polylinePoints(
  curve: CurveSpec,
  plot: PlotBox,
  axis: PlotAxis,
  key: 'strength' | 'muscle',
): string {
  const yMax = axis.yMax ?? 100
  return curve.points
    .map((p) => `${toX(plot, axis, p.x).toFixed(1)},${toY(plot, yMax, p[key]).toFixed(1)}`)
    .join(' ')
}
