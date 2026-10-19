import { clamp, mix, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './05-artifact.css'

/**
 * 爆点 05 · 10.0–12.0s · 卡片产物
 * 一颗对话气泡"沉淀"成一张画布卡片：卡片从气泡处放大成形、落影加深（浮起），
 * 图表柱状生长。停留段：卡片缓慢浮动 + 高光扫过 + 柱子微动。
 */
const BARS = [
  { h: 0.5, label: '08' },
  { h: 0.8, label: '10' },
  { h: 0.62, label: '12' },
  { h: 0.95, label: '14' },
  { h: 0.7, label: '16' },
  { h: 0.85, label: '18' },
  { h: 0.42, label: '20' },
]

export function createScene() {
  const el = shell({
    n: 5,
    label: '卡片产物',
    inner: `
      <div class="k-wrap p-wrap">
        <p class="k-micro">ARTIFACT · 卡片产物</p>
        <h2 class="k-title">对话，沉淀成一张可回看的卡片</h2>
        <div class="p-stage">
          <span class="bubble">AI</span>
          <span class="card-shadow"></span>
          <div class="artifact k-panel">
            <span class="art-sheen"></span>
            <div class="art-head">
              <div>
                <h3>明天的安排</h3>
                <p class="k-sub">7 项 · 08:00 – 20:00</p>
              </div>
              <span class="chip soft-accent">AI 生成</span>
            </div>
            <div class="art-chart">
              ${BARS.map((b) => `<span class="art-col"><i style="height:${b.h * 100}%"></i></span>`).join('')}
            </div>
            <div class="art-axis">
              ${BARS.map((b) => `<b>${b.label}</b>`).join('')}
            </div>
            <div class="art-foot">
              <span class="art-btn"><i></i>回看这一天</span>
            </div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s05')

  const wrap = el.querySelector('.p-wrap')
  const cap = el.querySelector('.beat-cap')
  const bubble = el.querySelector('.bubble')
  const shadow = el.querySelector('.card-shadow')
  const card = el.querySelector('.artifact')
  const sheen = el.querySelector('.art-sheen')
  const cols = [...el.querySelectorAll('.art-col i')]

  return {
    id: '05-artifact',
    label: '卡片产物',
    at: 10,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const kb = seg(t, 0.12, 0.32, 'outBack')
      const sink = seg(t, 0.34, 0.34, 'inCubic')
      bubble.style.opacity = String(clamp(kb * (1 - sink)))
      bubble.style.transform = `translate3d(0, 0, 0) scale(${mix(0.5, 1, kb) * mix(1, 0.5, sink)})`

      const km = seg(t, 0.34, 0.32, 'outCubic')
      const float = Math.sin(t * 1.9) * 5
      card.style.opacity = String(km)
      card.style.transform = `translate3d(${-300 * (1 - km)}px, ${float}px, 0) scale(${mix(0.36, 1, km)})`

      const ks = seg(t, 0.4, 0.34, 'outCubic')
      shadow.style.opacity = String(ks)
      shadow.style.transform = `scale(${mix(0.5, 1, ks)})`

      cols.forEach((c, i) => {
        const k = seg(t, 0.3 + i * 0.02, 0.14, 'outCubic')
        const ib = breathe(t, { amp: 0.02, speed: 2.4, phase: i * 1.1 })
        c.style.transform = `scaleY(${clamp((0.02 + 0.98 * k) * ib)})`
      })

      sheen.style.transform = `translate3d(${frac(t * 0.42) * 260 - 80}%, 0, 0)`
    },
  }
}
