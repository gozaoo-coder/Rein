/**
 * 画质预览页（#/settings/perf）· 像素级核验。
 *
 * 为什么不能只看计算样式：这一页的故障全是「样式全对、屏幕上读不出来」那一类 ——
 * 页签文字压在玻璃上、玻璃压在壁纸上，两个半透明层叠出来的**实际底色**只有渲染出来才知道。
 * 所以这里把整帧截图喂回页面里的 canvas，按坐标采像素，再用 WCAG 公式算对比度
 * （前景带 alpha 时先与采样到的底色合成 —— 那才是人眼看到的颜色）。
 *
 * 覆盖：
 *   1 亮 / 暗 · 超高：页签（未选中 / 选中衬底）与读数胶囊的对比度 ≥ 4.5:1、无横向溢出
 *   2 拖动态：把壁纸横拖一段留档（玻璃边缘的位移与色散靠这张图人工核对）
 *   3 退化态：Firefox UA（内核不支持 url() 折射）· 高画质档（未开折射）· 弱档（顶成实底）
 *     三条路径都要**如实报出**自己是哪一种，而不是让人对着退化结果猜
 *   4 系统「减弱透明度」：折射一并关掉（内联样式压过媒体查询，靠调用处的 !important 压住），
 *     顶成实底后前景仍读得出来
 *   5 窄屏 320：不横向溢出、底栏不出界、页签触区 ≥ 44
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

/** 页签/胶囊的采样点：页签取文字左侧的玻璃（避开字形），选中取衬底内 */
const TAB_POINTS = `(() => {
  const tabs = [...document.querySelectorAll('.bench .tab')]
  const off = tabs.find((t) => !t.classList.contains('on'))
  const on = tabs.find((t) => t.classList.contains('on'))
  const r = (el) => el.getBoundingClientRect()
  return [
    { name: '未选中页签玻璃', x: r(off).left + 3, y: r(off).top + r(off).height / 2 },
    { name: '选中页签衬底', x: r(on).left + 9, y: r(on).top + r(on).height / 2 },
  ]
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
      const px = await sampleAt(data, await evalJS(TAB_POINTS))
      const offColor = await evalJS(`getComputedStyle(document.querySelector('.bench .tab:not(.on)')).color`)
      const onColor = await evalJS(`getComputedStyle(document.querySelector('.bench .tab.on')).color`)
      for (const p of px) {
        const fg = p.name.includes('未选中') ? parseColor(offColor) : parseColor(onColor)
        const ratio = contrast(fg, p.bg)
        ok(`${theme} · ${p.name}对比度 ≥ 4.5:1`, ratio >= 4.5, `${ratio.toFixed(2)}:1 · 底 rgb(${p.bg.join(',')})`)
      }
      const chip = await evalJS(`(() => { const p = document.querySelector('.plaque'); const r = p.getBoundingClientRect(); return { x: r.right - 6, y: r.top + r.height / 2, color: getComputedStyle(p).color } })()`)
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
      const g = document.querySelector('.bench .glass')
      const cs = getComputedStyle(g)
      return {
        fill: cs.backgroundColor,
        noBlur: cs.backdropFilter === 'none' || cs.backdropFilter === '',
        text: document.querySelector('.plaque').className,
        detail: document.querySelector('.plaque').textContent.trim(),
        mounted: document.documentElement.dataset.perf,
        tabColor: getComputedStyle(document.querySelector('.bench .tab:not(.on)')).color,
      }
    })()`)
    const lowShot = await shot('tier-low')
    ok('弱档玻璃顶成实底且不挂模糊', low.mounted === 'low' && low.noBlur && low.fill === 'rgb(11, 11, 14)', `data-perf=${low.mounted} bg=${low.fill} backdrop=${low.noBlur ? 'none' : '仍在'}`)
    ok('弱档读数说「已降级到流畅优先」', low.text.includes('warn') && low.detail.includes('已降级到流畅优先'), `${low.text} · ${low.detail}`)
    const lowPt = await evalJS(`(() => { const t = document.querySelector('.bench .tab:not(.on)'); const r = t.getBoundingClientRect(); return [{ name: '弱档未选中页签', x: r.left + 3, y: r.top + r.height / 2 }] })()`)
    const [lpx] = await sampleAt(lowShot, lowPt)
    const lowRatio = contrast(parseColor(low.tabColor), lpx.bg)
    ok('弱档页签仍读得出来 ≥ 4.5:1', lowRatio >= 4.5, `${lowRatio.toFixed(2)}:1 · 底 rgb(${lpx.bg.join(',')})`)

    // ---------- 4 减弱透明度 ----------
    await setTier('ultra')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] })
    await reload()
    const rt = await evalJS(`(() => {
      const g = document.querySelector('.bench .glass')
      return { bg: getComputedStyle(g).backgroundColor, blur: getComputedStyle(g).backdropFilter, color: getComputedStyle(document.querySelector('.bench .tab:not(.on)')).color }
    })()`)
    const rtShot = await shot('reduced-transparency')
    const rtPt = await evalJS(`(() => { const t = document.querySelector('.bench .tab:not(.on)'); const r = t.getBoundingClientRect(); return [{ name: '减弱透明度未选中页签', x: r.left + 3, y: r.top + r.height / 2 }] })()`)
    const [rtpx] = await sampleAt(rtShot, rtPt)
    const rtRatio = contrast(parseColor(rt.color), rtpx.bg)
    ok('减弱透明度时折射被关掉（顶成实底）', rt.blur === 'none' && rt.bg === 'rgb(11, 11, 14)', `bg=${rt.bg} backdrop=${rt.blur}`)
    ok('减弱透明度下页签仍读得出来 ≥ 4.5:1', rtRatio >= 4.5, `${rtRatio.toFixed(2)}:1 · 前景=${rt.color} 采样底 rgb(${rtpx.bg.join(',')})`)
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] })

    // ---------- 5 窄屏 320 ----------
    await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await reload()
    const narrow = await evalJS(`(() => {
      const q = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) } }
      return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, dock: q('.dockrow'), tab: q('.bench .tab') }
    })()`)
    await shot('narrow-320')
    ok('窄屏 320 无横向溢出', narrow.doc <= narrow.vw + 1, `doc=${narrow.doc} 视口=${narrow.vw}`)
    ok('窄屏底栏不出界', narrow.dock.l >= 0 && narrow.dock.r <= narrow.vw, `dock=${narrow.dock.l}..${narrow.dock.r}`)
    ok('窄屏页签触区高度 ≥ 44', narrow.tab.h >= 44, `高=${narrow.tab.h}`)

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
