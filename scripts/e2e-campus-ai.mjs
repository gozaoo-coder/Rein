/**
 * e2e-campus-ai —— 抢课救援面（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 这条链路要证明的是「引擎挂了以后，AI 能救回来」需要的那几件东西真的接上了：
 *
 *   1. **入口**：抢课面板上有「交给 AI 排查」，点了就落到 AI 页，且现场（引擎故障、
 *      卡住的任务、计划与批次）已经作为一条消息递过去了 —— 着急的时候不该还要人复述一遍。
 *   2. **判断依据**：AI 能同时看到「会话是否有效」与「接口返回的原始正文」，
 *      并且**分清**这两种完全不同的故障：会话被踢（302 / 探针 false） vs 教务改了接口
 *      （探针 true，但接口回的是 HTML 回退而不是 JSON 信封）。判错就会白折腾一整轮。
 *   3. **能动手**：重试卡住的任务、改节奏、排课、直接提交 —— 这些调的是与人手操作
 *      同一批 Tauri 命令，做完要留下审计。
 *   4. **能交付**：把这一路打过的请求导出成可脱离 App 重放的脚本（.sh + 知识库副本）。
 *      这是「最后补救」的落点：App 被杀掉、手机没电时靠它继续。
 *
 * 模型不在环里：无头浏览器没有真模型可调，而这条链上真正会坏的是**参数形状与命令名**，
 * 不是模型的措辞。所以工具层用 `window.__REIN_TOOL__` 直调（dev 专用钩子，见 registry.ts）。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-campus-ai.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-campus-ai-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

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

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(100)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  const file = `${SHOTS}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${file}`)
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
      const ready = await evalJS('document.readyState')
      if (ready === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

const setInput = (selector, value) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

const clickText = (selector, text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

/**
 * 等元素出现后**在一次求值里**查+点。
 *
 * 分两步（先 querySelector 再 click）在页面重渲染的间隙会拿到 null ——
 * 抢课面板会跟着引擎事件重渲染，这条链路里踩过。
 */
async function clickSel(selector, label) {
  for (let i = 0; i < 3; i++) {
    const done = await evalJS(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)
    if (done) return true
    await sleep(400)
  }
  throw new Error(`点不到元素: ${label ?? selector}`)
}

/** 直调工具（dev 钩子）：返回结果或抛出，形状与模型看到的完全一致 */
const callTool = (name, args) =>
  evalJS(`window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})`)

/** 调工具并只取「成功/失败」：失败时把错误文案带回来（用于断言硬边界） */
const tryTool = (name, args) =>
  evalJS(`(async () => {
    try {
      const r = await window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})
      return { ok: true, value: r }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  })()`)

/** mock 钩子：开关教务侧的几种故障 */
const setHook = (name, value) => evalJS(`globalThis.${name} = ${JSON.stringify(value)}`)

