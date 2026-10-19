import { clamp, counter, mix, seg } from '../lib/anim.js'
import { pose, shell } from './_kit.js'
import './09-nutrition.css'

/**
 * 爆点 09 · 18.0–20.0s · 营养
 *
 * 重排（第 2 轮 blocker）：曾经是「左三环 + 右卡」两个等重焦点，一屏讲三套结论。
 * 现在**只有一个主角**：一枚摄入环 —— 红弧 = 已吃、绿弧 = 运动加回、顶部一条目标线。
 *
 * 口径按产品（IntakeOverview）：热量上限 = 目标 2000 + 运动加回 412 = 2412；
 * 剩余可吃 = 2412 − 947 = 1465。数字只出现一次、图例不带数字、色相只在环与色点上。
 */
const TOTAL = 2000
const BURN = 412
const CEILING = TOTAL + BURN // 2412
const EATEN = 947
const LEFT = CEILING - EATEN // 1465
const TARGET_FRAC = TOTAL / CEILING // ≈ 0.829

const SIZE = 460
const C = SIZE / 2
const R = 196
const CIRC = 2 * Math.PI * R
const EAT_FRAC = EATEN / CEILING
const BURN_FRAC = BURN / CEILING
// brand.css 的 `.ring > svg` 整体转 −90°（让 <circle> 的虚线从 12 点起画），
// 所以环内画的刻度要**先补回这 90°**，否则会落在错误的角度上。
const TARGET_ANGLE = TARGET_FRAC * 360 + 90

const MACROS = [
  { name: '蛋白质', now: 62, max: 80, color: 'var(--c-protein)' },
  { name: '碳水', now: 118, max: 250, color: 'var(--c-carb)' },
  { name: '脂肪', now: 24, max: 65, color: 'var(--c-fat)' },
]

export function createScene() {
  const el = shell({
    n: 9,
    label: '营养',
    eyebrow: 'NUTRITION · 营养',
    title: '今天吃了多少，一眼看清',
    zone: 'k-split',
    inner: `
      <div class="nu-hero">
        <div class="ring nu-ring">
          <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
            <circle class="nu-track" cx="${C}" cy="${C}" r="${R}" />
            <circle class="nu-eat" cx="${C}" cy="${C}" r="${R}" />
            <circle class="nu-burn" cx="${C}" cy="${C}" r="${R}" />
            <g class="nu-mark" transform="rotate(${TARGET_ANGLE} ${C} ${C})">
              <line x1="${C}" y1="${C - R - 16}" x2="${C}" y2="${C - R + 16}" />
            </g>
          </svg>
          <div class="nu-center">
            <span class="nu-line"><b class="nu-energy num">0</b><i class="nu-of num">/ ${CEILING} 大卡</i></span>
            <span class="nu-left num">剩余可吃 ${LEFT}</span>
          </div>
        </div>
        <div class="k-legend nu-legend">
          <span><i class="k-swatch" style="background:var(--c-intake)"></i>已吃</span>
          <span><i class="k-swatch" style="background:var(--c-exercise)"></i>运动加回</span>
          <span><i class="nu-swatch-line"></i>目标线</span>
        </div>
      </div>

      <div class="nu-rail k-panel">
        <h3 class="nu-h3">今日摄入</h3>
        ${MACROS.map(
          (m) => `
          <div class="nu-row" data-k="${m.name}">
            <span class="nu-name">${m.name}</span>
            <span class="k-bar nu-bar"><i style="background:${m.color}"></i></span>
            <span class="nu-val num"><b>0</b><i> / ${m.max}g</i></span>
          </div>`,
        ).join('')}
        <p class="k-foot nu-foot">目标 ${TOTAL} + 运动加回 ${BURN} = 上限 <b>${CEILING}</b> 大卡</p>
      </div>
    `,
  })
  el.classList.add('s09')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const hero = el.querySelector('.nu-hero')
  const rail = el.querySelector('.nu-rail')
  const ring = el.querySelector('.nu-ring')
  const energy = el.querySelector('.nu-energy')

  const eatArc = el.querySelector('.nu-eat')
  const burnArc = el.querySelector('.nu-burn')
  const mark = el.querySelector('.nu-mark')

  eatArc.style.strokeDasharray = String(CIRC)
  eatArc.style.strokeDashoffset = String(CIRC)
  burnArc.style.strokeDasharray = String(CIRC)
  burnArc.style.strokeDashoffset = String(CIRC)

  const rows = MACROS.map((m) => ({
    m,
    bar: el.querySelector(`.nu-row[data-k="${m.name}"] .nu-bar > i`),
    val: el.querySelector(`.nu-row[data-k="${m.name}"] .nu-val b`),
  }))

  return {
    id: '09-nutrition',
    label: '营养',
    at: 18,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([hero, rail], t, { y: 22, s: 0.99 })

      // 红弧：已吃 / 上限
      const pe = seg(t, 0.08, 0.34, 'outCubic')
      const eatArcLen = CIRC * EAT_FRAC * pe
      eatArc.style.strokeDashoffset = String(CIRC - eatArcLen)

      // 绿弧：运动加回，紧接红弧之后（dashoffset 用负值把虚线起点推到红弧末端）
      const pb = seg(t, 0.16, 0.3, 'outCubic')
      burnArc.style.strokeDasharray = `${CIRC * BURN_FRAC * pb} ${CIRC}`
      burnArc.style.strokeDashoffset = String(-eatArcLen)

      mark.style.opacity = String(seg(t, 0.38, 0.2))

      energy.textContent = counter(seg(t, 0.1, 0.32, 'outQuart'), 0, EATEN)
      rows.forEach((r, i) => {
        const k = seg(t, 0.14 + i * 0.05, 0.26, 'outCubic')
        r.bar.style.transform = `scaleX(${mix(0, r.m.now / r.m.max, k)})`
        r.val.textContent = counter(k, 0, r.m.now)
      })

      // 停留段：环极缓呼吸 + 运动加回弧的余辉脉动（≥0.6s 静止会被判不通过）
      const glow = 0.82 + 0.18 * Math.sin((t - 0.4) * 3.2)
      burnArc.style.opacity = String(clamp(glow, 0, 1))
      ring.style.transform = `scale(${1 + 0.006 * Math.sin(t * 1.9)})`
    },
  }
}
