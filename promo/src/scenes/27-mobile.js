import { seg } from '../lib/anim.js'
import { breathe, pose, shell } from './_kit.js'
import './27-mobile.css'

/**
 * 爆点 27 · 54.0–56.0s · 手机端
 * 手机壳入场，同一份代码切成底部页签单列形态；桌面壳与手机壳并排对照。
 * 停留段：页签依次亮起、手机壳轻微呼吸、两壳之间的同步光点往返。
 */
const TABS = ['首页', '待办', '记账', '我的']

export function createScene() {
  const el = shell({
    n: 27,
    label: '手机端',
    inner: `
      <div class="k-wrap ph-wrap">
        <p class="k-micro">MOBILE · 手机端</p>
        <h2 class="k-title">同一份代码，换个壳就换形态</h2>
        <div class="ph-stage">
          <div class="ph-desktop win">
            <div class="chrome"><i></i><i></i><i></i><span>桌面</span></div>
            <div class="body"><img src="/shots/desktop-home.png" alt="" /><span class="sheen"></span></div>
          </div>
          <div class="ph-link"><i></i><i></i><i></i></div>
          <div class="ph-phone phone">
            <div class="screen">
              <img src="/shots/mobile-home.png" alt="" />
              <span class="sheen"></span>
              <div class="ph-tabs">
                ${TABS.map((tb) => `<span class="ph-tab"><i></i>${tb}</span>`).join('')}
              </div>
            </div>
            <div class="notch"></div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s27')

  const wrap = el.querySelector('.ph-wrap')
  const cap = el.querySelector('.beat-cap')
  const desktop = el.querySelector('.ph-desktop')
  const phone = el.querySelector('.ph-phone')
  const tabs = [...el.querySelectorAll('.ph-tab')]
  const dots = [...el.querySelectorAll('.ph-link i')]

  return {
    id: '27-mobile',
    label: '手机端',
    at: 54,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const kd = seg(t, 0.12, 0.42, 'outCubic')
      desktop.style.opacity = String(kd)
      desktop.style.transform = `translate3d(${-40 * (1 - kd)}px, 0, 0)`

      const kp = seg(t, 0.2, 0.44, 'outCubic')
      phone.style.opacity = String(kp)
      phone.style.transform = `translate3d(${60 * (1 - kp)}px, ${breathe(t, { amp: 4, speed: 1.8 }) - 1}px, 0)`

      tabs.forEach((tb, i) => {
        const k = seg(t, 0.5 + i * 0.1, 0.28, 'outBack')
        tb.style.opacity = String(0.5 + 0.5 * k)
        const on = k > 0.5
        tb.style.color = on ? 'var(--accent-strong)' : 'var(--text-2)'
        tb.querySelector('i').style.background = on ? 'var(--accent)' : 'var(--line-strong)'
        tb.style.transform = `translate3d(0, ${-4 * on}px, 0)`
      })

      dots.forEach((d, i) => {
        const x = (0.5 + 0.5 * Math.sin(t * 1.6 + (i / dots.length) * 2)) * 150
        d.style.transform = `translate3d(${x}px, 0, 0)`
        d.style.opacity = String(0.3 + 0.7 * Math.sin(t * 1.6 + (i / dots.length) * 2) ** 2)
      })
    },
  }
}
