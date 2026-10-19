import { seg } from '../lib/anim.js'
import { breathe, pose, shell } from './_kit.js'
import './17-timetable.css'

/**
 * 爆点 17 · 34.0–36.0s · 课表教务
 * 周视图课表格子逐格落课，教务同步图标在右上转一圈，右侧课详情卡上浮。
 * 停留段：同步图标持续旋转、课块高光扫过、详情卡呼吸。
 */
const DAYS = ['周一', '周二', '周三', '周四', '周五']
const PERIODS = ['一', '二', '三', '四', '五']

const LESSONS = {
  '1-1': { name: '数据结构', tone: 'a' },
  '2-2': { name: '高等数学', tone: 'b' },
  '2-4': { name: '概率论', tone: 'c' },
  '3-3': { name: '计算机组成原理', tone: 'd' },
  '4-3': { name: '线性代数', tone: 'b' },
  '5-1': { name: '大学英语', tone: 'a' },
}

export function createScene() {
  let cells = ''
  for (let p = 1; p <= 5; p += 1) {
    cells += `<span class="tb-period">第 ${PERIODS[p - 1]} 节</span>`
    for (let d = 1; d <= 5; d += 1) {
      const l = LESSONS[`${d}-${p}`]
      cells += l
        ? `<span class="tb-cell has-lesson tone-${l.tone}"><b>${l.name}</b></span>`
        : '<span class="tb-cell"></span>'
    }
  }

  const el = shell({
    n: 17,
    label: '课表教务',
    inner: `
      <div class="k-wrap tb-wrap">
        <p class="k-micro">TIMETABLE · 课表教务</p>
        <h2 class="k-title">课表从教务同步进来，就长在日历上</h2>
        <div class="tb-stage">
          <div class="tb-panel">
            <div class="tb-sync">
              <svg viewBox="0 0 48 48" class="tb-sync-ico">
                <path d="M38 24a14 14 0 1 1-4.1-9.9" />
                <path d="M38 8v8h-8" />
              </svg>
              <span class="tb-sync-txt">教务同步</span>
            </div>
            <div class="tb-grid">
              <span class="tb-corner"></span>
              ${DAYS.map((d) => `<span class="tb-day">${d}</span>`).join('')}
              ${cells}
            </div>
          </div>
          <div class="tb-detail k-panel">
            <span class="tb-flag">已同步</span>
            <h3>计算机组成原理</h3>
            <p class="tb-when">周三 · 第 3 节 · 10:05 – 11:40</p>
            <div class="tb-facts">
              <div><span>教室</span><b>A-302</b></div>
              <div><span>教师</span><b>张老师</b></div>
              <div><span>学分</span><b>3.0</b></div>
            </div>
            <div class="tb-actions"><span class="tb-act">加入待办</span><span class="tb-act tb-act--ghost">提醒我</span></div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s17')

  const wrap = el.querySelector('.tb-wrap')
  const cap = el.querySelector('.beat-cap')
  const lessons = [...el.querySelectorAll('.has-lesson')]
  const syncIco = el.querySelector('.tb-sync-ico')
  const detail = el.querySelector('.tb-detail')

  return {
    id: '17-timetable',
    label: '课表教务',
    at: 34,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      lessons.forEach((l, i) => {
        const k = seg(t, 0.14 + i * 0.05, 0.28, 'outBack')
        l.style.opacity = String(k)
        const pulse = 1 + 0.02 * Math.sin(t * 3 + i)
        l.style.transform = `translate3d(0, ${-22 * (1 - k)}px, 0) scale(${(0.9 + 0.1 * k) * pulse})`
      })

      syncIco.setAttribute('transform', `rotate(${(t * 300).toFixed(2)} 24 24)`)

      const kd = seg(t, 0.34, 0.4, 'outCubic')
      const br = breathe(t, { amp: 4, speed: 1.9 })
      detail.style.opacity = String(kd)
      detail.style.transform = `translate3d(${44 * (1 - kd)}px, ${br - 1}px, 0)`
    },
  }
}
