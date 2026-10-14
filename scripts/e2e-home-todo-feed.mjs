/**
 * 主页「全部待办」信息流（HomeTodoFeed / query_todo_feed）端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-home-todo-feed.mjs                    （前置：npm run dev 已在 1420 上）
 *      node scripts/e2e-run.mjs scripts/e2e-home-todo-feed.mjs （1420 被系统排除时用这个）
 * 端口/地址约定同其它套件：E2E_CDP_PORT ?? 9333、REIN_E2E_URL ?? http://localhost:1420。
 *
 * 四阶段，一个常驻注入脚本 + localStorage['rein.e2e.todoFeedPhase'] 切换：
 *   A ''      默认演示数据 —— 短清单「整页装得下就一次挂完」的护栏（与 e2e-rubber-scroll 的底边断言共存）
 *   B 'bulk'  批量种子 296 条 —— 首屏只挂一批 → 滚动逐批追加 → 到底态 → 全量分组顺序 →
 *             勾选就地生效 → 重进主页已沉底收敛
 *   C 'empty' 空库 —— empty 态与「去待办页新建」入口
 *   D 'fail'  取数失败 —— error 态 → 关掉 mock 开关 → 点此重试 → 与首屏同一条挂载规则一次挂完
 *
 * 阶段切换**一律 Page.reload，不用同 URL 的 Page.navigate**：同 URL 导航不重建文档
 * （常驻注入脚本不重跑、mock 的模块级种子也不重新播种），reload 才会。切完读注入脚本在
 * 每个新文档里写的随机 token window.__e2eDoc，确认文档真的换代了再往下走。
 *
 * 断言只认 data-*（data-testid / data-rendered / data-total / data-state / data-group /
 * data-date / data-done / data-todo-id）；三处产品文案（「已全部载入」「还没有待办」「点此重试」）
 * 只在方案点名的地方读，读到的原文一并打进 detail 便于诊断。
 *
 * mock 侧的三个开关，全在 src/mock/server.ts（默认一个都不设时行为与从前逐字节一致）：
 *   localStorage['rein.e2e.todoFeedBulk'] === '1' → seedTodoFeedBulk() 追加 296 条种子
 *   window.__REIN_MOCK_TODO_EMPTY__      = true   → 清空全部待办（连重复模板一起，total 真是 0）
 *   window.__REIN_MOCK_TODO_FEED_FAIL__  = true   → query_todo_feed 抛错（本脚本在 retry 前 delete 掉它）
 *
 * 截帧：$TEMP/rein-e2e-home-todo-feed/*.png
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9333)
/** 目标应用地址：默认 1420；端口被系统排除或并发会话时用 REIN_E2E_URL 指向独立实例（与 e2e-cdp 同约定） */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-home-feed-${Date.now()}`
const SHOT_DIR = `${process.env.TEMP}/rein-e2e-home-todo-feed`

/** 移动端视口：406 < DESKTOP_MIN(1100) ⇒ HomePage 走移动端分支，页脚之后的 HomeTodoFeed 才挂得上 */
const VIEW = { width: 406, height: 904 }

/** 与 HomeTodoFeed.vue 的两个常量同步（组件里改了这里也要改，断言依赖它们） */
const FEED_PAGE = 30
const FEED_BATCH = 10

/* 选择器一律走 data-testid + data-*（不匹配文案、不依赖类名） */
const FEED = '[data-testid="home-todo-feed"]'
const ROW = '[data-testid="todo-feed-row"]'
const GROUP = '[data-testid="todo-feed-group"]'
const END = '[data-testid="todo-feed-end"]'
const CHECK = '[data-testid="todo-feed-check"]'
/** data-state 挂在底部小结元素上（定稿方案）；实现若把它挪到根节点，这里也读得到 */
const STATE = `(document.querySelector('${END}')?.dataset.state ?? document.querySelector('${FEED}')?.dataset.state ?? '')`

const results = []
let ws
let msgId = 0
const pending = new Map()
let shotIdx = 0

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 轮询到条件为真，返回耗时 ms；超时返回 -1（不抛，交给断言判，红的时候能多打几条） */
async function timeTo(expr, timeoutMs = 1000, stepMs = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return Date.now() - t0
    await sleep(stepMs)
  }
  return -1
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOT_DIR}/${String(++shotIdx).padStart(2, '0')}-${name}.png`, Buffer.from(r.data, 'base64'))
}

