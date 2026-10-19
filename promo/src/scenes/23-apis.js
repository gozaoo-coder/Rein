import { counter, seg } from '../lib/anim.js'
import { breathe, draw, pose, shell, sweep } from './_kit.js'
import './23-apis.css'

/**
 * 爆点 23 · 46.0–48.0s · 外部服务接口
 *
 * 重排（第 1 轮多条 major）：
 *  · 卡片按 5 行内容撑开，最后一行的落位动画在卡内结束（上一版「通知推送」掉出圆角下缘）；
 *  · 左卡与右卡等高；
 *  · 「文件访问」不再出现「蓝勾 + 未授权」的自相矛盾 —— 只有真的勾上才填蓝；
 *  · 右栏每行加一条**通道**细条：标题承诺「通道就开哪几条」，这里把它画出来。
 */
const ROWS = [
  { name: '日历只读', scope: '读取日程与忙闲', color: 'var(--accent)', on: true },
  { name: '课表读取', scope: '同步教务课表', color: 'var(--cat-class)', on: true },
  { name: '记账写入', scope: '写入一笔支出', color: 'var(--led-food)', on: true },
  { name: '文件访问', scope: '读写本地文件', color: 'var(--cat-general)', on: false },
  { name: '通知推送', scope: '发送提醒', color: 'var(--cat-general)', on: false },
]

const CHECK_LEN = 26

export function createScene() {
  const el = shell({
    n: 23,
    label: '外部服务接口',
    eyebrow: 'SERVICE API · 外部服务接口',
    title: '授权哪几条，通道就开哪几条',
    inner: `
      <div class="ap-stage">
        <div class="ap-list k-panel">
          <div class="ap-list-head"><b>权限清单</b><span>按需授权 · 随时可撤</span></div>
          ${ROWS.map(
            (r) => `
            <div class="ap-row" data-on="${r.on ? 1 : 0}">
              <span class="ap-box"><svg viewBox="0 0 30 26"><path d="M4 13 L11 20 L26 5" /></svg></span>
              <div class="ap-info"><b>${r.name}</b><span>${r.scope}</span></div>
              <span class="ap-state">${r.on ? '已授权' : '未授权'}</span>
            </div>`,
          ).join('')}
          <span class="k-sheen ap-sheen"></span>
        </div>

        <div class="ap-side k-panel">
          <div class="ap-count"><b class="ap-num num">0</b><span>项已授权</span></div>
          <div class="ap-chans">
            ${ROWS.map(
              (r) => `
              <div class="ap-chan" data-on="${r.on ? 1 : 0}" style="--c:${r.color}">
                <span class="ap-chan-name">${r.name}</span>
                <span class="ap-chan-track"><i></i></span>
              </div>`,
            ).join('')}
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s23')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const rows = [...el.querySelectorAll('.ap-row')]
  const boxes = rows.map((r) => r.querySelector('.ap-box'))
  const checks = boxes.map((b) => b.querySelector('path'))
  const states = [...el.querySelectorAll('.ap-state')]
  const chans = [...el.querySelectorAll('.ap-chan')]
  const num = el.querySelector('.ap-num')
  const sheen = el.querySelector('.ap-sheen')

  checks.forEach((c) => {
    c.style.strokeDasharray = String(CHECK_LEN)
  })

  return {
    id: '23-apis',
    label: '外部服务接口',
    at: 46,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)
      pose([el.querySelector('.ap-list'), el.querySelector('.ap-side')], t, { y: 22, s: 0.99 })

      const ks = ROWS.map((_, i) => seg(t, 0.16 + i * 0.06, 0.2, 'outCubic'))

      ROWS.forEach((r, i) => {
        const k = ks[i]
        rows[i].style.opacity = String(0.4 + 0.6 * k)
        // 只有真的勾上才填蓝 —— 未授权行必须是空框（第 1 轮审核的自相矛盾点）
        boxes[i].style.background = r.on && k > 0.35 ? 'var(--accent)' : 'var(--surface-2)'
        boxes[i].style.borderColor = r.on && k > 0.35 ? 'var(--accent)' : 'var(--line-strong)'
        draw(checks[i], r.on ? k : 0, CHECK_LEN)
        checks[i].style.opacity = String(r.on ? 1 : 0)
        states[i].style.opacity = String(seg(t, 0.22 + i * 0.06, 0.18))
      })

      chans.forEach((c, i) => {
        const on = c.dataset.on === '1'
        const fill = on ? seg(t, 0.24 + i * 0.06, 0.22, 'outCubic') : 0
        const bar = c.querySelector('i')
        bar.style.transform = `scaleX(${fill})`
        bar.style.background = on ? 'var(--c)' : 'transparent'
        c.querySelector('.ap-chan-name').style.color = on && fill > 0.5 ? 'var(--text-1)' : 'var(--text-3)'
      })

      num.textContent = counter(seg(t, 0.16, 0.46, 'outQuart'), 0, 3)
      el.querySelector('.ap-side').style.transform += ` scale(${breathe(t, { amp: 0.004, speed: 2.2 })})`
      sweep(sheen, t, { start: 0.6, dur: 0.85, opacity: 0.6 })
    },
  }
}
