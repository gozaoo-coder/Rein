/**
 * e2e-online-cost —— Rein 在线服务（模型下发 + 服务密钥 + 双端成本）端到端
 *
 * 为什么值得 e2e：这条链路的价值全在「服务端说了算」与「两端的账要能对上」上 ——
 * 密钥没填时按钮必须禁用、清单只列服务端给的模型、导入后模型卡要带「在线」徽章与单价、
 * 成本要同时显示本机估算与服务端权威值。这些联动单测照不出来。
 *
 * 剧本（浏览器 mock 模式，服务端的账由 mock 复刻同一结构）：
 *   1. 预置一条本机账本记录（2 元模型费 + 0.1 元流量费）→ 卡片显示「本机累计 ¥2.1000」
 *   2. 未填密钥时状态是「未配置服务密钥」，「获取模型列表」按钮禁用
 *   3. 填 rein_sk_… → 获取模型列表 → 出现服务端下发的 3 个模型与单价
 *   4. 导入所选 → 模型列表出现「在线」徽章 + 单价行，卡片状态变「已连接」
 *   5. 密钥填错（清空）→ 状态回到未配置，成本区仍显示本机账本
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-online-cost.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-online-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const DEBUG_PORT = 9800 + (process.pid % 150)

let ws
let nextId = 1
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${SHOTS}/${name}.png`)
}

/** 深色主题下也拍一张：卡片只用 token，换主题不该出现「没有背景色」这类破相 */
async function shotDark(name) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(350)
  await shot(name)
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(250)
}

async function connect(url) {
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
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

/* ---------------- 页面定位器 ---------------- */

const pageText = () => evalJS(`document.querySelector('.page')?.innerText ?? ''`)

/** Vue v-model 认的是原生 input 事件，直接改 .value 不生效 */
const setInput = (selector, value) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

const clickByText = (text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find((e) => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
    if (!el) return false
    el.click()
    return true
  })()`)

/** 在线服务卡里列出的模型 id（服务端下发的清单） */
const catalogIds = () =>
  evalJS(`[...document.querySelectorAll('.osc .models .m b')].map((e) => e.textContent.trim())`)

/** 管理页模型卡上的名字与徽章 */
const modelCards = () =>
  evalJS(`[...document.querySelectorAll('.m-card')].map((c) => ({
    name: c.querySelector('.m-name')?.textContent.trim() ?? '',
    online: Boolean(c.querySelector('.chip-onl')),
    cost: c.querySelector('.m-cost')?.textContent.trim() ?? '',
  }))`)

const onlineStatusText = () => evalJS(`document.querySelector('.osc .chip')?.textContent.trim() ?? ''`)

async function main() {
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(`${APP}/#/ai/models`)
    await evalJS(`localStorage.clear()`)

    /* ---- 1. 预置本机账本：2 元模型费 + 0.1 元流量费（与 Rust 侧纳元整数同结构） ---- */
    await evalJS(`(() => {
      const rows = [{
        chatId: 'main', modelPk: 1, modelName: 'DeepSeek · deepseek-flash', modelId: 'deepseek-flash',
        provider: 'rein-online', source: 'online',
        promptTokens: 1000000, completionTokens: 500, requestBytes: 2048, responseBytes: 134217728,
        costModelNano: 2000000000, costTrafficNano: 100000000,
        at: new Date().toISOString(),
      }]
      localStorage.setItem('rein.mock.ai_usage.v1', JSON.stringify(rows))
      return true
    })()`)
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('h1')?.textContent === '管理模型'`, 15000, '管理模型页挂载')

    /* ---- 2. 卡片与未配置态 ---- */
    ok('管理模型页出现「Rein 在线服务」卡', (await pageText()).includes('Rein 在线服务'))
    ok('未填密钥时状态为「未配置服务密钥」', (await onlineStatusText()).includes('未配置服务密钥'), await onlineStatusText())
    // 账本随模型列表一起异步加载，等它落位再断言
    await waitFor(`document.querySelector('.page').innerText.includes('¥2.1000')`, 8000, '本机账本渲染')
    ok(
      '本机累计成本按账本显示 ¥2.1000（模型费 + 流量费）',
      (await pageText()).includes('¥2.1000'),
      (await pageText()).match(/本机累计[^\n]*/)?.[0] ?? '',
    )
    await evalJS(`document.querySelector('.osc .head')?.click()`)
    await waitFor(`Boolean(document.querySelector('#osc-key'))`, 6000, '展开在线服务卡')
    ok(
      '未填密钥时「获取模型列表」禁用',
      await evalJS(`document.querySelector('.osc .act.primary')?.disabled === true`),
    )
    await shot('1-online-idle')

    /* ---- 3. 密钥 → 服务端下发模型清单 ---- */
    ok('填入服务地址', await setInput('#osc-base', 'http://127.0.0.1:8787'))
    ok('填入服务密钥', await setInput('#osc-key', 'rein_sk_e2e_demo'))
    await clickByText('获取模型列表')
    await waitFor(`document.querySelectorAll('.osc .models .m').length > 0`, 10000, '模型清单返回')
    const ids = await catalogIds()
    ok('清单只列服务端下发的模型', ids.length === 3 && ids.includes('deepseek-flash'), ids.join(' · '))
    ok('清单带官方单价（未定价的显示「未定价」）', (await pageText()).includes('每百万 tokens'))
    ok('状态变为已连接', (await onlineStatusText()).includes('已连接'), await onlineStatusText())
    await shot('2-online-catalog')

    /* ---- 4. 导入 → 落库成可用模型 ---- */
    await clickByText('导入所选')
    await waitFor(`document.querySelectorAll('.m-card').length >= 3`, 10000, '模型落库')
    const cards = await modelCards()
    ok('导入的模型出现在管理列表', cards.length === 3, JSON.stringify(cards.map((c) => c.name)))
    ok('导入的模型带「在线」徽章', cards.every((c) => c.online), JSON.stringify(cards))
    ok(
      '模型卡显示服务端下发的单价',
      cards.some((c) => c.cost.includes('每百万 tokens')),
      JSON.stringify(cards.map((c) => c.cost)),
    )
    await shot('3-online-imported')

    /* ---- 4b. 模型卡（含单价与「在线」徽章）---- */
    await evalJS(`document.querySelector('.m-card')?.scrollIntoView({ block: 'center' })`)
    await sleep(400)
    await shot('3b-model-cards')
    await shotDark('3b-model-cards-dark')

    /* ---- 5. 断开：状态回到未配置，本机账本不受影响 ---- */
    await clickByText('断开')
    await waitFor(`document.querySelector('.osc .chip')?.textContent.includes('未配置')`, 6000, '断开生效')
    ok('断开后状态回到未配置', (await onlineStatusText()).includes('未配置'), await onlineStatusText())
    ok('断开后不再提供「导入所选」（清单已清）', !(await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('导入所选'))`)))
    ok('本机账本仍在（¥2.1000 不因断开而消失）', (await pageText()).includes('¥2.1000'))
    await shot('4-online-cleared')
  } finally {
    edge.kill()
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${failed === 0 ? '✔' : '✖'} 在线服务 e2e：${results.length - failed} 项通过，${failed} 项失败`)
    console.log(`   截图目录：${SHOTS}`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.stack ?? e}`)
  process.exit(1)
})
