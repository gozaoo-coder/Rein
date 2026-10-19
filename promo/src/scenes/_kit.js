/**
 * 爆点通用基座（02–08 / 10–29 共用）。
 *
 * 纪律（见 promo/STORYBOARD.md §0）：
 *  - 确定性：全部动效在 seek(t) 里用纯函数算，写内联样式；不碰 CSS transition/animation。
 *  - 文字/数字内容一律用 lib/anim.js 的 seg/mix/counter 自己算，不指望 anime 写回 textContent。
 *  - 元素引用只用 el.querySelector，绝不使用全局选择器（30 个场景同时在 DOM 里）。
 *  - 色相只出现在图标 / 色点 / 进度条与图表 / 类型字章；数值与正文用中性色。
 *  - 字号/颜色/圆角/阴影一律 var(--*)；宽高与间距可用 px。
 *
 * 视频尺度：正文用 --fs-title1（26px），场景标题用 --fs-display-2xl（56px），
 * 主数值用 --fs-display-xl（84px）—— 全部来自令牌，不出现裸字号。
 */
import { clamp01, mix, seg } from '../lib/anim.js'
import './_kit.css'

export const pad2 = (n) => String(n).padStart(2, '0')
export const frac = (v) => v - Math.floor(v)
export const tri = (v) => 1 - Math.abs(2 * frac(v) - 1)

/**
 * 爆点外壳 —— 全片统一的「编辑版式头带 + 版心内容区 + 底栏元信息」。
 *
 *   02 ── TIMELINE · 一条时间线       ← 序号 + 短横线 + 眉标（y 固定 104）
 *   所有模块，长在同一条时间线上        ← 标题（56px，左对齐，限宽 1080）
 *   ───────────────────────────────   ← 通栏细线（y 固定 300）
 *   [ zone：本拍的版式 ]               ← 内容区（y 336 → 984，版心 1600）
 *
 * 几何由 brand.css 的 --promo-* 令牌定死：头带各行的 y、通栏线的 y、版心边距全片一致，
 * 相邻两拍因此即使内容全变也读作同一部片子（这正是「连续性靠固定框」）。
 * 内容区一律落在 zone 里 —— 元素不得越出版心。
 *
 * @param eyebrow 眉标（如 'TIMELINE · 一条时间线'），缺省用 label
 * @param title   场景标题（一行陈述句，与爆点内容对得上）
 * @param zone    追加到 .k-zone 上的版式类（k-split / k-split-r / k-ladder …）
 */
export function shell({ n, label, eyebrow = '', title = '', dark = false, grid = true, zone = '', inner = '' }) {
  const el = document.createElement('section')
  el.innerHTML = `<div class="content"><div class="k-zone${zone ? ` ${zone}` : ''}">${inner}</div></div>`
  const zoneEl = el.querySelector('.k-zone')

  // 旧写法兼容：早期场景把「眉标 + 场景标题」写在自己的内容区里
  // （<p class="k-micro"> / <h2 class="k-title">）。这里把它们**提到头带上**，
  // 于是那些还没迁移的场景也立刻用上全片统一的编辑版式 —— 不会出现「标题留在内容区、
  // 头带空着」的错位。显式传了 eyebrow/title 的场景以显式值为准。
  if (!title) {
    const t = zoneEl.querySelector('.k-title')
    if (t) {
      title = t.textContent.trim()
      t.remove()
    }
  }
  if (!eyebrow) {
    const m = zoneEl.querySelector('.k-micro')
    if (m) {
      eyebrow = m.textContent.trim()
      m.remove()
    }
  }

  el.innerHTML = `
    <div class="stage-bg${dark ? ' dark' : ''}"></div>
    ${grid ? `<div class="grid-bg${dark ? '' : ' on-light'}"></div>` : ''}
    <div class="vignette"></div>
    <div class="content">
      <header class="k-head">
        <div class="k-head-row">
          <span class="k-idx">${pad2(n)}</span>
          <span class="k-head-dash"></span>
          <span class="k-eyebrow">${eyebrow || label}</span>
        </div>
        <h2 class="k-title">${title}</h2>
      </header>
      <div class="k-rule"></div>
      <div class="k-zone${zone ? ` ${zone}` : ''}">${zoneEl.innerHTML}</div>
    </div>
    <div class="k-caption beat-cap"><b>${pad2(n)}</b><span>${label}</span></div>
  `
  if (dark) el.classList.add('k-dark')
  return el
}