/** 本机时区的今天（与页面 todayStr() 同款算法；浏览器与脚本同机同区，可直接比对 ISO 日期串） */
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 常驻注入脚本（**只装一次，先于第一次导航**）：每个新文档都要跑的四件事 ——
 *   1 种今天的仪式 key（否则每日规划仪式会盖住主页）；
 *   2 按 localStorage['rein.e2e.todoFeedPhase'] 推导本阶段的 mock 开关（关的显式清掉，免得跨阶段残留）；
 *   3 装 __errs 收集器（uncaught / unhandledrejection / console.error）；
 *   4 写随机文档 token：Page.reload 之后靠它判定文档真的换代了。
 */
const INJECTED = `(() => {
  try {
    const d = new Date();
    const t = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    localStorage.setItem('rein.ritual.' + t, '1');
    const phase = localStorage.getItem('rein.e2e.todoFeedPhase') || '';
    if (phase === 'bulk') localStorage.setItem('rein.e2e.todoFeedBulk', '1');
    else localStorage.removeItem('rein.e2e.todoFeedBulk');
    if (phase === 'empty') window.__REIN_MOCK_TODO_EMPTY__ = true;
    if (phase === 'fail') window.__REIN_MOCK_TODO_FEED_FAIL__ = true;
  } catch { /* about:blank 上不可用 */ }
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));
  const ce = console.error.bind(console);
  console.error = (...a) => { window.__errs.push('console.error: ' + a.map(String).join(' ')); ce(...a) };
  window.__e2eDoc = String(Math.random()).slice(2);
})()`

async function connect() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Page.screencastFrame') {
      // 每帧都要 ack，否则 Chromium 停发后续帧；帧一停，IntersectionObserver 的投递也会停，
      // 而「滚动 → 逐批追加」整段就靠它（这是本套件最容易假红的一处）
      cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => undefined)
      return
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  // 无头渲染器按需出帧，而信息流的触发源是 IntersectionObserver（在帧生命周期里投递）——
  // 持续截屏强制合成器连续出帧（与 e2e-cdp.mjs 的做法同源）；这里把帧缩到 160px、
  // 每 5 帧取一张，只为保帧率不占带宽（帧内容一概不看）。
  await cdp('Page.startScreencast', {
    format: 'jpeg', quality: 30, maxWidth: 160, maxHeight: 160, everyNthFrame: 5,
  }).catch(() => undefined)
  // 本套件唯一的常驻注入脚本：先于第一次导航装上，之后每个新文档都会重跑
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INJECTED })
  // **必须显式设视口**（headless 下 --window-size 给到的 innerWidth 不作数），再导航
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: true,
  })
  await cdp('Page.navigate', { url: `${APP}/#/` })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

/** 写阶段开关（mock 的三个开关都由注入脚本按这一个 key 推导） */
async function setPhase(phase) {
  await evalJS(`localStorage.setItem('rein.e2e.todoFeedPhase', ${JSON.stringify(phase)}); true`)
}

/**
 * 重载拿新文档。**不用同 URL 的 Page.navigate**：实测不重建文档 —— 注入脚本不重跑、
 * mock 的模块级种子也不重新播种（见 scripts/e2e-cdp.mjs 的 Page.reload 先例）。
 * 判定换代靠注入脚本写的随机 token：reload 之后立刻读仍是旧文档的值。
 */
async function reloadDoc() {
  // 先把 URL 归位到主页：阶段 C 的收尾停在 '#/todos'（点了空态小结的「去待办页新建」），
  // 而 Page.reload 照**当前 URL** 重载 —— 不归位的话重载出来是待办页，
  // 信息流根节点根本不存在，后面的等待全部超时（踩点：阶段 C → D 的交接）
  await evalJS(`(() => { if (location.hash !== '#/') location.hash = '#/'; return true })()`)
  await sleep(250)
  const before = await evalJS('window.__e2eDoc ?? null')
  await cdp('Page.reload')
  await waitFor(`window.__e2eDoc && window.__e2eDoc !== ${JSON.stringify(before)}`, 15000, '文档换代（Page.reload）')
}

