/**
 * 饮食历史优化验证（无头 Edge + 原生 CDP）。
 * 运行：REIN_E2E_URL=http://localhost:4199 node scripts/verify-diet-history.mjs
 *
 * 验证三件事：
 *  ① 超高画质下吸顶周条不再是实底白带：玻璃档下条自身背景透明（自铺玻璃底会与
 *     面板双重叠加、亮出一档）+ 自配磨砂；流畅档回落实底、与面板同色。
 *  ② 记录行四格指标（热量/蛋白/碳水/脂肪占本日 %，有真实数值与色条）。
 *  ③ 点行打开单笔详情：占本日五行 + 微量营养素 + 删除入口（确认弹层出现、取消不删）。
 * 产出：.tmp-ui-shots/dh-*.png（含滚动状态下周条区域的 3x 局部放大图）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`
const OUT = new URL('../.tmp-ui-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(200)
  }
  return false
}

async function viewport(width, height, mobile) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
  await sleep(350)
}

async function shot(name) {
  await sleep(650)
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}dh-${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  · dh-${name}.png`)
}

/** 局部放大截图（页面坐标 CSS px）：细看周条与面板/内容的材质交界 */
async function shotClip(name, x, y, width, height, scale = 3) {
  await sleep(500)
  const r = await cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale },
  })
  writeFileSync(`${OUT}dh-${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`  · dh-${name}.png（clip ${width}×${height}@${scale}x）`)
}

async function dismissUpdateDialog() {
  await evalJS(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => ['稍后','跳过此版本'].includes(b.textContent.trim()))
    if (btn) btn.click()
    return Boolean(btn)
  })()`)
  await sleep(300)
}

async function setPerf(mode) {
  await evalJS(`localStorage.setItem('rein.perf.v1', ${JSON.stringify(mode)})`)
  await cdp('Page.reload')
  await sleep(2400)
  await dismissUpdateDialog()
}

/** 打开饮食历史抽屉（移动端=文字链 chip，桌面=便当宽条） */
async function openHistory(desktop) {
  await evalJS(desktop
    ? `document.querySelector('[aria-label="查看饮食历史"]')?.click()`
    : `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '饮食历史')?.click()`)
  return waitFor(`document.querySelector('.panel .weekbar')`)
}

/** 采集一次界面状态（周条/面板材质、行指标、当日汇总） */
async function probe() {
  return evalJS(`(() => {
    const wb = document.querySelector('.panel .weekbar')
    const panel = document.querySelector('.panel')
    const wcs = getComputedStyle(wb)
    const pcs = getComputedStyle(panel)
    const rows = [...document.querySelectorAll('.panel button.row.pressable')]
    const cellsOf = (row) => [...row.querySelectorAll('.ncell')].map(c => ({
      label: c.querySelector('.nlab')?.textContent.replace(/\\s+/g,' ').trim() ?? '',
      width: c.querySelector('.nfill')?.style.width ?? '',
      bg: c.querySelector('.nfill')?.style.background ?? '',
      track: getComputedStyle(c.querySelector('.nbar')).backgroundColor,
    }))
    return {
      perf: document.documentElement.dataset.perf,
      glass: document.documentElement.dataset.glass,
      fillToken: getComputedStyle(document.documentElement).getPropertyValue('--glass-panel-fill').trim(),
      weekbarBg: wcs.backgroundColor,
      weekbarBackdrop: wcs.backdropFilter ?? wcs.webkitBackdropFilter,
      weekbarRadiusTop: wcs.borderTopLeftRadius,
      panelBg: pcs.backgroundColor,
      panelBackdrop: pcs.backdropFilter ?? pcs.webkitBackdropFilter,
      days: document.querySelectorAll('.panel .day').length,
      selDay: document.querySelector('.panel .day.sel .dn')?.textContent ?? '',
      dayHead: document.querySelector('.panel .dayhead')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      rowCount: rows.length,
      rowNames: rows.map(r => r.querySelector('.rname')?.textContent ?? ''),
      rowSubs: rows.map(r => r.querySelector('.rsub')?.textContent.replace(/\\s+/g,' ').trim() ?? ''),
      firstRowCells: rows.length ? cellsOf(rows[0]) : [],
    }
  })()`)
}

