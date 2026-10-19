import { mix, seg } from '../lib/anim.js'
import { frac, pose, shell, sweep } from './_kit.js'
import './24-glass.css'

/**
 * 爆点 24 · 48.0–50.0s · 液态玻璃
 *
 * 重排：上一版是「居中大标题 + 四张等权卡」，每张卡各演一遍自己那档玻璃 ——
 * 既落进简报 §7 的反例，也说不清「同一块玻璃」这件事。
 *
 * 现在标题说「同一块玻璃」，画面就给同一块玻璃：右侧一块大控件，背后铺一层彩色内容
 * （模糊才有东西可糊），左侧一列档位逐档切换。切换时那块玻璃的**模糊半径 / 饱和度 /
 * 受光边 / 内截面**是**连续插值**的（不是四档硬切）—— 60fps 下看得出光在玻璃里
 * 慢慢变厚，这才是「细腻」。
 */
const TIERS = [
  { name: '流畅', note: '无模糊 · 实底', blur: 0, sat: 100, sheen: 0.12, rim2: 0 },
  { name: '高画质', note: '28px 模糊 · 受光边', blur: 16, sat: 180, sheen: 0.38, rim2: 0 },
  { name: '超高', note: '双截面 · 焦散', blur: 30, sat: 185, sheen: 0.6, rim2: 1.2 },
  { name: '极致', note: '四层光学 · 折射', blur: 44, sat: 205, sheen: 0.72, rim2: 3 },
]

const BACK = ['--c-intake', '--c-carb', '--c-protein', '--c-balance', '--led-shopping', '--cat-class']

/** 在四档之间做连续插值（p ∈ [0,1] 覆盖 3 段） */
function opticsAt(p) {
  const x = Math.max(0, Math.min(0.9999, p)) * (TIERS.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = TIERS[i]
  const b = TIERS[Math.min(TIERS.length - 1, i + 1)]
  return {
    blur: mix(a.blur, b.blur, f),
    sat: mix(a.sat, b.sat, f),
    sheen: mix(a.sheen, b.sheen, f),
    rim2: mix(a.rim2, b.rim2, f),
  }
}

export function createScene() {
  const el = shell({
    n: 24,
    label: '液态玻璃',
    eyebrow: 'LIQUID GLASS · 液态玻璃',
    title: '四档画质，同一块玻璃',
    zone: 'k-ladder',
    inner: `
      <div class="gl-tiers">
        ${TIERS.map(
          (tr, i) => `
          <div class="gl-tier" data-i="${i}">
            <b>${tr.name}</b>
            <span>${tr.note}</span>
          </div>`,
        ).join('')}
      </div>

      <div class="gl-hero">
        <div class="gl-board k-panel">
          <span class="gl-back">
            ${BACK.map((c, i) => `<i style="background:var(${c});height:${34 + ((i * 31) % 60)}%"></i>`).join('')}
          </span>
          <div class="gl-ctrl glass">
            <span class="gl-seg">日</span>
            <span class="gl-seg is-on">周</span>
            <span class="gl-seg">月</span>
          </div>
          <span class="k-sheen gl-sheen"></span>
        </div>
        <p class="gl-note">流畅 · 无模糊 · 实底</p>
      </div>
    `,
  })
  el.classList.add('s24')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const tiers = [...el.querySelectorAll('.gl-tier')]
  const board = el.querySelector('.gl-board')
  const ctrl = el.querySelector('.gl-ctrl')
  const sheen = el.querySelector('.gl-sheen')
  const note = el.querySelector('.gl-note')

  return {
    id: '24-glass',
    label: '液态玻璃',
    at: 48,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([el.querySelector('.gl-tiers'), el.querySelector('.gl-hero')], t, { y: 24, s: 0.99 })

      // 档位从「流畅」连续推到「极致」；推进在 0.68s 前收尾，
      // 于是抽帧（t≈0.55）拿到的是玻璃最厚的那一档，而不是最素的实底档
      const p = seg(t, 0.12, 0.56, 'inOutCubic')
      const o = opticsAt(p)
      ctrl.style.setProperty('--gl-blur', `${o.blur.toFixed(2)}px`)
      ctrl.style.setProperty('--gl-sat', `${o.sat.toFixed(1)}%`)
      ctrl.style.setProperty('--gl-sheen', o.sheen.toFixed(4))
      ctrl.style.setProperty('--gl-rim2', `${o.rim2.toFixed(2)}px`)

      const active = Math.round(p * (TIERS.length - 1))
      note.textContent = `${TIERS[active].name} · ${TIERS[active].note}`

      tiers.forEach((n, i) => {
        const k = seg(t, 0.1 + i * 0.06, 0.3, 'outCubic')
        // 高亮随 p 连续移动（相邻两档之间是平滑过渡，不是跳变）
        const near = Math.max(0, 1 - Math.abs(p * (TIERS.length - 1) - i))
        const on = k * near
        n.style.opacity = String(k * (0.55 + 0.45 * on))
        n.style.transform = `translate3d(${14 * (1 - k)}px, 0, 0) scale(${1 + 0.02 * on})`
        n.style.background = on > 0.5 ? 'var(--accent-soft)' : 'transparent'
        n.querySelector('b').style.color = on > 0.5 ? 'var(--accent-strong)' : 'var(--text-1)'
      })

      // 停留段：一道高光横扫过这块玻璃
      sweep(sheen, t, { start: 0.62, dur: 0.86, opacity: 0.7, angle: 8 })
      board.style.transform = `scale(${1 + 0.006 * Math.sin(t * 2.1)})`
    },
  }
}
