import { clamp01, mix, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './02-timeline.css'

/**
 * 爆点 02 · 4.0–6.0s · 一条时间线
 * 一条横向时间轴从左贯到右，沿途落下 8 枚模块色点，末端一团光晕。
 * 手法：纯函数 seek —— 时间轴用 scaleX，色点用 outBack 错峰落位，另有一颗光点沿线往返。
 */
const TRACK = 1360
const MODULES = [
  { name: '饮食', color: 'var(--led-food)' },
  { name: '运动', color: 'var(--c-exercise)' },
  { name: '待办', color: 'var(--cat-general)' },
  { name: '专注', color: 'var(--cat-study)' },
  { name: '记账', color: 'var(--led-expense)' },
  { name: '课表', color: 'var(--cat-class)' },
  { name: '知识库', color: 'var(--sto-asset)' },
  { name: 'AI', color: 'var(--accent)' },
]

export function createScene() {
  const el = shell({
    n: 2,
    label: '一条时间线',
    eyebrow: 'ONE TIMELINE · 一条时间线',
    title: '所有模块，长在同一条时间线上',
    inner: `
      <div class="tl-panel k-panel">
        <div class="tl">
          <span class="tl-track"></span>
          <span class="tl-fill"></span>
          <span class="tl-head"></span>
          <span class="tl-scan"></span>
          ${MODULES.map(
            (m, i) => `
            <span class="tl-stop" style="left:${(i / (MODULES.length - 1)) * 100}%">
              <i class="tl-dot" style="background:${m.color}"></i>
              <b class="tl-name">${m.name}</b>
            </span>`,
          ).join('')}
        </div>
      </div>
    `,
  })
  el.classList.add('s02')

  const kHead = el.querySelector('.k-head')
  const kRule = el.querySelector('.k-rule')
  const panel = el.querySelector('.tl-panel')
  const fillEl = el.querySelector('.tl-fill')
  const head = el.querySelector('.tl-head')
  const scan = el.querySelector('.tl-scan')
  const stops = [...el.querySelectorAll('.tl-stop')].map((s) => ({
    dot: s.querySelector('.tl-dot'),
    name: s.querySelector('.tl-name'),
  }))

  return {
    id: '02-timeline',
    label: '一条时间线',
    at: 4,
    dur: 2,
    el,
    seek: (t) => {
      pose([kHead, kRule], t)
      pose([panel], t, { y: 24, s: 0.99 })

      const p = seg(t, 0.1, 0.48, 'outCubic')
      fillEl.style.transform = `scaleX(${p})`
      const headOp = seg(t, 0.08, 0.22)
      head.style.transform = `translate3d(${p * TRACK}px, 0, 0) scale(${breathe(t, { amp: 0.16, speed: 2.2 })})`
      head.style.opacity = String(0.9 * headOp)

      const sx = frac((t - 0.2) * 0.46) * TRACK
      scan.style.transform = `translate3d(${sx}px, 0, 0)`
      scan.style.opacity = String(0.85 * seg(t, 0.2, 0.24) * (1 - seg(t, 1.44, 0.4)))

      stops.forEach((s, i) => {
        const k = seg(t, 0.15 + i * 0.032, 0.36, 'outBack')
        const br = breathe(t, { amp: 0.06, speed: 2.3, phase: i * 0.9 })
        s.dot.style.transform = `scale(${mix(0.15, 1, k) * br})`
        s.dot.style.opacity = String(clamp01(k * 1.3))
        s.name.style.opacity = String(clamp01(k * 1.3))
        s.name.style.transform = `translate3d(0, ${mix(12, 0, k)}px, 0)`
      })
    },
  }
}