/** 单笔详情抽屉状态（第二个 .panel） */
async function probeDetail() {
  return evalJS(`(() => {
    const panels = [...document.querySelectorAll('.panel')]
    const d = panels[panels.length - 1]
    if (panels.length < 2 || !d.querySelector('.daylist')) return null
    const dayRows = [...d.querySelectorAll('.daylist li')].map(li => ({
      label: li.querySelector('.dlabel')?.textContent.trim() ?? '',
      val: li.querySelector('.dval')?.textContent.replace(/\\s+/g,' ').trim() ?? '',
      bar: li.querySelector('.fill') ? 'bar' : 'none',
      fill: li.querySelector('.fill')?.style.getPropertyValue('--p') ?? '',
    }))
    return {
      title: d.querySelector('.head h2')?.textContent ?? '',
      kcal: d.querySelector('.kcal b')?.textContent ?? '',
      meta: d.querySelector('.meta')?.textContent.replace(/\\s+/g,' ').trim() ?? '',
      share: d.querySelector('.share-label')?.textContent.replace(/\\s+/g,' ').trim() ?? '',
      dayRows,
      microCount: d.querySelectorAll('.micros li').length,
      microFirst: d.querySelector('.micros .mlabel')?.textContent.trim() ?? '',
      microFirstVal: d.querySelector('.micros .mval')?.textContent.trim() ?? '',
      hasDelete: Boolean(d.querySelector('.sheet-foot button')),
    }
  })()`)
}

