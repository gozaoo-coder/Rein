import { clamp, seg } from '../lib/anim.js'
import { frac, pose, shell } from './_kit.js'
import './03-conversation.css'

/**
 * 爆点 03 · 6.0–8.0s · 对话即操作
 * 左一句用户话泡，右一段 AI 回复流式逐字出现（字符数用 seg 自己算）。
 * 停留段靠光标闪烁 + 打字机继续推进 + "输入中"三点起伏保持有动。
 */
const USER_LINE = '帮我把明天安排满'
const AI_LINE = '好。明天 8:00 晨跑 5 公里，9:30 组会，12:00 午餐记一餐，20:00 复习英语 —— 全部排进日程。'

export function createScene() {
  const el = shell({
    n: 3,
    label: '对话即操作',
    inner: `
      <div class="k-wrap c-wrap">
        <p class="k-micro">CONVERSATION · 对话即操作</p>
        <h2 class="k-title">说一句，它就直接动手</h2>
        <div class="chat k-panel">
          <div class="chat-chrome"><i></i><i></i><i></i><span>Rein · AI</span></div>
          <div class="chat-body">
            <div class="msg msg-user">
              <span class="avatar av-user">我</span>
              <p class="bub bub-user">${USER_LINE}</p>
            </div>
            <div class="msg msg-ai">
              <p class="bub bub-ai">
                <span class="typing"><i></i><i></i><i></i></span>
                <span class="ai-txt"></span><span class="caret"></span>
              </p>
              <span class="avatar av-ai">R<i class="av-ring"></i></span>
            </div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s03')

  const wrap = el.querySelector('.c-wrap')
  const cap = el.querySelector('.beat-cap')
  const userMsg = el.querySelector('.msg-user')
  const aiMsg = el.querySelector('.msg-ai')
  const txt = el.querySelector('.ai-txt')
  const caret = el.querySelector('.caret')
  const typing = el.querySelector('.typing')
  const dots = [...el.querySelectorAll('.typing i')]
  const ring = el.querySelector('.av-ring')

  return {
    id: '03-conversation',
    label: '对话即操作',
    at: 6,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const ku = seg(t, 0.16, 0.4, 'outBack')
      userMsg.style.opacity = String(clamp(ku * 1.2))
      userMsg.style.transform = `translate3d(${-30 * (1 - ku)}px, 0, 0) scale(${0.94 + 0.06 * ku})`

      const ka = seg(t, 0.28, 0.4, 'outBack')
      aiMsg.style.opacity = String(clamp(ka * 1.2))
      aiMsg.style.transform = `translate3d(${30 * (1 - ka)}px, 0, 0) scale(${0.94 + 0.06 * ka})`

      const n = Math.round(seg(t, 0.38, 0.74, 'outCubic') * AI_LINE.length)
      txt.textContent = AI_LINE.slice(0, n)

      const started = seg(t, 0.34, 0.12)
      typing.style.opacity = String(clamp(1 - started))
      dots.forEach((d, i) => {
        const v = Math.sin(t * 9 - i * 0.9) * 0.5 + 0.5
        d.style.transform = `translate3d(0, ${-4 * v}px, 0)`
        d.style.opacity = String(0.35 + 0.65 * v)
      })

      const done = n >= AI_LINE.length
      caret.style.opacity = done ? String(0.9 * (1 - seg(t, 1.2, 0.3))) : frac(t * 2.6) < 0.5 ? '1' : '0.1'

      const pr = frac((t - 0.2) * 0.7)
      ring.style.transform = `translate(-50%, -50%) scale(${1 + pr * 0.7})`
      ring.style.opacity = String(0.5 * (1 - pr))
    },
  }
}
