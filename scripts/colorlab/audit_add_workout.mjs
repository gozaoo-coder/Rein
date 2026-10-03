/**
 * 对比度实测 · 记运动 sheet（像素级）。
 *
 * ## 三个坑，按踩到的顺序
 *
 * 1. **拿 rgba() 的原始分量算亮度** → 假警报。半透明底（如 `--accent-soft`
 *    = 12% 蓝）必须先合成到不透明底再算，否则得到「1.3:1」这种观感上不存在的数。
 * 2. **半透明层当终止条件** → 也会算错。抽屉 `.panel` 是 `rgba(28,28,30,0.84)`，
 *    停在它这层再拿白色兜底，等于把暗色画布当白纸。
 * 3. **直接对截图中心点取样当背景** → 中心点上是文字！文字像素和底色混在一起，
 *    读出来的底色是「白字 + 蓝底」的混合值，算出 1.79:1 这种假警报
 *    （同一个按钮合成模型算得 4.78:1）。**这是本脚本第一版的错**。
 *
 * 所以：先把文字设为透明再截图，量到的就是纯底色 —— 看到的就是眼睛看到的。
 *
 * 用法：node scripts/colorlab/audit_add_workout.mjs   （需先起 vite 于 1430）
 */
import { chromium } from 'playwright-core'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:1430/#/sports'

/** [说明, 前景元素, 背景取样元素, 门槛] */
const TARGETS = [
  ['热量数字', '.kcalinput', '.kcalinput', 4.5],
  ['保存钮文字', '[data-testid="workout-save"]', '[data-testid="workout-save"]', 4.5],
  ['分区选中文字', '.gtag.on', '.gtag.on', 4.5],
  ['分区未选文字', '.gtag:not(.on)', '.gtag:not(.on)', 4.5],
  ['类型选中文字', '.chip.on', '.chip.on', 4.5],
  ['类型未选文字', '.chip:not(.on)', '.chip:not(.on)', 4.5],
  // SegmentedControl 的根元素**就是** .seg（class 透传落在它身上，.thumb 与 .seg-item
// 是它的子节点）—— 所以量滑块/轨道要用它自身，不能写成后代选择器（那样一条都命不中）
['体感选中文字', '.effseg .seg-item.on', '.effseg .thumb', 4.5],
  // 未选项没有自己的底（透明），量到的是控件的 --surface-2 轨道：字与底分属两个元素
  ['体感未选文字', '.effseg .seg-item:not(.on)', '.effseg', 4.5],
  ['说明文字（三级）', '.hint', '.panel', 3],
  ['「估算」标记（三级）', '.autotag', '.panel', 3],
  ['时长数字', '.val-btn', '.panel', 4.5],
]

/**
 * 页面内：给一组选择器上「文字透明」标记，返回每项的前景色（实拍前先记下）。
 *
 * 文字用 text-fill-color 抹掉而不是 opacity —— opacity 会把背景一起变淡，
 * 量出来的底色就不是它真实的样子了。
 */
const PREP = (pairs) => {
  const out = []
  for (const [fgSel, bgSel] of pairs) {
    const fg = document.querySelector(fgSel)
    const bg = document.querySelector(bgSel)
    if (!fg || !bg) {
      out.push(null)
      continue
    }
    const m = getComputedStyle(fg).color.match(/[\d.]+/g).map(Number)
    out.push([m[0], m[1], m[2]])
    fg.style.setProperty('-webkit-text-fill-color', 'transparent', 'important')
    fg.style.setProperty('color', 'transparent', 'important')
  }
  return out
}

/** 页面内：报出每个背景元素中心点的**设备像素**坐标（截图按 dpr 缩放过） */
const CENTERS = (sels) =>
  sels.map((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return [
      Math.round((r.left + r.width / 2) * dpr),
      Math.round((r.top + r.height / 2) * dpr),
    ]
  })

/* ---------------- PNG 解码（Node 侧，避开 evaluate 的传参体积上限） ---------------- */

import { inflateSync } from 'node:zlib'

/** Playwright 截图是 8bit RGBA/RGB、非隔行 —— 解它只需 IHDR + IDAT + 反滤波 */
function decodePng(buf) {
  let off = 8 // 跳过签名
  let w = 0
  let h = 0
  let channels = 4
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      const colorType = data[9]
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
      if (channels === 0) throw new Error('暂不支持调色板/灰度 PNG（截图不该是这种）')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const px = Buffer.alloc(h * stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        // Paeth
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return { w, h, channels, px }
}

/** 取样点为中心 7×7 的平均色（避开抗锯齿边） */
function sampleAt(img, cx, cy) {
  let R = 0
  let G = 0
  let B = 0
  let n = 0
  for (let y = cy - 3; y <= cy + 3; y++) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue
      const i = (y * img.w + x) * img.channels
      R += img.px[i]
      G += img.px[i + 1]
      B += img.px[i + 2]
      n++
    }
  }
  return [Math.round(R / n), Math.round(G / n), Math.round(B / n)]
}

const lum = (c) => {
  const f = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const failures = []

for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, colorScheme: scheme })
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    for (const s of ['.up-backdrop', '.up-card'])
      for (const e of document.querySelectorAll(s)) e.style.display = 'none'
  })
  await page.getByText('手动记', { exact: true }).first().click()
  await page.waitForTimeout(800)
  // 拉到最大档，让所有字段进入视口
  const h = await page.locator('.grabber-zone').boundingBox()
  await page.mouse.move(h.x + h.width / 2, h.y + 10)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2, 100, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(900)

  const pairs = TARGETS.map(([, fg, bg]) => [fg, bg])
  const fgColors = await page.evaluate(PREP, pairs)
  const centers = await page.evaluate(CENTERS, pairs.map((p) => p[1]))
  const img = decodePng(await page.screenshot())
  const bgColors = centers.map((c) => (c ? sampleAt(img, c[0], c[1]) : null))
  // 恢复文字（后续不再截图，仅防影响交互）
  await page.reload({ waitUntil: 'networkidle' })

  console.log(`\n[${scheme}]`)
  TARGETS.forEach(([label, fgSel, bgSel, min], i) => {
    const fg = fgColors[i]
    const bg = bgColors[i]
    if (!fg || !bg) {
      console.log(`  ? ${label}（选择器未命中）`)
      return
    }
    const r = ratio(fg, bg)
    const pass = r >= min
    if (!pass) failures.push(`${scheme} / ${label}: ${r.toFixed(2)}:1 < ${min}`)
    console.log(
      `  ${pass ? '✓' : '✗'} ${label}: ${r.toFixed(2)}:1（门槛 ${min}）  文字 rgb(${fg}) / 底 rgb(${bg})`,
    )
  })
  await page.close()
}

await browser.close()
console.log(`\n不达标 ${failures.length} 项`)
for (const f of failures) console.log('  · ' + f)
process.exit(failures.length ? 1 : 0)