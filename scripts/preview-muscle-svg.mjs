/**
 * preview-muscle-svg：生成 SVG 预览图，展示当前肌群分区效果。
 * 用无头 Edge + CDP 渲染 SVG 并截图。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'

const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!BROWSER) throw new Error('no browser')

const ROOT = resolve(process.cwd())
const OUT = resolve(ROOT, 'scripts/shots/muscle-preview')
const USER_DATA = `${OUT}/.profile-${Date.now()}`
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9400 + (process.pid % 200)

let ws
let nextId = 1
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolveP) => {
    const id = nextId++
    pending.set(id, { resolve: resolveP })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

async function shot(name, full = false) {
  const r = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
  })
  if (!r?.data) return
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`截图 ${OUT}/${name}.png`)
}

async function connect(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      break
    } catch {
      await sleep(250)
    }
  }
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
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
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch { /* navigate */ }
    await sleep(200)
  }
  throw new Error('page load timeout')
}

const proc = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-background-timer-throttling',
  `--user-data-dir=${USER_DATA}`,
  '--no-first-run',
  '--window-size=1200,900',
  'about:blank',
], { stdio: 'ignore' })

try {
  // 读取 SVG 内容
  const frontSvg = readFileSync(resolve(ROOT, 'src/assets/muscles/rein/front.svg'), 'utf8')
  const backSvg = readFileSync(resolve(ROOT, 'src/assets/muscles/rein/back.svg'), 'utf8')

  // 生成预览 HTML（内联 SVG）
  const previewHtml = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; padding: 20px; background: #f5f5f5; font-family: sans-serif; }
  .container { display: flex; gap: 40px; justify-content: center; }
  .view { text-align: center; }
  .view h2 { margin: 10px 0; font-size: 18px; color: #333; }
  .svg-wrap { width: 400px; height: 800px; background: white; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  svg { width: 100%; height: 100%; }
  #base path { fill: rgba(120, 110, 95, 0.3); stroke: rgba(90, 70, 55, 0.5); stroke-width: 1; }
  .m path { fill: rgba(183, 92, 74, 0.4); stroke: rgba(90, 45, 30, 0.6); stroke-width: 1.5; }
  .m[data-m="chest-up"] path { fill: rgba(255, 0, 0, 0.6); }
  .m[data-m="delt-ant"] path { fill: rgba(0, 200, 0, 0.6); }
  .m[data-m="abs"] path { fill: rgba(0, 100, 255, 0.6); }
  .m[data-m="biceps"] path { fill: rgba(255, 165, 0, 0.6); }
  .m[data-m="lats"] path { fill: rgba(128, 0, 128, 0.6); }
  .m[data-m="glute-max"] path { fill: rgba(255, 192, 203, 0.6); }
</style>
</head>
<body>
  <h1>肌群激活图预览（rnbpa 数据）</h1>
  <div class="container">
    <div class="view">
      <h2>正面</h2>
      <div class="svg-wrap">${frontSvg}</div>
    </div>
    <div class="view">
      <h2>背面</h2>
      <div class="svg-wrap">${backSvg}</div>
    </div>
  </div>
</body>
</html>
  `
  writeFileSync(`${OUT}/preview.html`, previewHtml)

  await connect(`file://${OUT}/preview.html`)
  await sleep(1000)
  await shot('preview', true)
} finally {
  proc.kill()
}
