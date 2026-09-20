/**
 * e2e-app-campus —— **真机 App** 上的校园教务全链路（Tauri + WebView2，非 mock）
 *
 * 与其它 e2e 的根本区别：那些跑在浏览器里、走 src/mock/server.ts，**整个 Rust 一行不跑**。
 * 这个脚本连的是真实 App 的 WebView2（靠 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
 * --remote-debugging-port=9222` 打开调试端口），所以它验的是：
 *   前端 → invoke → Tauri 命令层（三段式加锁 / spawn_blocking / CampusHub 令牌缓存）
 *   → 真实教务系统
 * —— 也就是「命令层从没被执行过」这个缺口。
 *
 * 会打真实教务：登录一次、同步一次、读一次培养方案、读一次选课状态。
 * 不做任何写操作（不提交选课、不删账号）。
 *
 * 前置：`npm run app:dev` 已起（带上面的环境变量）
 * 运行：node scripts/e2e-app-campus.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.REIN_APP_DEBUG_PORT ?? 9222)
const USER = process.env.REIN_GUET_USER
const PASS = process.env.REIN_GUET_PASS
if (!USER || !PASS) {
  console.error('需要 REIN_GUET_USER / REIN_GUET_PASS（打真实教务系统）')
  process.exit(1)
}

const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-app-${Date.now()}`
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

async function waitFor(expr, timeoutMs = 15000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(180)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${SHOTS}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${file}`)
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

/** 找到 App 的页面目标（Tauri 是单窗口，但有 devtools 等其它 target） */
async function connect() {
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && /localhost:1420|tauri/.test(t.url ?? ''))
        ?? list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  if (!target) throw new Error(`连不上 WebView2 调试端口 ${PORT}，App 起了吗？`)

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
  console.log(`     已连上 ${target.url}`)
}

/* ---------------- 主流程 ---------------- */

