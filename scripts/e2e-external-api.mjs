/**
 * e2e-external-api —— 对外服务网关（WebSocket 网关）端到端。
 *
 * **真机 App**（Tauri + WebView2），与 `scripts/e2e-app-campus.mjs` 同一套接入方式：
 * 浏览器 mock（`src/mock/server.ts`）只伪造 6 条管理命令与授权弹窗，**没有真的 WS 监听**，
 * 所以对外接口这一层只能在真机进程里验 —— 它走的是：
 *   外部 WS 客户端 → server.rs 握手闸门 → 首帧令牌 → auth.rs 四态授权 → methods.rs 分发
 *   → 各域 `*_on`（同一把 state.db.lock()）→ 同步 update_hook 捕获 → ChangeFeed → 回推给订阅方。
 *
 * 覆盖场景：
 *   0. 服务启动与停止（开关切换、端口回写、停止后端口关闭）
 *   1. 无令牌的连接被拒（首帧不是合法 ClientHello → unauthorized + 1008）
 *   2. 四态授权：
 *      - allow-session：连上即通、**断链后失效**（重连再次待决）
 *      - allow-always ：下发一次性 clientToken、**带令牌免弹窗重连**、撤销后旧令牌失效
 *      - ignore      ：不授权不拒绝、连接维持待决；静默窗口过后**会再次询问**
 *      - deny        ：回 denied + 1008 关闭；**再次连接被直接拒**（不弹窗）
 *   3. scope 越权调用被拒（只授 schedule.read 时调 schedule.create → forbidden_scope）
 *   4. 日程读 / 写往返（create → list → update → delete，且 DTO 剥离内部列）
 *   5. 变更事件推送（写入被同步钩子捕获 → 订阅方收到 gateway.change）
 *   6. 带 Origin 头的握手被拒（403，模拟网页发起）
 *
 * ── 前置（脚本不启动 App、不跑浏览器）────────────────────────────────
 *   1) 起真机实例并打开 WebView2 调试端口：
 *        set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *        npm run app:dev
 *   2) **数据目录必须隔离**（不要写用户真身库，见 docs/EXTERNAL-API.md 与 REIN_DATA_DIR）：
 *        set REIN_DATA_DIR=%TEMP%\rein-e2e-external-api
 *      （脚本本身不碰数据目录，只读环境变量；这里只提要求。）
 *   3) 运行：node scripts/e2e-external-api.mjs
 *
 * 端口：WebView2 调试端口用 REIN_APP_DEBUG_PORT（默认 9222）。
 * 忽略的「再次询问」要跨过网关的 30s 限频静默窗口，故默认等 33s；
 * 可用 E2E_IGNORE_REPROMPT_MS 调（设 0 则跳过这段长等待，会把这 1 项标记为跳过）。
 */
import net from 'node:net'
import crypto from 'node:crypto'

const CDP_PORT = Number(process.env.REIN_APP_DEBUG_PORT ?? 9222)
const REPROMPT_MS = Number(process.env.E2E_IGNORE_REPROMPT_MS ?? 33000)
const CLIENT_NAME = 'e2e 外部客户端'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => crypto.randomUUID()

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, why) {
  results.push({ name, pass: true, skipped: true, detail: why })
  console.log(`SKIP  ${name} — ${why}`)
}

/* ---------------- CDP（与 e2e-app-campus.mjs 同形） ---------------- */

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

async function connect() {
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && /localhost:1420|tauri/.test(t.url ?? ''))
        ?? list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  if (!target) throw new Error(`连不上 WebView2 调试端口 ${CDP_PORT}，App 起了吗？`)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
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
  console.log(`     已连上 ${target.url}`)
}

/* ---------------- 页面内：管理命令封装（走 gatewayService） ---------------- */

/** 在页面里动态载入 gatewayService 并执行一次管理命令，返回其结果。 */
async function pageCall(expr) {
  return evalJS(`(async () => {
    const { gatewayService } = await import('/src/services/gatewayService.ts')
    ${expr}
  })()`)
}

const gwSetEnabled = (enabled) =>
  pageCall(`return await gatewayService.setEnabled(${JSON.stringify(enabled)})`)

const gwStatus = () => pageCall('return await gatewayService.status()')

const gwRespond = (requestId, decision, scopes) =>
  pageCall(`await gatewayService.authorizationRespond(${JSON.stringify(requestId)}, ${JSON.stringify(decision)}, ${JSON.stringify(scopes)}); return true`)

