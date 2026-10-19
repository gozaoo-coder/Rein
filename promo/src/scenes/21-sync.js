import { pathD, polyline, seg } from '../lib/anim.js'
import { frac, pose, shell } from './_kit.js'
import './21-sync.css'

/**
 * 爆点 21 · 42.0–44.0s · 多设备同步（暗场）
 *
 * 重排（第 2 轮 blocker）：上一版最右侧那台设备是**灰骨架占位块**（三条灰条 + 一根青线），
 * 与两台真实界面完全不对等；「中转」标签飘在标题下方、和它要标注的链路相距 210px。
 *
 * 现在：三台都是**真实界面壳**（桌面 / 手机 / 平板），统一**垂直中线**对齐，
 * 于是三条链路是同一 y 上的横线 + 一条上方的「中转」弧 ——
 * 直连 → 直连 → 中转 的顺序在画面上一眼可读。连线走中性色，色相只在流动光点与锁图标上。
 */
const LINKS = [
  { key: 'd2p', tag: '直连', at: 0.14 },
  { key: 'p2t', tag: '直连', at: 0.2 },
  { key: 'd2t', tag: '中转', at: 0.26 },
]

export function createScene() {
  const el = shell({
    n: 21,
    label: '多设备同步',
    eyebrow: 'MULTI-DEVICE · 多设备同步',
    title: '三台设备，三条路，都是端到端加密',
    dark: true,
    inner: `
      <div class="sy-stage">
        <div class="sy-dev sy-desk win">
          <div class="chrome"><i></i><i></i><i></i><span>桌面</span></div>
          <div class="body"><img src="/shots/desktop-home.png" alt="" /><span class="sheen"></span></div>
        </div>

        <div class="sy-dev sy-phone phone">
          <div class="screen"><img src="/shots/mobile-home.png" alt="" /><span class="sheen"></span></div>
          <div class="notch"></div>
        </div>

        <div class="sy-dev sy-tab">
          <div class="sy-tab-screen"><img src="/shots/desktop-ledger.png" alt="" /><span class="sheen"></span></div>
        </div>

        <svg class="sy-svg">
          ${LINKS.map((l) => `<path class="sy-link" data-k="${l.key}" />`).join('')}
          ${LINKS.map((l) => `<circle class="sy-pulse" data-k="${l.key}" r="7" />`).join('')}
        </svg>

        ${LINKS.map(
          (l, i) => `
          <span class="sy-lock" data-i="${i}">
            <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.6" /><path d="M8 10V7.6a4 4 0 0 1 8 0V10" /></svg>
          </span>
          <span class="sy-tag" data-i="${i}">${l.tag}</span>`,
        ).join('')}
      </div>
    `,
  })
  el.classList.add('s21')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const stage = el.querySelector('.sy-stage')
  const svg = el.querySelector('.sy-svg')
  const dEl = el.querySelector('.sy-desk')
  const pEl = el.querySelector('.sy-phone')
  const tEl = el.querySelector('.sy-tab')
  const paths = {}
  const pulses = {}
  for (const l of LINKS) {
    paths[l.key] = el.querySelector(`.sy-link[data-k="${l.key}"]`)
    pulses[l.key] = el.querySelector(`.sy-pulse[data-k="${l.key}"]`)
  }
  const locks = [...el.querySelectorAll('.sy-lock')]
  const tags = [...el.querySelectorAll('.sy-tag')]

  let G = null
  const geom = () => {
    if (G) return G
    const st = stage.getBoundingClientRect()
    if (!st.width) return null
    const rel = (node) => {
      const r = node.getBoundingClientRect()
      return { l: r.left - st.left, t: r.top - st.top, w: r.width, h: r.height, cy: r.top - st.top + r.height / 2 }
    }
    const d = rel(dEl)
    const p = rel(pEl)
    const tb = rel(tEl)
    // 弧顶只给「中转」留出标签的高度；手机是最高的那台，弧从它上方绕过
    const apexY = Math.max(20, Math.min(d.t, p.t, tb.t) - 62)
    G = {
      d2p: [
        [d.l + d.w, d.cy],
        [p.l, p.cy],
      ],
      p2t: [
        [p.l + p.w, p.cy],
        [tb.l, tb.cy],
      ],
      d2t: [
        [d.l + d.w * 0.42, d.t],
        [(d.l + d.w * 0.42 + tb.l + tb.w * 0.58) / 2, apexY],
        [tb.l + tb.w * 0.58, tb.t],
      ],
    }
    svg.setAttribute('viewBox', `0 0 ${st.width} ${st.height}`)
    return G
  }

  return {
    id: '21-sync',
    label: '多设备同步',
    at: 42,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      const g = geom()
      if (!g) return

      ;[
        [dEl, 0.05],
        [pEl, 0.09],
        [tEl, 0.13],
      ].forEach(([node, at]) => {
        const k = seg(t, at, 0.28, 'outCubic')
        node.style.opacity = String(k)
        node.style.transform = `translate3d(0, ${26 * (1 - k)}px, 0)`
      })

      LINKS.forEach((l, i) => {
        const pts = g[l.key]
        const k = seg(t, l.at, 0.14, 'outCubic')
        paths[l.key].setAttribute('d', pathD(pts, k))

        const lit = seg(t, l.at + 0.08, 0.12, 'outCubic')
        // 「中转」的锁挂在弧的左侧肩上；两条直连的锁挂在各自连线中点
        const mid = l.key === 'd2t' ? polyline(pts, 0.3) : polyline(pts, 0.5)
        locks[i].style.transform = `translate3d(${mid[0] - 26}px, ${mid[1] - 26}px, 0) scale(${lit})`
        locks[i].style.opacity = String(seg(t, l.at + 0.06, 0.12))

        // 标签：直连贴在连线中点上方；中转**居中压在弧顶**（它就是一个节点）
        const tagAt = l.key === 'd2t' ? pts[1] : [mid[0], mid[1] - 52]
        tags[i].style.transform = `translate3d(${tagAt[0]}px, ${tagAt[1]}px, 0) translate(-50%, -50%)`
        tags[i].style.opacity = String(seg(t, 0.3, 0.14))

        // 停留段：光点沿线流动（暗场里唯一持续可见的动）
        const pp = polyline(pts, frac((t - l.at) * 0.62))
        pulses[l.key].setAttribute('cx', String(pp[0]))
        pulses[l.key].setAttribute('cy', String(pp[1]))
        pulses[l.key].style.opacity = String(0.9 * seg(t, l.at, 0.12))
      })
    },
  }
}
