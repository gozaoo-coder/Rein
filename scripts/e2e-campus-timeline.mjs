/**
 * e2e-campus-timeline —— 「课表注册进 TimeLine」端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：课表进时间线是本功能的第一诉求，而它的正确性有一半落在**只读投影**上——
 * 派生行能拖、能改、点开是待办编辑器，这些在 Rust 单测（钉数据层）里一个都反映不出来。
 * 这个脚本盯的就是「同步之后，时间线上多了什么、又能对它们做什么」。
 *
 * 剧本：
 *   1. 登录（自动同步）→ 时间线里出现课程派生行
 *   2. 派生行按「课程」分类着色（--cat-class），不是普通待办
 *   3. 长按派生行**不武装**（拖不动）；长按普通待办照旧武装
 *   4. 点派生行开的是只读课程详情（不是待办编辑器），且没有编辑/删除
 *   5. 在详情里打卡 → 成为 done
 *   6. 再同步一次：行数不增（幂等），且打过卡的那行**没有被重建回去**
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-campus-timeline.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-timeline-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

/** 演示课表里的课程名（与 src/mock/server.ts 的 CAMPUS_SESSIONS 对应） */
const COURSES = [
  '高等数学（上）',
  '大学英语（一）',
  '数据结构与算法',
  '大学物理',
  '计算机组成原理',
  '体育（一）',
]
/** 普通待办（用来对照长按武装与否） */
const PLAIN_TODO = '力量训练 · 上肢'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 断言与结果汇总 ---------------- */

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
    await sleep(120)
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

/* ---------------- 时间线探针 ---------------- */

/** 进入待办页并切到周视图（每次重新进入都要点，segment 不跨挂载保留） */
async function goWeek() {
  await evalJS(`location.hash = '#/todos'`)
  await waitFor(`!!document.querySelector('[data-testid="seg-week"]')`, 8000, '待办页挂载')
  await evalJS(`document.querySelector('[data-testid="seg-week"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="week-timeline"]')`, 8000, '周时间线挂载')
}

/** 周视图网格里的派生行（按课程名筛），不含未安排池 */
const courseBlocksSel = `[...document.querySelectorAll('.col .blk')].filter((e) => ${JSON.stringify(COURSES)}.includes(e.dataset.title))`

const blockStats = () =>
  evalJS(`(() => {
    const all = [...document.querySelectorAll('.col .blk')]
    const courses = all.filter((e) => ${JSON.stringify(COURSES)}.includes(e.dataset.title))
    return {
      all: all.length,
      courses: courses.length,
      doneCourses: courses.filter((e) => e.classList.contains('done')).length,
      catVar: courses[0] ? getComputedStyle(courses[0]).getPropertyValue('--blk-cat').trim() : '',
      sample: courses[0]?.dataset.title ?? '',
    }
  })()`)

/**
 * 长按：按下 → 等过 LONGPRESS_MS(320) → 读是否武装 → 松手。
 * 用合成的 PointerEvent 走 Vue 的 @pointerdown/@pointerup，与真实手指同一条代码路径。
 */
