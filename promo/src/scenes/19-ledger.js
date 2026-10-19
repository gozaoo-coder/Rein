import { counter, seg } from '../lib/anim.js'
import { breathe, fill, pose, shell, sweep } from './_kit.js'
import './19-ledger.css'

/**
 * 爆点 19 · 38.0–40.0s · 记账
 *
 * 重排：上一版是「居中大标题 + 三列等宽白卡」，正是设计简报 §7 点名的反例，
 * 而且 5,000 − 3,224 与屏上的「剩余 1,750」对不上（差 26 元）。
 *
 * 现在只讲两件事、一个主角：
 *   左（主角）  本月预算 —— **线性进度条**（产品 LedgerStats 的真实形态，环留给分类）
 *   右（副栏）  分类占比 —— **环形图** + 带金额的图例（产品形态）
 * 账目配平：3,224 已用 + 1,776 结余 = 5,000 预算；分类占比合计 100%。
 * 趋势柱整块删除（它是第三张等权卡，也是信息密度过载的来源）。
 */
const BUDGET = 5000
const SPENT = 3224
const LEFT = BUDGET - SPENT // 1776

const CATS = [
  { name: '餐饮', v: 0.34, amount: 1096, color: 'var(--led-food)' },
  { name: '交通', v: 0.18, amount: 580, color: 'var(--led-travel)' },
  { name: '购物', v: 0.26, amount: 838, color: 'var(--led-shopping)' },
  { name: '居住', v: 0.22, amount: 710, color: 'var(--led-housing)' },
]

const SIZE = 260
const C = SIZE / 2
const R = 108
const CIRC = 2 * Math.PI * R
const TOP = CATS[0]

export function createScene() {
  const el = shell({
    n: 19,
    label: '记账',
    eyebrow: 'LEDGER · 记账',
    title: '这个月花在哪，都有数',
    zone: 'k-split',
    inner: `
      <div class="ld-hero">
        <span class="k-micro">本月预算</span>
        <div class="ld-used">
          <b class="ld-num num">¥0</b>
          <i class="ld-of num">/ ¥${BUDGET.toLocaleString()}</i>
        </div>
        <div class="k-bar ld-bar"><i></i><span class="k-sheen ld-sheen"></span></div>
        <div class="ld-foot">
          <span class="ld-foot-cell"><b class="num">¥${LEFT.toLocaleString()}</b><i>结余</i></span>
          <span class="ld-foot-cell"><b class="num">64%</b><i>占预算</i></span>
        </div>
      </div>

      <div class="ld-rail k-panel">
        <h3 class="ld-h3">分类占比</h3>
        <div class="ring ld-ring">
          <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
            <circle class="ld-track" cx="${C}" cy="${C}" r="${R}" />
            ${CATS.map((c) => `<circle class="ld-seg" cx="${C}" cy="${C}" r="${R}" stroke="${c.color}" data-v="${c.v}" />`).join('')}
          </svg>
          <div class="label col center">
            <span class="ld-top num">${Math.round(TOP.v * 100)}%</span>
            <span class="ld-top-k">${TOP.name}</span>
          </div>
        </div>
        <div class="ld-legend">
          ${CATS.map(
            (c) => `
            <div class="ld-leg-row">
              <i class="k-swatch" style="background:${c.color}"></i>
              <span class="ld-leg-name">${c.name}</span>
              <b class="ld-leg-amt num">¥${c.amount.toLocaleString()}</b>
              <b class="ld-leg-pct num">${Math.round(c.v * 100)}%</b>
            </div>`,
          ).join('')}
        </div>
      </div>
    `,
  })
  el.classList.add('s19')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const hero = el.querySelector('.ld-hero')
  const rail = el.querySelector('.ld-rail')
  const num = el.querySelector('.ld-num')
  const bar = el.querySelector('.ld-bar > i')
  const sheen = el.querySelector('.ld-sheen')
  const segs = [...el.querySelectorAll('.ld-seg')]

  segs.forEach((s) => {
    s.style.strokeDasharray = String(CIRC)
    s.style.strokeDashoffset = String(CIRC)
  })

  const starts = CATS.reduce((acc, c, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + CATS[i - 1].v)
    return acc
  }, [])

  return {
    id: '19-ledger',
    label: '记账',
    at: 38,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([hero, rail], t, { y: 22, s: 0.99 })

      const p = seg(t, 0.1, 0.36, 'outCubic')
      num.textContent = `¥${counter(p, 0, SPENT)}`
      fill(bar, p * (SPENT / BUDGET))

      segs.forEach((s, i) => {
        const k = seg(t, 0.16, 0.36, 'outCubic')
        s.style.strokeDasharray = `${CIRC * CATS[i].v * k} ${CIRC}`
        s.style.strokeDashoffset = String(-CIRC * starts[i])
      })

      // 停留段：预算条的受光扫过（确定性的）+ 环的极缓呼吸
      sweep(sheen, t, { start: 0.6, dur: 0.85, opacity: 0.75 })
      el.querySelector('.ld-ring').style.transform = `scale(${breathe(t, { amp: 0.01, speed: 2 })})`
    },
  }
}
