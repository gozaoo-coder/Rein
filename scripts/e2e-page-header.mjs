/**
 * e2e-page-header —— 页面标题固定 + 渐进模糊遮罩 E2E（无头 Edge + 原生 CDP）
 *
 * 覆盖四件事：
 *   1 页头是 sticky（不是 fixed）：移动端贴文档顶，桌面壳里贴 .desk-main 顶，
 *     不会跑到导航轨 / 信息栏底下去
 *   2 未滚动时遮罩完全透明（顶部没有内容经过，不该出现任何底色）
 *   3 滚动后遮罩显形，且由多层 backdrop-filter + mask 梯度构成（渐进模糊）
 *   4 性能降级档（localStorage rein.perf.v1 = low）下不给 backdrop-filter，
 *     改铺「底色 → 透明」渐变；同时毛玻璃表面换成实底
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-page-header.mjs
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-header-${Date.now()}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()
const loadWaiters = []

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 等一次真正的整页加载。超时返回 false（不抛——调用方自己有后续的挂载等待能报错） */
function waitLoad(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs)
    loadWaiters.push(() => {
      clearTimeout(t)
      resolve(true)
    })
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  if (!r?.data) return
  const file = `${process.env.TEMP}/rein-e2e-header-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
}

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 滚到页面中部；两种壳的滚动容器不同，按实际可滚的那个滚 */
const SCROLL_MID = `(() => {
  const main = document.querySelector('.desk-main')
  if (main && main.scrollHeight > main.clientHeight) {
    main.scrollTop = 320
    return { via: '.desk-main', top: main.scrollTop }
  }
  window.scrollTo(0, 320)
  return { via: 'window', top: window.scrollY }
})()`

const SCROLL_TOP = `(() => {
  const main = document.querySelector('.desk-main')
  if (main) main.scrollTop = 0
  window.scrollTo(0, 0)
  return true
})()`

/** 页头 + 遮罩的当下状态 */
const HEADER_STATE = `(() => {
  const h = document.querySelector('.page-header')
  if (!h) return { error: '没有 .page-header' }
  const cs = getComputedStyle(h)
  const hr = h.getBoundingClientRect()
  const mask = h.querySelector('.ph-mask')
  const mcs = mask ? getComputedStyle(mask) : null
  const mr = mask ? mask.getBoundingClientRect() : null
  const spans = mask ? [...mask.querySelectorAll('span')] : []
  const viewportTop = (() => {
    const main = document.querySelector('.desk-main')
    return main ? main.getBoundingClientRect().top : 0
  })()
  return {
    position: cs.position,
    zIndex: cs.zIndex,
    headerTop: Math.round(hr.top),
    headerHeight: Math.round(hr.height),
    headerLeft: Math.round(hr.left),
    headerRight: Math.round(hr.right),
    maskLeft: mr ? Math.round(mr.left) : null,
    maskRight: mr ? Math.round(mr.right) : null,
    maskBottom: mr ? Math.round(mr.bottom) : null,
    maskTail: mr ? Math.round(mr.bottom - hr.bottom) : null,
    viewportTop: Math.round(viewportTop),
    scrollInfo: (() => {
      const main = document.querySelector('.desk-main')
      const el = main ?? document.scrollingElement
      return {
        sel: main ? '.desk-main' : 'document',
        top: Math.round(el.scrollTop),
        h: el.scrollHeight,
        c: el.clientHeight,
        winY: Math.round(window.scrollY),
      }
    })(),
    scrolledClass: h.classList.contains('scrolled'),
    liteClass: h.classList.contains('lite'),
    maskOpacity: mcs ? mcs.opacity : null,
    maskBg: mcs ? mcs.backgroundImage.slice(0, 60) : null,
    layerCount: spans.length,
    layerBlur: spans[0] ? getComputedStyle(spans[0]).backdropFilter : null,
    layerMask: spans[0] ? getComputedStyle(spans[0]).maskImage.slice(0, 70) : null,
    perfAttr: document.documentElement.dataset.perf ?? '(未设)',
    tabbarBg: (() => {
      const t = document.querySelector('.dock')
      if (!t) return '(无 TabBar)'
      const cs = getComputedStyle(t)
      // 底栏的底色是**两层渐变**画的（padding-box 实底 + border-box 受光描边），
      // 所以 backgroundColor 恒为 transparent —— 要看的是 background-image 里那层底色。
      // 描边那一层本来就是半透明发丝线，别把它算进来
      return cs.backgroundImage.split('),').slice(0, 2).join('),').slice(0, 120)
    })(),
    /** 玻璃填充变量：低档下被顶成 --surface（不透明），加强档下是半透明的 */
    glassFill: getComputedStyle(document.documentElement).getPropertyValue('--glass-fill').trim(),
  }
})()`

async function connect(debugPort, url, seedScript) {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      p.resolve(m.result ?? m.error)
      return
    }
    if (m.method === 'Page.loadEventFired') loadWaiters.splice(0).forEach((fn) => fn())
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  // 异常收集器跟着每次整页加载重装：后面有多轮 reload，只 eval 一次会在重载后失效
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
addEventListener('error', (e) => window.__errs.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
  })
  if (seedScript) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: seedScript })
  const loaded = waitLoad()
  await cdp('Page.navigate', { url })
  await loaded
  await waitFor(`!!document.querySelector('.page-header')`, 15000, '页头挂载')
  await sleep(800)
}

/** 导航到目标路由；URL 与当前一致时走 reload，否则 Page.navigate 到新 URL。
 *  两种情况都等真正的 load 事件——只等 location.href 相等会在「同 URL 重载」时
 *  立刻返回，then 读到的是上一份文档的状态。 */
async function navigateTo(url) {
  const same = String(await evalJS('location.href')) === url
  const loaded = waitLoad()
  if (same) await cdp('Page.reload', { ignoreCache: true })
  else await cdp('Page.navigate', { url })
  await loaded
  await waitFor(`!!document.querySelector('.page-header')`, 15000, '页头挂载')
  await sleep(600)
}

async function main() {
  const debugPort = await freePort()
  /** 档位钉死：这些断言验的是遮罩怎么渲染，不该被无头环境的掉帧判定搅进来 */
  const pinHigh = `localStorage.setItem('rein.perf.v1', 'high');`
  const pinLow = `localStorage.setItem('rein.perf.v1', 'low');`
  // 「auto」写进去只是为了明确：**默认档就是 auto**（缺省时 `loadMode()` 回落到 auto），
  // 所以 removeItem 得到的也是 auto —— 见下面的 22b。
  const pinAuto = `localStorage.setItem('rein.perf.v1', 'auto');`
  /** 抹掉本地档位 = 全新安装的样子 */
  const clearPerf = `localStorage.removeItem('rein.perf.v1');`

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(debugPort, `${APP}/#/settings`, pinHigh)

    /* ---------- 1 移动端：sticky 且未滚动时遮罩透明 ---------- */
    await waitFor(`document.querySelector('h1')?.textContent === '设置'`, 10000, '设置页挂载')
    await evalJS(SCROLL_TOP)
    await sleep(300)
    let s = await evalJS(HEADER_STATE)
    ok('1 页头为 sticky（非 fixed）', s.position === 'sticky', `position=${s.position}`)
    ok('2 页头建立层叠上下文（z-index 非 auto）', s.zIndex !== 'auto', `z-index=${s.zIndex}`)
    ok('3 未滚动时遮罩透明', s.maskOpacity === '0', `opacity=${s.maskOpacity}`)
    ok('4 未滚动时无 scrolled 类', !s.scrolledClass)
    ok('5 渐进模糊层已就位（5 层）', s.layerCount === 5, `层数=${s.layerCount}`)
    ok(
      '6 每层带 backdrop-filter: blur',
      String(s.layerBlur).includes('blur'),
      String(s.layerBlur),
    )
    ok(
      '7 每层带 mask 梯度（限定纵向区间）',
      String(s.layerMask).includes('linear-gradient'),
      String(s.layerMask),
    )
    const layerBlurs = await evalJS(
      `[...document.querySelectorAll('.ph-mask span')].map(s => getComputedStyle(s).backdropFilter)`,
    )
    ok(
      '8 各层模糊量递增（越靠上叠加越浓）',
      new Set(layerBlurs).size === layerBlurs.length && layerBlurs[0] !== layerBlurs[4],
      layerBlurs.join(' | '),
    )
    await shot('1-mobile-top')

    /* ---------- 2 滚动后：页头贴顶 + 遮罩显形 ---------- */
    const sc = await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok('9 滚动生效', sc.top > 0, `经 ${sc.via} 滚到 ${sc.top}`)
    ok('10 滚动后遮罩显形', s.maskOpacity === '1', `opacity=${s.maskOpacity}`)
    ok('11 滚动后挂上 scrolled 类', s.scrolledClass)
    ok(
      '12 页头仍贴容器顶（未被滚走）',
      Math.abs(s.headerTop - s.viewportTop) <= 1,
      `headerTop=${s.headerTop} 容器顶=${s.viewportTop}`,
    )
    await shot('2-mobile-scrolled')

    /* ---------- 3 桌面壳：sticky 跟着 .desk-main ---------- */
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(800)
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_TOP)
    await sleep(300)
    const deskScrolled = await evalJS(SCROLL_MID)
    await sleep(400)
    s = await evalJS(HEADER_STATE)
    ok('13 桌面壳存在 .desk-main 且由它滚动', deskScrolled.via === '.desk-main', deskScrolled.via)
    ok(
      '14 桌面壳里页头贴 .desk-main 顶（没有跑到导航轨底下）',
      Math.abs(s.headerTop - s.viewportTop) <= 1,
      `headerTop=${s.headerTop} .desk-main顶=${s.viewportTop}`,
    )
    ok('15 桌面壳里遮罩同样显形', s.maskOpacity === '1', `opacity=${s.maskOpacity}`)
    await shot('3-desktop-scrolled')

    await cdp('Emulation.clearDeviceMetricsOverride')
    await sleep(600)

    /* ---------- 4 降级档：不用 backdrop-filter，改底色遮罩 ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pinLow })
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok('16 降级档写入 html[data-perf=low]', s.perfAttr === 'low', s.perfAttr)
    ok('17 降级档不再渲染模糊层', s.layerCount === 0, `层数=${s.layerCount}`)
    ok(
      '18 降级档遮罩为底色 → 透明渐变',
      String(s.maskBg).includes('gradient'),
      String(s.maskBg),
    )
    ok('19 降级档页头仍固定贴顶', Math.abs(s.headerTop - s.viewportTop) <= 1, `headerTop=${s.headerTop}`)
    ok('20 降级档遮罩显形', s.maskOpacity === '1', `opacity=${s.maskOpacity}`)
    ok(
      '21 降级档毛玻璃表面换成实底（玻璃填充不再半透明）',
      // 低档下 --glass-fill 被顶成 --surface：取得的值必须是不透明色。
      // 出现 rgba(...,0.x) / 8 位 hex 带 alpha 就说明半透明底还在（关掉 blur 后会成灰膜）
      (() => {
        const v = String(s.glassFill)
        if (/^rgb\(/.test(v)) return true
        if (/^rgba\(/.test(v)) return !/,\s*0?\.\d+\s*\)$/.test(v)
        if (/^#[0-9a-f]{6}$/i.test(v)) return true
        if (/^#[0-9a-f]{8}$/i.test(v)) return /ff$/i.test(v)
        return /^#[0-9a-f]{3}$/i.test(v)
      })(),
      `--glass-fill = ${s.glassFill} · dock=${String(s.tabbarBg).slice(0, 70)}`,
    )
    ok(
      '22 降级档全局不给 backdrop-filter',
      await evalJS(
        `getComputedStyle(document.querySelector('.dock')).backdropFilter === 'none'`,
      ),
    )
    await shot('4-degraded-scrolled')

    /* ---------- 4b 全新安装（没有本地档位）：默认必须是高画质 ----------
       0.2.5 → 0.2.7 升级后「渐进式模糊消失」就是这里翻的车：默认档是 low，
       而遮罩是 v-if="!perfDegraded"，于是装完就少了一块设计。 */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: clearPerf })
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok(
      '22b 全新安装（无本地档位）默认高画质：渐进模糊在',
      s.perfAttr === 'high' && s.layerCount === 5,
      `data-perf=${s.perfAttr} 层数=${s.layerCount}`,
    )

    /* ---------- 5 默认档（auto）：空闲时保持高画质 ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pinAuto })
    await navigateTo(`${APP}/#/settings`)
    await evalJS(SCROLL_MID)
    await sleep(500)
    s = await evalJS(HEADER_STATE)
    ok('23 默认 auto 档空闲时仍为高画质', s.perfAttr === 'high' && s.layerCount === 5, `data-perf=${s.perfAttr} 层数=${s.layerCount}`)

    /* ---------- 6 其它页标题同样固定 ---------- */
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: pinHigh })
    for (const [route, title] of [
      ['#/me', '我'],
      ['#/nutrition', '营养全览'],
      ['#/ledger', '记账'],
    ]) {
      await navigateTo(`${APP}/${route}`)
      await evalJS(SCROLL_MID)
      await sleep(500)
      const st = await evalJS(HEADER_STATE)
      ok(
        `24 ${route} 页头固定、标题为「${title}」且滚动后显形遮罩`,
        Math.abs(st.headerTop - st.viewportTop) <= 1 && st.maskOpacity === '1' && st.scrolledClass,
        `headerTop=${st.headerTop} opacity=${st.maskOpacity} scrolled=${st.scrolledClass}`,
      )
      const h1 = await evalJS(`document.querySelector('.page-header h1')?.textContent ?? '(无)'`)
      ok(`25 ${route} 页头标题文本正确`, h1 === title, `h1=${h1}`)
    }

    /* ---------- 7 暗色 + 桌面便当页 ---------- */
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await navigateTo(`${APP}/#/`)
    const homeScroll = await evalJS(SCROLL_MID)
    await sleep(600)
    s = await evalJS(HEADER_STATE)
    console.log(`      [home 滚动] ${JSON.stringify(homeScroll)} · 实际 ${JSON.stringify(s.scrollInfo)}`)
    ok(
      '27 暗色 + 桌面便当页：页头固定、遮罩显形、模糊层在位',
      Math.abs(s.headerTop - s.viewportTop) <= 1 && s.maskOpacity === '1' && s.layerCount === 5 && s.scrollInfo.top > 0,
      `headerTop=${s.headerTop} opacity=${s.maskOpacity} 层数=${s.layerCount} 滚动=${JSON.stringify(s.scrollInfo)}`,
    )
    ok('28 遮罩向左右铺出页头之外（盖满整帧，不留未模糊的窄条）', s.maskLeft < s.headerLeft && s.maskRight > s.headerRight, `mask=${s.maskLeft}..${s.maskRight} header=${s.headerLeft}..${s.headerRight}`)
    ok('29 遮罩向下超出页头（模糊有化开的空间）', s.maskTail > 0, `超出 ${s.maskTail}px`)
    await shot('5-desktop-dark-home')

    /* ---------- 8 运行期异常 ---------- */
    const errs = await evalJS(`window.__errs ?? ['(收集器未装)']`)
    ok('30 运行期无未捕获异常', Array.isArray(errs) && errs.length === 0, (errs ?? []).join(' | '))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

void main()
