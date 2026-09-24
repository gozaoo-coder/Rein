/**
 * e2e-course-select —— 选课 UI 端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：抢课的价值全在「点了之后到底发生了什么」——提交 → 教务异步受理 →
 * 轮询 → 落定，这条链路有进度文案、有按钮去重、有成功/冲突两种收尾，只有真渲染出来
 * 才验证得了。Rust 侧的 34 个单测钉的是请求体与解析，钉不到这些。
 *
 * 剧本：
 *   1. 未登录 → 选课页显示「去配置」空态
 *   2. 登录后进入 → 服务器时间、账号回显
 *   3. 批次未开放（钩子置空）→ 等待态而不是故障态
 *   4. 批次开放 → 进入 → 教学班列表；搜索按课程名/代码过滤
 *   5. 一键选课 → 轮询 → 「已选」标记落回列表
 *   6. 冲突课 → 「需要免听」提示，且**不能被误标为已选**
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-course-select.mjs
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
/** 输出目录：默认系统临时目录；REIN_E2E_OUT 可指定（便于人工翻看截图） */
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-select-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

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

/** 设置原生 input 的值并触发 Vue 的 v-model（监听的是 input 事件） */
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

/** 按课程名找到教学班行 */
const lessonRow = (name) =>
  `[...document.querySelectorAll('.lesson')].find((e) => e.querySelector('.l-name')?.textContent.includes(${JSON.stringify(name)}))`

/**
 * 点某一行的「抢课」按钮打开抽屉，再点抽屉里的「只试一次」（明细级的次要动作，
 * 标签自己写着「不加入任务单」）。
 *
 * 行按钮不再直接提交：抢课需要先选「上课小组 / 意愿值 / 占位还是直接提交」，
 * 所以一次性提交这一步挪进了抽屉。这条断言链验的仍然是「提交 → 受理 → 轮询 → 落定」。
 */
async function clickPick(name) {
  const opened = await evalJS(`(() => {
    const row = ${lessonRow(name)}
    if (!row) return false
    row.querySelector('.pick').click()
    return true
  })()`)
  if (!opened) return false
  await waitFor(`!!document.querySelector('.panel')`, 5000, '抢课抽屉打开')
  return clickText('.panel button', '只试一次')
}

/**
 * 刷新按钮：页头现在有两个按钮（抢课节奏 / 刷新），必须按 aria-label 定位。
 * 点之前先等它可用 —— 刷新期间它是禁用的，对禁用按钮调 click() 不会有任何反应。
 */
async function clickRefresh() {
  await waitFor(`(() => { const b = document.querySelector('[aria-label="立即刷新"]'); return !!b && !b.disabled })()`, 15000, '刷新按钮可用')
  return evalJS(`document.querySelector('[aria-label="立即刷新"]').click()`)
}

