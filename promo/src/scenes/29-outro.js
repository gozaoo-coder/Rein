import { clamp, mix, seg } from '../lib/anim.js'
import { breathe, frac, pose, rise, shell } from './_kit.js'
import './29-outro.css'

/**
 * 爆点 29 · 58.0–60.0s · 收尾
 * 回到品牌：标记 + Rein + 一句话 + 下载提示，整体缓慢推近后定住。
 * 停留段：推近仍在继续（速度放缓）、光晕一圈圈扩散、文案轻微呼吸。
 */
export function createScene() {
  const el = shell({
    n: 29,
    label: '收尾',
    inner: `
      <div class="k-wrap br-wrap">
        <div class="br-inner">
          <span class="br-halo"></span>
          <div class="br-mark">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M14 10h11.5c5.2 0 8.5 3 8.5 7.6 0 3.4-1.7 5.9-4.7 6.9L36.5 38h-6.3l-6.1-12.3h-4.2V38H14V10zm5.9 4.9v5.9h5c2.2 0 3.6-1.1 3.6-2.9 0-1.9-1.4-3-3.6-3h-5z" />
            </svg>
          </div>
          <h1 class="br-name">Rein</h1>
          <p class="br-tag">全能生活助理 · 单机优先</p>
          <div class="br-hint">
            <span class="br-pill"><i></i>下载 · Windows / Android</span>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s29')

  const wrap = el.querySelector('.br-wrap')
  const cap = el.querySelector('.beat-cap')
  const inner = el.querySelector('.br-inner')
  const mark = el.querySelector('.br-mark')
  const halo = el.querySelector('.br-halo')
  const name = el.querySelector('.br-name')
  const tag = el.querySelector('.br-tag')
  const hint = el.querySelector('.br-hint')

  return {
    id: '29-outro',
    label: '收尾',
    at: 58,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t, { outStart: 1.72, outDur: 0.28, y: 18, s: 0.99 })

      // 缓慢推近：全程都在推进，后段速度放缓并微呼吸
      const push = mix(1, 1.06, seg(t, 0, 1.35, 'outCubic'))
      inner.style.transform = `scale(${push * breathe(t, { amp: 0.004, speed: 1.8 })})`

      const km = seg(t, 0.08, 0.44, 'outBack')
      mark.style.opacity = String(clamp(km * 1.1))
      mark.style.transform = `scale(${mix(0.9, 1, km)})`

      const pr = frac((t - 0.1) * 0.75)
      halo.style.transform = `scale(${0.5 + pr * 1.3})`
      halo.style.opacity = String(0.5 * (1 - pr))

      rise(name, t, { start: 0.2, dur: 0.44, y: 22, s: 0.97 })
      rise(tag, t, { start: 0.3, dur: 0.44, y: 20, s: 0.98 })
      rise(hint, t, { start: 0.46, dur: 0.44, y: 18, s: 0.98 })
    },
  }
}
