/**
 * e2e-glass-perf —— 液态玻璃的**性能台架**（无头 Edge + 原生 CDP）
 *
 * 为什么要有这一份：`e2e-perf-glass.mjs` 管的是「画得对不对」（逐像素、对比度、
 * 原语数），而「贵不贵」是另一回事 —— 后者只有真的把帧跑起来、量帧时间才算数。
 * 计算样式与 DOM 计数都看不出 `backdrop-filter: url(#f)` 每帧重采样背景的开销。
 *
 * 量法（两条，缺一不可）：
 *   A 隔离台架：画质预览页的标本台（`.bench`）自带 rAF 驱动的光晕动画与可横拖的
 *     壁纸条，本来就是为「看得出位移」造的台子 —— 顺手就是最干净的负载源。
 *     每帧推一下 `.strip` 的 scrollLeft（模拟内容从玻璃底下移动过去，这正是
 *     backdrop-filter 最贵的那一刻），量 rAF 间隔。
 *   B 真实页面：营养页滚动时量帧 —— 折射名单里的 Dock 三块玻璃压在滚动内容之上，
 *     与用户实际遇到的路径一致。
 *
 * **为什么必须抓 trace 而不是只看 rAF 间隔**：`backdrop-filter` 的位移与模糊发生在
 * **光栅阶段**（compositor / raster worker），不在渲染主线程上。只量 rAF 会得到一个
 * 「主线程根本没花时间」的假象 —— 无头环境里去掉 vsync 之后甚至能读到 5800fps。
 * 所以这一份的主指标是 `Tracing` 抓下来的 **RasterTask 总时长 ÷ 帧数**：它是这条链上
 * 真正付钱的地方，也正是「玻璃更贵了」会体现出来的地方。rAF 间隔只作为**掉帧**的
 * 旁证（正常 vsync 下 16.7 / 33.3 / 50 的台阶）。
 *
 * 「玻璃的净成本」= 该档光栅成本 − 流畅档光栅成本（流畅档全局关掉 backdrop-filter，
 * 是同一页面同一滚动负载下的空白对照）。**跨档只比净成本**，不比绝对量 ——
 * 后者会被页面本身的负载盖住。
 *
 * 关于无头环境：SwiftShader 软件光栅与真机 GPU 的绝对数字不可比，所以这一份只用来
 * 看**同一台机器上的相对关系**（塌缩链 vs 完整链、加了什么之后贵了多少）。
 * 跨设备下结论必须回到真机。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-glass-perf.mjs
 * 产物：%TEMP%/rein-shots/glass-perf/*.png（截图留档）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行台架')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = `${process.env.TEMP}/rein-shots/glass-perf`
const USER_DATA = `${process.env.TEMP}/rein-e2e-glass-perf-${Date.now()}`
/** 一段测量的帧数：60 帧在 60Hz 上是一秒，取 150 帧把抖动摊平 */
const FRAMES = Number(process.env.REIN_PERF_FRAMES ?? 150)
/** trace 类别：cc / viz / gpu 是光栅与合成，devtools.timeline 是渲染主线程 */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'cc',
  'viz',
  'gpu',
  'benchmark',
  'blink.user_timing',
].join(',')

let ws
let msgId = 0
const pending = new Map()
/** 同一份 trace 会包含多个进程的片段，按 pid 分开聚合 */
let traceEvents = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}


async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

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

function save(file, base64) {
  if (base64) writeFileSync(`${OUT}/${file}.png`, Buffer.from(base64, 'base64'))
}

async function shot(file) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  save(file, r?.data)
  return r?.data ?? null
}

/**
 * 位移**停住**之后再截图，并回报当时的滚动位置与遮罩显隐。
 *
 * 为什么必须停住：负载每帧在推 scrollTop，两张截图会落在不同的滚动相位上 ——
 * 量出来的「像素差」其实是滚动位置差，与被测的实现无关（第一版白量了一轮）。
 *
 * 顺带记一笔这里的**能力边界**：这一节量的是成本，不做逐像素比对。
 * 试过，两轮都不作数：① 相位没停住时量到的是位置差；② 停住之后全帧差恒为 0 ——
 * 因为驱动负载的 sine 会把页面来回拖过整段内容，停下时页头底下那一屏恰好是纯白卡片，
 * 糊与不糊逐像素一样。真要验「换实现后是否还是同一块玻璃」，得另起一个
 * **不驱动滚动**的台子（静态页面 + 定点截图），别在负载里顺手做。
 */
