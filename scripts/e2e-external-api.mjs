/**
 * e2e-external-api —— 对外服务网关（WebSocket 网关）端到端。
 *
 * **真机 App**（Tauri + WebView2），与 `scripts/e2e-app-campus.mjs` 同一套接入方式：
 * 浏览器 mock（`src/mock/server.ts`）只伪造管理命令与授权弹窗，**没有真的 WS 监听**，
 * 所以对外接口这一层只能在真机进程里验 —— 它走的是：
 *   外部 WS 客户端 → server.rs 握手闸门 → 首帧令牌 → auth.rs 四态授权 → methods.rs 分发
 *   → 各域 `*_on`（同一把 state.db.lock()）→ 同步 update_hook 捕获 → ChangeFeed → 回推给订阅方。
 *
 *
 * ⚠️ **两道限频会把整个套件卡住，跑不满是预期**：服务端对同一来源 IP 有「弹窗 ≤3 次/分钟」
 * （`auth.rs` 的 `PROMPT_PER_MIN_IP`）与「未鉴权失败 ≥5 次/分钟封 10 分钟」（`AUTH_FAIL_PER_MIN`）。
 * 本套件一共要 4~5 次弹窗、并刻意制造多次 403/越权，所以单次运行必然先耗尽额度：
 * 后面的场景会 SKIP（脚本已按滚动窗口自动让路），最后甚至可能因为封禁而 WS 打不开。
 * 要跑满：**每段之间重启一次真机实例**（额度与封禁都在进程内存里），或分段跑。
 * 闸门逻辑本身有确定性单测兜底（`server.rs` 的 `origin_gate_*` / `host_gate_*` / scope 判据等）。
 * 覆盖场景：
 *   0. 服务启动与停止（开关切换、端口回写、停止后端口关闭）
 *   1. 无令牌的连接被拒（首帧不是合法 ClientHello → unauthorized + 1008）
 *   2. 四态授权：
 *      - allow-session：连上即通、**断链后失效**（重连再次待决）
 *      - allow-always ：下发一次性 clientToken、**带令牌免弹窗重连**、撤销后旧令牌失效
 *      - ignore      ：不授权不拒绝、连接维持待决；静默窗口过后**会再次询问**
 *      - deny        ：回 denied + 1008 关闭；**再次连接被直接拒**（不弹窗）；
 *                      出现在「被拦下」清单，**解除后重连能重新弹窗并授权成功**（§16）
 *   3. scope 越权调用被拒（只授 schedule.read 时调 schedule.create → forbidden_scope）
 *   4. 日程读 / 写往返（create → list → update → **delete（schedule.delete 独立 scope）**，DTO 剥离内部列）
 *   5. 变更事件推送（写入被同步钩子捕获 → 订阅方收到 gateway.change）
 *   6. 带 Origin 的握手（§15）：白名单为空时带 Origin 的握手 403、并落「被拦下的来源」；
 *      一键加入白名单后同一 Origin **放行（101）**。（只做这两次负向握手：每次 403 都计入
 *      按来源 IP 的未鉴权失败限频，多加一次就可能把后面的用例封掉。）
 *
 * ── 第二轮新增（本层扩写，docs/EXTERNAL-API.md §13~§16）──────────────
 *   7. schedule 域新增读方法（schedule.read）：schedule.campus（课表视图，含幂等物化
 *      副作用）/ schedule.programs / schedule.programActive 正常读 + 越权。
 *   8. workout 会话级写入（workout.write，走下行受理回执）：sessionActive 读 +
 *      sessionStart / sessionSnapshot / sessionFinish / sessionAbort 各回 {accepted:true}。
 *   9. 删除方法与「写 ≠ 删」：workout.delete 走 workout.delete（**不是** workout.write）；
 *      schedule.delete 同理独立于 schedule.write。被拦下时回 forbidden_scope。
 *  10. 番茄钟运行态（§14.1）：pomodoro.status 读 FocusRuntime（前端 focus_publish 上报后
 *      可读到；focus_unpublish 后回 null）；pomodoro.start/pause/stop 各回受理回执，
 *      缺 pomodoro.control 时 forbidden_scope。
 *  11. 审计参数摘要（§17.4）：gateway_audit_recent 能读到写方法的参数摘要（detail）与
 *      被拒记录（decision=denied）。
 *
 * 复用纪律：只用两个「全权 / 窄权」客户端跑完 7~11（各申请一次弹窗），
 * 因为网关有**按来源 IP** 的限频：授权弹窗 ≤3 次/分钟、未鉴权失败 ≥5 次/分钟即封 10 分钟
 * （auth.rs PROMPT_PER_MIN_IP / AUTH_FAIL_PER_MIN / AUTH_BAN）。整脚本的负向握手刻意
 * 压在阈值内；复跑前最好重启一次真机实例（封禁与限频状态在进程内存里）。
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
import { WebSocket as WsHeaderClient } from 'ws'

const CDP_PORT = Number(process.env.REIN_APP_DEBUG_PORT ?? 9222)
const REPROMPT_MS = Number(process.env.E2E_IGNORE_REPROMPT_MS ?? 33000)
const CLIENT_NAME = 'e2e 外部客户端'

/** 全部 10 个 scope（顺序同 Rust `Scope::ALL` / `src/types/externalAccess.ts` 的 GATEWAY_SCOPES）。 */
const ALL_SCOPES = [
  'schedule.read', 'schedule.create', 'schedule.write', 'schedule.delete',
  'workout.read', 'workout.write', 'workout.delete',
  'pomodoro.read', 'pomodoro.write', 'pomodoro.control',
]

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

