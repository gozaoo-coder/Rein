/**
 * 无头 Edge + CDP 抓 JS 渲染文档页（火山文档站直接 fetch 内容为空）。
 * 运行：node scripts/fetch-doc.mjs <搜索词或URL> [最长输出字符]
 * 传 URL → 直接打开抓 innerText；传搜索词 → Bing 搜出链接列表供下一步选。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const target = process.argv[2] ?? ''
const maxChars = Number(process.argv[3] ?? 6000)
const USER_DATA = `${process.env.TEMP}/rein-doc-fetch-${Date.now()}`
const PORT = 9557

import { spawn } from 'node:child_process'

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
  if (r.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' })
  try {
    await sleep(1500)
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    const t = await res.json()
    await sleep(300)
    ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result ?? m.error); pending.delete(m.id) }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')

    const isUrl = /^https?:/.test(target)
    let url = target
    if (!isUrl) {
      url = `https://www.bing.com/search?q=${encodeURIComponent(target)}`
      await cdp('Page.navigate', { url })
      await sleep(3500)
      const links = await evalJS(`[...document.querySelectorAll('#b_results .b_algo')].slice(0,8).map(li => {
        const a = li.querySelector('a')
        return a ? (a.textContent.trim().slice(0,80) + ' ||| ' + a.href) : null
      }).filter(Boolean).join('\\n')`)
      console.log('=== 搜索结果 ===')
      console.log(links || '(无结果)')
      return
    }

    await cdp('Page.navigate', { url })
    // 等内容渲染（文档站 JS 渲染，轮询 innerText 长度稳定）
    let prev = 0
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      const len = await evalJS(`document.body?.innerText?.length ?? 0`)
      if (len > 500 && len === prev) break
      prev = len
    }
    if (process.env.MODE === 'links') {
      const links = await evalJS(`[...document.querySelectorAll('a[href*="/docs/6561/"]')]
        .map(a => a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40) + ' ||| ' + a.href)
        .filter((v, i, arr) => v && arr.indexOf(v) === i).join('\\n')`)
      console.log(links)
      return
    }
    const text = await evalJS(`document.body.innerText`)
    console.log(text.slice(0, maxChars))
  } finally {
    try { await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).then(list => {
      for (const p of list) fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`).catch(() => {})
    }) } catch {}
    edge.kill()
  }
}

main().catch((e) => { console.error('抓取失败:', e.message); process.exit(1) })