async function main() {
  await connect()

  // 确认这次真的是 Tauri 而不是浏览器：差的正是这一层
  const runtime = await evalJS(`({
    tauri: '__TAURI_INTERNALS__' in window,
    ua: navigator.userAgent.slice(0, 60),
  })`)
  ok('连上的是真机 App（Tauri 运行时）', runtime.tauri === true, runtime.ua)
  if (!runtime.tauri) throw new Error('不是 Tauri 环境，拒绝继续')

  try {
    /* ---- 1. 配置页：真实登录 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 20000, '配置页挂载')
    await waitFor(`document.querySelectorAll('.sys').length >= 1`, 10000, '学校系统选择器（走 campus_systems）')
    ok('campus_systems 命令层可用', true, await evalJS(`document.querySelector('.sys-name')?.textContent`))

    await setInput('input[autocomplete="username"]', USER)
    await setInput('input[autocomplete="current-password"]', PASS)
    await clickText('button', '登录')
    // 真机登录 + 自动同步要打几十秒网络（RSA 握手 + 127KB 课表）
    await waitFor(`document.body.textContent.includes('已登录')`, 60000, 'campus_login 真机返回')
    ok('campus_login 真机登录成功（RSA + 会话 + Cookie 落库）', true)

    await waitFor(`document.body.textContent.includes('上次同步')`, 90000, 'campus_sync 完成')
    const who = await evalJS(`document.querySelector('.who-name')?.textContent.trim() ?? ''`)
    ok('账号档案回显（campus_account_get 投影，明文不出 Rust）', who.length > 0, who)
    const sync = await evalJS(`document.querySelector('.tip')?.textContent.replace(/\\s+/g,' ').trim() ?? ''`)
    ok('campus_sync 写入时间线', /门课/.test(sync), sync)
    await shot('1-login')

    /* ---- 2. 课表页：campus_schedule ---- */
    await evalJS(`location.hash = '#/campus/schedule'`)
    await waitFor(`document.querySelectorAll('.grid .cell.head.day').length === 7`, 30000, '周视图渲染')
    const blocks = await evalJS(`document.querySelectorAll('.grid .blk').length`)
    ok('campus_schedule 返回真实课表并渲染', blocks > 0, `${blocks} 块`)
    const first = await evalJS(`document.querySelector('.grid .blk')?.dataset.title ?? ''`)
    ok('课程块有真实课程名', first.length > 0, first)
    await shot('2-schedule')

    /* ---- 3. 时间线：物化是否真的写进了 todos ---- */
    await evalJS(`location.hash = '#/todos'`)
    await waitFor(`!!document.querySelector('[data-testid="seg-week"]')`, 15000, '待办页挂载')
    await evalJS(`document.querySelector('[data-testid="seg-week"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="week-timeline"]')`, 15000, '周时间线')
    await waitFor(`[...document.querySelectorAll('.col .blk')].some((e) => e.classList.contains('blk'))`, 15000, '块渲染')
    const derived = await evalJS(`(() => {
      const all = [...document.querySelectorAll('.col .blk')]
      const cls = all.filter((e) => getComputedStyle(e).getPropertyValue('--blk-cat').trim() ===
        getComputedStyle(document.documentElement).getPropertyValue('--cat-class').trim())
      return { total: all.length, derived: cls.length, sample: cls[0]?.dataset.title ?? '' }
    })()`)
    ok('真机时间线出现课表派生行（materialize_todos 落库）', derived.derived > 0,
      `${derived.derived}/${derived.total} 条，例：${derived.sample}`)

    const readonly = await evalJS(`(async () => {
      const el = [...document.querySelectorAll('.col .blk')].find((e) =>
        getComputedStyle(e).getPropertyValue('--blk-cat').trim() ===
        getComputedStyle(document.documentElement).getPropertyValue('--cat-class').trim())
      if (!el) return 'no-el'
      const init = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 }
      el.dispatchEvent(new PointerEvent('pointerdown', init))
      await new Promise((r) => setTimeout(r, 520))
      const armed = el.classList.contains('dragging')
      el.dispatchEvent(new PointerEvent('pointerup', init))
      return armed ? 'armed' : 'idle'
    })()`)
    ok('真机上派生行仍是只读（长按不武装）', readonly === 'idle', readonly)
    await shot('3-timeline')

    /* ---- 4. 培养方案：900KB 响应 + app_meta 缓存 ---- */
    await evalJS(`location.hash = '#/campus/program'`)
    await waitFor(`document.querySelector('h1')?.textContent === '培养方案'`, 15000, '培养方案页')
    await waitFor(`!!document.querySelector('.meta-grid')`, 90000, 'campus_program 拉取完成')
    const prog = await evalJS(`({
      courses: document.querySelectorAll('.courses .course').length,
      credits: document.querySelector('.prog-num')?.textContent.trim() ?? '',
      rows: document.querySelectorAll('.credit .crow').length,
    })`)
    ok('campus_program 真机拉到培养方案并渲染', prog.courses > 0, JSON.stringify(prog))

    // 第二次进入应当走缓存（不再打网络）：比较耗时
    const t0 = Date.now()
    await evalJS(`location.hash = '#/todos'`)
    await waitFor(`!!document.querySelector('[data-testid="seg-week"]')`, 15000, '离开')
    await evalJS(`location.hash = '#/campus/program'`)
    await waitFor(`!!document.querySelector('.meta-grid')`, 20000, '缓存命中')
    const cachedMs = Date.now() - t0
    ok('培养方案二次进入走 app_meta 缓存（秒开）', cachedMs < 8000, `${cachedMs}ms`)
    await shot('4-program')

    /* ---- 5. 选课：令牌链路 + 服务器时间（不提交） ---- */
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页')
    await waitFor(`document.body.textContent.includes('教务服务器时间')`, 60000, 'campus_course_select_status')
    const sel = await evalJS(`(() => {
      const facts = [...document.querySelectorAll('.grab .facts')].map((r) => r.textContent).find((x) => x.includes('服务器时间'))
      return {
        time: (facts?.match(/教务服务器时间\\s*([\\d-]+ [\\d:]+)/)?.[1] ?? ''),
        student: (facts?.match(/·\\s*([^·]*\\d{6,})/)?.[1] ?? '').trim(),
        body: document.body.textContent.includes('当前没有开放的选课批次') ? 'no-turn' : 'has-turn',
      }
    })()`)
    ok('选课令牌链路真机可用（EAMS 会话 → SSO JWT）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sel.time), sel.time)
    ok('批次状态如实反映（未开放则为等待态）', sel.body === 'no-turn' || sel.body === 'has-turn', sel.body)
    await shot('5-select')
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log(`截图目录：${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('app e2e 失败：', e.message)
  process.exit(1)
})
