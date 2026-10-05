/**
 * 沉浸层 ⇄ 悬浮条 开合专项验证（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：node scripts/e2e-immerse-toggle.mjs（前置：npm run dev 已在 1420）
 *
 * 覆盖：开始课程进入沉浸层（不改变 hash）/ 收起 → 沉浸层隐藏 + 悬浮条回归 /
 * 悬浮条恢复沉浸 → 沉浸层再开 / 放弃会话后沉浸层与悬浮条归位。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

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

const DEBUG_PORT = await freePort()

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOW_TIER = process.env.REIN_E2E_LOW === '1'

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50), pollMs = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(pollMs)
  }
  throw new Error(`等待超时: ${label}`)
}

const layerVisible = `(() => { const el = document.querySelector('.session-layer'); return !!el && el.classList.contains('is-open') && Number(getComputedStyle(el).opacity) > 0.99 })()`
const wbarVisible = `(() => { const el = document.querySelector('.wdock-root'); return !!el && el.getClientRects().length > 0 })()`

// ---------- 启动无头 Edge ----------
const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${USER_DATA}`,
  '--no-first-run',
  '--window-size=420,860',
  APP + '/#/sports',
], { stdio: 'ignore' })

try {
  // 等 CDP 端口
  let targets = null
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      targets = await res.json()
      if (targets?.some((t) => t.type === 'page')) break
    } catch {}
    await sleep(300)
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result ?? m)
      pending.delete(m.id)
    }
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await sleep(2500)
  await cdp('Emulation.setCPUThrottlingRate', { rate: LOW_TIER ? 4 : 1 })
  await evalJS(`document.querySelector('.up-x')?.click()`)
  if (process.env.REIN_E2E_LOW === '1') {
    await evalJS(`localStorage.setItem('rein.perf.v1','low'); location.reload()`)
    await sleep(2200)
  }

  /* ---------- T1. 开始课程 → 沉浸层打开，hash 不变（不走路由） ---------- */
  await waitFor(`!!document.querySelector('.card li .play')`, 15000, '课程卡渲染')
  await evalJS(`document.querySelector('.card li .play')?.click()`)
  await waitFor(layerVisible, 8000, '沉浸层打开')
  const hash1 = await evalJS('location.hash')
  ok('T1 开始课程开沉浸层且 hash 不变', !hash1.includes('session'), hash1)

  /* ---------- T2. 收起 → 壳与 Dock 落点侧先就位，收尾零位移（落位溶解） ---------- */
  await evalJS(`(() => {
    window.__reinMorphFrames = []
    let last = 0
    const sample = (now) => {
      if (document.documentElement.dataset.immersive === 'returning') return
      if (last) window.__reinMorphFrames.push(now - last)
      last = now
      if (window.__reinMorphFrames.length >= 200) return
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    document.querySelector('.ctrl-top .min')?.click()
  })()`)
  await sleep(120)
  const t2mid = await evalJS(`(() => {
    const bar = document.querySelector('.wdock-root')
    return {
      state: document.documentElement.dataset.immersive,
      measuring: bar?.classList.contains('immersive-measuring') ?? false,
      barOpacity: bar ? Number(getComputedStyle(bar).opacity) : -1,
      dockOpacity: document.querySelector('.dock') ? Number(getComputedStyle(document.querySelector('.dock')).opacity) : -1,
      reserve: getComputedStyle(document.documentElement).getPropertyValue('--wbar-reserve').trim(),
      pad: parseFloat(getComputedStyle(document.querySelector('.page')).paddingBottom),
    }
  })()`)
  ok('T2 收起前半程进入 closing 态', t2mid.state === 'closing', JSON.stringify(t2mid))
  ok('T2 收起前半程 Dock 与壳就位可见（被形变壳盖住，落点侧先就位）', t2mid.measuring && t2mid.barOpacity === 1 && t2mid.dockOpacity === 1 && !!t2mid.reserve, JSON.stringify(t2mid))
  await sleep(LOW_TIER ? 420 : 580) // 等形变收尾 + 落位溶解
  const t2end = await evalJS(`(() => {
    const bar = document.querySelector('.wdock-root')
    const dock = document.querySelector('.dock')
    return {
      state: document.documentElement.dataset.immersive,
      barOpacity: bar ? Number(getComputedStyle(bar).opacity) : -1,
      barTranslate: bar ? getComputedStyle(bar).translate : 'none',
      barAnim: bar ? getComputedStyle(bar).animationName : 'none',
      dockOpacity: dock ? Number(getComputedStyle(dock).opacity) : -1,
      dockAnim: dock ? getComputedStyle(dock).animationName : 'none',
      pad: parseFloat(getComputedStyle(document.querySelector('.page')).paddingBottom),
    }
  })()`)
  ok('T2 收起完成后 Dock 原位显形（无滑入动画）', (t2end.state === 'ready' || t2end.state === 'returning') && t2end.barOpacity === 1 && t2end.barTranslate === 'none' && t2end.barAnim === 'none' && t2end.dockOpacity === 1 && t2end.dockAnim === 'none', JSON.stringify(t2end))
  ok('T2 收起后页面安全区同段恢复', t2end.pad >= t2mid.pad, JSON.stringify({ mid: t2mid.pad, end: t2end.pad }))
  const frameStats = await evalJS(`(() => {
    const values = window.__reinMorphFrames.filter((v) => v < 1000)
    values.sort((a,b) => a-b)
    const at = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
    return { frames: values.length, p50: at(0.5), p95: at(0.95), max: values.at(-1) ?? 0, dropped: values.filter((v) => v > 32).length }
  })()`)
  const collapseFrameOk = frameStats.p95 <= 40 && frameStats.dropped / Math.max(1, frameStats.frames) <= 0.1
  ok(LOW_TIER ? 'T2 4× CPU 低功耗档收起 p95 ≤ 40ms 且掉帧率 ≤ 10%' : 'T2 收起 p95 ≤ 40ms 且掉帧率 ≤ 10%', collapseFrameOk, JSON.stringify(frameStats))
  const t2layer = await evalJS(layerVisible)
  const t2barOpacity = await evalJS(`Number(getComputedStyle(document.querySelector('.wdock-root')).opacity)`)
  ok('T2 收起后沉浸层关闭', !t2layer)
  ok('T2 收起后悬浮条完全恢复', t2barOpacity === 1, String(t2barOpacity))

  /* ---------- T3. 悬浮条恢复沉浸 → 沉浸层再开（同一实例复用） ---------- */
  await evalJS(`(() => {
    window.__reinExpandFrames = []
    let last = 0
    const sample = (now) => {
      if (last) window.__reinExpandFrames.push(now - last)
      last = now
      if (window.__reinExpandFrames.length >= 200) return
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    document.querySelector('.wdock-root [aria-label="恢复沉浸模式"]')?.click()
  })()`)
  await waitFor(layerVisible, 8000, '沉浸层再开')
  await sleep(LOW_TIER ? 260 : 360)
  const expandStats = await evalJS(`(() => {
    const values = window.__reinExpandFrames.filter((v) => v < 1000)
    values.sort((a,b) => a-b)
    const at = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
    return { frames: values.length, p50: at(0.5), p95: at(0.95), max: values.at(-1) ?? 0, dropped: values.filter((v) => v > 32).length }
  })()`)
  const expandFrameOk = expandStats.p95 <= 40 && expandStats.dropped / Math.max(1, expandStats.frames) <= 0.1
  ok(LOW_TIER ? 'T3 4× CPU 低功耗档展开 p95 ≤ 40ms 且掉帧率 ≤ 10%' : 'T3 展开 p95 ≤ 40ms 且掉帧率 ≤ 10%', expandFrameOk, JSON.stringify(expandStats))
  ok('T3 悬浮条恢复沉浸层', true)

  /* ---------- T4. 收起动画进行中再展开（重入）→ 沉浸层保持可见 ---------- */
  await evalJS(`document.querySelector('.ctrl-top .min')?.click()`)
  await sleep(120) // 动画中途
  await evalJS(`document.querySelector('.wdock-root [aria-label="恢复沉浸模式"]')?.click()`)
  await sleep(700)
  const t4 = await evalJS(layerVisible)
  ok('T4 收起途中再展开，沉浸层最终可见', t4)

  /* ---------- T5. 结束放弃 → 沉浸层关闭，悬浮条消失（会话已关） ---------- */
  await evalJS(`document.querySelector('.ctrl-top .end')?.click()`)
  await sleep(500)
  await evalJS(`[...document.querySelectorAll('.card-wrap .opt')].find(b => b.textContent.includes('放弃本次训练'))?.click()`)
  await sleep(1200)
  const t5layer = await evalJS(layerVisible)
  const t5bar = await evalJS(wbarVisible)
  ok('T5 放弃后沉浸层关闭', !t5layer)
  ok('T5 放弃后悬浮条消失（无进行中会话）', !t5bar)

  const pass = results.filter((r) => r.pass).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exitCode = pass === results.length ? 0 : 1
} finally {
  proc.kill()
  ws?.close()
}
