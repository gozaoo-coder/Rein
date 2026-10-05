/**
 * 沉浸层开合 · 对齐与细节专项（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：node scripts/e2e-immerse-align.mjs（前置：npm run dev 已在 1420）
 *
 * 针对 2026-10-05 三项退出/进入修复做逐帧采样断言（e2e-immerse-toggle 只管开关
 * 状态，这里管「动画长什么样」）：
 *   A1 默认档收起：closing 态壳/浮条就位可见、圆角逐帧椭圆补偿（无全屏方角豁底、
 *      无落位压扁：末帧视觉圆角 ≈ 悬浮条圆角）、落位溶解（壳面淡出与浮条原位交棒）；
 *   A2 默认档展开：画布延后到末段才浮现（半程无拉伸文字）、圆角补偿反向成立；
 *   A3 丰富档（animejs layout 编舞）：内容块交错入场（opacity/transform 被驱动）；
 *   A4 丰富档收起：内容块离场、落位溶解与零位移收尾同默认档。跑完不还原档位
 *   （一次性 profile），对照用例请用 e2e-immerse-toggle。
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

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50), pollMs = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(pollMs)
  }
  throw new Error(`等待超时: ${label}`)
}

const layerVisible = `(() => { const el = document.querySelector('.session-layer'); return !!el && el.classList.contains('is-open') && Number(getComputedStyle(el).opacity) > 0.99 })()`

/** 逐帧采样器：页面内 rAF 记录器，window.__alignSamples 供断言读取 */
const SAMPLER = (span) => `(() => {
  window.__alignSamples = []
  const t0 = performance.now()
  const sample = (now) => {
    const cs = (el) => (el ? getComputedStyle(el) : null)
    const L = cs(document.querySelector('.session-layer'))
    const B = cs(document.querySelector('.wdock-root'))
    const D = cs(document.querySelector('.dock'))
    const C = cs(document.querySelector('.session-page'))
    const T = cs(document.querySelector('.ctrl-top'))
    const P = cs(document.querySelector('.pane'))
    window.__alignSamples.push({
      t: Math.round(now - t0),
      state: document.documentElement.dataset.immersive,
      layerOpacity: L ? Number(L.opacity) : -1,
      layerRadius: L ? L.borderRadius : '',
      layerTransform: L ? L.transform : 'none',
      barOpacity: B ? Number(B.opacity) : -1,
      barTranslate: B ? B.translate : 'none',
      barAnim: B ? B.animationName : 'none',
      dockOpacity: D ? Number(D.opacity) : -1,
      canvasOpacity: C ? Number(C.opacity) : -1,
      canvasVisibility: C ? C.visibility : '',
      ctrlTopDisplay: T ? T.display : 'missing',
      ctrlTopOpacity: T ? Number(T.opacity) : -1,
      ctrlTopTransform: T ? T.transform : 'none',
      paneDisplay: P ? P.display : 'missing',
      paneOpacity: P ? Number(P.opacity) : -1,
    })
    if (now - t0 < ${span}) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
})()`

