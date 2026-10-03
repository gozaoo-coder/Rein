/**
 * 记运动 sheet 的**布局体检**（不是对比度，那个在 colorlab/audit_add_workout.mjs）。
 *
 * 量的是「眼睛能看到但类型检查查不出来」的那类问题：
 * 文字截断 / 换行、点按热区不够 44px、抽屉里大片用不上的留白、
 * 以及各区块在纵轴上到底占了多高（谁才是主角一目了然）。
 */
import { chromium } from 'playwright-core'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await chromium.launch({ executablePath: EXE, headless: true })

for (const width of [430, 375]) {
  const page = await browser.newPage({ viewport: { width, height: 932 } })
  await page.goto('http://localhost:1430/#/sports', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    for (const s of ['.up-backdrop', '.up-card'])
      for (const e of document.querySelectorAll(s)) e.style.display = 'none'
  })
  await page.getByText('手动记', { exact: true }).first().click()
  await page.waitForTimeout(600)
  // 拉到最大档，让所有字段进入视口
  const h = await page.locator('.grabber-zone').boundingBox()
  await page.mouse.move(h.x + h.width / 2, h.y + 10)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2, 100, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(800)

  const r = await page.evaluate(() => {
    const out = {}
    // **作用域锁死在抽屉面板内**：SheetModal 是 Teleport 到 <body> 的，
    // 页面上还挂着别的 .seg-item（如视图切换「列表/时间线」），不限定会量到别人的组件，
    // 报错时看着像自己的问题。
    const root = document.querySelector('.panel')
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }
    }

    // 1) 文字截断 / 换行：类型 chip 与分区 tag
    //
    // 换行**不能用 offsetHeight 猜**（原先写的是 `offsetHeight > 46`）：
    // 分区胶囊单行约 27px、折成两行约 42px —— 42 < 46，于是
    // 「跑跳有氧」在 375px 上断成「跑跳有」/「氧」时审计照样报「文字问题: []」。
    // 正解是让浏览器数**行盒**：Range.getClientRects() 每个行盒给一个矩形。
    const lineCount = (el) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      return r.getClientRects().length
    }
    const trunc = []
    for (const el of root.querySelectorAll('.chip, .gtag, .seg-item')) {
      const cls = el.classList.contains('chip')
        ? '类型chip'
        : el.classList.contains('gtag')
          ? '分区tag'
          : '体感段'
      const name = el.textContent.trim()
      if (el.scrollWidth > el.clientWidth + 1) trunc.push(`${cls}「${name}」被截断`)
      const n = lineCount(el)
      if (n > 1) trunc.push(`${cls}「${name}」折成 ${n} 行`)
    }
    out.文字问题 = trunc

    // 2) 点按热区：44px 是苹果的下限。
    //    **不能用 getBoundingClientRect 量** —— 撑热区的 ::after 伪元素不计入元素自身矩形，
    //    量出来永远是「视觉尺寸」。真实热区要用命中测试问浏览器：
    //    从中心向上下各探，看最远能探到哪里仍命中本元素。
    const small = []
    const hit = (el, dy) => {
      const b = el.getBoundingClientRect()
      if (b.top + dy < 0 || b.bottom + dy > window.innerHeight) return false
      const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2 + dy)
      return !!t && (t === el || el.contains(t) || t.contains(el))
    }
    for (const el of root.querySelectorAll('.chip, .gtag, .seg-item, .kcalinput, .save')) {
      let up = 0
      let down = 0
      while (up < 30 && hit(el, -(up + 1))) up++
      while (down < 30 && hit(el, down + 1)) down++
      const total = up + down + el.getBoundingClientRect().height
      if (total < 44) {
        small.push(
          `${el.className.split(' ')[0]}「${el.textContent.trim().slice(0, 6)}」热区仅 ${Math.round(total)}px`,
        )
      }
    }
    out.热区不足44 = small

    // 3) 纵轴占用：谁是主角
    const secs = [...root.querySelectorAll('.sec')].map((el) => ({
      标题: el.querySelector('.seclabel')?.textContent.trim().split('\n')[0].slice(0, 10) ?? '(无)',
      高: Math.round(el.getBoundingClientRect().height),
    }))
    out.各区块高度 = secs

    // 4) 留白：内容末尾 → 固定操作区顶部（.body 是 flex:1，撑不满就留白）
    const body = root.querySelector('.body')
    const hint = root.querySelector('.hint')
    const foot = root.querySelector('.foot')
    out.内容末尾到操作区 = hint && foot
      ? Math.round(foot.getBoundingClientRect().top - hint.getBoundingClientRect().bottom)
      : null
    out.内容是否需要滚动 = body ? body.scrollHeight > body.clientHeight + 1 : null
    out.滚动余量 = body ? body.scrollHeight - body.clientHeight : null

    // 5) 分区 tag 占了几行
    const gtags = [...root.querySelectorAll('.gtag')]
    const rows = new Set(gtags.map((e) => Math.round(e.getBoundingClientRect().top)))
    out.分区占行数 = rows.size
    out.类型chip宽 = Math.round(root.querySelector('.chip')?.getBoundingClientRect().width ?? 0)
    return out
  })

  console.log(`\n===== 视口宽 ${width} =====`)
  for (const [k, v] of Object.entries(r)) console.log('  ' + k + ': ' + JSON.stringify(v))
  await page.close()
}

await browser.close()