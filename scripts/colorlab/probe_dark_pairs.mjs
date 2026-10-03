/** 暗色下候选令牌组合实测：给「已选态」选一对真达标的 */
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: 'dark' })
await page.goto('http://localhost:1430/#/sports', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.evaluate(() => {
  for (const s of ['.up-backdrop', '.up-card'])
    for (const e of document.querySelectorAll(s)) e.style.display = 'none'
})
await page.getByText('手动记', { exact: true }).first().click()
await page.waitForTimeout(700)

const out = await page.evaluate(() => {
  function parse(c) {
    if (!c) return { r: 0, g: 0, b: 0, a: 0 }
    const s = c.trim()
    // 自定义属性在 getComputedStyle 里返回**声明原值**（十六进制 / rgba 记法），
    // 不像标准属性那样已经算成 rgb() —— 两种都要认
    if (s.startsWith('#')) {
      const h = s.slice(1)
      const n = h.length === 3 ? [...h].map((x) => x + x).join('') : h
      return { r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16), a: 1 }
    }
    const m = s.match(/[\d.]+/g)
    if (!m) return { r: 0, g: 0, b: 0, a: 0 }
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 }
  }
  function over(fg, bg) {
    return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 }
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  function ratio(a, b) { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  const v = (n) => parse(getComputedStyle(document.documentElement).getPropertyValue(n).trim() || 'rgb(0,0,0)')
  const S = v('--surface'), S2 = v('--surface-2')
  const r = (fg, bg) => (fg.a < 1 ? ratio(over(fg, bg), bg) : ratio(fg, bg)).toFixed(2)
  return {
    'accent-strong / accent-soft@surface': r(v('--accent-strong'), over(v('--accent-soft'), S)),
    'accent-strong / surface-2': r(v('--accent-strong'), S2),
    'on-accent(白) / accent': r(v('--on-accent'), v('--accent')),
    '深墨 #0b1a2f / accent': r(parse('rgb(11,26,47)'), v('--accent')),
    'on-accent(白) / ok': r(v('--on-accent'), v('--ok')),
    '深墨 / ok': r(parse('rgb(11,26,47)'), v('--ok')),
    'c-exercise-deep / surface-2(暗)': r(v('--c-exercise-deep'), S2),
    'c-exercise-deep / surface(暗)': r(v('--c-exercise-deep'), S),
    'text-2 / surface-2(暗)': r(v('--text-2'), S2),
    'text-3 / surface(暗)': r(v('--text-3'), S),
    'text-3 / surface-2(暗)': r(v('--text-3'), S2),
    'accent-strong / surface(暗)': r(v('--accent-strong'), S),
    'ok-strong / ok-soft@surface': r(v('--ok-strong'), over(v('--ok-soft'), S)),
  }
})
for (const [k, val] of Object.entries(out)) console.log('  ' + k.padEnd(38) + val + ':1')
await browser.close()