import { counter, pathD, polyline, seg } from '../lib/anim.js'
import { pose, shell } from './_kit.js'
import './13-run.css'

/**
 * 爆点 13 · 26.0–28.0s · 运动（暗场）
 *
 * 重排（第 1 轮三条 major）：上一版是纯黑底 + 大面积荧光绿辉光折线，
 * 观感偏电竞，且**画了两条几乎同形的绿线**（一条带渐变填充、一条带发光端点）没有图例。
 *
 * 现在：曲线收进一块 --hero-bg 深色玻璃面板里，辉光大幅收敛，只留**一条**配速曲线
 * 加一条面积底，并补上纵向网格与配速刻度 —— 读者能真的读出「配速」这件事。
 */
const W = 1020
const H = 540
const PAD = { l: 86, r: 34, t: 34, b: 58 }
const PLOT_W = W - PAD.l - PAD.r
const PLOT_H = H - PAD.t - PAD.b

// 归一化配速（0 = 最快，1 = 最慢）
const SERIES = [0.62, 0.5, 0.56, 0.38, 0.44, 0.3, 0.36, 0.22, 0.3, 0.14, 0.2, 0.1]
const PTS = SERIES.map((v, i) => [PAD.l + (i / (SERIES.length - 1)) * PLOT_W, PAD.t + v * PLOT_H])
const TICKS = [
  { v: 0, label: '5:00' },
  { v: 0.32, label: '5:20' },
  { v: 0.64, label: '5:40' },
  { v: 1, label: '6:00' },
]
const KM = ['0', '1', '2', '3', '4', '5', '6']

export function createScene() {
  const el = shell({
    n: 13,
    label: '运动',
    eyebrow: 'RUN · 运动',
    title: '今天的配速',
    dark: true,
    zone: 'k-split-r',
    inner: `
      <div class="run-rail k-panel">
        <div class="run-pace"><b class="k-num k-on-dark">5:12</b><span class="run-unit">/km</span></div>
        <div class="run-stats">
          <div><b class="num">6.4</b><span>公里</span></div>
          <div><b class="num">33:20</b><span>时长</span></div>
        </div>
        <div class="run-met">
          <span class="run-met-ico">M</span>
          <div><b class="num">0</b><span>MET 消耗</span></div>
        </div>
      </div>

      <div class="run-chart k-panel">
        <svg class="run-svg" viewBox="0 0 ${W} ${H}">
          <defs>
            <linearGradient id="runArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style="stop-color: var(--hero-route-line); stop-opacity: 0.26" />
              <stop offset="100%" style="stop-color: var(--hero-route-line); stop-opacity: 0" />
            </linearGradient>
          </defs>

          ${TICKS.map(
            (tk) => `<line class="run-grid" x1="${PAD.l}" y1="${PAD.t + tk.v * PLOT_H}" x2="${W - PAD.r}" y2="${PAD.t + tk.v * PLOT_H}" />`,
          ).join('')}
          ${KM.map((m, i) => {
            const x = PAD.l + (i / (KM.length - 1)) * PLOT_W
            return `<line class="run-grid run-grid--v" x1="${x}" y1="${PAD.t}" x2="${x}" y2="${H - PAD.b}" />`
          }).join('')}

          ${TICKS.map((tk) => `<text class="run-ytick" x="${PAD.l - 18}" y="${PAD.t + tk.v * PLOT_H + 6}">${tk.label}</text>`).join('')}
          ${KM.map((m, i) => {
            const x = PAD.l + (i / (KM.length - 1)) * PLOT_W
            return `<text class="run-xtick" x="${x}" y="${H - PAD.b + 30}">${m}</text>`
          }).join('')}

          <path class="run-area" d="" />
          <path class="run-curve" d="" />
          <circle class="run-pace-dot" r="9" cx="0" cy="0" />
        </svg>
        <span class="run-axis-label">配速 / 公里</span>
      </div>
    `,
  })
  el.classList.add('s13')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const rail = el.querySelector('.run-rail')
  const chart = el.querySelector('.run-chart')
  const area = el.querySelector('.run-area')
  const curve = el.querySelector('.run-curve')
  const dot = el.querySelector('.run-pace-dot')
  const met = el.querySelector('.run-met b')

  const areaD = (p) => {
    const upto = PTS.filter((_, i) => i / (PTS.length - 1) <= p + 1e-6)
    if (upto.length < 2) return ''
    const xs = upto.map(([x]) => x)
    const left = xs[0]
    const right = polyline(PTS, p)[0]
    const body = upto.map(([x, y]) => `L ${x} ${y}`).join(' ')
    return `M ${left} ${H - PAD.b} ${body} L ${right} ${H - PAD.b} Z`
  }

  return {
    id: '13-run',
    label: '运动',
    at: 26,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([rail, chart], t, { y: 22, s: 0.99 })

      const kc = seg(t, 0.12, 0.4, 'outCubic')
      curve.setAttribute('d', pathD(PTS, kc))
      area.setAttribute('d', areaD(kc))
      area.style.opacity = String(0.85 * kc)

      const pc = polyline(PTS, kc)
      dot.setAttribute('cx', String(pc[0]))
      dot.setAttribute('cy', String(pc[1]))
      dot.setAttribute('r', String(9 * (1 + 0.18 * Math.sin(t * 3.4))))

      met.textContent = counter(seg(t, 0.34, 0.34, 'outQuart'), 0, 8.6, { decimals: 1 })
    },
  }
}
