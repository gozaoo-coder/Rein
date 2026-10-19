import { mix, seg } from '../lib/anim.js'
import { breathe, pose, shell } from './_kit.js'
import './25-motion.css'

/**
 * 爆点 25 · 50.0–52.0s · 丰富动效
 *
 * 重排（第 1 轮三条 major）：上一版药丸只有 900px、blob 只有 50px（占画幅 2.6%），
 * 「手机底栏塞进 1080p」；而且画面正中把实现机制（blob / 触点 / 光晕）当卖点写了出来。
 *
 * 现在：药丸拉满版心（1420px）、blob 提到 104–124px、槽位放大到正文尺度；
 * 那行工程词副文案删除 —— 信息交给画面本身。
 */
const W = 1420
const H = 184
const SLOTS = [
  { ico: '饮', name: '饮食' },
  { ico: '待', name: '待办' },
  { ico: '账', name: '记账' },
  { ico: '我', name: '我的' },
]
const SLOT_W = W / SLOTS.length
const SLOT_X = SLOTS.map((_, i) => SLOT_W * (i + 0.5))

export function createScene() {
  const el = shell({
    n: 25,
    label: '丰富动效',
    eyebrow: 'MOTION · 丰富动效',
    title: '选中态，是会流动的',
    zone: 'k-center',
    inner: `
      <div class="mo-stage">
        <span class="mo-amb"></span>
        <span class="mo-amb mo-amb--2"></span>
        <div class="mo-dock">
          <span class="mo-touch"></span>
          <span class="mo-glow"></span>
          <span class="mo-blob mo-blob--a"></span>
          <span class="mo-blob mo-blob--b"></span>
          ${SLOTS.map(
            (s, i) => `
            <span class="mo-slot" style="left:${SLOT_X[i] - SLOT_W / 2}px;width:${SLOT_W}px">
              <i>${s.ico}</i><b>${s.name}</b>
            </span>`,
          ).join('')}
        </div>
      </div>
    `,
  })
  el.classList.add('s25')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const stage = el.querySelector('.mo-stage')
  const blobA = el.querySelector('.mo-blob--a')
  const blobB = el.querySelector('.mo-blob--b')
  const glow = el.querySelector('.mo-glow')
  const touch = el.querySelector('.mo-touch')
  const slots = [...el.querySelectorAll('.mo-slot')]

  return {
    id: '25-motion',
    label: '丰富动效',
    at: 50,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)

      const k = seg(t, 0.14, 0.5, 'outCubic')
      stage.style.opacity = String(k)
      stage.style.transform = `translate3d(0, ${26 * (1 - k)}px, 0)`

      // 走动：0.5s 起从第一格平滑游到最后一格，停留段继续游走
      const p = mix(0, 1, seg(t, 0.5, 1.1, 'inOutCubic'))
      const x = mix(SLOT_X[0], SLOT_X[3], p)
      const sep = 8 + 26 * (0.5 + 0.5 * Math.sin(t * 2.4))
      const size = 112 + 10 * Math.sin(t * 3.1)

      blobA.style.transform = `translate3d(${x - sep - size / 2}px, ${-size / 2}px, 0)`
      blobA.style.width = `${size}px`
      blobA.style.height = `${size}px`
      blobB.style.transform = `translate3d(${x + sep - size / 2}px, ${-size / 2}px, 0)`
      blobB.style.width = `${size}px`
      blobB.style.height = `${size}px`

      const gs = 320 + 36 * Math.sin(t * 2.2)
      glow.style.transform = `translate3d(${x - gs / 2}px, ${-gs / 2}px, 0)`
      glow.style.width = `${gs}px`
      glow.style.height = `${gs}px`
      glow.style.opacity = String(0.5 + 0.25 * Math.sin(t * 2.6))

      const ts = 18 + 12 * (0.5 + 0.5 * Math.sin(t * 3.4))
      touch.style.transform = `translate3d(${x - ts / 2}px, ${-ts / 2}px, 0)`
      touch.style.width = `${ts}px`
      touch.style.height = `${ts}px`
      touch.style.opacity = String(0.55 + 0.4 * Math.sin(t * 3.4))

      slots.forEach((s, i) => {
        const near = Math.max(0, 1 - Math.abs(SLOT_X[i] - x) / (SLOT_W * 0.9))
        const on = near * near
        s.style.transform = `translate3d(0, ${-8 * on}px, 0) scale(${1 + 0.08 * on})`
        const ico = s.querySelector('i')
        const lbl = s.querySelector('b')
        ico.style.color = on > 0.35 ? 'var(--text-1)' : 'var(--text-3)'
        ico.style.background = on > 0.35 ? 'var(--accent-soft)' : 'transparent'
        lbl.style.color = on > 0.35 ? 'var(--accent-strong)' : 'var(--text-3)'
      })
    },
  }
}