async function stillShot(file) {
  await evalJS('(() => { window.__still = true; document.scrollingElement.scrollTop = 600; return true })()')
  await sleep(320)
  const data = await shot(file)
  const at = await evalJS(`(() => ({
    scrollTop: Math.round(document.scrollingElement.scrollTop),
    maskOn: getComputedStyle(document.querySelector('.pblur span') ?? document.body).opacity,
  }))()`)
  await evalJS('(() => { window.__still = false; return true })()')
  return { data, at }
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(((sorted.length - 1) * p) / 100)))
  return sorted[i]
}

function stats(deltas) {
  if (!deltas.length) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, fps: 0 }
  // 头一帧会带上「从静到动」的启动成本（首次重采样背景），与稳态无关
  const s = deltas.slice(1).sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return {
    n: s.length,
    mean: +mean.toFixed(2),
    p50: +pct(s, 50).toFixed(2),
    p95: +pct(s, 95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    fps: +(1000 / mean).toFixed(1),
  }
}

/** 帧时间采样：每帧推一下负载源（见文件头），返回 rAF 间隔数组 */
function sampler(body, frames = FRAMES) {
  return `(async () => {
    const tick = ${body}
    const out = []
    await new Promise((res) => {
      let last = 0
      let n = 0
      const step = (ts) => {
        if (last) out.push(ts - last)
        last = ts
        tick(n)
        n += 1
        if (n < ${frames}) requestAnimationFrame(step)
        else res()
      }
      requestAnimationFrame(step)
    })
    return out
  })()`
}

let failed = 0
function ok(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed += 1
}

/* ---------- trace 聚合 ---------- */

/**
 * 把一段 trace 归成「每帧成本」。帧数取 rAF 实测产出数（trace 覆盖的就是那段）——
 * 不要自己去数 trace 里的帧事件：`Graphics.Pipeline` 每帧发好几步，数出来是步数不是帧数。
 *
 * 主指标是 `Graphics.Pipeline` ÷ 帧数：这是 viz 合成器对一帧的总记账，
 * 背景滤镜就落在这一步里。旁证两列是合成绘制与 OutputSurface 的收尾，
 * 它们同向变化才说明「贵在滤镜」而不是「贵在别处」。
 */
function summarizeTrace(events, frames) {
  const nameDur = new Map()

  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue
    nameDur.set(e.name, (nameDur.get(e.name) || 0) + e.dur)
  }

  const per = (name) => (frames ? +((nameDur.get(name) || 0) / 1000 / frames).toFixed(3) : 0)
  const top = [...nameDur.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n, us]) => ({ n, ms: +(us / 1000).toFixed(1) }))

  return {
    frames,
    /** 一帧的合成管线总时间（含背景滤镜） */
    pipelineMs: per('Graphics.Pipeline'),
    /** 合成器真正的绘制（滤镜在这一步作用在背景上） */
    drawMs: per('DirectRenderer::DrawFrame'),
    /** 绘制通道收尾（软件光栅时这一项最重） */
    paintMs: per('SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass'),
    top,
  }
}

/** 抓一段 trace，同时把负载跑起来（负载就是被测对象，所以必须在 trace 里跑） */
async function traceWhile(body, frames = FRAMES) {
  traceEvents = []
  const done = new Promise((resolve) => {
    const prev = ws.onmessage
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.method === 'Tracing.dataCollected') {
        traceEvents.push(...(m.params?.value ?? []))
        return
      }
      if (m.method === 'Tracing.tracingComplete') {
        ws.onmessage = prev
        resolve()
        return
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result ?? m.error)
        pending.delete(m.id)
      }
    }
  })
  await cdp('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' })
  const deltas = await evalJS(sampler(body, frames))
  await cdp('Tracing.end')
  await done
  // 首帧带着「从静到动」的启动成本（贴图首次采样、图层首次合成），与稳态无关
  return { deltas, trace: summarizeTrace(traceEvents, Math.max(1, deltas.length - 1)) }
}

function row(label, s, extra = '') {
  console.log(
    `      ${label.padEnd(20)} 帧管线 ${String(s.pipelineMs).padStart(6)}ms/帧 · 合成绘制 ${String(s.drawMs).padStart(6)} · 收尾 ${String(s.paintMs).padStart(6)} · ${extra}`,
  )
}

/** 台架负载源：标本台的壁纸条横推一格（玻璃底下的内容真的在动） */
const BENCH_LOAD = `() => {
  const strip = document.querySelector('.bench .strip')
  if (!strip) return
  const max = strip.scrollWidth - strip.clientWidth
  strip.scrollLeft = max > 0 ? (strip.scrollLeft + 6) % max : 0
}`


