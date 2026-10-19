import { counter, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './15-score.css'

/**
 * 爆点 15 · 30.0–32.0s · 练够分
 *
 * 重排（第 2 轮 blocker/多条 major）：上一版是「等宽圆角块拼的人形」，审核的原话是
 * 「像占位素材，不如 App 里的肌群图克制精致」。现在**直接用 App 的 MuscleMap 资产**
 * （docs/design/colorlab 的真实热力图截出的正面视图）—— 解剖轮廓与热力配色都是产品本人的，
 * 不是重绘的近似物。
 *
 * 主角是右侧的 82 环；左侧肌群图是辅助层（去掉白色卡面）。
 * 档名按产品真实六段（config/muscles.ts）：75–89 是「足够」。数值与正文一律中性色。
 */
const STEPS = [
  { label: '充分', v: 'var(--c-exercise)' },
  { label: '足够', v: 'var(--heat-mid)' },
  { label: '基本够', v: 'var(--c-balance)' },
  { label: '不足', v: 'var(--text-3)' },
]

const SIZE = 300
const C = SIZE / 2
const R = 128
const CIRC = 2 * Math.PI * R

export function createScene() {
  const el = shell({
    n: 15,
    label: '练够分',
    eyebrow: 'TRAINING SCORE · 练够分',
    title: '这周哪块练够了，一眼看清',
    zone: 'k-split-r',
    inner: `
      <div class="sc-map">
        <div class="sc-figure">
          <img src="/shots/muscle-front.png" alt="" />
          <span class="sc-scan"></span>
        </div>
        <div class="k-legend sc-legend">
          ${STEPS.map((s) => `<span><i class="k-swatch" style="background:${s.v}"></i>${s.label}</span>`).join('')}
        </div>
      </div>

      <div class="sc-hero">
        <div class="ring sc-ring">
          <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
            <circle class="sc-track" cx="${C}" cy="${C}" r="${R}" />
            <circle class="sc-arc" cx="${C}" cy="${C}" r="${R}" />
          </svg>
          <div class="label col center">
            <span class="sc-val num">0</span>
            <span class="sc-tier">足够</span>
          </div>
        </div>
        <p class="k-body sc-note">本周 5 次训练 · 10 组肌群中 <b class="num">3</b> 组不足</p>
      </div>
    `,
  })
  el.classList.add('s15')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const map = el.querySelector('.sc-map')
  const hero = el.querySelector('.sc-hero')
  const figure = el.querySelector('.sc-figure')
  const scan = el.querySelector('.sc-scan')
  const arc = el.querySelector('.sc-arc')
  const val = el.querySelector('.sc-val')
  const ring = el.querySelector('.sc-ring')

  arc.style.strokeDasharray = String(CIRC)
  arc.style.strokeDashoffset = String(CIRC)

  return {
    id: '15-score',
    label: '练够分',
    at: 30,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([map, hero], t, { y: 22, s: 0.99 })

      // 入场：一条扫描线自上而下过身（「逐块读出来」的手感）
      const sy = frac((t - 0.08) * 0.75)
      scan.style.transform = `translate3d(0, ${sy * 560}px, 0)`
      scan.style.opacity = String(0.7 * Math.sin(seg(t, 0.06, 0.5, 'outCubic') * Math.PI))

      const p = seg(t, 0.2, 0.3, 'outQuart')
      val.textContent = counter(p, 0, 82)
      arc.style.strokeDashoffset = String(CIRC * (1 - p * 0.82))
      ring.style.transform = `scale(${breathe(t, { amp: 0.008, speed: 2 })})`
      // 停留段：人物图极缓呼吸（确定性）
      figure.style.transform = `scale(${1 + 0.008 * Math.sin(t * 1.9)})`
    },
  }
}
