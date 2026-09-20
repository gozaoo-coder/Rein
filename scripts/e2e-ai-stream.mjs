/**
 * e2e-ai-stream —— AI 流式输出体验 E2E（无头 Edge + 原生 CDP + 本地假 provider）
 *
 * 为什么要假 provider：浏览器 mock 模式下聊天是前端直连 provider 的（pi-ai streamSimple），
 * 所以只要把模型 baseUrl 指向本脚本起的本地 SSE 服务，就能让「真实全链路」跑起来——
 * pi-ai 解析 → chat.ts 回调 → streamBubbles 聚合 → ProcessSection 渲染，且节奏完全可编排。
 *
 * 剧本：第 1 轮吐思考（3 块）→ list_todos 工具调用；第 2 轮（请求里带 tool 结果）吐思考 + 正文 JSON。
 * 覆盖：合并标题（思考中 N 秒 → 已思考 N 秒 · 使用了工具）、进行中自动展开 + 跳动圆点、
 *       思考文字与工具行按到达顺序穿插、工具行状态（执行中→完成）、结果内联预览、
 *       工具详情手风琴、结束后自动折叠、点击手动展开。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-ai-stream.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
/** 每次运行独立目录：上次运行的 Edge 残留进程会锁住旧目录（EPERM） */
const USER_DATA = `${process.env.TEMP}/rein-e2e-ai-${Date.now()}`

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

/* ---------------- 断言与结果汇总 ---------------- */

const T0 = Date.now()
const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 本地假 provider（OpenAI 兼容 SSE） ---------------- */

/** 剧本台词 */
const R1_THINK = ['用户想知道', '今天的待办，', '先查一下再回答。']
const R2_THINK = ['拿到结果了，', '整理成一句话。']
const R2_TEXT = '{"kind":"chat","text":"今天有 3 条待办，最要紧的是跑步。"}'
const CHUNK_MS = 260

