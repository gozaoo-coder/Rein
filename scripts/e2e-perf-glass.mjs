/**
 * 画质预览页（#/settings/perf）· 像素级核验。
 *
 * 为什么不能只看计算样式：这一页的故障全是「样式全对、屏幕上读不出来」那一类 ——
 * 页签文字压在玻璃上、玻璃压在壁纸上，两个半透明层叠出来的**实际底色**只有渲染出来才知道。
 * 所以这里把整帧截图喂回页面里的 canvas，按坐标采像素，再用 WCAG 公式算对比度
 * （前景带 alpha 时先与采样到的底色合成 —— 那才是人眼看到的颜色）。
 *
 * 覆盖：
 *   1 亮 / 暗 · 超高：**底栏标本与真实 Dock 逐项一致**（块数 / 几何 / 页签前景 /
 *     受光亮斑 / 玻璃底色，逐项比计算样式）、读数胶囊对比度 ≥ 4.5:1、无横向溢出
 *   2 拖动态：把壁纸横拖一段留档（玻璃边缘的位移与色散靠这张图人工核对）
 *   3 退化态：Firefox UA（内核不支持 url() 折射）· 高画质档（未开折射）· 弱档（顶成实底）
 *     三条路径都要**如实报出**自己是哪一种，而不是让人对着退化结果猜
 *   4 系统「减弱透明度」：折射一并关掉（内联样式压过媒体查询，靠调用处的 !important 压住），
 *     顶成实底；这两档里标本也必须继续与真实 Dock 一致
 *   5 窄屏 320：不横向溢出、底栏不出界、页签触区 ≥ 44
 *   6 真实 Dock（左圆钮 + 中药丸 + 右圆钮，三块并列玻璃）：超高逐块折射 / 高画质普通
 *     毛玻璃 / 弱档顶成实底，页签对比度真图采像素
 *   7 参数调节面板：11 行参数、拖滑杆滤镜跟着重烘、点值就地输入、恢复默认
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-perf-glass.mjs
 * 产物：%TEMP%/rein-shots/perf/*.png
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = `${process.env.TEMP}/rein-shots/perf`
const USER_DATA = `${process.env.TEMP}/rein-e2e-perf-${Date.now()}`

let ws
let msgId = 0
const pending = new Map()
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
  if (r.exceptionDetails) throw new Error('eval 异常: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
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

let failed = 0
function ok(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed += 1
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

/** 把整帧截图喂回页面里的 canvas 采像素（data: URI 不污染 canvas） */
async function sampleAt(data, points) {
  return evalJS(`(async () => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${data}' })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] }
    return ${JSON.stringify(points)}.map((p) => ({ ...p, bg: px(p.x, p.y) }))
  })()`)
}

