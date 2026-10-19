import { clamp, counter, mix, seg } from '../lib/anim.js'
import { breathe, fill, frac, pose, shell } from './_kit.js'
import './08-meal.css'

/**
 * 爆点 08 · 16.0–18.0s · 记一餐
 * 手机壳里的拍照界面 → 快门白闪 → 识别框扫描 → 右侧落成一张食物卡（热量 + 三大宏量）。
 * 停留段：识别框扫描线往返、卡片呼吸、营养条与数值微动。
 */
const MACROS = [
  { name: '蛋白质', now: 32, max: 80, color: 'var(--c-protein)' },
  { name: '碳水', now: 68, max: 250, color: 'var(--c-carb)' },
  { name: '脂肪', now: 22, max: 65, color: 'var(--c-fat)' },
]

export function createScene() {
  const el = shell({
    n: 8,
    label: '记一餐',
    inner: `
      <div class="k-wrap meal-wrap">
        <p class="k-micro">CAPTURE · 记一餐</p>
        <h2 class="k-title">拍一张，一餐就记好了</h2>
        <div class="meal-stage">
          <div class="phone meal-phone">
            <div class="screen">
              <div class="cam">
                <div class="cam-plate"><i class="cam-food"></i></div>
                <div class="cam-frame">
                  <b class="cam-scan"></b>
                  <span class="cam-corner tl"></span><span class="cam-corner tr"></span>
                  <span class="cam-corner bl"></span><span class="cam-corner br"></span>
                </div>
                <div class="cam-ui">
                  <span class="cam-hint">对准食物 · 自动识别</span>
                  <span class="shutter"></span>
                </div>
              </div>
              <div class="flash"></div>
            </div>
            <div class="notch"></div>
          </div>

          <div class="food k-panel">
            <div class="food-head">
              <span class="k-ico food-ico">餐</span>
              <div class="food-name"><h3>番茄牛腩盖饭</h3><p class="k-sub">午餐 · 12:04 · 一份</p></div>
              <span class="chip soft-ok">已识别</span>
            </div>
            <div class="food-energy"><b class="k-num">0</b><span class="k-sub">kcal</span></div>
            <div class="macros">
              ${MACROS.map(
                (m) => `
                <div class="macro" data-k="${m.name}">
                  <div class="macro-top"><span class="k-sub">${m.name}</span><span class="macro-val"><b>0</b><i>／${m.max}g</i></span></div>
                  <div class="k-bar macro-bar"><i style="background:${m.color}"></i></div>
                </div>`,
              ).join('')}
            </div>
            <div class="food-foot k-sub muted">米饭 220g · 牛腩 120g · 番茄 2 只</div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s08')

  const wrap = el.querySelector('.meal-wrap')
  const cap = el.querySelector('.beat-cap')
  const phone = el.querySelector('.meal-phone')
  const flash = el.querySelector('.flash')
  const scan = el.querySelector('.cam-scan')
  const food = el.querySelector('.food')
  const energy = el.querySelector('.food-energy b')
  const macroNodes = MACROS.map((m) => ({
    bar: el.querySelector(`.macro[data-k="${m.name}"] .macro-bar > i`),
    val: el.querySelector(`.macro[data-k="${m.name}"] .macro-val b`),
    max: m.max,
    now: m.now,
  }))

  return {
    id: '08-meal',
    label: '记一餐',
    at: 16,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const kp = seg(t, 0.1, 0.42, 'outCubic')
      phone.style.opacity = String(kp)
      phone.style.transform = `translate3d(${-40 * (1 - kp)}px, ${breathe(t, { amp: 4, speed: 1.7 }) - 1}px, 0)`

      const fl = Math.max(0, 1 - Math.abs(t - 0.3) / 0.09)
      flash.style.opacity = String(fl * 0.96)

      const sy = frac((t - 0.12) * 0.8)
      scan.style.transform = `translate3d(0, ${mix(0, 300, sy)}px, 0)`
      scan.style.opacity = String(0.85 * (1 - Math.abs(sy - 0.5) * 1.3))

      const kf = seg(t, 0.42, 0.3, 'outCubic')
      food.style.opacity = String(kf)
      food.style.transform = `translate3d(${44 * (1 - kf)}px, 0, 0) scale(${breathe(t, { amp: 0.008, speed: 1.9 })})`

      energy.textContent = counter(seg(t, 0.44, 0.2, 'outQuart'), 0, 612)

      macroNodes.forEach((n, i) => {
        const k = seg(t, 0.46 + i * 0.04, 0.18, 'outCubic')
        fill(n.bar, clamp(k))
        n.val.textContent = counter(k, 0, n.now)
      })
    },
  }
}