const longPress = (title, holdMs = 520) =>
  evalJS(`(async () => {
    const el = [...document.querySelectorAll('.col .blk')].find((e) => e.dataset.title === ${JSON.stringify(title)})
    if (!el) return 'no-el'
    const init = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20 }
    el.dispatchEvent(new PointerEvent('pointerdown', init))
    await new Promise((r) => setTimeout(r, ${holdMs}))
    const armed = el.classList.contains('dragging')
    el.dispatchEvent(new PointerEvent('pointerup', init))
    return armed ? 'armed' : 'idle'
  })()`)

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9333 + (process.pid % 200)

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
    await connect(`${APP}/#/campus/settings`)

    /* ---- 1. 登录 → 自动同步 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
    await waitFor(`document.querySelectorAll('.sys').length >= 1`, 6000, '学校系统选择器')
    await setInput('input[autocomplete="username"]', '2600350118')
    await setInput('input[autocomplete="current-password"]', 'demo1234')
    await clickText('button', '登录')
    await waitFor(`document.body.textContent.includes('写入')`, 12000, '同步回执')
    ok('登录后自动同步并回报写入条数', true, await evalJS(`document.querySelector('.tip')?.textContent.trim()`))

    /* ---- 2. 时间线里出现派生行 ---- */
    await goWeek()
    await waitFor(`${courseBlocksSel}.length > 0`, 10000, '课程派生行出现')

    const before = await blockStats()
    ok('同步后时间线出现课程派生行', before.courses > 0, `${before.courses} 条 / 共 ${before.all} 块`)
    // getComputedStyle 会把 var() 替换成实际值，所以跟 --cat-class 的解析结果比
    const catToken = await evalJS(
      `getComputedStyle(document.documentElement).getPropertyValue('--cat-class').trim()`,
    )
    ok(
      '派生行按「课程」分类着色（--cat-class）',
      before.catVar === catToken,
      `--blk-cat=${before.catVar} / --cat-class=${catToken}`,
    )
    await shot('1-week-courses')

    /* ---- 3. 只读：长按不武装 ---- */
    const courseTitle = before.sample
    const courseArmed = await longPress(courseTitle)
    ok('长按派生行**不**武装（拖不动）', courseArmed === 'idle', `${courseTitle} → ${courseArmed}`)

    const plainArmed = await longPress(PLAIN_TODO)
    ok('长按普通待办照旧武装（对照）', plainArmed === 'armed', `${PLAIN_TODO} → ${plainArmed}`)

    /* ---- 4. 点派生行 → 只读课程详情 ---- */
    await evalJS(`[...document.querySelectorAll('.col .blk')]
      .find((e) => e.dataset.title === ${JSON.stringify(courseTitle)})?.click()`)
    await waitFor(`document.querySelector('.panel h2')?.textContent === '课程'`, 6000, '课程详情面板')
    ok('点派生行开的是课程详情，不是待办编辑器', true)

    const sheet = await evalJS(`(() => {
      const p = document.querySelector('.panel')
      return {
        title: p?.querySelector('h2')?.textContent ?? '',
        text: p?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        edits: [...p.querySelectorAll('button')].filter((b) => /编辑|删除/.test(b.getAttribute('aria-label') ?? '')).length,
      }
    })()`)
    ok('详情里没有「编辑」「删除」', sheet.edits === 0, `found ${sheet.edits}`)
    ok('详情说明改动会被同步覆盖', /重新同步/.test(sheet.text), sheet.text.slice(0, 80))
    ok('详情提供「在课表中查看」出口', /在课表中查看/.test(sheet.text))
    await shot('2-course-sheet')

    /* ---- 5. 打卡 ---- */
    await clickText('.panel button', '标记已完成')
    await waitFor(`document.body.textContent.includes('已打卡')`, 6000, '打卡状态')
    ok('派生行可以打卡（考勤属于用户）', true)
    await evalJS(`document.querySelector('.panel .close')?.click()`)

    /* ---- 6. 再同步：幂等 + done 行不被重建 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`!!document.querySelector('.primary')`, 8000, '配置页')
    await clickText('button', '立即同步')
    await waitFor(`document.body.textContent.includes('上次同步')`, 10000, '同步完成')

    await evalJS(`location.hash = '#/todos'`)
    await goWeek()
    await waitFor(`${courseBlocksSel}.length > 0`, 10000, '派生行重建')

    const after = await blockStats()
    ok(
      '重复同步不会让派生行变多（先删后建，幂等）',
      after.courses === before.courses,
      `前 ${before.courses} → 后 ${after.courses}`,
    )
    ok(
      '打过卡的那行没被重建回未完成（done 行永不删）',
      after.doneCourses === before.doneCourses + 1,
      `done：前 ${before.doneCourses} → 后 ${after.doneCourses}`,
    )
    await shot('3-after-resync')

    /* ---- 7. 删账号 → 派生行与课表一起清 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.body.textContent.includes('账号管理')`, 8000, '账号管理区')
    await clickText('button', '删除账号')
    await waitFor(`!!document.querySelector('.card-wrap .opt')`, 6000, '删除确认弹层')
    ok('删账号有二次确认', true, await evalJS(`document.querySelector('.card-wrap .title')?.textContent.trim()`))
    await clickText('.card-wrap .opt', '删除账号并清除课表日程')
    await waitFor(`document.body.textContent.includes('账号与课表日程已清除')`, 8000, '删除回执')

    await evalJS(`location.hash = '#/todos'`)
    await goWeek()
    await sleep(600)
    const gone = await blockStats()
    ok('删除账号后派生行一并清除', gone.courses === 0, `剩 ${gone.courses} 条`)
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log(`截图目录：${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('e2e 失败：', e.message)
  process.exit(1)
})
