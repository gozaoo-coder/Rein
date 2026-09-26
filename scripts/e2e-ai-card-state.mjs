/**
 * e2e-ai-card-state —— 卡片状态回灌回归（无头 Edge + 原生 CDP + 假 provider）
 *
 * 钉住的不变量（对应 src/ai/cardState.ts + src/ai/cardOutcomes.ts；背景见 docs/ARCHITECTURE.md
 * 的「卡片状态回灌」）：卡片本身不进模型历史（回灌的 history 只挑 text/analysis/voice/photo/doc），
 * 所以「用户对卡 / 提议做了什么」必须靠每轮重发的两段带过去 —— 而且必须是**用户操作之后的最新事实**。
 *
 *   A. 纯函数：食物卡三态 / 纪要写入状态 / 事件段渲染 / 事件日志的上限与 TTL；
 *   B. 端到端「确认」：出卡 → 加入记录 → 下一轮 system 段说「已确认写入今日X + 最终条目」；
 *   C. 端到端「没处理」：出卡 → 不点加入记录直接继续聊 → 「未确认 + 用户没有处理就直接继续」；
 *   D. 事件注入：记录一条提议处理结果 → 下一轮带上；老化 25 小时 → 不再带（TTL）；
 *   E. 真实路径 · 目标建议卡：饮食调整页生成 → 采用 → 聊天下轮知道「采用了 AI 目标调整建议」；
 *   F. 真实路径 · 语音纪要卡：写入状态（已写入/未写入）进注入，且用户刚写入立刻生效；
 *   G. 真实路径 · 智能添加：抽屉出食物卡 → 写入 → 聊天下轮知道「智能添加记入今日…」。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-ai-card-state.mjs
 *      E2E_DEBUG=1 … 另打印每个请求的形状与假 provider 的收发时序（排查卡住时用）
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

/** 逐请求的时序日志：平时安静，怀疑「请求发了但界面不动」时开它 */
const DEBUG = !!process.env.E2E_DEBUG

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-cardstate-${Date.now()}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

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

/* ---------------- 假 provider：请求体全部留存（断言 system 段用） ---------------- */

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

/** 假模型的三副面孔：两张不同的食物卡 + 纯聊天 */
const CARDS = {
  food_a: [
    { foodName: '鸡蛋', grams: 50, kcalEstimate: 70 },
    { foodName: '米饭', grams: 200, kcalEstimate: 232 },
  ],
  food_b: [{ foodName: '牛奶', grams: 250, kcalEstimate: 160 }],
}
/** 智能添加（smartGen.ts）的输出协议：一张食物卡 + 空待办 */
const SMART_FOOD = { todos: [], foods: [{ foodName: '鸡蛋', grams: 50, kcalEstimate: 70 }] }

/**
 * F 段专用的 seed（在 F 之前才注册）：往 mock 的会话存储里塞一条**带语音轮**的会话，
 * 这样不用走整套语音链路，就能验证「纪要卡的写入状态」这条派生来源（形状见 mock 的 MockAiChat）。
 */
const MEMO_CHAT_SEED = `
  (() => {
    const now = new Date().toISOString()
    const chat = {
      id: 'chatmemo', seq: 2, title: '纪要测试', createdAt: now, updatedAt: now,
      messages: [
        { id: 'mm1', chatId: 'chatmemo', seq: 1, role: 'assistant', kind: 'text', text: '你好，我是 Rein AI。', imageBase64: null, mime: null, payload: null, createdAt: now },
        { id: 'mm2', chatId: 'chatmemo', seq: 2, role: 'user', kind: 'voice', text: '记一下明天跑步三十分钟，还有买蛋白粉', imageBase64: null, mime: null, payload: JSON.stringify({ voice: { memoId: 'memo1', durationMs: 60000, words: 20 } }), createdAt: now },
      ],
    }
    localStorage.setItem('rein.mock.ai_chats.v1', JSON.stringify([chat]))
  })()
`
let mode = 'chat'
/** 是否先吐思考增量：真实模型（thinking 档）出卡前一般有推理，C 段用它覆盖「有过程段」那条路 */
let think = false
/** 假 provider 收到的全部请求（含启动时的记忆整理等后台模型调用） */
const requests = []
/** 每个请求的元信息（诊断用；与 requests 同序） */
const metas = []
/** 聊天提示词的身份证：只有聊天链路才带「你是 Rein AI」这句，后台整理/抽取不带 */
const CHAT_MARK = '你是 Rein AI'

