import './brand.css'
import { createScenes } from './scenes/index.js'
import { setVisible } from './lib/anim.js'

/**
 * 主时钟。
 *
 * record.mjs 只认三样东西：`window.__promo.duration`、`window.__promo.seek(t)`、
 * `window.__promo.ready`。场景不参与全局排序 —— 每个场景自己把本地时间映射到画面，
 * 主时钟只负责「该不该显示」与「把本地时间喂给它」。这样加/删场景不会影响别人的节奏。
 */
const stage = document.getElementById('stage')
const scenes = createScenes().sort((a, b) => a.at - b.at)

for (const s of scenes) {
  s.el.classList.add('scene')
  s.el.dataset.scene = s.id
  stage.appendChild(s.el)
}

/** 场景之间不允许重叠：at 是绝对秒，dur 是它的时长。 */
for (let i = 1; i < scenes.length; i += 1) {
  const prev = scenes[i - 1]
  const gap = scenes[i].at - (prev.at + prev.dur)
  if (Math.abs(gap) > 0.001) {
    console.warn(`[promo] 场景时间轴有空隙/重叠：${prev.id} 结束于 ${prev.at + prev.dur}s，${scenes[i].id} 起于 ${scenes[i].at}s`)
  }
}

const last = scenes[scenes.length - 1]
const duration = last ? last.at + last.dur : 0

function seek(T) {
  const t = Math.max(0, Math.min(T, duration))
  for (const s of scenes) {
    const local = t - s.at
    const on = local >= -1e-6 && local <= s.dur + 1e-6
    setVisible(s.el, on)
    if (on) s.seek(Math.max(0, local))
  }
  stage.dataset.t = t.toFixed(3)
}

window.__promo = {
  duration,
  fps: 60,
  beats: scenes.map((s) => ({ id: s.id, label: s.label, at: s.at, dur: s.dur })),
  seek,
  ready: true,
}

seek(0)

/** 浏览器里直接预览（?play）：用 rAF 走一遍，便于人工看节奏。 */
if (new URLSearchParams(location.search).has('play')) {
  const t0 = performance.now()
  const loop = () => {
    const T = ((performance.now() - t0) / 1000) % duration
    seek(T)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}
