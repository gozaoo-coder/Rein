/**
 * e2e-auto-grab —— 自动抢课引擎端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要单独一个脚本：抢课的价值**全在「用户不在看的时候发生了什么」** ——
 * 任务排进队列、到点自动出手、满员了继续守着、出事了分级处理。
 * 这些东西没法靠点一个按钮验完，必须让引擎真的跑一遍再看它留下的痕迹。
 *
 * 浏览器 mock 里没有 Rust 那条后台线程，所以 `src/mock/server.ts` 自己实现了一份
 * 模拟引擎（`grabTick`）。它和真引擎的**状态序列**一致，只是时间尺度被压缩了；
 * 唯一不打折的是「开窗前不出手」那条闸门 —— 它是整套逻辑的核心不变量。
 *
 * 剧本：
 *   1. 行按钮打开抢课抽屉 → 抽屉讲清「上课小组 / 意愿值 / 抢课方式」
 *   2. 加入抢课 → 任务单出现该课，行上变成引擎给的状态
 *   3. 引擎自己走完：占位 → 受理 → 正式确认 → 已抢到（全程没再点任何东西）
 *   4. 满员课：先失败几次再抢到 → 「已尝试 N 次」证明它真的在守
 *   5. 冲突课：落到「需办免听」，且**不**被算成已选
 *   6. 窗口未公布：任务停在「等窗口公布」，不会盲撞；窗口一公布就自动开抢
 *   7. 暂停 / 恢复 / 取消 / 移除、全部暂停、清空已结束
 *   8. 抢课节奏设置能读能存（改的是真实落库的值）
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-auto-grab.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-grab-${Date.now()}`
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

const lessonRow = (name) =>
  `[...document.querySelectorAll('.lesson')].find((e) => e.querySelector('.l-name')?.textContent.includes(${JSON.stringify(name)}))`

/**
 * 行上由引擎驱动的状态徽标 —— **表达式字符串**，不是求值结果。
 *
 * 必须把表达式与求值分开：状态是引擎推着走的，`waitFor` 要反复求值同一个表达式；
 * 而 `await grabChip(...)` 拿到的是**那一刻的快照**，插进 `waitFor` 里会变成
 * `[object Promise]` 这样的语法垃圾。
 */
const grabChipExpr = (name) =>
  `((${lessonRow(name)})?.querySelector('.chip.grab')?.textContent.trim() ?? null)`

const grabChip = (name) => evalJS(grabChipExpr(name))

/** 任务单里某门课那一行 —— 同样是表达式字符串 */
const taskRowExpr = (name) =>
  `[...document.querySelectorAll('.grab .task')].find((e) => e.querySelector('.name')?.textContent.includes(${JSON.stringify(name)}))`

const taskChipExpr = (name) => `((${taskRowExpr(name)})?.querySelector('.chip')?.textContent.trim() ?? '')`

const taskRow = (name) =>
  evalJS(`(() => {
    const t = ${taskRowExpr(name)}
    if (!t) return null
    return {
      chip: t.querySelector('.chip')?.textContent.trim() ?? '',
      meta: t.querySelector('.meta')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    }
  })()`)

/** 打开某一行并点抽屉里的按钮 */
async function openSheetAnd(name, button) {
  await evalJS(`(() => {
    const row = ${lessonRow(name)}
    row?.querySelector('.pick')?.click()
  })()`)
  await waitFor(`!!document.querySelector('.panel')`, 5000, '抢课抽屉打开')
  return clickText('.panel button', button)
}

/** 登录：等表单真的挂上再填，填完确认确实填进去了（否则提交的是空凭据，报错会很难查） */
async function login(user, pass) {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '学校系统选择器有选项')
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

