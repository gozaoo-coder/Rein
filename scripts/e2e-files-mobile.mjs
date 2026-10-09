/**
 * 文件系统**手机端**专项 e2e（430×932 触屏）：盯住移动端改造那一版的交互契约。
 *
 * 桌面形态的覆盖在 e2e-ai-workspace.mjs（视口撑到 1512 后断言），这里只验窄屏：
 *   T1 工具条只留 上一步/搜索/添加/更多；地标/状态行/列头/sizing 全收起来；dock 在位
 *   T2 「更多 → 目录树」能打开树并进子目录（根目录在手机上只看得到文件，树是正门）
 *   T3 dock 分段：最近文件 / 目录文件 两种模式切换
 *   T4 长按弹菜单 → 「多选」→ dock 功能栏（全选/复制/剪切/删除/更多/完成）+ 单击 toggle
 *   T5 触屏文件语义：文件单击只选中、双击打开、文件夹单击直接进
 *   T6 窄屏行：大小/日期是定宽右对齐列，跨行对齐
 *   T7 「添加 → 新建文件」预填 未命名.md，创建后进就地改名
 *   T8 「更多 → 回收站」入口（桌面那颗 .trash-entry 按钮窄屏不渲染）
 *
 * 运行：REIN_E2E_URL=http://127.0.0.1:1777 node scripts/e2e-files-mobile.mjs
 * （前置：npm run dev / vite 已在跑；浏览器无头 Edge 自带触屏模拟）
 */
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:1420'

let failed = 0
function ok(name, cond, detail = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})
const page = await context.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
const cdp = await context.newCDPSession(page)
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })

const send = (type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }],
  })
/** 一记轻点（touchStart → touchEnd，浏览器据此合成 click） */
const tap = async (x, y) => {
  await send('touchStart', x, y)
  await sleep(30)
  await send('touchEnd', x, y)
  await sleep(120)
}
/** 双击：两记间隔 90ms 的轻点（浏览器合成 dblclick） */
const doubleTap = async (x, y) => {
  await tap(x, y)
  await sleep(90)
  await tap(x, y)
  await sleep(150)
}
/** 长按：按住 dwellMs 毫秒不移动（组件阈值 460ms / 位移 12px） */
const longPress = async (x, y, dwellMs = 800) => {
  await send('touchStart', x, y)
  await sleep(dwellMs)
  await send('touchEnd', x, y)
  await sleep(250)
}

/** 点 AppMenu 里文本含 text 的菜单项（子层级的项也在文档里，一并可见） */
const clickMenuItem = async (text) => {
  const r = await page.evaluate((t) => {
    const items = [...document.querySelectorAll('button[role="menuitem"]')]
      .filter((b) => b.offsetParent !== null)
    const hit = items.find((b) => b.textContent.includes(t))
    if (!hit) return 'not-found: ' + items.map((b) => b.textContent.trim()).join('|')
    hit.click()
    return 'clicked'
  }, text)
  if (r !== 'clicked') throw new Error(`菜单项「${text}」${r}`)
  await sleep(350)
}

/** 行中心坐标（文件的 .hit 元素） */
async function rowCenter(namePart) {
  const box = await page.evaluate((t) => {
    const row = [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"]')]
      .find((r) => r.querySelector('b')?.textContent?.includes(t))
    if (!row) return null
    const el = row.querySelector('.hit') ?? row
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }, namePart)
  if (!box) throw new Error(`找不到行：${namePart}`)
  return box
}

/* ---------- 准备：进文件管理器，种两个文件 ---------- */

await page.goto(`${BASE}/#/`)
await page.waitForSelector('.app-frame', { timeout: 12000 })
await page.waitForTimeout(1000)
// 静默更新检查会把提示卡弹出来（全屏遮罩，挡触摸）——先点掉
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.up-card button')].find((x) => x.textContent.trim() === '稍后')
  b?.click()
})
await page.evaluate(() => { location.hash = '#/ai/files' })
await page.waitForSelector('[aria-label="文件列表"]', { timeout: 12000 })

const seeded = await page.evaluate(async () => {
  const { kbService } = await import('/src/services/kbService.ts')
  await kbService.fileWrite({ path: '未分类数据/移动端甲.wav', content: '种子甲' })
  await kbService.fileWrite({ path: '未分类数据/移动端乙.wav', content: '种子乙' })
  const dir = await kbService.listDir('未分类数据')
  return (dir?.entries ?? []).map((e) => e.name)
})
ok('T0 种子就绪（未分类数据 下两个文件）', seeded.includes('移动端甲.wav') && seeded.includes('移动端乙.wav'), seeded.join(','))

