import { clamp, seg } from '../lib/anim.js'
import { breathe, frac, pose, shell, wave } from './_kit.js'
import './20-recording.css'

/**
 * 爆点 20 · 40.0–42.0s · 录音纪要
 * 声波条随录音确定性起伏，右侧实时转写逐字出现，结束落成一张纪要卡。
 * 停留段：声波持续摆动、录音计时走动、纪要卡呼吸。
 */
const BARS = 44
const TEXT = '今天定了发布节奏：本周先内部试用，下周一灰度，月底全量。'

const pad = (n) => String(n).padStart(2, '0')

export function createScene() {
  const el = shell({
    n: 20,
    label: '录音纪要',
    inner: `
      <div class="k-wrap rc-wrap">
        <p class="k-micro">RECORDING · 录音纪要</p>
        <h2 class="k-title">边说边转写，说完就是纪要</h2>
        <div class="rc-stage">
          <div class="rc-wave k-panel">
            <div class="rc-rec"><i class="rc-dot"></i><span>录音中</span><b class="rc-timer num">00:00</b></div>
            <div class="rc-bars">${Array.from({ length: BARS }, () => '<span class="rc-bar"><i></i></span>').join('')}</div>
            <div class="rc-axis"><span>00:00</span><span>01:00</span></div>
          </div>
          <div class="rc-side">
            <div class="rc-transcript k-panel">
              <span class="rc-cap">实时转写</span>
              <p class="rc-text"><span class="rc-typed"></span><span class="rc-caret"></span></p>
            </div>
            <div class="rc-summary k-panel">
              <div class="rc-sum-head"><span class="rc-sum-ico">纪</span><b>会议纪要</b><span class="chip soft-accent">已生成</span></div>
              <p class="rc-sum-row">· 发布节奏：内部试用 → 灰度 → 全量</p>
              <p class="rc-sum-row">· 时间点：本周内测，下周灰度，月底全量</p>
            </div>
          </div>
        </div>
      </div>
    `,
  })
  el.classList.add('s20')

  const wrap = el.querySelector('.rc-wrap')
  const cap = el.querySelector('.beat-cap')
  const bars = [...el.querySelectorAll('.rc-bar > i')]
  const typed = el.querySelector('.rc-typed')
  const caret = el.querySelector('.rc-caret')
  const timer = el.querySelector('.rc-timer')
  const recDot = el.querySelector('.rc-dot')
  const summary = el.querySelector('.rc-summary')
  const transcript = el.querySelector('.rc-transcript')

  return {
    id: '20-recording',
    label: '录音纪要',
    at: 40,
    dur: 2,
    el,
    seek: (t) => {
      pose([wrap, cap], t)

      const env = 1 - seg(t, 1.08, 0.4, 'outCubic')
      wave(bars, t, { speed: 5.2, spread: 0.5, base: 0.12, amp: 0.86, env: 0.35 + 0.65 * env })

      const n = Math.round(seg(t, 0.2, 0.86, 'outCubic') * TEXT.length)
      typed.textContent = TEXT.slice(0, n)
      caret.style.opacity = n >= TEXT.length ? String(0.9 * (1 - seg(t, 1.15, 0.3))) : frac(t * 2.6) < 0.5 ? '1' : '0.12'

      const secs = Math.floor(seg(t, 0.14, 1.6, 'linear') * 78)
      timer.textContent = `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`
      recDot.style.opacity = String(0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 6)))
      recDot.style.transform = `scale(${1 + 0.18 * Math.sin(t * 6)})`

      const ks = seg(t, 1.06, 0.34, 'outCubic')
      summary.style.opacity = String(ks)
      summary.style.transform = `translate3d(0, ${26 * (1 - ks)}px, 0) scale(${breathe(t, { amp: 0.006, speed: 2.2 })})`
      transcript.style.transform = `translate3d(0, ${-14 * ks}px, 0)`
      transcript.style.opacity = String(clamp(1 - 0.35 * ks))
    },
  }
}
