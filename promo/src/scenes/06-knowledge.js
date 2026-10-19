import { pathD, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell } from './_kit.js'
import './06-knowledge.css'

/**
 * 爆点 06 · 12.0–14.0s · 知识库
 * 一叠文件卡向中心聚拢，一条条向量线汇入检索框，命中的一张描边亮起。
 * 停留段：检索框内有扫描线往返、命中卡呼吸、线尾光点脉动。
 */
const STAGE_W = 1360
const STAGE_H = 520
const CARD_W = 320
const CARD_H = 104
const CARD_X = 4
const SEARCH_X = 768

const CARDS = [
  { name: '会议纪要', meta: '笔记 · 今天 10:20', ico: '记', color: 'var(--accent)', top: 24 },
  { name: '产品需求文档', meta: 'PDF · 命中', ico: 'P', color: 'var(--danger)', top: 138, hit: true },
  { name: '2026 计划', meta: '文件夹 · 8 个文件', ico: '夹', color: 'var(--cat-general)', top: 252 },
  { name: '周会录音', meta: '语音 · 12:30', ico: '录', color: 'var(--sto-asset)', top: 366 },
]

const SEARCH_Y = 260

export function createScene() {
  const lines = CARDS.map((c) => {
    const x0 = CARD_X + CARD_W
    const y0 = c.top + CARD_H / 2
    return [
      [x0, y0],
      [(x0 + SEARCH_X) / 2, y0],
      [SEARCH_X, SEARCH_Y],
    ]
  })

  const el = shell({
    n: 6,
    label: '知识库',
    inner: `
      <div class="k-wrap kb-wrap">
        <p class="k-micro">KNOWLEDGE · 知识库</p>
        <h2 class="k-title">资料喂进去，一句话就能查</h2>
        <div class="kb-stage">
          <svg class="kb-lines" viewBox="0 0 ${STAGE_W} ${STAGE_H}">
            ${lines.map((pts, i) => `<path class="kb-line" data-i="${i}" d="${pathD(pts, 1)}" />`).join('')}
          </svg>
          <div class="kb-cards">
            ${CARDS.map(
              (c) => `
              <div class="kb-card${c.hit ? ' is-hit' : ''}" style="top:${c.top}px">
                <span class="k-ico kb-ico" style="background:${c.color}">${c.ico}</span>
                <div class="kb-meta"><b>${c.name}</b><span>${c.meta}</span></div>
                ${c.hit ? '<span class="kb-flag">命中</span>' : ''}
              </div>`,
            ).join('')}
          </div>
          <div class="kb-search k-panel">
            <span class="kb-scan"></span>
            <div class="kb-q">
              <svg viewBox="0 0 24 24" class="kb-glass"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 L21 21" /></svg>
              <span class="kb-text">初稿什么时候交？</span><span class="kb-caret"></span>
            </div>
            <div class="kb-hit"><b>命中 1 条</b><span>产品需求文档 · 第 3 节</span></div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s06')

  const wrap = el.querySelector('.kb-wrap')
  const cap = el.querySelector('.beat-cap')
  const lineEls = [...el.querySelectorAll('.kb-line')]
  const cardEls = [...el.querySelectorAll('.kb-card')]
  const search = el.querySelector('.kb-search')
  const scan = el.querySelector('.kb-scan')
  const hit = el.querySelector('.kb-hit')
  const caret = el.querySelector('.kb-caret')

  return {
    id: '06-knowledge',
    label: '知识库',
    at: 12,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const ks = seg(t, 0.14, 0.42, 'outCubic')
      search.style.opacity = String(ks)
      search.style.transform = `translate3d(${40 * (1 - ks)}px, 0, 0)`

      cardEls.forEach((c, i) => {
        const k = seg(t, 0.14 + i * 0.08, 0.4, 'outCubic')
        const isHit = CARDS[i].hit
        const lift = isHit ? -14 * seg(t, 0.5, 0.24, 'outBack') : 0
        const br = isHit ? breathe(t, { amp: 0.014, speed: 2.3 }) : 1
        c.style.opacity = String(k)
        c.style.transform = `translate3d(${-80 * (1 - k)}px, ${lift}px, 0) scale(${br})`
        c.querySelector('.k-ico').style.transform = `scale(${0.8 + 0.2 * k})`
      })

      lineEls.forEach((l, i) => {
        const p = seg(t, 0.26 + i * 0.05, 0.22, 'outCubic')
        l.setAttribute('d', pathD(lines[i], p))
        l.style.opacity = String(0.2 + 0.65 * p)
      })

      const kh = seg(t, 0.46, 0.24)
      hit.style.opacity = String(kh)
      hit.style.transform = `translate3d(0, ${14 * (1 - kh)}px, 0)`

      const sy = frac((t - 0.2) * 0.72)
      scan.style.transform = `translate3d(0, ${sy * 200}px, 0)`
      scan.style.opacity = String(0.7 * (1 - Math.abs(sy - 0.5) * 1.2))

      caret.style.opacity = frac(t * 2.4) < 0.5 ? '1' : '0.15'
    },
  }
}