/** WCAG 相对对比度；前景带 alpha 时先与底色合成 */
function contrast(fg, bg) {
  const lin = (v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const a = fg[3] ?? 1
  const eff = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
  const l1 = lum(eff)
  const l2 = lum(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function parseColor(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/)
  if (!m) return [0, 0, 0, 1]
  const p = m[1].split(',').map((x) => parseFloat(x))
  return [p[0], p[1], p[2], p[3] ?? 1]
}

/** 读数胶囊的采样点（暗场芯片材质，前景浅色） */
const PLAQUE_POINT = `(() => { const p = document.querySelector('.plaque'); const r = p.getBoundingClientRect(); return { x: r.right - 6, y: r.top + r.height / 2, color: getComputedStyle(p).color } })()`

/**
 * 标本台的底栏 vs 真实 Dock：逐项比对**计算样式与几何**。
 * 这是「标本必须与真实 Dock 长得一样」的那条约束 —— 两边各写一套样式迟早会漂
 * （标本曾经用暗场令牌 + 自己的一版页签），所以这里比对的是同一份全局定义落出来的结果。
 */
const SYNC_PROBE = `(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const pick = (root) => {
    if (!root) return null
    const tab = root.querySelector('.dock-tab')
    const slot = root.querySelector('.dock-slot')
    const block = root.querySelector('.dock-block')
    const pill = root.querySelector('.dock-block.pill')
    const blob = tab ? getComputedStyle(tab, '::before') : null
    const rect = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null)
    return {
      blocks: root.querySelectorAll('.dock-block').length,
      tabs: root.querySelectorAll('.dock-tab').length,
      slots: root.querySelectorAll('.dock-slot').length,
      block: rect(block),
      blockFill: cs(block)?.backgroundColor,
      // 滤镜 id 每个实例都不同（glass-filter-xxxx）：只比「挂没挂折射」
      blockFilter: String(cs(block)?.backdropFilter).replace(/glass-filter-[a-z0-9]+/g, 'glass-filter-*'),
      tabH: Math.round(tab?.getBoundingClientRect().height ?? 0),
      pillGrow: cs(pill)?.flexGrow,
      tabColor: cs(tab)?.color,
      tabSize: cs(tab)?.fontSize,
      tabWeight: cs(tab)?.fontWeight,
      tabGap: cs(tab)?.gap,
      tabRadius: cs(tab)?.borderRadius,
      blob: blob?.backgroundImage,
      blobInset: blob?.inset,
      blobRadius: blob?.borderRadius,
      slotColor: cs(slot)?.color,
    }
  }
  return { bench: pick(document.querySelector('.bench .dockrow')), dock: pick(document.querySelector('.dock')) }
})()`

async function main() {
  mkdirSync(OUT, { recursive: true })
  const debugPort = await freePort()
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
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
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 930, deviceScaleFactor: 1, mobile: true })
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        // 档位走 window.name 带入：这段注入脚本每次 reload 都会重跑，写死某一档的话
        // 下面所有切档的步骤都会被它顶回去
        localStorage.setItem('rein.perf.v1', window.name || 'ultra');
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
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)

    const dismiss = `(() => { const b = [...document.querySelectorAll('.up-actions .up-btn')].find((x) => x.textContent.includes('稍后')); if (b) { b.click(); return true } return false })()`
    const reload = async () => {
      await evalJS('location.reload()')
      await sleep(2200)
      if (await evalJS(dismiss)) await sleep(600)
    }
    const setTier = async (t) => {
      await evalJS(`window.name = ${JSON.stringify(t)}`)
      await reload()
    }

    // ---------- 1 + 2 亮/暗 · 超高 ----------
    for (const theme of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
      await reload()
      const data = await shot(`ultra-${theme}`)

      // 标本台的底栏必须与真实 Dock **逐项一致**（结构与前景类共用 base.css 一份定义）
      const sync = await evalJS(SYNC_PROBE)
      const same = JSON.stringify(sync.bench) === JSON.stringify(sync.dock)
      ok(
        `${theme} · 底栏标本与真实 Dock 逐项一致（块数 / 几何 / 页签前景 / 受光亮斑）`,
        same && sync.dock?.blocks === 3,
        same ? `3 块 · ${sync.dock.tabColor} · 亮斑 ${String(sync.dock.blob).slice(0, 48)}…` : `标本 ${JSON.stringify(sync.bench)} · Dock ${JSON.stringify(sync.dock)}`,
      )

      const chip = await evalJS(PLAQUE_POINT)
      const [chipPx] = await sampleAt(data, [{ name: '读数胶囊', x: chip.x, y: chip.y }])
      const chipRatio = contrast(parseColor(chip.color), chipPx.bg)
      ok(`${theme} · 读数胶囊对比度 ≥ 4.5:1`, chipRatio >= 4.5, `${chipRatio.toFixed(2)}:1 · 底 rgb(${chipPx.bg.join(',')})`)

      await evalJS(`document.querySelector('.strip').scrollLeft = 170`)
      await sleep(500)
      await shot(`ultra-${theme}-dragged`)

      const overflow = await evalJS(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, errs: window.__errs })`)
      ok(`${theme} · 无横向溢出`, overflow.doc <= overflow.vw + 1, `doc=${overflow.doc} 视口=${overflow.vw}`)
      ok(`${theme} · 运行期无未捕获异常`, overflow.errs.length === 0, overflow.errs.join(' | '))
    }

    // ---------- 3 退化态 ----------
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' })
    await reload()
    const ff = await evalJS(`({ text: document.querySelector('.plaque').textContent.trim(), tone: document.querySelector('.plaque').className, refracting: !!document.querySelector('.bench .glass').style.backdropFilter })`)
    await shot('fallback-firefox')
    ok('内核不支持时读数如实说明', ff.text.includes('不支持') && ff.tone.includes('warn'), `${ff.tone} · ${ff.text}`)
    ok('内核不支持时不挂折射滤镜', ff.refracting === false, `内联 backdrop-filter=${ff.refracting}`)
    await cdp('Emulation.setUserAgentOverride', { userAgent: '' })

    await setTier('high')
    const hi = await evalJS(`({ text: document.querySelector('.plaque').textContent.trim(), tone: document.querySelector('.plaque').className, mounted: document.documentElement.dataset.perf, refracting: !!document.querySelector('.bench .glass').style.backdropFilter })`)
    await shot('tier-high')
    ok('高画质档读数说「当前档位用普通毛玻璃」', hi.mounted === 'high' && hi.tone.includes('idle') && hi.text.includes('当前档位用普通毛玻璃'), `data-perf=${hi.mounted} ${hi.tone} · ${hi.text}`)
    ok('高画质档不挂折射滤镜', hi.refracting === false, `内联 backdrop-filter=${hi.refracting}`)

    await setTier('low')
    const low = await evalJS(`(() => {
      const g = document.querySelector('.parts .glass')
      const cs = getComputedStyle(g)
      return {
        fill: cs.backgroundColor,
        noBlur: cs.backdropFilter === 'none' || cs.backdropFilter === '',
        text: document.querySelector('.plaque').className,
        detail: document.querySelector('.plaque').textContent.trim(),
        mounted: document.documentElement.dataset.perf,
      }
    })()`)
    await shot('tier-low')
    ok('弱档玻璃顶成实底且不挂模糊（暗场基本件）', low.mounted === 'low' && low.noBlur && low.fill === 'rgb(11, 11, 14)', `data-perf=${low.mounted} bg=${low.fill} backdrop=${low.noBlur ? 'none' : '仍在'}`)
    ok('弱档读数说「已降级到流畅优先」', low.text.includes('warn') && low.detail.includes('已降级到流畅优先'), `${low.text} · ${low.detail}`)
    const lowSync = await evalJS(SYNC_PROBE)
    ok(
      '弱档 · 底栏标本仍与真实 Dock 一致（退化语义两边同步）',
      JSON.stringify(lowSync.bench) === JSON.stringify(lowSync.dock),
      `标本 ${JSON.stringify(lowSync.bench)} · Dock ${JSON.stringify(lowSync.dock)}`,
    )

    // ---------- 4 减弱透明度 ----------
    await setTier('ultra')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] })
    await reload()
    const rt = await evalJS(`(() => {
      const g = document.querySelector('.parts .glass')
      return { bg: getComputedStyle(g).backgroundColor, blur: getComputedStyle(g).backdropFilter }
    })()`)
    await shot('reduced-transparency')
    ok('减弱透明度时折射被关掉（基本件顶成实底）', rt.blur === 'none' && rt.bg === 'rgb(11, 11, 14)', `bg=${rt.bg} backdrop=${rt.blur}`)
    const rtSync = await evalJS(SYNC_PROBE)
    ok(
      '减弱透明度 · 底栏标本仍与真实 Dock 一致',
      JSON.stringify(rtSync.bench) === JSON.stringify(rtSync.dock),
      `标本 ${JSON.stringify(rtSync.bench)} · Dock ${JSON.stringify(rtSync.dock)}`,
    )
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] })

    // ---------- 5 窄屏 320 ----------
    await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await reload()
    const narrow = await evalJS(`(() => {
      const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) } }
      return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, dock: q('.dockrow'), tab: q('.bench .dock-tab') }
    })()`)
    await shot('narrow-320')
    ok('窄屏 320 无横向溢出', narrow.doc <= narrow.vw + 1, `doc=${narrow.doc} 视口=${narrow.vw}`)
    ok('窄屏底栏不出界', narrow.dock.l >= 0 && narrow.dock.r <= narrow.vw, `dock=${narrow.dock.l}..${narrow.dock.r}`)
    ok('窄屏页签触区高度 ≥ 44', narrow.tab.h >= 44, `高=${narrow.tab.h}`)

    // ---------- 6 真实 Dock：液态玻璃落地（三块并列玻璃，超高档逐块折射） ----------
    // 站在主页上测：内容滚到 Dock 底下，折射才有得采（背后若是纯背景，看不出差别）。
    const dockProbe = `(() => {
      const nav = document.querySelector('.dock')
      const navCs = getComputedStyle(nav)
      const blocks = [...nav.querySelectorAll('.dock-block')]
      const tab = nav.querySelector('.dock-tab:not(.active)')
      const r = tab.getBoundingClientRect()
      const filters = blocks.map((b) => getComputedStyle(b).backdropFilter)
      return {
        tier: document.documentElement.dataset.perf,
        blocks: blocks.length,
        filters,
        refracting: filters.filter((f) => String(f).includes('url(')).length,
        blurring: filters.filter((f) => String(f).includes('blur(')).length,
        fills: blocks.map((b) => getComputedStyle(b).backgroundColor),
        navBg: navCs.backgroundImage,
        navFilter: navCs.backdropFilter,
        tabColor: getComputedStyle(tab).color,
        probe: { name: 'Dock 未选中页签玻璃', x: r.left + 3, y: r.top + r.height / 2 },
      }
    })()`
    const scrollContentUnderDock = `window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.55))`

    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 930, deviceScaleFactor: 1, mobile: true })
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setTier('ultra')
    await cdp('Page.navigate', { url: `${APP}/#/` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockUltra = await evalJS(dockProbe)
    const dockUltraShot = await shot('dock-ultra')
    const [duPx] = await sampleAt(dockUltraShot, [dockUltra.probe])
    const dockUltraRatio = contrast(parseColor(dockUltra.tabColor), duPx.bg)

    ok('超高 · Dock 是三块并列玻璃（左圆钮 + 中药丸 + 右圆钮）', dockUltra.blocks === 3, `${dockUltra.blocks} 块`)
    ok(
      '超高 · 三块各自折射（与预览页标本同一个 GlassSurface）',
      dockUltra.refracting === 3 && dockUltra.filters.every((f) => String(f).includes('glass-filter-')),
      dockUltra.filters.join(' | '),
    )
    ok(
      '超高 · 三块的底同色且不是全透的膜（都取自 --glass-fill）',
      dockUltra.fills.every((f) => f === dockUltra.fills[0] && !/rgba?\(0, 0, 0, 0\)/.test(String(f))),
      dockUltra.fills.join(' | '),
    )
    ok(
      '超高 · nav 自己不画底也不模糊（底与模糊都在三块玻璃上，nav 只是定位壳）',
      dockUltra.navBg === 'none' && (dockUltra.navFilter === 'none' || dockUltra.navFilter === ''),
      `bg=${dockUltra.navBg} backdrop=${dockUltra.navFilter}`,
    )
    const dockUltraOverflow = await evalJS(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth })`)
    ok(
      '超高 · 折射层不参与布局（固定定位的 Dock 不该把页面撑出横向溢出）',
      dockUltraOverflow.doc <= dockUltraOverflow.vw + 1,
      `doc=${dockUltraOverflow.doc} 视口=${dockUltraOverflow.vw}`,
    )

    await setTier('high')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockHigh = await evalJS(dockProbe)
    const dockHighShot = await shot('dock-high')
    const [dhPx] = await sampleAt(dockHighShot, [dockHigh.probe])
    const dockHighRatio = contrast(parseColor(dockHigh.tabColor), dhPx.bg)

    ok(
      '高画质 · Dock 不挂折射、三块都走普通毛玻璃',
      dockHigh.refracting === 0 && dockHigh.blurring === 3,
      `折射 ${dockHigh.refracting} · 模糊 ${dockHigh.blurring}：${dockHigh.filters.join(' | ')}`,
    )
    // 折射的底若与其余档位不同色（比如暗色下用纯黑），页签文字的真图对比度会整档下滑 ——
    // 这条把「同色」钉成结构不变量，而不是靠对比度阈值兜
    ok(
      '超高 · 折射的底与高画质档同色（同一份 --glass-fill）',
      dockUltra.fills.every((f, i) => f === dockHigh.fills[i]),
      `超高 ${dockUltra.fills.join(' | ')} · 高画质 ${dockHigh.fills.join(' | ')}`,
    )
    // 未选中页签的前景是 --text-3（既有设计），这里锁的是「折射不该让它更差」：
    // 折射层的底若调得太薄，这条会立刻红（真图采像素，不是算合成）
    ok(
      `超高 Dock 页签对比度不回退（超高 ${dockUltraRatio.toFixed(2)} ≥ 高画质 ${dockHighRatio.toFixed(2)} − 0.2）`,
      dockUltraRatio >= dockHighRatio - 0.2,
      `超高=${dockUltraRatio.toFixed(2)}:1 高画质=${dockHighRatio.toFixed(2)}:1`,
    )
    ok('高画质 Dock 页签对比度不下滑基线 ≥ 2.0:1', dockHighRatio >= 2.0, `${dockHighRatio.toFixed(2)}:1`)

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await setTier('ultra')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockUltraDark = await evalJS(dockProbe)
    const dockUltraDarkShot = await shot('dock-ultra-dark')
    const [dudPx] = await sampleAt(dockUltraDarkShot, [dockUltraDark.probe])
    const dockUltraDarkRatio = contrast(parseColor(dockUltraDark.tabColor), dudPx.bg)

    await setTier('high')
    await evalJS(scrollContentUnderDock)
    await sleep(700)
    const dockHighDark = await evalJS(dockProbe)
    const dockHighDarkShot = await shot('dock-high-dark')
    const [dhdPx] = await sampleAt(dockHighDarkShot, [dockHighDark.probe])
    const dockHighDarkRatio = contrast(parseColor(dockHighDark.tabColor), dhdPx.bg)

    // 未选中页签走 --text-3（半透明灰）压在玻璃上，亮暗两色都在 2.4 上下 —— 这是既有设计，
    // 这里锁的是「折射不该让它更差」与「不低于既有基线」
    ok(
      `暗色 · 超高 Dock 页签对比度不回退（超高 ${dockUltraDarkRatio.toFixed(2)} ≥ 高画质 ${dockHighDarkRatio.toFixed(2)} − 0.2）`,
      dockUltraDarkRatio >= dockHighDarkRatio - 0.2,
      `超高=${dockUltraDarkRatio.toFixed(2)}:1 高画质=${dockHighDarkRatio.toFixed(2)}:1 · 底 rgb(${dudPx.bg.join(',')})`,
    )
    ok('暗色 · 高画质 Dock 页签对比度不下滑基线 ≥ 2.0:1', dockHighDarkRatio >= 2.0, `${dockHighDarkRatio.toFixed(2)}:1`)

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await setTier('low')
    const dockLow = await evalJS(dockProbe)
    await shot('dock-low')
    ok(
      '弱档 · Dock 无折射也不挂模糊（顶成实底）',
      dockLow.refracting === 0 && dockLow.filters.every((f) => f === 'none' || f === ''),
      dockLow.filters.join(' | '),
    )

    // ---------- 7 参数调节面板（system/glassParams） ----------
    // 面板改的是**全局可调参数**：拖一下滑杆，标本的滤镜定义必须跟着重烘 ——
    // 「样式写对了但没生效」这类毛病只有真拖一遍才看得出来。
    await setTier('ultra')
    await evalJS(`localStorage.removeItem('rein.glass.v1')`)
    await cdp('Page.navigate', { url: `${APP}/#/settings/perf` })
    await sleep(2200)
    if (await evalJS(dismiss)) await sleep(400)

    ok('画质预览页有参数调节入口', await evalJS(`!!document.querySelector('.tuner')`))
    await evalJS(`document.querySelector('.tuner').click()`)
    await sleep(700)
    const tuner = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.prow')]
      return {
        open: !!document.querySelector('.panel'),
        title: document.querySelector('.panel h2')?.textContent.trim(),
        keys: rows.map((r) => r.querySelector('.pkey')?.textContent.trim()),
        labelled: rows.every((r) => !!r.querySelector('.pcn') && !!r.querySelector('button.pval') && !!r.querySelector('.prange')),
      }
    })()`)
    ok(
      '面板拉开并列出全部 11 项参数',
      tuner.open && tuner.title === '液态玻璃参数' && tuner.keys.length === 11,
      `${tuner.title} · ${tuner.keys.join(' ')}`,
    )
    ok(
      '每行都是「英文键名 + 中文名 + 当前值 + 滑杆」',
      tuner.labelled && tuner.keys.includes('distortionScale') && tuner.keys.includes('backgroundOpacity'),
      `键名 ${tuner.keys.join(' ')}`,
    )

    const rowExpr = (key, inner) => `(() => {
      const row = [...document.querySelectorAll('.prow')].find((r) => r.querySelector('.pkey')?.textContent.trim() === ${JSON.stringify(key)})
      if (!row) return null
      ${inner}
    })()`
    const scaleExpr = `document.querySelector('.bench .glass filter feDisplacementMap')?.getAttribute('scale')`

    const scaleBefore = await evalJS(scaleExpr)
    await evalJS(
      rowExpr('distortionScale', `const input = row.querySelector('.prange'); input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true }))`),
    )
    await sleep(400)
    const scaleAfter = await evalJS(scaleExpr)
    const stored = await evalJS(`localStorage.getItem('rein.glass.v1')`)
    ok(
      '拖滑杆 → 滤镜定义跟着重烘（scale 40）',
      scaleAfter === '40' && scaleAfter !== scaleBefore,
      `${scaleBefore} → ${scaleAfter}`,
    )
    ok('改动落盘（rein.glass.v1）', String(stored).includes('"distortionScale":40'), String(stored))

    // 点一下就地输入：值钮 → 输入框 → 回车提交（吸附到步长、夹回区间）
    await evalJS(rowExpr('borderWidth', `row.querySelector('button.pval').click()`))
    await sleep(200)
    const editing = await evalJS(`!!document.querySelector('.prow input.pval.edit')`)
    await evalJS(`(() => {
      const inp = document.querySelector('.prow input.pval.edit')
      inp.value = '0.62'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    await sleep(300)
    const typed = await evalJS(
      rowExpr('borderWidth', `return { text: row.querySelector('button.pval')?.textContent.trim(), stored: JSON.parse(localStorage.getItem('rein.glass.v1')).borderWidth }`),
    )
    ok(
      '点数值可就地输入（0.62 吸附到步长并生效）',
      editing && typed.text === '0.62' && typed.stored === 0.62,
      `显示 ${typed.text} · 存储 ${typed.stored}`,
    )

    await evalJS(`document.querySelector('.panel .reset').click()`)
    await sleep(400)
    const reset = await evalJS(`(() => ({
      stored: JSON.parse(localStorage.getItem('rein.glass.v1')),
      scale: ${scaleExpr},
    }))()`)
    ok(
      '「恢复默认」回到出厂参数',
      reset.stored.borderWidth === 0.28 && reset.stored.distortionScale === -31 && reset.scale === '-31',
      JSON.stringify(reset.stored),
    )
    await evalJS(`document.querySelector('.panel .close').click()`)
    await sleep(600)
    ok('面板可关闭', (await evalJS(`!!document.querySelector('.panel')`)) === false)

    const errs = await evalJS('window.__errs ?? []')
    ok('末次运行期无未捕获异常', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('EXCEPTION', false, e instanceof Error ? e.message : String(e))
  } finally {
    edge.kill()
  }

  console.log(`\n${failed ? `${failed} 项未通过` : '全部通过'} · 截图在 ${OUT}`)
  if (failed) process.exitCode = 1
}

void main()
