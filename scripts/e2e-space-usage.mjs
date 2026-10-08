/**
 * 空间总览端到端（/ai/files/space）：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-space-usage.mjs
 * 前置：npm run dev（默认 1420；端口被排除或并发会话时用 REIN_E2E_URL 指向独立实例）
 *
 * 覆盖这条链路：文件页页头右侧的总大小胶囊 → 空间总览页（构成条 / 目录占用 / 大文件摘要 /
 * 索引来源 / 本体模态 / 维护）→ 大文件完整榜单页 → 从目录行与大文件行跳回文件管理器
 * （?dir= / ?path= 深链）。顺带守住三条回归：页内不再有「空间总览」卡（入口只在页头）、
 * 两页的总大小取自同一份 report、大文件在总览里只留摘要（完整榜单在下一级页）。
 *
 * 结束时在 TEMP 落五个截图（移动 / 桌面 × 文件页 / 总览页 + 移动大文件页），供人工或视觉验收。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内，可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9338)
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-space-${Date.now()}`
const SHOT_DIR = process.env.TEMP ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

async function waitFor(expr, timeoutMs = 9000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch { /* 上下文销毁（HMR）时重试 */ }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (!r?.data) return null
  const file = `${SHOT_DIR}/rein-space-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
  return file
}

/** 视图尺寸切换：mobile=true 会同时命中 (pointer: coarse)，与真机一致 */
async function viewport(width, height, mobile) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 })
  await sleep(400)
}

/** 关掉应用自己的「发现新版本」弹层：它是启动时静默检查弹出的，正好盖在截图中间 */
async function dismissUpdatePrompt() {
  await evalJS(`(() => {
    const x = document.querySelector('.up-x') ??
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后')
    if (x) x.click()
    return true
  })()`)
  await sleep(400)
}

/** 页内调 kbService（UI 走的就是它）——只读调用带一次重试，抵御 dev 服务器 HMR 重载 */
async function kb(method, ...args) {
  const expr = `(async () => {
    const { kbService } = await import('/src/services/kbService.ts')
    return await kbService[${JSON.stringify(method)}](${args.map((a) => JSON.stringify(a)).join(', ')})
  })()`
  const v = await evalJS(expr)
  return v === undefined ? evalJS(expr) : v
}

/** 让会话级备忘失效：直接调 kbService 写入不会走 UI 那条 invalidate 路径 */
async function dropUsageMemo() {
  await evalJS(`(async () => {
    const m = await import('/src/services/kbService.ts')
    m.invalidateUsage()
    return true
  })()`)
}

const SEED_PATH = '笔记/空间总览测试.md'

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,932',
    'about:blank',
  ])
  await sleep(1800)

  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    const target = await res.json()
    await sleep(300)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        p.resolve(m.result ?? m.error)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')

    await viewport(430, 932, true)
    await cdp('Page.navigate', { url: APP })
    await waitFor("document.querySelector('h1')", 15000, '应用挂载')
    await sleep(600)

    /* ---------- 播种：一条够大的笔记，保证它在目录榜与大文件榜里可识别 ---------- */
    await kb('fileWrite', { path: SEED_PATH, content: '空间总览测试内容。'.repeat(6000) })
    await dropUsageMemo()
    await evalJS("location.hash = '#/ai/files'")
    await sleep(700)

    /* ---------- A. 入口：页头右侧的总大小胶囊 ---------- */
    await waitFor("document.querySelector('.hdr-btn.pill')", 9000, '页头总大小胶囊')
    const pill = await evalJS(`(() => {
      const b = document.querySelector('.hdr-btn.pill')
      return { text: b.textContent.replace(/\\s+/g, ' ').trim(), label: b.getAttribute('aria-label') ?? '' }
    })()`)
    ok('入口：文件页页头右侧有一颗总大小胶囊', /^[\d.]+ ?(B|KB|MB|GB)$/.test(pill.text), pill.text)
    ok('入口：胶囊带「空间总览」无障碍标签', pill.label.includes('空间总览'), pill.label)
    const cardGone = await evalJS("!document.querySelector('.usage, .usage-head')")
    ok('回归：页内不再有空间总览卡（入口只在页头）', cardGone === true, '')
    await dismissUpdatePrompt()
    await shot('files-mobile')

    /* ---------- B. 进入空间总览页 ---------- */
    await evalJS("document.querySelector('.hdr-btn.pill').click()")
    await waitFor("location.hash === '#/ai/files/space'", 8000, '跳到空间总览路由')
    await waitFor("document.querySelector('.bignum')", 9000, '总览页渲染')
    ok('入口：点胶囊进入空间总览页', true, '')

    const hero = await evalJS(`(() => {
      const hero = document.querySelector('.bignum').textContent.trim()
      const legends = [...document.querySelectorAll('.legend li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())
      const groups = [...document.querySelectorAll('.lgroup')].map((g) => g.querySelector('.lcap').textContent.replace(/\\s+/g, ' ').trim())
      const bars = document.querySelectorAll('.stackbar').length
      return { hero, legends, groups, bars }
    })()`)
    ok(
      '构成：大数字与胶囊同一个数（两页共用一份 report）',
      hero.hero.replace(/\s/g, '') === pill.text.replace(/\s/g, ''),
      `hero=${hero.hero} pill=${pill.text}`,
    )
    ok('构成：两组构成条（真源 / 派生缓存）', hero.bars === 2 && hero.groups.length === 2, hero.groups.join(' | '))
    ok(
      '构成：四本账图例齐全（文本 / 本体 / 索引 / 数据库）',
      ['文本', '本体', '索引', '数据库'].every((n) => hero.legends.some((l) => l.includes(n))),
      hero.legends.join(' / '),
    )

    /* ---------- C. 目录占用 → 跳文件管理器该目录 ---------- */
    await waitFor("document.querySelector('.barrow')", 9000, '目录占用行')
    const firstArea = await evalJS(`(() => {
      const b = document.querySelector('.barrow')
      return { name: b.querySelector('.br-1 b').textContent.trim(), pct: b.querySelector('.br-pct').textContent.trim() }
    })()`)
    ok('目录占用：每行有名字与占比', Boolean(firstArea.name) && /%$/.test(firstArea.pct), `${firstArea.name} ${firstArea.pct}`)
    const hasSeedArea = await evalJS(`document.body.innerText.includes('笔记')`)
    ok('目录占用：包含播种的目录', hasSeedArea === true, '')

    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.barrow')].find((x) => x.querySelector('.br-1 b').textContent.trim() === '笔记')
      if (!b) throw new Error('找不到「笔记」目录行')
      b.click()
      return true
    })()`)
    await waitFor("location.hash.startsWith('#/ai/files') && !location.hash.includes('/space')", 8000, '回到文件页')
    await waitFor("document.body.innerText.includes('空间总览测试.md')", 9000, '落在目标目录')
    ok('联动：点目录行落到文件管理器的对应目录', true, '')

    /* ---------- D. 大文件：总览只留摘要 → 完整榜单页 → 打开阅读器 ---------- */
    await evalJS("location.hash = '#/ai/files/space'")
    await waitFor("document.querySelector('.filerow')", 9000, '大文件摘要行')
    const summary = await evalJS(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent.trim() === '大文件')
      return {
        rows: card.querySelectorAll('.filerow').length,
        entry: card.querySelector('.more')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      }
    })()`)
    ok('大文件：总览卡只留前三名摘要', summary.rows > 0 && summary.rows <= 3, `${summary.rows} 行`)
    ok('大文件：总览卡给出完整榜单入口', summary.entry.includes('查看完整榜单'), summary.entry)

    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.more')].find((x) => x.textContent.includes('查看完整榜单'))
      if (!b) throw new Error('找不到完整榜单入口')
      b.click()
      return true
    })()`)
    await waitFor("location.hash === '#/ai/files/space/large'", 8000, '跳到大文件页')
    await waitFor("document.querySelector('.filerow')", 9000, '完整榜单渲染')
    const listInfo = await evalJS(`(() => ({
      rows: document.querySelectorAll('.filerow').length,
      head: document.querySelector('.card-head .sub')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    }))()`)
    ok('大文件页：榜单条数多于摘要（top 更大）', listInfo.rows > summary.rows, `${listInfo.rows} 行 · ${listInfo.head}`)

    const fileRow = await evalJS(`(() => {
      const b = [...document.querySelectorAll('.filerow')].find((x) => x.querySelector('small').textContent.trim() === ${JSON.stringify(SEED_PATH)})
      if (!b) return null
      return { path: b.querySelector('small').textContent.trim(), bytes: b.querySelector('.fr-bytes').textContent.trim() }
    })()`)
    ok('大文件页：播种的大文件在榜上且带体积', !!fileRow && /\d/.test(fileRow.bytes), `${fileRow?.path ?? '未找到'} ${fileRow?.bytes ?? ''}`)

    await evalJS(`(() => {
      const b = [...document.querySelectorAll('.filerow')].find((x) => x.querySelector('small').textContent.trim() === ${JSON.stringify(SEED_PATH)})
      if (!b) throw new Error('找不到播种的大文件行')
      b.click()
      return true
    })()`)
    await waitFor("!!document.querySelector('.reader .rpath')", 9000, '阅读器打开')
    const readerPath = await evalJS("document.querySelector('.reader .rpath').textContent.trim()")
    ok('联动：点大文件行按路径打开对应的阅读器（不是隔壁文档）', readerPath === SEED_PATH, readerPath)

    /* ---------- E. 维护卡（碎片 / 丢失） ---------- */
    await evalJS("location.hash = '#/ai/files/space'")
    await waitFor("document.body.innerText.includes('维护')", 9000, '维护卡')
    const maint = await evalJS(`(() => {
      const t = document.body.innerText
      return { noFragment: t.includes('没有发现可回收的碎片') || t.includes('可回收碎片'), source: t.includes('索引来源'), modal: t.includes('本体模态') }
    })()`)
    ok('维护：碎片状态可读且清理入口在两态下都有交代', maint.noFragment === true, '')
    ok('分布：索引来源与本体模态两张卡都在', maint.source && maint.modal, '')

    /* ---------- F. 截图（移动全页 + 桌面形态） ---------- */
    await dismissUpdatePrompt()
    await shot('space-mobile')
    await evalJS("location.hash = '#/ai/files/space/large'")
    await waitFor("document.querySelector('.filerow')", 9000, '大文件页（截图）')
    await sleep(400)
    await dismissUpdatePrompt()
    await shot('large-mobile')
    await viewport(1400, 1000, false)
    await evalJS("location.hash = '#/ai/files'")
    await sleep(700)
    await dismissUpdatePrompt()
    await shot('files-desktop')
    await evalJS("location.hash = '#/ai/files/space'")
    await waitFor("document.querySelector('.bignum')", 9000, '桌面总览页')
    await sleep(500)
    const deskCols = await evalJS(`(() => {
      const page = document.querySelector('.page')
      const cs = getComputedStyle(page)
      return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length }
    })()`)
    ok('桌面：壳层给出两栏栅格（width 1400 下 .desk-main 生效）', deskCols.display === 'grid' && deskCols.cols === 2, JSON.stringify(deskCols))
    await dismissUpdatePrompt()
    await shot('space-desktop')

    /* ---------- 清理播种数据 ---------- */
    const cleaned = await evalJS(`(async () => {
      const { kbService } = await import('/src/services/kbService.ts')
      const hits = await kbService.glob(${JSON.stringify(SEED_PATH)}, 10)
      const hit = hits.find((h) => h.path === ${JSON.stringify(SEED_PATH)})
      if (!hit) return 'not-found'
      await kbService.fileDelete(hit.id)
      return 'deleted'
    })()`)
    ok('清理：测试文件已删除', cleaned === 'deleted', String(cleaned))
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    edge.kill()
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('运行失败：', e)
    process.exit(1)
  })
