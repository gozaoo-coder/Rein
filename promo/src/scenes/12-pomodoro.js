import { counter, seg } from '../lib/anim.js'
import { breathe, pose, shell } from './_kit.js'
import './12-pomodoro.css'

/**
 * 爆点 12 · 24.0–26.0s · 番茄钟
 *
 * 重排：上一版是一枚环孤零零居中，两侧全空。现在按 k-split 分成两块 ——
 * 左侧大环是主角（倒计时读数），右侧一栏「今日专注」把点阵、累计与下一段说清楚，
 * 一屏一个焦点，但不留空场。
 */
const SIZE = 520
const C = SIZE / 2
const R = 214
const CIRC = 2 * Math.PI * R
const TOTAL = 6
const DONE = 4

const pad = (n) => String(n).padStart(2, '0')
const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`

export function createScene() {
  const el = shell({
    n: 12,
    label: '番茄钟',
    eyebrow: 'FOCUS · 番茄钟',
    title: '一个番茄，二十五分钟',
    zone: 'k-split',
    inner: `
      <div class="po-hero">
        <div class="ring po-ring">
          <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
            <circle class="po-tick" cx="${C}" cy="${C}" r="${R + 34}" />
            <circle class="po-track" cx="${C}" cy="${C}" r="${R}" />
            <circle class="po-prog" cx="${C}" cy="${C}" r="${R}" />
          </svg>
          <div class="label col center">
            <span class="po-time num">25:00</span>
            <span class="po-cap">专注中</span>
          </div>
        </div>
      </div>

      <div class="po-rail k-panel">
        <h3 class="po-h3">今日专注</h3>
        <div class="po-dots">${Array.from({ length: TOTAL }, () => '<i></i>').join('')}</div>
        <p class="po-line">已完成 <b class="num">0</b> 个 · 累计 <b class="num">0</b> 分钟</p>
        <div class="po-rule"></div>
        <p class="po-line">下一段 · 休息 <b class="num">5:00</b></p>
      </div>
    `,
  })
  el.classList.add('s12')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const prog = el.querySelector('.po-prog')
  const ticks = el.querySelector('.po-tick')
  const time = el.querySelector('.po-time')
  const dots = [...el.querySelectorAll('.po-dots i')]
  const rail = el.querySelector('.po-rail')
  const doneNum = el.querySelectorAll('.po-line b')[0]
  const minsNum = el.querySelectorAll('.po-line b')[1]
  const svg = el.querySelector('.po-ring svg')

  prog.style.strokeDasharray = String(CIRC)
  prog.style.strokeDashoffset = String(CIRC)

  return {
    id: '12-pomodoro',
    label: '番茄钟',
    at: 24,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([el.querySelector('.po-hero'), rail], t, { y: 22, s: 0.99 })

      // 圆环：从满圈开始退（100% → 82%）
      const p = seg(t, 0.14, 1.6, 'linear')
      prog.style.strokeDashoffset = String(CIRC * (1 - (1 - 0.18 * p)))

      ticks.setAttribute('transform', `rotate(${(t * 7).toFixed(3)} ${C} ${C})`)

      const secs = 1500 - Math.floor(p * 47)
      time.textContent = mmss(secs)

      const litP = seg(t, 0.2, 0.3, 'outCubic')
      dots.forEach((d, i) => {
        const k = seg(t, 0.2 + i * 0.035, 0.2, 'outBack')
        const on = i < DONE ? k : 0
        const pulse = on > 0.9 ? 1 + 0.07 * Math.sin(t * 4.2 + i) : 1
        d.style.background = on > 0.4 ? 'var(--c-intake)' : 'var(--surface-3)'
        d.style.borderColor = on > 0.4 ? 'var(--c-intake)' : 'var(--line-strong)'
        d.style.transform = `scale(${(0.7 + 0.3 * on) * pulse})`
        d.style.opacity = String(0.5 + 0.5 * Math.min(1, k))
      })
      doneNum.textContent = counter(litP, 0, DONE)
      minsNum.textContent = counter(litP, 0, DONE * 25)

      svg.style.transform = `rotate(-90deg) scale(${breathe(t, { amp: 0.006, speed: 2 })})`
    },
  }
}
