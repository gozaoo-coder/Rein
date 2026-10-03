/**
 * 教务课程详情抽屉（`CampusCourseDetailSheet`）截图 + 布局守卫。
 *
 * 为什么单独一个脚本：这个抽屉 90% 的价值在**排版**而不是数据 ——
 * 「节次尺 / 周次尺 / 数字瓦片 / 堆叠条」这几样东西只有真渲染出来才谈得上好不好看，
 * 而它们全在 large 档的内容区里。下面量的三件事正对应三个已知的翻车点：
 *
 * 1. **横向溢出**：尺子是 `display:flex` + 每格 `flex:1`，一旦总学期数很大
 *    （endWeek 报到 30+）而容器没兜住，会把整页撑出横向滚动。
 * 2. **折行**：`.cell` 是固定高度的方块，序号一旦折成两行，尺子会高低不齐。
 *    用 `Range.getClientRects().length` 数行盒（别用 offsetHeight 猜）。
 * 3. **首屏截断**：抽屉是 large 档但内容可能超一屏，量一下「身份 / 起止时刻 / 地点 /
 *    容量 / 节次尺」这些主体信息有没有落到折叠线以下 —— 折叠线以下的内容等于不存在。
 *
 * 前置：非 Tauri 的 vite（`npx vite --port 1430`）。`cargo tauri dev` 起的 vite
 * 走 `src/mock/disabled.ts`，浏览器连上去拿不到任何数据。
 * 运行：REIN_SHOT_URL=http://localhost:1430 node scripts/shot-campus-course-detail.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

import { chromium } from 'playwright-core'

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = BROWSERS.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行截图脚本')
  process.exit(1)
}

const APP = process.env.REIN_SHOT_URL ?? 'http://localhost:1430'
const OUT = process.env.REIN_SHOT_OUT ?? 'docs/shots'
mkdirSync(OUT, { recursive: true })

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 隐藏会挡住抽屉的浮层：只置 display:none，**绝不 remove()** ——
 * `.up-backdrop` / `.up-card` / toast 都是 Vue 管理的节点，摘掉会破坏 Vue 的 DOM 记账，
 * 之后关闭任何弹层都会抛 `insertBefore of null`（看着像产品 bug，其实是脚本自造的）。
 */
async function hideOverlays(page) {
  await page.evaluate(() => {
    const sels = ['.up-backdrop', '.up-card', '.toast', '.toast-wrap', '.snack']
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
  })
}

/** 抽屉打开后再扫一次：toast 常在打开后才被 push 进 DOM */
async function hideOverlaysLate(page) {
  await page.waitForTimeout(300)
  await hideOverlays(page)
}

async function setInput(page, selector, value) {
  await page.evaluate(
    ([sel, val]) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    [selector, value],
  )
}

async function clickText(page, selector, text) {
  return page.evaluate(
    ([sel, txt]) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(txt))
      if (!el) return false
      el.click()
      return true
    },
    [selector, text],
  )
}

async function login(page) {
  await page.goto(`${APP}/#/campus/settings`, { waitUntil: 'networkidle' })
  // 冷启动时 vite 还在编首个模块图，`.sys` 可能晚好几秒才出现 —— 等它而不是等固定时长
  await page.waitForSelector('.sys', { timeout: 30000 })
  await hideOverlays(page)
  await setInput(page, 'input[autocomplete="username"]', '2600350118')
  await setInput(page, 'input[autocomplete="current-password"]', 'demo1234')
  await clickText(page, 'button', '登录')
  await page.waitForFunction(() => document.body.textContent.includes('已登录'), null, { timeout: 15000 })
}

/** 打开一个课程详情抽屉（周视图点课程块） */
async function openDetail(page) {
  await page.goto(`${APP}/#/campus/schedule`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.grid .cell.head.day', { timeout: 30000 })
  await hideOverlays(page)
  // 课程块是 ScheduleWeekView 的 `.blk`；mock 的高等数学A1 一定有，点第一个
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('.blk')
    if (!el) return false
    el.click()
    return true
  })
  if (!clicked) throw new Error('课表里找不到课程块')
  await page.waitForSelector('.panel .hero-name', { timeout: 12000 })
  await hideOverlaysLate(page)
  await page.waitForTimeout(700)
}

