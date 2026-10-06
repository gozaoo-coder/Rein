/**
 * 饮食历史优化验证（无头 Edge + 原生 CDP）。
 * 运行：REIN_E2E_URL=http://localhost:4199 node scripts/verify-diet-history.mjs
 *
 * 验证四件事：
 *  ① 日选栏是 Dock 栏目风格（两侧圆钮 + 中间药丸；选中是**中性提亮的药丸**、
 *     不是主色实心块），且玻璃档（高画质 / 超高 / 极致）下吸顶条**整条什么都不画**
 *     （透明 + 无整宽模糊，滚过的记录行改由每一块玻璃自己吃背影）；
 *     流畅档条与块都回落实底、与面板同色。
 *  ② 当日摄入总览跟着选中日走（切到没有记录的那天就归零，不串今天的数字）；
 *     点它打开「营养全览 · 那一天」抽屉（摄入总览 + 宏量营养素 + 微量元素）。
 *  ③ 记录行四格指标（热量/蛋白/碳水/脂肪占本日 %，有真实数值与色条）。
 *  ④ 点行打开单笔详情：占本日五行 + 微量营养素 + 删除入口（确认弹层出现、取消不删）。
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
      days: document.querySelectorAll('.panel .dock-day').length,
      selDay: document.querySelector('.panel .dock-day.on .dd')?.textContent ?? '',
      dockSides: document.querySelectorAll('.panel .dock-side').length,
      pillBg: getComputedStyle(document.querySelector('.panel .dock-pill')).backgroundColor,
      pillBackdrop: (() => { const s = getComputedStyle(document.querySelector('.panel .dock-pill')); return s.backdropFilter || s.webkitBackdropFilter })(),
      sideBackdrop: (() => { const s = getComputedStyle(document.querySelector('.panel .dock-side')); return s.backdropFilter || s.webkitBackdropFilter })(),
      selBg: getComputedStyle(document.querySelector('.panel .dock-day.on')).backgroundColor,
      selColor: getComputedStyle(document.querySelector('.panel .dock-day.on .dd')).color,
      numColor: getComputedStyle(document.querySelector('.panel .dock-day:not(.on) .dd')).color,
      ovKcal: document.querySelector('.panel .ovcard .big')?.textContent ?? '',
      ovDate: document.querySelector('.panel .ovcard .ovgo')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      ovHasTitle: /摄入总览/.test(document.querySelector('.panel .ovcard')?.textContent ?? ''),
      mealEmpty: Boolean(document.querySelector('.panel .empty')),
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
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setPerf('ultra')
    check('超高档生效', (await evalJS(`document.documentElement.dataset.perf`)) === 'ultra',
      await evalJS(`document.documentElement.dataset.perf`))

    check('饮食历史入口可点开', await openHistory(false))
    await sleep(900)
    let s = await probe()
    await shot('ultra-rows')

    check('顶栏整条什么都不画：不铺底色、也不挂整宽模糊（超高）',
      alphaOf(s.weekbarBg) === 0 && !/blur/.test(s.weekbarBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop} panel=${s.panelBg} token=${s.fillToken}`)
    check('磨砂改挂在每一块玻璃上（胶囊 + 侧钮各自吃背影）',
      /blur/.test(s.pillBackdrop ?? '') && /blur/.test(s.sideBackdrop ?? ''),
      `pill=${s.pillBackdrop} side=${s.sideBackdrop}`)
    check('面板也是玻璃（对照组）', /blur/.test(s.panelBackdrop ?? ''), String(s.panelBackdrop))
    check('日选栏 7 天 + 选中今天', s.days === 7 && s.selDay.length > 0, `days=${s.days} sel=${s.selDay}`)
    check('Dock 构型：两侧圆钮 + 中间药丸',
      s.dockSides === 2 && alphaOf(s.pillBg) > 0, `sides=${s.dockSides} pill=${s.pillBg}`)
    check('选中格是中性提亮的药丸，不是主色实心块',
      s.selBg !== 'rgb(0, 110, 232)' && s.selBg !== s.pillBg, `sel=${s.selBg} pill=${s.pillBg}`)
    check('选中格文字转 --accent-strong', s.selColor === 'rgb(10, 94, 194)', s.selColor)
    check('当日摄入总览在场且挂着选中日',
      s.ovHasTitle && s.ovDate.length > 0 && Number(s.ovKcal) > 0, `${s.ovDate} · ${s.ovKcal} 大卡`)
    check('当日 7 笔记录（mock 种子）', s.rowCount === 7, `rows=${s.rowCount} ${s.rowNames.join('/')}`)
    check('行内有 4 格指标', s.firstRowCells.length === 4,
      s.firstRowCells.map((c) => `${c.label} ${c.width}`).join(' | '))
    check('指标格显示占本日百分比', s.firstRowCells.every((c) => /%$/.test(c.label.split(' ').pop() ?? '')),
      s.firstRowCells.map((c) => c.label).join(' | '))
    check('指标条有色且有填充', s.firstRowCells.every((c) => c.bg.includes('var') && parseFloat(c.width) > 0),
      s.firstRowCells.map((c) => `${c.bg} ${c.width}`).join(' | '))
    check('行副标题保留具体克重', /g/.test(s.rowSubs[0] ?? ''), s.rowSubs[0])

    // 内容滚过吸顶条：周条应压在内容之上（视觉核对用）
    await evalJS(`document.querySelector('.panel .body').scrollTop = 520`)
    await shot('ultra-weekbar-scrolled')
    const wbBox = await evalJS(`(() => {
      const r = document.querySelector('.panel .weekbar').getBoundingClientRect()
      return { x: r.left, y: Math.max(0, r.top - 56), w: r.width, h: r.height + 132 }
    })()`)
    await shotClip('ultra-weekbar-clip', wbBox.x, wbBox.y, wbBox.w, wbBox.h)

    /* ============ ② 摄入总览：切日 + 点开当日营养全览 ============ */
    console.log('\n[2] 摄入总览 · 切日与「营养全览」')
    await evalJS(`document.querySelector('.panel .body').scrollTop = 0`)
    await evalJS(`document.querySelector('.panel .ovcard')?.click()`)
    const ovOpen = await waitFor(`(() => {
      const ps = document.querySelectorAll('.panel')
      return ps.length === 2 && Boolean(ps[1].querySelector('.scard .ov'))
    })()`)
    check('点摄入总览打开「营养全览」抽屉', ovOpen)
    if (ovOpen) {
      const nd = await evalJS(`(() => {
        const ps = [...document.querySelectorAll('.panel')]
        const d = ps[ps.length - 1]
        return {
          title: [...d.querySelectorAll('.head h2')][0]?.textContent ?? '',
          kcal: d.querySelector('.scard .big')?.textContent ?? '',
          cards: d.querySelectorAll('.cards .card').length,
          rows: d.querySelectorAll('.cards .item').length,
          hasMicro: /微量元素/.test(d.textContent),
          cardBg: getComputedStyle(d.querySelector('.cards .card')).backgroundColor,
          sheetFill: getComputedStyle(document.documentElement).getPropertyValue('--sheet-card-fill').trim(),
        }
      })()`)
      await shot('ultra-intake-detail')
      check('标题 = 营养全览 · 选中日', nd.title === `营养全览 · ${s.ovDate}`, `${nd.title} vs 营养全览 · ${s.ovDate}`)
      check('这一天的热量与历史里那条逐字一致', nd.kcal === s.ovKcal, `${nd.kcal} vs ${s.ovKcal}`)
      check('宏量 + 微量元素两张卡都在（复用页面级组件）',
        nd.cards === 2 && nd.rows >= 17 && nd.hasMicro, `cards=${nd.cards} rows=${nd.rows}`)
      check('两张页面级卡片在抽屉里换成抽屉白卡材质（不是页面级 .card 的玻璃底）',
        nd.cardBg === nd.sheetFill, `card=${nd.cardBg} --sheet-card-fill=${nd.sheetFill}`)
      await evalJS(`document.querySelectorAll('.panel')[1].querySelector('.head .close')?.click()`)
      await sleep(700)
      check('营养全览关闭后回到历史', (await evalJS(`document.querySelectorAll('.panel').length`)) === 1)
    }

    // 翻到没有记录的那一周（mock 只种了今天）：总览必须跟着这一天走，不能留着今天的数据
    await evalJS(`document.querySelector('.panel [aria-label="上一周"]')?.click()`)
    await sleep(400)
    await evalJS(`(() => { const d = [...document.querySelectorAll('.panel .dock-day')]; d[d.length - 1]?.click() })()`)
    await sleep(900)
    const past = await probe()
    check('切到无记录的过去某天：总览归零、日期跟着换',
      past.ovKcal === '0' && past.ovDate !== s.ovDate && past.mealEmpty,
      `${past.ovDate} ${past.ovKcal} 大卡 empty=${past.mealEmpty}`)
    await shot('ultra-past-day')
    // 回本周：上一周最后一格 +7 天必落在今天或之后，会被钳回今天
    await evalJS(`document.querySelector('.panel [aria-label="下一周"]')?.click()`)
    await sleep(700)

    /* ============ ③ 单笔详情 ============ */
    console.log('\n[3] 点行 → 单笔详情')
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

    /* ============ ④ 暗色 · 超高 ============ */
    console.log('\n[4] 暗色 · 超高')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(700)
    s = await probe()
    check('暗色下顶栏同样不画东西（透明 + 无整宽模糊），磨砂仍在块上',
      alphaOf(s.weekbarBg) === 0 && !/blur/.test(s.weekbarBackdrop ?? '') && /blur/.test(s.pillBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop} pill=${s.pillBackdrop} panel=${s.panelBg}`)
    check('暗色下日选栏仍是中性药丸 + 选中文字换色（不是主色块）',
      s.selBg !== 'rgb(0, 110, 232)' && s.selColor !== s.numColor, `sel=${s.selBg} ${s.selColor} vs ${s.numColor}`)
    await shot('dark-rows')
    // 暗色下的当日营养全览：同一张抽屉白卡，材质跟着暗色档走
    await evalJS(`document.querySelector('.panel .ovcard')?.click()`)
    await waitFor(`document.querySelectorAll('.panel').length === 2`)
    await shot('dark-intake-detail')
    await evalJS(`document.querySelectorAll('.panel')[1]?.querySelector('.head .close')?.click()`)
    await sleep(600)
    await evalJS(`document.querySelector('.panel button.row.pressable')?.click()`)
    await waitFor(`document.querySelectorAll('.panel').length === 2`)
    await shot('dark-detail')
    await evalJS(`document.querySelectorAll('.panel')[1]?.querySelector('.head .close')?.click()`)
    await sleep(600)
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(800)

    /* ============ ⑤ 流畅档回落 ============ */
    console.log('\n[5] 移动端 · 流畅档（回落实底）')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setPerf('low')
    check('流畅档生效', (await evalJS(`document.documentElement.dataset.perf`)) === 'low')
    check('饮食历史可再开', await openHistory(false))
    await sleep(900)
    s = await probe()
    check('流畅档周条回落实底、与面板同色',
      s.weekbarBg === s.panelBg && alphaOf(s.weekbarBg) === 1, `weekbar=${s.weekbarBg} panel=${s.panelBg}`)
    check('流畅档周条无模糊', !/blur/.test(s.weekbarBackdrop ?? ''), String(s.weekbarBackdrop))
    check('流畅档 Dock 块也退回实底、无模糊',
      alphaOf(s.pillBg) === 1 && !/blur/.test(s.pillBackdrop ?? ''), `pill=${s.pillBg} ${s.pillBackdrop}`)
    check('流畅档选中药丸仍与容器可辨（实底档不走令牌的薄底）',
      s.selBg !== s.pillBg && alphaOf(s.selBg) === 1, `sel=${s.selBg} pill=${s.pillBg}`)
    await shot('low-rows')
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(700)

    /* ============ ⑥ 桌面便当入口 ============ */
    console.log('\n[6] 桌面 1440 · 超高（同一组件的另一入口）')
    await viewport(1440, 900, false)
    await setPerf('ultra')
    check('便当饮食条可点开', await openHistory(true))
    await sleep(900)
    s = await probe()
    check('桌面顶栏同为透明 + 无整宽模糊（磨砂在块上）',
      alphaOf(s.weekbarBg) === 0 && !/blur/.test(s.weekbarBackdrop ?? '') && /blur/.test(s.pillBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop} pill=${s.pillBackdrop}`)
    await shot('desk-rows')
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(700)

    /* ============ ⑦ 窄屏 320：七格日选栏不横向溢出 ============ */
    console.log('\n[7] 窄屏 320 · 日选栏不溢出')
    await viewport(320, 568, true)
    await sleep(900)
    check('饮食历史可再开（320）', await openHistory(false))
    await sleep(900)
    const narrow = await evalJS(`(() => {
      const bar = document.querySelector('.panel .weekbar')
      const pill = document.querySelector('.panel .dock-pill')
      const day = document.querySelector('.panel .dock-day')
      return {
        barOver: bar.scrollWidth - bar.clientWidth,
        pillOver: pill.scrollWidth - pill.clientWidth,
        dayW: Math.round(day.getBoundingClientRect().width),
        numW: Math.round(day.querySelector('.dd').getBoundingClientRect().width),
      }
    })()`)
    check('日选栏在 320 宽下不横向溢出',
      narrow.barOver <= 1 && narrow.pillOver <= 1 && narrow.numW <= narrow.dayW,
      `bar=+${narrow.barOver}px pill=+${narrow.pillOver}px 格宽=${narrow.dayW} 数字=${narrow.numW}`)
    await shot('narrow-320')

    /* ============ ⑧ 高画质档：条材质与超高同一套 ============ */
    console.log('\n[8] 高画质 · 顶栏同样不画东西')
    await viewport(430, 932, true)
    await setPerf('high')
    check('高画质档生效', (await evalJS(`document.documentElement.dataset.perf`)) === 'high',
      await evalJS(`document.documentElement.dataset.perf`))
    check('饮食历史可再开（high）', await openHistory(false))
    await sleep(900)
    s = await probe()
    check('高画质顶栏同样不铺底色、不挂整宽模糊（磨砂在块上）',
      alphaOf(s.weekbarBg) === 0 && !/blur/.test(s.weekbarBackdrop ?? '') && /blur/.test(s.pillBackdrop ?? ''),
      `weekbar=${s.weekbarBg} backdrop=${s.weekbarBackdrop} pill=${s.pillBackdrop} side=${s.sideBackdrop}`)
    await shot('high-rows')

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
