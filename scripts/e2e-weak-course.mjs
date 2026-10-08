/**
 * 弱项 → 现成课程匹配 专项 E2E（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：REIN_E2E_URL=http://localhost:1431 node scripts/e2e-weak-course.mjs
 *   （前置：另起一个**非 Tauri** 的 vite —— `cargo tauri dev` 起的 1420 没有 mock 后端）
 *
 * 为什么单独一条：这条链路的算术（练够分 → 弱项序 → 课程匹配）已有引擎冒烟钉住
 * （scripts/.tmp-weak-course*.ts，14 + 2 项断言），这里只钉**接线**——
 * 卡上那句话说的是不是真的、按下去开的到底是不是那节课。两处最容易悄悄错：
 *   1. 课程训练目的读的是条目自带的 muscles（内置课/编辑器建的课都是空的）→ 匹配永远不中；
 *   2. 抽屉里推荐块写「拉日」，主按钮却仍然开临时草稿。
 *
 * 用画像（注入 mock 的做组历史，不依赖任何演示数据）：
 *   正例 = 横杠划船 1×5@50kg + 杠铃弯举 1×5@30kg（2 天前）→ 背 53 / 肩 53 / 二头 53 弱项
 *          （引擎实测；肩被划船的后束带弱）→ 命中「拉日」（命中 3 / 主攻 3）
 *   反例 = 站姿提踵 1×5@40kg → 只弱小腿 → 没有对症的课，退回临时草稿
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!EDGE) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-e2e-weak-course-${Date.now()}`
const OUT = 'docs/shots'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

let DEBUG_PORT = 9336
let ws
let msgId = 0
const pending = new Map()
const results = []

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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 12000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const els = [...document.querySelectorAll('${scope} button')]
    const el = els.find(b => b.textContent.includes(${JSON.stringify(text)}) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function shoot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  截图 → ${OUT}/${name}.png`)
}

/** 关掉过渡与动画（无头下 rAF 会被节流，Vue 过渡可能停在中间态） */
async function injectStableCSS() {
  await evalJS(`(() => {
    let s = document.getElementById('__e2e-stable')
    if (!s) {
      s = document.createElement('style')
      s.id = '__e2e-stable'
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
      document.head.appendChild(s)
    }
    return true
  })()`)
}

/** 首启的更新浮层：display:none 而不是 remove()（摘 Vue 管理的节点会破坏它的 DOM 记账） */
async function hideUpdateOverlay() {
  await evalJS(`(() => {
    document.querySelectorAll('.up-backdrop').forEach((n) => { n.style.display = 'none' })
    return true
  })()`)
}

/**
 * 注入一份确定的做组历史（mock 的做组明细真源在 localStorage：rein.mock.sets.v1），
 * 同时把演示播种的版本位写满 —— 否则 mock 会再叠一份腿日/推日演示组，
 * 画像就不干净了（日期由 createdAt 决定：找不到 workoutId 时 mock 用它取日期）。
 */
async function injectProfile(rows) {
  const n = await evalJS(`(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('rein.mock.')) localStorage.removeItem(k)
    }
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
    const rows = ${JSON.stringify(rows)}.map((r, i) => ({
      id: i + 1,
      workoutId: 90000 + r.day,
      planId: null,
      exerciseKey: 'e2e-' + r.id,
      exerciseId: r.id,
      exerciseName: r.name,
      setNo: r.setNo,
      kind: 'strength',
      weightKg: r.weight,
      reps: r.reps,
      sec: null,
      warmup: false,
      createdAt: day(r.day) + 'T19:00:00',
    }))
    localStorage.setItem('rein.mock.sets.v1', JSON.stringify(rows))
    localStorage.setItem('rein.mock.sets.seedVer.v1', '1')
    return rows.length
  })()`)
  await cdp('Page.reload')
  await injectStableCSS()
  await hideUpdateOverlay()
  await sleep(2200)
  return n
}

const BACK_ARMS = [
  { id: 'barbell-row', name: '杠铃划船', weight: 50, reps: 5, day: 2, setNo: 1 },
  { id: 'barbell-curl', name: '杠铃弯举', weight: 30, reps: 5, day: 2, setNo: 1 },
]
const CALVES_ONLY = [{ id: 'standing-calf-raise', name: '站姿提踵', weight: 40, reps: 5, day: 2, setNo: 1 }]

async function connect(pageTargetUrl) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true })
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
  await injectStableCSS()
}

/** 读主页练卡的三件事：值行 / 事实句 / 立刻练指向谁 */
async function readTrainCard() {
  return evalJS(`(() => {
    const z = document.querySelector('[data-testid="hf-zone-train"]')
    const start = z?.querySelector('[data-testid="hf-start"]')
    return {
      value: z?.querySelector('.hf-zv')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      note: z?.querySelector('.hf-zn')?.textContent.trim() ?? '',
      startLabel: start?.getAttribute('aria-label') ?? '',
    }
  })()`)
}

/** 读当前会话开的是哪节课（沉浸层起来前 store 已有值，不必等 UI） */
async function readSessionPlan() {
  return evalJS(`(async () => {
    const { useSessionStore } = await import('/src/stores/session.ts')
    const s = useSessionStore()
    return { plan: s.plan?.name ?? null, exCount: s.plan?.exercises.length ?? 0 }
  })()`)
}

