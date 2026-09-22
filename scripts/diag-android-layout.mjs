/**
 * 真机布局体检 —— 通过 adb 连上 Android WebView 的 DevTools，在**设备自己的页面**上求值。
 *
 * 为什么不能只靠截图：截图只能量「有墨迹的东西」，而空元素（没有文字/背景/边框却占着
 * 高度）在截图上是一片白 —— 那正是「莫名空档」的典型来源。这个脚本直接读 DOM
 * （getBoundingClientRect + 计算样式），能把这类盒子抓出来；`--border` 还会把每个
 * 盒子用 outline 画出来（outline 不参与布局，不影响被观察的几何）以便肉眼核对。
 *
 * 前置：
 *   1. 设备已 adb 连接（`adb devices` 能看到，且已授权）
 *   2. 设备上跑的是**打开了 WebView 调试**的包：
 *      release 包默认关（`/proc/net/unix` 里没有 webview_devtools_remote）；
 *      需要在 MainActivity.onCreate 里临时加一行
 *        WebView.setWebContentsDebuggingEnabled(true)
 *      重新构建安装（同签名覆盖安装，数据不丢），体检完再发正式包即可。
 *
 * 用法：
 *   node scripts/diag-android-layout.mjs                 # 量下列页面的间距与空盒子
 *   node scripts/diag-android-layout.mjs --border        # 额外把盒子用 outline 画出来并截图
 *   node scripts/diag-android-layout.mjs --watch         # 每 2 秒轮询，发现异常空档就打印
 *   REIN_PAGES="#/ai/models,#/ai" node …                 # 指定页面
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`
const PORT = Number(process.env.REIN_DIAG_PORT ?? 9336)
const OUT = process.env.TEMP ?? '.'
const argv = process.argv.slice(2)
const wantBorder = argv.includes('--border')
const watch = argv.includes('--watch')
const PAGES = (process.env.REIN_PAGES ?? '#/ai/models,#/settings/update,#/ai').split(',')

/** 每个页面要量的东西：选择器 → 名称（量 rect 与相邻空档） */
const PROBES = {
  '#/ai/models': ['.page-header', '.ph-mask', '.m-card', '.m-card .m-name', '.m-card .m-id', '.m-card .m-cost', '.m-card .caps'],
  '#/settings/update': ['.page-header', '.card .rows'],
  '#/ai': ['.page-header', '.msgs', '.composer', '.inbar', '.dock'],
}

const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sock = adb('shell', `cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1`)
if (!sock) {
  console.error(
    '没有 webview_devtools_remote socket：\n' +
      '  · 确认 App 在前台运行；\n' +
      '  · release 包默认关闭 WebView 调试，需要按文件头说明临时打开并重装。',
  )
  process.exit(1)
}
adb('forward', `tcp:${PORT}`, `localabstract:${sock}`)
const targets = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).text())
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('没有可调试的 page 目标：', targets.map((t) => t.type).join(','))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const cb = pending.get(m.id)
    pending.delete(m.id)
    cb(m.result ?? m.error)
  }
}
function evaluate(expression) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, (r) => {
      if (r?.exceptionDetails) resolve({ __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text })
      else resolve(r?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

/** 取 --safe-* 等变量的**解析值**（getPropertyValue 给的是未解析 token，parseFloat 会得 0） */
const RESOLVE = `(name) => {
  const p = document.createElement('div')
  p.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;padding-top:var(' + name + ')'
  document.body.appendChild(p)
  const v = Math.round((parseFloat(getComputedStyle(p).paddingTop) || 0) * 10) / 10
  p.remove()
  return v
}`

function measureExpr(sels) {
  return `(() => {
    const resolveVar = ${RESOLVE}
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
    }
    const out = {
      hash: location.hash,
      view: innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio,
      scroll: Math.round(window.scrollY),
      perf: document.documentElement.dataset.perf ?? '-',
      vars: {
        safeTop: resolveVar('--safe-top'),
        safeBottom: resolveVar('--safe-bottom'),
        tabbar: resolveVar('--tabbar-h'),
      },
      rects: {},
      gaps: [],
      phantoms: [],
    }
    for (const sel of ${JSON.stringify(sels)}) {
      out.rects[sel] = rect(document.querySelector(sel))
    }
    // 相邻块之间的空档（同一父容器内）
    for (const box of document.querySelectorAll('.card, .m-card, .rows, .composer')) {
      const kids = [...box.children].filter((el) => el.getBoundingClientRect().height > 0)
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1].getBoundingClientRect()
        const b = kids[i].getBoundingClientRect()
        const gap = Math.round(b.top - a.bottom)
        if (gap > 0) out.gaps.push({ parent: String(box.className).slice(0, 20), gap })
      }
    }
    // 空盒子：无文本 / 无背景 / 无边框却有高度（截图上看不出来，却是空档的来源）
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.pblur') || el.classList.contains('ph-mask') || el.classList.contains('cb-mask')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.height <= 4 || r.width <= 0) continue
      const hasText = (el.textContent || '').trim().length > 0
      const hasBg = cs.backgroundImage !== 'none' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent')
      if (hasText || hasBg || cs.borderTopWidth !== '0px') continue
      if (el.tagName === 'SVG' || el.closest('svg')) continue
      out.phantoms.push({ path: el.tagName.toLowerCase() + '.' + String(el.className).split(/\\s+/).filter(Boolean).join('.'), top: Math.round(r.top), h: Math.round(r.height) })
    }
    return out
  })()`
}

async function goto(hash, waitSel) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`)
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(waitSel)})`)) break
    await sleep(200)
  }
  await sleep(800)
}

async function shot(name) {
  adb('shell', 'screencap -p /sdcard/_diag.png')
  adb('pull', '/sdcard/_diag.png', `${OUT}\\${name}.png`)
  console.log(`      截图 → ${OUT}\\${name}.png`)
}

if (watch) {
  console.log('轮询中（每 2 秒；Ctrl+C 结束）。只在发现 >28px 的可疑空档时打印。')
  for (;;) {
    const m = await evaluate(measureExpr([]))
    if (m?.gaps?.length) {
      const bad = m.gaps.filter((g) => g.gap >= 28)
      if (bad.length) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${m.hash} 可疑空档：`, JSON.stringify(bad))
        await shot(`diag-anomaly-${Date.now()}`)
      }
    }
    await sleep(2000)
  }
}

for (const hash of PAGES) {
  const sels = PROBES[hash] ?? ['.page-header']
  await goto(hash, sels[1] ?? sels[0])
  const m = await evaluate(measureExpr(sels))
  console.log(`\n===== ${hash} =====`)
  console.log(JSON.stringify(m, null, 1))
  if (wantBorder) {
    await evaluate(`document.getElementById('rein-diag-border')?.remove();
      (() => { const s = document.createElement('style'); s.id='rein-diag-border';
        s.textContent = '*:not(html):not(body){outline:1px solid rgba(255,0,0,.30) !important}'
          + '.pblur,.pblur span,.ph-mask,.cb-mask,.page-header{outline:1px dashed rgba(0,170,0,.85) !important}'
          + '.card,.m-card{outline:1px solid rgba(0,90,255,.55) !important}';
        document.head.appendChild(s); return true })()`)
    await sleep(400)
    await shot(`diag-border-${hash.replace(/[#/]/g, '_').replace(/^_/, '')}`)
    await evaluate(`document.getElementById('rein-diag-border')?.remove()`)
  }
}
ws.close()