const MEASURE = () => {
  const panel = document.querySelector('.panel')
  const body = panel.querySelector('.body')
  const br = body.getBoundingClientRect()

  const lineBoxes = (el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getClientRects().length
  }

  // 尺子格子：一行一个方块，任何一格折行都会让整把尺子高低不齐
  const cells = [...panel.querySelectorAll('.cells')].map((list) => ({
    n: list.children.length,
    rows: [...list.children].map((c) => lineBoxes(c)),
    heights: [...list.children].map((c) => Math.round(c.getBoundingClientRect().height)),
  }))

  // 首屏可见性：抽屉是 large 档（视口 ×0.9），可视区 = body 高度
  const visible = (sel) => {
    const el = panel.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.top < br.bottom && r.bottom > br.top
  }

  return {
    panelH: Math.round(panel.getBoundingClientRect().height),
    bodyViewH: Math.round(br.height),
    // 横向溢出：内容比容器宽就会让 body 出现横向滚动
    overflowX: body.scrollWidth - body.clientWidth,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    scrollable: body.scrollHeight > body.clientHeight,
    contentH: body.scrollHeight,
    cells,
    visible: {
      name: visible('.hero-name'),
      time: visible('.when-time'),
      where: visible('.where'),
      cap: visible('.cap'),
      unitAxis: visible('.axis'),
    },
    sections: [...panel.querySelectorAll('.sec h4')].map((h) => h.textContent.trim()),
    dashCount: [...panel.querySelectorAll('.detail *')].filter(
      (e) => e.children.length === 0 && e.textContent.trim() === '—',
    ).length,
    // 「实验安排 0」这类：教务用 0 表达「没有」，渲染出来读起来像 bug
    zeroNoise: [...panel.querySelectorAll('.note-v, .owner-v, .axis-v')].filter(
      (e) => e.textContent.trim() === '0',
    ).length,
    // 「有标题没值」的孤儿行：比不渲染更糟
    emptyRows: [...panel.querySelectorAll('.notes li')].filter(
      (li) => !li.querySelector('.note-v')?.textContent.trim(),
    ).length,
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })

try {
  for (const [theme, width] of [
    ['light', 430],
    ['dark', 430],
    ['light', 375],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 932 } })
    // 暗色由 tokens.css 的 `@media (prefers-color-scheme: dark)` 驱动，
    // 只能靠 emulateMedia 模拟 —— 写 <html data-theme> 不会生效（Rein 没有这个开关）
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    await login(page)
    await openDetail(page)

    const m = await page.evaluate(MEASURE)
    const tag = `${theme}-${width}`
    const file = `${OUT}/campus-course-detail-${tag}.png`
    await page.screenshot({ path: file })
    writeFileSync(`${OUT}/campus-course-detail-${tag}.json`, JSON.stringify(m, null, 2))
    console.log(`\n── ${tag} ──`)
    console.log(file)

    check(`${tag} 抽屉无横向溢出`, m.overflowX <= 0 && m.docOverflowX <= 0, `body ${m.overflowX} / doc ${m.docOverflowX}`)
    check(
      `${tag} 尺子每格单行`,
      m.cells.every((c) => c.rows.every((r) => r <= 1)),
      JSON.stringify(m.cells.map((c) => c.rows)),
    )
    check(
      `${tag} 尺子等高`,
      m.cells.every((c) => new Set(c.heights).size === 1),
      JSON.stringify(m.cells.map((c) => [...new Set(c.heights)])),
    )
    check(
      `${tag} 主体信息在首屏可见`,
      m.visible.name && m.visible.time && m.visible.where && m.visible.unitAxis,
      JSON.stringify(m.visible),
    )
    check(`${tag} 没有占位符「—」残留`, m.dashCount === 0, `${m.dashCount} 处`)
    check(`${tag} 没有「0」值噪音`, m.zeroNoise === 0, `${m.zeroNoise} 处`)
    check(`${tag} 没有空值孤儿行`, m.emptyRows === 0, `${m.emptyRows} 处`)

    await page.close()
  }
} finally {
  await browser.close()
}

const bad = results.filter((r) => !r.pass)
console.log(`\n${results.length - bad.length}/${results.length} 通过`)
if (bad.length) {
  console.log('失败：')
  for (const b of bad) console.log(`  - ${b.name}`)
  process.exit(1)
}
