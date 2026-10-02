/**
 * AI 页改动的运行时冒烟：真开浏览器点一遍。
 * 覆盖：页头合并后的历史菜单、识别卡存草稿、看板、底栏 overlay。
 */
import { chromium } from 'playwright-core'

const URL = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
})
const page = await browser.newPage({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

async function go(hash) {
  await page.goto(URL + '/#' + hash, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  // 首启的更新浮层（.up-backdrop）会盖住整屏。
  // ⚠️ 必须用 display:none **隐藏**，不能 remove() —— 那是 Vue 管理的节点，
  // 摘掉它会破坏 Vue 的 DOM 记账，之后任何弹层关闭都会抛
  // 「Cannot read properties of null (reading 'insertBefore')」，
  // 看起来像产品 bug，实际是测试自己造的（踩过一次，2026-10-02）。
  await page.evaluate(() => {
    document.querySelectorAll('.up-backdrop').forEach((n) => {
      if (n instanceof HTMLElement) n.style.display = 'none'
    })
  })
  await page.waitForTimeout(200)
}

/** 强制点击：绕开 Playwright 的命中测试（更新浮层这类全屏遮罩会挡住） */
async function forceClick(selector) {
  await page.evaluate((s) => {
    const el = document.querySelector(s)
    if (el instanceof HTMLElement) el.click()
  }, selector)
  await page.waitForTimeout(450)
}

/* ---------- 1. AI 页：页头与历史菜单 ---------- */
await go('/ai')

const header = await page.evaluate(() => {
  const hdr = document.querySelector('.page-header')
  const btns = [...document.querySelectorAll('.page-header button, .page-header .hdr-btn')]
  return {
    title: hdr?.querySelector('h1')?.textContent?.trim() ?? null,
    btnCount: btns.length,
    labels: btns.map((b) => b.getAttribute('aria-label')),
    // 形态是否统一：都该是 38px 圆钮
    sizes: btns.map((b) => {
      const r = b.getBoundingClientRect()
      return `${Math.round(r.width)}x${Math.round(r.height)}`
    }),
  }
})
console.log('页头:', JSON.stringify(header))

// 点开历史菜单
await forceClick('button[aria-label="历史"]')
await page.waitForTimeout(500)
const menu = await page.evaluate(() => {
  const panel = document.querySelector('.panel[role="menu"]')
  if (!panel) return null
  const items = [...panel.querySelectorAll('.item')].map((i) => ({
    label: i.querySelector('.lbl')?.textContent?.trim(),
    hasIcon: !!i.querySelector('svg'),
  }))
  const r = panel.getBoundingClientRect()
  const anchor = document.querySelector('button[aria-label="历史"]')?.getBoundingClientRect()
  return {
    items,
    // 菜单是否依附在按钮旁（横向重叠）
    nearAnchor: anchor ? Math.abs(r.left - anchor.left) < 30 : false,
    below: anchor ? r.top >= anchor.bottom : false,
  }
})
console.log('历史菜单:', JSON.stringify(menu, null, 1))
await page.screenshot({ path: 'docs/design/colorlab/shot-ai-history-menu.png' })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

/* ---------- 2. 看板（空会话） ---------- */
const board = await page.evaluate(() => {
  const b = document.querySelector('.board')
  if (!b) return { present: false, msgCount: document.querySelectorAll('.msg').length }
  return {
    present: true,
    qa: b.querySelectorAll('.qa').length,
    qaLabels: [...b.querySelectorAll('.qa b')].map((x) => x.textContent.trim()),
    hasToday: !!b.querySelector('.today'),
    hasWelcome: (document.body.textContent || '').includes('你好，我是 Rein AI'),
    msgCount: document.querySelectorAll('.msg').length,
  }
})
console.log('看板:', JSON.stringify(board))
await page.screenshot({ path: 'docs/design/colorlab/shot-ai-board.png' })

/* ---------- 3. 底栏 overlay：内容能否从玻璃下方走 ---------- */
const composer = await page.evaluate(() => {
  const c = document.querySelector('.composer')
  const bar = document.querySelector('.cbar')
  const msgs = document.querySelector('.msgs')
  if (!c || !bar || !msgs) return null
  const cr = c.getBoundingClientRect()
  const br = bar.getBoundingClientRect()
  const mr = msgs.getBoundingClientRect()
  return {
    composerPos: getComputedStyle(c).position,
    // 底栏是否与滚动区**重叠**（overlay 的判据）
    overlapsScroll: cr.top < mr.bottom - 1,
    barH: Math.round(br.height),
    scrollPadBottom: getComputedStyle(msgs).paddingBottom,
  }
})
console.log('底栏:', JSON.stringify(composer))

/* ---------- 4. 间距不变量（与 e2e-layout-guard 同口径） ---------- */
const gap = await page.evaluate(() => {
  const bar = document.querySelector('.cbar')?.getBoundingClientRect()
  const dock = document.querySelector('.dock')?.getBoundingClientRect()
  if (!bar || !dock) return null
  return { dockTopMinusBarBottom: Math.round(dock.top - bar.bottom) }
})
console.log('输入栏底→Dock顶（期望 10）:', JSON.stringify(gap))

/* ---------- 5. 虚拟文件系统：能否点开看正文 ---------- */
await go('/ai/files')
const files = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.list .item')]
  return {
    cards: document.querySelectorAll('.card.list').length,
    itemCount: items.length,
    sections: [...document.querySelectorAll('.sec')].map((s) => s.textContent.trim()),
    firstItems: items.slice(0, 5).map((i) => i.querySelector('b')?.textContent?.trim()),
  }
})
console.log('文件页:', JSON.stringify(files))
await page.screenshot({ path: 'docs/design/colorlab/shot-ai-files.png' })

// 点第一个条目，看能否进阅读器并读到文本
const opened = await page.evaluate(async () => {
  const item = document.querySelector('.list .item')
  if (!item) return { clicked: false }
  item.click()
  await new Promise((r) => setTimeout(r, 1400))
  const reader = document.querySelector('.reader')
  const doc = document.querySelector('.reader .doc')
  return {
    clicked: true,
    readerShown: !!reader,
    title: reader?.querySelector('.rtitle')?.textContent?.trim() ?? null,
    docChars: doc ? doc.textContent.trim().length : 0,
    docHead: doc ? doc.textContent.trim().slice(0, 60) : null,
    hasLoadMore: !!reader?.querySelector('.more-row'),
  }
})
console.log('点开条目:', JSON.stringify(opened))
await page.screenshot({ path: 'docs/design/colorlab/shot-ai-files-reader.png' })

await browser.close()

console.log('\nJS 报错:', errors.length ? errors : '无')