async function login(user, pass) {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '学校系统选择器有选项')
  // 先点一次学校系统：登录用的是「服务地址」输入框里的值，而它只在选校时才被填上。
  // （不点也能登录，但拿到的是一个空 baseUrl —— 后面所有跟地址有关的断言就都失去了意义。）
  await evalJS(`document.querySelector('.sys').click()`)
  await waitFor(`document.querySelector('input[type="url"]')?.value.length > 0`, 4000, '服务地址被填上')
  await waitFor(
    `!!document.querySelector('input[autocomplete="username"]') && !!document.querySelector('input[autocomplete="current-password"]')`,
    8000,
    '登录表单挂载',
  )
  const filled =
    (await setInput('input[autocomplete="username"]', user)) &&
    (await setInput('input[autocomplete="current-password"]', pass))
  if (!filled) throw new Error('登录表单没填上')
  await clickText('button', '登录')
  await waitFor(`document.body.textContent.includes('已登录')`, 15000, '登录成功')
}

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9900 + (process.pid % 90)

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
    await connect(`${APP}/#/campus/course-select`)

    /* ---- 0. 登录并让任务单上真的有东西（没有任务时面板根本不渲染） ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`!!document.querySelector('.plan')`, 8000, '计划面板出现')
    await setInput('.plan .entry input', '高数 张')
    await sleep(80)
    await evalJS(`document.querySelector('.plan .entry-go').click()`)
    await waitFor(`!!document.querySelector('.plan .preview, .plan .err')`, 6000, '预览返回')
    await clickText('.plan .primary', '加入计划')
    await waitFor(`document.querySelectorAll('.grab .task').length >= 1`, 12000, '引擎解析出任务')
    const taskCount = await evalJS(`document.querySelectorAll('.grab .task').length`)
    ok('任务单上有任务（救援面的前提）', taskCount >= 1, `${taskCount} 条`)

    /* ---- 1. 入口：交给 AI 排查 ---- */
    await waitFor(`!!document.querySelector('.grab footer .link.ai')`, 8000, 'AI 入口出现')
    const entryText = await evalJS(`document.querySelector('.grab footer .link.ai')?.textContent.trim() ?? ''`)
    ok('抢课面板有常驻的「交给 AI 排查」入口', entryText.includes('交给 AI 排查'), entryText)
    await shot('1-panel-entry')

    await clickSel('.grab footer .link.ai', '交给 AI 排查')
    await waitFor(`location.hash.includes('/ai')`, 6000, '跳到 AI 页')
    await waitFor(
      `document.querySelector('.msg.user .bubble')?.textContent.includes('抢课排障')`,
      10000,
      '现场作为一条消息发出去了',
    )
    const handoff = await evalJS(
      `document.querySelector('.msg.user .bubble')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`,
    )
    ok(
      '递过去的现场里有引擎状态与任务明细（AI 不必再问一遍）',
      handoff.includes('抢课排障') && handoff.includes('服务器时间') && handoff.includes('在场任务'),
      handoff.slice(0, 48),
    )
    await shot('2-handoff')

    /* ---- 2. 工具链：现场快照 ---- */
    const st = await callTool('campus_status', { probe: true })
    ok(
      'campus_status 一次给出账号 / 会话 / 时钟 / 引擎 / 计划 / 任务 / 节奏',
      !!st &&
        'sessionAlive' in st &&
        !!st.clock &&
        !!st.engine &&
        Array.isArray(st.tasks) &&
        Array.isArray(st.intents) &&
        Array.isArray(st.stuckTaskIds) &&
        Array.isArray(st.recentActions) &&
        typeof st.settings?.minIntervalMs === 'number',
      `sessionAlive=${st?.sessionAlive} tasks=${st?.tasks?.length} turns=${st?.engine?.turns?.length}`,
    )
    ok('现场里有批次窗口（判「窗口开没开」的依据）', (st?.engine?.turns ?? []).length >= 1)

    /* ---- 3. 原始请求：相对路径自动带会话 ---- */
    const good = await callTool('campus_http', {
      url: '/course-selection-api/api/v1/student/course-select/getCurrentDateTime',
      reason: '核对选课接口还回不回 JSON 信封',
    })
    ok('同源相对路径被补全成绝对地址', good?.url?.startsWith('https://'), good?.url)
    ok('同源请求带上了教务会话', good?.sameOrigin === true && good?.withSession === true)
    ok('响应能读出信封（result 字段）', good?.status === 200 && good.body.includes('"result"'), good?.body?.slice(0, 60))
    ok(
      '等价 curl 用变量引用凭据（不逐行复制 Cookie）',
      good?.curl?.includes('-H "Cookie: $COOKIE"') && !good.curl.includes('__pstsid__='),
    )

    /* ---- 4. 硬边界：带凭据只许打教务同源 ---- */
    const cross = await tryTool('campus_http', {
      url: 'https://example.com/collect',
      withSession: true,
      reason: '试着把会话发到外部地址（应该被拒）',
    })
    ok(
      '带会话打外部地址被拒（会话不会被发给第三方）',
      cross.ok === false && cross.message.includes('只能打教务自己的域名'),
      cross.message,
    )
    const publicReq = await callTool('campus_http', {
      url: 'https://example.com/robots.txt',
      reason: '读一份公开文档',
    })
    ok(
      '外部地址可以打，但不带任何凭据',
      publicReq?.sameOrigin === false && publicReq?.withSession === false && publicReq?.withSelectToken === false,
      publicReq?.note,
    )

    /* ---- 5. 关键对照：会话死了 vs 教务改了接口 ---- */
    await setHook('__REIN_MOCK_CAMPUS_BREAK__', true)
    const broken = await callTool('campus_http', {
      url: '/course-selection-api/api/v1/student/course-select/getCurrentDateTime',
      reason: '教务改接口了吗？',
    })
    const brokenState = await callTool('campus_status', { probe: false })
    ok(
      '接口返回 HTML 回退（信封不见了）',
      broken?.status === 200 && broken.body.includes('<!DOCTYPE html>'),
      broken?.body?.slice(0, 40),
    )
    ok(
      '与此同时会话**仍然有效** —— 「接口变了」与「会话死了」是两回事',
      brokenState?.sessionAlive === true,
      `sessionAlive=${brokenState?.sessionAlive}`,
    )
    await setHook('__REIN_MOCK_CAMPUS_BREAK__', false)

    await setHook('__REIN_MOCK_CAMPUS_SESSION_DEAD__', true)
    const deadState = await callTool('campus_status', { probe: true })
    const deadReq = await callTool('campus_http', { url: '/student/home', reason: '会话还在吗' })
    ok('会话被踢：探针说 false', deadState?.sessionAlive === false)
    ok('会话被踢：门户回 302（而不是 200 的 HTML）', deadReq?.status === 302, `HTTP ${deadReq?.status}`)
    await setHook('__REIN_MOCK_CAMPUS_SESSION_DEAD__', false)

    /* ---- 6. 动手：认出卡住的任务 → 重试 → 真的归零，并留下审计 ---- */
    await setHook('__REIN_MOCK_CAMPUS_STUCK__', true)
    const stuck = await callTool('campus_status', { probe: false })
    const stuckId = stuck?.stuckTaskIds?.[0]
    ok(
      '卡住的任务被识别出来（连败/逾期未动）',
      Number.isInteger(stuckId) && stuck.tasks.some((t) => t.id === stuckId && t.strikes >= 3),
      `stuck=${JSON.stringify(stuck?.stuckTaskIds)}`,
    )

    const ctl = await callTool('campus_grab_control', { action: 'retry_stuck' })
    ok('retry_stuck 动的正是被判为卡住的那些任务', (ctl?.retried ?? []).includes(stuckId), JSON.stringify(ctl?.retried))

    await setHook('__REIN_MOCK_CAMPUS_STUCK__', false)
    const fixed = await callTool('campus_status', { probe: false })
    const fixedTask = (fixed?.tasks ?? []).find((t) => t.id === stuckId)
    ok(
      '重试真的把连败与次数清零（回到守着窗口的状态）',
      fixedTask?.strikes === 0 && fixedTask?.attempts === 0 && fixedTask?.status === 'waiting',
      JSON.stringify(fixedTask && { status: fixedTask.status, strikes: fixedTask.strikes, attempts: fixedTask.attempts }),
    )

    const settings = await callTool('campus_grab_control', {
      action: 'settings',
      settings: { fullRetryMs: 3000 },
    })
    ok('改节奏只动传进去的那一项（其余保留）', settings?.settings?.fullRetryMs === 3000 && settings.settings.minIntervalMs > 0)

    const after = await callTool('campus_status', { probe: false })
    const kinds = (after?.recentActions ?? []).map((a) => a.kind)
    ok(
      '这些动作都进了审计（写操作不弹确认，靠记录兜底）',
      kinds.includes('grab') && (after?.recentActions ?? []).length >= 3,
      kinds.join(','),
    )

    /* ---- 7. 交付：导出可独立重放的脚本 ---- */
    const exp = await callTool('campus_export_script', { hours: 6, title: 'e2e 救援脚本' })
    // 工具只回前 40 行预览（整份脚本可能有几千行，不该全塞进上下文）；落到磁盘的才是完整的那份
    const script = exp?.preview ?? ''
    ok('脚本落到磁盘（有路径、有条数）', !!exp?.scriptPath && exp?.count >= 1, `${exp?.count} 条 → ${exp?.scriptPath}`)
    ok('脚本有正确的开头（shebang + 严格模式）', script.startsWith('#!/usr/bin/env bash\n') && script.includes('set -euo pipefail'))
    ok('脚本头部带凭据变量（不是逐行复制）', script.includes('COOKIE=') && script.includes('$COOKIE'))
    ok('每条请求一条 curl + 一行说明', (script.match(/curl -sS/g) ?? []).length >= 1 && script.includes('# ── 1)'))
    ok('脚本行尾是 LF（Windows 上 bash 才不会报 $\\r）', !script.includes('\r'))
    ok('知识库里留了一份可读副本', !!exp?.notePath, exp?.notePath)
    await shot('3-script')

    /* ---- 8. 记录区：AI 干了什么，人看得见 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 10000, '配置页挂载')
    await waitFor(`document.body.textContent.includes('AI 操作记录')`, 8000, '记录区出现')
    // 记录是挂载后才去拉的（异步），所以这里要等它回来，而不是立刻数
    await waitFor(`document.querySelectorAll('.audit li').length >= 1`, 8000, '记录行出现')
    const rows = await evalJS(`document.querySelectorAll('.audit li').length`)
    ok('设置页列出了 AI 的操作记录', rows >= 1, `${rows} 条`)
    ok(
      '记录区有「导出救援脚本」入口（不只在聊天里能做）',
      await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('导出救援脚本'))`),
    )
    await shot('4-audit')
  } finally {
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('e2e 崩溃：', e)
  process.exit(1)
})