/**
 * 关「有新版本」启动提示卡：它带全屏遮罩（.up-backdrop），不关的话后面所有真实点按
 * 都会落在遮罩上（先例 e2e-day-canvas.mjs:182-188 与调用点 :211-215、e2e-rubber-scroll.mjs:31-36）。
 * 静默更新检查比首屏晚 ~1.2s，所以先等再关。
 */
async function dismissUpdateCard() {
  await sleep(1400)
  const clicked = await evalJS(`(() => {
    const b = [...document.querySelectorAll('.up-card button')].find((x) => x.textContent.trim() === '稍后')
    if (b) b.click()
    return !!b
  })()`)
  await sleep(200)
  return clicked
}

/**
 * 一次信息流快照。断言只认 data-*：根节点 data-rendered / data-total、小结 data-state、
 * 每行 data-todo-id / data-group / data-date / data-done，外加分组头序列。
 */
function snapshot() {
  return evalJS(`(() => {
    const el = document.querySelector('${FEED}')
    if (!el) return null
    const end = document.querySelector('${END}')
    const rows = [...document.querySelectorAll('${ROW}')]
    return {
      rendered: Number(el.dataset.rendered ?? -1),
      total: Number(el.dataset.total ?? -1),
      endState: end?.dataset.state ?? el.dataset.state ?? null,
      endText: (end?.textContent ?? '').trim(),
      /* 四态小结是 div[data-testid="todo-feed-end"]，可点的两态（error / empty）里面才是 button */
      endBtnTag: end?.querySelector('button')?.tagName ?? '',
      endBtnText: (end?.querySelector('button')?.textContent ?? '').trim(),
      domRows: rows.length,
      firstId: rows[0]?.dataset.todoId ?? null,
      lastDone: rows.length ? (rows[rows.length - 1].dataset.done ?? '') : '',
      ids: rows.map((r) => r.dataset.todoId ?? ''),
      dates: rows.map((r) => r.dataset.date ?? ''),
      dones: rows.map((r) => r.dataset.done ?? ''),
      groups: [...document.querySelectorAll('${GROUP}')].map((g) => g.dataset.group ?? ''),
    }
  })()`)
}

/** 前 n 行的 data-* 摘要（首屏顺序抽查用） */
function rowsHead(n) {
  return evalJS(`(() => {
    const rows = [...document.querySelectorAll('${ROW}')].slice(0, ${n})
    return {
      count: rows.length,
      dates: rows.map((r) => r.dataset.date ?? ''),
      dones: rows.map((r) => r.dataset.done ?? ''),
      groups: rows.map((r) => r.dataset.group ?? ''),
      ids: rows.map((r) => r.dataset.todoId ?? ''),
    }
  })()`)
}

/**
 * 每 100ms 轮询一次 data-rendered，返回**第一个 > 0** 的值（首屏挂载量）。
 * reload 之后要立刻开始问：晚一步就只看得见长完的样子。超时返回 -1。
 */
async function pollFirstRendered(timeoutMs = 15000, stepMs = 100) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`(() => {
      const el = document.querySelector('${FEED}')
      return el ? Number(el.dataset.rendered ?? -1) : null
    })()`)
    if (typeof v === 'number') {
      last = v
      if (v > 0) return v
    }
    await sleep(stepMs)
  }
  return last === null ? -1 : last
}

/**
 * 记录 data-state 的每一次变更（挂在底部小结元素上）。
 * 单靠 400ms 采样会漏掉 120ms 的 loading 窗口，观察器是确定性的：
 * 「增长过程中出现过 loading」这条才有可执行的证据。
 */
function watchFeedState() {
  return evalJS(`(() => {
    const el = document.querySelector('${END}') ?? document.querySelector('${FEED}')
    if (!el) return false
    window.__feedStates = [el.dataset.state ?? null]
    const mo = new MutationObserver(() => window.__feedStates.push(el.dataset.state ?? null))
    mo.observe(el, { attributes: true, attributeFilter: ['data-state'] })
    return true
  })()`)
}