/**
 * 进出场姿态：进入 0.46s → 停留 → 退出 0.46s（起于 1.54s）。
 * 进出同路径（从下方进，也从下方出），与相邻爆点的进入接力，不出现硬切。
 */
export function pose(nodes, t, o = {}) {
  const {
    inDur = 0.46,
    outStart = 1.54,
    outDur = 0.46,
    y = 26,
    x = 0,
    s = 0.985,
    easeIn = 'outCubic',
    easeOut = 'inCubic',
  } = o
  const list = Array.isArray(nodes) ? nodes : [nodes]
  const pIn = seg(t, 0, inDur, easeIn)
  const pOut = seg(t, outStart, outDur, easeOut)
  const k = 1 - pIn + pOut
  const op = clamp01(pIn * (1 - pOut))
  const sc = mix(s, 1, pIn) * mix(1, s, pOut)
  const st = `translate3d(${x * k}px, ${y * k}px, 0) scale(${sc})`
  for (const nd of list) {
    nd.style.opacity = String(op)
    nd.style.transform = st
  }
  return { pIn, pOut }
}

/** 呼吸：停留段也必须有可见的动,任何 ≥0.6s 静止都会被判不通过。 */
export function breathe(t, { amp = 0.012, speed = 2.6, phase = 0 } = {}) {
  return 1 + Math.sin(t * speed + phase) * amp
}

/** 元素级错峰入场（写内联 transform/opacity）。返回 [0,1] 进度。 */
export function rise(node, t, { start = 0.3, dur = 0.42, y = 24, s = 0.98, ease: e = 'outCubic' } = {}) {
  const p = seg(t, start, dur, e)
  node.style.opacity = String(p)
  node.style.transform = `translate3d(0, ${y * (1 - p)}px, 0) scale(${mix(s, 1, p)})`
  return p
}

/** 进度条填充：用 scaleX（不逐帧改宽度，避免重排掉帧）。 */
export function fill(node, p) {
  node.style.transform = `scaleX(${clamp01(p)})`
}

/** 声波/点阵：确定性地摆动（纯时间函数）。 */
export function wave(nodes, t, { speed = 5.4, spread = 0.55, base = 0.28, amp = 0.72, env = 1 } = {}) {
  nodes.forEach((nd, i) => {
    const v = 0.5 + 0.5 * Math.sin(t * speed + i * spread)
    const h = base + v * amp * env
    nd.style.transform = `scaleY(${clamp01(h)})`
  })
}

/** 勾选描线：node 必须已有 stroke-dasharray=len。 */
export function draw(node, p, len) {
  node.style.strokeDashoffset = String(len * (1 - clamp01(p)))
}

/**
 * 停留段的「扫光」：一道高光沿元素横越一次。
 *
 * 每个爆点在 0.5–1.5s 的停留段里必须有一处看得见的动（≥0.6s 完全静止会被审核判不通过），
 * 这是最通用的一处 —— 纯时间函数，确定性，写内联 transform/opacity。
 * 用法：元素里放 `<span class="k-sheen"></span>`（绝对定位、铺满、受光渐变、overflow 由父卡裁切），
 * 每帧 `sweep(sheenEl, t)`。
 */
export function sweep(node, t, { start = 0.62, dur = 0.9, from = -40, to = 140, opacity = 0.5, angle = 12 } = {}) {
  const p = seg(t, start, dur, 'inOutCubic')
  node.style.opacity = String(opacity * Math.sin(clamp01(p) * Math.PI))
  node.style.transform = `translate3d(${mix(from, to, p)}%, 0, 0) rotate(${angle}deg)`
  return p
}

/**
 * 停留段的「呼吸」：缓慢的缩放起伏（不改变布局，只动 transform）。
 * 与 breathe() 的区别：breathe 返回一个系数由场景自己用，pulse 直接写回节点的 transform。
 */
export function pulse(node, t, { start = 0.5, amp = 0.016, speed = 2.2, ease: e = 'outCubic' } = {}) {
  const on = seg(t, start, 0.3, e)
  const k = 1 + Math.sin(t * speed) * amp * on
  node.style.transform = `scale(${k})`
  return k
}
