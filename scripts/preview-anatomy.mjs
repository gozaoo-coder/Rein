/**
 * preview-anatomy：渲染自绘三视图（src/assets/muscles/rein/{front,back,side}.svg）
 * 为单张 PNG 预览，供人工审验。
 *
 * 用法：node scripts/preview-anatomy.mjs [--highlight chest-up:3,delt-ant:2]
 * 输出：scripts/shots/anatomy-preview/preview.png
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
const OUT = resolve(ROOT, 'scripts/shots/anatomy-preview')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9500 + (process.pid % 200)

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
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`截图 ${OUT}/${name}.png`)
}
async function connect(url) {
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); break } catch { await sleep(250) }
  }
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result ?? m.error); pending.delete(m.id) }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try { if ((await evalJS('document.readyState')) === 'complete') return } catch { /* nav */ }
    await sleep(200)
  }
  throw new Error('page load timeout')
}

// 高亮参数：--highlight chest-up:3,delt-ant:2 → 演示激活着色
const hlArg = process.argv.find((a) => a.startsWith('--highlight'))
const highlights = hlArg ? Object.fromEntries(hlArg.split('=')[1].split(',').map((kv) => kv.split(':'))) : {}

const front = readFileSync(resolve(ROOT, 'src/assets/muscles/rein/front.svg'), 'utf8')
const back = readFileSync(resolve(ROOT, 'src/assets/muscles/rein/back.svg'), 'utf8')
const side = readFileSync(resolve(ROOT, 'src/assets/muscles/rein/side.svg'), 'utf8')

/** 给指定 data-m 分区加激活 class */
function paint(svg) {
  return svg.replace(/<g class="m" data-m="([^"]+)">/g, (all, key) => {
    const lv = highlights[key]
    return `<g class="m ${lv ? `l${lv}` : 'idle'}" data-m="${key}">`
  })
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f2efe9; font-family: "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .row { display: flex; gap: 28px; align-items: flex-start; }
  .view { text-align: center; }
  .view h2 { font-size: 14px; letter-spacing: 4px; color: #8a7f70; margin: 8px 0 0; }
  .wrap { width: 300px; background: #fbf9f5; border: 1px solid #e0d8cc; border-radius: 12px; padding: 8px; }
  svg { width: 100%; height: auto; display: block; }
  #base path { fill: rgba(120,110,95,.34); stroke: rgba(90,70,55,.55); stroke-width: 1.6; stroke-linejoin: round; }
  #base path.garment { fill: rgba(120,110,95,.16); }
  #base path.hair { fill: rgba(120,110,95,.5); }
  #base path.detail { fill: none; stroke: rgba(90,70,55,.45); stroke-width: 1.2; }
  .m.idle path { fill: rgba(183,92,74,.3); stroke: rgba(90,45,30,.4); stroke-width: 1.4; stroke-linejoin: round; }
  .m.l1 path { fill: #7fb069; }
  .m.l2 path { fill: #4f9142; }
  .m.l3 path { fill: #2e7d32; }
</style></head><body>
  <h1>自绘三视图预览${Object.keys(highlights).length ? `（高亮: ${Object.entries(highlights).map(([k, v]) => `${k}=${v}`).join(' ')}）` : ''}</h1>
  <div class="row">
    <div class="view"><div class="wrap">${paint(front)}</div><h2>正面</h2></div>
    <div class="view"><div class="wrap">${paint(back)}</div><h2>背面</h2></div>
    <div class="view"><div class="wrap">${paint(side)}</div><h2>侧面</h2></div>
  </div>
</body></html>`
writeFileSync(`${OUT}/preview.html`, html)

const proc = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT}/.profile-${Date.now()}`,
  '--no-first-run',
  '--window-size=1100,1000',
  'about:blank',
], { stdio: 'ignore' })

try {
  await connect(`file:///${OUT.replace(/\\/g, '/')}/preview.html`)
  await sleep(800)
  await shot('preview')
} finally {
  proc.kill()
}
