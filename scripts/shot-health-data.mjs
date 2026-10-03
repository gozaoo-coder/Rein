/**
 * 第三方数据管理页（/settings/health）UI 修复后的截图验证。
 *
 * 背景：该页 scoped 样式漏写了 `.page` 内边距与 `.gtitle` 分组标题（两者全局无兜底），
 * h2 退化成浏览器默认 1.5em 大黑标题、卡片顶边贴屏。修复后核对：
 *   1. 页面左右有留白（卡片不贴屏）
 *   2. gtitle 字号回到 footnote 档（不是浏览器默认的 24px）
 *   3. 末张卡不被 Dock 遮死（--page-pad-bottom 生效）
 */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})

const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
await page.goto('http://localhost:1430/#/settings/health', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
// 隐藏弹层（更新提示等）：只能 display='none'，不能 remove()（Vue DOM 记账会被破坏）
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card', '.modal', '.dialog', '.overlay', '[class*="backdrop"]']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})

const m = await page.evaluate(() => {
  const g = (sel) => document.querySelector(sel)
  const title = g('.page .gtitle')
  const card = g('.page .card')
  const pageEl = g('.page')
  const ts = title ? getComputedStyle(title) : null
  const cardR = card ? card.getBoundingClientRect() : null
  const lastCard = [...document.querySelectorAll('.page .card')].pop()
  return {
    gtitleFontSize: ts?.fontSize,
    gtitleWeight: ts?.fontWeight,
    gtitleColor: ts?.color,
    cardLeft: cardR ? Math.round(cardR.left) : null,
    pagePadLeft: pageEl ? getComputedStyle(pageEl).paddingLeft : null,
    pagePadBottom: pageEl ? getComputedStyle(pageEl).paddingBottom : null,
    lastCardBottom: lastCard ? Math.round(lastCard.getBoundingClientRect().bottom) : null,
    viewportH: window.innerHeight,
  }
})

console.log('===== 第三方数据管理页 · 布局核对 =====')
console.log(`  gtitle 字号: ${m.gtitleFontSize}（期望 13px footnote 档）/ 字重: ${m.gtitleWeight}`)
console.log(`  gtitle 颜色: ${m.gtitleColor}（期望 --text-2 次级灰，不是纯黑）`)
console.log(`  首卡左边距: ${m.cardLeft}px / .page padding-left: ${m.pagePadLeft}（期望 > 0）`)
console.log(`  .page padding-bottom: ${m.pagePadBottom}（期望 > 0）`)
console.log(`  末卡底边: ${m.lastCardBottom} / 视口高: ${m.viewportH}`)

await page.screenshot({ path: 'docs/shots/health-data-page.png' })
await page.close()
await browser.close()
