import { clamp, mix, pathD, seg } from '../lib/anim.js'
import { frac, pose, shell } from './_kit.js'
import './11-todo.css'

/**
 * 爆点 11 · 22.0–24.0s · 待办时间线
 *
 * 重排（第 1 轮多条 major）：上一版左侧 8 个时段**全是空灰条**、右侧四象限只写了数量，
 * 整帧读起来是线框稿而不是成品海报。现在：日视图只留 5 个**有真实事项**的时段，
 * 四象限各列 1–2 条**真实待办**；从象限到时间轴的连线改成 `--accent` 细实线
 * （原来那条手绘感淡蓝虚线不在任何令牌色相内）。
 */
const SLOTS = [
  { t: '09:00', k: '晨会 · 30 分钟' },
  { t: '10:00', k: '回复产品反馈' },
  { t: '12:00', k: '午休散步 20 分钟' },
  { t: '13:00', k: '交初稿 · 今天' },
  { t: '15:00', k: '力量训练 · 上肢' },
]
const TARGET = 3
const QUADS = [
  { title: '紧急 · 重要', n: '3 项', items: ['交初稿 · 今天', '确认下周排期'] },
  { title: '重要 · 不紧急', n: '5 项', items: ['读完设计规范'] },
  { title: '紧急 · 不重要', n: '2 项', items: ['报名表签字'] },
  { title: '不紧急 · 不重要', n: '1 项', items: ['整理相册'] },
]

export function createScene() {
  const el = shell({
    n: 11,
    label: '待办时间线',
    eyebrow: 'TO-DO · 待办时间线',
    title: '四象限里的一件事，排进一天里',
    inner: `
      <div class="td-stage">
        <div class="td-panel td-left k-panel">
          <div class="td-head"><b>今天 · 日视图</b><span class="td-sub">5 个时段</span></div>
          <div class="td-rows">
            ${SLOTS.map(
              (s, i) => `
              <div class="td-row${i === TARGET ? ' is-target' : ''}">
                <span class="td-hour">${s.t}</span>
                <span class="td-slot">
                  ${i === TARGET ? '<i class="td-land"></i>' : ''}
                  <span class="td-task">${s.k}</span>
                </span>
              </div>`,
            ).join('')}
          </div>
        </div>

        <div class="td-panel td-right k-panel">
          <span class="td-sweep"></span>
          <div class="td-head"><b>四象限</b><span class="td-sub">按优先级分组</span></div>
          <div class="td-quads">
            ${QUADS.map(
              (q) => `
              <div class="td-quad">
                <b>${q.title}</b>
                ${q.items.map((it) => `<span class="td-quad-item"><i></i>${it}</span>`).join('')}
                <span class="td-quad-n">${q.n}</span>
              </div>`,
            ).join('')}
          </div>
        </div>

        <svg class="td-svg"><path class="td-arc" /></svg>
        <span class="td-chip"><i></i>交初稿 · 今天</span>
      </div>
    `,
  })
  el.classList.add('s11')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const stageEl = el.querySelector('.td-stage')
  const svg = el.querySelector('.td-svg')
  const arc = el.querySelector('.td-arc')
  const chip = el.querySelector('.td-chip')
  const quads = [...el.querySelectorAll('.td-quad')]
  const sweep = el.querySelector('.td-sweep')
  const land = el.querySelector('.td-land')
  const targetRow = el.querySelector('.td-row.is-target')

  let G = null
  const geom = () => {
    if (G) return G
    const st = stageEl.getBoundingClientRect()
    if (!st.width) return null
    const centre = (r) => [r.left - st.left + r.width / 2, r.top - st.top + r.height / 2]
    const start = centre(quads[0].getBoundingClientRect())
    const end = centre(el.querySelector('.td-row.is-target .td-slot').getBoundingClientRect())
    const ctrl = [(start[0] + end[0]) / 2, Math.min(start[1], end[1]) - 120]
    const bez = (p) => [
      mix(mix(start[0], ctrl[0], p), mix(ctrl[0], end[0], p), p),
      mix(mix(start[1], ctrl[1], p), mix(ctrl[1], end[1], p), p),
    ]
    svg.setAttribute('viewBox', `0 0 ${st.width} ${st.height}`)
    G = { bez, pts: Array.from({ length: 25 }, (_, i) => bez(i / 24)) }
    return G
  }

  return {
    id: '11-todo',
    label: '待办时间线',
    at: 22,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)

      const kl = seg(t, 0.08, 0.32, 'outCubic')
      el.querySelector('.td-left').style.opacity = String(kl)
      el.querySelector('.td-right').style.opacity = String(kl)

      const g = geom()
      if (!g) return

      quads.forEach((q, i) => {
        const k = seg(t, 0.1 + i * 0.05, 0.28, 'outCubic')
        q.style.opacity = String(k)
        q.style.transform = `translate3d(0, ${16 * (1 - k)}px, 0)`
      })

      const fp = seg(t, 0.14, 0.2, 'outCubic')
      arc.setAttribute('d', pathD(g.pts, fp))
      arc.style.opacity = String(seg(t, 0.14, 0.12))

      const [cx, cy] = g.bez(Math.min(fp, 0.995))
      chip.style.opacity = String(seg(t, 0.12, 0.1) * (1 - seg(t, 0.3, 0.12)))
      chip.style.transform = `translate3d(${cx - 130}px, ${cy - 28}px, 0)`

      const lk = seg(t, 0.32, 0.14, 'outBack')
      land.style.transform = `scaleX(${clamp(lk)})`
      land.style.opacity = String(seg(t, 0.32, 0.1))
      el.querySelector('.td-row.is-target .td-task').style.opacity = String(lk)
      targetRow.style.transform = `scale(${1 + 0.02 * Math.sin(t * 3.4)})`

      // 停留段：一道柔光沿四象限缓缓下行（可见的持续推进）
      const hl = frac((t - 0.3) * 0.45)
      sweep.style.transform = `translate3d(0, ${hl * 520}px, 0)`
      sweep.style.opacity = String(0.7 * Math.sin(hl * Math.PI))
    },
  }
}
