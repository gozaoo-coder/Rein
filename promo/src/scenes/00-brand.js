import { createTimeline } from 'animejs'
import './00-brand.css'

/**
 * 爆点 00 · 0.0–2.0s · 品牌开场
 * 手法：anime.js v4 timeline（paused + seek）—— 位移 / 缩放 / 透明度全部由它驱动。
 * 节奏：0.06s 起标记弹入（outBack）→ 0.26s 起字标 → 0.42s 起副标 → 1.56s 整块退场。
 */
export function createScene() {
  const el = document.createElement('section')
  el.innerHTML = `
    <div class="stage-bg"></div>
    <div class="grid-bg on-light"></div>
    <div class="vignette"></div>
    <div class="content center">
      <div class="brand-stack col center">
        <div class="halo"></div>
        <div class="mark">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M14 10h11.5c5.2 0 8.5 3 8.5 7.6 0 3.4-1.7 5.9-4.7 6.9L36.5 38h-6.3l-6.1-12.3h-4.2V38H14V10zm5.9 4.9v5.9h5c2.2 0 3.6-1.1 3.6-2.9 0-1.9-1.4-3-3.6-3h-5z"/>
          </svg>
        </div>
        <h1 class="brand-name">Rein</h1>
        <p class="brand-tag">全能生活助理</p>
      </div>
    </div>
    <div class="beat-cap"><b>00</b><span>品牌</span></div>
  `

  const mark = el.querySelector('.mark')
  const halo = el.querySelector('.halo')
  const name = el.querySelector('.brand-name')
  const tag = el.querySelector('.brand-tag')
  const stack = el.querySelector('.brand-stack')
  const cap = el.querySelector('.beat-cap')

  const tl = createTimeline({ autoplay: false })

  tl.set([mark, halo], { opacity: 0 }, 0)
    .set([name, tag], { opacity: 0, translateY: 20 }, 0)
    .set(cap, { opacity: 0 }, 0)
    .add(mark, { opacity: 1, scale: [0.62, 1], duration: 620, ease: 'outBack' }, 60)
    .add(halo, { opacity: [0, 1], scale: [0.5, 1.5], duration: 900, ease: 'outCubic' }, 60)
    .add(name, { opacity: 1, translateY: 0, duration: 540, ease: 'outCubic' }, 260)
    .add(tag, { opacity: 1, translateY: 0, duration: 520, ease: 'outCubic' }, 420)
    .add(cap, { opacity: 1, duration: 400, ease: 'outCubic' }, 500)
    .add(stack, { opacity: 0, scale: 1.06, duration: 440, ease: 'inCubic' }, 1560)

  return {
    id: '00-brand',
    label: '品牌',
    at: 0,
    dur: 2,
    el,
    seek: (t) => tl.seek(t * 1000),
  }
}