/** 按来源 IP 弹窗限频（`PROMPT_PER_MIN_IP=3`/60s）时 `waitPending` 会返回 null ——
 *  不炸脚本，降级为 SKIP 并提示重启真机实例。2a–2d 共用这一条说明。 */
const PROMPT_LIMIT_SKIP = '未收到 gateway.auth.pending（多半是按 IP 弹窗限频 ≤3/分钟，重启真机实例后重跑）'

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
      target = list.find((t) => t.type === 'page' && /localhost:\d+|127\.0\.0\.1:\d+|tauri/.test(t.url ?? ''))
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

const gwSetAllowedOrigins = (origins) =>
  pageCall(`return await gatewayService.setAllowedOrigins(${JSON.stringify(origins)})`)

const gwAuditRecent = (limit, clientId) =>
  pageCall(`return await gatewayService.auditRecent(${JSON.stringify(limit ?? null)}, ${JSON.stringify(clientId ?? null)})`)

const gwFocusPublish = (snapshot) =>
  pageCall(`return await gatewayService.focusPublish(${JSON.stringify(snapshot)})`)

const gwFocusUnpublish = () => pageCall('return await gatewayService.focusUnpublish()')

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

/**
 * 按来源 IP 的弹窗限频是 3 次/60s（`auth.rs` 的 `PROMPT_PER_MIN_IP`）。本脚本连着的场景
 * 一共要 4~5 次弹窗，用满之后第 4 次**根本不会出现** —— 原先的表现就是「后续断言全崩、
 * 最后 WS 打开超时」。这里按窗口自动让路：每用满 3 次就等到下一个 60s 窗口再继续。
 */
