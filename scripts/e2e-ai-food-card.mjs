/**
 * e2e-ai-food-card —— 食物卡「不用切页就能看见」回归（无头 Edge + 原生 CDP + 假 provider）
 *
 * 钉住的是用户报的这条：「AI 已经返回了弹出食品卡的行为，但要跳去其他页面再回来才弹出来」。
 * 两个真实成因各留一条不变量：
 *  ① 定稿时把流式占位气泡就地改成食物卡：若改的是**原始对象**而不是 messages.value 里那份
 *     响应式代理，写进去不触发渲染（数据在、界面不动），要靠别的 reactive 写入（busy 落回 false）
 *     才顺带刷出来 —— 这条用「不切页也出现卡片」断言。
 *  ② 卡片是在最后一条流式事件**之后**才长高的：那次事件已滚过，不补一次滚动，卡片就停在
 *     视口下方；用户切页回来时 onMounted 的 scrollToBottom 才把它带进视野。
 *     这条用「卡片落进可视区」断言（只断言存在会漏掉它）。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向别的实例 —— 1420 常落在 Windows
 *       保留端口段报 EACCES，那时换个端口起服再指过来）
 * 运行：node scripts/e2e-ai-food-card.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-probe-foodcard-${Date.now()}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 假 provider：先 search_food，再回 food 卡协议 ----------------
 * foodId 由用例在页面里用 __REIN_TOOL__ 现查（不写死种子 id），经下面的变量注入。 */
let foodId = null

function sse(res, delta) {
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'probe-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`,
  )
}

function endTurn(res, finish) {
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'probe-model',
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
}

async function startFakeProvider(port) {
  const server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* 空体 */
      }
      const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool')
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      if (hasToolResult) {
        sse(res, { reasoning_content: '库里这条叫鸡胸肉，' })
        await sleep(200)
        sse(res, { reasoning_content: '写入卡片。' })
        await sleep(200)
        // 定稿协议：kind=food 的卡片（正文对用户不可见，定稿才 morph 成卡）。
        // 克重特意用 180：种子里今天午餐已有一条 150g 鸡胸肉，用 180 才能证明掉库的是这一张卡。
        const card = JSON.stringify({
          kind: 'food',
          items: [{ foodName: '鸡胸肉', grams: 180, kcalEstimate: 297, foodId }],
        })
        for (let i = 0; i < card.length; i += 8) {
          sse(res, { content: card.slice(i, i + 8) })
          await sleep(120)
        }
        endTurn(res, 'stop')
      } else {
        sse(res, { reasoning_content: '先搜一下食物库。' })
        await sleep(200)
        sse(res, {
          tool_calls: [
            {
              index: 0,
              id: 'call_probe_food',
              type: 'function',
              function: { name: 'search_food', arguments: '{"query":"鸡胸肉"}' },
            },
          ],
        })
        await sleep(150)
        endTurn(res, 'tool_calls')
      }
      res.end()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return server
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
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

async function waitFor(expr, timeoutMs = 25000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${process.env.TEMP}/rein-probe-foodcard-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
}

/** 食物卡相对滚动可视区的位置：卡片底部是否进视野（用户不滚动就能看见） */
const CARD_VIEW = `(() => {
  const card = document.querySelector('.msg.assistant .parse')
  const list = document.querySelector('.msgs')
  if (!card || !list) return null
  const c = card.getBoundingClientRect()
  const l = list.getBoundingClientRect()
  return {
    text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    cardTop: Math.round(c.top),
    cardBottom: Math.round(c.bottom),
    viewTop: Math.round(l.top),
    viewBottom: Math.round(l.bottom),
    scrollTop: Math.round(list.scrollTop),
    maxScroll: Math.round(list.scrollHeight - list.clientHeight),
    inView: c.bottom <= l.bottom + 4 && c.top >= l.top - 4,
  }
})()`