/* ---------- T1 窄屏形态 ---------- */

const shape = await page.evaluate(() => {
  const bar = document.querySelector('.fx .bar')
  const buttons = [...(bar?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label') ?? '')
  const dock = document.querySelector('.fdock')
  const dockRect = dock?.getBoundingClientRect()
  const segs = [...(dock?.querySelectorAll('.fseg-b') ?? [])].map((b) => ({
    label: b.textContent.trim(),
    pressed: b.getAttribute('aria-pressed'),
  }))
  return {
    narrow: matchMedia('(max-width: 640px)').matches,
    buttons,
    hasSearch: !!bar?.querySelector('input[type="search"]'),
    landmarks: !!document.querySelector('.landmarks'),
    status: !!document.querySelector('.fx .status'),
    thead: !!document.querySelector('.thead'),
    sizing: !!document.querySelector('.sizing'),
    hasDock: !!dock,
    dockBottomGap: dockRect ? Math.round(window.innerHeight - dockRect.bottom) : null,
    segs,
  }
})
ok('T1a 窄屏判定与四钮工具条', shape.narrow && shape.buttons.includes('上一步') && shape.buttons.includes('添加') && shape.buttons.includes('更多') && shape.hasSearch, `按钮: ${shape.buttons.join('/')}`)
ok(
  'T1b 桌面专属元素全部收起',
  !shape.landmarks && !shape.status && !shape.thead && !shape.sizing &&
  !shape.buttons.some((b) => ['新建目录', '导入文件', '目录树', '排序', '分组', '后退', '前进', '上一级'].includes(b)) &&
  !shape.buttons.some((b) => b.startsWith('回收站')),
  'landmarks/status/thead/sizing/桌面按钮均不在',
)
ok('T1c 底部 dock 在位且贴视口底', shape.hasDock && shape.dockBottomGap !== null && shape.dockBottomGap < 120, `距底 ${shape.dockBottomGap}px`)
ok(
  'T1d dock 分段（最近/目录）且目录为当前',
  shape.segs.length === 2 && shape.segs[0].label === '最近文件' && shape.segs[1].label === '目录文件' && shape.segs[1].pressed === 'true',
  JSON.stringify(shape.segs),
)

/* ---------- T2 「更多 → 目录树」进子目录（本次修复的入口） ---------- */

await page.click('button[aria-label="更多"]')
await clickMenuItem('目录树')
const treeOn = await page.evaluate(() => ({
  tree: !!document.querySelector('aside[aria-label="目录树"]'),
  rows: [...document.querySelectorAll('.tree button')].map((b) => b.textContent.trim()).slice(0, 8),
}))
ok('T2a 「更多 → 目录树」打开目录树', treeOn.tree, treeOn.rows.join('/'))

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tree button')].find((x) => x.textContent.includes('未分类数据'))
  b?.click()
})
// 面包屑（path）是同步翻转的，列表要等一次目录列举（mock 有 ~120ms delay）——
// 断言落到「行出现」上，别只等面包屑（那一窗口里列表还是旧目录的内容）
await page.waitForFunction(
  () => [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"] b')]
    .some((b) => b.textContent.includes('移动端甲.wav')),
  null,
  { timeout: 8000 },
)
const rowsIn = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"] b')].map((b) => b.textContent),
)
ok('T2b 树里进「未分类数据」：面包屑与列表跟上', rowsIn.includes('移动端甲.wav') && rowsIn.includes('移动端乙.wav'), rowsIn.join(','))