/** 某一行的状态：按钮文案 + 徽标 */
const rowState = (name) =>
  evalJS(`(() => {
    const row = ${lessonRow(name)}
    if (!row) return null
    return {
      btn: row.querySelector('.pick')?.textContent.trim(),
      disabled: row.querySelector('.pick')?.disabled === true,
      chip: row.querySelector('.chip')?.textContent.trim() ?? '',
    }
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
    await connect(`${APP}/#/campus/course-select`)

    /* ---- 1. 未登录空态 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 12000, '选课页挂载')
    await waitFor(`document.body.textContent.includes('还没有绑定教务系统账号')`, 6000, '未登录空态')
    ok('未登录时提示先绑定账号', true)
    ok('空态提供「去配置」出口', await evalJS(`!!document.body.textContent.includes('去配置')`))
    await shot('1-empty')

    /* ---- 2. 登录 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 8000, '配置页挂载')
    await waitFor(`document.querySelectorAll('.sys').length >= 1`, 6000, '学校系统选择器有选项')
    await setInput('input[autocomplete="username"]', '2600350118')
    await setInput('input[autocomplete="current-password"]', 'demo1234')
    await clickText('button', '登录')
    await waitFor(`document.body.textContent.includes('已登录')`, 12000, '登录成功')

    // 入口就在配置页里，走一次真实点击而不是直接改 hash
    ok(
      '配置页有选课入口',
      await evalJS(
        `[...document.querySelectorAll('.link-row')].some((e) => e.textContent.includes('选课（直连教务）'))`,
      ),
    )
    await clickText('.link-row', '选课（直连教务）')

    /* ---- 3. 未开放批次 → 等待态 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 8000, '选课页挂载')
    await waitFor(`document.body.textContent.includes('可进入')`, 8000, '演示批次渲染')
    ok('批次卡片显示开放状态与时间', true, await evalJS(`document.querySelector('.turn .line')?.textContent.trim()`))

    await evalJS(`window.__REIN_MOCK_NO_SELECT_TURN__ = true`)
    await clickRefresh()
    await waitFor(`document.body.textContent.includes('当前没有开放的选课批次')`, 8000, '等待态')
    ok('批次为空时是「等待窗口开放」而不是报错', true)
    ok(
      '等待态给出官方选课页出口',
      await evalJS(`!!document.querySelector('.cta.ghost')?.href.includes('course-selection')`),
      await evalJS(`document.querySelector('.cta.ghost')?.textContent.trim()`),
    )
    await shot('2-waiting')

    await evalJS(`window.__REIN_MOCK_NO_SELECT_TURN__ = false`)
    await clickRefresh()
    await waitFor(`document.body.textContent.includes('可进入')`, 8000, '批次恢复')

    /* ---- 4. 服务器时间 ---- */
    const time = await evalJS(`[...document.querySelectorAll('.grab .facts')]
      .map((r) => r.textContent).find((t) => t.includes('教务服务器时间'))
      ?.match(/教务服务器时间\\s*([\\d-]+ [\\d:]+)/)?.[1]`)
    ok('显示教务服务器时间（抢课对时用）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time ?? ''), time ?? '(空)')
    ok('未出现时钟偏差告警（偏差 < 30s 不打扰用户）', (await evalJS(`!document.querySelector('.grab .warn')`)) === true)
    ok(
      '倒计时缺席时不摆数字（没有值得等的时刻）',
      (await evalJS(`!document.querySelector('.grab .cd-big')`)) === true,
    )

    /* ---- 5. 进入批次 → 教学班列表 ---- */
    await clickText('.turn .primary', '进入选课')
    await waitFor(`document.querySelectorAll('.lesson').length >= 7`, 8000, '教学班列表')
    ok('进入批次后列出教学班', true, await evalJS(`document.querySelectorAll('.lesson').length`) + ' 个')

    const full = await rowState('大学物理')
    ok('满员教学班标「已满」', full?.chip === '已满', JSON.stringify(full))

    const seat = await evalJS(`[...document.querySelectorAll('.lesson')]
      .find((e) => e.querySelector('.l-name')?.textContent.includes('大学英语'))
      ?.querySelector('.l-meta')?.textContent.replace(/\\s+/g, ' ').trim()`)
    ok('列出课程代码 / 学分 / 已选人数', /000002/.test(seat ?? '') && /学分/.test(seat ?? ''), seat ?? '')

    /* ---- 6. 搜索过滤 ---- */
    await setInput('.search input', '英语')
    await evalJS(`document.querySelector('.go').click()`)
    await waitFor(`document.querySelectorAll('.lesson').length === 1`, 8000, '搜索收敛')
    ok('搜索按课程名过滤', await evalJS(`document.querySelector('.l-name')?.textContent.includes('英语')`))

    await setInput('.search input', '000031')
    await evalJS(`document.querySelector('.go').click()`)
    await waitFor(`document.querySelector('.l-name')?.textContent.includes('体育') === true`, 8000, '按代码搜索')
    ok('搜索按课程代码过滤', true)

    await setInput('.search input', '')
    await evalJS(`document.querySelector('.go').click()`)
    await waitFor(`document.querySelectorAll('.lesson').length >= 7`, 8000, '清空搜索')
    ok('清空搜索回到全部', true)
    await shot('3-lessons')

    /* ---- 6b. 搜「羽毛球」：教务的查询字段里根本没有它 ---- */
    // 体育课的课程名是「大学体育1」，项目名（羽毛球）在 `minorCourse` ——
    // 学生的第一反应一定是打「羽毛球」，而服务器只会回一段空列表。
    // 这条验的是：界面自己退一步、把全量拉回来在本地按项目名过滤。
    await setInput('.search input', '羽毛球')
    await evalJS(`document.querySelector('.go').click()`)
    await waitFor(`document.querySelectorAll('.lesson').length === 2`, 8000, '按项目名搜出两个班')
    ok('按项目名搜索能命中（教务查不到，靠本地兜底）', true, await evalJS(`document.querySelectorAll('.lesson').length`) + ' 个')
    const peNames = await evalJS(`[...document.querySelectorAll('.lesson .l-name')].map((e) => e.textContent.trim())`)
    ok(
      '行标题显示项目名而不是那门共用的课程名',
      peNames.length === 2 && peNames.every((n) => n === '羽毛球'),
      JSON.stringify(peNames),
    )
    const peMeta = await evalJS(`[...document.querySelectorAll('.lesson')].map((e) => e.textContent.replace(/\\s+/g,' ').trim())`)
    ok(
      '副信息里带出课程名与教学班名，两个班的院系也分得开',
      peMeta.every((t) => t.includes('大学体育1-花江校区-26级')) &&
        peMeta.some((t) => t.includes('3院')) &&
        peMeta.some((t) => t.includes('4院')),
      JSON.stringify(peMeta).slice(0, 240),
    )

    await setInput('.search input', '')
    await evalJS(`document.querySelector('.go').click()`)
    await waitFor(`document.querySelectorAll('.lesson').length >= 7`, 8000, '再次清空搜索')

    /* ---- 7. 一键选课：提交 → 轮询 → 落定 ---- */
    // 防连点的守卫现在在抽屉里（提交要等结果，期间不能让人再按一次）
    await evalJS(`(${lessonRow('高等数学')}).querySelector('.pick').click()`)
    await waitFor(`!!document.querySelector('.panel')`, 5000, '抢课抽屉打开')
    await clickText('.panel button', '只试一次')
    await waitFor(`document.body.textContent.includes('教务处理中')`, 6000, '提交中状态')
    ok(
      '提交期间抽屉里的按钮禁用（防连点重复提交）',
      await evalJS(`[...document.querySelectorAll('.panel .primary, .panel .once')].every((b) => b.disabled)`),
    )

    await waitFor(`document.body.textContent.includes('选课成功')`, 15000, '轮询出结果')
    ok('轮询后提示选课成功', true)
    await waitFor(`document.querySelectorAll('.chip.ok').length === 1`, 6000, '已选标记')
    const picked = await rowState('高等数学')
    // 这条原先断言「已选之后按钮必须禁用」。**那是个缺陷，不是规格** ——
    // 一旦禁用，这门课在列表上就成了一块点不动的死砖：用户没有任何地方能核对
    // 自己当初是怎么排的（选了哪个上课小组、填了多少意愿值）。
    // 现在断言的是「标成已选，且仍然点得开」。
    ok(
      '成功的课在列表里标「已选」，且仍可点开核对',
      picked?.chip === '已选' && picked?.disabled === false,
      JSON.stringify(picked),
    )

    /* ---- 8. 冲突课：提示免听，且不能被算成已选 ---- */
    await clickPick('大学物理')
    await waitFor(`document.body.textContent.includes('办理免听')`, 15000, '冲突提示')
    ok('时间冲突的课提示去网页端办免听', true)
    const conflict = await rowState('大学物理')
    ok(
      '冲突未选中的课**不**标「已选」',
      conflict?.chip !== '已选' && conflict?.disabled === false,
      JSON.stringify(conflict),
    )
    await shot('4-result')

    /* ---- 9. 返回批次列表 ---- */
    await clickText('.back-row', '返回批次列表')
    await waitFor(`!!document.querySelector('.turn')`, 6000, '回到批次列表')
    ok('可返回批次列表', true)
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
