/**
 * 容量热力图 + 弱项加练 + 重量曲线轮播的运行时冒烟。
 * 真开 Chrome 点一遍：热力 SVG 上色、排序切换、加练课程组装、轮播与选择抽屉。
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
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('console: ' + m.text())
})

await page.goto(URL + '/#/sports', { waitUntil: 'load' })
await page.waitForTimeout(1500)
// 隐藏首启的更新浮层。⚠️ 用 display:none 而不是 remove() —— 后者是 Vue 管理的节点，
// 摘掉它会破坏 Vue 的 DOM 记账，之后关闭任何弹层都会抛 insertBefore of null（测试自造）。
await page.evaluate(() =>
  document.querySelectorAll('.up-backdrop').forEach((n) => {
    if (n instanceof HTMLElement) n.style.display = 'none'
  }),
)
await page.waitForTimeout(2500)

/* ---------- 1. 容量热力图 ---------- */
const heat = await page.evaluate(() => {
  const card = document.querySelector('[data-testid], .card')
  // 找到含「本周容量」标题的卡
  const cards = [...document.querySelectorAll('.card')]
  const vol = cards.find((c) => c.querySelector('h2')?.textContent?.includes('本周容量'))
  if (!vol) return { found: false, cardTitles: cards.map((c) => c.querySelector('h2')?.textContent?.trim()) }
  const map = vol.querySelector('.mmap')
  const svgs = [...vol.querySelectorAll('.mmap svg')]
  // 统计上色情况：每种热力档位各有多少个分区
  const tally = {}
  for (const el of vol.querySelectorAll('.layer')) {
    for (const c of el.classList) {
      if (/^h[0-4]$/.test(c)) tally[c] = (tally[c] ?? 0) + 1
    }
  }
  const legend = [...vol.querySelectorAll('.heatlegend span')].map((s) => s.textContent.trim())
  return {
    found: true,
    hasMap: !!map,
    viewCount: svgs.length,
    viewBoxes: svgs.map((s) => s.getAttribute('viewBox')),
    tally,
    legend,
    headline: vol.querySelector('.headline')?.textContent?.trim(),
  }
})
console.log('热力图:', JSON.stringify(heat, null, 1))
await page.screenshot({ path: 'docs/design/colorlab/shot-volume-heat.png' })

/* ---------- 2. 排序切换 ---------- */
const sortTest = await page.evaluate(async () => {
  const vol = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('本周容量'),
  )
  const readNames = () => [...vol.querySelectorAll('.vrow .mname')].map((n) => n.textContent.trim())
  const readNums = () =>
    [...vol.querySelectorAll('.vrow .mnum')].map((n) => parseFloat(n.textContent.trim()))
  const label = () => vol.querySelector('.lh-t')?.textContent?.trim()
  const before = { label: label(), nums: readNums() }
  const btn = vol.querySelector('.sortbtn')
  btn.click()
  await new Promise((r) => setTimeout(r, 400))
  const after = { label: label(), nums: readNums(), names: readNames() }
  btn.click()
  await new Promise((r) => setTimeout(r, 400))
  const back = { label: label(), nums: readNums() }
  const mono = (a, cmp) => a.every((v, i) => i === 0 || cmp(a[i - 1], v))
  return {
    beforeLabel: before.label,
    descOk: mono(before.nums, (a, b) => a >= b),
    afterLabel: after.label,
    ascOk: mono(after.nums, (a, b) => a <= b),
    backLabel: back.label,
    backToDesc: mono(back.nums, (a, b) => a >= b),
    rows: after.names.length,
  }
})
console.log('排序切换:', JSON.stringify(sortTest))

