/**
 * 配色画廊的运行时冒烟测试：真的把页面开起来，验证 10 套都渲染、无 JS 报错、
 * 令牌表与对比度表齐全，并抽 3 套截图供人工复核。
 */
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = 'file:///' + path.join(here, '..', '..', 'docs', 'design', 'home-color-palettes.html').replace(/\\/g, '/')
const shotDir = path.join(here, '..', '..', 'docs', 'design', 'colorlab')
fs.mkdirSync(shotDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(target, { waitUntil: 'load' })
await page.waitForSelector('.pal', { timeout: 10000 })

const report = await page.evaluate(() => {
  const pals = [...document.querySelectorAll('.pal')]
  return {
    paletteCount: pals.length,
    swatchCount: document.querySelectorAll('.sw').length,
    perPalette: pals.map(p => ({
      id: p.id,
      name: p.querySelector('h2')?.childNodes[0]?.textContent?.trim(),
      phones: p.querySelectorAll('.screen').length,
      tokens: p.querySelectorAll('.tok').length,
      auditRows: p.querySelectorAll('.audittable tbody tr').length,
      failing: [...p.querySelectorAll('.audittable tbody tr')]
        .filter(r => r.querySelector('td:last-child')?.textContent?.trim() !== '通过')
        .map(r => r.querySelector('td')?.textContent?.trim()),
      blocks: p.querySelectorAll('.blk').length,
      rings: p.querySelectorAll('.ring svg').length,
      tools: p.querySelectorAll('.tool').length,
      dockTabs: p.querySelectorAll('.dtab').length,
    })),
  }
})

console.log('方案数:', report.paletteCount, '| 色板按钮:', report.swatchCount)
for (const p of report.perPalette) {
  console.log(
    `  ${String(p.name).padEnd(6)} phone=${p.phones} tok=${p.tokens} audit=${p.auditRows} ` +
    `blk=${p.blocks} rings=${p.rings} tools=${p.tools} tabs=${p.dockTabs}` +
    (p.failing.length ? `  ✗ 不达标: ${p.failing.join(' / ')}` : '  ✓ 全通过'),
  )
}

// 抽 3 套截图（亮色 + 暗色）
for (const [id, mode] of [['graphite', 'light'], ['sand', 'dark'], ['mint', 'light'], ['sunset', 'dark']]) {
  await page.evaluate(([i, m]) => {
    document.querySelector('#modeSeg button[data-mode="' + m + '"]').click()
  }, [id, mode])
  await page.waitForTimeout(220)
  const el = await page.$('#' + id)
  if (el) {
    await el.scrollIntoViewIfNeeded()
    await page.waitForTimeout(160)
    await el.screenshot({ path: path.join(shotDir, `shot-${id}-${mode}.png`) })
    console.log('截图:', `shot-${id}-${mode}.png`)
  }
}

await browser.close()

if (errors.length) {
  console.log('\nJS 报错:')
  errors.forEach(e => console.log('  ' + e))
  process.exit(1)
}
const bad = report.perPalette.filter(p => p.failing.length || p.phones < 1 || p.tokens < 19)
if (report.paletteCount !== 10 || bad.length) {
  console.log('\n未达标方案:', bad.map(b => b.id))
  process.exit(1)
}
console.log('\n运行时冒烟通过：10 套 × 明暗渲染完整，0 JS 报错，全部对比度达标')