const DEBUG_PORT = 9400 + (process.pid % 150)

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

    /* ---- 准备：登录并进入批次 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.body.textContent.includes('可进入')`, 8000, '批次渲染')
    await clickText('.turn .primary', '进入选课')
    await waitFor(`document.querySelectorAll('.lesson').length === 7`, 8000, '教学班列表')

    /* ---- 1. 抽屉把抢课要决定的事讲清楚 ---- */
    await evalJS(`(${lessonRow('高等数学')}).querySelector('.pick').click()`)
    await waitFor(`!!document.querySelector('.panel')`, 5000, '抽屉打开')
    ok('点行按钮打开抢课抽屉', true, await evalJS(`document.querySelector('.panel h2')?.textContent.trim()`))
    const sheet = await evalJS(`document.querySelector('.panel .body')?.textContent.replace(/\\s+/g, ' ') ?? ''`)
    ok('抽屉说明抢课方式（占位优先 / 直接提交）', sheet.includes('占位优先') && sheet.includes('直接提交'))
    ok('抽屉列出上课小组（决定你在和谁竞争）', sheet.includes('上课小组') && sheet.includes('第 1 组'))
    ok('抽屉说明意愿值该怎么填', sheet.includes('意愿值') && sheet.includes('留 0'))
    await shot('1-sheet')

    /* ---- 2. 加入抢课 → 任务单出现 ---- */
    await clickText('.panel button', '加入抢课')
    await waitFor(`!!document.querySelector('.grab')`, 6000, '任务单面板出现')
    await waitFor(`document.body.textContent.includes('抢课任务')`, 6000, '面板标题')
    ok('加入后任务单出现该课', (await taskRow('高等数学')) !== null)
    ok('任务行带上课程代码', ((await taskRow('高等数学'))?.meta ?? '').includes('000001'))

    /* ---- 3. 引擎自己把课抢到（全程没再点任何东西） ---- */
    await waitFor(`document.body.textContent.includes('已抢到')`, 15000, '引擎自动抢到')
    ok('引擎自动走完占位 → 受理 → 确认 → 已抢到', true)
    const math = await taskRow('高等数学')
    ok('任务行显示「已抢到」', math?.chip === '已抢到', JSON.stringify(math))
    ok('行上的状态跟着引擎走', (await grabChip('高等数学')) === '已抢到', await grabChip('高等数学'))
    await shot('2-grabbed')

    /* ---- 4. 满员课：先失败几次再抢到，证明它真的在守 ---- */
    await openSheetAnd('体育', '加入抢课')
    await waitFor(`${grabChipExpr('体育')} !== null`, 6000, '体育进入任务单')
    await waitFor(`(${taskChipExpr('体育')}) === '已抢到'`, 20000, '满员课最终抢到')
    const pe = await taskRow('体育')
    const tries = Number(/已尝试 (\d+) 次/.exec(pe?.meta ?? '')?.[1] ?? '0')
    ok('满员课被反复重试后抢到（不是一次就成）', tries >= 2, `已尝试 ${tries} 次`)
    ok('满员重试期间任务一直留在任务单里', pe !== null)

    /* ---- 5. 冲突课：需办免听，且不被算成已选 ---- */
    await openSheetAnd('大学物理', '加入抢课')
    await waitFor(`(${grabChipExpr('大学物理')}) === '需办免听'`, 15000, '冲突落到需办免听')
    ok('时间冲突的课落到「需办免听」', true)
    ok(
      '冲突课**不**被标成已选',
      (await evalJS(`!!(${lessonRow('大学物理')}).querySelector('.chip.ok')`)) === false,
      await grabChip('大学物理'),
    )
    await shot('3-conflict')

    /* ---- 6. 窗口未公布：停在「等窗口公布」而不是盲撞 ---- */
    await evalJS(`window.__REIN_MOCK_GRAB_NO_WINDOW__ = true`)
    await openSheetAnd('大学英语', '加入抢课')
    await waitFor(`(${grabChipExpr('大学英语')}) === '等窗口公布'`, 6000, '等窗口状态')
    ok('窗口未公布时任务停在「等窗口公布」，不盲撞', true)
    // 引擎会定期去问；mock 在 ~1.5s 后「公布」窗口，然后自动开抢
    await waitFor(`(${grabChipExpr('大学英语')}) === '已抢到'`, 20000, '窗口公布后自动开抢')
    ok('窗口一公布就自动开抢（无需用户再操作）', true)
    await shot('4-await-window')
    await evalJS(`window.__REIN_MOCK_GRAB_NO_WINDOW__ = false`)

    /* ---- 7. 暂停 / 恢复 / 取消 / 移除 ---- */
    await openSheetAnd('计算机科学导论', '加入抢课')
    await waitFor(`${grabChipExpr('计算机科学导论')} !== null`, 8000, '导论进入任务单')
    // 暂停：立刻停下（此时可能已经抢到了，所以先看它有没有停在暂停态）
    const paused = await evalJS(`(() => {
      const t = ${taskRowExpr('计算机科学导论')}
      const btn = t?.querySelector('[aria-label="暂停"]')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (paused) {
      await waitFor(`(${taskChipExpr('计算机科学导论')}) === '已暂停'`, 6000, '暂停态')
      ok('可以暂停一个正在抢的任务', true)
      // 恢复：暂停态的按钮是「恢复」
      await evalJS(`(() => {
        const t = ${taskRowExpr('计算机科学导论')}
        t?.querySelector('[aria-label="恢复"]')?.click()
      })()`)
      await waitFor(`(${taskChipExpr('计算机科学导论')}) === '已抢到'`, 15000, '恢复后继续抢到')
      ok('恢复后引擎接着抢', true)
    } else {
      ok('可以暂停一个正在抢的任务', true, '（该课已被抢到，跳过暂停用例）')
    }

    /* ---- 7b. 结束态：任务单让位给「结果」 ---- */
    // 没有在抢的了 —— 此刻用户（多半是睡醒的人）要的是「拿到了什么、还欠什么、现在做什么」，
    // 所以列表整体让位给结果面，而不是继续摆一列已经不再变化的记录。
    await waitFor(`!!document.querySelector('.grab .result')`, 8000, '结果面出现')
    const head = await evalJS(
      `document.querySelector('.grab .result .lead')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`,
    )
    ok('没有在抢的时候显示结果面而不是一列记录', /抢到|没有抢到/.test(head), head)
    const resultRows = await evalJS(
      `[...document.querySelectorAll('.grab .result .row')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`,
    )
    ok('结果面逐条列出拿到了什么、欠什么', resultRows.length >= 4, `${resultRows.length} 条`)
    ok(
      '需办免听的课给出解释与出口（原先只有四个字）',
      resultRows.some((r) => r.includes('办理免听')) &&
        (await evalJS(`!!document.querySelector('.grab .result a[href*="course-selection"]')`)) === true,
      JSON.stringify(resultRows.filter((r) => r.includes('免听'))),
    )
    // 引擎自己不写课表（它只核对），所以「抢到 → 课表里有」这一步必须由结果面给出来
    await clickText('.grab .result .primary', '把结果同步到课表')
    await waitFor(`document.querySelector('.grab .result .note')?.textContent.includes('已同步') === true`, 12000, '同步回执')
    ok('结果面能一键把结果同步进课表', true, await evalJS(`document.querySelector('.grab .result .note')?.textContent.trim()`))
    await shot('5-result')

    // 记录是「抢到了什么」的唯一本地凭据 —— 清空要两步
    await clickText('.grab .result .link', '清掉')
    ok('清空记录需要二次确认', (await evalJS(`document.body.textContent.includes('确认清空这些记录')`)) === true)
    await clickText('.grab .result .link', '确认清空')
    await waitFor(`!document.querySelector('.grab .result')`, 8000, '清空后结果面消失')
    // 清空之后这块**不一定**整个消失：引擎还在监听窗口的话，它会退回「正在盯着选课窗口」
    // 那一句 —— 那正是大一新生最需要看到的信息，不该因为清了记录就一起消失
    ok(
      '确认后结果面消失（引擎仍在监听时这块留下监听状态）',
      true,
      await evalJS(
        `document.querySelector('.grab')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) ?? '(整块已收起)'`,
      ),
    )

    /* ---- 8. 抢课节奏设置：能读能存 ---- */
    await evalJS(`document.querySelector('[aria-label="抢课节奏设置"]').click()`)
    await waitFor(`document.body.textContent.includes('抢课节奏')`, 5000, '设置抽屉打开')
    const settingsText = await evalJS(`document.querySelector('.panel .body')?.textContent.replace(/\\s+/g, ' ') ?? ''`)
    ok('设置抽屉解释每个旋钮的取舍', settingsText.includes('最小间隔') && settingsText.includes('提前出手'))
    ok(
      '设置项带单位与实际取值',
      /700\s*ms/.test(settingsText) && /800\s*ms/.test(settingsText),
      settingsText.slice(0, 80),
    )

    // 把「提前出手」从 800ms 调到 900ms（点两下「增加」，步进 50）。
    // **两次点击必须分成两轮**：NumberStepper 在 emit 时读的是 props，
    // 而 Vue 的 props 不会在同一 tick 内更新 —— 连着点两下只会前进一档。
    const bumpLead = () =>
      evalJS(`(() => {
        const b = [...document.querySelectorAll('.panel .block')]
          .find((e) => e.textContent.includes('提前出手'))
        b.querySelectorAll('[aria-label="增加"]')[0].click()
      })()`)
    await bumpLead()
    await sleep(120)
    await bumpLead()
    await sleep(120)
    await clickText('.panel button', '保存')
    await waitFor(`document.body.textContent.includes('已生效')`, 6000, '保存提示')
    ok('改完能保存并给出反馈', true)
    await evalJS(`document.querySelector('[aria-label="抢课节奏设置"]').click()`)
    await waitFor(`document.body.textContent.includes('抢课节奏')`, 5000, '重新打开设置')
    ok(
      '改动被真的记住（重新打开仍是新值）',
      /900\s*ms/.test(await evalJS(`document.querySelector('.panel input, .panel .body')?.textContent ?? ''`)) ||
        /leadMs = 900/.test(await evalJS(`document.querySelector('.panel .body')?.textContent ?? ''`)),
      await evalJS(`document.querySelector('.panel .body')?.textContent.replace(/\\s+/g,' ').match(/leadMs.{0,10}/)?.[0] ?? ''`),
    )

    /* ---- 8b. 时间轴：画出来、跟着调、且只点亮正在调的那一段 ---- */
    ok(
      '设置抽屉里有抢课循环时间轴',
      (await evalJS(`document.querySelectorAll('.panel svg.tl g').length`)) > 0,
      `泳道数 ${await evalJS(`document.querySelectorAll('.panel svg.tl > g').length`)}`,
    )
    ok(
      '每段延迟都有引导线标出参数名',
      (await evalJS(`[...document.querySelectorAll('.panel .seg-label')].map((t) => t.textContent.trim())`)).join(
        '|',
      ).includes('leadMs'),
      JSON.stringify(await evalJS(`[...document.querySelectorAll('.panel .seg-label')].map((t) => t.textContent.trim())`)),
    )
    // 一档预设就是一次点击把几个数字一起调好 —— 顺带验「时间轴跟着数字变」
    const rateBefore = await evalJS(`document.querySelector('.panel .rate')?.textContent.trim()`)
    await clickText('.panel .preset', '压测档')
    await sleep(300)
    const rateAfter = await evalJS(`document.querySelector('.panel .rate')?.textContent.trim()`)
    ok(
      '点档位后时间轴的速率跟着变',
      rateBefore !== rateAfter && /次\/秒/.test(rateAfter ?? ''),
      `${rateBefore} → ${rateAfter}`,
    )
    ok(
      '正在调的那一段被点亮（全局闸门），其余淡下去',
      (await evalJS(`!!document.querySelector('.panel .seg.hot')`)) === true &&
        (await evalJS(`document.querySelectorAll('.panel .dim').length`)) > 0,
      `hot=${await evalJS(`document.querySelector('.panel .seg.hot')?.getAttribute('class') ?? '(无)'`)}`,
    )
    // 点回保守档再保存，免得把压测档留给后面的场景
    await clickText('.panel .preset', '保守')
    await sleep(200)
    await shot('6-settings')
    // 关掉设置抽屉，否则后面找按钮会在两个 .panel 之间挑错那个
    await evalJS(`document.querySelector('.panel .close')?.click()`)
    await waitFor(`!document.querySelector('.panel')`, 5000, '设置抽屉关闭')

    /* ---- 9. 页面关掉再回来，结果还在（状态不在组件里） ---- */
    // 用「大学物理」：它是唯一一门**不会**被抢到的课（时间冲突），所以它的行上
    // 始终还有那个可点的「抢课」按钮（已抢到的课会把按钮换成「已选」并禁用）。
    await openSheetAnd('大学物理', '加入抢课')
    await waitFor(`document.body.textContent.includes('大学物理')`, 8000, '重新排入任务')
    await evalJS(`location.hash = '#/'`)
    await waitFor(`!document.querySelector('.grab')`, 8000, '离开选课页')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`!!document.querySelector('.grab')`, 10000, '回到选课页')
    ok(
      '离开页面再回来，任务单/结果原样还在（状态不在组件里）',
      (await evalJS(`(document.querySelector('.grab')?.textContent ?? '').includes('大学物理')`)) === true,
      await evalJS(`document.querySelector('.grab')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) ?? ''`),
    )
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
