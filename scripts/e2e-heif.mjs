#!/usr/bin/env node
/**
 * HEIC 附图端到端：在开发服务器（非 Tauri ⇒ mock 后端）上真的选中一张 HEIC，
 * 看图能不能变成可发送的附图芯片。
 *
 * 跑这条用例走的是**软件解码**那条路（浏览器没有原生 HEIF 解码），
 * 原生侧那条由 `cargo test --lib media::wic` 守着，两边合起来才是完整的支持。
 *
 * 用法：先启 `npx vite --port 1430 --strictPort false`，再 `node scripts/e2e-heif.mjs`
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:1430'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'resources', 'test', 'heic', 'sample.heic')

let failed = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed += 1
}

if (!existsSync(SAMPLE)) {
  console.error(`缺样例 ${SAMPLE}，先跑 npm run heic:fixture`)
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(`${BASE}/#/ai`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.composer', { timeout: 20000 })

// 图库入口是多选那个 input；直接给它喂文件，等价于用户选了一张 HEIC
const gallery = await page.$('input[type=file][multiple]')
check('存在图库选图入口', !!gallery)
const accept = await gallery?.getAttribute('accept')
check('选图 accept 含 HEIC', /\.heic/.test(accept ?? ''), accept ?? '(空)')

await gallery.setInputFiles(SAMPLE)
await page.waitForSelector('.attach-row .attach-chip img', { timeout: 30000 })

const img = await page.$('.attach-row .attach-chip img')
const src = await img.getAttribute('src')
check('附图芯片出现', !!src && src.startsWith('data:image/jpeg;base64,'))
const bytes = Math.round(((src?.length ?? 0) - 'data:image/jpeg;base64,'.length) * 0.75)
check('解码出 JPEG 且体积合理', bytes > 2000, `${bytes} 字节`)

// 真能画出来才是真解出来了（破损 ≤ base64 也会非空）
const decoded = await img.evaluate((el) => ({
  w: el.naturalWidth,
  h: el.naturalHeight,
  complete: el.complete,
}))
check('浏览器能渲染这张缩略图', decoded.complete && decoded.w > 0 && decoded.h > 0, `${decoded.w}x${decoded.h}`)

check('没有未捕获的页面异常', errors.length === 0, errors.join(' | ').slice(0, 200))

// 回归：普通 JPEG 还得照旧好使（别为了 HEIF 把主路径改坏）。
// 直接在页面里画一张再塞回 file input，避免为一条用例往仓库里塞二进制。
await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 48
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#12b3d6'
  ctx.fillRect(0, 0, c.width, c.height)
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
  const file = new File([blob], 'plain.jpg', { type: 'image/jpeg' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const el = document.querySelector('input[type=file][multiple]')
  el.files = dt.files
  el.dispatchEvent(new Event('change'))
})
await page.waitForFunction(
  () => document.querySelectorAll('.attach-row .attach-chip').length === 2,
  { timeout: 15000 },
)
check('普通 JPEG 仍能累积成第二张附图（主路径未回退）', true)

await page.screenshot({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-ui-shots', 'heic-attach.png') })
await browser.close()
console.log(failed === 0 ? '\nHEIC 附图链路 ✓' : `\n${failed} 项未通过`)
process.exit(failed > 0 ? 1 : 0)
