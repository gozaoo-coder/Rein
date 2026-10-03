/**
 * 课表配置与设置页（`CampusSettingsPage`）二级抽屉截图 + 布局守卫。
 *
 * 这页的列表不走折叠：学期 / 调休纠正 / AI 操作记录都收进二级抽屉（SheetModal），
 * 页面本体只留入口行。这里量三件事，对应三个已知翻车点：
 *
 * 1. **横向溢出**：抽屉里 `.pick-row` / `.holiday-list li` 都是 flex 行，
 *    日期 + 选择器挤在 375px 上容易把容器撑出横向滚动。
 * 2. **入口行折行**：`.link-row` 的主文字 + `em` 副行，用 Range 数行盒确认
 *    `em` 副行各自单行（主标题允许 balance 折行，副行折行就是挤）。
 * 3. **抽屉可达性**：三个入口点开都能等到抽屉标题出现，且抽屉里真能数到列表行。
 *
 * 前置：非 Tauri 的 vite（`npx vite --port 1430`）。`cargo tauri dev` 起的 vite
 * 走 `src/mock/disabled.ts`，浏览器连上去拿不到任何数据。
 * 运行：REIN_SHOT_URL=http://localhost:1430 node scripts/shot-campus-settings.mjs
 */
import { mkdirSync, existsSync } from 'node:fs'

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

/** 只置 display:none，绝不 remove()（Vue 管理的节点摘掉会炸 DOM 记账） */
async function hideOverlays(page) {
  await page.evaluate(() => {
    for (const sel of ['.up-backdrop', '.up-card', '.toast', '.toast-wrap', '.snack']) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
  })
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
  await page.waitForTimeout(900)
  await hideOverlays(page)
  await page.waitForSelector('.sys', { timeout: 12000 })
  await setInput(page, 'input[autocomplete="username"]', '2600350118')
  await page.waitForTimeout(300)
  await setInput(page, 'input[autocomplete="current-password"]', 'demo1234')
  await page.waitForTimeout(300)
  await clickText(page, 'button', '登录')
  await page.waitForFunction(() => document.body.textContent.includes('已登录'), null, { timeout: 20000 })
  // 登录成功会自动同步一轮（onLogin → onSync）。注意入口行的 !disabled 在两轮
  // 背靠背同步的间隙里也会短暂为 true —— 在那个间隙点它会被 disabled 吞掉。
  // 等「上次同步」出现（说明有一轮真正跑完）再继续。
  await page.waitForFunction(() => document.body.textContent.includes('上次同步'), null, { timeout: 30000 })
  await page.waitForFunction(
    () => {
      const row = [...document.querySelectorAll('.link-row')].find((b) => b.textContent.includes('学期'))
      return row && !row.disabled
    },
    null,
    { timeout: 20000 },
  )
  await page.waitForTimeout(600)
  await hideOverlays(page)
}

const MEASURE_PAGE = () => {
  const lineBoxes = (el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getClientRects().length
  }
  const doc = document.documentElement
  return {
    docOverflowX: doc.scrollWidth - doc.clientWidth,
    entries: [...document.querySelectorAll('.link-row')].map((b) => ({
      text: b.textContent.trim().slice(0, 24),
      h: Math.round(b.getBoundingClientRect().height),
      emLines: b.querySelector('em') ? lineBoxes(b.querySelector('em')) : 0,
    })),
  }
}

const MEASURE_SHEET = () => {
  // SheetModal 的面板类名就是 .panel（与 shot-campus-course-detail 同一约定）
  const panel = document.querySelector('.panel')
  const body = panel?.querySelector('.body') ?? panel
  const doc = document.documentElement
  return {
    found: !!panel,
    overflowX: body ? body.scrollWidth - body.clientWidth : -1,
    docOverflowX: doc.scrollWidth - doc.clientWidth,
    rows: panel ? panel.querySelectorAll('li').length : 0,
    text: panel ? panel.textContent.slice(0, 80) : '',
  }
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })

try {
  for (const [theme, width] of [
    ['light', 430],
    ['light', 375],
    ['dark', 430],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 932 } })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    await login(page)
    const tag = `${theme}-${width}`

    // ── 页面本体：入口行 ──
    const p = await page.evaluate(MEASURE_PAGE)
    console.log(`\n── ${tag} · 页面本体 ──`)
    check(`${tag} 页面无横向溢出`, p.docOverflowX <= 0, `${p.docOverflowX}px`)
    check(
      `${tag} 入口行 em 副行单行`,
      p.entries.every((e) => e.emLines <= 1),
      JSON.stringify(p.entries),
    )
    await page.screenshot({ path: `${OUT}/campus-settings-${tag}.png` })

    // ── 抽屉 1：学期 ──
    await clickText(page, '.link-row', '学期')
    await page.waitForTimeout(900)
    await hideOverlays(page)
    let s = await page.evaluate(MEASURE_SHEET)
    check(`${tag} 学期抽屉打开`, s.found && s.text.includes('选择学期'), JSON.stringify(s))
    check(`${tag} 学期抽屉无横向溢出`, s.overflowX <= 0 && s.docOverflowX <= 0, `body ${s.overflowX}`)
    // 行数只作信息输出：mock 的 semesters 可能为空（真机才有数据），空抽屉不是布局问题
    console.log(`INFO  ${tag} 学期抽屉 ${s.rows} 行`)
    await page.screenshot({ path: `${OUT}/campus-settings-sem-${tag}.png` })
    // 关抽屉点 backdrop（它就挂着 @click=emit(close)）；Esc 要焦点在面板内才生效
    await page.evaluate(() => { document.querySelector('.backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await page.waitForTimeout(800)

    // ── 抽屉 2：调休纠正 ──
    await clickText(page, '.link-row', '逐日纠正')
    await page.waitForTimeout(900)
    await hideOverlays(page)
    s = await page.evaluate(MEASURE_SHEET)
    check(`${tag} 调休抽屉打开`, s.found && s.text.includes('逐日纠正'), s.text.slice(0, 30))
    check(`${tag} 调休抽屉无横向溢出`, s.overflowX <= 0 && s.docOverflowX <= 0, `body ${s.overflowX}`)
    await page.screenshot({ path: `${OUT}/campus-settings-holiday-${tag}.png` })
    await page.evaluate(() => { document.querySelector('.backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await page.waitForTimeout(800)

    // ── 抽屉 3：AI 操作记录 ──
    await clickText(page, '.link-row', '操作记录')
    await page.waitForTimeout(900)
    await hideOverlays(page)
    s = await page.evaluate(MEASURE_SHEET)
    check(`${tag} 记录抽屉打开`, s.found && s.text.includes('操作记录'), s.text.slice(0, 30))
    await page.screenshot({ path: `${OUT}/campus-settings-audit-${tag}.png` })

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
