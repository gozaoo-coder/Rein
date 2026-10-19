import { seg } from '../lib/anim.js'
import { fill, pose, shell } from './_kit.js'
import './10-recipes.css'

/**
 * 爆点 10 · 20.0–22.0s · 食谱库
 *
 * 重排（第 1 轮两条 major）：上一版是「居中大标题 + 三张等高同构白卡 + 右侧结果面板」——
 * 设计简报 §7 点名的反例，而且卡面是平涂白、没有玻璃受光边。
 * 现在改成 k-ladder：左侧一列模板行（选中项放大上浮、其余降饱和下沉），
 * 右侧只放一块菜单大面板（玻璃），一屏一个焦点。
 */
const TEMPLATES = [
  { name: '高蛋白 · 低碳', ico: '蛋', color: 'var(--c-protein)', tags: '蛋白质 40% · 碳水 25%', p: 0.62 },
  { name: '均衡三餐', ico: '衡', color: 'var(--accent)', tags: '蛋白质 30% · 碳水 45%', p: 0.52 },
  { name: '增肌期', ico: '肌', color: 'var(--c-carb)', tags: '热量 2600 · 碳水 50%', p: 0.74 },
]
const MENU = [
  { meal: '早餐', name: '燕麦莓果碗 + 水煮蛋', kcal: 420 },
  { meal: '午餐', name: '鸡胸藜麦沙拉', kcal: 560 },
  { meal: '晚餐', name: '三文鱼配时蔬', kcal: 480 },
]

export function createScene() {
  const el = shell({
    n: 10,
    label: '食谱库',
    eyebrow: 'RECIPES · 食谱库',
    title: '选一个模板，生成一日菜单',
    zone: 'k-ladder',
    inner: `
      <div class="r-tiers">
        ${TEMPLATES.map(
          (t, i) => `
          <div class="r-tier${i === 1 ? ' is-sel' : ''}">
            <span class="k-ico r-ico" style="background:${t.color}">${t.ico}</span>
            <div class="r-tier-txt">
              <b>${t.name}</b>
              <span>${t.tags}</span>
              <span class="k-bar r-bar"><i style="background:${t.color}"></i></span>
            </div>
          </div>`,
        ).join('')}
      </div>

      <div class="r-menu k-panel">
        <div class="r-menu-head">
          <b>一日菜单</b>
          <span class="r-gen"><i></i>均衡三餐 · 生成中</span>
        </div>
        ${MENU.map(
          (m) => `
          <div class="r-row">
            <span class="r-meal">${m.meal}</span>
            <span class="r-dish">${m.name}</span>
            <span class="r-kcal"><b class="num">${m.kcal}</b> kcal</span>
          </div>`,
        ).join('')}
      </div>
    `,
  })
  el.classList.add('s10')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const tiers = [...el.querySelectorAll('.r-tier')]
  const menu = el.querySelector('.r-menu')
  const rows = [...el.querySelectorAll('.r-row')]
  const gen = el.querySelector('.r-gen')
  const genIco = el.querySelector('.r-gen i')

  return {
    id: '10-recipes',
    label: '食谱库',
    at: 20,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([el.querySelector('.r-tiers'), menu], t, { y: 22, s: 0.99 })

      const ksel = seg(t, 0.34, 0.26, 'outBack')
      tiers.forEach((c, i) => {
        const k = seg(t, 0.1 + i * 0.07, 0.3, 'outCubic')
        const sel = i === 1
        c.style.opacity = String(k * (sel ? 1 : 0.6))
        c.style.transform = `translate3d(${14 * (1 - k)}px, 0, 0) scale(${sel ? 1 + 0.04 * ksel : 1 - 0.02 * ksel})`
        c.style.background = sel ? 'var(--accent-soft)' : 'transparent'
        fill(c.querySelector('.r-bar > i'), seg(t, 0.2 + i * 0.06, 0.3, 'outCubic') * TEMPLATES[i].p)
      })

      rows.forEach((r, i) => {
        const k = seg(t, 0.28 + i * 0.035, 0.18, 'outCubic')
        r.style.opacity = String(k)
        r.style.transform = `translate3d(0, ${18 * (1 - k)}px, 0)`
      })

      gen.style.opacity = String(0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 5)))
      genIco.style.transform = `rotate(${t * 320}deg)`
    },
  }
}
