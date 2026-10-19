import { clamp, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './07-memory.css'

/**
 * 爆点 07 · 14.0–16.0s · 长期记忆
 * 左侧一枚"记忆"芯片呼吸，一句话从记忆层浮上来注入对话，关键词被点亮。
 * 停留段：芯片光圈扩散、链路上光点往返、关键词高亮微亮。
 */
const LINE = [
  { text: '上次你说要在' },
  { text: '周五', hl: true },
  { text: '前交' },
  { text: '初稿', hl: true },
  { text: '，已经记下了。' },
]

export function createScene() {
  const el = shell({
    n: 7,
    label: '长期记忆',
    inner: `
      <div class="k-wrap mem-wrap">
        <p class="k-micro">MEMORY · 长期记忆</p>
        <h2 class="k-title">它记得你上次说过的话</h2>
        <div class="mem-stage">
          <div class="mem-chip">
            <span class="mem-ring"></span>
            <span class="k-ico mem-ico">忆</span>
            <div class="mem-chip-txt"><b>记忆</b><span>长期上下文</span></div>
          </div>
          <div class="mem-link"><i></i><i></i><i></i></div>
          <div class="chat k-panel mem-chat">
            <div class="chat-chrome"><i></i><i></i><i></i><span>Rein · AI</span></div>
            <div class="mem-body">
              <span class="mem-tag">记忆注入</span>
              <p class="mem-say">${LINE.map(
                (s) => (s.hl ? `<span class="hlw"><i class="hlb"></i><em>${s.text}</em></span>` : s.text),
              ).join('')}</p>
              <p class="mem-reply">明白，我把它放进了今天的计划。</p>
            </div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s07')

  const wrap = el.querySelector('.mem-wrap')
  const cap = el.querySelector('.beat-cap')
  const chip = el.querySelector('.mem-chip')
  const ring = el.querySelector('.mem-ring')
  const linkDots = [...el.querySelectorAll('.mem-link i')]
  const chat = el.querySelector('.mem-chat')
  const say = el.querySelector('.mem-say')
  const reply = el.querySelector('.mem-reply')
  const tag = el.querySelector('.mem-tag')
  const hlbs = [...el.querySelectorAll('.hlb')]

  return {
    id: '07-memory',
    label: '长期记忆',
    at: 14,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const kc = seg(t, 0.12, 0.4, 'outCubic')
      chip.style.opacity = String(kc)
      chip.style.transform = `translate3d(${-30 * (1 - kc)}px, 0, 0) scale(${breathe(t, { amp: 0.02, speed: 2.2 })})`

      const pr = frac((t - 0.16) * 0.95)
      ring.style.transform = `translate(-50%, -50%) scale(${1 + pr * 1.1})`
      ring.style.opacity = String(0.55 * (1 - pr))

      linkDots.forEach((d, i) => {
        const x = frac((t - 0.2) * 0.5 + i / 3) * 150
        d.style.transform = `translate3d(${x}px, 0, 0)`
        d.style.opacity = String(seg(t, 0.24, 0.24) * (0.25 + 0.75 * (1 - Math.abs(x / 150 - 0.5) * 2)))
      })

      const kch = seg(t, 0.16, 0.44, 'outCubic')
      chat.style.opacity = String(kch)
      chat.style.transform = `translate3d(${30 * (1 - kch)}px, ${breathe(t, { amp: 3, speed: 1.8 }) - 1}px, 0)`

      const ks = seg(t, 0.36, 0.44, 'outCubic')
      say.style.opacity = String(ks)
      say.style.transform = `translate3d(0, ${36 * (1 - ks)}px, 0)`

      tag.style.opacity = String(seg(t, 0.4, 0.28))

      hlbs.forEach((h, i) => {
        const p = seg(t, 0.42 + i * 0.09, 0.24, 'outCubic')
        h.style.clipPath = `inset(0 ${clamp((1 - p) * 100)}% 0 0)`
      })

      const kr = seg(t, 0.8, 0.4, 'outCubic')
      reply.style.opacity = String(kr * 0.95)
      reply.style.transform = `translate3d(0, ${16 * (1 - kr)}px, 0)`
    },
  }
}