/* ---------- T3 dock 分段：最近文件 / 目录文件 ---------- */

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.fdock .fseg-b')].find((x) => x.textContent.includes('最近文件'))
  b?.click()
})
// 最近模式要等一次跨目录检索（异步）——等行出现，不是等面包屑
await page.waitForFunction(
  () => document.querySelector('.crumbs')?.textContent?.includes('最近文件') &&
    [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"] b')].length > 0,
  null,
  { timeout: 8000 },
)
const recentShape = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"] b')].map((b) => b.textContent),
  recentPressed: [...document.querySelectorAll('.fdock .fseg-b')].find((b) => b.textContent.includes('最近'))?.getAttribute('aria-pressed'),
  note: document.querySelector('.crumb-note')?.textContent ?? null,
}))
// 最近模式列的是「跨目录最近动过的检索文档」——种子的 wav 未必在其中，
// 这里断言的是模式切换本身：行数（跨目录检索的结果）、分段态、提示语
ok(
  'T3a 切「最近文件」：跨目录列出且分段态正确',
  recentShape.rows.length >= 3 && recentShape.recentPressed === 'true' && !!recentShape.note,
  `rows=${recentShape.rows.length} note=${recentShape.note}`,
)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.fdock .fseg-b')].find((x) => x.textContent.includes('目录文件'))
  b?.click()
})
await page.waitForTimeout(400)
const backToDir = await page.evaluate(() => ({
  crumbs: document.querySelector('.crumbs')?.textContent ?? '',
  rows: [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"] b')].map((b) => b.textContent),
}))
ok('T3b 切回「目录文件」：停在未分类数据，行还在', backToDir.crumbs.includes('未分类数据') && backToDir.rows.includes('移动端甲.wav'), backToDir.rows.join(','))

/* ---------- T4 长按 → 多选 → dock 功能栏 ---------- */

const lp = await rowCenter('移动端甲.wav')
await longPress(lp.x, lp.y)
const menu = await page.evaluate(() => {
  const items = [...document.querySelectorAll('button[role="menuitem"]')].filter((b) => b.offsetParent !== null)
  return {
    open: items.length > 0,
    first: items[0]?.textContent.trim() ?? null,
    selectedAfterLp: document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length,
  }
})
ok('T4a 长按弹菜单且首项是「多选」', menu.open && menu.first === '多选', `first=${menu.first}`)
// 设计：菜单命令作用于选中项，长按会先选中这一行（与桌面右键一致）——
// 这里断言的是「幽灵点击没有被顺手激活」：选中的应该正好只有被按的那一行
ok('T4b 长按只选中被按行（幽灵点击被吞）', menu.selectedAfterLp === 1, `selected=${menu.selectedAfterLp}`)

await clickMenuItem('多选')
const selShape = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"]')]
  const facts = [...document.querySelectorAll('.fdock .fact')].map((b) => ({
    label: b.textContent.trim(),
    disabled: b.disabled,
  }))
  return {
    ck: document.querySelectorAll('[aria-label="文件列表"] .ck').length,
    selected: document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length,
    facts,
    navSegGone: !document.querySelector('.fdock .fseg'),
  }
})
ok('T4c 多选态：勾选框出现 + dock 切功能栏', selShape.ck === 2 && selShape.navSegGone, `ck=${selShape.ck}`)
const copyFact = selShape.facts.find((f) => f.label.includes('复制'))
const delFact = selShape.facts.find((f) => f.label.includes('删除'))
ok('T4d 功能栏含 全选/复制/剪切/删除/更多/完成', ['全选', '复制', '剪切', '删除', '完成'].every((t) => selShape.facts.some((f) => f.label.includes(t))), JSON.stringify(selShape.facts.map((f) => f.label)))

// 多选态单击 = toggle（不是单选）
const c2 = await rowCenter('移动端乙.wav')
await tap(c2.x, c2.y)
const afterToggle = await page.evaluate(() => document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length)
ok('T4e 多选态单击 = 切换选中（两行都留着）', afterToggle === 2, `selected=${afterToggle}`)

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.fdock .fact')].find((x) => x.textContent.includes('全选'))
  b?.click()
})
const allSel = await page.evaluate(() => ({
  selected: document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length,
  total: document.querySelectorAll('[aria-label="文件列表"] li[role="option"]').length,
  label: [...document.querySelectorAll('.fdock .fact')].find((b) => b.textContent.includes('全'))?.textContent.trim(),
}))
ok('T4f 全选 → 全不选（标签翻转）', allSel.selected === allSel.total && allSel.total > 0 && allSel.label === '全不选', `selected=${allSel.selected}/${allSel.total}`)

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.fdock .fact')].find((x) => x.textContent.includes('完成'))
  b?.click()
})
await page.waitForTimeout(300)
const exited = await page.evaluate(() => ({
  navSeg: !!document.querySelector('.fdock .fseg'),
  selected: document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length,
}))
ok('T4g 「完成」退出多选态', exited.navSeg && exited.selected === 0, JSON.stringify(exited))

/* ---------- T5 触屏文件语义：单击选中 / 双击打开 / 文件夹单击直接进 ---------- */

// 先回根再进「笔记」也没有种子文件—— 直接还在 未分类数据 里验文件语义
const f5 = await rowCenter('移动端乙.wav')
await tap(f5.x, f5.y)
const single = await page.evaluate(() => ({
  selected: document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length,
  reader: !!document.querySelector('.reader'),
}))
ok('T5a 触屏文件单击 = 只选中，不打开', single.selected === 1 && !single.reader, JSON.stringify(single))