/** 真实页面负载源：整页滚一格（Dock 三块玻璃底下的内容真的在动） */
const PAGE_LOAD = `() => {
  if (window.__still) return
  const el = document.scrollingElement
  const max = el.scrollHeight - el.clientHeight
  if (max <= 0) return
  const span = Math.min(max, 1400)
  el.scrollTop = Math.round(((Math.sin(window.__p = (window.__p || 0) + 0.035) + 1) / 2) * span)
}`

/** 玻璃负载的结构计数（面积 / 原语 / 模糊量）：净成本该与它们同向 */
const GLASS_LOAD_PROBE = `(() => {
  const seen = new Set()
  const surfaces = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const bf = String(cs.backdropFilter || cs.webkitBackdropFilter || 'none')
    if (!bf.includes('url(') && !bf.includes('blur(')) continue
    // 同一块玻璃会同时命中 -webkit- 与标准属性：按元素去重
    if (seen.has(el)) continue
    seen.add(el)
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    surfaces.push({ w: Math.round(r.width), h: Math.round(r.height), refract: bf.includes('url('), bf })
  }
  const filters = [...document.querySelectorAll('.gdefs filter')].filter((f) => getComputedStyle(f.ownerSVGElement).display !== 'none')
  const prims = filters.map((f) => f.children.length)
  const sigma = filters.reduce((a, f) => a + [...f.querySelectorAll('feGaussianBlur')].reduce((b, g) => b + Number(g.getAttribute('stdDeviation') || 0), 0), 0)
  return {
    tier: document.documentElement.dataset.perf,
    glass: document.documentElement.dataset.glass,
    surfaces: surfaces.length,
    refracting: surfaces.filter((s) => s.refract).length,
    // 面积是成本的一阶项：折射/模糊都是「按这块区域重采样」
    area: surfaces.reduce((a, s) => a + s.w * s.h, 0),
    planes: surfaces.filter((s) => s.bf.includes('blur(')).length,
    filters: filters.length,
    prims,
    primTotal: prims.reduce((a, b) => a + b, 0),
    sigma: +sigma.toFixed(2),
  }
})()`

