import { seg } from '../lib/anim.js'
import { frac, pose, shell } from './_kit.js'
import './26-workbench.css'

/**
 * 爆点 26 · 52.0–54.0s · 桌面工作台
 *
 * 重排（第 2 轮 blocker）：上一版一屏四个抢焦点的块（截图 + 半透明命令面板 + 左导航浮卡 +
 * 右统计卡），浮卡还把截图里已有的信息又复述了一遍。
 *
 * 现在**只有一个主角**：真实的工作台窗口本身。标题说「窗口一宽，工作台就展开」，
 * 画面就给出证据 —— 窗口从 760px 形变到 1240px；命令面板收成一块**实底**的紧凑面板，
 * 停在窗口下缘（不压主体中心）。左导航浮卡与右统计卡整块删除。
 */
const COMMANDS = ['记一餐', '新建待办', '开始专注 25 分钟', '打开记账', '排明天的日程']

export function createScene() {
  const el = shell({
    n: 26,
    label: '桌面工作台',
    eyebrow: 'WORKBENCH · 桌面工作台',
    title: '窗口一宽，工作台就展开',
    inner: `
      <div class="wb-stage">
        <div class="wb-win win">
          <div class="chrome"><i></i><i></i><i></i><span>Rein · 工作台</span></div>
          <div class="body"><img src="/shots/workbench-home.png" alt="" /><span class="sheen"></span></div>
        </div>

        <div class="wb-pal">
          <div class="wb-pal-search">
            <span class="wb-key">Ctrl K</span>
            <span class="wb-pal-q">想做什么？</span>
            <span class="wb-caret"></span>
          </div>
          <div class="wb-pal-row"><i></i><b></b><span>↵</span></div>
        </div>
      </div>
    `,
  })
  el.classList.add('s26')

  const head = el.querySelector('.k-head')
  const rule = el.querySelector('.k-rule')
  const win = el.querySelector('.wb-win')
  const pal = el.querySelector('.wb-pal')
  const row = el.querySelector('.wb-pal-row')
  const rowText = el.querySelector('.wb-pal-row b')
  const caret = el.querySelector('.wb-caret')

  return {
    id: '26-workbench',
    label: '桌面工作台',
    at: 52,
    dur: 2,
    el,
    seek: (t) => {
      pose([head, rule], t)

      // 「窄 → 宽」：窗口宽度就是这一拍的论点本身
      const kw = seg(t, 0.06, 0.42, 'outCubic')
      win.style.width = `${Math.round(760 + (1240 - 760) * kw)}px`
      win.style.opacity = String(seg(t, 0.04, 0.24))

      // 命令面板：实底、紧凑，落在窗口下缘（不遮主体）
      const kp = seg(t, 0.42, 0.24, 'outBack')
      pal.style.opacity = String(seg(t, 0.42, 0.2))
      pal.style.transform = `translate3d(-50%, ${22 * (1 - kp)}px, 0)`

      // 停留段：候选行循环 + 光标闪烁。换行做一次极短的交叉淡化 ——
      // 60fps 下读得出「换了一条」，而不是硬切闪一下。
      const pos = frac((t - 0.66) * 0.26) * COMMANDS.length
      const idx = Math.min(COMMANDS.length - 1, Math.floor(pos))
      const inRow = pos - Math.floor(pos)
      rowText.textContent = COMMANDS[idx]
      const fade = Math.min(1, Math.min(inRow, 1 - inRow) / 0.16)
      row.style.opacity = String(0.5 + 0.5 * fade)
      row.style.transform = `translate3d(0, ${(1 - fade) * 3}px, 0)`
      caret.style.opacity = frac(t * 2.4) < 0.5 ? '1' : '0.15'
    },
  }
}
