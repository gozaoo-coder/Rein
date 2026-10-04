/**
 * 记账页布局取证 + 断言。
 *
 * 起因：用户截图里「搜索备注 / 分类胶囊 / 空态卡 / 记一笔悬浮钮」糊在一起。
 * 那个窗口实测是 393×781（Tauri minWidth 390 / minHeight 640，用户把窗口缩小了），
 * 所以这里按 390×608（可行下限）/393×749（实测）/430×932（默认）/桌面 四档跑。
 *
 * 断言（全绿才算过）：
 *   A. 没有任何 fixed 浮层压住文字（悬浮钮已取消，这条是回归护栏）
 *   B. 滚到底后内容完整露出（不被 dock 压住）
 *   C. 没有横向溢出（.chips 自己滚是自己的事，页面不许被撑宽）
 *   D. 页头副标题单行且不被截断（折行会把页头顶到 98px，月份切换器被挤到第二行旁）
 *   E. 「记一笔」入口恒为 1 处（有流水在筛选条右端 / 没有在空态卡里），且完整可见
 *
 * 用法：
 *   node scripts/shot-ledger.mjs            # mock 自带数据（本月若干条）
 *   node scripts/shot-ledger.mjs --empty    # 先删光流水，看空态
 *   node scripts/shot-ledger.mjs --empty --dark
 *   W=430 H=932 node scripts/shot-ledger.mjs --empty
 */
import { chromium } from 'playwright-core'

const empty = process.argv.includes('--empty')
const dark = process.argv.includes('--dark')
const tag = `${empty ? 'empty' : 'full'}${dark ? '-dark' : ''}`

const SIZES = process.env.W
  ? [[Number(process.env.W), Number(process.env.H ?? 932)]]
  : [
      [390, 608],
      [393, 749],
      [430, 932],
      [1280, 860],
    ]

/** 端口可配（1420/1430 常入 Windows 排除段报 EACCES）：REIN_E2E_URL 指向已起服的实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})

let failed = 0

for (const [width, height] of SIZES) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  if (dark) await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${APP}/#/ledger`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1100)
  await hideOverlays(page)

  if (empty) {
    // reload 不行：mock 是模块级内存态，刷新会重新 seed。删完用月份箭头逼 store 重拉。
    const n = await page.evaluate(async () => {
      const mod = await import('/src/mock/server.ts')
      const list = await mod.mockInvoke('list_ledger_entries', {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      })
      for (const e of list) await mod.mockInvoke('delete_ledger_entry', { id: e.id })
      return list.length
    })
    await page.locator('.month .nav').first().click()
    await page.waitForTimeout(400)
    await page.locator('.month .nav').last().click()
    await page.waitForTimeout(600)
    await hideOverlays(page)
    if (width === SIZES[0][0]) console.log(`（已删光流水 ${n} 条）`)
  }

  const m = await page.evaluate(measure)
  report(width, height, m)

  // 滚到底：内容要能从 dock 底下完整露出来
  await page.evaluate(() => window.scrollTo(0, 1e6))
  await page.waitForTimeout(400)
  const tail = await page.evaluate(measure)
  check(
    `${width}×${height} 滚到底 · 内容不被 dock 压住`,
    tail.dockTop === null || tail.contentBottom <= tail.dockTop,
    `内容底 ${tail.contentBottom} vs dock 顶 ${tail.dockTop}`,
  )
  check(`${width}×${height} 滚到底 · 无浮层压文字`, tail.hitText.length === 0, tail.hitText.join(' / '))
  await page.screenshot({ path: `docs/shots/ledger-${tag}-${width}x${height}-bottom.png` })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `docs/shots/ledger-${tag}-${width}x${height}.png` })
  await page.close()
}

/* ---------- 流程 smoke：空态 → 卡内「记一笔」→ 有流水 ----------
   主操作的落点在这一步会整体切换（卡内按钮 ↔ 筛选条按钮），是这次改动最容易断的地方：
   只量静态矩形看不出「点了没反应 / 记完还是空态」。 */
if (!process.env.W) await smoke()

