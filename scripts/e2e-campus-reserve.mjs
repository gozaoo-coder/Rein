/**
 * e2e-campus-reserve —— 培养方案 + 预约（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 这条链路要证明的是「**用户还没开口问细节之前，AI 就能把该修什么、该选什么、什么时候开抢说清楚**」：
 *
 *   1. **培养方案读得全**：学分要求 / 已修 / 缺多少、模块学分树、上百门课程清单都能按面取到；
 *      课程清单里搜不到 = 不在你方案里 —— 这正是「教学条件组」那道门槛的前置判据。
 *   2. **和本批次逐门对照**：哪些方案内的课本批次开了（开了几个班、还剩几个有余量、你选上几个）、
 *      哪些是本批次有但不在方案里的（别碰）、哪些方案课这学期压根没开。
 *   3. **预约单先出、落库在后**：dryRun 默认只给「会抢哪些班 + 还剩多少 + 在不在方案里」，
 *      用户点头后才真排；批次还没公布时预约照样能落，引擎自己等窗口。
 *   4. **落库之后不用管**：引擎自己解析成志愿任务、自己守着名额抢 —— 这一条由 mock 引擎在环里跑完。
 *
 * 模型不在环里：无头浏览器没有真模型可调，而这条链上真正会坏的是**参数形状、命令名与投影口径**，
 * 不是模型的措辞。所以工具层用 `window.__REIN_TOOL__` 直调（dev 专用钩子，见 registry.ts）。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-campus-reserve.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-reserve-${Date.now()}`
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

/** 直调工具（dev 钩子）：返回结果，形状与模型看到的完全一致 */
const callTool = (name, args) =>
  evalJS(`window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})`)

/** 轮询式调工具：抢课引擎在后台推进，状态要等它走到 */
async function waitTool(name, args, predicate, timeoutMs = 15000, label = name) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await callTool(name, args)
    if (predicate(last)) return last
    await sleep(300)
  }
  throw new Error(`等待超时: ${label}（最后一次：${JSON.stringify(last).slice(0, 3000)}）`)
}

const setHook = (name, value) => evalJS(`globalThis.${name} = ${JSON.stringify(value)}`)