/** 滚到当前文档底边、等一拍、读一次快照（增长/到底的采样单位） */
async function scrollStep() {
  await evalJS(`(() => { window.scrollTo(0, document.documentElement.scrollHeight); return true })()`)
  await sleep(400)
  return await snapshot()
}

/** 反复「滚到底边 → 等 400ms」，直到 untilExpr 为真或试完 tries 次 */
async function scrollUntil(untilExpr, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await evalJS(`Boolean(${untilExpr})`)) return true
    await scrollStep()
  }
  return await evalJS(`Boolean(${untilExpr})`)
}

async function checkNoErrs(name) {
  const list = (await evalJS('window.__errs ?? []')) ?? []
  ok(name, Array.isArray(list) && list.length === 0, JSON.stringify(list).slice(0, 300))
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    // 无头下计时器与出帧都会被节流：mock 的 120ms delay 与信息流的 IO 都靠它们，
    // 关掉（与 e2e-cdp.mjs 的启动参数同一组）
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect()

    /* ================= 阶段 A：默认演示数据（短清单护栏） ================= */
    await waitFor(`!!document.querySelector('${FEED}')`, 20000, '阶段 A：信息流根节点')
    await dismissUpdateCard()
    // total 要等第一笔 query_todo_feed 落地（mock 每笔 delay 120ms）才写入，先等它落定：
    // 直接读会拿到 data-total="0"，而且渲染与 total 是两次赋值，等 end 态一起到位才稳
    const aSettled = await timeTo(`Number(document.querySelector('${FEED}')?.dataset.total ?? 0) > 0 && ${STATE} === 'end'`, 8000, 150) >= 0
    const a = await snapshot()
    ok(
      'A1 默认演示数据 ≤ 一页（FEED_PAGE=30）',
      aSettled && !!a && a.total > 0 && a.total <= FEED_PAGE,
      `total=${a?.total}（演示数据涨过 30 条时这条会红：主页信息流会切成「到边分批」，滑到主页底边会持续长高，e2e-rubber-scroll 的底边断言跟着红 —— 见 mock 里 seedTodoFeedBulk 的注释）`,
    )
    ok(
      'A2 整页装得下就一次挂完（rendered === total 且已是 end 态，不分批）',
      !!a && a.rendered === a.total && a.rendered <= FEED_PAGE && a.domRows === a.rendered && a.endState === 'end',
      `rendered=${a?.rendered} total=${a?.total} domRows=${a?.domRows} state=${a?.endState}`,
    )
    await checkNoErrs('A3 阶段 A 无报错（uncaught / unhandledrejection / console.error）')
    await shot('shortlist')

    /* ================= 阶段 B：批量种子 296 条（增量渲染主用例） ================= */
    await setPhase('bulk')
    await reloadDoc()
    await waitFor(`!!document.querySelector('${FEED}')`, 20000, '阶段 B：信息流根节点')
    // T1 的首屏挂载量：从 reload 起每 100ms 轮询，记下第一个 > 0 的 data-rendered
    const v0 = await pollFirstRendered(15000, 100)
    await dismissUpdateCard()
    const b = await snapshot()
    const todayS = localToday()

    ok(
      'T0 批量种子已注入（total ≥ 296：种子 296 条 + 默认演示数据 + 重复实例，故取下界）',
      !!b && b.total >= 296,
      `total=${b?.total}`,
    )
    ok(
      'T1 首屏只挂一批（FEED_BATCH 的倍数，且没滚到底就停住）',
      typeof v0 === 'number' && v0 >= FEED_BATCH && v0 % FEED_BATCH === 0 && v0 <= 60 &&
        v0 < (b?.total ?? 0) && b?.domRows === b?.rendered,
      `首个 rendered=${v0}（10 = 恰好一批；20 = 首屏时就已连追两批）+ total=${b?.total} domRows=${b?.domRows}`,
    )

    const head = await rowsHead(10)
    ok(
      'T2 首屏顺序抽查：前 8 行是「未安排」（date 空、未完成），第 9-10 行进逾期桶；头两个分组头是 inbox / overdue',
      !!b && b.groups[0] === 'inbox' && b.groups[1] === 'overdue' && head.count >= 10 &&
        head.groups.slice(0, 8).every((g) => g === 'inbox') &&
        head.dates.slice(0, 8).every((d) => d === '') &&
        head.dones.slice(0, 8).every((d) => d === '0') &&
        head.groups.slice(8, 10).every((g) => g === 'overdue') &&
        head.dates.slice(8, 10).every((d) => d !== '' && d < todayS) &&
        head.dates[8] <= head.dates[9],
      `groups=${JSON.stringify(b?.groups)} 前10行 date=${JSON.stringify(head.dates)} done=${head.dones.join('')}`,
    )
    await shot('initial')

    // T3：滚到底边逐批追加。每步 400ms 采样一次；状态变更另挂观察器（loading 窗口只有 120ms）
    await watchFeedState()
    const V = []
    let shotMid = false
    for (let i = 0; i < 60; i++) {
      const s = await scrollStep()
      if (!s) break
      V.push(s.rendered)
      if (!shotMid && s.rendered > v0 && s.rendered < s.total) {
        await shot('mid')
        shotMid = true
      }
      if (s.endState === 'end') break
    }
    const states = (await evalJS('window.__feedStates ?? []')) ?? []
    const grown = V.filter((v, i) => i > 0 && v > V[i - 1]).length
    const mono = V.every((v, i) => i === 0 || v >= V[i - 1])
    const capped = V.every((v) => v <= (b?.total ?? 0))
    ok(
      'T3 滚动逐批增长（单调不减、至少 3 次严格增长、每个采样 ≤ total、中途存在「长过一批但还没到底」的值）',
      V.length >= 3 && mono && grown >= 3 && capped && V.some((v) => v > FEED_BATCH && v < (b?.total ?? 0)),
      `V=${V.join(' → ')}`,
    )
    ok(
      'T3b 增长过程中出现过 loading 态（data-state 的变更序列里含 loading）',
      states.includes('loading'),
      `变更序列=${states.join(' → ') || '(空)'}`,
    )

    const endOk = await timeTo(`${STATE} === 'end'`, 30000, 200) >= 0
    const e4 = await snapshot()
    ok(
      'T4 到底态：rendered === total（跨页不重不漏）、小结是「已全部载入」、末行是已完成（整体沉底）',
      endOk && !!e4 && e4.rendered === e4.total && e4.domRows === e4.rendered &&
        e4.endText.includes('已全部载入') && e4.lastDone === '1',
      `rendered=${e4?.rendered} total=${e4?.total} domRows=${e4?.domRows} state=${e4?.endState} text="${e4?.endText}" 末行done=${e4?.lastDone}`,
    )
    await shot('end')

    // T5：全量分组顺序（组头按行自身字段推导，排序保证同桶连续 ⇒ 每组只出现一次）
    const groups = e4?.groups ?? []
    const asc = (arr) => arr.length > 0 && arr.every((d, i) => i === 0 || arr[i - 1] < d)
    /** 行级日期串按出现顺序非降：同一天可能有多行（种子与 sync_recurrences 物化的重复实例同日） */
    const nondesc = (arr) => arr.length > 0 && arr.every((d, i) => i === 0 || arr[i - 1] <= d)
    /** 日期型组键（YYYY-MM-DD）。inbox / overdue / today 是字面键，首字符 'i'/'o'/'t' 的码位
     *  大于任何日期串的首位数字，与日期串混在一起做比较会恒假（复核发现，纯断言写法错） */
    const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
    const undoneG = groups.filter((g) => !g.startsWith('done:'))
    const doneG = groups.filter((g) => g.startsWith('done:'))
    const lastUndone = groups.reduce((acc, g, i) => (g.startsWith('done:') ? acc : i), -1)
    ok(
      'T5 全量分组顺序：未安排 → 逾期（日期升序 = 最早欠的排最前）→ 今天 → 未来（日期升序）→ done:* 整段沉底',
      undoneG[0] === 'inbox' && undoneG[1] === 'overdue' && undoneG.includes('today') &&
        // 逾期行的日期升序只能查行级：未完成的过去日期在组件里全部并入字面键 'overdue'，组键上没有日期
        nondesc((e4?.dates ?? []).filter((d, i) => (e4?.dones ?? [])[i] === '0' && d !== '' && d < todayS)) &&
        asc(undoneG.filter((g) => DATE_KEY.test(g) && g > todayS)) &&
        doneG.length >= 4 && doneG[0] === 'done:inbox' && doneG[1] === 'done:overdue' && doneG[2] === 'done:today' &&
        asc(doneG.slice(3).map((g) => g.slice('done:'.length))) &&
        lastUndone >= 0 && lastUndone < groups.findIndex((g) => g.startsWith('done:')),
      `组序列(${groups.length})=${groups.join(' | ')}`,
    )

    // T6：勾选就地生效 —— 不重排（首行还是它）、不重取（rendered 不变）。
    // 同时是「写期间屏蔽 store 变化 + 落地 300ms 尾巴」的回归：固定 500ms 窗会在这里暴露
    await evalJS('window.scrollTo(0, 0)')
    await sleep(300)
    const before6 = await snapshot()
    const clicked6 = await evalJS(`(() => {
      const btn = document.querySelectorAll('${ROW}')[0]?.querySelector('${CHECK}')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    const toggledMs = clicked6
      ? await timeTo(`document.querySelectorAll('${ROW}')[0]?.dataset.done === '1'`, 1000, 50)
      : -1
    const after6 = await snapshot()
    const idT = before6?.firstId ?? null
    ok(
      'T6 勾选就地生效：首行 ≤1s 变完成态、不重排（首行 id 不变）、不重取（rendered 不变）',
      clicked6 && toggledMs >= 0 && !!after6 && after6.firstId === before6?.firstId &&
        after6.rendered === before6?.rendered,
      `id=${before6?.firstId}→${after6?.firstId} rendered=${before6?.rendered}→${after6?.rendered} 变完成耗时=${toggledMs}ms`,
    )
    await checkNoErrs('T7 阶段 B 无报错（uncaught / unhandledrejection / console.error）')

    // T8：写 → 重进主页 → 已沉底（「勾选不重排」的代价由下一次 refresh 收敛，这条把链钉住）
    await evalJS('window.scrollTo(0, 0)')
    await sleep(300)
    await evalJS(`location.hash = '#/todos'`)
    await timeTo(`location.hash.includes('/todos')`, 6000, 150)
    await timeTo(`!!document.querySelector('[data-testid="seg-canvas"], [aria-label="添加待办"]')`, 6000, 150)
    await evalJS(`location.hash = '#/'`)
    await waitFor(`!!document.querySelector('${FEED}')`, 15000, 'T8：回主页信息流')
    await timeTo(`Number(document.querySelector('${FEED}')?.dataset.rendered ?? 0) > 0`, 8000, 150)
    const t8 = await snapshot()
    // 计划预期恰 10（= 一批：路由切换回顶部，哨兵不在 600px 预取带内）。
    // 这里放宽到「一个批量的量级」：>10 同样是合法的首批挂载（首屏时就已连追两批），
    // 真正的红线是「重进后没重取」（渲染整份 / 0 行）与「idT 还在首屏里」
    ok(
      'T8 重进主页收敛：列表回到首屏量级（不是整份）、idT 已不在已渲染行里',
      !!t8 && t8.rendered >= FEED_BATCH && t8.rendered % FEED_BATCH === 0 && t8.rendered <= 60 &&
        t8.rendered < t8.total && !t8.ids.includes(idT),
      `rendered=${t8?.rendered}（计划预期恰 10）total=${t8?.total} idT=${idT} 在首屏=${t8?.ids.includes(idT)}`,
    )
    const idTJs = JSON.stringify(String(idT))
    const found8 = await scrollUntil(
      `[...document.querySelectorAll('${ROW}')].some((r) => r.dataset.todoId === ${idTJs})`,
      60,
    )
    const g8 = await evalJS(`(() => {
      const r = [...document.querySelectorAll('${ROW}')].find((x) => x.dataset.todoId === ${idTJs})
      return r ? (r.dataset.group ?? '') : null
    })()`)
    ok(
      'T8b 滚到底后 idT 落在 done:* 组（「写 → 重进主页 → 已沉底」收敛链）',
      found8 && typeof g8 === 'string' && g8.startsWith('done:'),
      `group=${g8}`,
    )

    /* ================= 阶段 C：空库 → empty 态 ================= */
    await setPhase('empty')
    await reloadDoc()
    await waitFor(`!!document.querySelector('${FEED}')`, 20000, '阶段 C：信息流根节点')
    await dismissUpdateCard()
    const cEmpty = await timeTo(`${STATE} === 'empty'`, 8000, 150) >= 0
    const c = await snapshot()
    ok(
      'C1 空库：total=0 / rendered=0 / empty 态；列表不渲染但根节点仍在（e2e 找得到）',
      cEmpty && !!c && c.total === 0 && c.rendered === 0 && c.domRows === 0 && c.endState === 'empty',
      `total=${c?.total} rendered=${c?.rendered} domRows=${c?.domRows} state=${c?.endState}`,
    )
    await shot('empty')
    await checkNoErrs('C2 阶段 C 无报错（uncaught / unhandledrejection / console.error）')
    const cTag = await evalJS(`document.querySelector('${END} button')?.tagName ?? ''`)
    const cClicked = await evalJS(`(() => {
      const b = document.querySelector('${END} button')
      if (!b) return false
      b.click()
      return true
    })()`)
    const cRouted = cClicked ? await timeTo(`location.hash.includes('/todos')`, 4000, 150) : -1
    ok(
      'C3 空态小结是按钮且可点（去待办页新建）',
      cTag === 'BUTTON' && !!c && c.endText.includes('还没有待办') && cRouted >= 0,
      `内含 ${cTag || '(无)'} text="${c?.endText}" 点后 hash=${await evalJS('location.hash')}`,
    )

    /* ================= 阶段 D：取数失败 → 重试 ================= */
    await setPhase('fail')
    await reloadDoc()
    await waitFor(`!!document.querySelector('${FEED}')`, 20000, '阶段 D：信息流根节点')
    await dismissUpdateCard()
    const dErr = await timeTo(`${STATE} === 'error'`, 8000, 150) >= 0
    const d = await snapshot()
    await shot('error')
    ok(
      'D1 取数失败落到 error 态，小结里是「点此重试」按钮',
      dErr && !!d && d.endState === 'error' && d.endBtnTag === 'BUTTON' && d.endBtnText.includes('点此重试'),
      `state=${d?.endState} 内含=${d?.endBtnTag || '(无按钮)'} text="${d?.endText}" rendered=${d?.rendered}`,
    )
    // 关掉失败开关就地点重试：只重取失败的那一页（offset 没推进），
    // 而默认演示数据 ≤ 一页 ⇒ 与首屏同一条挂载规则（appendInitial）一次挂完进 end
    const failDeleted = await evalJS('delete window.__REIN_MOCK_TODO_FEED_FAIL__; true')
    const retried = await evalJS(`(() => {
      const b = document.querySelector('${END} button')
      if (!b) return false
      b.click()
      return true
    })()`)
    const dSettled = await timeTo(
      `Number(document.querySelector('${FEED}')?.dataset.rendered ?? 0) > 0 && ${STATE} === 'end'`,
      10000, 150,
    ) >= 0
    const d2 = await snapshot()
    ok(
      'D2 重试后一次挂完进 end（重试与首屏共用「整页装得下就一次挂完」）',
      failDeleted === true && retried && dSettled && !!d2 &&
        d2.rendered === d2.total && d2.rendered > 0 && d2.rendered <= FEED_PAGE,
      `rendered=${d2?.rendered} total=${d2?.total} state=${d2?.endState}`,
    )
    await shot('retry-end')
    await checkNoErrs('D3 阶段 D 无报错（取数失败走的是 console.warn，不该进 __errs）')
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
  console.log(`截帧: ${SHOT_DIR}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 中断:', e.message)
  process.exit(2)
})
