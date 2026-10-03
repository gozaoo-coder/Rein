/**
 * 训练总结页 mask 渐隐实测（读渲染像素，不信计算样式）。
 * 运行：REIN_E2E_URL=http://localhost:1430 node scripts/colorlab/audit_summary_mask.mjs
 *
 * 为什么必须读像素：项目里已经踩过三次「读计算样式自己算对比度/尺寸」的错误模型
 * （probe_dark_pairs / 见 2026-10-03.md）—— 同一个元素能给出两个互相矛盾的答案。
 * mask-image 是否真的把末段溶掉，只有截图上的像素知道。
 *
 * 查两件事：
 *  1. 折叠线**之上**取一点（正文）应是全不透明；
 *  2. 折叠线**之下**取一点（正文区末尾）应明显更淡 —— 证明渐隐在起作用。
 * 若两点亮度一样，说明 mask 没生效，末段是被 Dock 硬切的（那正是要修的观感问题）。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-audit-mask-${Date.now()}`

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

let DEBUG_PORT = 9337
let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1400)
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    const target = await res.json()
    await sleep(300)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        p.resolve(m.result ?? m.error)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true })
    await cdp('Page.navigate', { url: `${APP}/#/sports/plans/ppl-push` })
    await sleep(3000)
    await evalJS(`(() => {
      let s = document.getElementById('__e2e-stable')
      if (!s) { s = document.createElement('style'); s.id = '__e2e-stable'
        s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
        document.head.appendChild(s) }
      return true
    })()`)

    // 直接把 store 推到 summary：省掉逐组模拟（这里要测的是版式，不是口径）
    await evalJS(`(async () => {
      const { usePlanStore } = await import('/src/stores/plan.ts')
      const { useSessionStore } = await import('/src/stores/session.ts')
      const p = usePlanStore(); await p.ensureLoaded()
      const plan = p.byId('ppl-push')
      const s = useSessionStore()
      await s.start(plan)
      for (const e of plan.exercises) {
        for (let i = 0; i < e.sets; i++) {
          if (s.phase === 'summary') break
          if (s.phase === 'warmup') { s.completeWarmup(); continue }
          if (s.phase === 'rest') { s.skipRest(); continue }
          if (e.kind !== 'strength') { s.skipCurrentSet(); continue }
          s.setWeight(50 + i * 2.5); s.setReps(8); s.completeSet()
        }
        if (s.phase === 'rest') s.skipRest()
      }
      // 若还没到 summary（时序差异），直接把剩余组标为完成
      let guard = 0
      while (s.phase !== 'summary' && guard++ < 200) {
        if (s.phase === 'rest') { s.skipRest(); continue }
        if (s.phase === 'warmup') { s.completeWarmup(); continue }
        const ex = s.currentEx
        if (ex?.kind === 'strength') { s.setWeight(50); s.setReps(8); s.completeSet() }
        else s.skipCurrentSet()
      }
      return s.phase
    })()`)
    await sleep(1500)

    const geom = await evalJS(`(() => {
      const q = (s) => document.querySelector(s)
      const info = (s) => {
        const el = q(s)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          sel: s, h: Math.round(r.height),
          scrollH: el.scrollHeight, clientH: el.clientHeight,
          flex: cs.flex, minH: cs.minHeight, display: cs.display,
        }
      }
      const sb = q('.scrollbody')
      return {
        // 逐层量：滚动失效时能立刻看出是哪一层把内容压回去了
        layers: ['.session-page', '.scrollbody', '.rubber-layer', '.sumpane']
          .map(info).filter(Boolean),
        mask: getComputedStyle(sb).maskImage?.slice(0, 60) ?? '',
        edgeBottom: getComputedStyle(sb).getPropertyValue('--edge-fade-bottom'),
        scrollTop: sb.scrollTop,
        scrollHeight: sb.scrollHeight,
        clientHeight: sb.clientHeight,
      }
    })()`)
    console.log('几何:', JSON.stringify(geom, null, 1))

    /**
     * 末段可达性。这一屏**本来就该一屏装下**（设计如此：环 + 指标 + 进步在首屏，
     * 明细与建议紧随其后），所以这里断言的是「末段落在底簇之上」，
     * 而不是「能滚动」——后者会把一个正确的版式判成失败。
     *
     * 曾经的坑：子项用 `flex: 1` 时被压进父级高度，超出部分被裁掉且滚不动，
     * 症状是末段被 Dock 压住、划不到。现在 `flex: 1 0 auto` 后内容按实际高度排布。
     * 若哪天内容又长到装不下，M1（scrollHeight > clientHeight 时能滚）会自动接上。
     */
    const lastCard = await evalJS(`(() => {
      const cards = [...document.querySelectorAll('.sumpane .blockcard')]
      const el = cards[cards.length - 1]
      if (!el) return null
      const r = el.getBoundingClientRect()
      const sb = document.querySelector('.scrollbody').getBoundingClientRect()
      return {
        title: el.querySelector('h3')?.textContent?.trim() ?? '',
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        sbBottom: Math.round(sb.bottom),
      }
    })()`)
    const dockTop = await evalJS(`Math.round(document.querySelector('.ctrl-dock')?.getBoundingClientRect().top ?? 1e9)`)
    console.log('末段卡片:', JSON.stringify(lastCard), 'dockTop=', dockTop)
    ok('M1 末段（下次建议）落在底簇之上，内容够得到',
      lastCard != null && lastCard.bottom <= dockTop + 1,
      JSON.stringify(lastCard))

    // 若内容确实超一屏（数据更多的课程），滚动必须可用 —— 这条留作回归守卫
    const scrollInfo = await evalJS(`(() => {
      const sb = document.querySelector('.scrollbody')
      return { sh: sb.scrollHeight, ch: sb.clientHeight }
    })()`)
    if (scrollInfo.sh > scrollInfo.ch + 1) {
      const scrolled = await evalJS(`(() => {
        const sb = document.querySelector('.scrollbody')
        sb.scrollTop = sb.scrollHeight
        const card = [...document.querySelectorAll('.sumpane .blockcard')].pop()
        const dock = document.querySelector('.ctrl-dock')
        return {
          scrollTop: sb.scrollTop,
          lastBottom: card?.getBoundingClientRect().bottom ?? null,
          dockTop: dock?.getBoundingClientRect().top ?? null,
        }
      })()`)
      console.log('超一屏，滚到底:', JSON.stringify(scrolled))
      ok('M2 超一屏时滚到底末段进入底簇之上',
        scrolled.lastBottom != null && scrolled.dockTop != null && scrolled.lastBottom <= scrolled.dockTop + 1,
        JSON.stringify(scrolled))
    } else {
      ok('M2 本屏一屏装下（无滚动需求）', true, `scrollHeight=${scrollInfo.sh}`)
    }
    await evalJS(`(() => { document.querySelector('.scrollbody').scrollTop = 0; return true })()`)
    await sleep(200)

    /**
     * 截一张全页图再按 y 采样：Page.captureScreenshot 的 clip 用**文档坐标**，
     * 而渐隐是按**元素盒内的 y** 算的（mask 跟着 .scrollbody 一起被裁），
     * 所以两套坐标必须先对齐，否则采到的不是折叠线上下那两个点。
     */
    /**
     * 渐隐实测：**滚到底**再采（那才是渐隐该起作用的时刻 —— 内容末端正贴着
     * 折叠线）。只截视口（captureBeyondViewport 会把 mask 一起拉长，
     * 量到的是被拉稀后的假渐变）。
     */
    await evalJS(`(() => {
      const sb = document.querySelector('.scrollbody')
      sb.scrollTop = sb.scrollHeight
      return true
    })()`)
    await sleep(400)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    // 在页面里用 canvas 解码这张图（避免 Node 侧引图像库）
    const samples = await evalJS(`(async () => {
      const img = new Image()
      img.src = 'data:image/png;base64,${shot.data}'
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width; cv.height = img.height
      const cx = cv.getContext('2d', { willReadFrequently: true })
      cx.drawImage(img, 0, 0)
      const at = (y) => [...cx.getImageData(Math.floor(cv.width / 2), Math.floor(y), 1, 1).data].slice(0, 3)
      const sb = document.querySelector('.scrollbody')
      const sbR = sb.getBoundingClientRect()
      const fade = 54 + 26 // --edge-fade-bottom = dock-h(54) + 26，与 .scrollbody 的 padding 同源
      const out = { imgH: img.height, fadePx: fade }
      // 三点都在 dock 上方的正文带上：渐隐带上沿之上 / 渐隐中段 / 折叠线处
      out.aboveY = Math.round(sbR.top + sbR.height - fade - 34)
      out.midY   = Math.round(sbR.top + sbR.height - fade * 0.5)
      out.belowY = Math.round(sbR.top + sbR.height - 3)
      out.above = at(out.aboveY)
      out.mid = at(out.midY)
      out.below = at(out.belowY)
      return out
    })()`)
    console.log('像素采样:', JSON.stringify(samples, null, 1))

    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    const lAbove = lum(samples.above)
    const lMid = lum(samples.mid)
    const lBelow = lum(samples.below)
    console.log(`亮度：折叠线上 ${lAbove.toFixed(1)} / 渐隐中段 ${lMid.toFixed(1)} / 折叠线处 ${lBelow.toFixed(1)}`)
    // 中段必须落在上沿与折叠线之间（渐变是单调的）；折叠线处应明显更淡
    const monotonic = lMid < lAbove && lMid >= lBelow - 3
    ok('M3 渐隐是单调渐变而非硬切', monotonic,
      `${lAbove.toFixed(1)} → ${lMid.toFixed(1)} → ${lBelow.toFixed(1)}`)
    ok('M4 折叠线处明显淡于正文带（内容溶进背景）', lBelow < lAbove - 4,
      `${lBelow.toFixed(1)} vs ${lAbove.toFixed(1)}`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) process.exit(1)
  } catch (e) {
    console.error('审计中断:', e.message)
    process.exit(1)
  } finally {
    edge.kill()
  }
}

main()