/** 只取聊天请求：启动时 kb 的记忆整理会先打一发模型，不能让它顶掉第一条 */
function chatRequests() {
  return requests.filter((r) => systemOf(r).includes(CHAT_MARK))
}

async function startFakeProvider(port) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    // CORS：真模型网关会回这些头，假 provider 不回的话 WebView 侧整轮就发不出去
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    try {
      let body = raw
      const enc = String(req.headers['content-encoding'] ?? '')
      if (enc.includes('gzip')) body = gunzipSync(body)
      else if (enc.includes('deflate')) body = inflateSync(body)
      else if (enc.includes('br')) body = brotliDecompressSync(body)
      const parsed = JSON.parse(body.toString('utf8'))
      requests.push(parsed)
      metas.push({ method: req.method, url: req.url, bytes: body.length })
      if (DEBUG && requests.length <= 3) {
        console.log(
          `      [诊断] 请求${requests.length}：${(parsed.messages ?? [])
            .map((x) => `${x.role}:${typeof x.content === 'string' ? x.content.slice(0, 24) : '[parts]'}`)
            .join(' | ')}`,
        )
      }
    } catch (e) {
      requests.push(null)
      metas.push({ method: req.method, url: req.url, bytes: raw.length, error: String(e) })
      console.log(
        `      [警告] 请求体解析失败（${req.method} len=${raw.length} enc=${req.headers['content-encoding'] ?? '-'}）：${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors })
    const text =
      mode === 'chat'
        ? JSON.stringify({ kind: 'chat', text: '好的。' })
        : mode === 'smart_food'
          ? JSON.stringify(SMART_FOOD)
          : JSON.stringify({ kind: 'food', items: CARDS[mode] })
    if (think) {
      for (const t of ['先看用户说了什么，', '再决定出不出卡片。']) {
        sse(res, { reasoning_content: t })
        await sleep(30)
      }
    }
    for (let i = 0; i < text.length; i += 10) {
      sse(res, { content: text.slice(i, i + 10) })
      await sleep(10)
    }
    endTurn(res, 'stop')
    res.end()
    if (DEBUG) {
      console.log(`      [provider] 回复写完 #${requests.length}（${text.length} 字，mode=${mode}）`)
      res.on('close', () =>
        console.log(`      [provider] 连接关闭 #${requests.length}（writableEnded=${res.writableEnded}）`),
      )
    }
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return server
}

/**
 * 取一次请求里的系统提示词。两条线路的写法不同：openai-completions 把系统提示词发成
 * `developer` 角色（这条线路实测如此），别处可能是 `system` —— 两个都要认。
 */
function systemOf(req) {
  const m = (req?.messages ?? []).find((x) => x.role === 'system' || x.role === 'developer')
  if (!m) return ''
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}

/**
 * 从 system 段里切一段（切到下一个段头为止）。
 * 认块头整句而不是只认段名：提示词的【分寸】段也点了这两个段名（讲语义），
 * 只认段名的话「没有卡 / 没有记录」会被误判成「有」。
 */
const BLOCK_MARK = '【卡片状态】你在本会话里出过的卡与用户对它们的处理'
const OUTCOME_MARK = '【AI 提议处理记录】用户在其他页面处理过的 AI 提议'

function sectionOf(sys, mark, stopMarks) {
  const at = sys.indexOf(mark)
  if (at === -1) return ''
  const stops = stopMarks.map((m) => sys.indexOf(m, at + mark.length)).filter((i) => i !== -1)
  return sys.slice(at, stops.length ? Math.min(...stops) : undefined)
}

const cardBlockOf = (sys) => sectionOf(sys, BLOCK_MARK, ['【约定】', OUTCOME_MARK])
const outcomeBlockOf = (sys) => sectionOf(sys, OUTCOME_MARK, ['【约定】'])

