import { clamp, seg } from '../lib/anim.js'
import { breathe, draw, pose, shell } from './_kit.js'
import './18-checkin.css'

/**
 * 爆点 18 · 36.0–38.0s · 自动打卡
 * 一节课块走到「已下课」，自动打勾并落一条打卡记录，撤销入口淡出。
 * 停留段：打卡勾呼吸、时钟秒针走动、记录行脉动。
 */
const pad = (n) => String(n).padStart(2, '0')

export function createScene() {
  const el = shell({
    n: 18,
    label: '自动打卡',
    inner: `
      <div class="k-wrap ck-wrap">
        <p class="k-micro">AUTO CHECK-IN · 自动打卡</p>
        <h2 class="k-title">下课那一刻，它替你打卡</h2>
        <div class="ck-stage">
          <div class="ck-clock"><span class="num ck-hh">15</span>:<span class="num ck-mm">42</span><i class="num">:</i><span class="num ck-ss">08</span></div>
          <div class="ck-course k-panel">
            <span class="k-ico ck-ico">课</span>
            <div class="ck-info"><b>计算机组成原理</b><span>14:00 – 15:40 · A-302</span></div>
            <span class="ck-state">上课中</span>
            <span class="ck-state ck-state--done">已下课</span>
            <svg class="ck-check" viewBox="0 0 34 30"><path d="M5 15 L13 23 L29 6" /></svg>
          </div>
          <div class="ck-record k-panel">
            <span class="ck-rec-ico">✓</span>
            <div class="ck-rec-txt"><b>自动打卡成功</b><span>15:40 · 计算机组成原理</span></div>
            <span class="ck-undo">撤销</span>
            <span class="ck-rec-shine"></span>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s18')

  const wrap = el.querySelector('.ck-wrap')
  const cap = el.querySelector('.beat-cap')
  const course = el.querySelector('.ck-course')
  const stateOn = el.querySelector('.ck-state:not(.ck-state--done)')
  const stateDone = el.querySelector('.ck-state--done')
  const check = el.querySelector('.ck-check path')
  const record = el.querySelector('.ck-record')
  const undo = el.querySelector('.ck-undo')
  const shine = el.querySelector('.ck-rec-shine')
  const ss = el.querySelector('.ck-ss')

  check.style.strokeDasharray = '33'

  return {
    id: '18-checkin',
    label: '自动打卡',
    at: 36,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const kc = seg(t, 0.1, 0.34, 'outCubic')
      const shift = seg(t, 0.32, 0.34, 'outBack')
      course.style.opacity = String(kc)
      course.style.transform = `translate3d(${-16 * (1 - kc) + 14 * shift}px, ${breathe(t, { amp: 3, speed: 1.9 }) - 1}px, 0)`
      course.style.boxShadow = `0 0 0 ${3 * shift}px var(--ok-soft), var(--shadow-card)`

      const kd = seg(t, 0.34, 0.2, 'outCubic')
      stateOn.style.opacity = String(1 - kd)
      stateDone.style.opacity = String(kd)
      draw(check, seg(t, 0.38, 0.24, 'outCubic'), 33)
      check.style.opacity = String(kd)

      const kr = seg(t, 0.42, 0.3, 'outCubic')
      record.style.opacity = String(kr)
      record.style.transform = `translate3d(0, ${24 * (1 - kr)}px, 0) scale(${breathe(t, { amp: 0.006, speed: 2.4 })})`

      const ku = seg(t, 0.46, 0.18) * (1 - clamp(seg(t, 1.5, 0.4)))
      undo.style.opacity = String(ku * 0.9)

      shine.style.transform = `translate3d(${(0.5 + 0.5 * Math.sin(t * 2.2)) * 110}%, 0, 0)`
      ss.textContent = pad(8 + Math.floor(t * 4) % 52)
    },
  }
}