const gwRevoke = (clientId) =>
  pageCall(`return await gatewayService.revokeClient(${JSON.stringify(clientId)})`)

/* ---------------- 原始 WS 客户端（Node 内置 WebSocket，按 127.0.0.1 连） ---------------- */
// Host 闸门放行集合含 127.0.0.1 / ::1 / [::1] / localhost（带端口形式端口须等于实际监听端口），
// 所以连 localhost 也不会被 403。本脚本统一用 127.0.0.1，只为消除 DNS 解析的不确定性。

function wsOpen(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url)
    const c = { ws: sock, messages: [], close: null, error: false, opened: false }
    sock.addEventListener('message', (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { m = { raw: String(e.data) } }
      c.messages.push(m)
    })
    sock.addEventListener('close', (e) => { c.close = { code: e.code, reason: e.reason } })
    sock.addEventListener('error', () => { c.error = true })
    const timer = setTimeout(() => {
      if (!c.opened) {
        try { sock.close() } catch { /* 忽略 */ }
        reject(new Error('WS 打开超时'))
      }
    }, timeoutMs)
    sock.addEventListener('open', () => { c.opened = true; clearTimeout(timer); resolve(c) })
  })
}

function hello(c, clientId, extra = {}) {
  c.ws.send(JSON.stringify({ v: 1, clientId, clientName: CLIENT_NAME, ...extra }))
}

async function waitMsg(c, pred, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = c.messages.find(pred)
    if (hit) return hit
    await sleep(40)
  }
  return null
}

async function waitClose(c, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (c.close) return c.close
    await sleep(40)
  }
  return null
}

let rpcSeq = 0
async function rpc(c, method, params = {}, timeoutMs = 10000) {
  const id = `r-${++rpcSeq}-${uuid().slice(0, 8)}`
  c.ws.send(JSON.stringify({ v: 1, id, method, params }))
  const m = await waitMsg(c, (x) => x.id === id && 'ok' in x, timeoutMs)
  if (!m) throw new Error(`RPC 无响应：${method}`)
  return m
}

const waitPending = (c) => waitMsg(c, (m) => m.event === 'gateway.auth.pending', 8000)
const waitGranted = (c) => waitMsg(c, (m) => m.event === 'gateway.auth.granted', 8000)
const waitDenied = (c) => waitMsg(c, (m) => m.event === 'gateway.auth.denied', 8000)

/* ---------------- 原始 TCP：握手闸门 / 端口开关探测 ---------------- */

function rawConnect(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.setTimeout(timeoutMs)
    s.once('connect', () => resolve(s))
    s.once('error', (e) => { s.destroy(); reject(e) })
    s.once('timeout', () => { s.destroy(); reject(new Error('connect timeout')) })
  })
}

