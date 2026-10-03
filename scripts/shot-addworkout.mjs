/** 记运动 sheet 展开档截图（内容比一屏高，默认档只露出顶部） */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
await page.goto('http://localhost:1430/#/sports', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
await page.getByText('手动记', { exact: true }).first().click()
await page.waitForTimeout(700)

// 拖到最大档
const handle = page.locator('.grabber-zone')
const box = await handle.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + 10)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2, 100, { steps: 12 })
await page.mouse.up()
// 等抽屉高度的 320ms 过渡走完再截，否则拍到的是动画中间帧
await page.waitForTimeout(900)

const h = await page.locator('.panel').evaluate((el) => el.getBoundingClientRect().height)
console.log('展开后抽屉高度: ' + Math.round(h))
console.log('底部保存条存在: ' + (await page.locator('.foot').count()))
await page.screenshot({ path: 'docs/shots/addworkout-large.png' })

// 滚到底看表单尾部（.body 全局有 6 个同名节点，必须限定在抽屉内）
await page.locator('.panel .body').evaluate((el) => el.scrollTo(0, el.scrollHeight))
await page.waitForTimeout(500)
await page.screenshot({ path: 'docs/shots/addworkout-bottom.png' })

await browser.close()