/**
 * 更新说明的 Markdown 渲染 —— 真浏览器核验。
 * 目标：`.notes` / `.up-notes` 里必须是**块级元素**（ul/li/b），
 * 而不是原样的 `**` `##` 与 `- ` 字面量（那正是本次要修的 bug）。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:5180'
const OUT = `${process.env.TEMP ?? '/tmp'}/rein-shots/update-notes`
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))
if (!EDGE) throw new Error('找不到 Edge')
fs.mkdirSync(OUT, { recursive: true })

const PORT = 9333
const tmp = fs.mkdtempSync(`${process.env.TEMP ?? '/tmp'}/edge-notes-`)
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + tmp,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=430,930', 'about:blank',
])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws
let id = 0
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
    setTimeout(() => {
      if (pending.delete(msgId)) reject(new Error(`CDP 超时：${method}`))
    }, 30000)
  })
}
async function evalJS(expr) {
  const r = await cdp('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 异常')
  return r.result?.value
}
function save(name, b64) {
  if (b64) fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, 'base64'))
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  save(name, r?.data)
}

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name} — ${detail}`) }
}

try {
  await sleep(1200)
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  }
  await new Promise((r) => { ws.onopen = r })

  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 930, deviceScaleFactor: 1, mobile: true,
  })

  console.log('\n=== 启动更新提示（UpdatePrompt）===')
  // 必须在**整页加载**时看：提示由 App.vue 的 onMounted → autoCheckIfDue() 打开，
  // 换 hash 不会重挂（第一次写这条探针就踩了这个坑 —— 那条路上永远看不到提示）。
  // mock 的更新设置是模块内存态，整页加载即重置，所以每次都能跑到「到点了」这一支。
  await cdp('Page.navigate', { url: `${APP}/#/` })
  await sleep(3600)
  const prompt = await evalJS(`
    const el = document.querySelector('.up-notes')
    if (!el) return { present: false, hasCard: !!document.querySelector('.up-card') }
    return {
      present: true,
      lis: el.querySelectorAll('li').length,
      bold: el.querySelectorAll('b').length,
      text: el.textContent,
    }
  `)
  ok('启动提示出现说明区', prompt.present, JSON.stringify(prompt))
  if (prompt.present) {
    ok('提示里的说明也是块级列表', prompt.lis >= 2, `li=${prompt.lis}`)
    ok('** 强调渲染成 <b>', prompt.bold >= 1, `b=${prompt.bold}`)
    ok('提示里不再有 ** 与 ##', !prompt.text.includes('**') && !prompt.text.includes('##'), prompt.text.slice(0, 120))
    console.log(`      渲染后文本：${prompt.text.replace(/\n+/g, ' | ').slice(0, 150)}`)
    await shot('startup-prompt')
  }

  console.log('\n=== 更新页（设置 › 软件更新）===')
  await evalJS(`
    const x = document.querySelector('.up-x'); if (x) x.click(); return true
  `)
  await sleep(400)
  await evalJS(`
    location.hash = '#/settings/update'; return true
  `)
  await sleep(2000)
  await evalJS(`
    const b = [...document.querySelectorAll('button')].find((e) => e.textContent.includes('检查更新'))
    if (!b) return false
    b.click(); return true
  `)
  await sleep(1800)

  const notes = await evalJS(`
    const el = document.querySelector('.card.hl .notes, .notes')
    if (!el) return { present: false }
    return {
      present: true,
      html: el.innerHTML,
      text: el.textContent,
      lis: el.querySelectorAll('li').length,
      bold: el.querySelectorAll('b').length,
      cls: el.className,
    }
  `)
  ok('更新页出现说明区', notes.present, JSON.stringify(notes))
  if (notes.present) {
    ok('说明渲染成块级列表（有 <li>）', notes.lis >= 2, `li=${notes.lis}`)
    ok('** 强调渲染成 <b>', notes.bold >= 1, `b=${notes.bold}`)
    ok('不再有原样的 ** 字面量', !notes.text.includes('**'), notes.text.slice(0, 120))
    ok('不再有原样的 ## 字面量', !notes.text.includes('##'), notes.text.slice(0, 120))
    ok('不再有原样的 - 列表前缀', !notes.text.includes('- 更新链路'), notes.text.slice(0, 120))
    console.log(`      渲染后文本：${notes.text.replace(/\n+/g, ' | ').slice(0, 150)}`)
  }
  await shot('update-page')

  const errs = await evalJS(`return (window.__errors ?? []).slice(0, 3)`)
  ok('页面无未捕获异常', !errs || errs.length === 0, JSON.stringify(errs))

  console.log(`\n${fail === 0 ? '✔ 全部通过' : '✖ 有失败'} · ${pass} 项通过 / ${fail} 项失败 · 截图在 ${OUT}`)
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  edge.kill()
}
process.exit(fail === 0 ? 0 : 1)
