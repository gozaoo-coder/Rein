/**
 * 记运动 sheet **初始档**截图（用户真正第一眼看到的那个状态）。
 *
 * 展开档（shot-addworkout.mjs）只证明「拖到底不丑」，而用户一打开看到的是 medium 档：
 * 如果「消耗」这张结果卡被压在折叠线以下，那这张抽屉的主角就白设计了。
 * 这里量三件事：结果卡顶端相对抽屉内容区顶部的偏移、抽屉可视区高度、结果卡是否可见。
 */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})

for (const width of [430, 375]) {
  const page = await browser.newPage({ viewport: { width, height: 932 } })
  await page.goto('http://localhost:1430/#/sports', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    for (const sel of ['.up-backdrop', '.up-card']) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
  })
  await page.getByText('手动记', { exact: true }).first().click()
  await page.waitForTimeout(900)

  const m = await page.locator('.panel').evaluate((panel) => {
    const body = panel.querySelector('.body')
    const br = body.getBoundingClientRect()
    const result = panel.querySelector('.result').getBoundingClientRect()
    const save = panel.querySelector('.save').getBoundingClientRect()
    return {
      panelH: Math.round(panel.getBoundingClientRect().height),
      bodyViewH: Math.round(br.height),
      // 结果卡底边相对内容区可视底边的位置：负=被折叠线切掉
      resultBottomInView: Math.round(br.bottom - result.bottom),
      resultTop: Math.round(result.top),
      resultH: Math.round(result.height),
      scrollable: body.scrollHeight > body.clientHeight,
      scrollH: body.scrollHeight,
      clientH: body.clientHeight,
      saveVisible: save.bottom <= panel.getBoundingClientRect().bottom,
    }
  })

  console.log(`\n===== 视口宽 ${width}（打开时的初始档）=====`)
  console.log(`  抽屉高: ${m.panelH} / 内容可视区高: ${m.bodyViewH}`)
  console.log(`  结果卡: 高 ${m.resultH}，顶端 y=${m.resultTop}`)
  console.log(
    `  结果卡是否完整可见: ${m.resultBottomInView >= 0 ? '是' : `否（还差 ${-m.resultBottomInView}px）`}`,
  )
  console.log(`  内容需滚动: ${m.scrollable}（scrollH ${m.scrollH} / clientH ${m.clientH}）`)
  console.log(`  保存钮可见: ${m.saveVisible}`)
  console.log(`  折叠线以下还有多少内容: ${Math.round(m.scrollH - m.clientH)}px`)

  await page.screenshot({ path: `docs/shots/addworkout-initial-${width}.png` })
  await page.close()
}

await browser.close()
