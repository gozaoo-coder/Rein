/**
 * preview-anatomy：把三视图资产渲染成一张 PNG 供人工审验。
 *
 * 用法：
 *   node scripts/preview-anatomy.mjs
 *   node scripts/preview-anatomy.mjs --highlight=chest-up:3,delt-ant:2,quads-rec:3
 *   node scripts/preview-anatomy.mjs --layer=1        只画浅层
 *   node scripts/preview-anatomy.mjs --nofill         只描边，便于看分区边界
 * 输出：scripts/shots/anatomy-preview/preview.png
 */
import {spawn} from 'node:child_process'
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Buffer} from 'node:buffer'

const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!BROWSER) throw new Error('no browser')

const ROOT = resolve(process.cwd())
const OUT = resolve(ROOT, 'scripts/shots/anatomy-preview')
mkdirSync(OUT, {recursive: true})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9500 + (process.pid % 200)

const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return null
  const eq = hit.indexOf('=')
  return eq < 0 ? true : hit.slice(eq + 1)
}

const highlights = (() => {
  const raw = arg('highlight')
  if (typeof raw !== 'string') return {}
  return Object.fromEntries(raw.split(',').map((kv) => kv.split(':')))
})()
const maxLayer = arg('layer')
const noFill = arg('nofill')

let ws
let nextId = 1
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolveP) => {
    const id = nextId++
    pending.set(id, {resolve: resolveP})
    ws.send(JSON.stringify({id, method, params}))
  })
}
async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true})
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
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result ?? m.error)
      pending.delete(m.id)
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', {url})
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch {
      /* navigating */
    }
    await sleep(200)
  }
  throw new Error('page load timeout')
}

const read = (n) => readFileSync(resolve(ROOT, `src/assets/muscles/rein/${n}.svg`), 'utf8')

/** 注入着色：激活档位按 l1/l2/l3，未激活为 idle；超过 --layer 的深层直接移除 */
function paint(svg) {
  let out = svg.replace(/<g class="(m|a)" data-m="([^"]+)" data-layer="(\d+)" data-depth="([^"]+)">/g, (all, kind, key, layer, depth) => {
    const lv = highlights[key]
    const cls = kind === 'a' ? 'a' : lv ? `l${lv}` : 'idle'
    return `<g class="${kind} ${cls}" data-m="${key}" data-layer="${layer}" data-depth="${depth}">`
  })
  if (maxLayer !== null) {
    const limit = Number(maxLayer)
    out = out.replace(/<g class="(m|a) [^"]*" data-m="[^"]+" data-layer="(\d+)"/g, (all, kind, layer) =>
      Number(layer) > limit ? `${all} hidden=""` : all,
    )
  }
  return out
}

const view = (name, label) =>
  `<div class="view"><div class="wrap">${paint(read(name))}</div><h2>${label}</h2></div>`

const size = Number(arg('size') || 300)
const only = arg('only')
const picked = only ? [[String(only), {front: '正面', back: '背面', side: '侧面'}[String(only)]]] : [['front', '正面'], ['back', '背面'], ['side', '侧面']]

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f2efe9; font-family: "Segoe UI", sans-serif; }
  h1 { font-size: 17px; margin: 0 0 16px; }
  .row { display: flex; gap: 26px; align-items: flex-start; }
  .view { text-align: center; }
  .view h2 { font-size: 13px; letter-spacing: 4px; color: #8a7f70; margin: 8px 0 0; }
  .wrap { width: ${size}px; background: #fbf9f5; border: 1px solid #e0d8cc; border-radius: 12px; padding: 8px; }
  svg { width: 100%; height: auto; display: block; }
  [hidden] { display: none; }

  #base path { fill: rgba(126,116,100,.30); stroke: rgba(88,68,52,.5); stroke-width: 1.1; stroke-linejoin: round; }
  g.m path { stroke-linejoin: round; }
  g.m.idle path { fill: rgba(183,92,74,.32); stroke: rgba(96,44,28,.42); stroke-width: .85; }
  g.m.l1 path { fill: #8fbf7a; stroke: rgba(40,70,30,.4); stroke-width: .85; }
  g.m.l2 path { fill: #4f9142; stroke: rgba(30,60,22,.45); stroke-width: .85; }
  g.m.l3 path { fill: #2e7d32; stroke: rgba(20,48,16,.5); stroke-width: .85; }
  g.a path { fill: rgba(120,108,132,.30); stroke: rgba(70,60,84,.35); stroke-width: .7; }
  ${noFill ? 'g.m path, g.a path { fill: none !important; stroke: rgba(150,60,40,.85); stroke-width: .55; }' : ''}
</style></head><body>
  <h1>三视图预览${Object.keys(highlights).length ? `（高亮: ${Object.entries(highlights).map(([k, v]) => `${k}=${v}`).join(' ')}）` : ''}${maxLayer !== null ? `（只显示到 layer ${maxLayer}）` : ''}</h1>
  <div class="row">
    ${picked.map(([n, l]) => view(n, l)).join('')}
  </div>
</body></html>`
writeFileSync(`${OUT}/preview.html`, html)

const proc = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${OUT}/.profile-${Date.now()}`,
    '--no-first-run',
    '--window-size=1100,1000',
    'about:blank',
  ],
  {stdio: 'ignore'},
)

try {
  await connect(`file:///${OUT.replace(/\\/g, '/')}/preview.html`)
  await sleep(900)
  await shot('preview')
} finally {
  proc.kill()
}
