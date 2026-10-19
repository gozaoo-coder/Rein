import { counter, seg } from '../lib/anim.js'
import { pose, shell } from './_kit.js'
import './16-plan.css'

/**
 * 爆点 16 · 32.0–34.0s · 健康方案
 *
 * 重排（第 1 轮两条 major）：与 10-recipes 同构的「居中标题 + 三张等高卡 + 右面板」，
 * 同样落在简报 §7 的反例上、卡面也没有受光边。
 * 现在改成 k-ladder：左侧一列基线档位（选中项展开上浮、其余下沉），右侧一块一日安排大面板。
 */
const TIERS = [
  { name: '保守', kcal: 1600, desc: '低强度 · 稳步减脂' },
  { name: '均衡', kcal: 1850, desc: '常规训练 · 保持体能' },
  { name: '激进', kcal: 2200, desc: '高强度 · 增肌期' },
]
const PLAN = [
  { t: '07:00', k: '起床 · 饮水 300ml' },
  { t: '08:00', k: '晨间有氧 30 分钟' },
  { t: '09:00', k: '早餐 · 燕麦 + 鸡蛋' },
  { t: '12:30', k: '午餐 · 鸡胸藜麦' },
  { t: '18:30', k: '力量训练 · 推日' },
  { t: '19:30', k: '晚餐 · 三文鱼时蔬' },
  { t: '22:30', k: '睡眠 · 目标 8 小时' },
]

export function createScene() {
  const el = shell({
    n: 16,
    label: '健康方案',
    eyebrow: 'PLAN · 健康方案',
    title: '先选一档基线，再展开一天',
    zone: 'k-ladder',
    inner: `
      <div class="pl-tiers">
        ${TIERS.map(
          (t, i) => `
          <div class="pl-tier${i === 1 ? ' is-sel' : ''}">
            <b>${t.name}</b>
            <div class="pl-kcal"><span class="num">${t.kcal}</span><i>kcal / 日</i></div>
            <span class="pl-desc">${t.desc}</span>
          </div>`,
        ).join('')}
      </div>

      <div class="pl-panel k-panel">
        <div class="pl-head"><b>均衡 · 一日安排</b><span class="pl-sub">7 项</span></div>
        <div class="pl-rows">
          ${PLAN.map((r) => `<div class="pl-row"><span class="pl-t num">${r.t}</span><span class="pl-k">${r.k}</span></div>`).join('')}
        </div>
      </div>
    `,
  })
  el.classList.add('s16')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const tiers = [...el.querySelectorAll('.pl-tier')]
  const panel = el.querySelector('.pl-panel')
  const rows = [...el.querySelectorAll('.pl-row')]
  const kcal = tiers.map((c) => c.querySelector('.pl-kcal span'))

  return {
    id: '16-plan',
    label: '健康方案',
    at: 32,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([el.querySelector('.pl-tiers'), panel], t, { y: 22, s: 0.99 })

      const ksel = seg(t, 0.34, 0.26, 'outBack')
      tiers.forEach((c, i) => {
        const k = seg(t, 0.1 + i * 0.07, 0.3, 'outCubic')
        const sel = i === 1
        c.style.opacity = String(k * (sel ? 1 : 0.6))
        c.style.transform = `translate3d(${14 * (1 - k)}px, 0, 0) scale(${sel ? 1 + 0.05 * ksel : 1 - 0.03 * ksel})`
        c.style.background = sel ? 'var(--accent-soft)' : 'var(--surface)'
        kcal[i].textContent = counter(seg(t, 0.2 + i * 0.06, 0.3, 'outQuart'), 0, TIERS[i].kcal)
      })

      rows.forEach((r, i) => {
        const k = seg(t, 0.22 + i * 0.025, 0.16, 'outCubic')
        r.style.opacity = String(k)
        r.style.transform = `translate3d(0, ${16 * (1 - k)}px, 0)`
      })
    },
  }
}
