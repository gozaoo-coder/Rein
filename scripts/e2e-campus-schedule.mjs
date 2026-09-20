/**
 * e2e-campus-schedule —— 校园课表 UI 端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：课表页有一半价值在交互与布局上——双向冻结窗格、双轴滚动、
 * 左列「实际上课时间」、日/周/月切换、未登录空态。这些只有真渲染出来才验证得了，
 * 单测（Rust 侧 22 个）覆盖不到。同时它也是回归网：周视图的行列绑定一旦错位，
 * 「某天某节有课」的断言会立刻红。
 *
 * 剧本：
 *   1. 未登录 → 课表页显示空态与「去配置」出口
 *   2. 配置页选学校系统 → 填学号密码 → 登录（mock 会自动顺带同步课表）
 *   3. 回到课表页 → 周视图：7 列表头带日期、左列是实际上课时间、课程块落在正确的格子里
 *   4. 冻结窗格生效（表头 sticky top / 时间列 sticky left / 左上角两者兼具）
 *   5. 切日视图、月视图各自渲染
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-campus-schedule.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-campus-${Date.now()}`
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
    await connect(`${APP}/#/campus/schedule`)

    /* ---- 1. 未登录空态 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '我的课表'`, 12000, '课表页挂载')
    await waitFor(`document.body.textContent.includes('还没有课表数据')`, 6000, '未登录空态')
    ok('未登录时显示空态', true)
    ok(
      '空态提供「去配置」出口',
      await evalJS(`!!document.body.textContent.includes('去配置')`),
    )
    await shot('1-empty')

    /* ---- 2. 走配置页登录 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 8000, '配置页挂载')
    await waitFor(`document.querySelectorAll('.sys').length >= 1`, 6000, '学校系统选择器有选项')
    ok('学校系统选择器渲染出在册学校', true, await evalJS(`document.querySelector('.sys-name')?.textContent`))

    await setInput('input[autocomplete="username"]', '2600350118')
    await setInput('input[autocomplete="current-password"]', 'demo1234')
    await clickText('button', '登录')

    await waitFor(`document.body.textContent.includes('已登录')`, 12000, '登录成功')
    await waitFor(`document.body.textContent.includes('演示同学')`, 6000, '账号档案回显')
    ok('登录后回显学生档案', true, await evalJS(`document.querySelector('.who-name')?.textContent.trim()`))
    // 登录会顺带同步一次课表
    await waitFor(`document.body.textContent.includes('上次同步')`, 12000, '同步回执')
    ok('登录后自动同步课表', true, await evalJS(`document.querySelector('.tip')?.textContent.trim()`))
    await shot('2-settings')

    /* ---- 3. 周视图 ---- */
    await evalJS(`location.hash = '#/campus/schedule'`)
    await waitFor(`document.querySelectorAll('.grid .cell.head.day').length === 7`, 12000, '周视图 7 列表头')
    ok('周视图渲染 7 个日期表头', true)

    const headers = await evalJS(
      `[...document.querySelectorAll('.cell.head.day')].map((e) => ({
        dow: e.querySelector('.dow')?.textContent.trim(),
        dnum: e.querySelector('.dnum')?.textContent.trim(),
      }))`,
    )
    ok(
      '表头是「星期几 + 具体日期」',
      headers.length === 7 && /^周[一二三四五六日]$/.test(headers[0].dow) && /^\d+\/\d+$/.test(headers[0].dnum),
      headers.map((h) => `${h.dow}${h.dnum}`).join(' '),
    )

    const times = await evalJS(
      `[...document.querySelectorAll('.cell.time')].map((e) => e.querySelector('.t1')?.textContent.trim())`,
    )
    ok(
      '左侧列显示实际上课时间（不是「第 N 节」）',
      times.length > 0 && times.every((t) => /^\d{2}:\d{2}$/.test(t)),
      times.join(' '),
    )
    ok(
      '左侧列同时标注节次区间',
      await evalJS(`!!document.querySelector('.cell.time .unit')?.textContent.includes('节')`),
      await evalJS(`document.querySelector('.cell.time .unit')?.textContent.trim()`),
    )

    const blocks = await evalJS(`document.querySelectorAll('.grid .blk').length`)
    ok('课程块已渲染', blocks > 0, `${blocks} 块`)

    // 初始横向位置必须落在列边界上，否则左边会露出半截列（看起来像渲染坏了）。
    // **直接验这件事本身**：冻结的时刻列右侧就是可见区左缘，不许有任何列横跨它 ——
    // 用 scrollLeft 去除以列宽那种算法要额外假设冻结列是否计入滚动量，一路算错两回（8px → 26px），
    // 而「有没有半截列」本来就能一眼量出来。
    const align = await evalJS(`(() => {
      const wrap = document.querySelector('.wrap')
      const wr = wrap.getBoundingClientRect()
      const timeW = document.querySelector('.cell.time').getBoundingClientRect().width
      const left = wr.left + timeW
      const cols = [...document.querySelectorAll('.cell.head.day')].map((c) => c.getBoundingClientRect())
      // 横跨左缘 = 被切了一半
      const straddling = cols.filter((c) => c.left < left - 0.5 && c.right > left + 0.5).length
      return { scrollLeft: wrap.scrollLeft, timeW, straddling, offsets: cols.map((c) => Math.round(c.left - left)) }
    })()`)
    ok(
      '初始横向滚动对齐到列边界（左缘不出现半截列）',
      align.straddling === 0,
      `scrollLeft=${align.scrollLeft.toFixed(1)} 时刻列宽=${align.timeW.toFixed(0)} 半截列=${align.straddling} 各列偏移=${JSON.stringify(align.offsets)}`,
    )

    /* ---- 4. 冻结窗格 ---- */
    const frozen = await evalJS(`(() => {
      const g = getComputedStyle
      const head = document.querySelector('.cell.head.day')
      const time = document.querySelector('.cell.time')
      const corner = document.querySelector('.cell.head.corner')
      const wrap = document.querySelector('.wrap')
      return {
        head: g(head).position, headTop: g(head).top,
        time: g(time).position, timeLeft: g(time).left,
        corner: g(corner).position,
        overflow: g(wrap).overflow,
        overscroll: g(wrap).overscrollBehaviorX,
        touchAction: g(wrap).touchAction,
        height: parseFloat(g(wrap).height),
        viewportH: window.innerHeight,
      }
    })()`)
    ok('表头冻结（sticky top）', frozen.head === 'sticky' && frozen.headTop === '0px', JSON.stringify(frozen))
    ok('时间列冻结（sticky left）', frozen.time === 'sticky' && frozen.timeLeft === '0px')
    ok('左上角双向冻结', frozen.corner === 'sticky')
    ok('单一容器承担双轴滚动', frozen.overflow === 'auto')
    ok('滚动不穿透（overscroll-behavior: contain）', frozen.overscroll === 'contain')
    ok('允许双轴触摸手势', frozen.touchAction.includes('pan-x') && frozen.touchAction.includes('pan-y'))
    ok(
      '容器定高且不超出视口（节次变多时才真正滚动）',
      frozen.height > 0 && frozen.height < frozen.viewportH,
      `height=${frozen.height} viewport=${frozen.viewportH}`,
    )

    // 节次少时课表应铺满容器（和纸质课表一样）。**这条与视口高度有关**：容器矮于内容时
    // （小屏 / 远程桌面窗口被压扁）铺满本就无从谈起，此时该验的是「照常可滚动」而不是压扁课表。
    const scrollProof = await evalJS(`(async () => {
      const wrap = document.querySelector('.wrap')
      const grid = document.querySelector('.grid')
      const m = {
        wrapH: wrap.clientHeight,
        contentH: wrap.scrollHeight,
        gridH: grid.offsetHeight,
        viewportH: window.innerHeight,
        fits: grid.offsetHeight <= wrap.clientHeight + 1,
        scrollable: wrap.scrollHeight > wrap.clientHeight,
      }
      m.fills = Math.abs(grid.offsetHeight - wrap.clientHeight) <= 1
      wrap.style.height = '120px'
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      m.shrunkOverflow = wrap.scrollHeight > wrap.clientHeight
      wrap.scrollTop = 40
      m.canScroll = wrap.scrollTop > 0
      m.afterShrinkH = wrap.clientHeight
      wrap.scrollTop = 0
      wrap.style.height = ''
      return m
    })()`)
    ok(
      scrollProof.fits ? '节次少时课表铺满容器高度' : '容器矮于内容时课表按滚动处理（不压扁）',
      scrollProof.fits ? scrollProof.fills === true : scrollProof.scrollable === true,
      `grid=${scrollProof.gridH} wrap=${scrollProof.wrapH} viewport=${scrollProof.viewportH}`,
    )
    ok('内容变高后容器可纵向滚动', scrollProof.shrunkOverflow === true && scrollProof.canScroll === true,
      `压矮后 clientHeight=${scrollProof.afterShrinkH} 可滚动=${scrollProof.canScroll}`)
    await shot('3-week')

    /* ---- 5. 日 / 月视图 ---- */
    // 周视图里「今天」那列有几块，日视图就该有几节。切视图会异步重载当天区间，
    // 在重载回来之前 store 里仍是上一段的数据——这里正是为了钉住那次串台。
    const todayBlocks = await evalJS(`document.querySelectorAll('.cell.slot.today .blk').length`)
    // 这一段真正要钉的是「周视图今天列的块数 == 日视图的行数」（换视图时不与相邻日期串台）。
    // 「今天列必须有课」只是个前提，而周末的演示数据本来就没有课 —— 周中仍严格要它成立。
    const dow = new Date().getDay()
    if (todayBlocks > 0) {
      ok('周视图今天列有课', true, `${todayBlocks} 节`)
    } else {
      ok('周视图今天列有课（周末演示数据无课，仅校验视图一致）', dow === 0 || dow === 6, `今天 周${'日一二三四五六'[dow]}，${todayBlocks} 节`)
    }

    await clickText('.seg-item', '日')
    await waitFor(
      `document.querySelectorAll('.day .row').length === ${todayBlocks}`,
      8000,
      '日视图收敛到当天',
    )
    ok('日视图只显示当天课程（不与相邻日期串台）', true, `${todayBlocks} 节`)
    const dayTimes = await evalJS(`[...document.querySelectorAll('.row .rail .t1')].map((e) => e.textContent.trim())`)
    ok(
      '日视图按上课时间升序',
      dayTimes.join() === [...dayTimes].sort().join(),
      dayTimes.join(' '),
    )
    await shot('4-day')

    await clickText('.seg-item', '月')
    await waitFor(`document.querySelectorAll('.month .cell').length >= 28`, 6000, '月视图渲染')
    const monthCells = await evalJS(`document.querySelectorAll('.month .cell:not(.blank)').length`)
    ok('月视图渲染整月日期格', monthCells >= 28, `${monthCells} 格`)
    await shot('5-month')

    // 点某天应切回日视图
    await evalJS(`document.querySelector('.month .cell:not(.blank)')?.click()`)
    await waitFor(`document.querySelector('.day')`, 6000, '点日期切到日视图')
    ok('月视图点日期切到日视图', true)
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
