/**
 * 壳层环境光的验证（无头 Edge + 原生 CDP）。
 * 运行：node scripts/verify-shell-ambient.mjs
 * 依赖：dev server 已在 1420（或 REIN_E2E_URL 指向的实例）。
 *
 * 验的是 2026-10-04 那条约定（docs/ARCHITECTURE.md「环境光属于壳，画布只留中性底」）：
 *   ① 手机壳在**宽窗口**里只是一栏居中 —— 窗外必须是恒定的 `--bg`，不随视口把光漏出去
 *      （旧写法 `body` + `background-attachment: fixed` 的定位基准是视口，窗口比栏宽多少
 *      光就偏出去多少：同一列上 60px 与 600px 处能差 16 级）；
 *   ② 那一栏里必须有环境光，且与"整屏手机"的渐变公式逐值相符（手机上逐像素不变）；
 *   ③ 桌面壳那层铺满整窗；
 *   ④ 前置条件：中性底在 `<html>` 上、`body` 透明 —— body 一旦自己画背景就压在负 z 层之上
 *      （层叠顺序：负 z 后代 → 在流块级背景），两层光会被整块盖掉。
 *
 * 取样点都刻意避开卡片落影（`--shadow-card` 会漏出栏目 30 来 px）与桌面壳的玻璃窗格。
 * 产出：.tmp-ui-shots/ambient-*.png，供肉眼复核。
 */
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`
const OUT = new URL('../.tmp-ui-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
    srv.on('error', reject)
  })
}

let ws
let msgId = 0
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
}
async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression: `(() => { ${expression} })()`, returnByValue: true })
  if (r?.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 1×1 PNG → [r,g,b]（单像素图四种行过滤的预测值都是 0，故只取原始字节） ---------- */
function px1(png) {
  let off = 8
  const idats = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idats))
  return [raw[1], raw[2], raw[3]]
}

async function sample(x, y) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 } })
  return px1(Buffer.from(r.data, 'base64'))
}
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
const near = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

/** 期望值 = `--app-ambient` 那份渐变的独立实现（三个停靠点、椭圆半径 1200×700、圆心 18% / -10%） */
function ambientAt(x, y, boxW, boxH) {
  const cx = 0.18 * boxW
  const cy = -0.1 * boxH
  const r = Math.min(1, Math.hypot((x - cx) / 1200, (y - cy) / 700))
  const [a, b, t] = r <= 0.48
    ? [[255, 255, 255], [238, 240, 244], r / 0.48]
    : [[238, 240, 244], [230, 232, 238], (r - 0.48) / 0.52]
  return a.map((v, i) => Math.round(v + (b[i] - v) * t))
}

const NEUTRAL = [245, 245, 247] // --bg（亮色）

/** 壳层那层光的位置/尺寸（取 ::before 的 computed，再按 transform 落回视口坐标） */
async function layerBox(sel) {
  return JSON.parse(await evalJS(`
    const el = document.querySelector(${JSON.stringify(sel)})
    const cs = getComputedStyle(el, '::before')
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform)
    const parseTopLeft = (v, base) => (v.endsWith('%') ? (parseFloat(v) / 100) * base : parseFloat(v))
    const w = cs.width.endsWith('px') ? parseFloat(cs.width) : NaN
    const h = cs.height.endsWith('px') ? parseFloat(cs.height) : NaN
    const l = cs.left === 'auto' ? parseTopLeft(cs.right, innerWidth) - w : parseTopLeft(cs.left, innerWidth)
    const t = cs.top === 'auto' ? innerHeight - h : parseTopLeft(cs.top, innerHeight)
    return JSON.stringify({
      content: cs.content, position: cs.position, zIndex: cs.zIndex,
      bgImage: cs.backgroundImage.slice(0, 24),
      x: Math.round(l + m.e), y: Math.round(t + m.f), w: Math.round(w), h: Math.round(h),
    })
  `))
}

let failed = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}
async function shot(name) {
  await sleep(400)
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}ambient-${name}.png`, Buffer.from(r.data, 'base64'))
}
const viewport = async (width, height, mobile) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  await sleep(900)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const DEBUG_PORT = await freePort()
  spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  await sleep(1500)
  let target
  for (let i = 0; i < 20; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json(); break } catch { await sleep(500) }
  }
  if (!target) throw new Error('连不上无头 Edge 的调试端口')
  await sleep(300)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result ?? m.error) } }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: `${APP}/#/` })
  await sleep(3000)
  // 浏览器 mock 下的「发现新版本」卡片会盖一层 scrim，先关掉
  await evalJS(`const b = [...document.querySelectorAll('button')].find(x => ['稍后','跳过此版本'].includes(x.textContent.trim())); if (b) b.click(); return true`)

  /* ---------- ⓪ 前置条件：中性底在 <html>、body 透明 ---------- */
  console.log('画布')
  const canvas = JSON.parse(await evalJS(`
    return JSON.stringify({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      neutral: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    })
  `))
  check('中性底画在 <html> 上', canvas.html === 'rgb(245, 245, 247)', `${canvas.html}（--bg ${canvas.neutral}）`)
  check('body 不画背景（否则压住负 z 的壳层光）', canvas.body === 'rgba(0, 0, 0, 0)', canvas.body)

  /* ---------- ① 手机壳 · 宽窗口：一栏居中 + 窗外恒为中性底 ---------- */
  await viewport(1080, 688, false)
  const frame = JSON.parse(await evalJS(`
    const r = document.querySelector('.app-frame').getBoundingClientRect()
    return JSON.stringify([Math.round(r.x), Math.round(r.width), Math.round(r.height)])
  `))
  const [fx, fw, fh] = frame
  console.log(`手机壳 · 1080×688（栏 x=${fx} w=${fw} h=${fh}）`)
  const layer = await layerBox('.app-frame')
  // 层是固定定位：横向与栏严丝合缝，纵向铺满视口（栏本身比视口高，文档在滚）
  check('光层横向与栏严丝合缝、纵向铺满视口', layer.x === fx && layer.w === fw && layer.h === 688, `层 ${layer.x},${layer.w},${layer.h} vs 栏 ${fx},${fw} / 视口高 688`)
  check('光层在负 z 层（画布之上、内容之下）', layer.zIndex === '-1' && layer.position === 'fixed' && layer.content === '""', `${layer.position} z=${layer.zIndex}`)
  for (const y of [60, 300, 600]) {
    for (const x of [40, 1040]) {
      const c = await sample(x, y)
      check(`窗外 (${x},${y}) 是中性底`, near(c, NEUTRAL), `${hex(c)} vs ${hex(NEUTRAL)}`)
    }
  }
  {
    const c = await sample(fx + 30, 60)
    const e = ambientAt(30, 60, fw, fh)
    check(`栏内 (${fx + 30},60) 等于环境光公式值`, near(c, e, 3), `${hex(c)} vs ${hex(e)}`)
  }
  await shot('1080x688')

  /* ---------- ② 手机视口：这一栏 = 整屏，与从前的 body 渐变逐像素同值 ---------- */
  await viewport(430, 932, true)
  console.log('手机 · 430×932')
  const phoneLayer = await layerBox('.app-frame')
  check('光层铺满整屏', phoneLayer.x === 0 && phoneLayer.w === 430 && phoneLayer.h === 932, `${phoneLayer.x},${phoneLayer.w},${phoneLayer.h}`)
  for (const [x, y] of [[15, 60], [415, 60]]) {
    const c = await sample(x, y)
    const e = ambientAt(x, y, 430, 932)
    check(`(${x},${y}) 等于环境光公式值`, near(c, e, 3), `${hex(c)} vs ${hex(e)}`)
  }
  await shot('430x932')

  /* ---------- ③ 桌面壳：那层铺满整窗 ---------- */
  await viewport(1440, 900, false)
  const shell = await evalJS(`return document.documentElement.dataset.shell`)
  console.log(`桌面 · 1440×900（data-shell=${shell}）`)
  const deskLayer = await layerBox('.desk-frame')
  check('桌面壳是同一套壳（data-shell=desk）', shell === 'desk', shell)
  check('光层铺满整窗', deskLayer.x === 0 && deskLayer.y === 0 && deskLayer.w === 1440 && deskLayer.h === 900, `${deskLayer.x},${deskLayer.y} ${deskLayer.w}×${deskLayer.h}`)
  // 主区左右留白各取一点（避开 64 的导航轨、298 的信息栏与卡片落影）
  const deskL = await sample(96, 120)
  const deskR = await sample(1110, 860)
  check('主区左上确实亮于右下（光在窗口里）', deskL[0] - deskR[0] >= 4, `${hex(deskL)} vs ${hex(deskR)}`)
  await shot('1440x900')

  console.log(failed ? `\nFAIL：${failed} 项不通过` : '\nPASS：壳层环境光符合约定')
  process.exit(failed ? 1 : 0)
}

void main()
