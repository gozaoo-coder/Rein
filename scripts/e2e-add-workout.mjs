/**
 * 记运动 sheet 运行时实测（浏览器 + mock 后端）。
 * 覆盖：分区切换 / 类型网格 / 时长点输入 / 体感换算 / 手动热量 / 保存落库
 */
import { chromium } from 'playwright-core'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:1430'
let pass = 0
let fail = 0

function ok(cond, msg) {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg)
  } else {
    fail++
    console.log('  ✗ ' + msg)
  }
}

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } })
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('    [console.error] ' + m.text())
})
page.on('pageerror', (e) => console.log('    [pageerror] ' + e.message))

await page.goto(BASE + '/#/sports', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

// 更新弹窗会盖住整页。用 style.display='none' 摘掉（.up-backdrop/.up-card 是 Vue 管理的节点，
// remove() 会破坏 Vue 的 DOM 记账，之后关任何弹层都抛 insertBefore of null）。
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
await page.waitForTimeout(300)

// 打开「手动记」
await page.getByText('手动记', { exact: true }).first().click()
await page.waitForTimeout(600)

console.log('\n[1] 类型选择器')
const groups = await page.locator('.gtag').allTextContents()
ok(groups.length === 6, `6 个分区：${groups.join(' / ')}`)
ok(groups.join(',').includes('球类') && groups.join(',').includes('力量场馆'), '分区含球类/力量场馆')

const firstGroupTypes = await page.locator('.types .chip').allTextContents()
ok(firstGroupTypes.length === 7, `默认「跑跳有氧」7 项：${firstGroupTypes.join('、')}`)

// 切到球类分区
await page.locator('.gtag', { hasText: '球类' }).click()
await page.waitForTimeout(300)
const ballTypes = await page.locator('.types .chip').allTextContents()
ok(ballTypes.length === 7 && ballTypes.includes('羽毛球'), `球类分区 7 项：${ballTypes.join('、')}`)
ok(
  !(await page.locator('.types .chip.on').textContent()).includes('跑步'),
  '切分区后选中态被带过去（不再选着别区的类型）',
)

console.log('\n[2] 选类型 + 时长点输入')
await page.locator('.types .chip', { hasText: '羽毛球' }).click()
await page.waitForTimeout(200)

const kcalOf = () => page.locator('.kcalinput').inputValue()

// 点时长数字 → 直接输入 47
await page.locator('.val-btn').click()
await page.waitForTimeout(200)
const editing = page.locator('.stepper input.edit')
ok(await editing.count() === 1, '时长可点开输入框')
await editing.fill('47')
await editing.press('Enter')
await page.waitForTimeout(400)
ok((await page.locator('.val-btn b').textContent()) === '47', '时长输入 47 生效')

console.log('\n[3] 体感换算热量')
const k1 = Number(await kcalOf())
// 体感 5（累坏了）→ high 档
await page.locator('.effseg .seg-item', { hasText: '累坏了' }).click()
await page.waitForTimeout(300)
const k2 = Number(await kcalOf())
ok(k2 > k1, `体感 3→5 热量上升：${k1} → ${k2}`)

await page.locator('.effseg .seg-item', { hasText: '毫不累' }).click()
await page.waitForTimeout(300)
const k3 = Number(await kcalOf())
ok(k3 < k1, `体感 3→1 热量下降：${k1} → ${k3}`)

// 回适中
await page.locator('.effseg .seg-item', { hasText: '适中' }).click()
await page.waitForTimeout(300)
ok(Number(await kcalOf()) === k1, '回到适中恢复原估算值')

console.log('\n[4] 手动输入实测热量')
ok((await page.locator('.autotag').count()) === 1, '默认显示「估算」标记')
await page.locator('.kcalinput').fill('412')
await page.locator('.kcalinput').blur()
await page.waitForTimeout(300)
ok((await page.locator('.kcalinput').inputValue()) === '412', '手填 412 生效')
ok((await page.locator('.reset').count()) === 1, '出现「回到估算」')
ok(
  (await page.locator('[data-testid="workout-save"]').textContent()).includes('412'),
  '保存按钮同步显示 412',
)

// 改类型/体感不应覆盖手填值
await page.locator('.types .chip', { hasText: '篮球' }).click()
await page.waitForTimeout(300)
ok((await page.locator('.kcalinput').inputValue()) === '412', '改类型后手填值不被覆盖')

// 回估算
await page.locator('.reset').click()
await page.waitForTimeout(300)
const kAfterReset = Number(await kcalOf())
ok(kAfterReset !== 412 && kAfterReset > 0, `回到估算：412 → ${kAfterReset}（篮球档）`)
ok((await page.locator('.autotag').count()) === 1, '「回到估算」后标记复原')

console.log('\n[5] 保存落库')
// 选个体感（4=挺累），这样详情里「体感」格不是默认值，断言才有意义
await page.locator('.effseg .seg-item', { hasText: '挺累' }).click()
await page.waitForTimeout(200)
// 重新手填并保存（改体感后手动值仍在，正好验证「手填不被覆盖」）
await page.locator('.kcalinput').fill('412')
await page.locator('.kcalinput').blur()
await page.waitForTimeout(200)
// 名称留空 → 自动生成
await page.locator('[data-testid="workout-save"]').click()
await page.waitForTimeout(1200)

const subtitle = await page.locator('.page-head .sub, .sub').first().textContent().catch(() => '')
console.log('    运动页副标题: ' + subtitle)

// 打开全部运动记录确认今天多了一条
await page.goto(BASE + '/#/sports/records', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
const names = await page.locator('.tlist .name, .name').allTextContents()
ok(names.some((n) => n.includes('篮球') && n.includes('47分钟')), `记录已落库：${names.slice(0, 4).join(' | ')}`)

// 详情抽屉应显示「体感」而不是「强度」
const row = page.locator('.item', { hasText: '篮球' }).first()
await row.click()
await page.waitForTimeout(900)
const cells = await page.locator('.dgrid .cell').allTextContents()
const cellText = cells.join(' | ')
ok(cellText.includes('体感'), `详情显示体感格：${cellText}`)
ok(cellText.includes('挺累'), '体感值为「挺累」')
ok(!cellText.includes('强度'), '不再显示「强度」格')

await page.screenshot({ path: 'docs/shots/addworkout-detail.png' })

// 回到记运动 sheet 拍主图
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.goto(BASE + '/#/sports', { waitUntil: 'networkidle' })
await page.waitForTimeout(900)
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})
await page.getByText('手动记', { exact: true }).first().click()
await page.waitForTimeout(700)
await page.screenshot({ path: 'docs/shots/addworkout-sheet.png' })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail ? 1 : 0)