async function smoke() {
  const page = await browser.newPage({ viewport: { width: 393, height: 749 }, deviceScaleFactor: 2 })
  await page.goto(`${APP}/#/ledger`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1100)
  await hideOverlays(page)
  await page.evaluate(async () => {
    const mod = await import('/src/mock/server.ts')
    const list = await mod.mockInvoke('list_ledger_entries', { startDate: '2026-01-01', endDate: '2026-12-31' })
    for (const e of list) await mod.mockInvoke('delete_ledger_entry', { id: e.id })
  })
  await page.locator('.month .nav').first().click()
  await page.waitForTimeout(400)
  await page.locator('.month .nav').last().click()
  await page.waitForTimeout(700)
  await hideOverlays(page)

  console.log('\n===== 流程 smoke（393×749：空态 → 记一笔 → 有流水）=====')
  const before = await page.evaluate(measure)
  check('空态：卡内「记一笔」在、筛选条收起', before.addCount === 1 && !before.filtersShown)
  check('空态：没有 fixed 悬浮钮', before.overlays.length === 0, before.overlays.join(', '))
  check('空态：卡内按钮在空态卡里', await page.locator('.card .add-inline').count() === 1)

  await page.locator('.card .add-inline').click()
  await page.waitForTimeout(700)
  check('点卡内按钮 → 记一笔抽屉打开', (await page.locator('.panel').count()) > 0)

  for (const k of ['3', '2', '5']) {
    await page.locator(`.key[aria-label="数字 ${k}"]`).click()
    await page.waitForTimeout(120)
  }
  await page.locator('.panel .save').click()
  await page.waitForTimeout(900)
  await hideOverlays(page)

  const after = await page.evaluate(measure)
  check('保存后 → 抽屉关闭', (await page.locator('.panel:visible').count()) === 0)
  check('保存后 → 流水出现', after.hasList)
  check('保存后 → 筛选条回来、空态卡退场', after.filtersShown && after.addCount === 1)
  check('保存后 → 仍无 fixed 悬浮钮', after.overlays.length === 0, after.overlays.join(', '))
  check('保存后 → 「记一笔」在筛选条里', (await page.locator('.searchrow .add-inline').count()) === 1)
  await page.screenshot({ path: 'docs/shots/ledger-smoke-after-save.png' })
  await page.close()
}

await browser.close()
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)

/* ---------- 工具 ---------- */

/** 隐藏全应用浮层（更新卡 / toast）—— e2e 里一律 display:none，绝不能 remove()：
 *  它们是 Vue 管的节点，摘掉会破坏 DOM 记账（见 .workbuddy/memory 的踩坑记录）。 */
async function hideOverlays(p) {
  await p.evaluate(() => {
    for (const sel of ['.up-backdrop', '.up-card', '.toast']) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
  })
}

/**
 * 在页面里跑的度量。
 *
 * 「压文字」的判定不用写死某个选择器 —— 它把**所有 fixed 浮层**（排除 dock：
 * 内容从玻璃 dock 底下穿过是全应用约定）与「要读的那几行文字」两两求交。
 * 悬浮钮（.fab）已经取消，这张网留着防它回来。
 */