async function login(user, pass) {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '学校系统选择器有选项')
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

    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 8000, '回到选课页')

    /* ---- 1. 培养方案：档案 + 学分缺口 ---- */
    const overview = await callTool('campus_program', {})
    ok(
      '培养方案读到了档案（专业 / 年级）',
      overview?.profile?.major === '智能科学与技术' && overview?.profile?.grade === '2026',
      JSON.stringify(overview?.profile),
    )
    ok(
      '学分：要求 162 / 已修 18.75 / 还差 143.25',
      overview?.credits?.required === 162 &&
        overview?.credits?.earned === 18.75 &&
        overview?.credits?.missing === 143.25,
      JSON.stringify(overview?.credits),
    )
    ok(
      '顶层模块列出来了（问「该修哪几类」不必再翻页）',
      Array.isArray(overview?.topModules) && overview.topModules.includes('通识必修课程'),
      JSON.stringify(overview?.topModules),
    )

    /* ---- 2. 模块学分树 ---- */
    const modules = await callTool('campus_program', { view: 'modules' })
    const depths = new Set((modules?.rows ?? []).map((r) => r.depth))
    ok(
      '模块树带层级（一级模块 0、二级模块 1）',
      depths.has(0) && depths.has(1),
      `depth=${[...depths].join(',')}`,
    )
    ok(
      '学分逐级挂在它自己那一层（课程性质 + 学分 + 学时）',
      (modules?.rows ?? []).some((r) => (r.credits ?? []).some((c) => /学分 \/ \d+ 学时/.test(c))),
      JSON.stringify(modules?.rows?.slice(0, 2)),
    )
    ok('明确告诉模型「不做跨层求和」', String(modules?.tip ?? '').includes('跨层求和'))

    /* ---- 3. 课程清单：搜得到 = 在方案里 ---- */
    const found = await callTool('campus_program', { view: 'courses', query: '高等数学' })
    ok(
      '课程清单能按课名搜（带回课程代码）',
      found?.matched === 1 && found?.courses?.[0]?.code === '000001',
      JSON.stringify(found?.courses),
    )
    const notFound = await callTool('campus_program', { view: 'courses', query: '量子力学' })
    ok(
      '搜不到 = 不在方案里，并提示教学条件组会拒选',
      notFound?.matched === 0 && String(notFound?.tip ?? '').includes('教学条件组'),
      String(notFound?.tip ?? ''),
    )

    /* ---- 4. 与培养方案逐门对照 ---- */
    const cross = await callTool('campus_program', { view: 'crosscheck' })
    ok(
      '核对挂在当前批次上（带去重后的教学班数）',
      cross?.window?.turn === '77' && cross?.counts?.lessons === 7,
      JSON.stringify({ window: cross?.window, counts: cross?.counts }),
    )
    const insideNames = (cross?.inProgram ?? []).map((r) => r.course)
    ok(
      '方案内、本批次有开的课被标出来（含余额与已选状态）',
      insideNames.includes('高等数学（上）') && insideNames.includes('体育（一）'),
      JSON.stringify(insideNames),
    )
    const outsideNames = (cross?.outsideProgram ?? []).map((r) => r.course)
    ok(
      '本批次有、但不在方案里的课单独列出（教学条件组外，别排）',
      outsideNames.includes('线性代数') && outsideNames.includes('计算机科学导论'),
      JSON.stringify(outsideNames),
    )
    ok(
      '方案里有、这学期没开的课如实说明（属正常，不是异常）',
      cross?.counts?.notOffered === 2 &&
        (cross?.notOfferedSample ?? []).includes('数据结构与算法') &&
        String(cross?.tip ?? '').includes('正常'),
      JSON.stringify(cross?.notOfferedSample),
    )
    ok(
      '已选上的教学班数被数出来（pickedSections）',
      (cross?.inProgram ?? []).every((r) => typeof r.pickedSections === 'number'),
      JSON.stringify(cross?.inProgram?.[0]),
    )
    await evalJS(`location.hash = '#/campus/program'`)
    await sleep(600)
    await shot('1-program')

    /* ---- 5. 预约单（dryRun 默认）：先摆事实，不落库 ---- */
    const dry = await callTool('campus_reserve', { queries: ['高数 张', '大学英语'] })
    ok('dryRun 默认不落库', dry?.dryRun === true)
    const mathPick = dry?.items?.[0]?.picks?.[0]
    ok(
      '「高数 张」的预约单：命中张伟的班、满员如实说、判据带出来',
      mathPick?.course === '高等数学（上）' &&
        mathPick?.teacher === '张伟' &&
        mathPick?.seatsLeft === 0 &&
        Array.isArray(mathPick?.why),
      JSON.stringify(mathPick),
    )
    ok(
      '每个班都标了「在不在我的培养方案里」（按课程代码认的）',
      mathPick?.inProgram?.by === 'code',
      JSON.stringify(mathPick?.inProgram),
    )
    const engPick = dry?.items?.[1]?.picks?.[0]
    ok(
      '余量按「上限 − 已选」算出来（大学英语 56/60 → 剩 4）',
      engPick?.course === '大学英语（一）' && engPick?.seatsLeft === 4,
      JSON.stringify(engPick),
    )
    ok(
      '窗口状态摆在同一张单子里（现在开着就直说）',
      dry?.window?.openNow === true && String(dry?.window?.note ?? '').includes('窗口正开着'),
      JSON.stringify(dry?.window),
    )
    ok(
      '收尾明确要求「念给用户核对、拿到同意再落库」',
      String(dry?.next ?? '').includes('同意'),
      String(dry?.next ?? ''),
    )

    const risky = await callTool('campus_reserve', { queries: ['计算机科学导论'] })
    ok(
      '不在培养方案里的课，预约单上就是 false（提前拦住，而不是等教务驳回）',
      risky?.items?.[0]?.picks?.[0]?.inProgram === false,
      JSON.stringify(risky?.items?.[0]?.picks?.[0]),
    )

    const audited = await callTool('campus_status', { probe: false })
    ok(
      '查看培养方案与预约单不会写审计（dryRun 不落库就什么都不该留下）',
      !(audited?.recentActions ?? []).some((a) => String(a.summary ?? '').includes('预约了')),
      JSON.stringify((audited?.recentActions ?? []).map((a) => a.summary).slice(0, 3)),
    )

    /* ---- 6. 批次还没公布：预约照样能落库，只是先等着 ---- */
    await setHook('__REIN_MOCK_NO_SELECT_TURN__', true)
    const early = await callTool('campus_reserve', { queries: ['体育'] })
    ok(
      '批次没公布：预览如实报「查不到名单」而不是报错崩掉',
      !!early?.items?.[0]?.error,
      String(early?.items?.[0]?.error ?? ''),
    )
    ok(
      '并说清「不影响预约，引擎每分钟看一次窗口」',
      String(early?.items?.[0]?.hint ?? '').includes('每分钟') &&
        String(early?.window?.note ?? '').includes('不影响预约'),
      String(early?.window?.note ?? ''),
    )
    await setHook('__REIN_MOCK_NO_SELECT_TURN__', false)

    /* ---- 7. 落库：预约之后不用再管 ---- */
    const committed = await callTool('campus_reserve', { queries: ['体育'], dryRun: false })
    ok(
      'dryRun:false 才真的落库（返回计划 id）',
      committed?.dryRun === false && (committed?.reserved?.[0]?.id ?? 0) > 0,
      JSON.stringify(committed?.reserved),
    )
    ok(
      '落库回执讲清了「引擎接下来会做什么」',
      String(committed?.message ?? '').includes('窗口一开'),
      String(committed?.message ?? ''),
    )

    const parsed = await waitTool(
      'campus_status',
      { probe: false },
      // 工具给模型的投影里 groupKeys 叫 groups（见 campus.ts::intentDigest）
      (s) => (s?.intents ?? []).some((i) => i.query === '体育' && (i.groups ?? []).length > 0),
      20000,
      '引擎把计划解析成志愿任务',
    )
    ok(
      '引擎自己把计划解析成了志愿任务（候选教学班列出来了）',
      true,
      JSON.stringify((parsed?.intents ?? []).find((i) => i.query === '体育')?.candidates ?? []),
    )
    ok(
      '落库留了审计（写操作不弹确认，靠事后可查兜底）',
      (parsed?.recentActions ?? []).some((a) => String(a.summary ?? '').includes('预约了 1 门课')),
      JSON.stringify((parsed?.recentActions ?? []).map((a) => a.summary).slice(0, 4)),
    )

    const grabbed = await waitTool(
      'campus_status',
      // 已结束的任务默认不列出来（省上下文），要断言「抢到了」就得把它们带上
      { probe: false, includeFinished: true },
      (s) => (s?.tasks ?? []).some((t) => t.course === '体育（一）' && t.status === 'success'),
      25000,
      '预约的那门课被引擎抢到',
    )
    ok(
      '全程没有再操作：预约的课自己走到了「已抢到」',
      true,
      (grabbed?.tasks ?? []).find((t) => t.course === '体育（一）')?.status,
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