const promptTimes = []
async function pacePrompts() {
  // 服务端用的是**滚动**窗口（auth.rs 的 PROMPT_PER_MIN_IP = 3/60s）：固定窗口会漏 ——
  // 上一个窗口末尾 3 次 + 这个窗口开头 3 次，滚动一分钟里就是 6 次，照样被挡。
  // 所以只留最近 3 次的时间戳，`waitMs` 等的是**最早那次滑出 60s**。
  const now = Date.now()
  while (promptTimes.length > 3) promptTimes.shift()
  if (promptTimes.length >= 3 && now - promptTimes[0] < 60_000) {
    const waitMs = 60_000 - (now - promptTimes[0]) + 1500
    console.log(`      （按 IP 弹窗最近 60s 已用满 3 次，等 ${Math.round(waitMs / 1000)}s 跨窗口）`)
    await new Promise((r) => setTimeout(r, waitMs))
    promptTimes.length = 0
  }
  promptTimes.push(Date.now())
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
/** 用真 WebSocket 客户端带自定义 `Origin` 头握手（`ws` 包）。
 *  为什么不用裸 HTTP 请求：那样写出来的请求 tungstenite 直接判 `Handshake not finished`，
 *  回调都走不到（既没有 403 也没有审计记录）—— 看上去像产品没拦，其实是脚本没握上手。
 *  真客户端还顺带验了「HTML 小组件（浏览器内核）带 Origin 来连」这条真实路径。
 *  返回形状与断言保持不变：`{ status, line }`，101 = 放行。 */
async function handshakeWithOrigin(port, origin) {
  return await new Promise((resolve) => {
    const sock = new WsHeaderClient(`ws://127.0.0.1:${port}/`, { headers: { Origin: origin } })
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    sock.on('open', () => { done({ status: 101, line: 'HTTP/1.1 101 Switching Protocols' }); sock.close() })
    sock.on('unexpected-response', (_req, res) => { done({ status: res.statusCode, line: `HTTP/1.1 ${res.statusCode}` }); sock.terminate() })
    sock.on('error', (e) => done({ status: 0, line: String(e?.message ?? e) }))
    setTimeout(() => { try { sock.terminate() } catch { /* 忽略 */ } done({ status: -1, line: 'no response' }) }, 5000)
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
    await pacePrompts()
    const c = await wsOpen(URL)
    hello(c, cidSession)
    const pend = await waitPending(c)
    ok('新客户端首帧无令牌进待决（收到 gateway.auth.pending）', pend != null,
      pend ? `requestId=${pend.data?.requestId}` : '未收到')
    if (!pend) {
      skip('四态·允许本次会话（断链即失效）', PROMPT_LIMIT_SKIP)
    } else {
      await gwRespond(pend.data.requestId, 'allow-session', ['schedule.read'])
      const granted = await waitGranted(c)
      ok('本次会话授权：grant=session（且不下发 clientToken）',
        granted?.data?.grant === 'session' && granted?.data?.clientToken == null,
        JSON.stringify(granted?.data))
      const r = await rpc(c, 'schedule.listAll', {})
      ok('会话授权后可读日程（schedule.listAll 成功）', r.ok === true && Array.isArray(r.result))
      c.ws.close()
      await sleep(400)

      await pacePrompts()
      const c2 = await wsOpen(URL)
      hello(c2, cidSession)
      const pend2 = await waitPending(c2)
      ok('本次会话授权随断链失效：重连再次进待决', pend2 != null,
        pend2 ? '重新弹窗' : '未再弹窗（错误：会话授权被持久化了）')
      // 立刻裁决掉这条待决，别让它悬到 60s 超时——那会白记一次按 IP 的失败限频（§16 规则 6），
      // 把后面负向用例的封 IP 预算吃掉。
      if (pend2) {
        await gwRespond(pend2.data.requestId, 'allow-session', ['schedule.read'])
        await waitGranted(c2)
      }
      c2.ws.close()
    }
  }

  /* ---- 2b. 四态：始终允许（可重连、撤销后失效） ---- */
  const cidAlways = uuid()
  createdClients.push(cidAlways)
  let clientToken = null
  {
    await pacePrompts()
    const c = await wsOpen(URL)
    hello(c, cidAlways)
    const pend = await waitPending(c)
    if (!pend) {
      skip('四态·始终允许（可重连、撤销后失效）', PROMPT_LIMIT_SKIP)
      c.ws.close()
    } else {
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
  }

  /* ---- 2c. 四态：忽略（不决策、维持待决；静默窗口过后再次询问） ---- */
  const cidIgnore = uuid()
  createdClients.push(cidIgnore)
  {
    await pacePrompts()
    const c = await wsOpen(URL)
    hello(c, cidIgnore)
    const pend = await waitPending(c)
    if (!pend) {
      skip('四态·忽略（不决策、维持待决）', PROMPT_LIMIT_SKIP)
    } else {
    await gwRespond(pend.data.requestId, 'ignore', [])
    await sleep(1200)
    const gotGranted = c.messages.some((m) => m.event === 'gateway.auth.granted')
    const gotDenied = c.messages.some((m) => m.event === 'gateway.auth.denied')
    ok('忽略：不授权也不拒绝，连接维持待决（未关闭）',
      !gotGranted && !gotDenied && c.close == null,
      `granted=${gotGranted} denied=${gotDenied} closed=${c.close?.code ?? '未关'}`)
    }
    c.ws.close()
  }
  if (REPROMPT_MS > 0) {
    await sleep(REPROMPT_MS)
    await pacePrompts()
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
    await pacePrompts()
    const c = await wsOpen(URL)
    hello(c, cidDeny)
    const pend = await waitPending(c)
    if (!pend) {
      skip('四态·拒绝（直接拒 + 持久化后直接拒）', PROMPT_LIMIT_SKIP)
    } else {
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

    // 「被拦下」清单可解除（§5.1 / §16 规则 4）：解除 = 删 deny 行 → 回到无记录，
    // 重连应重新进待决、且能授权成功（否则拒绝就是用户无法撤销的死结）。
    const stDeny = await gwStatus()
    ok('拒绝后出现在「被拦下」清单（reason=deny）',
      Array.isArray(stDeny.blocked) && stDeny.blocked.some((b) => b.clientId === cidDeny && b.reason === 'deny'),
      `blocked=${stDeny.blocked?.length ?? 0}`)
    const stAfterRevoke = await gwRevoke(cidDeny)
    ok('解除拒绝后不再出现在「被拦下」清单',
      !Array.isArray(stAfterRevoke.blocked) || !stAfterRevoke.blocked.some((b) => b.clientId === cidDeny),
      `blocked=${stAfterRevoke.blocked?.length ?? 0}`)
    {
      await pacePrompts()
      const c3 = await wsOpen(URL)
      hello(c3, cidDeny)
      const pend3 = await waitPending(c3)
      let grantedOk = false
      if (pend3) {
        await gwRespond(pend3.data.requestId, 'allow-session', ['schedule.read'])
        grantedOk = (await waitGranted(c3)) != null
      }
      ok('解除拒绝后重连能重新询问并授权成功',
        pend3 != null && grantedOk,
        pend3 ? (grantedOk ? '已重新授权' : '弹窗了但未授权成功') : '未重新弹窗（被拦下没解除？）')
      c3.ws.close()
    }
    }
  }

  /* ---- 3. scope 越权调用被拒 ---- */
  const cidScope = uuid()
  createdClients.push(cidScope)
  {
    await pacePrompts()
    const c = await wsOpen(URL)
    hello(c, cidScope)
    const pend = await waitPending(c)
    if (!pend) {
      skip('scope 越权调用被拒', PROMPT_LIMIT_SKIP)
      c.ws.close()
    } else {
    await gwRespond(pend.data.requestId, 'allow-session', ['schedule.read'])
    await waitGranted(c)
    const bad = await rpc(c, 'schedule.create', { title: '越权日程', date: '2026-01-01' })
    ok('scope 越权调用被拒：forbidden_scope',
      bad.ok === false && bad.error?.code === 'forbidden_scope', `code=${bad.error?.code}`)
    const still = await rpc(c, 'schedule.listAll', {})
    ok('越权被拒后连接仍可用（只回错误帧，不关连）', still.ok === true)
    c.ws.close()
    }
  }

  /* ---- 4/5. 日程读写往返 + 变更事件推送 ---- */
  const cidRW = uuid()
  const cidSub = uuid()
  createdClients.push(cidRW, cidSub)
  {
    await pacePrompts()
    const rw = await wsOpen(URL)
    hello(rw, cidRW)
    const p1 = await waitPending(rw)

    await pacePrompts()
    const sub = await wsOpen(URL)
    hello(sub, cidSub)
    const p2 = await waitPending(sub)

    if (!p1 || !p2) {
      skip('日程读写往返 + 变更事件推送', PROMPT_LIMIT_SKIP)
      rw.ws.close()
      sub.ws.close()
    } else {
    // 第二轮起 schedule.delete 是**独立 scope**（§13.1）：不勾它，schedule.delete 回 forbidden_scope。
    await gwRespond(p1.data.requestId, 'allow-session', ['schedule.read', 'schedule.create', 'schedule.write', 'schedule.delete'])
    await waitGranted(rw)

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
  }

  /* ==== 第二轮新增：7~11（§13~§14）================================================
   * 复用两个探针客户端跑完全部新用例，把「按来源 IP 弹窗 ≤3/分钟」的限频开销压到最小：
   *   cidAll：全权（10 个 scope），走所有正常路径；
   *   cidRO ：窄权（schedule.read + workout.write），走越权路径（含「写 ≠ 删」）。
   * 弹窗被 IP 限频挡下时降级为 SKIP，不让脚本炸在 pend.data 上。
   * ========================================================================== */
  const cidAll = uuid() // 全权探针
  const cidRO = uuid() // 窄权探针
  createdClients.push(cidAll, cidRO)
  {
    await pacePrompts()
    const cAll = await wsOpen(URL)
    hello(cAll, cidAll)
    const pAll = await waitPending(cAll)
    if (pAll) {
      await gwRespond(pAll.data.requestId, 'allow-session', ALL_SCOPES)
      await waitGranted(cAll)
    }

    await pacePrompts()
    const cRO = await wsOpen(URL)
    hello(cRO, cidRO)
    const pRO = await waitPending(cRO)
    if (pRO) {
      await gwRespond(pRO.data.requestId, 'allow-session', ['schedule.read', 'workout.write'])
      await waitGranted(cRO)
    }

    const probesOk = pAll != null && pRO != null
    ok('两个探针客户端都进入待决并完成授权', probesOk,
      probesOk ? '全权 + 窄权' : '弹窗未出现（多半是按 IP 弹窗限频 ≤3/分钟，重启真机实例后重跑）')

    if (probesOk) {
      /* ---- 7. schedule 域新增读方法（scope=schedule.read） ---- */
      const campus = await rpc(cAll, 'schedule.campus', {})
      ok('schedule.campus 返回课表视图（entries/timeSlots/courses 齐备）',
        campus.ok === true && Array.isArray(campus.result?.entries)
          && Array.isArray(campus.result?.timeSlots) && Array.isArray(campus.result?.courses),
        campus.ok ? `keys=${Object.keys(campus.result).join(',')}` : JSON.stringify(campus.error))

      const progs = await rpc(cAll, 'schedule.programs', {})
      ok('schedule.programs 返回方案数组', progs.ok === true && Array.isArray(progs.result),
        `ok=${progs.ok} len=${Array.isArray(progs.result) ? progs.result.length : 'N/A'}`)

      const active = await rpc(cAll, 'schedule.programActive', {})
      ok('schedule.programActive 返回 ProgramRecord 或 null',
        active.ok === true && (active.result === null || typeof active.result?.id === 'number'),
        active.result === null ? 'null' : `ok=${active.ok}`)

      const campusRO = await rpc(cRO, 'schedule.campus', {})
      ok('窄权含 schedule.read 即可读课表（read 足够，无需更高权限）', campusRO.ok === true,
        `ok=${campusRO.ok} code=${campusRO.error?.code ?? '-'}`)

      /* ---- 8. workout 会话级写入（scope=workout.write）→ 受理回执 {accepted:true} ---- */
      const start = await rpc(cAll, 'workout.sessionStart', {
        planId: 'plan-e2e', planName: 'E2E 方案', startedAt: '2026-01-16T09:00:00Z',
        state: { phase: 'work', restLeft: 0 },
      })
      ok('workout.sessionStart 受理回执 {accepted:true}', start.ok === true && start.result?.accepted === true,
        JSON.stringify(start.result ?? start.error))

      const snap = await rpc(cAll, 'workout.sessionSnapshot', {
        id: 1, exIndex: 0, setIndex: 0, weightKg: 40, state: { phase: 'rest', restLeft: 60 },
      })
      ok('workout.sessionSnapshot 受理回执 {accepted:true}', snap.ok === true && snap.result?.accepted === true,
        JSON.stringify(snap.result ?? snap.error))

      const fin = await rpc(cAll, 'workout.sessionFinish', {
        sessionFinish: {
          id: 1, name: 'E2E 会话', workoutType: 'strength', date: '2026-01-16',
          durationMin: 45, kcal: 300, sets: [],
        },
      })
      ok('workout.sessionFinish 受理回执 {accepted:true}', fin.ok === true && fin.result?.accepted === true,
        JSON.stringify(fin.result ?? fin.error))

      const abort = await rpc(cAll, 'workout.sessionAbort', { id: 1 })
      ok('workout.sessionAbort 受理回执 {accepted:true}', abort.ok === true && abort.result?.accepted === true,
        JSON.stringify(abort.result ?? abort.error))

      const live = await rpc(cAll, 'workout.sessionActive', {})
      ok('workout.sessionActive 返回 SessionLive 或 null（含补时后的 restLeftSec 字段）',
        live.ok === true && (live.result === null
          || (typeof live.result?.id === 'number' && typeof live.result?.elapsedSec === 'number'
            && 'restLeftSec' in live.result)),
        live.result === null ? 'null' : `ok=${live.ok}`)

      const liveRO = await rpc(cRO, 'workout.sessionActive', {})
      ok('sessionActive 需 workout.read：窄权（有 write 无 read）被拒 forbidden_scope',
        liveRO.ok === false && liveRO.error?.code === 'forbidden_scope', `code=${liveRO.error?.code}`)

      const startRO = await rpc(cRO, 'workout.sessionStart', {
        planId: 'p', planName: 'n', startedAt: '2026-01-16T10:00:00Z',
      })
      ok('sessionStart 只需 workout.write：窄权被受理', startRO.ok === true && startRO.result?.accepted === true,
        JSON.stringify(startRO.result ?? startRO.error))

      /* ---- 9. 删除方法：scope 独立于 write（§13.1） ---- */
      const delRO = await rpc(cRO, 'workout.delete', { id: 1 })
      ok('「写 ≠ 删」：有 workout.write 也调不动 workout.delete（forbidden_scope）',
        delRO.ok === false && delRO.error?.code === 'forbidden_scope', `code=${delRO.error?.code}`)

      const schDelRO = await rpc(cRO, 'schedule.delete', { id: -1 })
      ok('schedule.delete 独立于 schedule.write：窄权被拒 forbidden_scope',
        schDelRO.ok === false && schDelRO.error?.code === 'forbidden_scope', `code=${schDelRO.error?.code}`)

      const schCreateRO = await rpc(cRO, 'schedule.create', { title: '越权日程' })
      ok('schedule.create 需 schedule.create：窄权被拒 forbidden_scope',
        schCreateRO.ok === false && schCreateRO.error?.code === 'forbidden_scope', `code=${schCreateRO.error?.code}`)

      // 正常路径（全权）：建一条本地运动 → 删掉 → list 不再命中。
      const wCreated = await rpc(cAll, 'workout.create', {
        name: 'E2E 删除用运动', workoutType: 'strength', date: '2026-01-17', durationMin: 30, kcal: 200,
      })
      const wId = wCreated.result?.id
      ok('workout.create 建一条本地记录（供删除验证）',
        wCreated.ok === true && typeof wId === 'number', `id=${wId}`)
      const wDel = await rpc(cAll, 'workout.delete', { id: wId })
      const wList = await rpc(cAll, 'workout.list', { startDate: '2026-01-01', endDate: '2026-01-31' })
      ok('workout.delete 正常路径：删后 workout.list 不再命中',
        wDel.ok === true && Array.isArray(wList.result) && !wList.result.some((x) => x.id === wId),
        `del.ok=${wDel.ok}`)

      /* ---- 10. 番茄钟运行态读 + 控制受理（§14.1 / §14.3） ---- */
      await gwFocusUnpublish() // 先清干净，避免上一次运行残留快照（陈旧判定 5s 之外也会回 null）
      const idle = await rpc(cAll, 'pomodoro.status', {})
      ok('pomodoro.status 无运行态时回 null', idle.ok === true && idle.result === null,
        `result=${JSON.stringify(idle.result)}`)

      const nowIso = new Date().toISOString()
      await gwFocusPublish({
        phase: 'focus', running: true, remainingSec: 600, plannedFocusMin: 25, plannedBreakMin: 5,
        phaseStartedAt: nowIso, linkedTodoId: null, completedRounds: 0, reportedAt: nowIso,
      })
      const running = await rpc(cAll, 'pomodoro.status', {})
      ok('focus_publish 后 pomodoro.status 读到 FocusRuntime（phase/running/remainingSec）',
        running.ok === true && running.result?.running === true && running.result?.phase === 'focus'
          && running.result?.remainingSec === 600,
        JSON.stringify(running.result ?? running.error))

      await gwFocusUnpublish()
      const off = await rpc(cAll, 'pomodoro.status', {})
      ok('focus_unpublish 后 pomodoro.status 回 null', off.ok === true && off.result === null,
        `result=${JSON.stringify(off.result)}`)

      const pStart = await rpc(cAll, 'pomodoro.start', { focusMin: 25, breakMin: 5, todoId: null })
      ok('pomodoro.start 受理回执 {accepted:true}', pStart.ok === true && pStart.result?.accepted === true,
        JSON.stringify(pStart.result ?? pStart.error))
      const pPause = await rpc(cAll, 'pomodoro.pause', {})
      ok('pomodoro.pause 受理回执 {accepted:true}', pPause.ok === true && pPause.result?.accepted === true,
        JSON.stringify(pPause.result ?? pPause.error))
      const pStop = await rpc(cAll, 'pomodoro.stop', {})
      ok('pomodoro.stop 受理回执 {accepted:true}', pStop.ok === true && pStop.result?.accepted === true,
        JSON.stringify(pStop.result ?? pStop.error))

      const pStatusRO = await rpc(cRO, 'pomodoro.status', {})
      ok('pomodoro.status 需 pomodoro.read：窄权被拒 forbidden_scope',
        pStatusRO.ok === false && pStatusRO.error?.code === 'forbidden_scope', `code=${pStatusRO.error?.code}`)
      const pStartRO = await rpc(cRO, 'pomodoro.start', {})
      ok('pomodoro.start 需 pomodoro.control：窄权被拒 forbidden_scope',
        pStartRO.ok === false && pStartRO.error?.code === 'forbidden_scope', `code=${pStartRO.error?.code}`)

      /* ---- 11. 审计参数摘要（§17.4）---- */
      const AUDIT_TITLE = `E2E 审计摘要 ${Date.now()}`
      const aCreated = await rpc(cAll, 'schedule.create', { title: AUDIT_TITLE, date: '2026-01-18' })
      const aId = aCreated.result?.id
      ok('schedule.create（供水印用）成功', aCreated.ok === true && typeof aId === 'number', `id=${aId}`)
      const listAll = await rpc(cAll, 'schedule.listAll', {})
      ok('schedule.listAll（只读，供审计对照）成功', listAll.ok === true && Array.isArray(listAll.result))

      const auditAll = await gwAuditRecent(300, null)
      const auditByClient = await gwAuditRecent(300, cidAll)
      ok('gateway_audit_recent 可读（非空数组）',
        Array.isArray(auditAll) && auditAll.length > 0, `len=${Array.isArray(auditAll) ? auditAll.length : 'N/A'}`)
      ok('gateway_audit_recent 的 clientId 过滤生效（结果都属该 client）',
        Array.isArray(auditByClient) && auditByClient.length > 0
          && auditByClient.every((e) => e.clientId === cidAll),
        `len=${Array.isArray(auditByClient) ? auditByClient.length : 'N/A'}`)

      const rows = Array.isArray(auditAll) ? auditAll : []
      const createRow = rows.find((e) => e.method === 'schedule.create' && e.decision === 'allowed'
        && typeof e.detail === 'string' && e.detail.includes(AUDIT_TITLE))
      ok('审计：写方法 detail 是参数摘要（含 title）', createRow != null,
        createRow ? `detail=${createRow.detail}` : '未找到含该 title 的 schedule.create 记录')

      const readRow = rows.find((e) => e.method === 'schedule.listAll' && e.decision === 'allowed')
      ok('审计：只读成功不记参数（detail 为 null）', readRow != null && readRow.detail == null,
        readRow ? `detail=${JSON.stringify(readRow.detail)}` : '未找到 schedule.listAll 记录')

      const deniedRow = rows.find((e) => e.method === 'workout.delete' && e.decision === 'denied')
      ok('审计：越权调用留痕（workout.delete / denied）', deniedRow != null,
        deniedRow ? `detail=${deniedRow.detail}` : '未找到 workout.delete 的 denied 记录')

      // 清掉水印条，别在库里留 E2E 数据。
      const aDel = await rpc(cAll, 'schedule.delete', { id: aId })
      ok('schedule.delete（全权）正常路径：独立 scope 生效', aDel.ok === true, JSON.stringify(aDel.error ?? {}))
    } else {
      skip('7~11 新增方法与运行态用例', '探针客户端未进入待决（按 IP 弹窗限频），本轮无法执行')
    }

    cAll.ws.close()
    cRO.ws.close()
  }

  /* ---- 6. 带 Origin 的握手：白名单外拒绝 / 白名单内放行（§15）----
   * 放在最后：Origin 负向握手会计入「未鉴权失败按 IP 限频」（≥5 次/分钟封 10 分钟），
   * 让它排在所有需要新连接的用例之后，免得封禁挡了后面的授权。 */
  {
    const st0 = await gwStatus()
    const originalOrigins = Array.isArray(st0.allowedOrigins) ? [...st0.allowedOrigins] : []
    const ORIGIN_OK = 'http://widget.e2e'

    const cleared = await gwSetAllowedOrigins([])
    ok('清空白名单：allowedOrigins 为空、blockedOrigins 字段存在',
      Array.isArray(cleared.allowedOrigins) && cleared.allowedOrigins.length === 0
        && Array.isArray(cleared.blockedOrigins),
      `allowed=${JSON.stringify(cleared.allowedOrigins)}`)

    const miss = await handshakeWithOrigin(PORT, ORIGIN_OK)
    ok('Origin 未列入白名单：握手 403（挡网页来源）', miss.status === 403, `${miss.line}`)

    const st1 = await gwStatus()
    ok('被 403 的 Origin 落进「被拦下的来源」（设置页据此一键加白）',
      Array.isArray(st1.blockedOrigins) && st1.blockedOrigins.includes(ORIGIN_OK),
      `blockedOrigins=${JSON.stringify(st1.blockedOrigins)}`)

    const added = await gwSetAllowedOrigins([ORIGIN_OK])
    ok('一键加入白名单：allowedOrigins 含它、blockedOrigins 不再含它',
      Array.isArray(added.allowedOrigins) && added.allowedOrigins.includes(ORIGIN_OK)
        && Array.isArray(added.blockedOrigins) && !added.blockedOrigins.includes(ORIGIN_OK),
      `allowed=${JSON.stringify(added.allowedOrigins)}`)

    const hit = await handshakeWithOrigin(PORT, ORIGIN_OK)
    ok('Origin 命中白名单：握手放行（101 Switching Protocols）', hit.status === 101, `${hit.line}`)
    // 刻意只做「一次白名单外 + 一次白名单内」这两次负向握手：每次 403 都计入按来源 IP
    // 的未鉴权失败限频（≥5 次/分钟封 10 分钟），多加一次就可能把后面的用例封掉。

    const restored = await gwSetAllowedOrigins(originalOrigins)
    const restoredSet = Array.isArray(restored.allowedOrigins) ? restored.allowedOrigins : []
    ok('恢复测试前的 Origin 白名单',
      restoredSet.length === originalOrigins.length && originalOrigins.every((o) => restoredSet.includes(o)),
      `restored=${JSON.stringify(restoredSet)}`)
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