await doubleTap(f5.x, f5.y)
await page.waitForTimeout(600)
const opened = await page.evaluate(() => ({
  reader: !!document.querySelector('.reader'),
  text: document.querySelector('.reader')?.innerText?.slice(0, 40) ?? null,
}))
ok('T5b 触屏文件双击 = 打开阅读器', opened.reader, opened.text)

// 退回列表，验文件夹单击直接进（树还在，先回根）
await page.evaluate(() => {
  document.querySelector('button[aria-label="返回列表"]')?.click()
})
await page.waitForTimeout(400)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tree button')].find((x) => x.textContent.includes('笔记'))
  b?.click()
})
await page.waitForTimeout(600)
const inNotes = await page.evaluate(() => document.querySelector('.crumbs')?.textContent ?? '')
ok('T5c 文件夹单击（树里）直接进入', inNotes.includes('笔记'), inNotes)

/* ---------- T6 窄屏行：大小/日期定宽右对齐列，跨行对齐 ---------- */

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tree button')].find((x) => x.textContent.includes('未分类数据'))
  b?.click()
})
await page.waitForTimeout(600)
const align = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[aria-label="文件列表"] li[role="option"]')]
  const cols = (r) => {
    const s = r.querySelector('.num.size')
    const d = r.querySelector('.num.date')
    if (!s || !d) return null
    const sb = s.getBoundingClientRect()
    const db = d.getBoundingClientRect()
    return { sx: Math.round(sb.x), sw: Math.round(sb.width), dx: Math.round(db.x), dw: Math.round(db.width), align: getComputedStyle(s).textAlign }
  }
  return rows.map(cols).filter(Boolean)
})
ok(
  'T6 大小/日期列跨行对齐（56/66px 定宽右对齐）',
  align.length >= 2 &&
  align.every((c) => c.sw === 56 && c.dw === 66 && c.align === 'right') &&
  align.every((c) => c.sx === align[0].sx && c.dx === align[0].dx),
  JSON.stringify(align),
)

/* ---------- T7 「添加 → 新建文件」预填 未命名.md + 就地改名 ---------- */

await page.click('button[aria-label="添加"]')
await clickMenuItem('新建文件')
const prefill = await page.evaluate(() => {
  const input = document.querySelector('.newfolder input')
  return { label: input?.getAttribute('aria-label'), value: input?.value ?? null }
})
ok('T7a 新建预填「未命名.md」', prefill.label === '新文件名' && prefill.value === '未命名.md', JSON.stringify(prefill))

await page.evaluate(() => {
  const input = document.querySelector('.newfolder input')
  if (input) {
    input.value = '移动端新文件.wav'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }
})
await page.keyboard.press('Enter')
await page.waitForTimeout(900)
const t7 = await page.evaluate(() => ({
  // 编辑中的行显示的是改名输入框（不是 <b>），行「可见」要按输入框的值算
  renameOpen: !!document.querySelector('[aria-label="文件列表"] input[aria-label^="重命名为"]'),
  renameValue: document.querySelector('[aria-label="文件列表"] input[aria-label^="重命名为"]')?.value ?? null,
}))
ok('T7b 创建后直接进就地改名且新行可见', t7.renameOpen && String(t7.renameValue).includes('移动端新文件'), JSON.stringify(t7))
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------- T8 「更多 → 回收站」入口 ---------- */

await page.click('button[aria-label="更多"]')
const trashLabel = await page.evaluate(() => {
  const items = [...document.querySelectorAll('button[role="menuitem"]')].filter((b) => b.offsetParent !== null)
  return items.find((b) => b.textContent.includes('回收站'))?.textContent.trim() ?? null
})
ok('T8a 「更多」里有回收站入口', !!trashLabel, String(trashLabel))
await clickMenuItem('回收站')
await page.waitForTimeout(500)
const trashMode = await page.evaluate(() => ({
  banner: document.querySelector('.crumbs')?.textContent?.includes('回收站') || !!document.querySelector('.banner'),
  exitBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '退出'),
  listLabel: document.querySelector('[aria-label="文件列表"]') !== null,
}))
ok('T8b 进回收站：横幅 + 退出按钮 + 列表仍在', trashMode.banner && trashMode.exitBtn && trashMode.listLabel, JSON.stringify(trashMode))

console.log(failed === 0 ? '\n== 全部通过 ==' : `\n== ${failed} 条失败 ==`)
if (failed > 0) process.exitCode = 1
await browser.close()
