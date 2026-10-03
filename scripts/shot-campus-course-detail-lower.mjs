/**
 * 课程详情抽屉**下半部分**截图：学时构成堆叠条 / 开课归属 / 补充 / 编号折叠。
 *
 * 上半部分（身份 + 两把尺子 + 瓦片）由 shot-campus-course-detail.mjs 负责。
 * 这里只做一件事：把 body 滚到底再截，因为抽屉是 large 档但内容超一屏，
 * 首屏截图永远看不到堆叠条与折叠区。
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
  console.error('找不到 Edge/Chrome')
  process.exit(1)
}

const APP = process.env.REIN_SHOT_URL ?? 'http://localhost:1430'
const OUT = process.env.REIN_SHOT_OUT ?? 'docs/shots'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    [selector, value],
  )
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
    await page.emulateMedia({ colorScheme: theme })

    await page.goto(`${APP}/#/campus/settings`, { waitUntil: 'networkidle' })
    // 等 `.sys` 而不是等固定时长：vite 冷启动时首屏模块图要现编，晚几秒是常态
    await page.waitForSelector('.sys', { timeout: 30000 })
    await hideOverlays(page)
    await setInput(page, 'input[autocomplete="username"]', '2600350118')
    await setInput(page, 'input[autocomplete="current-password"]', 'demo1234')
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('登录'))
      el?.click()
    })
    await page.waitForFunction(() => document.body.textContent.includes('已登录'), null, { timeout: 15000 })

    await page.goto(`${APP}/#/campus/schedule`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.blk', { timeout: 30000 })
    await hideOverlays(page)
    await page.evaluate(() => document.querySelector('.blk').click())
    await page.waitForSelector('.panel .hero-name', { timeout: 12000 })
    await sleep(400)
    await hideOverlays(page)

    // 滚到底：堆叠条与编号折叠区在这一屏以下
    await page.evaluate(() => {
      const b = document.querySelector('.panel .body')
      b.scrollTop = b.scrollHeight
    })
    await sleep(500)
    const file = `${OUT}/campus-course-detail-lower-${theme}.png`
    await page.screenshot({ path: file })
    console.log(file)

    // 编号折叠：默认折起，量一下初始高度；点开后量展开高度
    const measure = async () =>
      page.evaluate(() => {
        const codes = document.querySelector('.panel .codes')
        const list = codes ? codes.getBoundingClientRect().height : 0
        return { codesH: Math.round(list) }
      })
    const closed = await measure()
    await page.evaluate(() => document.querySelector('.disclosure')?.click())
    await sleep(400)
    await hideOverlays(page)
    const open = await measure()
    const f2 = `${OUT}/campus-course-detail-codes-${theme}.png`
    await page.screenshot({ path: f2 })
    console.log(f2)
    console.log(`  编号区 折起 ${closed.codesH}px → 展开 ${open.codesH}px`)

    await page.close()
  }
} finally {
  await browser.close()
}