function sse(res, delta) {
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'e2e-model',
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`,
  )
}

async function startFakeProvider(port) {
  const rounds = []
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
      rounds.push(hasToolResult ? 2 : 1)

      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const task = hasToolResult ? round2(res) : round1(res)
      await task
      res.end()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))

  /** 第 1 轮：思考 → 调 list_todos（args 分块，验证增量拼接） */
  async function round1(res) {
    for (const t of R1_THINK) {
      sse(res, { reasoning_content: t })
      await sleep(CHUNK_MS)
    }
    sse(res, {
      tool_calls: [{ index: 0, id: 'call_e2e_1', type: 'function', function: { name: 'list_todos', arguments: '' } }],
    })
    await sleep(120)
    sse(res, { tool_calls: [{ index: 0, function: { arguments: '{"limit":20}' } }] })
    await sleep(120)
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'e2e-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
  }

  /** 第 2 轮：思考补充 → 正文（JSON 协议，逐块） */
  async function round2(res) {
    for (const t of R2_THINK) {
      sse(res, { reasoning_content: t })
      await sleep(CHUNK_MS)
    }
    // 正文按 3 块吐，验证 chatStreamView 增量解出 text 字段
    const step = Math.ceil(R2_TEXT.length / 3)
    for (let i = 0; i < R2_TEXT.length; i += step) {
      sse(res, { content: R2_TEXT.slice(i, i + step) })
      await sleep(CHUNK_MS)
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'e2e-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
  }

  return { server, rounds }
}

/* ---------------- CDP 驱动 ---------------- */

let DEBUG_PORT = 9333
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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

const shots = []

/** 存一张 PNG 截图（用于人工回看观感；不进仓库，落在系统临时目录） */
async function shot(name) {
  // 无头下动画停下后合成器可能不再出帧，截屏会拿到旧帧：先推两帧再抓
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const state = await evalJS(`(() => {
    const sec = document.querySelector('.process-section')
    const body = document.querySelector('.process-body')
    if (!sec) return '(无过程区)'
    return (sec.classList.contains('collapsed') ? 'collapsed' : 'expanded') +
      ' · body显示=' + (getComputedStyle(body).display !== 'none') +
      ' · maxHeight=' + (body.style.maxHeight || '(空)') +
      ' · 详情=' + (document.querySelector('.tool-detail-inline') ? '开' : '关')
  })()`)
  console.log(`      [截图 ${name}] ${state}`)
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${process.env.TEMP}/rein-e2e-ai-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  shots.push(file)
}

async function connect(url, seedScript) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
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
  // 无头渲染器按需出帧：animejs 的高度动画走 rAF，持续截屏保帧率（不取图）
  await cdp('Page.startScreencast', { format: 'jpeg', everyNthFrame: 2 }).catch(() => undefined)
  // 应用脚本执行前注入：写模型配置 + 清空会话存储，保证每轮从干净会话开始
  if (seedScript) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seedScript })
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      if (String(await evalJS('location.href')).startsWith(APP)) break
    } catch {
      /* 尚未就绪 */
    }
    await sleep(250)
  }
  await sleep(1200)
  await evalJS(`(() => {
    window.__errs = []
    window.addEventListener('error', e => window.__errs.push(String(e.message)))
    window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
    return true
  })()`)
}

/* ---------------- 主流程 ---------------- */

async function main() {
  DEBUG_PORT = await freePort()
  const providerPort = await freePort()
  const provider = await startFakeProvider(providerPort)
  const model = {
    id: 1,
    name: 'E2E 假模型',
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'sk-e2e',
    modelId: 'e2e-model',
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
  `
  console.log(`假 provider: http://127.0.0.1:${providerPort}/v1 · CDP ${DEBUG_PORT}`)

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
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
    await connect(`${APP}/#/ai`, seed)
    await waitFor(`document.querySelector('h1')?.textContent === 'AI'`, 12000, 'AI 页挂载')

    // 欢迎语由 init() 异步落库后上屏，等它出现再记录基线
    await waitFor(`document.querySelectorAll('.msg.assistant').length >= 1`, 8000, '欢迎语上屏')
    const before = await evalJS(`document.querySelectorAll('.msg.assistant').length`)
    ok('0 AI 页挂载且欢迎语就位', before >= 1, `已有助手气泡 ${before}`)

    /* ---------- 发送一轮会触发工具调用的提问 ---------- */
    const typed = await evalJS(`(() => {
      const el = document.querySelector('.inbar textarea')
      if (!el) return false
      el.value = '看看我今天有什么待办'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    ok('1 输入框可写入提问', typed)
    await sleep(200)
    await evalJS(`document.querySelector('.inbar .send').click()`)
    await sleep(300)
    ok('2 用户气泡上屏', await evalJS(`document.querySelectorAll('.msg.user').length === 1`))

    /* ---------- 进行中：过程区自动展开 ---------- */
    await waitFor(`!!document.querySelector('.process-header')`, 10000, '过程区出现')
    ok(
      '3 过程区标题为「思考中」',
      await evalJS(`document.querySelector('.process-title').textContent.includes('思考中')`),
      await evalJS(`document.querySelector('.process-title').textContent`),
    )
    ok('4 进行中默认展开（无 collapsed 类）', await evalJS(`!document.querySelector('.process-section').classList.contains('collapsed')`))
    ok(
      '5 展开区可见（v-show 未隐藏）',
      await evalJS(`getComputedStyle(document.querySelector('.process-body')).display !== 'none'`),
    )
    ok('6 进行中有跳动圆点', await evalJS(`document.querySelectorAll('.process-dots .dot').length === 3`))
    await waitFor(`document.querySelector('.process-reasoning')?.textContent?.includes('待办')`, 8000, '思考文字流出')
    ok('7 思考文字实时流出', true)

    /* ---------- 工具行：执行中 → 完成 ---------- */
    await waitFor(`!!document.querySelector('.tool-item')`, 10000, '工具行出现')
    const running = await evalJS(`document.querySelector('.tool-status')?.textContent?.trim()`)
    ok('8 工具行先显示执行中', running.includes('执行中'), running)
    await waitFor(`document.querySelector('.tool-status')?.textContent?.includes('完成')`, 10000, '工具执行完成')
    ok(
      '9 工具行显示中文短名（注册表 label）',
      (await evalJS(`document.querySelector('.tool-name').textContent`)) === '查看待办（分页）',
      await evalJS(`document.querySelector('.tool-name').textContent`),
    )
    const inline = await evalJS(`document.querySelector('.tool-result-inline')?.textContent?.trim() ?? ''`)
    ok('10 工具行内联结果预览非空（showResult）', inline.length > 0, inline.slice(0, 40))
    await shot('1-streaming')

    /* ---------- 结束：标题合并摘要 + 自动折叠 ---------- */
    await waitFor(`/已思考 \\d+ 秒/.test(document.querySelector('.process-title')?.textContent ?? '')`, 15000, '标题转为已思考')
    const title = await evalJS(`document.querySelector('.process-title').textContent`)
    ok('11 结束后标题为「已思考 N 秒 · 使用了工具」', /^已思考 \d+ 秒 · 使用了工具$/.test(title), title)
    ok('12 结束后跳动圆点消失', await evalJS(`document.querySelectorAll('.process-dots .dot').length === 0`))
    await waitFor(`document.querySelector('.process-section').classList.contains('collapsed')`, 6000, '自动折叠')
    ok('13 结束后自动折叠（600ms 延迟）', true)
    ok(
      '14 折叠后展开区隐藏',
      await evalJS(`getComputedStyle(document.querySelector('.process-body')).display === 'none'`),
    )
    await shot('2-collapsed')

    /* ---------- 对话气泡切分：过程 + 正文 ---------- */
    const rows = await evalJS(`document.querySelectorAll('.msg.assistant').length`)
    ok('15 一条提问产生 2 个助手气泡（过程气泡 + 正文气泡）', rows === before + 2, `前 ${before} → 后 ${rows}`)
    const bubbleText = await evalJS(`[...document.querySelectorAll('.msg.assistant .bubble')].pop()?.textContent?.trim()`)
    ok('16 正文气泡为协议解出的纯文本', (bubbleText ?? '').includes('今天有 3 条待办，最要紧的是跑步。'), bubbleText)
    ok('17 协议 JSON 不外泄到界面', !(bubbleText ?? '').includes('kind'))

    /* ---------- 手动展开：穿插顺序 + 工具详情 ---------- */
    await evalJS(`document.querySelector('.process-header').click()`)
    await sleep(500)
    ok('18 点击标题可手动展开', await evalJS(`!document.querySelector('.process-section').classList.contains('collapsed')`))
    await sleep(400)
    const order = await evalJS(
      `[...document.querySelector('.process-body').children].map(c => c.className.split(' ')[0]).join(',')`,
    )
    ok('19 思考文字与工具行按到达顺序穿插', order === 'process-reasoning,tool-group,process-reasoning', order)

    await evalJS(`document.querySelector('.tool-item').click()`)
    await sleep(400)
    ok('20 工具行点击展开详情（手风琴）', await evalJS(`!!document.querySelector('.tool-detail-inline')`))
    const detail = await evalJS(`document.querySelector('.tool-detail-inline')?.textContent ?? ''`)
    ok('21 详情含输入参数与返回结果', detail.includes('输入参数') && detail.includes('返回结果'))
    ok(
      '22 详情保留原始 JSON 入参',
      await evalJS(`[...document.querySelectorAll('.detail-pre')].some(p => p.textContent.includes('limit'))`),
    )

    // 自动折叠只应发生一次：手动展开后继续交互（打开工具详情）不应被自折叠定时器打断
    ok(
      '23 手动展开后在后续交互中保持展开',
      await evalJS(`!document.querySelector('.process-section').classList.contains('collapsed')`),
    )
    await shot('3-expanded-detail')

    /* ---------- 再点一次折叠回去 ---------- */
    await evalJS(`document.querySelector('.process-header').click()`)
    await sleep(500)
    ok('24 再点标题可折叠回去', await evalJS(`document.querySelector('.process-section').classList.contains('collapsed')`))

    /* ---------- 运行期异常 ---------- */
    const errs = await evalJS(`window.__errs`)
    ok('25 运行期无未捕获异常', Array.isArray(errs) && errs.length === 0, (errs ?? []).join(' | '))
    ok(
      '26 provider 恰好收到 2 轮请求（工具后二次调用）',
      provider.rounds.join(',') === '1,2',
      provider.rounds.join(','),
    )
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
    // 失败诊断：把当时的真实状态打出来，省得盲猜
    try {
      console.log('--- 诊断 ---')
      console.log('provider 收到的轮次:', provider.rounds.join(',') || '(无)')
      console.log('过程标题:', await evalJS(`document.querySelector('.process-title')?.textContent ?? '(无)'`))
      console.log('过程区类名:', await evalJS(`document.querySelector('.process-section')?.className ?? '(无)'`))
      console.log(
        '助手气泡文本:',
        JSON.stringify(await evalJS(`[...document.querySelectorAll('.msg.assistant')].map(m => (m.textContent ?? '').slice(0, 60))`)),
      )
      console.log('运行期异常:', JSON.stringify(await evalJS(`window.__errs ?? []`)))
    } catch (e2) {
      console.log('诊断失败:', String(e2))
    }
  } finally {
    edge.kill()
    provider.server.close()
  }

  if (shots.length) console.log('截图:', shots.join(' , '))
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

void main()