/** 读「弱项加练」抽屉里的推荐课块（限定在 dialog 内，别把页面上的同名文案算进来） */
async function readCatchupSheet() {
  return evalJS(`(() => {
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes('弱项加练'))
    if (!dlg) return { open: false }
    const box = dlg.querySelector('[data-testid="catchup-course"]')
    return {
      open: true,
      hasCourse: !!box,
      name: box?.querySelector('.rc-name')?.textContent.trim() ?? '',
      chips: [...(box?.querySelectorAll('.rc-g') ?? [])].map((c) => ({
        t: c.textContent.trim(),
        on: c.classList.contains('on'),
      })),
      why: box?.querySelector('.rc-why')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      startLabel: dlg.querySelector('[data-testid="catchup-start-course"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      draftLabel: dlg.querySelector('[data-testid="catchup-start-draft"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      draftTitle: [...dlg.querySelectorAll('.dt')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim()).join('|'),
      draftRows: dlg.querySelectorAll('.dlist .drow').length,
      lede: dlg.querySelector('.lede')?.textContent.trim() ?? '',
    }
  })()`)
}

/** 抽屉在不在（标题认得出即可） */
const SHEET_OPEN = `[...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent.includes('弱项加练'))`

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,932', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/`)

    /* ---------- 正例画像：背/肩/二头 弱 ---------- */
    const injected = await injectProfile(BACK_ARMS)
    ok('S0 注入画像（2 组：划船 + 弯举）', injected === 2, `rows=${injected}`)

    await waitFor(`document.querySelector('[data-testid="hf-zone-train"]')`, 15000, '练卡就绪')
    await waitFor(`document.querySelector('[data-testid="hf-start"]')`, 15000, '立刻练出现')

    const card = await readTrainCard()
    ok('S1 练卡事实句说出对症的课', card.note.includes('拉日') && card.note.includes('正好补上'), card.note)
    ok('S1b 立刻练指向该课（不是「开练弱项加练」）', card.startLabel === '立刻开练「拉日」', card.startLabel)
    ok('S1c 值行给出焦点组（未练/分低同一份口径）', card.value.includes('背'), card.value)
    await shoot('e2e-weak-course-home')

    /* ---------- S2. 立刻练 = 直接开那节课 ---------- */
    await evalJS(`document.querySelector('[data-testid="hf-start"]').click()`)
    await sleep(1500)
    const started = await readSessionPlan()
    ok('S2 立刻练开的是「拉日」', started.plan === '拉日', JSON.stringify(started))

    /* ---------- S3. 运动页抽屉：推荐课块 ---------- */
    await injectProfile(BACK_ARMS)
    await evalJS(`location.hash = '#/sports'`)
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('弱项加练'))`, 15000, '运动页热力图卡就绪')
    await clickButton('弱项加练')
    await waitFor(SHEET_OPEN, 8000, '弱项加练抽屉')

    const sheet = await readCatchupSheet()
    ok('S3 抽屉里出现推荐课块', sheet.hasCourse && sheet.name === '拉日', `${sheet.name} / ${sheet.startLabel}`)
    ok(
      'S3b 主攻组 chip：命中的打勾高亮（背/肩/二头）',
      sheet.chips.length === 3 && sheet.chips.every((c) => c.on) &&
        sheet.chips.map((c) => c.t).join('、') === '背、肩、二头',
      JSON.stringify(sheet.chips),
    )
    ok('S3c 命中说明与命中数一致', sheet.why.includes('主攻 3 组') && sheet.why.includes('背、肩、二头'), sheet.why)
    ok('S3d 主按钮 = 开练该课', sheet.startLabel === '开练「拉日」', sheet.startLabel)
    ok('S3e 临时草稿降级为备选', sheet.draftTitle.includes('备选') && sheet.draftRows > 0, `${sheet.draftTitle} / ${sheet.draftRows} 行`)
    ok('S3f 开场白说明「优先练它」', sheet.lede.includes('优先练它'), sheet.lede)
    await shoot('e2e-weak-course-sheet')

    /* ---------- S4. 抽屉主按钮 = 真的开那节课 ---------- */
    await evalJS(`document.querySelector('[data-testid="catchup-start-course"]').click()`)
    await sleep(1500)
    const fromSheet = await readSessionPlan()
    ok('S4 抽屉主按钮开的是「拉日」', fromSheet.plan === '拉日', JSON.stringify(fromSheet))

    /* ---------- S5. 反例画像：只弱小腿 → 无对症课，退回临时草稿 ---------- */
    await injectProfile(CALVES_ONLY)
    await evalJS(`location.hash = '#/'`)
    await sleep(800)
    const card2 = await readTrainCard()
    ok('S5 没有对症的课：立刻练退回弱项加练', card2.startLabel === '开练弱项加练', card2.startLabel)
    await evalJS(`document.querySelector('[data-testid="hf-start"]').click()`)
    await waitFor(SHEET_OPEN, 8000, '弱项加练抽屉（反例）')
    const sheet2 = await readCatchupSheet()
    ok('S5b 抽屉里没有推荐课块', sheet2.open && !sheet2.hasCourse, sheet2.name || '(none)')
    ok('S5c 主按钮回到「开始训练」（临时草稿）', sheet2.draftLabel === '开始训练', sheet2.draftLabel)
    ok('S5d 草稿补上小腿的动作，且不带「备选」字样（它仍是主路）', sheet2.draftRows > 0 && sheet2.draftTitle.indexOf('备选') === -1, `${sheet2.draftRows} 行 / ${sheet2.draftTitle}`)
    await shoot('e2e-weak-course-fallback')
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 中断:', e.message)
  process.exit(2)
})