async function main() {
  const debugPort = await freePort()
  const providerPort = await freePort()
  const provider = await startFakeProvider(providerPort)
  const model = {
    id: 1,
    name: 'Probe 假模型',
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'sk-probe',
    modelId: 'probe-model',
    isDefault: true,
    vision: false,
    thinking: true,
    effort: null,
    imageMaxEdge: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const seed = `
    localStorage.setItem('rein.mock.ai_models.v1', ${JSON.stringify(JSON.stringify([model]))});
    localStorage.removeItem('rein.mock.ai_chats.v1');
    sessionStorage.setItem('__loads', String(Number(sessionStorage.getItem('__loads') ?? 0) + 1));
  `

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
    const target = await res.json()
    await sleep(300)
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
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seed })
    await cdp('Page.navigate', { url: `${APP}/#/ai` })
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      try {
        if (String(await evalJS('location.href')).startsWith(APP)) break
      } catch {
        /* 尚未就绪 */
      }
      await sleep(250)
    }
    await sleep(1500)
    await waitFor(`!!document.querySelector('.inbar textarea')`, 30000, 'AI 页输入栏就绪')
    await sleep(400)

    // 现查食物 id（不写死种子顺序）；dev 模式才有 __REIN_TOOL__ 直调钩子
    foodId = await evalJS(`window.__REIN_TOOL__
      ? window.__REIN_TOOL__('search_food', { query: '鸡胸肉' }).then((r) => (r.find((x) => x.name === '鸡胸肉') ?? r[0]).id)
      : Promise.resolve(null)`)
    ok('0 取到食物库里的鸡胸肉 id', typeof foodId === 'number' && foodId > 0, `foodId=${foodId}`)

    await evalJS(`(() => {
      const el = document.querySelector('.inbar textarea')
      el.value = '午饭吃了 180 克鸡胸肉'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evalJS(`document.querySelector('.inbar .send').click()`)
    await waitFor(`document.querySelectorAll('.msg.user').length === 1`, 8000, '用户气泡上屏')

    /* ---------- 不切页：卡片自己出现 ---------- */
    let appeared = true
    try {
      await waitFor(`!!document.querySelector('.msg.assistant .parse')`, 25000, '食物卡上屏（不切页）')
    } catch (e) {
      appeared = false
      console.log(`      ${e.message}`)
    }
    ok('1 AI 定稿后食物卡自动上屏（未切页、未刷新）', appeared)

    // 卡片长出来之后还在动（morph 是异步的：items 要等食物校验/补录）—— 等滚动跟随落定
    await sleep(1200)
    const view = await evalJS(CARD_VIEW)
    ok('2 卡片在可视区内（回合结束补了滚动跟随）', !!view?.inView, JSON.stringify(view ?? {}))
    ok(
      '3 卡片内容正确（鸡胸肉 / 180g）',
      !!view && view.text.includes('鸡胸肉') && view.text.includes('180'),
      view?.text ?? '',
    )
    const loads = await evalJS(`Number(sessionStorage.getItem('__loads') ?? 0)`)
    ok('4 期间没有整页重载（会话没被重置）', loads === 1, `loads=${loads}`)
    await shot('card')

    /* ---------- 卡片可写入 ---------- */
    await evalJS(`document.querySelector('.msg.assistant .parse .commit')?.click()`)
    let committed = true
    try {
      await waitFor(`!!document.querySelector('.msg.assistant .parse .committed')`, 8000, '写入态')
    } catch {
      committed = false
    }
    ok('5 卡片「加入记录」可写入（已写入态上屏）', committed)

    const meals = await evalJS(`window.__REIN_TOOL__('list_meals', {}).then((r) => r.meals.filter((m) => m.foodName === '鸡胸肉').map((m) => m.grams))`)
    ok('6 午餐确实新增落库 180g 鸡胸肉', Array.isArray(meals) && meals.includes(180), JSON.stringify(meals))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
    provider.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

void main()
