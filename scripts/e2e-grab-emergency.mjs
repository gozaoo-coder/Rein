/**
 * e2e-grab-emergency —— 抢课的三类应急：限流 / 教务服务器出错 / 参数错误
 *
 * 要证明的是三种**完全不同的应对**，而它们看起来都只是「一次失败」：
 *
 *   1. **教务限速**（请求过于频繁 / 429）：继续按节奏打，**不退避** ——
 *      窗口只有几分钟，退避一次就少几十次机会。判据是「尝试次数还在涨」。
 *   2. **教务服务器出错**（5xx）：同样继续打。判据同上。
 *   3. **参数错误**（400/422）：重试不会成功，还一直在用错的参数骚扰教务 ——
 *      引擎停下（任务变 `needs_ai`），**立刻把现场递给 AI**，界面上给出「重新排队试试」。
 *
 * 故障由 mock 注入（`window.__REIN_MOCK_GRAB_FAULT__` = 教务的原话），
 * 判定走 mock 里那份与 Rust `grab.rs::verdict_of` 同形的关键词表 ——
 * 这里验的是分档语义本身，不是给测试另开的捷径。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-grab-emergency.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-emergency-${Date.now()}`
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
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
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

/** 注入/清除故障（教务的原话；简写 throttle / server / params 也可以） */
const inject = (fault) =>
  evalJS(`(() => { window.__REIN_MOCK_GRAB_FAULT__ = ${JSON.stringify(fault)}; return true })()`)
const clearFault = () =>
  evalJS(`(() => { delete window.__REIN_MOCK_GRAB_FAULT__; return true })()`)

const lessonRow = (name) =>
  `[...document.querySelectorAll('.lesson')].find((e) => e.textContent.includes(${JSON.stringify(name)}))`

/** 任务单 / 结果面里某门课那一行 */
const taskRowExpr = (name) =>
  `[...document.querySelectorAll('.grab .task')].find((e) => e.querySelector('.name')?.textContent.includes(${JSON.stringify(name)}))`

const taskChipExpr = (name) => `((${taskRowExpr(name)})?.querySelector('.chip')?.textContent.trim() ?? null)`
/** 上面那个是**表达式**（给 waitFor 用）；要取值的用这个 */
const chipOf = (name) => evalJS(taskChipExpr(name))

async function taskRow(name) {
  return evalJS(`(() => {
    const el = ${taskRowExpr(name)}
    if (!el) return null
    return {
      chip: el.querySelector('.chip')?.textContent.trim() ?? '',
      meta: el.querySelector('.meta')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      why: el.querySelector('.why')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    }
  })()`)
}

/** 行上的「已尝试 N 次」 */
async function tries(name) {
  const meta = (await taskRow(name))?.meta ?? ''
  return Number(/已尝试 (\d+) 次/.exec(meta)?.[1] ?? '0')
}

async function openSheetAnd(name, button) {
  await evalJS(`(${lessonRow(name)})?.querySelector('.pick')?.click()`)
  await waitFor(`!!document.querySelector('.panel')`, 5000, '抢课抽屉打开')
  return clickText('.panel button', button)
}

async function login(user, pass) {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '学校系统选择器有选项')
  await waitFor(
    `!!document.querySelector('input[autocomplete="username"]') && !!document.querySelector('input[autocomplete="current-password"]')`,
    8000,
    '登录表单挂载',
  )
  await setInput('input[autocomplete="username"]', user)
  await setInput('input[autocomplete="current-password"]', pass)
  await clickText('button', '登录')
  await waitFor(`document.body.textContent.includes('已登录')`, 15000, '登录成功')
}

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9500 + (process.pid % 90)

