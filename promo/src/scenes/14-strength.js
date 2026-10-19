import { clamp, mix, seg } from '../lib/anim.js'
import { breathe, pose, shell } from './_kit.js'
import './14-strength.css'

/**
 * 爆点 14 · 28.0–30.0s · 力量训练
 * 做组界面：重量 / 次数步进跳变，组间休息环收缩倒计时，组格一格一格点亮。
 * 停留段：休息环继续收缩、秒数走动、已完成的组格脉动。
 */
const SIZE = 280
const C = SIZE / 2
const R = 108
const CIRC = 2 * Math.PI * R
const SETS = 4

const pad = (n) => String(n).padStart(2, '0')

export function createScene() {
  const el = shell({
    n: 14,
    label: '力量训练',
    inner: `
      <div class="k-wrap st-wrap">
        <p class="k-micro">STRENGTH · 力量训练</p>
        <h2 class="k-title">一组一组，练到该练的量</h2>
        <div class="st-card k-panel">
          <div class="st-left">
            <div class="st-ex">
              <span class="k-ico st-ico">推</span>
              <div><b>杠铃卧推</b><span class="st-ex-sub">胸 · 三头 · 第 3 组</span></div>
            </div>
            <div class="st-steps">
              <div class="st-step">
                <span class="st-label">重量</span>
                <span class="st-ctrl"><i>−</i><b class="st-weight num">55</b><em>kg</em><i>+</i></span>
              </div>
              <div class="st-step">
                <span class="st-label">次数</span>
                <span class="st-ctrl"><i>−</i><b class="st-reps num">6</b><em>次</em><i>+</i></span>
              </div>
            </div>
            <span class="st-done-chip">已完成本组</span>
          </div>
          <div class="st-right">
            <div class="ring st-ring">
              <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
                <circle class="st-track" cx="${C}" cy="${C}" r="${R}" />
                <circle class="st-rest" cx="${C}" cy="${C}" r="${R}" />
              </svg>
              <div class="label col center">
                <span class="st-rest-t num">90</span>
                <span class="st-rest-cap">组间休息</span>
              </div>
            </div>
            <div class="st-sets">
              ${Array.from({ length: SETS }, (_, i) => `<span class="st-cell" data-i="${i}"><b>${i + 1}</b><svg viewBox="0 0 30 26"><path d="M4 13 L11 20 L26 5" /></svg></span>`).join('')}
            </div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s14')

  const wrap = el.querySelector('.st-wrap')
  const cap = el.querySelector('.beat-cap')
  const rest = el.querySelector('.st-rest')
  const restT = el.querySelector('.st-rest-t')
  const weight = el.querySelector('.st-weight')
  const reps = el.querySelector('.st-reps')
  const cells = [...el.querySelectorAll('.st-cell')]
  const checks = cells.map((c) => c.querySelector('path'))
  const ringSvg = el.querySelector('.st-ring svg')

  rest.style.strokeDasharray = String(CIRC)
  checks.forEach((p) => {
    p.style.strokeDasharray = '28'
  })

  return {
    id: '14-strength',
    label: '力量训练',
    at: 28,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      // 步进跳变：离散值，读出来就是"一格一格跳"
      const kw = seg(t, 0.18, 0.5, 'outCubic')
      weight.textContent = String(55 + Math.floor(kw * 5 + 1e-6))
      const kr = seg(t, 0.26, 0.5, 'outCubic')
      reps.textContent = String(6 + Math.floor(kr * 2 + 1e-6))

      // 休息环：90s → 55s 收缩
      const p = seg(t, 0.24, 1.5, 'linear')
      rest.style.strokeDashoffset = String(CIRC * (1 - (1 - 0.4 * p)))
      restT.textContent = pad(90 - Math.floor(p * 35))
      ringSvg.style.transform = `rotate(-90deg) scale(${breathe(t, { amp: 0.008, speed: 2.2 })})`

      cells.forEach((cell, i) => {
        const k = seg(t, 0.42 + i * 0.1, 0.28, 'outCubic')
        const pulse = k > 0.5 ? 1 + 0.05 * Math.sin(t * 4 + i) : 1
        cell.style.opacity = String(0.55 + 0.45 * k)
        cell.style.transform = `scale(${mix(0.9, 1, k) * pulse})`
        cell.style.background = k > 0.5 ? 'var(--c-exercise-soft)' : 'var(--surface-2)'
        const ck = seg(t, 0.58 + i * 0.1, 0.2, 'outCubic')
        checks[i].style.strokeDashoffset = String(28 * (1 - clamp(ck)))
      })
    },
  }
}
