import { counter, seg } from '../lib/anim.js'
import { draw, fill, frac, pose, shell } from './_kit.js'
import './22-update.css'

/**
 * 爆点 22 · 44.0–46.0s · 软件更新
 *
 * 重排：图标统一成片头那一枚「蓝底白 R」（同一支片里不能有两个 Rein 标记）；
 * 两枚验签章在卡内**等宽并列**、间距固定，落位只用位移 + 透明度（不再有缩放过冲，
 * 也就不会有元素越出卡片右缘的残影）。标题与卡片作为一个整体垂直居中。
 */
const CHECK_LEN = 30

export function createScene() {
  const el = shell({
    n: 22,
    label: '软件更新',
    eyebrow: 'UPDATE · 软件更新',
    title: '装之前，先验两次签',
    zone: 'k-stack',
    inner: `
      <div class="up-card k-panel">
        <div class="up-head">
          <span class="up-ico">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M14 10h11.5c5.2 0 8.5 3 8.5 7.6 0 3.4-1.7 5.9-4.7 6.9L36.5 38h-6.3l-6.1-12.3h-4.2V38H14V10zm5.9 4.9v5.9h5c2.2 0 3.6-1.1 3.6-2.9 0-1.9-1.4-3-3.6-3h-5z" />
            </svg>
          </span>
          <div class="up-title"><b>Rein 有新版本</b><span>v0.6.0 · 42.6 MB · 增量更新</span></div>
          <span class="chip soft-accent">可安装</span>
        </div>

        <div class="up-progress">
          <div class="up-prog-top"><span class="k-sub">下载更新包</span><b class="up-pct num">0%</b></div>
          <div class="k-bar up-bar"><i></i><span class="up-shine"></span></div>
        </div>

        <div class="up-stamps">
          <div class="up-stamp">
            <span class="up-stamp-badge">签</span>
            <div><b>官方签名校验通过</b><span>第一道 · 发布包签名</span></div>
            <svg class="up-stamp-check" viewBox="0 0 30 26"><path d="M4 13 L11 20 L26 5" /></svg>
          </div>
          <div class="up-stamp">
            <span class="up-stamp-badge">签</span>
            <div><b>第二道校验通过</b><span>两处都过 · 可以安装</span></div>
            <svg class="up-stamp-check" viewBox="0 0 30 26"><path d="M4 13 L11 20 L26 5" /></svg>
          </div>
        </div>

        <div class="up-done">
          <svg class="up-done-check" viewBox="0 0 34 30"><path d="M5 15 L13 23 L29 6" /></svg>
          <span>双签都通过，可以安装</span>
        </div>
      </div>
    `,
  })
  el.classList.add('s22')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const card = el.querySelector('.up-card')
  const bar = el.querySelector('.up-bar > i')
  const shine = el.querySelector('.up-shine')
  const pct = el.querySelector('.up-pct')
  const stamps = [...el.querySelectorAll('.up-stamp')]
  const badgeSvg = el.querySelector('.up-ico svg')
  const stampChecks = [...el.querySelectorAll('.up-stamp-check path')]
  const doneCheck = el.querySelector('.up-done-check path')
  const done = el.querySelector('.up-done')

  stampChecks.forEach((c) => {
    c.style.strokeDasharray = '28'
  })
  doneCheck.style.strokeDasharray = String(CHECK_LEN)

  return {
    id: '22-update',
    label: '软件更新',
    at: 44,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([card], t, { y: 24, s: 0.99 })

      const p = seg(t, 0.06, 0.26, 'outCubic')
      fill(bar, p)
      pct.textContent = `${counter(p, 0, 100)}%`
      shine.style.transform = `translate3d(${frac(t * 0.55) * 260 - 70}%, 0, 0)`
      badgeSvg.style.transform = `scale(${1 + 0.02 * Math.sin(t * 3.1)})`

      stamps.forEach((s, i) => {
        const k = seg(t, 0.26 + i * 0.06, 0.18, 'outCubic')
        s.style.opacity = String(seg(t, 0.26 + i * 0.06, 0.14))
        s.style.transform = `translate3d(0, ${14 * (1 - k)}px, 0)`
        draw(stampChecks[i], seg(t, 0.32 + i * 0.06, 0.14, 'outCubic'), 28)
      })

      const kd = seg(t, 0.42, 0.12, 'outCubic')
      done.style.opacity = String(kd)
      done.style.transform = `translate3d(0, ${12 * (1 - kd)}px, 0)`
      draw(doneCheck, kd, CHECK_LEN)
    },
  }
}
