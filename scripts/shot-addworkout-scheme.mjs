/**
 * 记运动 sheet 暗色态截图。
 *
 * 对比度审计（colorlab/audit_add_workout.mjs）只验证「文字与底色的比值达标」，
 * 它读的是渲染像素，但**不看观感** —— 比如结果卡的 --surface-2 在暗色下与抽屉
 * 面板底（--surface）只差一点点时，那张「结果卡」就退化成一团看不见的东西，
 * 而对比度数值照样全绿。这一步专门盯这个。
 */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})

for (const scheme of ['dark', 'light']) {
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 },
    colorScheme: scheme,
  })
  await page.goto('http://localhost:1430/#/sports', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    for (const sel of ['.up-backdrop', '.up-card']) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
  })
  await page.getByText('手动记', { exact: true }).first().click()
  await page.waitForTimeout(900)

  // 结果卡 / 抽屉底 的实际色差：暗色下如果两者太近，卡就"消失"了
  // 注意 .types .chip 的首个匹配就是默认选中的「跑步」，未选态必须显式排除 .on
  const layers = await page.locator('.panel').evaluate((panel) => {
    const cs = (el) => (el ? getComputedStyle(el).backgroundColor : '(无此节点)')
    return {
      面板底: cs(panel),
      结果卡底: cs(panel.querySelector('.result')),
      未选chip底: cs(panel.querySelector('.types .chip:not(.on)')),
      已选chip底: cs(panel.querySelector('.types .chip.on')),
      未选分区底: cs(panel.querySelector('.gtag:not(.on)')),
      名称框底: cs(panel.querySelector('.namefield')),
      底栏底: cs(panel.querySelector('.foot')),
    }
  })
  console.log(`\n===== ${scheme} =====`)
  for (const [k, v] of Object.entries(layers)) console.log(`  ${k}: ${v}`)

  await page.screenshot({ path: `docs/shots/addworkout-${scheme}.png` })
  await page.close()
}

await browser.close()