async function main() {
  mkdirSync(OUT, { recursive: true })
  const debugPort = await freePort()
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--force-device-scale-factor=1',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,930',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
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
        pending.get(m.id)(m.result ?? m.error)
        pending.delete(m.id)
      }
    }
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 930,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        localStorage.setItem('rein.perf.v1', window.name || 'ultra');
        localStorage.setItem('rein.motion.v1', 'off');
        const applySafe = () => {
          document.documentElement.style.setProperty('--safe-top-native', '32px');
          document.documentElement.style.setProperty('--safe-bottom-native', '48px');
        };
        if (document.documentElement) applySafe();
        else addEventListener('DOMContentLoaded', applySafe, { once: true });
        window.__errs = [];
        addEventListener('error', (e) => window.__errs.push(String(e.message)));
        addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String(e.reason)));`,
    })

    const dismiss = `(() => { const b = [...document.querySelectorAll('.up-actions .up-btn')].find((x) => x.textContent.includes('稍后')); if (b) { b.click(); return true } return false })()`
    const setTier = async (tier) => {
      await evalJS(`window.name = ${JSON.stringify(tier)}`)
      await evalJS('location.reload()')
      await sleep(2400)
      if (await evalJS(dismiss)) await sleep(500)
    }

    const tiers = ['low', 'high', 'ultra', 'extreme']
    const report = { bench: {}, page: {}, load: {} }
    /** 只跑某几节（`REIN_PERF_ONLY=material`）：调 D 节那种要反复试的用法不必每次跑全套 */
    const ONLY = (process.env.REIN_PERF_ONLY ?? '').split(',').filter(Boolean)
    const skip = (id) => ONLY.length > 0 && !ONLY.includes(id)

    /** 冻住光晕动画的相位差异：四档量的是同一个负载源，不是四次不同的动画 */
    const freezeGlow = `(() => {
      let s = document.getElementById('perf-freeze')
      if (!s) { s = document.createElement('style'); s.id = 'perf-freeze'; document.head.appendChild(s) }
      s.textContent = '.bench .glow { animation: none !important }'
      return true
    })()`

    /** 一次完整测量：切档 → 到目标页 → 预热 → 抓 trace + 量 rAF */
    const measure = async (tier, url, body, tag) => {
      await setTier(tier)
      await cdp('Page.navigate', { url })
      await sleep(2400)
      if (await evalJS(dismiss)) await sleep(500)
      await evalJS(freezeGlow)
      await evalJS(`window.__p = 0`)
      // 预热：滤镜首次光栅化、贴图解码、首帧重采样都是一次性成本，不进稳态
      await evalJS(sampler(body, 30))
      await sleep(250)
      const { deltas, trace } = await traceWhile(body)
      const load = await evalJS(GLASS_LOAD_PROBE)
      report[tag][tier] = { ...trace, raf: stats(deltas) }
      report.load[`${tag}:${tier}`] = load
      await shot(`${tag}-${tier}`)
      return { trace, load, raf: stats(deltas) }
    }

    /** 逐档跑一遍，并把「这颗成本到底花在哪个事件上」摊开 —— 那不是猜，是 trace 里数出来的 */
    const sweep = async (title, url, body, tag) => {
      console.log(`\n=== ${title} ===`)
      for (const tier of tiers) {
        const { trace, load, raf } = await measure(tier, url, body, tag)
        row(`${tag === 'bench' ? '标本台' : '营养页滚动'} · ${tier}`, trace, `raf p95 ${raf.p95}ms · fps ${raf.fps}`)
        console.log(
          `      ${''.padEnd(20)} 玻璃面 ${load.surfaces} 块（折射 ${load.refracting} · 模糊 ${load.planes}）· 面积 ${load.area}px² · 滤镜 ${load.filters} 份 / 原语合计 ${load.primTotal} · Σσ ${load.sigma}`,
        )
        if (tier === 'extreme' || tier === 'ultra') {
          console.log(`      ${''.padEnd(20)} 耗时前几名（trace 实测）：${trace.top.map((t) => `${t.n} ${t.ms}ms`).join(' · ')}`)
        }
      }
      const base = report[tag].low
      const net = (t) => (report[tag][t].pipelineMs ?? 0) - (base.pipelineMs ?? 0)
      console.log(
        `\n      合成净成本（本档 − 流畅档，同页面同负载）：高画质 ${net('high').toFixed(3)}ms · 超高 ${net('ultra').toFixed(3)}ms · 极致 ${net('extreme').toFixed(3)}ms`,
      )
      return net
    }

    // ---------- A 隔离台架：画质预览页的标本台 ----------
    if (!skip('bench')) {
      await sweep(
        'A · 隔离台架（标本台：5 块玻璃 + 每帧横推壁纸，位移贴着底下的内容重采样）',
        `${APP}/#/settings/perf`,
        BENCH_LOAD,
        'bench',
      )
      const L = (k) => report.load[`bench:${k}`]
      const cLow = report.bench.low.pipelineMs
      const cHigh = report.bench.high.pipelineMs
      const cUltra = report.bench.ultra.pipelineMs
      const cExt = report.bench.extreme.pipelineMs

      ok(
        'A · 超高与极致的滤镜都只有 3 个原语（全程序只走塌缩管线）',
        L('ultra').prims.length > 0 &&
          L('ultra').prims.every((n) => n === 3) &&
          L('extreme').prims.every((n) => n === 3),
        `超高 ${JSON.stringify(L('ultra').prims)} · 极致 ${JSON.stringify(L('extreme').prims)}`,
      )
      ok(
        'A · 超高与极致都写 data-glass=collapsed',
        L('ultra').glass === 'collapsed' && L('extreme').glass === 'collapsed',
        `超高 ${L('ultra').tier}/${L('ultra').glass} · 极致 ${L('extreme').tier}/${L('extreme').glass}`,
      )
      ok(
        'A · 折射只给离散小控件（整屏没有大的折射面）',
        L('ultra').refracting > 0 && L('ultra').area < 1_200_000,
        `折射 ${L('ultra').refracting} 块 · 玻璃总面积 ${L('ultra').area}px²（视口 ${430 * 930}px²）`,
      )
      ok(
        'A · 极致不靠加大模糊半径（Σσ 与超高同量级：差异来自光学层与覆盖范围）',
        L('extreme').sigma <= L('ultra').sigma * 1.25,
        `超高 Σσ=${L('ultra').sigma} · 极致 Σσ=${L('extreme').sigma}`,
      )
      ok(
        'A · 超高的合成净成本在预算内（不高于高画质档 + 上限）',
        (cUltra ?? 0) - (cLow ?? 0) <= ((cHigh ?? 0) - (cLow ?? 0)) + 0.6,
        `超高 ${((cUltra ?? 0) - (cLow ?? 0)).toFixed(3)}ms vs 高画质 ${((cHigh ?? 0) - (cLow ?? 0)).toFixed(3)}ms · 极致 ${((cExt ?? 0) - (cLow ?? 0)).toFixed(3)}ms`,
      )
      ok(
        'A · 极致与超高的合成成本同量级（同一套管线、只差材质铺开）',
        Math.abs((cExt ?? 0) - (cUltra ?? 0)) <= ((cUltra ?? 0) - (cLow ?? 0)) * 0.5 + 0.6,
        `极致 ${cExt} · 超高 ${cUltra} · 流畅 ${cLow}`,
      )
    }

    // ---------- B 真实页面：滚动时 Dock 三块玻璃压在内容之上 ----------
    // 「玻璃压在滚动的正文上」是产品里最贵的常态路径 —— 与用户实际遇到的路径一致。
    if (!skip('page')) {
      const netPage = await sweep(
        'B · 真实页面（营养全览：4 张卡片 + 列表滚过 Dock 三块玻璃）',
        `${APP}/#/nutrition`,
        PAGE_LOAD,
        'page',
      )
      ok(
        'B · 极致档的滚动净成本不超过超高（材质铺开不该带来滚动掉帧）',
        netPage('extreme') <= netPage('ultra') * 1.35 + 0.4,
        `极致 ${netPage('extreme').toFixed(3)}ms vs 超高 ${netPage('ultra').toFixed(3)}ms`,
      )
      ok(
        'B · 超高净成本相对高画质档可控（折射的代价有上限）',
        netPage('ultra') <= netPage('high') * 1.6 + 0.6,
        `超高 ${netPage('ultra').toFixed(3)}ms vs 高画质 ${netPage('high').toFixed(3)}ms`,
      )
    }

    // ---------- D 材质实现实验 ----------
    //
    // 问题：「玻璃材质」（毛玻璃那一路的 `backdrop-filter: blur(28px) saturate(1.8)`）
    // 能不能换成别的实现来省成本 —— 换成折射管线那套 SVG 滤镜？降低渲染分辨率？
    //
    // 量法上踩过的坑值得记下来：一开始插一块**标本**去量（156×54 与 430×620 各一块），
    // 结果九种实现的差值全在 ±0.05ms 内**来回跳**（blur(8) 比 blur(28) 还贵、
    // 1/3 分辨率比 1/2 还贵、去掉 saturate 更贵），排序在大小两个尺寸之间还会翻过来。
    // 原因有两个：① 单块玻璃的边际成本（0.02~0.06ms/帧）低于这套方法的噪声；
    // ② 标本压在**产品自己的玻璃**上面，被测的那一丁点变化被淹没在别的东西里。
    // 所以这里改成**改产品自己的玻璃、量整页**：先按计算样式把「模糊族」标出来，
    // 再用一张覆盖样式整族换实现，于是差值被族里的每一层放大，
    // 同时每档重复 3 次取中位数，把噪声压到能分辨的量级。
    //
    // 页面取 `#/nutrition` 且**滚动到页头遮罩进场**：遮罩是一叠多层背景滤镜，
    // 只在滚起来之后才出现（不滚的那一版会整整漏掉一族）。
    await setTier('extreme')
    await cdp('Page.navigate', { url: `${APP}/#/nutrition` })
    await sleep(2400)
    if (await evalJS(dismiss)) await sleep(500)

    // 滤镜定义（SVG 化的模糊要用到）与「模糊族」标记：标记只做一次 ——
    // 有几档会把 backdrop-filter 整条换掉，标记一旦重做就会把自己标没
    await evalJS(`(() => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.id = 'pfx-defs'
      svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none'
      svg.innerHTML =
        '<defs>' +
        '<filter id="pf-blur" color-interpolation-filters="sRGB" x="-10%" y="-10%" width="120%" height="120%">' +
        '<feGaussianBlur stdDeviation="28"/></filter>' +
        '<filter id="pf-blur-sat" color-interpolation-filters="sRGB" x="-10%" y="-10%" width="120%" height="120%">' +
        '<feGaussianBlur stdDeviation="28"/><feColorMatrix type="saturate" values="1.8"/></filter>' +
        '</defs>'
      document.body.appendChild(svg)
      let n = 0
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        const bf = String(cs.backdropFilter || cs.webkitBackdropFilter || 'none')
        if (!bf.includes('blur(')) continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        el.setAttribute('data-pf-mat', '')
        n += 1
      }
      return n
    })()`)

    /** 材质族在滚动状态下的规模（后面每个数字都要对着它读） */
    const materialScale = async () => {
      await evalJS(`(() => { document.scrollingElement.scrollTop = 600; return true })()`)
      await sleep(500)
      return evalJS(`(() => {
        const els = [...document.querySelectorAll('[data-pf-mat]')]
        return {
          count: els.filter((e) => e.offsetWidth > 0).length,
          area: els.reduce((a, e) => a + (e.offsetWidth > 0 ? e.offsetWidth * e.offsetHeight : 0), 0),
        }
      })()`)
    }
    const scale = await materialScale()
    const materialScale0 = scale
    console.log(`\n=== D · 材质实现实验（整页真实玻璃族：${scale.count} 块 / ${scale.area}px²，滚动态）===`)

    const APPLY_VARIANT = (css) => `(() => {
      let s = document.getElementById('pfx-variant')
      if (!s) { s = document.createElement('style'); s.id = 'pfx-variant'; document.head.appendChild(s) }
      s.textContent = ${JSON.stringify(css)}
      return true
    })()`

    const MAT = '[data-pf-mat]'
    const MATERIAL_VARIANTS = [
      { id: 'shipped', label: '现行 blur(var(--glass-blur)) saturate(var(--glass-sat))', css: '' },
      {
        id: 'off',
        label: '整族不挂滤镜（地板：材质到底值多少钱）',
        css: `${MAT}{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}`,
      },
      {
        id: 'no-saturate',
        label: '去掉 saturate（单独看那一步）',
        css: `${MAT}{backdrop-filter:blur(var(--glass-blur)) !important;-webkit-backdrop-filter:blur(var(--glass-blur)) !important}`,
      },
      {
        id: 'svg-blur',
        label: '换成 SVG 滤镜里的 feGaussianBlur（塌缩管线同一份机制）',
        css: `${MAT}{backdrop-filter:url(#pf-blur) saturate(var(--glass-sat)) !important;-webkit-backdrop-filter:url(#pf-blur) saturate(var(--glass-sat)) !important}`,
      },
      {
        id: 'svg-blur-sat',
        label: '模糊 + 饱和度都进 SVG 链（不叠第二遍）',
        css: `${MAT}{backdrop-filter:url(#pf-blur-sat) !important;-webkit-backdrop-filter:url(#pf-blur-sat) !important}`,
      },
      {
        id: 'radius-14',
        label: '半径减半（--glass-blur 28 → 14）',
        css: `html{--glass-blur:14px}`,
      },
      {
        id: 'radius-8',
        label: '--glass-blur 28 → 8',
        css: `html{--glass-blur:8px}`,
      },
      // ProgressiveBlur 的每一层都 `inset: 0`，但**看得见的只有靠强端那一段**：
      // 第 i 层的 mask 从 solid% 淡到 fadeTo%（= solid + 100/n），之外全是透明的。
      // 也就是说第 5 层只在顶上 20% 有内容，却按整条 430×94 付了滤镜的钱。
      // 这一档把每层收到自己的可见带里（mask 在带内重新归一），滤镜总面积少约 40%。
      // **测下来不值得落地**：反复量到的是 ±0.03ms 的来回跳（换一轮就换个符号），
      // 而它换来一个新风险 —— 带边缘的模糊少采到下缘的内容。
      // 留在这里是当**反例**：面积看起来砍了 40%，成本却没动，说明这一族的成本
      // 根本不是「按面积线性」的，别再从面积上打主意。
      {
        id: 'blur-band',
        label: '渐进模糊：每层收到自己的可见带（滤镜面积 −40%，实测无收益，不落地）',
        css: [
          '.pblur span:nth-child(2){bottom:auto;height:80%;mask-image:linear-gradient(to bottom,#000 0%,#000 75%,transparent 100%) !important;-webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 75%,transparent 100%) !important}',
          '.pblur span:nth-child(3){bottom:auto;height:60%;mask-image:linear-gradient(to bottom,#000 0%,#000 66.67%,transparent 100%) !important;-webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 66.67%,transparent 100%) !important}',
          '.pblur span:nth-child(4){bottom:auto;height:40%;mask-image:linear-gradient(to bottom,#000 0%,#000 50%,transparent 100%) !important;-webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 50%,transparent 100%) !important}',
          '.pblur span:nth-child(5){bottom:auto;height:20%;mask-image:linear-gradient(to bottom,#000 0%,transparent 100%) !important;-webkit-mask-image:linear-gradient(to bottom,#000 0%,transparent 100%) !important}',
        ].join(''),
      },
    ]

    /** 重复次数：单块玻璃那点边际成本比这套方法的噪声还小，靠重复取中位数才分得出方向 */
    const REPS = Number(process.env.REIN_PERF_REPS ?? 5)

    const materialResult = {}
    let matAt = null
    for (const v of MATERIAL_VARIANTS) {
      await APPLY_VARIANT(v.css)
      await evalJS(`(() => { document.scrollingElement.scrollTop = 600; return true })()`)
      // 换实现 = 重建图层：先跑一段把一次性成本排掉，再重复多次取中位数压噪声
      await evalJS(sampler(PAGE_LOAD, 25))
      await sleep(200)
      const runs = []
      for (let i = 0; i < REPS; i += 1) {
        const { trace } = await traceWhile(PAGE_LOAD)
        runs.push(trace)
        await sleep(150)
      }
      // 取中位数：个别几次会被系统抖动整段抬高（极差实测能到 0.15ms），均值会被它拖走
      const mid = runs
        .map((r) => r.pipelineMs)
        .sort((a, b) => a - b)
        .at(Math.floor(runs.length / 2))
      const { at } = await stillShot(`material-${v.id}`)
      if (v.id === 'shipped') matAt = at
      materialResult[v.id] = {
        pipelineMs: +mid.toFixed(3),
        drawMs: runs.map((r) => r.drawMs).sort((a, b) => a - b).at(Math.floor(runs.length / 2)),
        paintMs: runs.map((r) => r.paintMs).sort((a, b) => a - b).at(Math.floor(runs.length / 2)),
        spread: +(
          Math.max(...runs.map((r) => r.pipelineMs)) - Math.min(...runs.map((r) => r.pipelineMs))
        ).toFixed(3),
      }
      const m = materialResult[v.id]
      console.log(
        `      ${v.id.padEnd(14)} 帧管线 ${String(m.pipelineMs).padStart(6)}ms/帧（${REPS} 次极差 ${m.spread}）· 合成绘制 ${m.drawMs} · 收尾 ${m.paintMs}`,
      )
      console.log(`      ${''.padEnd(14)} ${v.label}`)
    }

    const base = materialResult.shipped.pipelineMs
    const floor = materialResult.off.pipelineMs
    // 噪声带取现行实现自身重复的极差：比它还小的差值不值得下结论
    const noise = Math.max(materialResult.shipped.spread, 0.02)
    const saving = (id) => +(base - materialResult[id].pipelineMs).toFixed(3)
    console.log(
      `\n      材质族总账：现行 ${base}ms/帧 · 整族不挂滤镜 ${floor}ms/帧（省 ${saving('off')}ms）· 噪声带 ±${(noise / 2).toFixed(3)}ms`,
    )
    console.log(
      `      清单现场：${materialScale0.count} 层遮罩 / ${materialScale0.area}px² · 截图时 scrollTop=${matAt?.scrollTop} 遮罩 opacity=${matAt?.maskOn}`,
    )
    console.log('      各档相对现行实现的节省（正 = 更便宜）：')
    for (const v of MATERIAL_VARIANTS) {
      if (v.id === 'shipped') continue
      console.log(`        ${v.id.padEnd(14)} ${(saving(v.id) >= 0 ? '+' : '') + saving(v.id).toFixed(3)}ms/帧`)
    }

    const partial = MATERIAL_VARIANTS.map((v) => v.id).filter((id) => id !== 'shipped' && id !== 'off')

    // 结论是**否定式**的，断言也写成否定式 —— 写成「某某应当更便宜」会逼着后来的人
    // 去追一个不存在的收益。这里用两条与机器无关的逻辑约束来锁住结论：
    //
    // ① 「拆掉一部分」不可能比「全部拆掉」省得更多。任何违反它的读数只能是在量噪声 ——
    //    实测就出现过「只去掉 saturate」(+0.123) 比「整族全关」(+0.041) 还省的读数，
    //    这一条正是用来把那种读数挡在外面的（它是这一节唯一稳定的判据：
    //    噪声带本身在几轮之间从 0.037 飘到 0.172，拿它当阈值根本不牢）。
    // ② 连「整族全关」都换不来超过噪声带的节省 —— 材质族的成本低于这套方法的信噪比。
    const overclaim = partial.filter((id) => saving(id) > saving('off') + noise)
    ok(
      'D · 各档的「节省」都不超过「整族全关」的节省（否则就是在量噪声）',
      overclaim.length === 0,
      overclaim.length
        ? `${overclaim.map((id) => `${id} ${saving(id)}ms > off ${saving('off')}ms`).join(' · ')}`
        : `全部 ≤ off 的 ${saving('off')}ms`,
    )
    ok(
      'D · 整族全关也换不来可测的节省 → 材质的成本低于这套方法的信噪比',
      saving('off') <= noise,
      `off 省 ${saving('off')}ms · 噪声带 ${noise.toFixed(3)}ms`,
    )
    console.log(
      `\n      → 落地判断：保持现行 \`backdrop-filter: blur()\`。换 SVG 滤镜链、去掉 saturate、` +
        `缩半径、把渐进模糊每层收到可见带（滤镜面积 −40%），量的收益都在噪声带里来回跳 ——` +
        `唯一稳定可测的节省来自**折射管线本身**（见 A / B 节：极致档砍掉完整链省 0.4~0.7ms/帧）。`,
    )
    await APPLY_VARIANT('')

    // ---------- C 逐档结构清单：净成本的解释 ----------
    // 清单量的是「滤镜面有多大」——成本的一阶项就是块数与面积，D 节的结论要对着它读。
    if (!skip('list')) {
      const LIST_SURFACES = `(() => {
      const out = []
      const seen = new Set()
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        const bf = String(cs.backdropFilter || cs.webkitBackdropFilter || 'none')
        if (!bf.includes('url(') && !bf.includes('blur(')) continue
        if (seen.has(el)) continue
        seen.add(el)
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
        out.push({
          cls: String(el.className).split(' ').slice(0, 3).join('.'),
          w: Math.round(r.width),
          h: Math.round(r.height),
          kind: bf.includes('url(') ? '折射' : '模糊',
        })
      }
      return out
    })()`

    const listOn = async (tier, url, title) => {
      await setTier(tier)
      await cdp('Page.navigate', { url })
      await sleep(2400)
      if (await evalJS(dismiss)) await sleep(500)
      const detail = await evalJS(LIST_SURFACES)
      console.log(`\n=== C · ${title} ===`)
      for (const d of detail) console.log(`      ${d.kind}  ${String(d.w).padStart(4)}×${String(d.h).padStart(4)}  ${d.cls}`)
      const totalArea = detail.reduce((a, d) => a + d.w * d.h, 0)
      console.log(`      合计 ${detail.length} 块 · ${totalArea}px²（视口 430×930 = ${430 * 930}px²）`)
      return detail
    }

    const detail = await listOn('extreme', `${APP}/#/settings/perf`, '极致档玻璃面清单 · 材质标本台')
    const big = detail.filter((d) => d.w * d.h > 40_000)
    ok(
      'C · 极致档没有「大面积 + 挂滤镜」的表面（整屏的面积不该带背景滤镜）',
      big.length === 0,
      big.length ? big.map((d) => `${d.kind} ${d.w}×${d.h} ${d.cls}`).join(' | ') : '最大一块也都压在离散控件的尺寸内',
    )
    const live = await listOn('extreme', `${APP}/#/nutrition`, '极致档玻璃面清单 · 真实页面（营养全览，未滚动）')
    const blurred = live.filter((d) => d.kind === '模糊')
    console.log(
      `      其中「模糊」这一类 ${blurred.length} 块 · 最大 ${blurred.reduce((a, d) => Math.max(a, d.w * d.h), 0)}px²` +
        ` · 就是 D 节要优化的那一族`,
    )
    // 页头遮罩只在**滚起来之后**才出现（useScrolled）：同一页滚与不滚差着一整族模糊层，
    // 所以「材质贵不贵」必须在滚动状态下量 —— 不滚的那一版会把整族漏掉
    await evalJS(`(() => { document.scrollingElement.scrollTop = 600; return true })()`)
    await sleep(700)
    const scrolled = await evalJS(LIST_SURFACES)
    const scrolledBlur = scrolled.filter((d) => d.kind === '模糊')
    console.log(
      `\n=== C · 极致档玻璃面清单 · 同一页**滚动后**（页头遮罩进场）===\n` +
        `      合计 ${scrolled.length} 块 · 模糊 ${scrolledBlur.length} 块（${scrolledBlur.reduce((a, d) => a + d.w * d.h, 0)}px²）· 折射 ${scrolled.filter((d) => d.kind === '折射').length} 块`,
    )
    for (const d of scrolledBlur.slice(0, 12))
      console.log(`      模糊  ${String(d.w).padStart(4)}×${String(d.h).padStart(4)}  ${d.cls}`)
    }

    const errs = await evalJS('window.__errs ?? []')
    ok('运行期无未捕获异常', errs.length === 0, errs.join(' | '))

    console.log(`\n${failed ? `${failed} 项未通过` : '全部通过'} · 截图在 ${OUT}`)
    console.log(
      '      注：无头 SwiftShader 只用于同机相对比较（塌缩链 vs 完整链 / 各档之间），跨设备结论必须回真机。',
    )
    if (failed) process.exitCode = 1
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    edge.kill()
  }
}

void main()
