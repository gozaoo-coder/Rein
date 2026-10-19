import { seg } from '../lib/anim.js'
import { frac, pose, shell } from './_kit.js'
import './01-pillars.css'

/**
 * 爆点 01 · 2.0–4.0s · AI 中枢
 *
 * 重排：上一版是「居中眉标 + 三张等高同构白卡」，正是设计简报 §7 点名的反例
 * （第 1 轮审核在 01/10/16 三处重复命中）。现在改成非对称的 k-ladder：
 * 左列三行「能力」（当前一行展开放大，其余降饱和），右侧一块大面板画**中枢**本身 ——
 * AI 在中心，八个模块挂在四周，连线依次点亮。一屏一个焦点，因果（AI 把数据串起来）看得见。
 */
const CAPS = [
  { k: 'read', glyph: '读', title: '它读得到', sub: '饮食 · 运动 · 待办 · 开销 · 课表 · 笔记' },
  { k: 'act', glyph: '动', title: '它能动手', sub: '记一餐 · 记一笔 · 排进明天的日程' },
  { k: 'keep', glyph: '存', title: '它会沉淀', sub: '可留存的卡片与文件，长期记住你' },
]

const MODULES = [
  { name: '饮食', color: 'var(--led-food)' },
  { name: '运动', color: 'var(--c-exercise)' },
  { name: '待办', color: 'var(--cat-general)' },
  { name: '专注', color: 'var(--cat-study)' },
  { name: '记账', color: 'var(--led-expense)' },
  { name: '课表', color: 'var(--cat-class)' },
  { name: '知识库', color: 'var(--sto-asset)' },
  { name: '营养', color: 'var(--c-protein)' },
]

export function createScene() {
  const el = shell({
    n: 1,
    label: 'AI 中枢',
    eyebrow: 'COPILOT · AI 中枢',
    title: 'AI 是那个把数据串起来的人',
    zone: 'k-ladder',
    inner: `
      <div class="pl-list">
        ${CAPS.map(
          (c, i) => `
          <div class="pl-item" data-i="${i}">
            <span class="k-ico pl-ico">${c.glyph}</span>
            <div class="pl-item-txt">
              <b>${c.title}</b>
              <span>${c.sub}</span>
            </div>
          </div>`,
        ).join('')}
      </div>

      <div class="pl-visual k-panel">
        <svg class="pl-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${MODULES.map((m, i) => `<path class="pl-spoke" data-i="${i}" pathLength="1" />`).join('')}
        </svg>
        <span class="pl-hub">AI</span>
        ${MODULES.map(
          (m, i) => `
          <span class="pl-node" data-i="${i}">
            <i style="background:${m.color}"></i><b>${m.name}</b>
          </span>`,
        ).join('')}
      </div>
    `,
  })
  el.classList.add('s01')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const list = el.querySelector('.pl-list')
  const visual = el.querySelector('.pl-visual')
  const items = [...el.querySelectorAll('.pl-item')]
  const nodes = [...el.querySelectorAll('.pl-node')]
  const spokes = [...el.querySelectorAll('.pl-spoke')]
  const hub = el.querySelector('.pl-hub')

  // 八个模块按同一个椭圆排布；节点与连线共用这份坐标（不量 DOM，直接算）
  const pos = (i) => {
    const a = (-90 + i * (360 / MODULES.length)) * (Math.PI / 180)
    return [50 + 40 * Math.cos(a), 50 + 36 * Math.sin(a)]
  }

  return {
    id: '01-pillars',
    label: 'AI 中枢',
    at: 2,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([list, visual], t, { y: 24, s: 0.99 })

      // 三行能力：错峰入场；停留段里「当前行」轮转（可见的持续推进）
      const active = Math.min(CAPS.length - 1, Math.floor(frac((t - 0.6) * 0.3) * 3))
      items.forEach((it, i) => {
        const k = seg(t, 0.1 + i * 0.08, 0.34, 'outCubic')
        const on = i === active
        it.style.opacity = String(k * (on ? 1 : 0.55))
        it.style.transform = `translate3d(${18 * (1 - k)}px, 0, 0) scale(${on ? 1 : 0.98})`
        it.style.background = on ? 'var(--accent-soft)' : 'transparent'
        it.querySelector('b').style.color = on ? 'var(--accent-strong)' : 'var(--text-1)'
      })

      // 中枢：八个模块落位 + 连线依次点亮
      nodes.forEach((n, i) => {
        const [x, y] = pos(i)
        const k = seg(t, 0.16 + i * 0.05, 0.3, 'outBack')
        n.style.left = `${x}%`
        n.style.top = `${y}%`
        n.style.opacity = String(k)
        n.style.transform = `translate(-50%, -50%) scale(${0.85 + 0.15 * k})`
        n.style.boxShadow = i === active % MODULES.length ? '0 0 0 2px var(--accent)' : 'none'
      })

      spokes.forEach((s, i) => {
        const [x, y] = pos(i)
        s.setAttribute('d', `M 50 50 L ${x} ${y}`)
        s.style.strokeDasharray = '1'
        s.style.strokeDashoffset = String(1 - seg(t, 0.16 + i * 0.05, 0.3, 'outCubic'))
      })

      hub.style.transform = `translate(-50%, -50%) scale(${1 + 0.03 * Math.sin(t * 2.6)})`
    },
  }
}