/** 等聊天请求累积到 n 个（send 之后调用；后台的记忆整理/抽取不计入） */
async function waitChatRequests(n, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (chatRequests().length >= n) return
    await sleep(100)
  }
  throw new Error(
    `等待第 ${n} 个聊天请求超时（当前 ${chatRequests().length}；共收到 ${requests.length} 个请求，元信息 ${JSON.stringify(metas)}）`,
  )
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()
/** 页内 console / 未捕获异常（失败时打印，省得对着「等待超时」猜） */
const logs = []
/** 每个 /v1 响应的 requestId → 已收字节（dataReceived / loadingFinished 对账用） */
const dataSeen = new Map()
/** 假 provider 端口（诊断里从页内直接打一发做对照） */
let providerPort = 0

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

/** 失败时留一张现场图（消息区尾部文本另在 catch 里打印） */
async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${process.env.TEMP}/rein-e2e-cardstate-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
}

/** 等条件成立。SPA 的 location 早于渲染就绪，必须等到输入框真的在页面上 */
async function waitFor(expr, timeoutMs = 25000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 已发送的用户消息数（跨 reload 归零；进页面时重新数：欢迎语是 assistant，不干扰） */
let sent = 0

async function send(text) {
  await evalJS(`(() => {
    const el = document.querySelector('.inbar textarea')
    el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  // 发送键 disabled = busy || 空草稿；文案已填，所以「可用」就等于「上一轮已结束」
  await waitFor(`!document.querySelector('.inbar .send').disabled`, 25000, '上一轮结束、发送键可用')
  await evalJS(`document.querySelector('.inbar .send').click()`)
  sent++
  await waitFor(`document.querySelectorAll('.msg.user').length >= ${sent}`, 15000, '用户气泡上屏')
}

/** 发一条消息并返回这一轮请求的 system 段（假 provider 收到的最新一条聊天请求） */
async function sendAndSystem(text) {
  const before = chatRequests().length
  await send(text)
  await waitChatRequests(before + 1)
  return systemOf(chatRequests().at(-1))
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const debugPort = await freePort()
  providerPort = await freePort()
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
  // 每次整页加载都重置 mock 会话：C 段靠 reload 拿一个干净会话；
  // 顺手关掉更新检查（否则真有机上会弹「发现新版本」抽屉压住页面）
  //
  // 两个页内探针（只在测试里挂，不进产品代码）：
  //   ① 未捕获异常 / unhandledrejection → console.error，会被 CDP 的 Log 域收走；
  //   ② fetch 包一层，把假 provider 的 SSE 流 clone 出来读到底 —— 「请求发出去了、
  //      200 也回来了，但界面一动不动」时，第一件要分清的事就是流有没有走完。
  const seed = `
    localStorage.setItem('rein.mock.ai_models.v1', ${JSON.stringify(JSON.stringify([model]))});
    localStorage.removeItem('rein.mock.ai_chats.v1');
    window.__REIN_MOCK_UPDATE_NONE__ = true;
    window.addEventListener('unhandledrejection', (e) =>
      console.error('[probe] unhandledrejection: ' + (e.reason?.stack ?? e.reason?.message ?? e.reason)));
    window.addEventListener('error', (e) => console.error('[probe] error: ' + (e.message ?? e)));
    const __origFetch = window.fetch;
    window.fetch = async (...a) => {
      const res = await __origFetch(...a);
      const url = String(typeof a[0] === 'string' ? a[0] : a[0]?.url ?? '');
      if (url.includes('/v1/')) {
        const clone = res.clone();
        (async () => {
          try {
            const t = await clone.text();
            console.log('[probe] stream done bytes=' + t.length + ' tail=' + JSON.stringify(t.slice(-60)));
          } catch (err) {
            console.log('[probe] stream read error: ' + err);
          }
        })();
      }
      return res;
    };
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

  /**
   * 导航到 AI 页并等到可交互。`query` 用来换一个**真不同**的 URL：hash 变化是同位导航，
   * 不会重跑 seed，也就清不掉 mock 里的会话（C 段要一个干净会话，靠的就是整页重载）。
   */
  async function openAiPage(query = '') {
    sent = 0
    await cdp('Page.navigate', { url: `${APP}/${query}#/ai` })
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      try {
        if (String(await evalJS('location.href')).startsWith(APP)) break
      } catch {
        /* 尚未就绪 */
      }
      await sleep(250)
    }
    await waitFor(`!!document.querySelector('.inbar textarea')`, 30000, 'AI 页输入栏就绪')
    await waitFor(`!!document.querySelector('.msg.assistant .bubble')`, 15000, '欢迎语上屏')
  }

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
      if (m.method === 'Runtime.consoleAPICalled') {
        // console.* 走 Runtime 域，不走 Log 域 —— 漏了这条会把页内探针全丢掉
        const text = (m.params?.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
        if (m.params?.type === 'error' || m.params?.type === 'warning' || text.includes('[probe]')) {
          logs.push(`console.${m.params?.type}: ${text}`)
        }
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push(`exception: ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text}`)
        return
      }
      if (m.method === 'Log.entryAdded') {
        const entry = m.params?.entry ?? {}
        const text = String(entry.text ?? '')
        if (entry.level === 'error' || entry.level === 'warning' || text.includes('[probe]')) {
          logs.push(`${entry.level}: ${text}`)
        }
        return
      }
      if (m.method === 'Network.loadingFailed') {
        logs.push(`network failed: ${m.params?.errorText}（${m.params?.type}）`)
        return
      }
      if (m.method === 'Network.dataReceived' && dataSeen.has(m.params?.requestId)) {
        const d = dataSeen.get(m.params.requestId)
        d.bytes += m.params?.dataLength ?? 0
        return
      }
      if (m.method === 'Network.loadingFinished' && dataSeen.has(m.params?.requestId)) {
        logs.push(`network finished: ${dataSeen.get(m.params.requestId).url} bytes=${dataSeen.get(m.params.requestId).bytes}`)
        return
      }
      if (m.method === 'Network.responseReceived' && String(m.params?.response?.url ?? '').includes('127.0.0.1')) {
        dataSeen.set(m.params.requestId, { url: m.params.response.url, bytes: 0 })
        logs.push(`network resp: ${m.params.response.status} ${m.params.response.url}`)
        return
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result ?? {})
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    await cdp('Log.enable')
    await cdp('Network.enable')
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seed })
    await openAiPage()

    /* ---------- A. 纯函数：卡片状态 + 提议记录（含纪要、上限、TTL） ---------- */
    const pure = await evalJS(`(async () => {
      const { buildCardStateBlock } = await import('/src/ai/cardState.ts')
      const outcomes = await import('/src/ai/cardOutcomes.ts')
      const card = (over) => ({
        id: 'm1', role: 'assistant', kind: 'food-parse', at: '2026-09-26T04:00:00.000Z',
        items: [{ foodId: 1, foodName: '鸡蛋', grams: 50, kcalEstimate: 70, confidence: 0.9, note: null }],
        ...over,
      })
      const memo = {
        id: 'memo1', chatId: 'c1', messageId: 'm9', title: '周会', audioPath: null, durationMs: 60000, words: 20,
        createdAt: '2026-09-26T04:00:00.000Z', sentences: [],
        summary: [
          { kind: 'todo', text: '明天跑步 30 分钟', refs: [0], written: true, todo: { title: '明天跑步 30 分钟' } },
          { kind: 'food', text: '一杯牛奶 250g', refs: [1], written: false, food: { name: '牛奶', grams: 250 } },
          { kind: 'note', text: '聊了聊工作', refs: [] },
        ],
      }
      const notesOnly = { ...memo, id: 'memo2', title: '随笔', summary: [{ kind: 'note', text: '随便聊聊', refs: [] }] }
      const now = Date.now()
      const out = {}
      out.empty = buildCardStateBlock({ messages: [{ id: 'u1', role: 'user', kind: 'text', at: '', text: '嗨' }] })
      out.pending = buildCardStateBlock({ messages: [card({ committed: false })] })
      out.done = buildCardStateBlock({ messages: [card({ committed: true, mealType: 'lunch', proposal: [{ foodName: '鸡蛋', grams: 50 }] })] })
      out.edited = buildCardStateBlock({ messages: [card({ committed: true, mealType: 'lunch', proposal: [{ foodName: '鸡蛋', grams: 100 }] })] })
      out.legacy = buildCardStateBlock({ messages: [card({ committed: true })] })
      out.many = buildCardStateBlock({ messages: Array.from({ length: 7 }, () => card({ committed: true, mealType: 'lunch', proposal: [{ foodName: '鸡蛋', grams: 50 }] })) })
      out.memo = buildCardStateBlock({ messages: [], memos: [memo] })
      out.memoNote = buildCardStateBlock({ messages: [], memos: [notesOnly] })
      out.onlyOutcome = buildCardStateBlock({ messages: [], outcomes: [{ id: 'o1', kind: 'target-adjust', text: '采用了 AI 目标调整建议 —— 热量 1900 → 1800 大卡', at: now - 12 * 60000 }] })
      out.justNow = buildCardStateBlock({ messages: [], outcomes: [{ id: 'o2', kind: 'smart-add', text: '智能添加写入待办 1 条（买蛋白粉）', at: now - 9000 }] })
      localStorage.removeItem('rein.aiCards.v1')
      for (let i = 0; i < 12; i++) outcomes.recordCardOutcome('schedule', '第 ' + i + ' 条')
      out.capped = outcomes.listCardOutcomes().length
      const raw = JSON.parse(localStorage.getItem('rein.aiCards.v1'))
      raw[0].at = Date.now() - 25 * 3600 * 1000
      localStorage.setItem('rein.aiCards.v1', JSON.stringify(raw))
      out.afterTtl = outcomes.listCardOutcomes().length
      localStorage.removeItem('rein.aiCards.v1')
      return out
    })()`)
    ok('A1 三部分都空 → 整段不出现（零开销）', pure.empty === '', JSON.stringify(pure.empty))
    ok(
      'A2 未确认：说明「没处理就继续聊」不等于已记录、不要重复出卡',
      pure.pending.includes('未确认') &&
        pure.pending.includes('没有处理它就直接继续了对话') &&
        pure.pending.includes('不要重复出这张卡') &&
        !pure.pending.includes('已确认'),
      pure.pending.slice(0, 80),
    )
    ok('A3 已确认：带餐次与最终条目（没改过就不标修改）', pure.done.includes('已确认写入今日午餐') && !pure.done.includes('用户修改后确认'), pure.done)
    ok('A4 用户改过克重 → 标「用户修改后确认」', pure.edited.includes('用户修改后确认'), pure.edited)
    ok('A5 旧数据（无 mealType / proposal）不炸、不编造餐次', pure.legacy.includes('已确认写入今日饮食') && !pure.legacy.includes('用户修改后确认'), pure.legacy)
    ok(
      'A6 超过 6 张：只列最近 6 张 + 省略计数，编号仍按会话顺序',
      (pure.many.match(/- 食物卡 /g) ?? []).length === 6 &&
        pure.many.includes('（更早的 1 张食物卡已省略）') &&
        pure.many.includes('食物卡 2：') &&
        !pure.many.includes('食物卡 1：'),
      `行数=${(pure.many.match(/- 食物卡 /g) ?? []).length}`,
    )
    ok(
      'A7 纪要行：已写入 / 未写入分开报，未写入的不当成已记录',
      pure.memo.includes('语音纪要《周会》') &&
        pure.memo.includes('已写入 1 条') &&
        pure.memo.includes('未写入 1 条') &&
        pure.memo.includes('明天跑步 30 分钟') &&
        pure.memo.includes('一杯牛奶 250g') &&
        pure.memo.includes('别当成已记录'),
      pure.memo.slice(0, 120),
    )
    ok('A8 只有备注的纪要不是「待处理的卡」，不出行', pure.memoNote === '', JSON.stringify(pure.memoNote))
    ok(
      'A9 只有跨页事件时也成段，且不冒充【卡片状态】',
      pure.onlyOutcome.includes('【AI 提议处理记录】') &&
        pure.onlyOutcome.includes('12 分钟前') &&
        pure.onlyOutcome.includes('1900 → 1800') &&
        !pure.onlyOutcome.includes('【卡片状态】'),
      pure.onlyOutcome.slice(0, 100),
    )
    ok('A10 一小时内用「刚刚」这类相对时间', pure.justNow.includes('刚刚'), pure.justNow.slice(0, 60))
    ok('A11 事件日志上限 10 条（写 12 条只留 10 条）', pure.capped === 10, `capped=${pure.capped}`)
    ok('A12 超过 24 小时的事件被剔除（10 → 9）', pure.afterTtl === 9, `afterTtl=${pure.afterTtl}`)

    /* ---------- B. 端到端：出卡 → 加入记录 → 下一轮知道已写入 ---------- */
    mode = 'food_a'
    await send('我吃了两个鸡蛋和一碗米饭')
    await waitChatRequests(1)
    const sysFirst = systemOf(chatRequests()[0])
    ok(
      'B1 出卡之前不带【食物卡状态】段（没有卡就不发）',
      sysFirst.includes(CHAT_MARK) && cardBlockOf(sysFirst) === '',
      `system 前 40 字：${sysFirst.slice(0, 40)}`,
    )

    await waitFor(`!!document.querySelector('.parse .commit')`, 20000, '食物卡上屏')
    const beforeCommit = chatRequests().length
    await evalJS(`document.querySelector('.parse .commit').click()`)
    await waitFor(`!!document.querySelector('.parse .committed')`, 20000, '卡片进入已确认态')
    const label = await evalJS(`document.querySelector('.parse .committed').textContent.replace(/\\s+/g, ' ').trim()`)
    ok('B2 卡片已确认文案带餐次', /已写入今日(早餐|午餐|晚餐|加餐)/.test(label), label)
    ok('B3 点「加入记录」本身不发模型请求（状态在下一轮带过去）', chatRequests().length === beforeCommit)

    mode = 'chat'
    await send('我一会去跑步，跑 30 分钟，不用倒计时')
    await waitChatRequests(beforeCommit + 1)
    const blockB = cardBlockOf(systemOf(chatRequests().at(-1)))
    ok(
      'B4 下一轮的 system 段说「已确认写入今日X」+ 最终条目',
      /已确认写入今日(早餐|午餐|晚餐|加餐)/.test(blockB) &&
        blockB.includes('鸡蛋 50g') &&
        blockB.includes('米饭 200g'),
      blockB.slice(0, 140),
    )
    ok('B5 已确认的卡不再报「未确认」', blockB !== '' && !/食物卡 \d+：未确认/.test(blockB), '')

    /* ---------- C. 端到端：出卡 → 不处理直接继续聊 ---------- */
    // 换 query 触发整页重载：seed 会清掉 mock 里的会话，这里要的是一张白纸
    await openAiPage('?round=c')
    mode = 'food_b'
    think = true // 先吐思考：占位气泡成了过程段载体，卡另起气泡承接（真实 thinking 模型那条路）
    const beforeC = chatRequests().length
    await send('我喝了一杯牛奶')
    await waitChatRequests(beforeC + 1)
    await waitFor(`!!document.querySelector('.parse .commit')`, 20000, '食物卡上屏（C 组）')
    mode = 'chat'
    think = false
    await send('我一会去跑步，跑 30 分钟，不用倒计时')
    await waitChatRequests(beforeC + 2)
    const blockC = cardBlockOf(systemOf(chatRequests().at(-1)))
    ok(
      'C1 未处理的卡：下一轮 system 段明说「用户没有处理就继续聊」且不等于已记录',
      blockC.includes('未确认') &&
        blockC.includes('牛奶 250g') &&
        blockC.includes('没有处理它就直接继续了对话') &&
        blockC.includes('不要重复出这张卡') &&
        // 整页重载后是干净会话：块里只该有这一张卡
        (blockC.match(/- 食物卡 /g) ?? []).length === 1,
      blockC.slice(0, 140),
    )
    ok('C2 未确认的卡不会被说成「已确认写入」', blockC !== '' && !/食物卡 \d+：已确认写入/.test(blockC), '')

    /* ---------- D. 事件日志 → 注入 + TTL ---------- */
    await evalJS(`localStorage.removeItem('rein.aiCards.v1')`)
    await evalJS(
      `(async () => { const { recordCardOutcome } = await import('/src/ai/cardOutcomes.ts'); recordCardOutcome('target-adjust', '采用了 AI 目标调整建议 —— 热量 1900 → 1800 大卡'); return true })()`,
    )
    const outD = outcomeBlockOf(await sendAndSystem('我现在的目标是多少'))
    ok(
      'D1 记录下来的提议处理结果出现在下一轮【AI 提议处理记录】',
      outD.includes('采用了 AI 目标调整建议') && outD.includes('1900 → 1800') && outD.includes('刚刚'),
      outD.slice(0, 120),
    )
    // 老化到 25 小时前：过了 TTL 就不该再提（结果数据模型自己查得到，事件本身没意义了）
    await evalJS(
      `(() => { const k = 'rein.aiCards.v1'; const list = JSON.parse(localStorage.getItem(k)); list[0].at = Date.now() - 25 * 3600 * 1000; localStorage.setItem(k, JSON.stringify(list)); return true })()`,
    )
    const outD2 = outcomeBlockOf(await sendAndSystem('再问一句'))
    ok('D2 超过 24 小时的事件不再注入', outD2 === '', JSON.stringify(outD2.slice(0, 60)))

    /* ---------- E. 真实路径：目标建议卡「采用」→ 注入 ---------- */
    await evalJS(`localStorage.removeItem('rein.aiCards.v1')`)
    await cdp('Page.navigate', { url: `${APP}/?round=c#/nutrition/adjust` })
    await waitFor(`!!document.querySelector('input[aria-label="描述目标调整"]')`, 25000, '目标调整卡就绪')
    await evalJS(`(() => {
      const el = document.querySelector('input[aria-label="描述目标调整"]')
      el.value = '热量降到 1234'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(`!document.querySelector('button[aria-label="生成调整建议"]').disabled`, 10000, '生成键可用')
    await evalJS(`document.querySelector('button[aria-label="生成调整建议"]').click()`)
    await waitFor(`!!document.querySelector('.proposal .apply')`, 20000, '目标建议卡上屏')
    await evalJS(`document.querySelector('.proposal .apply').click()`)
    await waitFor(`!document.querySelector('.proposal')`, 20000, '建议已采用（卡片收起）')
    await cdp('Page.navigate', { url: `${APP}/?round=c#/ai` })
    await waitFor(`!!document.querySelector('.inbar textarea')`, 25000, 'AI 页就绪（E）')
    const outE = outcomeBlockOf(await sendAndSystem('我刚把目标改了'))
    ok(
      'E1 真实路径：采用目标建议 → 下一轮知道「采用了 AI 目标调整建议」',
      // 不钉具体标签与数值：标签由 config 决定（「能量」），数值会被规则解析钳制
      /采用了 AI 目标调整建议 —— .+ \d+ ?→ ?\d+/.test(outE),
      outE.slice(0, 140),
    )

    /* ---------- G. 真实路径：智能添加写入 → 注入 ---------- */
    await evalJS(`localStorage.removeItem('rein.aiCards.v1')`)
    await cdp('Page.navigate', { url: `${APP}/?round=g#/` })
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('记饮食'))`, 25000, '主页工具格就绪')
    await evalJS(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('记饮食')).click()`)
    await waitFor(`!!document.querySelector('.paste')`, 20000, '智能添加抽屉打开')
    mode = 'smart_food'
    await evalJS(`(() => {
      const el = document.querySelector('.paste')
      el.value = '早上吃了两个鸡蛋'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(`!!document.querySelector('.smart .run') && !document.querySelector('.smart .run').disabled`, 10000, '生成键可用')
    await evalJS(`document.querySelector('.smart .run').click()`)
    await waitFor(`!!document.querySelector('.food-card .commit')`, 30000, '智能添加出食物卡')
    await evalJS(`document.querySelector('.food-card .commit').click()`)
    await waitFor(`!!document.querySelector('.food-card .done')`, 20000, '食物卡已写入')
    await cdp('Page.navigate', { url: `${APP}/?round=g#/ai` })
    await waitFor(`!!document.querySelector('.inbar textarea')`, 25000, 'AI 页就绪（G）')
    sent = 0
    const outG = outcomeBlockOf(await sendAndSystem('我今天吃了什么'))
    ok(
      'G1 真实路径：智能添加写入 → 下一轮记着这件事',
      outG.includes('智能添加记入今日') && outG.includes('鸡蛋'),
      outG.slice(0, 140),
    )

    /* ---------- F. 真实路径：语音纪要卡（写入状态随点随生效） ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: MEMO_CHAT_SEED })
    await openAiPage('?round=f')
    await evalJS(`(async () => {
      const { voiceService } = await import('/src/services/voiceService.ts')
      await voiceService.memoCreate({
        id: 'memo1', chatId: 'chatmemo', messageId: 'mm2', title: '周会', audioPath: null,
        durationMs: 60000, words: 20, sentencesJson: '[]',
        summaryJson: JSON.stringify([
          { kind: 'todo', text: '明天跑步 30 分钟', refs: [0], written: true, todo: { title: '明天跑步 30 分钟' } },
          { kind: 'food', text: '一杯牛奶 250g', refs: [1], written: false, food: { name: '牛奶', grams: 250 } },
          { kind: 'note', text: '随便聊聊', refs: [] },
        ]),
      })
      return true
    })()`)
    const blockF = cardBlockOf(await sendAndSystem('纪要里那两件事怎么样了'))
    ok(
      'F1 纪要卡：写入状态进注入（已写入 1 条 / 未写入 1 条）',
      blockF.includes('语音纪要《周会》') &&
        blockF.includes('已写入 1 条') &&
        blockF.includes('未写入 1 条') &&
        blockF.includes('一杯牛奶 250g'),
      blockF.slice(0, 160),
    )
    // 走真实入口写掉那条未写入的（voiceRuntime.writeMemoItem）→ 下一轮就该变成「都写完了」
    await evalJS(`(async () => {
      const { voiceService } = await import('/src/services/voiceService.ts')
      const { writeMemoItem } = await import('/src/system/voiceRuntime.ts')
      const memo = await voiceService.memoGet('memo1')
      await writeMemoItem(memo, memo.summary.find((x) => x.kind === 'food' && !x.written))
      return true
    })()`)
    const blockF2 = cardBlockOf(await sendAndSystem('那我下午还吃点什么好'))
    ok(
      'F2 用户刚写入的那条立刻反映到下一轮（未写入 → 已写入，不缓存）',
      blockF2.includes('已写入 2 条') && !blockF2.includes('未写入'),
      blockF2.slice(0, 160),
    )
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
    try {
      const tail = await evalJS(
        `(document.querySelector('.msgs')?.textContent ?? '').replace(/\\s+/g, ' ').slice(-400)`,
      )
      console.log(`      [诊断] 消息区尾部：${tail}`)
      const dom = await evalJS(`(() => ({
        msgs: [...document.querySelectorAll('.msg')].map((el) => el.className + '::' + el.textContent.replace(/\\s+/g, ' ').slice(0, 40)),
        process: !!document.querySelector('.process-section'),
        sendDisabled: document.querySelector('.inbar .send')?.disabled,
      }))()`)
      console.log(`      [诊断] DOM：${JSON.stringify(dom)}`)
      console.log(`      [诊断] 页内最后 ${Math.min(logs.length, 20)} 条 error/异常/探针：\n        ${logs.slice(-20).join('\n        ')}`)
      const direct = await evalJS(`(async () => {
        const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))])
        const t0 = Date.now()
        try {
          const res = await race(
            fetch('http://127.0.0.1:${providerPort}/v1/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer sk-probe' },
              body: JSON.stringify({ model: 'probe-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
            }).then(async (r) => ({ status: r.status, len: (await r.text()).length })), 8000)
          return { ms: Date.now() - t0, res }
        } catch (e) {
          return { ms: Date.now() - t0, error: String(e) }
        }
      })()`)
      console.log(`      [诊断] 页内直连假 provider：${JSON.stringify(direct)}`)
      const probes = await evalJS(`(async () => {
        const out = { fetchWrapped: window.fetch.toString().includes('__origFetch') }
        const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))])
        try {
          const { toParsedItems } = await import('/src/ai/foodMatch.ts')
          const t0 = Date.now()
          const items = await race(toParsedItems([{ foodName: '鸡蛋', grams: 50, kcalEstimate: 70 }]), 5000)
          out.toParsedItems = items === 'TIMEOUT' ? 'TIMEOUT' : { ms: Date.now() - t0, count: items.length }
        } catch (e) {
          out.toParsedItems = 'ERR ' + String(e)
        }
        return out
      })()`)
      console.log(`      [诊断] 页内探测：${JSON.stringify(probes)}`)
      await shot('fail')
    } catch {
      /* 页面已经不可用（导航中断等）：忽略 */
    }
  } finally {
    edge.kill()
    provider.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

void main()