/* ---------- 断言 ---------- */
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`)
}

const alphaOf = (rgba) => {
  const m = /rgba?\(([^)]+)\)/.exec(rgba ?? '')
  if (!m) return 1
  const parts = m[1].split(',').map((x) => Number(x.trim()))
  return parts.length === 4 ? parts[3] : 1
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
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
    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2600)

    /* ============ ① 移动端 · 超高 ============ */
    console.log('\n[1] 移动端 407×932 · 超高画质（用户报的档）')
    await viewport(430, 932, true)
    await setPerf('ultra')
    check('超高档生效', (await evalJS(`document.documentElement.dataset.perf`)) === 'ultra',
      await evalJS(`document.documentElement.dataset.perf`))

    check('饮食历史入口可点开', await openHistory(false))
    await sleep(900)
    let s = await probe()
    await shot('ultra-rows')

    check('周条不再自铺玻璃底（透明，不与面板双重叠加）',
      alphaOf(s.weekbarBg) === 0,
      `weekbar=${s.weekbarBg} panel=${s.panelBg} token=${s.fillToken}`)
    check('周条自带磨砂（玻璃档）', /blur/.test(s.weekbarBackdrop ?? ''), String(s.weekbarBackdrop))
    check('面板也是玻璃（对照组）', /blur/.test(s.panelBackdrop ?? ''), String(s.panelBackdrop))
    check('周条 7 天 + 选中今天', s.days === 7 && s.selDay.length > 0, `days=${s.days} sel=${s.selDay}`)
    check('当日 7 笔记录（mock 种子）', s.rowCount === 7, `rows=${s.rowCount} ${s.rowNames.join('/')}`)
    check('行内有 4 格指标', s.firstRowCells.length === 4,
      s.firstRowCells.map((c) => `${c.label} ${c.width}`).join(' | '))
    check('指标格显示占本日百分比', s.firstRowCells.every((c) => /%$/.test(c.label.split(' ').pop() ?? '')),
      s.firstRowCells.map((c) => c.label).join(' | '))
    check('指标条有色且有填充', s.firstRowCells.every((c) => c.bg.includes('var') && parseFloat(c.width) > 0),
      s.firstRowCells.map((c) => `${c.bg} ${c.width}`).join(' | '))
    check('行副标题保留具体克重', /g/.test(s.rowSubs[0] ?? ''), s.rowSubs[0])
    check('当日汇总仍在', /已摄入/.test(s.dayHead), s.dayHead)

    // 内容滚过吸顶条：周条应压在内容之上（视觉核对用）
    await evalJS(`document.querySelector('.panel .body').scrollTop = 520`)
    await shot('ultra-weekbar-scrolled')
    const wbBox = await evalJS(`(() => {
      const r = document.querySelector('.panel .weekbar').getBoundingClientRect()
      return { x: r.left, y: Math.max(0, r.top - 56), w: r.width, h: r.height + 132 }
    })()`)
    await shotClip('ultra-weekbar-clip', wbBox.x, wbBox.y, wbBox.w, wbBox.h)

    /* ============ ② 单笔详情 ============ */
    console.log('\n[2] 点行 → 单笔详情')
    await evalJS(`document.querySelector('.panel button.row.pressable')?.click()`)
    const detailOpen = await waitFor(`(() => {
      const ps = document.querySelectorAll('.panel')
      return ps.length === 2 && ps[1].querySelector('.daylist')
    })()`)
    check('详情抽屉打开', detailOpen)
    const d = await probeDetail()
    if (d) {
      await shot('ultra-detail')
      check('标题 = 首行食物名', d.title === s.rowNames[0], `${d.title} vs ${s.rowNames[0]}`)
      check('热量与份量元信息', Number(d.kcal) > 0 && /早餐/.test(d.meta) && /g/.test(d.meta), `${d.kcal} kcal / ${d.meta}`)
      check('供能占比条有数据', /供能占比/.test(d.share), d.share)
      check('占本日 5 行（热量/蛋白/碳水/脂肪/钠）', d.dayRows.length === 5,
        d.dayRows.map((r) => r.label).join('/'))
      check('占本日行带目标与进度条', d.dayRows.every((r) => r.bar === 'bar' && /%/.test(r.val)),
        d.dayRows.map((r) => `${r.label} ${r.val}`).join(' | '))
      check('微量营养素列表非空', d.microCount > 0, `${d.microCount} 项，首项 ${d.microFirst} ${d.microFirstVal}`)
      check('详情底部有删除入口', d.hasDelete)

      // 删除必须二次确认，取消后记录数不变
      await evalJS(`document.querySelectorAll('.panel')[1].querySelector('.sheet-foot button')?.click()`)
      const confirmOpen = await waitFor(`document.querySelector('.card-wrap')`)
      check('删除弹二次确认', confirmOpen,
        await evalJS(`document.querySelector('.card-wrap')?.textContent.replace(/\\s+/g,' ').trim() ?? ''`))
      await shot('ultra-delete-confirm')
      await evalJS(`document.querySelector('.card-wrap .opt.cancel')?.click()`)
      await sleep(600)
      const rowsAfter = await evalJS(`document.querySelectorAll('.panel button.row.pressable').length`)
      const panelsAfter = await evalJS(`document.querySelectorAll('.panel').length`)
      const sheetAlive = await evalJS(`document.querySelectorAll('.panel .weekbar').length`)
      const wrapAlive = await evalJS(`Boolean(document.querySelector('.card-wrap'))`)
      check('取消后记录数不变', rowsAfter === 7,
        `rows=${rowsAfter} panels=${panelsAfter} weekbar=${sheetAlive} actionSheet=${wrapAlive}`)
      await evalJS(`document.querySelectorAll('.panel')[1].querySelector('.head .close')?.click()`)
      await sleep(700)
      check('详情关闭后回到历史', (await evalJS(`document.querySelectorAll('.panel').length`)) === 1)
    }

    /* ============ ③ 暗色 · 超高 ============ */
    console.log('\n[3] 暗色 · 超高')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(700)
    s = await probe()
    check('暗色下周条同样透明 + 磨砂',
      alphaOf(s.weekbarBg) === 0 && /blur/.test(s.weekbarBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop} panel=${s.panelBg}`)
    await shot('dark-rows')
    await evalJS(`document.querySelector('.panel button.row.pressable')?.click()`)
    await waitFor(`document.querySelectorAll('.panel').length === 2`)
    await shot('dark-detail')
    await evalJS(`document.querySelectorAll('.panel')[1]?.querySelector('.head .close')?.click()`)
    await sleep(600)
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(800)

    /* ============ ④ 流畅档回落 ============ */
    console.log('\n[4] 移动端 · 流畅档（回落实底）')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setPerf('low')
    check('流畅档生效', (await evalJS(`document.documentElement.dataset.perf`)) === 'low')
    check('饮食历史可再开', await openHistory(false))
    await sleep(900)
    s = await probe()
    check('流畅档周条回落实底、与面板同色',
      s.weekbarBg === s.panelBg && alphaOf(s.weekbarBg) === 1, `weekbar=${s.weekbarBg} panel=${s.panelBg}`)
    check('流畅档周条无模糊', !/blur/.test(s.weekbarBackdrop ?? ''), String(s.weekbarBackdrop))
    await shot('low-rows')
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(700)

    /* ============ ⑤ 桌面便当入口 ============ */
    console.log('\n[5] 桌面 1440 · 超高（同一组件的另一入口）')
    await viewport(1440, 900, false)
    await setPerf('ultra')
    check('便当饮食条可点开', await openHistory(true))
    await sleep(900)
    s = await probe()
    check('桌面周条同为透明 + 磨砂',
      alphaOf(s.weekbarBg) === 0 && /blur/.test(s.weekbarBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop}`)
    await shot('desk-rows')

    console.log('\n===== 结果 =====')
    const failed = results.filter((r) => !r.ok)
    for (const f of failed) console.log(`  ✗ ${f.name}（${f.detail}）`)
    console.log(failed.length === 0
      ? `全部通过：${results.length}/${results.length}`
      : `失败 ${failed.length}/${results.length}`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    try { ws?.close() } catch { /* 已断开 */ }
    edge.kill()
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e)
  process.exitCode = 1
})
