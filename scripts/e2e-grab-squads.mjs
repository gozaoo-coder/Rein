/**
 * e2e：志愿组（互斥备选）+ 多选批量预定
 *
 * 钉住的是**只有志愿组才说得通的那几条**：
 *   1. 一次选中多个教学班 → 排成一组，勾选顺序就是志愿序
 *   2. 组内只主攻当前志愿，其余显示「等第 N 志愿」而不是各自乱抢
 *   3. 任一中选 → 同组其余自动取消（这是「不会同时抢到两门冲突课」的保证）
 *   4. 当前志愿进终态（这里是时间冲突）→ 下一志愿自动接手，不需要任何手动操作
 *   5. 选「各抢各的」时不产生任何组关系
 *
 * 浏览器里没有 Rust 那条后台线程，所以 `mock/server.ts` 自己实现了一份模拟引擎；
 * 本脚本断言的是那份实现与真引擎**同序**的部分。
 *
 * 用法：node scripts/e2e-grab-squads.mjs（需 npm run dev 在 1420）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-squads-${Date.now()}`
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

const lessonRow = (name) =>
  `[...document.querySelectorAll('.lesson')].find((e) => e.querySelector('.l-name')?.textContent.includes(${JSON.stringify(name)}))`

const taskRowExpr = (name) =>
  `[...document.querySelectorAll('.grab .task')].find((e) => e.querySelector('.name')?.textContent.includes(${JSON.stringify(name)}))`

const chipOf = (name) => `((${taskRowExpr(name)})?.querySelector('.chip')?.textContent.trim() ?? '')`

/** 任务行上的全部徽标（第 N 志愿 / 状态 / 等第几志愿） */
const chipsOf = (name) =>
  `[...((${taskRowExpr(name)})?.querySelectorAll('.chip') ?? [])].map((c) => c.textContent.trim())`

const ordOf = (name) => `((${taskRowExpr(name)})?.querySelector('.ord')?.textContent.trim() ?? '')`

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

/** 进入选课页并走进批次 */
async function enterTurn() {
  await evalJS(`location.hash = '#/campus/course-select'`)
  await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
  await waitFor(`document.body.textContent.includes('可进入')`, 10000, '批次渲染')
  await clickText('.turn .primary', '进入选课')
  await waitFor(`document.querySelectorAll('.lesson').length === 7`, 10000, '教学班列表')
}

