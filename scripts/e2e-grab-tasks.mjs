/**
 * e2e-grab-tasks —— 抢课任务管理页（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要单独一条：任务单在选课页只是**仪表盘的一部分**（按志愿组渲染、和倒计时抢位置），
 * 而「哪些没抢到、为什么、要不要重排」需要一屏摊开并且能动手。这条验的就是那个面：
 *
 *   1. 入口常驻在选课页页头（多选模式下也在）
 *   2. 三种状态各归各位：进行中 / 已抢到 / 没抢到
 *   3. **编辑**：改设置之后旧的那条撤掉、新的那条排上（不留垃圾）
 *   4. 重试 / 两步移除
 *   5. **重启别重播**：任务单落盘了（页面刷新后还在），但旧结果不该再弹一次浮条 ——
 *      这一条是用户实际报上来的毛病（每次启动都弹「XXX未选到」）
 *
 * 前置：npm run dev（或 REIN_E2E_URL 指向其它实例）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!EDGE) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-tasks-${Date.now()}`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let ws
let nextId = 1
const pending = new Map()
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch {
      /* 导航中 */
    }
    await sleep(120)
  }
  console.log(`   ! 等待超时: ${label}`)
  return false
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${name}`)
}

const setInput = (sel, val) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return false
    const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    s.call(el, ${JSON.stringify(val)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

const clickText = (sel, text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

const lessonRow = (name) =>
  `[...document.querySelectorAll('.lesson')].find((e) => e.querySelector('.l-name')?.textContent.includes(${JSON.stringify(name)}))`

/** 任务管理页里某门课那一行 */
const taskRow = (name) =>
  `[...document.querySelectorAll('.page .task')].find((e) => e.querySelector('.name')?.textContent.includes(${JSON.stringify(name)}))`

/** 某门课落在哪个分组里（小组标题文本 + 行状态徽标） */
const taskWhere = (name) =>
  evalJS(`(() => {
    const row = ${taskRow(name)}
    if (!row) return null
    const sec = row.closest('.card')
    return {
      group: sec?.querySelector('h2')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      chip: row.querySelector('.chip')?.textContent.trim() ?? '',
    }
  })()`)

async function taskCount() {
  return evalJS(`document.querySelectorAll('.page .task').length`)
}

/** 顶部那条浮条现在写的什么（没有就是 null） */
const hud = () => evalJS(`document.querySelector('.hud')?.textContent ?? null`)

async function openSheetAnd(name, button) {
  await evalJS(`(() => { const row = ${lessonRow(name)}; row?.querySelector('.pick')?.click() })()`)
  if (!(await waitFor(`!!document.querySelector('.panel')`, 5000, '抽屉'))) return false
  await sleep(300)
  return clickText('.panel button', button)
}

async function login() {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 15000, '配置页')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 10000, '学校系统选择器')
  await setInput('input[autocomplete="username"]', '2600350118')
  await setInput('input[autocomplete="current-password"]', 'demo1234')
  await clickText('button', '登录')
  await waitFor(`document.body.textContent.includes('已登录')`, 15000, '登录成功')
}

async function goSelect() {
  await evalJS(`location.hash = '#/campus/course-select'`)
  await waitFor(`['选课','选择教学班'].includes(document.querySelector('h1')?.textContent ?? '')`, 12000, '选课页')
}

const DEBUG_PORT = 9800 + (process.pid % 90)

async function main() {
  const edge = spawn(
    EDGE,
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
    await sleep(1600)
    let list = null
    const dl = Date.now() + 20000
    while (Date.now() < dl) {
      try {
        list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
        if (list.length) break
      } catch {
        /* 端口还没开 */
      }
      await sleep(500)
    }
    if (!list?.length) throw new Error(`调试端口 ${DEBUG_PORT} 没起来`)
    ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
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
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__REIN_MOCK_UPDATE_NONE__ = true;',
    })
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true })

    await cdp('Page.navigate', { url: `${APP}/#/campus/course-select` })
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login()
    await goSelect()

    /* ---- 1. 入口常驻 ---- */
    const entry = `document.querySelector('a[aria-label="抢课任务"]')`
    ok('选课页页头有任务管理入口', (await evalJS(`!!${entry}`)) === true)
    await waitFor(`document.body.textContent.includes('可进入')`, 10000, '批次')
    await clickText('.pick-bar button', '多选预定')
    await sleep(300)
    ok('多选模式开着时入口依然在（抢完正要看它）', (await evalJS(`!!${entry}`)) === true)
    await clickText('.pick-bar button', '退出多选')
    await sleep(300)

    /* ---- 2. 空态 ---- */
    await evalJS(`${entry}.click()`)
    await waitFor(`document.querySelector('h1')?.textContent === '抢课任务'`, 8000, '任务页')
    ok('还没有任务时给空态与出口', (await evalJS(`document.body.textContent.includes('还没有抢课任务')`)) === true)
    ok(
      '空态能回选课页',
      (await evalJS(`!!document.querySelector('.empty a, .cta')`)) === true,
      await evalJS(`document.querySelector('.cta')?.textContent.trim()`),
    )
    await shot('1-empty')

    /* ---- 3. 一条没抢到的任务 ---- */
    await goSelect()
    await clickText('.turn .primary', '进入选课')
    await waitFor(`document.querySelectorAll('.lesson').length >= 7`, 10000, '教学班列表')
    // 9003 固定返回「时间冲突，需办免听」—— 确定性地落进「没抢到」
    await openSheetAnd('大学物理', '加入抢课')
    await waitFor(`document.body.textContent.includes('需办免听')`, 15000, '任务落到需办免听')
    // 再排一门会抢到的，用来验分组
    await openSheetAnd('线性代数', '加入抢课')
    await waitFor(`document.body.textContent.includes('已抢到')`, 15000, '任务抢到')

    /* ---- 3b. 结果必须送达：他**不在**结果页上时 ---- */
    // 排一门会抢到的课，然后**立刻切走** —— 结果到达时他不在结果页上，
    // 而通知发不出去（浏览器），所以浮条是唯一的告知，它**不能自己消失**。
    // （此刻我们本来就在选课页的批次里，不用再绕一圈导航。）
    await openSheetAnd('计算机科学导论', '加入抢课')
    await evalJS(`location.hash = '#/'`)
    await sleep(300)
    const gotResult = await waitFor(
      `(document.querySelector('.hud')?.textContent ?? '').includes('已抢到')`,
      25000,
      '浮条报出结果',
    )
    ok('不在结果页时结果会挂到浮条上（通知发不出去时的兜底）', gotResult, String(await hud()))
    if (!gotResult) {
      console.log(
        '   [诊断] mock 任务：',
        await evalJS(`(async () => {
          const m = await import('/src/mock/server.ts')
          const s = await m.mockInvoke('campus_grab_state', {})
          return JSON.stringify((s.tasks||[]).map(t => ({ id: t.id, st: t.status, msg: t.lastMessage })))
        })()`),
      )
    }
    await shot('3b-sticky')

    await evalJS(`location.hash = '#/campus/grab-tasks'`)
    await waitFor(`document.querySelector('h1')?.textContent === '抢课任务'`, 8000, '任务页')
    await waitFor(`document.querySelectorAll('.page .task').length === 3`, 8000, '三条任务')
    const lost = await taskWhere('大学物理')
    const won = await taskWhere('线性代数')
    ok('没抢到的归到「没抢到」', lost?.group.includes('没抢到') === true, JSON.stringify(lost))
    ok('抢到的归到「已抢到」', won?.group.includes('已抢到') === true, JSON.stringify(won))
    ok(
      '没抢到的那条写清了原因（教务的原话）',
      (await evalJS(`(${taskRow('大学物理')})?.textContent ?? ''`)).includes('免听'),
      await evalJS(`(${taskRow('大学物理')})?.textContent.replace(/\\s+/g,' ').trim()`),
    )
    await shot('2-groups')

    /* ---- 4. 编辑：改设置并重排（旧的那条要撤掉） ---- */
    const beforeIds = await evalJS(`[...document.querySelectorAll('.page .task')].length`)
    await evalJS(`(() => { const b = ${taskRow('大学物理')}; b?.querySelector('[aria-label="改设置并重排"]')?.click() })()`)
    await waitFor(`document.querySelector('.panel')?.textContent.includes('改设置并重排') === true`, 5000, '编辑抽屉')
    ok(
      '编辑抽屉从这条任务的**当前设置**起步',
      (await evalJS(`document.querySelector('.panel')?.textContent ?? ''`)).includes('占位优先'),
    )
    await shot('3-edit')
    await clickText('.panel button', '保存并重新排队')
    await waitFor(`!document.querySelector('.panel')`, 8000, '抽屉关闭')
    await waitFor(`document.querySelectorAll('.page .task').length === ${beforeIds}`, 8000, '重排后条数不变')
    const afterIds = await evalJS(`[...document.querySelectorAll('.page .task .name')].map((e) => e.textContent.trim())`)
    ok('重排之后没有多出一条垃圾（旧的被撤掉了）', afterIds.length === beforeIds, JSON.stringify(afterIds))

    /* ---- 5. 重试 ---- */
    await evalJS(`(() => { const b = ${taskRow('大学物理')}; b?.querySelector('[aria-label="重试"]')?.click() })()`)
    ok(
      '点了重试就回到「进行中」',
      await waitFor(`${taskRow('大学物理')}?.closest('.card')?.querySelector('h2')?.textContent.includes('进行中') === true`, 8000, '回到进行中'),
      JSON.stringify(await taskWhere('大学物理')),
    )

    /* ---- 6. 进结果页 → 浮条收起；两步移除 ---- */
    // 走 hash 而不是点页头入口：此刻在首页上，那里没有这个入口
    await evalJS(`location.hash = '#/campus/grab-tasks'`)
    await waitFor(`document.querySelector('h1')?.textContent === '抢课任务'`, 8000, '回任务页')
    ok(
      '进了任务页（结果的正主）浮条就收起来了',
      (await evalJS(`document.querySelector('.hud')?.textContent ?? null`)) === null,
    )
    const beforeRemove = await taskCount()
    await evalJS(`(() => { const b = ${taskRow('线性代数')}; b?.querySelector('[aria-label="移除"]')?.click() })()`)
    ok(
      '移除先要一次确认（不会一击即删）',
      (await evalJS(`!!(${taskRow('线性代数')})?.querySelector('[aria-label="确认移除"]')`)) === true,
    )
    await evalJS(`(() => { const b = ${taskRow('线性代数')}; b?.querySelector('[aria-label="确认移除"]')?.click() })()`)
    ok('再点一次才真的移除', (await waitFor(`${taskRow('线性代数')} == null`, 6000, '行消失')) === true)
    ok('移除之后条数正好少一', (await taskCount()) === beforeRemove - 1, `${beforeRemove} → ${await taskCount()}`)

    // 入口在选课页上 —— 角标（没抢到的条数）也得回那一页去看
    await goSelect()
    await waitFor(`!!document.querySelector('a[aria-label="抢课任务"] .badge')`, 8000, '角标出现')
    ok(
      '页头入口带「没抢到」的角标',
      (await evalJS(`document.querySelector('a[aria-label="抢课任务"] .badge')?.textContent ?? ''`)).trim() === '1',
      await evalJS(`document.querySelector('a[aria-label="抢课任务"] .badge')?.textContent ?? ''`),
    )

    /* ---- 7. 重启别重播 ---- */
    // 「重启」在这里就是**整页重载**：mock 把任务单落盘了（真引擎落 SQLite），所以任务还在；
    // 但**旧结果不该再报一遍** —— 那正是用户报上来的那个毛病（每次启动都弹「XXX未选到」）。
    // 注意：`Page.navigate` 到同一个地址只改 hash 时浏览器**不会重载**（SPA 内部路由），
    // 所以这里带一个查询参数，逼出一次真正的重新加载。
    await cdp('Page.navigate', { url: `${APP}/?restart=1#/campus/grab-tasks` })
    await waitFor(`document.querySelector('h1')?.textContent === '抢课任务'`, 15000, '重启后的任务页')
    await sleep(2500)
    ok('重启后任务还在（任务单落盘了）', (await taskCount()) >= 1, String(await taskCount()))
    const hudAfterReload = await evalJS(`document.querySelector('.hud')?.textContent ?? null`)
    ok(
      '重启后不会把旧结果再报一遍（浮条不该提这门课）',
      !(hudAfterReload ?? '').includes('大学物理'),
      String(hudAfterReload),
    )
    await shot('5-after-reload')
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
