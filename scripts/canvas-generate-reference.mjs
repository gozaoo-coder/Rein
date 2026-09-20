/**
 * canvas-generate-reference：操作无限画布（localhost:8091），生成 16:9、2K 分辨率的三视图参考图。
 *
 * 步骤：
 * 1. 连接画布 CDP
 * 2. 检查当前画布状态（是否有项目/节点）
 * 3. 创建新项目（或复用现有）
 * 4. 添加三视图参考图节点（正面/背面/侧面）
 * 5. 设置画布为 16:9、2K（2560×1440）
 * 6. 导出为 PNG
 *
 * 运行：node scripts/canvas-generate-reference.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'

const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!BROWSER) throw new Error('no browser')

const SITE = 'http://localhost:8091/canvas'
const OUT = resolve(process.cwd(), 'scripts/shots/canvas-reference')
const USER_DATA = `${OUT}/.profile-${Date.now()}`
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9600 + (process.pid % 200)

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

const proc = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-background-timer-throttling',
  `--user-data-dir=${USER_DATA}`,
  '--no-first-run',
  '--window-size=1920,1080',
  'about:blank',
], { stdio: 'ignore' })

try {
  await connect(SITE)
  await sleep(3000)

  // 检查画布状态
  const status = await evalJS(`(async () => {
    const open = indexedDB.open('infinite-canvas')
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej })
    const tx = db.transaction('app_state', 'readonly')
    const rawReq = tx.objectStore('app_state').get('infinite-canvas:canvas_store')
    const raw = await new Promise((res) => (rawReq.onsuccess = () => res(rawReq.result)))
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    return {
      projects: parsed?.state?.projects?.length ?? 0,
      projectTitles: parsed?.state?.projects?.map(p => p.title) ?? [],
      firstProjectNodes: parsed?.state?.projects?.[0]?.nodes?.length ?? 0,
      nodeKinds: parsed?.state?.projects?.[0]?.nodes?.reduce((a, n) => { a[n.kind] = (a[n.kind] || 0) + 1; return a }, {}) ?? {},
    }
  })()`)
  console.log('画布状态:', JSON.stringify(status, null, 2))

  // 截图当前画布
  await shot('canvas-current')

  // 如果画布为空，创建新项目
  if (status.projects === 0) {
    console.log('画布为空，创建新项目...')
    await evalJS(`(async () => {
      const open = indexedDB.open('infinite-canvas')
      const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = rej })
      const tx = db.transaction('app_state', 'readwrite')
      const store = tx.objectStore('app_state')
      const newProject = {
        id: 'ref-' + Date.now(),
        title: '三视图参考图',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: 'lines',
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
      }
      const raw = await new Promise((res) => {
        const req = store.get('infinite-canvas:canvas_store')
        req.onsuccess = () => res(req.result)
      })
      let parsed = { version: 0, state: { projects: [] } }
      try { parsed = JSON.parse(raw) } catch { /* ignore */ }
      parsed.state.projects = [newProject, ...(parsed.state.projects || [])]
      store.put(JSON.stringify(parsed), 'infinite-canvas:canvas_store')
      await new Promise((res) => (tx.oncomplete = res))
      return 'created'
    })()`)
    console.log('项目已创建，刷新页面...')
    await cdp('Page.reload')
    await sleep(3000)
    await shot('canvas-after-create')
  }

  // 检查画布 UI 元素
  const ui = await evalJS(`(() => {
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean)
    const inputs = [...document.querySelectorAll('input')].map(i => i.placeholder || i.type).filter(Boolean)
    return { buttons: buttons.slice(0, 20), inputs: inputs.slice(0, 10) }
  })()`)
  console.log('画布 UI:', JSON.stringify(ui, null, 2))

} finally {
  proc.kill()
}