/* ---------- 3. 弱项加练 ---------- */
const catchup = await page.evaluate(async () => {
  const vol = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('本周容量'),
  )
  const btn = vol.querySelector('.catchup')
  if (!btn) return { buttonFound: false }
  const label = btn.textContent.replace(/\s+/g, ' ').trim()
  btn.click()
  await new Promise((r) => setTimeout(r, 1200))
  const sheet = document.querySelector('.sheet, [role="dialog"]')
  const weakRows = [...document.querySelectorAll('.wrow')].map((r) => ({
    name: r.querySelector('.wname')?.textContent.trim(),
    gap: r.querySelector('.wgap')?.textContent.trim(),
    ex: r.querySelector('.wex')?.textContent.trim(),
    muted: r.classList.contains('muted'),
  }))
  const draftRows = [...document.querySelectorAll('.drow')].map((r) => ({
    name: r.querySelector('.dname')?.textContent.trim(),
    sets: r.querySelector('.dsets')?.textContent.trim(),
  }))
  const acts = [...document.querySelectorAll('.acts button')].map((b) => ({
    label: b.textContent.replace(/\s+/g, ' ').trim(),
    disabled: b.disabled,
  }))
  return { buttonFound: true, label, sheetShown: !!sheet, weakRows, draftRows, acts }
})
console.log('弱项加练:', JSON.stringify(catchup, null, 1))
await page.screenshot({ path: 'docs/design/colorlab/shot-catchup.png' })

// 关掉 sheet
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  const x = btns.find((b) => b.getAttribute('aria-label')?.includes('关闭'))
  x?.click()
})
await page.waitForTimeout(700)

/* ---------- 4. 重量曲线：轮播 + 选择抽屉 ---------- */
const curve0 = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('重量曲线'),
  )
  if (!card) return { found: false }
  return {
    found: true,
    name: card.querySelector('.pname')?.textContent?.trim(),
    rotating: card.querySelector('.rotate')?.getAttribute('aria-pressed'),
    hasArrows: !!card.querySelector('.arrow'),
    dots: card.querySelectorAll('.curve svg circle').length,
  }
})
console.log('曲线初始:', JSON.stringify(curve0))

// 点箭头翻页
const afterNext = await page.evaluate(async () => {
  const card = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('重量曲线'),
  )
  const before = card.querySelector('.pname')?.textContent?.trim()
  const arrows = card.querySelectorAll('.arrow')
  arrows[arrows.length - 1].click()
  await new Promise((r) => setTimeout(r, 900))
  return { before, after: card.querySelector('.pname')?.textContent?.trim() }
})
console.log('箭头翻页:', JSON.stringify(afterNext))

// 打开选择抽屉
const picker = await page.evaluate(async () => {
  const card = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('重量曲线'),
  )
  card.querySelector('.pickbtn').click()
  await new Promise((r) => setTimeout(r, 900))
  const rows = [...document.querySelectorAll('.prow')]
  return {
    open: rows.length > 0,
    count: rows.length,
    countLabel: document.querySelector('.count')?.textContent?.trim(),
    first: rows.slice(0, 4).map((r) => ({
      name: r.querySelector('.pname')?.textContent.trim(),
      meta: r.querySelector('.pmeta')?.textContent.trim(),
      checked: !!r.querySelector('.pcheck'),
    })),
    hasSearch: !!document.querySelector('.finder input'),
  }
})
console.log('选择抽屉:', JSON.stringify(picker, null, 1))
await page.screenshot({ path: 'docs/design/colorlab/shot-curve-picker.png' })

// 搜索 + 选中
const picked = await page.evaluate(async () => {
  const input = document.querySelector('.finder input')
  const rowsAll = [...document.querySelectorAll('.prow')]
  const target = rowsAll[rowsAll.length - 1]?.querySelector('.pname')?.textContent.trim()
  input.value = target?.slice(0, 2) ?? ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 600))
  const filtered = document.querySelectorAll('.prow').length
  const first = document.querySelector('.prow')
  first?.click()
  await new Promise((r) => setTimeout(r, 1200))
  const card = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('重量曲线'),
  )
  return { target, filtered, nowShowing: card?.querySelector('.pname')?.textContent?.trim() }
})
console.log('搜索并选中:', JSON.stringify(picked))

/* ---------- 5. 轮播暂停 ---------- */
const rot = await page.evaluate(async () => {
  const card = [...document.querySelectorAll('.card')].find((c) =>
    c.querySelector('h2')?.textContent?.includes('重量曲线'),
  )
  const btn = card.querySelector('.rotate')
  const before = btn.getAttribute('aria-pressed')
  btn.click()
  await new Promise((r) => setTimeout(r, 200))
  return { before, after: btn.getAttribute('aria-pressed'), label: btn.textContent.trim() }
})
console.log('轮播开关:', JSON.stringify(rot))

await browser.close()
console.log('\nJS 报错:', errors.length ? errors.slice(0, 8) : '无')