async function main() {
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${OUT}/profile`,
      '--no-first-run',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(`${APP}/#/campus/course-select`)
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.body.textContent.includes('可进入')`, 8000, '批次渲染')
    await clickText('.turn .primary', '进入选课')
    await waitFor(`document.querySelectorAll('.lesson').length === 7`, 8000, '教学班列表')

    /* ═══════ 一、教务限速：**继续打**，不退避 ═══════ */
    await inject('throttle')
    await openSheetAnd('高等数学', '加入抢课')
    await waitFor(`(${taskChipExpr('高等数学')}) === '教务限速中'`, 12000, '限速状态上屏')
    const throttled = await taskRow('高等数学')
    ok('限流被认出来并说清应对（不是「未成功」）', throttled?.chip === '教务限速中', JSON.stringify(throttled))
    ok(
      '行内写明「继续按节奏重试」，并留着教务原话',
      (throttled?.meta ?? '').includes('限速') && (throttled?.meta ?? '').includes('请求过于频繁'),
      throttled?.meta,
    )

    // 「不退避」只能由行为证明：尝试次数要一直涨
    const t1 = await tries('高等数学')
    await sleep(1600)
    const t2 = await tries('高等数学')
    ok('限速期间仍在高频重试（尝试次数持续增加）', t2 > t1, `${t1} → ${t2} 次`)
    ok('限速不算作任务失败（不落终态）', (await taskRow('高等数学'))?.chip === '教务限速中')
    await shot('1-throttled')

    /* ═══════ 二、教务服务器出错：同样**继续打** ═══════ */
    await inject('server')
    await waitFor(`(${taskChipExpr('高等数学')}) === '教务异常中'`, 12000, '服务器错误状态上屏')
    const down = await taskRow('高等数学')
    ok('服务器出错被单独认出来', down?.chip === '教务异常中', JSON.stringify(down))
    ok(
      '行内写明「继续重试」+ 教务原话（503）',
      (down?.meta ?? '').includes('服务器出错') && (down?.meta ?? '').includes('503'),
      down?.meta,
    )
    const s1 = await tries('高等数学')
    await sleep(1600)
    const s2 = await tries('高等数学')
    ok('服务器出错期间仍在高频重试', s2 > s1, `${s1} → ${s2} 次`)
    await shot('2-server-down')

    /* ═══════ 三、参数错误：停下 + 立刻交给 AI ═══════ */
    await inject('params')
    // 引擎停手：任务落到「请求被拒」，并且**自动把现场递出去**（跳到 AI 页、直接发问）
    await waitFor(`location.hash.startsWith('#/ai')`, 12000, '自动跳到 AI 页')
    ok('参数错误触发自动交接（跳到 AI 页）', true)
    // 「立刻接入」在实现上就是**直接发**（AI 页对 pendingPrompt 的既定行为），
    // 所以要验的是对话里出现了那段现场，而不是输入框里躺着一段话
    await waitFor(
      `[...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes('被教务拒绝的请求'))`,
      10000,
      '现场已作为问题发给 AI',
    )
    const prompt = await evalJS(
      `[...document.querySelectorAll('.msg.user')].map((m) => m.textContent).join('\\n')`,
    )
    ok('递给 AI 的现场点名了参数错误（含原话）', prompt.includes('参数错误') && prompt.includes('assoc'))
    ok('并交代了该怎么查（手工打一次看原始响应）', prompt.includes('手工打一次'))
    await shot('3-handed-to-ai')

    // 回到抢课页：任务停在「请求被拒」，并且给出路
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`!!document.querySelector('.grab')`, 8000, '回到抢课页')
    // 状态要等一次 campus_grab_state 落下来，别急着断言（上一次就是这么假红的）
    await waitFor(`(${taskChipExpr('高等数学')}) === '请求被拒'`, 8000, '被拒状态在行上落定')
    ok('被拒的任务不再显示成「还在抢」', (await chipOf('高等数学')) === '请求被拒', await chipOf('高等数学'))
    ok(
      '结果面按「请求被拒」单独计数（不是「未抢到」）',
      (await evalJS(`document.querySelector('.grab')?.textContent ?? ''`)).includes('请求被拒'),
    )
    const band = await evalJS(`document.querySelector('.grab .rejected')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
    ok('给出「为什么停了」与下一步', band.includes('参数错误') && band.includes('重试不会成功'), band.slice(0, 80))
    ok('有「交给 AI 排查」的手动入口', band.includes('交给 AI 排查'))
    ok('也有「重新排队试试」的出路', band.includes('重新排队试试'))
    await shot('4-rejected')

    // 重新排队：mock 的故障注入是一次性的（模拟 AI 修好参数），这一轮该抢到
    await clickText('.grab .rejected button', '重新排队试试')
    await waitFor(`(${taskChipExpr('高等数学')}) === '已抢到'`, 20000, '重排后抢到')
    ok('重新排队后按现有节奏抢到（故障已排除）', (await chipOf('高等数学')) === '已抢到', await chipOf('高等数学'))
    ok('被拒的记录不再挂在结果面上', !(await evalJS(`!!document.querySelector('.grab .rejected')`)))
    await shot('5-recovered')

    /* ═══════ 清场：注入未知错误仍按「可重试」处理（不误判成三类之一） ═══════ */
    await inject('教务返回了一段没人见过的话')
    await openSheetAnd('体育', '加入抢课')
    await waitFor(`(${taskChipExpr('体育')}) !== null`, 8000, '体育进入任务单')
    await sleep(1200)
    const unknown = await taskRow('体育')
    ok(
      '认不出来的错误按「可重试」处理，不误判成限流/参数错误',
      unknown?.chip !== '教务限速中' && unknown?.chip !== '请求被拒' && unknown?.chip !== '教务异常中',
      JSON.stringify(unknown),
    )
    await clearFault()
    ok('清掉故障注入后不再干扰后续', true)
  } finally {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    edge.kill()
  }

  const pass = results.filter((r) => r.pass).length
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass !== results.length) process.exit(1)
}

await main()
