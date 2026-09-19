/**
 * e2e-ai-bubbles —— 聊天区「空气泡」与阴影裁切回归（无头 Edge + 原生 CDP）
 *
 * 两个曾经出过问题的点，这里各钉一条可机检的不变量：
 *   空气泡：流式占位气泡在推理/工具阶段是空 text（内容在 ProcessSection 里），
 *           它的 padding/底色/阴影会渲染成一个什么都没有的盒子挂在过程区上方。
 *           不变量——.msgs 内任何画了底色或边框的盒子，文本长度都不为 0。
 *   阴影裁切：.msgs 是滚动容器，按规范会裁掉溢出，气泡的 --shadow-card
 *           （12px 偏移 + 32/80px 模糊）会被自己的滚动区切出直边。
 *           不变量——滚动区左右各留出不小于 16px 的空白，气泡离裁切边界足够远。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-ai-bubbles.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-probe-bubbles-${Date.now()}`

/** 气泡阴影向外扩散的最低余量（--shadow-card 最浓的一层是 32px 模糊 ≈ 16px 外扩） */
const MIN_SHADOW_ROOM = 16

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

/* ---------------- 假 provider：思考 → 工具 → 二轮思考 → 正文 ---------------- */

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
        for (const t of ['整理一下，', '这就回答。']) {
          sse(res, { reasoning_content: t })
          await sleep(200)
        }
        // 正文按块吐，让正文气泡真正成形（协议 JSON 由 chatStreamView 解出 text 字段）
        const text = '{"kind":"chat","text":"今天有 3 条待办。"}'
        for (let i = 0; i < text.length; i += 8) {
          sse(res, { content: text.slice(i, i + 8) })
          await sleep(150)
        }
        endTurn(res, 'stop')
      } else {
        for (const t of ['用户想知道', '今天的待办。']) {
          sse(res, { reasoning_content: t })
          await sleep(200)
        }
        sse(res, {
          tool_calls: [
            { index: 0, id: 'call_probe_1', type: 'function', function: { name: 'list_todos', arguments: '{"limit":20}' } },
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

/** 等条件成立。SPA 的 location 早于渲染就绪，只等 href 会在冷启动（Vite 首次编译
 *  才现编 AIPage 那一大串动态 import）时抢跑——页面上还没有输入框。 */
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
  const file = `${process.env.TEMP}/rein-probe-bubbles-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
}

/** .msgs 内所有「画了底色 / 边框 / 渐变」的盒子：几何 + 文本长度 */
const PAINTED_BOXES = `(() => {
  const msgs = document.querySelector('.msgs')
  if (!msgs) return null
  const out = []
  for (const el of msgs.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const bare = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.borderTopWidth === '0px' && cs.backgroundImage === 'none'
    if (bare) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    out.push({
      cls: typeof el.className === 'string' ? el.className : el.tagName,
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: Math.round(r.left),
      textLen: (el.textContent ?? '').trim().length,
      bg: cs.backgroundColor,
    })
  }
  return { boxes: out, empty: out.filter((b) => b.textLen === 0) }
})()`

/** 滚动容器两侧留给气泡阴影的余量（内容盒边缘到裁切边界） */
const SHADOW_ROOM = `(() => {
  const msgs = document.querySelector('.msgs')
  if (!msgs) return null
  const cs = getComputedStyle(msgs)
  const r = msgs.getBoundingClientRect()
  const bubbles = [...msgs.querySelectorAll('.bubble')]
  return {
    paddingLeft: parseFloat(cs.paddingLeft),
    paddingRight: parseFloat(cs.paddingRight),
    contentLeft: Math.round(r.left + parseFloat(cs.paddingLeft)),
    bubbles: bubbles.map((b) => Math.round(b.getBoundingClientRect().left)),
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
    // 整页加载计数（sessionStorage 跨 reload 存活）：中途被重载会让会话从种子态重来，
    // 那样断言看到的是「刚冷启动」而不是「这一轮对话」，必须能被发现
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
    await waitFor(`!!document.querySelector('.inbar input')`, 30000, 'AI 页输入栏就绪')
    await waitFor(`!!document.querySelector('.msg.assistant .bubble')`, 15000, '欢迎语上屏')
    await sleep(400)

    await evalJS(`(() => {
      const el = document.querySelector('.inbar input')
      el.value = '看看我今天有什么待办'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await evalJS(`document.querySelector('.inbar .send').click()`)
    await waitFor(`document.querySelectorAll('.msg.user').length === 1`, 8000, '用户气泡上屏')

    /* ---------- 过程阶段：推理 + 工具进行中，正文还没到 ---------- */
    const tProcess = Date.now()
    let phase = null
    let reached = false
    while (Date.now() - tProcess < 10000) {
      // 过程区本体没有底色（靠左细线标识层级），不能只看「画了底色的盒子」——
      // 它上屏就是进入了过程阶段：此刻正文气泡还不该存在
      if (await evalJS(`!!document.querySelector('.process-section')`)) {
        reached = true
        phase = await evalJS(PAINTED_BOXES)
        break
      }
      await sleep(150)
    }
    ok('1 已进入过程阶段（过程区上屏）', reached)
    ok(
      '2 过程阶段无空气泡（画了底色的盒子文本都不为空）',
      phase !== null && phase.empty.length === 0,
      JSON.stringify(phase?.empty ?? []),
    )
    await shot('process-phase')

    /* ---------- 定稿后 ---------- */
    await sleep(5000)
    const loads = await evalJS(`Number(sessionStorage.getItem('__loads') ?? 0)`)
    if (loads !== 1) console.log(`      [警告] 测试期间整页加载了 ${loads} 次（会话被重置）`)
    const settled = await evalJS(PAINTED_BOXES)
    ok('3 定稿后无空气泡', settled !== null && settled.empty.length === 0, JSON.stringify(settled?.empty ?? []))
    ok(
      '4 定稿后正文气泡成形（欢迎语 + 提问 + 回答三个有底色的盒子）',
      (settled?.boxes ?? []).length === 3 && settled.boxes.every((b) => b.textLen > 0),
      `盒子数=${settled?.boxes?.length ?? 0} 文本长度=${JSON.stringify((settled?.boxes ?? []).map((b) => b.textLen))}`,
    )
    await shot('settled')

    /* ---------- 阴影余量 ---------- */
    const room = await evalJS(SHADOW_ROOM)
    ok(
      `5 滚动区左右各留出 ≥ ${MIN_SHADOW_ROOM}px 影子余量`,
      room !== null && room.paddingLeft >= MIN_SHADOW_ROOM && room.paddingRight >= MIN_SHADOW_ROOM,
      `padding=${room?.paddingLeft}/${room?.paddingRight}`,
    )
    ok(
      '6 气泡未贴住裁切边界（最靠边的气泡也在余量之内）',
      room !== null && room.bubbles.length > 0 && room.bubbles.every((l) => l >= room.contentLeft),
      `气泡左缘=${JSON.stringify(room?.bubbles ?? [])} 内容左缘=${room?.contentLeft}`,
    )
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