/** 多选模式下按顺序勾选（顺序 = 志愿序） */
async function pick(name) {
  const clicked = await evalJS(`(() => {
    const row = ${lessonRow(name)}
    const btn = row?.querySelector('.l-main')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) throw new Error(`勾选不到教学班：${name}`)
  await sleep(120)
  return clicked
}

async function startMultiSelect() {
  await clickText('.pick-bar button', '多选预定')
  await waitFor(`!!document.querySelector('.lessons.picking')`, 4000, '进入多选模式')
}

/** 批量抽屉里确认 */
async function confirmBatch() {
  await clickText('.pick-bar button', '加入抢课')
  await waitFor(`!!document.querySelector('.panel')`, 5000, '批量抽屉打开')
  await clickText('.panel .acts button', '加入抢课')
  await waitFor(`!document.querySelector('.panel')`, 5000, '批量抽屉关闭')
}

/** 清掉任务单里已结束的行，避免上一段场景干扰下一段。
 *  结束态由**结果面**负责清理（两步确认），旧版的「清掉已结束的」页脚按钮已经没有了。 */
async function clearFinished() {
  const has = await evalJS(`!!document.querySelector('.grab .result .link')`)
  if (!has) return
  await clickText('.grab .result .link', '清掉')
  await clickText('.grab .result .link', '确认清空')
  await sleep(300)
}

const DEBUG_PORT = 9700 + (process.pid % 150)

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
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await enterTurn()

    /* ---- 1. 多选 → 排成志愿组 ---- */
    await startMultiSelect()
    await pick('高等数学（上）') // 第 1 志愿
    await pick('体育（一）') // 第 2 志愿
    ok('多选模式下能看到已选计数', (await evalJS(`document.querySelector('.pick-bar .count')?.textContent`))?.includes('2'))
    ok('勾选顺序标成了志愿序', (await evalJS(`document.querySelector('.lessons .ord')?.textContent.trim() ?? ''`)) === '第 1 志愿')

    await clickText('.pick-bar button', '加入抢课')
    await waitFor(`!!document.querySelector('.panel')`, 5000, '批量抽屉打开')
    ok(
      '批量抽屉把顺序摆出来给人看',
      (await evalJS(`document.querySelector('.panel .batch-list')?.textContent ?? ''`)).includes('高等数学'),
    )
    await shot('1-batch')
    await confirmBatch()

    /* ---- 2. 组渲染：组头 + 志愿序 + 「等第 N 志愿」 ---- */
    await waitFor(`!!document.querySelector('.grab .squad')`, 6000, '志愿组头出现')
    ok('任务单按志愿组渲染（组头）', true)
    ok('第 1 志愿被标出来', (await evalJS(ordOf('高等数学'))) === '第 1')
    ok('第 2 志愿被标出来', (await evalJS(ordOf('体育'))) === '第 2')
    ok(
      '组头说明当前是谁在抢',
      ((await evalJS(`document.querySelector('.grab .squad')?.textContent ?? ''`)).includes('第 1 志愿在抢')),
      await evalJS(`document.querySelector('.grab .squad')?.textContent.replace(/\\s+/g, ' ').trim()`),
    )
    ok(
      '被压住的第 2 志愿显示「等第 1 志愿」而不是自己乱抢',
      (await evalJS(chipsOf('体育（一）'))).some((c) => c.includes('等第 1 志愿')),
      JSON.stringify(await evalJS(chipsOf('体育（一）'))),
    )
    await shot('2-squad')

    /* ---- 3. 中选即收组 ---- */
    await waitFor(`(${chipOf('高等数学')}) === '已抢到'`, 20000, '第 1 志愿抢到')
    ok('第 1 志愿中选', true)
    await waitFor(`(${chipOf('体育（一）')}) === '已取消'`, 8000, '同组备选被取消')
    ok('任一中选 → 同组其余自动取消', true, await evalJS(`(${taskRowExpr('体育（一）')})?.querySelector('.meta')?.textContent.trim()`))
    ok(
      '取消原因说明了是被谁抢先的',
      // 读整行文本：结束态下这一行由结果面渲染，文案可能落在 .meta 之外的节点上
      (await evalJS(`(${taskRowExpr('体育（一）')})?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)).includes(
        '已被第 1 志愿',
      ),
      await evalJS(`(${taskRowExpr('体育（一）')})?.textContent.replace(/\\s+/g, ' ').trim()`),
    )
    await shot('3-closed')

    await clearFinished()
    await waitFor(`document.querySelectorAll('.grab .task').length === 0`, 6000, '清空任务单')

    /* ---- 4. 第一志愿进终态 → 下一志愿自动接手 ---- */
    await evalJS(`location.hash = '#/'`)
    await sleep(400)
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.querySelectorAll('.lesson').length === 7`, 10000, '回到教学班列表')

    await startMultiSelect()
    await pick('大学物理（含实验）') // 第 1 志愿，会走到「时间冲突」终态
    await pick('体育（一）') // 第 2 志愿
    await confirmBatch()

    await waitFor(`!!document.querySelector('.grab .squad')`, 6000, '志愿组头')
    ok(
      '一开始仍是第 1 志愿在抢',
      (await evalJS(chipsOf('体育（一）'))).some((c) => c.includes('等第 1 志愿')),
    )

    // 第 1 志愿时间冲突 → 终态；第 2 志愿应当**自动**成为当前志愿并继续抢
    await waitFor(`(${chipOf('大学物理（含实验）')}) === '需办免听'`, 20000, '第 1 志愿落到终态')
    ok('第 1 志愿走到终态（时间冲突）', true)
    // 出局的那条不该还挂着「等第 N 志愿」—— 否则界面上一条已经没戏的任务看起来还在排队
    ok(
      '出局的那条不再显示「等第 N 志愿」',
      !(await evalJS(chipsOf('大学物理（含实验）'))).some((c) => c.includes('等第')),
      JSON.stringify(await evalJS(chipsOf('大学物理（含实验）'))),
    )
    await waitFor(`(${chipOf('体育（一）')}) === '已抢到'`, 25000, '第 2 志愿接手并抢到')
    ok('第 1 志愿没戏后，第 2 志愿自动接手并抢到（无需手动操作）', true)
    ok(
      '接手后不再是「等第 1 志愿」',
      !(await evalJS(chipsOf('体育（一）'))).some((c) => c.includes('等第 1 志愿')),
      JSON.stringify(await evalJS(chipsOf('体育（一）'))),
    )
    await shot('4-promoted')

    await clearFinished()

    /* ---- 5. 选「各抢各的」不该产生任何组关系 ---- */
    await evalJS(`location.hash = '#/'`)
    await sleep(400)
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.querySelectorAll('.lesson').length === 7`, 10000, '回到教学班列表')

    await startMultiSelect()
    await pick('高等数学（上）')
    await pick('大学英语（一）')
    await clickText('.pick-bar button', '加入抢课')
    await waitFor(`!!document.querySelector('.panel')`, 5000, '批量抽屉')
    await clickText('.panel button', '各抢各的')
    await sleep(200)
    await clickText('.panel .acts button', '加入抢课')
    await waitFor(`!document.querySelector('.panel')`, 5000, '批量抽屉关闭')

    await waitFor(`document.querySelectorAll('.grab .task').length === 2`, 8000, '两条独立任务')
    ok('「各抢各的」不组成志愿组', (await evalJS(`!document.querySelector('.grab .squad')`)) === true)
    ok('独立任务没有志愿序标记', (await evalJS(ordOf('高等数学'))) === '')
    // 两条都该各自抢到（互不压制）
    await waitFor(
      `(${chipOf('高等数学')}) === '已抢到' && (${chipOf('大学英语（一）')}) === '已抢到'`,
      25000,
      '两条独立任务各自抢到',
    )
    ok('独立任务互不压制，各自抢到', true)
    await shot('5-independent')
  } finally {
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