const ELLIPSE = /^([\d.]+)px \/ ([\d.]+)px$/

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
  await evalJS(`document.querySelector('.up-x')?.click()`)

  await waitFor(`!!document.querySelector('.card li .play')`, 15000, '课程卡渲染')
  await evalJS(`document.querySelector('.card li .play')?.click()`)
  await waitFor(layerVisible, 8000, '沉浸层打开（默认档）')
  await sleep(800) // 等展开动画完全落定

  /* ---------- A1. 默认档收起：就位显形 / 圆角补偿 / 落位溶解 ---------- */
  const barRadius = await evalJS(`parseFloat(getComputedStyle(document.querySelector('.dock-body')).borderTopLeftRadius)`)
  await evalJS(SAMPLER(950))
  await evalJS(`document.querySelector('.ctrl-top .min')?.click()`)
  await sleep(1100)
  const a1 = await evalJS(`window.__alignSamples ?? []`)
  const closing = a1.filter((s) => s.state === 'closing')
  const ellipses = a1.filter((s) => ELLIPSE.test(s.layerRadius))
  ok('A1 收起进入 closing 态', closing.length > 3, `closing 采样 ${closing.length}`)
  ok('A1 closing 期壳（TabBar）就位可见', closing.length > 0 && closing.every((s) => s.dockOpacity === 1), JSON.stringify([...new Set(closing.map((s) => s.dockOpacity))]))
  ok('A1 closing 期悬浮条原位可见（落点底）', closing.length > 0 && closing.every((s) => s.barOpacity === 1 && s.barTranslate === 'none' && s.barAnim === 'none'), JSON.stringify([...new Set(closing.map((s) => `${s.barOpacity}/${s.barAnim}`))]))
  ok('A1 圆角走椭圆补偿（含 " / " 形态）', ellipses.length > 2, `椭圆采样 ${ellipses.length}`)
  const plain = a1.filter((s) => s.layerRadius && s.layerRadius !== '0px' && !ELLIPSE.test(s.layerRadius))
  ok('A1 无「裸圆角」帧（全屏方角豁底已除）', plain.length === 0, JSON.stringify(plain.slice(0, 2).map((s) => s.layerRadius)))
  // 末帧视觉圆角 = 写入值 × 当前 scale，应贴回悬浮条圆角（matrix 与 matrix3d 都认）
  const scaleOf = (tf) => {
    if (tf.startsWith('matrix3d(')) {
      const n = tf.slice(9, -1).split(',').map((v) => parseFloat(v))
      return { a: n[0], d: n[5] }
    }
    const n = tf.slice(7, -1).split(',').map((v) => parseFloat(v))
    return { a: n[0], d: n[3] }
  }
  let landing = null
  for (let i = a1.length - 1; i >= 0; i--) {
    const m = ELLIPSE.exec(a1[i].layerRadius)
    if (m && a1[i].layerTransform.startsWith('matrix')) {
      const { a, d } = scaleOf(a1[i].layerTransform)
      landing = { rx: parseFloat(m[1]) * a, ry: parseFloat(m[2]) * d }
      break
    }
  }
  ok('A1 落位帧视觉圆角贴合悬浮条', !!landing && Math.abs(landing.rx - barRadius) <= 4 && Math.abs(landing.ry - barRadius) <= 4, `bar=${barRadius} visual=${landing ? `${landing.rx.toFixed(1)}/${landing.ry.toFixed(1)}` : 'null'}`)
  const crossfade = a1.filter((s) => s.layerOpacity > 0.02 && s.layerOpacity < 0.98 && s.barOpacity === 1)
  ok('A1 落位溶解：壳面原地淡出交棒', crossfade.length >= 2, `溶解段采样 ${crossfade.length}`)
  ok('A1 收尾无滑入（浮条全程零位移零动画）', a1.every((s) => s.barAnim === 'none' && s.barTranslate === 'none'), JSON.stringify([...new Set(a1.map((s) => s.barAnim))]))
  ok('A1 最终回到 ready', a1.slice(-3).some((s) => s.state === 'ready'), `末态 ${a1.at(-1)?.state}`)

  /* ---------- A2. 默认档展开：画布末段浮现 + 圆角反向补偿 ---------- */
  await evalJS(SAMPLER(800))
  await evalJS(`document.querySelector('.wdock-root [aria-label="恢复沉浸模式"]')?.click()`)
  await sleep(950)
  const a2 = await evalJS(`window.__alignSamples ?? []`)
  const start2 = a2.findIndex((s) => s.layerOpacity > 0.02) // 形变首帧（此前层关闭态）
  ok('A2 展开形变启动', start2 >= 0, `首帧索引 ${start2}`)
  const t02 = a2[start2]?.t ?? 0
  // M3 emphasized 前段极快（~25% 时间已到 75% 进度）：画布「未浮现」的窗口
  // 只在形变头 ~110ms，之后开始淡入——这里只断言窗口内 opacity≈0
  const early = a2.filter((s) => s.t >= t02 + 30 && s.t <= t02 + 110)
  ok('A2 展开前段画布未浮现（无拉伸文字）', early.length > 3 && early.every((s) => s.canvasOpacity < 0.1), JSON.stringify(early.map((s) => +s.canvasOpacity.toFixed(2))))
  const mid = a2.filter((s) => s.t >= t02 + 150 && s.t <= t02 + 300)
  ok('A2 展开中段画布渐入（晚淡入在走）', mid.length > 3 && mid.some((s) => s.canvasOpacity > 0.3 && s.canvasOpacity < 0.95), JSON.stringify(mid.map((s) => +s.canvasOpacity.toFixed(2))))
  ok('A2 展开圆角补偿反向成立', a2.filter((s) => ELLIPSE.test(s.layerRadius)).length > 2)
  const opened = [...a2].reverse().find((s) => s.layerOpacity > 0.98)
  ok('A2 展开完成画布完全显现', !!opened && opened.canvasOpacity > 0.95 && opened.canvasVisibility === 'visible', JSON.stringify(opened && { t: opened.t, op: opened.canvasOpacity }))

  /* ---------- A3. 丰富档：animejs layout 内容编舞（展开向） ---------- */
  await evalJS(`document.querySelector('.ctrl-top .end')?.click()`)
  await sleep(500)
  await evalJS(`[...document.querySelectorAll('.card-wrap .opt')].find(b => b.textContent.includes('放弃本次训练'))?.click()`)
  await sleep(1200)
  await evalJS(`localStorage.setItem('rein.motion.v1','rich'); location.reload()`)
  await sleep(2500)
  await waitFor(`document.documentElement.dataset.motion === 'rich'`, 6000, '丰富档生效')
  await evalJS(`document.querySelector('.up-x')?.click()`)
  await waitFor(`!!document.querySelector('.card li .play')`, 15000, '课程卡渲染（丰富档）')
  await evalJS(SAMPLER(1250))
  await evalJS(`document.querySelector('.card li .play')?.click()`)
  await waitFor(layerVisible, 8000, '沉浸层打开（丰富档）')
  await sleep(1400)
  const a3 = await evalJS(`window.__alignSamples ?? []`)
  const start3 = a3.find((s) => s.ctrlTopDisplay !== 'missing')
  ok('A3 丰富档展开启动', a3.some((s) => s.state === 'open' && s.layerOpacity > 0.02), `采样 ${a3.length}`)
  const minCtrl = Math.min(...a3.map((s) => s.ctrlTopOpacity).filter((v) => v >= 0))
  ok('A3 内容块被编舞驱动（opacity 被拉低再回满）', minCtrl < 0.4, `ctrl-top 最低 opacity ${minCtrl.toFixed(2)}`)
  ok('A3 内容块入场带位移（transform 被驱动）', a3.some((s) => s.ctrlTopTransform !== 'none' && s.layerOpacity > 0.02), JSON.stringify(a3.find((s) => s.ctrlTopTransform !== 'none')?.ctrlTopTransform))
  const settled = a3.at(-1)
  ok('A3 内容块最终就位可见', settled && settled.ctrlTopDisplay !== 'none' && settled.ctrlTopOpacity > 0.95 && settled.paneDisplay !== 'none' && settled.paneOpacity > 0.95, JSON.stringify(settled && { ctrl: `${settled.ctrlTopDisplay}/${settled.ctrlTopOpacity.toFixed(2)}`, pane: `${settled.paneDisplay}/${settled.paneOpacity.toFixed(2)}` }))

  /* ---------- A4. 丰富档收起：内容先汇出、壳后收缩、落位溶解一致 ---------- */
  await evalJS(SAMPLER(1100))
  await evalJS(`document.querySelector('.ctrl-top .min')?.click()`)
  await sleep(1300)
  const a4 = await evalJS(`window.__alignSamples ?? []`)
  const a4closing = a4.filter((s) => s.state === 'closing')
  ok('A4 丰富档收起进入 closing 态', a4closing.length > 3, `closing 采样 ${a4closing.length}`)
  const a4closed = a4.filter((s) => s.state !== 'open').at(-1)
  ok('A4 内容块离场（display 收起）', (a4closing.some((s) => s.ctrlTopDisplay === 'none' && s.paneDisplay === 'none')) || (!!a4closed && a4closed.ctrlTopDisplay === 'none' && a4closed.paneDisplay === 'none'), JSON.stringify(a4closed && { ctrl: a4closed.ctrlTopDisplay, pane: a4closed.paneDisplay }))
  ok('A4 丰富档落位溶解与默认档一致', a4.filter((s) => s.layerOpacity > 0.02 && s.layerOpacity < 0.98 && s.barOpacity === 1).length >= 2)
  ok('A4 收尾浮条零位移零动画', a4.every((s) => s.barAnim === 'none' && s.barTranslate === 'none'), JSON.stringify([...new Set(a4.map((s) => s.barAnim))]))
  ok('A4 最终回到 ready', a4.slice(-3).some((s) => s.state === 'ready'), `末态 ${a4.at(-1)?.state}`)

  const pass = results.filter((r) => r.pass).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exitCode = pass === results.length ? 0 : 1
} finally {
  proc.kill()
  ws?.close()
}
