/**
 * 确定性动效基元。
 *
 * 视频是**逐帧截图**录出来的，所以「同一时刻必须得到同一画面」是硬约束：
 * 页面里不允许出现 CSS transition / animation（brand.css 全局关掉），
 * 数字滚动这类 anime 的 seek 不易覆盖的地方，一律用它自己的纯函数算。
 * 每个场景暴露 seek(t)，t 是**相对本场景起点的秒数**。
 */

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const clamp01 = (x) => clamp(x, 0, 1)
export const mix = (a, b, p) => a + (b - a) * p

/** 缓动族：与 tokens.css 的 --ease-* 同族，命名对齐 anime 的 ease 名。 */
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t) => 1 - (1 - t) ** 4,
  outQuint: (t) => 1 - (1 - t) ** 5,
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  outBack: (t) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
  /** 苹果那条按压弹簧的近似：过冲看得见、但不像小控件那样弹。 */
  outLiquid: (t) => {
    const c1 = 1.2
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
  outElastic: (t) => {
    if (t <= 0 || t >= 1) return t
    const c4 = (2 * Math.PI) / 3
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  },
}

/**
 * 把「秒」换成一段 [0,1] 进度。
 * @param t 场景本地时间（秒）
 * @param start 起（秒）
 * @param dur 时长（秒）
 */
export function seg(t, start, dur, easeName = 'outCubic') {
  return (ease[easeName] ?? ease.outCubic)(clamp01((t - start) / dur))
}

/**
 * 进入 → 停留 → 退出 的标准爆点节奏：每 2s 一个信息单元。
 * 返回三段各自 [0,1] 的进度，供场景自由组合（可以做位移、遮罩、缩放）。
 */
export function beat(t, { inDur = 0.5, inEase = 'outCubic', outEase = 'inCubic', tail = 0.5 } = {}) {
  const pIn = seg(t, 0, inDur, inEase)
  const pOut = seg(t, 2 - tail, tail, outEase)
  return { pIn, pOut, hold: pIn * (1 - pOut), out: pOut }
}

/** 一行元素的错峰进度表：i 是序号，返回 [0,1] 进度。 */
export function staggerAt(t, i, { start = 0, step = 0.06, dur = 0.45, ease: e = 'outCubic' } = {}) {
  return seg(t, start + i * step, dur, e)
}

/** 把进入进度写成一个可直接 Object.assign 到 el.style 的样式对象。 */
export function enter(p, { y = 24, x = 0, s = 1, blur = 0, o = 1 } = {}) {
  return {
    opacity: String(o * p),
    transform: `translate3d(${x * (1 - p)}px, ${y * (1 - p)}px, 0) scale(${mix(s, 1, p)})`,
    filter: blur ? `blur(${blur * (1 - p)}px)` : 'none',
  }
}

/** 数值滚动：p ∈ [0,1]，返回带千分位与进位的字符串。 */
export function counter(p, from, to, { decimals = 0, group = true } = {}) {
  const v = mix(from, to, clamp01(p))
  const s = v.toFixed(decimals)
  if (!group) return s
  const [int, frac] = s.split('.')
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${g}.${frac}` : g
}

/** 采样一条分段折线，用于图表 / 曲线的确定性绘制。 */
export function polyline(points, p) {
  if (points.length < 2) return points[0] ?? [0, 0]
  const total = points.length - 1
  const pos = clamp01(p) * total
  const i = Math.min(Math.floor(pos), total - 1)
  const local = pos - i
  const [x0, y0] = points[i]
  const [x1, y1] = points[i + 1]
  return [mix(x0, x1, local), mix(y0, y1, local)]
}

/** 画一条 SVG path 的确定性 d（按进度截断），points 为 [[x,y], …]。 */
export function pathD(points, p) {
  if (!points.length) return ''
  const total = points.length - 1
  const pos = clamp01(p) * total
  const end = Math.min(Math.ceil(pos), total)
  const out = [`M ${points[0][0]} ${points[0][1]}`]
  for (let i = 1; i < end; i += 1) out.push(`L ${points[i][0]} ${points[i][1]}`)
  if (end >= 1) {
    const [x, y] = points[pos < total ? end : total]
    const t = pos < total ? pos - Math.floor(pos) : 1
    const [px, py] = points[Math.max(0, end - 1)]
    out.push(`L ${mix(px, x, t)} ${mix(py, y, t)}`)
  }
  return out.join(' ')
}

/** 隐藏/显示，避免 display 切换在 seek 里被漏掉。 */
export function setVisible(el, on) {
  const v = on ? '' : 'none'
  if (el.style.display !== v) el.style.display = v
}