function measure() {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      right: Math.round(r.right),
    }
  }
  const OVERLAP = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

  // 页面级 fixed 浮层（排除 dock：内容从它底下穿过是全应用约定；排除 opacity:0 的
  // 常驻形变层 SessionOverlay —— 它 inset:0 铺满视口但不可见、不吃指针）
  const overlays = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed') continue
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    if (el.closest('.dock')) continue
    const r = rect(el)
    if (r.right - r.left > 0 && r.bottom - r.top > 0) overlays.push({ cls: el.className || el.tagName, r })
  }

  // 真正要读的那几行（不是整张卡）
  const TEXT_SEL = [
    '.empty .title',
    '.empty .hint',
    '.search input',
    '.chip',
    '.list .lbl',
    '.list .note',
    '.list .amt',
    '.list .dhead',
    '.add-inline',
  ]
  const textEls = []
  for (const sel of TEXT_SEL) {
    for (const el of document.querySelectorAll(sel)) {
      const r = rect(el)
      if (r.bottom > 0 && r.top < window.innerHeight) textEls.push({ sel, r })
    }
  }
  const hit = textEls.filter((t) => overlays.some((o) => OVERLAP(o.r, t.r)))

  const pEl = document.querySelector('.page-header p')
  const headerEl = document.querySelector('.page-header')
  const rows = [...document.querySelectorAll('.list .item')]
  const lastRow = rows.length ? rect(rows[rows.length - 1].parentElement) : null
  const emptyEl = document.querySelector('.empty')
  const dockEl = document.querySelector('.dock')
  const contentEl = lastRow ? rows[rows.length - 1].parentElement : emptyEl
  const addBtns = [...document.querySelectorAll('.add-inline')].map(rect)
  const lastAdd = addBtns.length ? addBtns[addBtns.length - 1] : null
  const dockTop = dockEl ? Math.round(dockEl.getBoundingClientRect().top) : null

  return {
    vh: window.innerHeight,
    docH: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    headerH: headerEl ? Math.round(headerEl.getBoundingClientRect().height) : null,
    // 副标题的**行盒**数量（用 Range 数行，别拿高度估）
    subLines: pEl
      ? (() => {
          const r = document.createRange()
          r.selectNodeContents(pEl)
          return r.getClientRects().length
        })()
      : 0,
    subTextW: pEl ? Math.round(pEl.scrollWidth) : null,
    subBoxW: pEl ? Math.round(pEl.getBoundingClientRect().width) : null,
    overlays: [...new Set(overlays.map((o) => String(o.cls)))],
    hitText: [...new Set(hit.map((h) => h.sel))],
    filtersShown: !!document.querySelector('.filters'),
    chipsShown: !!document.querySelector('.chips'),
    hasList: rows.length > 0,
    dockTop,
    addCount: addBtns.length,
    // 完整可见，或滚得出来（内容在流里 —— 390×608 这种下限窗口下，统计卡本身就超过一屏）
    addReachable:
      lastAdd === null
        ? false
        : (dockTop === null || lastAdd.bottom <= dockTop) ||
          document.documentElement.scrollHeight - window.innerHeight >= lastAdd.bottom - (dockTop ?? 0),
    addBottom: lastAdd ? lastAdd.bottom : null,
    contentBottom: contentEl ? rect(contentEl).bottom : 0,
    emptyH: emptyEl ? Math.round(emptyEl.getBoundingClientRect().height) : null,
  }
}

function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

function report(w, h, m) {
  console.log(`\n===== ${w}×${h} =====`)
  console.log(
    `  文档 ${m.docH} / 视口 ${m.vh}  页头 ${m.headerH}px  副标题 ${m.subLines} 行` +
      `（文本 ${m.subTextW} / 可用 ${m.subBoxW}）  横向溢出 ${m.overflowX}px`,
  )
  console.log(
    `  筛选条 ${m.filtersShown ? '在' : '收起'}  分类胶囊 ${m.chipsShown ? '在' : '收起'}` +
      `  空态卡 ${m.emptyH ?? '—'}px  dock 顶 ${m.dockTop}  fixed 浮层 [${m.overlays.join(', ') || '无'}]`,
  )
  check(`${w}×${h} 无浮层压文字`, m.hitText.length === 0, m.hitText.join(' / '))
  check(`${w}×${h} 无横向溢出`, m.overflowX <= 0, `${m.overflowX}px`)
  check(`${w}×${h} 页头副标题单行`, m.subLines <= 1, `${m.subLines} 行`)
  check(`${w}×${h} 副标题不被截断`, m.subTextW <= m.subBoxW, `文本 ${m.subTextW} / 可用 ${m.subBoxW}`)
  check(`${w}×${h} 「记一笔」入口恒为 1 处`, m.addCount === 1, `${m.addCount} 处`)
  check(
    `${w}×${h} 「记一笔」看得见或滚得出来`,
    m.addReachable,
    `钮底 ${m.addBottom} vs dock 顶 ${m.dockTop}`,
  )
}
