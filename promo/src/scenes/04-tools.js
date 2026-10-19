import { clamp, seg } from '../lib/anim.js'
import { breathe, draw, frac, fill, pose, shell } from './_kit.js'
import './04-tools.css'

/**
 * 爆点 04 · 8.0–10.0s · 工具调用
 * AI 回复下方展开三行工具卡，每行依次滑入 → 行内进度条生长 → 勾选描线。
 * 停留段：图标呼吸 + 条上高光扫过 + 末行旋转的运行态。
 */
const TOOLS = [
  { ico: '餐', color: 'var(--led-food)', title: '记一餐', meta: '午餐 · 番茄牛腩盖饭 · 612 kcal', state: '已记录' },
  { ico: '账', color: 'var(--led-expense)', title: '记一笔账', meta: '餐饮 · −32.00', state: '已记录' },
  { ico: '日', color: 'var(--accent)', title: '排日程', meta: '明天 9:30 组会 · 加入日历', state: '已排入' },
]

const CHECK_LEN = 28

export function createScene() {
  const el = shell({
    n: 4,
    label: '工具调用',
    inner: `
      <div class="k-wrap t-wrap">
        <p class="k-micro">TOOL CALLS · 工具调用</p>
        <h2 class="k-title">它不只回答，还会动手</h2>
        <div class="say k-panel">
          <span class="avatar">R</span>
          <p>收到，这就去办 ——</p>
        </div>
        <div class="tools">
          ${TOOLS.map(
            (tl) => `
            <div class="tool">
              <span class="k-ico tool-ico" style="background:${tl.color}">${tl.ico}</span>
              <div class="tool-main">
                <div class="tool-head"><b>${tl.title}</b><span class="tool-meta">${tl.meta}</span></div>
                <div class="k-bar tool-bar"><i style="background:${tl.color}"></i><b class="shine"></b></div>
              </div>
              <div class="tool-end">
                <span class="tool-spin"></span>
                <svg class="tool-check" viewBox="0 0 30 26"><path d="M4 13 L11 20 L26 5" /></svg>
                <span class="tool-state">${tl.state}</span>
              </div>
            </div>`,
          ).join('')}
        </div>
      </div>
    `,
  })
  el.classList.add('s04')

  const wrap = el.querySelector('.t-wrap')
  const cap = el.querySelector('.beat-cap')
  const say = el.querySelector('.say')
  const rows = [...el.querySelectorAll('.tool')].map((r) => ({
    row: r,
    ico: r.querySelector('.tool-ico'),
    bar: r.querySelector('.tool-bar > i'),
    shine: r.querySelector('.shine'),
    check: r.querySelector('.tool-check path'),
    state: r.querySelector('.tool-state'),
    spin: r.querySelector('.tool-spin'),
  }))
  rows.forEach((r) => {
    r.check.style.strokeDasharray = String(CHECK_LEN)
  })

  return {
    id: '04-tools',
    label: '工具调用',
    at: 8,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const ks = seg(t, 0.12, 0.36, 'outBack')
      say.style.opacity = String(clamp(ks * 1.2))
      say.style.transform = `translate3d(0, ${-18 * (1 - ks)}px, 0) scale(${0.96 + 0.04 * ks})`

      rows.forEach((r, i) => {
        const k = seg(t, 0.2 + i * 0.1, 0.36, 'outCubic')
        r.row.style.opacity = String(k)
        r.row.style.transform = `translate3d(${26 * (1 - k)}px, 0, 0)`
        r.ico.style.transform = `scale(${0.8 + 0.2 * k})`

        fill(r.bar, seg(t, 0.3 + i * 0.1, 0.4, 'outCubic'))
        r.shine.style.transform = `translate3d(${frac(t * 0.5 + i * 0.3) * 240 - 60}%, 0, 0)`

        // 状态位**二选一**：不出现「半环 spinner + 已完成尖角勾」并存的一行
        // （第 1 轮审核：这一行到底做完没有，一眼读不出）。三行都以完成态收尾。
        draw(r.check, seg(t, 0.36 + i * 0.08, 0.2, 'outCubic'), CHECK_LEN)
        r.state.style.opacity = String(seg(t, 0.44 + i * 0.08, 0.18))
        r.spin.style.opacity = '0'
      })

      const ib = breathe(t, { amp: 0.04, speed: 2.6 })
      rows.forEach((r, i) => {
        r.ico.style.transform += ` scale(${1 + (ib - 1) * (1 + i * 0.3)})`
      })
    },
  }
}
