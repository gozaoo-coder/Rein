import { mix, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './28-local.css'

/**
 * 爆点 28 · 56.0–58.0s · 本地优先
 * 暗场：一枚盾牌居中，四周数据点汇聚到「本机」，下方一句话。
 * 停留段：数据点继续向心微移并环绕、盾牌呼吸、涟漪一圈圈扩散。
 */
const DOTS = 28
const R0 = 430

export function createScene() {
  const el = shell({
    n: 28,
    label: '本地优先',
    eyebrow: 'LOCAL-FIRST · 本地优先',
    title: '数据只存在你的设备上',
    dark: true,
    inner: `
      <div class="lo-wrap">
        <div class="lo-stage">
          <span class="lo-ripple"></span>
          <span class="lo-ripple lo-ripple--2"></span>
          ${Array.from({ length: DOTS }, (_, i) => `<span class="lo-dot" data-i="${i}"></span>`).join('')}
          <span class="lo-core">
            <svg viewBox="0 0 48 48" class="lo-shield">
              <path d="M24 5 L40 11 V23c0 9.4-6.6 17.4-16 20-9.4-2.6-16-10.6-16-20V11z" />
              <path d="M17 23.5 L22 28.5 L32 18" />
            </svg>
            <b>本机</b>
          </span>
        </div>
      </div>
    `,
  })
  el.classList.add('s28')

  const dots = [...el.querySelectorAll('.lo-dot')]
  const ripples = [...el.querySelectorAll('.lo-ripple')]
  const core = el.querySelector('.lo-core')

  return {
    id: '28-local',
    label: '本地优先',
    at: 56,
    dur: 2,
    el,
    seek: (t) => {
      dots.forEach((d, i) => {
        const p = seg(t, 0.1 + (i % 14) * 0.02 + (i >= 14 ? 0.26 : 0), 0.9, 'outCubic')
        const ang = (i / DOTS) * Math.PI * 2 + t * 0.16
        const r = mix(R0, 62 + (i % 3) * 10, p)
        d.style.transform = `translate3d(${Math.cos(ang) * r}px, ${Math.sin(ang) * r}px, 0)`
        d.style.opacity = String(0.25 + 0.7 * p)
        d.style.background = i % 4 === 0 ? 'var(--hero-route-line)' : 'var(--c-balance)'
      })

      ripples.forEach((rp, i) => {
        const pr = frac((t - 0.2) * 0.55 + i * 0.5)
        rp.style.transform = `translate(-50%, -50%) scale(${0.2 + pr * 1.1})`
        rp.style.opacity = String(0.5 * (1 - pr))
      })

      const br = breathe(t, { amp: 0.03, speed: 2.1 })
      core.style.transform = `translate(-50%, -50%) scale(${0.9 + 0.1 * seg(t, 0.16, 0.4, 'outBack')}) scale(${br})`
      core.style.opacity = String(seg(t, 0.14, 0.4))
    },
  }
}