/** 手工发一次带 Origin 的 WS 握手，读回 HTTP 状态码（Node WebSocket 不允许自定义头）。 */
async function handshakeWithOrigin(port, origin) {
  const key = crypto.randomBytes(16).toString('base64')
  const req = [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${origin}`,
    '',
    '',
  ].join('\r\n')
  const s = await rawConnect(port)
  return await new Promise((resolve) => {
    const chunks = []
    s.on('data', (d) => {
      chunks.push(d)
      const text = Buffer.concat(chunks).toString('utf8')
      const m = text.match(/^HTTP\/1\.1 (\d{3})/)
      if (m) { resolve({ status: Number(m[1]), line: text.split('\r\n')[0] }); s.destroy() }
    })
    s.on('close', () => resolve({ status: 0, line: Buffer.concat(chunks).toString('utf8').split('\r\n')[0] ?? '' }))
    s.write(req)
    setTimeout(() => { resolve({ status: -1, line: 'no response' }); s.destroy() }, 4000)
  })
}

/* ---------------- 主流程 ---------------- */

const createdClients = []

async function main() {
  await connect()

  const runtime = await evalJS(`({ tauri: '__TAURI_INTERNALS__' in window })`)
  ok('连上的是真机 App（Tauri 运行时，WS 服务端只在这里）', runtime.tauri === true)
  if (!runtime.tauri) throw new Error('不是 Tauri 环境，拒绝继续')

  /* ---- 0. 服务启动与停止 ---- */
  const off0 = await gwSetEnabled(false)
  ok('服务停止态：enabled=false 且端口为空', off0.enabled === false && off0.port == null,
    JSON.stringify({ enabled: off0.enabled, port: off0.port }))

  const on1 = await gwSetEnabled(true)
  ok('服务启动态：enabled=true 且回写实际端口', on1.enabled === true && typeof on1.port === 'number',
    `port=${on1.port}`)
  const PORT = on1.port
  const URL = `ws://127.0.0.1:${PORT}`
  {
    let reachable = false
    try { const s = await rawConnect(PORT); reachable = true; s.destroy() } catch { /* 连不上 */ }
    ok('启动后端口可连', reachable === true, `127.0.0.1:${PORT}`)
  }

  /* ---- 1. 无令牌的连接被拒 ---- */
  {
    const c = await wsOpen(URL)
    // 首帧直接发一条业务请求（不是 ClientHello，缺 clientId）→ 服务端按首帧格式错误回 unauthorized
    c.ws.send(JSON.stringify({ v: 1, id: 'no-token-1', method: 'schedule.listAll' }))
    const err = await waitMsg(c, (m) => m.ok === false && m.error, 6000)
    const cl = await waitClose(c, 6000)
    ok('无令牌的连接被拒：回 unauthorized 且 1008 关闭',
      err != null && err.error.code === 'unauthorized' && cl?.code === 1008,
      `code=${err?.error?.code ?? '无'} close=${cl?.code ?? '无'}`)
  }

  /* ---- 2a. 四态：允许本次会话（断链即失效） ---- */
  const cidSession = uuid()
  createdClients.push(cidSession)
  {
    const c = await wsOpen(URL)
    hello(c, cidSession)
    const pend = await waitPending(c)
    ok('新客户端首帧无令牌进待决（收到 gateway.auth.pending）', pend != null,
      pend ? `requestId=${pend.data?.requestId}` : '未收到')
    await gwRespond(pend.data.requestId, 'allow-session', ['schedule.read'])
    const granted = await waitGranted(c)
    ok('本次会话授权：grant=session（且不下发 clientToken）',
      granted?.data?.grant === 'session' && granted?.data?.clientToken == null,
      JSON.stringify(granted?.data))
    const r = await rpc(c, 'schedule.listAll', {})
    ok('会话授权后可读日程（schedule.listAll 成功）', r.ok === true && Array.isArray(r.result))
    c.ws.close()
    await sleep(400)

    const c2 = await wsOpen(URL)
    hello(c2, cidSession)
    const pend2 = await waitPending(c2)
    ok('本次会话授权随断链失效：重连再次进待决', pend2 != null,
      pend2 ? '重新弹窗' : '未再弹窗（错误：会话授权被持久化了）')
    createdClients.push(cidSession) // 重连同一 client，去重无碍
    c2.ws.close()
  }

  /* ---- 2b. 四态：始终允许（可重连、撤销后失效） ---- */
  const cidAlways = uuid()
  createdClients.push(cidAlways)
  let clientToken = null
  {
    const c = await wsOpen(URL)
    hello(c, cidAlways)
    const pend = await waitPending(c)
    await gwRespond(pend.data.requestId, 'allow-always', ['schedule.read', 'schedule.create', 'schedule.write'])
    const granted = await waitGranted(c)
    clientToken = granted?.data?.clientToken ?? null
    ok('始终允许：grant=always 且一次性下发 rein_ext_ 令牌',
      granted?.data?.grant === 'always' && typeof clientToken === 'string' && clientToken.startsWith('rein_ext_'),
      `token 前缀=${clientToken ? clientToken.slice(0, 12) + '…' : '无'}`)
    c.ws.close()
    await sleep(400)

    const c2 = await wsOpen(URL)
    hello(c2, cidAlways, { clientToken })
    const r2 = await rpc(c2, 'schedule.listAll', {})
    await sleep(500) // 若会弹窗，pending 事件此刻应已到
    const noPend = !c2.messages.some((m) => m.event === 'gateway.auth.pending')
    ok('始终允许可重连：带令牌免弹窗直接放行', r2.ok === true && noPend === true,
      `listAll ok=${r2.ok} pending=${!noPend}`)

    const st = await gwStatus()
    ok('设置页客户端列表出现该 always 客户端',
      Array.isArray(st.clients) && st.clients.some((x) => x.clientId === cidAlways && x.grant === 'always'),
      `clients=${st.clients?.length ?? 0}`)

    await gwRevoke(cidAlways)
    const c3 = await wsOpen(URL)
    hello(c3, cidAlways, { clientToken })
    // 撤销后 token_hash 被清 → find_by_token 落空 → 一律 unauthorized + 1008（不再进待决）。
    const err3 = await waitMsg(c3, (m) => m.ok === false && m.error, 6000)
    const cl3 = await waitClose(c3, 6000)
    ok('撤销后旧令牌失效：重连回 unauthorized 且 1008 关闭',
      err3 != null && err3.error.code === 'unauthorized' && cl3?.code === 1008,
      `code=${err3?.error?.code ?? '无'} close=${cl3?.code ?? '无'}`)
    c2.ws.close()
    c3.ws.close()
  }

  /* ---- 2c. 四态：忽略（不决策、维持待决；静默窗口过后再次询问） ---- */
  const cidIgnore = uuid()
  createdClients.push(cidIgnore)
  {
    const c = await wsOpen(URL)
    hello(c, cidIgnore)
    const pend = await waitPending(c)
    await gwRespond(pend.data.requestId, 'ignore', [])
    await sleep(1200)
    const gotGranted = c.messages.some((m) => m.event === 'gateway.auth.granted')
    const gotDenied = c.messages.some((m) => m.event === 'gateway.auth.denied')
    ok('忽略：不授权也不拒绝，连接维持待决（未关闭）',
      !gotGranted && !gotDenied && c.close == null,
      `granted=${gotGranted} denied=${gotDenied} closed=${c.close?.code ?? '未关'}`)
    c.ws.close()
  }
  if (REPROMPT_MS > 0) {
    await sleep(REPROMPT_MS)
    const c2 = await wsOpen(URL)
    hello(c2, cidIgnore)
    const pend2 = await waitPending(c2)
    ok('忽略后（越过 30s 静默窗口）会再次询问', pend2 != null,
      pend2 ? `再次弹窗（等待 ${Math.round(REPROMPT_MS / 1000)}s）` : '未再弹窗')
    if (pend2) {
      await gwRespond(pend2.data.requestId, 'allow-session', ['schedule.read'])
      await waitGranted(c2)
    }
    c2.ws.close()
  } else {
    skip('忽略后（越过静默窗口）会再次询问', 'E2E_IGNORE_REPROMPT_MS=0，跳过长等待')
  }

  /* ---- 2d. 四态：拒绝（直接拒、持久化后再连还是直接拒） ---- */
  const cidDeny = uuid()
  createdClients.push(cidDeny)
  {
    const c = await wsOpen(URL)
    hello(c, cidDeny)
    const pend = await waitPending(c)
    await gwRespond(pend.data.requestId, 'deny', [])
    const denied = await waitDenied(c)
    const cl = await waitClose(c)
    ok('拒绝：回 gateway.auth.denied 并以 1008 关闭', denied != null && cl?.code === 1008,
      `denied=${denied != null} close=${cl?.code ?? '无'}`)

    const c2 = await wsOpen(URL)
    hello(c2, cidDeny)
    const denied2 = await waitDenied(c2)
    const noPend = !c2.messages.some((m) => m.event === 'gateway.auth.pending')
    const cl2 = await waitClose(c2)
    ok('拒绝持久化：再连被直接拒（denied 1008，不再询问）',
      denied2 != null && noPend === true && cl2?.code === 1008,
      `denied=${denied2 != null} pending=${!noPend} close=${cl2?.code ?? '无'}`)
  }

  /* ---- 3. scope 越权调用被拒 ---- */
  const cidScope = uuid()
  createdClients.push(cidScope)
  {
    const c = await wsOpen(URL)
    hello(c, cidScope)
    const pend = await waitPending(c)
    await gwRespond(pend.data.requestId, 'allow-session', ['schedule.read'])
    await waitGranted(c)
    const bad = await rpc(c, 'schedule.create', { title: '越权日程', date: '2026-01-01' })
    ok('scope 越权调用被拒：forbidden_scope',
      bad.ok === false && bad.error?.code === 'forbidden_scope', `code=${bad.error?.code}`)
    const still = await rpc(c, 'schedule.listAll', {})
    ok('越权被拒后连接仍可用（只回错误帧，不关连）', still.ok === true)
    c.ws.close()
  }

  /* ---- 4/5. 日程读写往返 + 变更事件推送 ---- */
  const cidRW = uuid()
  const cidSub = uuid()
  createdClients.push(cidRW, cidSub)
  {
    const rw = await wsOpen(URL)
    hello(rw, cidRW)
    const p1 = await waitPending(rw)
    await gwRespond(p1.data.requestId, 'allow-session', ['schedule.read', 'schedule.create', 'schedule.write'])
    await waitGranted(rw)

    const sub = await wsOpen(URL)
    hello(sub, cidSub)
    const p2 = await waitPending(sub)
    await gwRespond(p2.data.requestId, 'allow-session', ['schedule.read'])
    await waitGranted(sub)

    const created = await rpc(rw, 'schedule.create', {
      title: 'E2E 日程', date: '2026-01-15', startMin: 600, durationMin: 30, category: 'general', priority: 0,
    })
    const todo = created.result
    ok('日程写入：schedule.create 返回带 id 的 DTO',
      created.ok === true && typeof todo?.id === 'number' && todo.title === 'E2E 日程',
      `id=${todo?.id} title=${todo?.title}`)
    ok('对外 DTO 剥离内部列（无 attachments/recRule/createdAt）',
      todo != null && !('attachments' in todo) && !('recRule' in todo) && !('createdAt' in todo))
    const todoId = todo?.id

    const listed = await rpc(rw, 'schedule.list', { startDate: '2026-01-01', endDate: '2026-01-31' })
    ok('日程读取：schedule.list 命中刚写入的行',
      listed.ok === true && Array.isArray(listed.result) && listed.result.some((x) => x.id === todoId))

    const upd = await rpc(rw, 'schedule.update', {
      todo: { id: todoId, title: 'E2E 日程（改）', category: 'general', priority: 0, status: 'done' },
    })
    ok('日程修改：schedule.update 生效（title/status 已变）',
      upd.ok === true && upd.result?.title === 'E2E 日程（改）' && upd.result?.status === 'done',
      JSON.stringify({ title: upd.result?.title, status: upd.result?.status }))

    const change = await waitMsg(sub, (m) => m.event === 'gateway.change', 10000)
    ok('变更事件推送：订阅方收到 gateway.change（seq/kind 齐备）',
      change != null && typeof change.data?.seq === 'number' && typeof change.data?.kind === 'string',
      change ? JSON.stringify(change.data) : '未收到（同步钩子未广播？）')

    const del = await rpc(rw, 'schedule.delete', { id: todoId })
    const after = await rpc(rw, 'schedule.list', { startDate: '2026-01-01', endDate: '2026-01-31' })
    ok('日程删除：schedule.delete 后 list 不再命中',
      del.ok === true && after.ok === true && !after.result.some((x) => x.id === todoId))

    rw.ws.close()
    sub.ws.close()
  }

  /* ---- 6. 带 Origin 头的握手被拒（模拟网页发起） ---- */
  {
    const r = await handshakeWithOrigin(PORT, 'http://evil.example')
    ok('带 Origin 的握手被拒（403，挡浏览器页面）', r.status === 403, `${r.line}`)
  }

  /* ---- 收尾：撤销本轮建的客户端，停服务，端口应关闭 ---- */
  for (const id of [...new Set(createdClients)]) {
    try { await gwRevoke(id) } catch { /* 已无记录，忽略 */ }
  }
  const off = await gwSetEnabled(false)
  ok('服务停止：enabled=false 且端口清空', off.enabled === false && off.port == null,
    JSON.stringify({ enabled: off.enabled, port: off.port }))
  {
    let refused = false
    try { const s = await rawConnect(PORT); s.destroy() } catch { refused = true }
    ok('停止后端口不再接受连接', refused === true, `127.0.0.1:${PORT}`)
  }
}

main()
  .then(() => {
    try { ws?.close() } catch { /* 忽略 */ }
    const failed = results.filter((r) => !r.pass)
    const skipped = results.filter((r) => r.skipped).length
    console.log(`\n${results.length - skipped - failed.length}/${results.length - skipped} 通过${skipped ? `（${skipped} 项跳过）` : ''}`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('e2e-external-api 失败：', e instanceof Error ? e.message : e)
    try { ws?.close() } catch { /* 忽略 */ }
    process.exit(1)
  })
