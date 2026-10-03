/**
 * 训练总结页对比度审计（明暗双态）。
 * 运行：REIN_E2E_URL=http://localhost:1430 node scripts/colorlab/audit_summary_contrast.mjs
 *   （前置：另起一个**非 Tauri** 的 vite 于 1430）
 *
 * ## 方法与踩坑（按踩到的顺序 —— 每一条都产生过"看起来像配色坏了"的假警报）
 *
 * 1. **前景从像素里猜 —— 错。** 「取行盒内离底色最远的像素」在大字号元素上
 *    会把**卡底**当字（行盒里空白比墨色多）；DPR=1 时 17px 正文又几乎没有
 *    纯字芯像素（抗锯齿把每个像素都混成中间色）。**前景读
 *    getComputedStyle().color** —— 文字色是设计变量，不是要猜的东西。
 * 2. **背景从像素里采（中心点 / 角落）—— 都错。** 中心点会撞到压在上面的
 *    环与遮罩（量到 rgb(150,10,47) 的玫红，是倒数覆盖层）；角落 inset 4px
 *    在这一页又正好落进完成环的绿弧（量到 rgb(145,149,140)）。两者都把
 *    「亮色档几乎全红」造了出来，而那全是假的。
 *    **改为读背景元素的 background-color 计算值** —— 它是设计令牌
 *    （--surface / --surface-2 / color-mix 的结果），alpha 合成是确定算术。
 * 3. **半透明层当终止条件 —— 会算错。** 逐层向上找底时要跳过 alpha<1 的层，
 *    停在半透明层再拿白/黑兜底 = 把玻璃当白纸。--c-exercise-soft（alpha 0.2）
 *    与 --surface-2 都是这样，必须合成到第一个不透明祖先。
 * 4. **PNG 必须 Node 侧解。** 把 base64 塞进 Runtime.evaluate 传回页面再
 *    img.decode()：整屏图约 1 MB，evaluate 传参体积不够，decode() 静默失败
 *    → canvas 尺寸 undefined → 采样行数 0（症状伪装成"这一行盒里没有字"）。
 *    本脚本保留 Node 侧解 PNG，只用它做**主题自检**与截图留档。
 * 5. **evalJS 的模板字符串里不能出现反引号，也不能出现美元号加大括号** ——
 *    任一个都会提前终止模板，后面的注释被当代码执行，报出
 *    「JSON.stringify(...) is not a function」这种完全指错位置的错。
 * 6. **开课要走真实 UI。** 直接调 store 的 session.start() 不会打开沉浸层
 *    （那层壳由 openImmersive 异步挂载），脚本会量到课程详情页；
 *    且 start() 撞上残留的 active 会话会**静默返回 conflict** 而不开新课。
 *
 * 覆盖：完成环 / 四项指标 / 进步卡 / 明细三段 / 肌群三档芯片 / 标签 / 下次建议。
 * 门槛按 STANDARDS：正文 ≥7、次要 ≥4.5、三级 ≥3（比例 1）。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { inflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1430'
const USER_DATA = `${process.env.TEMP}/rein-audit-sum-${Date.now()}`
const OUT = 'docs/shots'

const TIER = { body: 7, sub: 4.5, hint: 3 }

/**
 * 待测项。bg 给的是**该处文字实际压着的那个元素**（显式，不猜）：
 * 逐层 alpha 合成由 audit 脚本做，调用方只负责说清"底是谁"。
 * 同档多处命中时取第一个可见的（列表类元素本身逐条样式相同）。
 */
const TARGETS = [
  { name: '完成环百分比', fg: '.heropct', tier: 'body', bg: '.sumpane' },
  { name: '完成环 n/N 组', fg: '.herosub', tier: 'sub', bg: '.sumpane' },
  { name: '课程名标题', fg: '.sumtitle', tier: 'body', bg: '.sumpane' },
  { name: '副标题（日期·类型）', fg: '.sumsub', tier: 'sub', bg: '.sumpane' },
  { name: '跳过/加练/热身标签', fg: '.sumtag', tier: 'sub', bg: '.sumtag' },
  { name: '指标标签（三级）', fg: '.stlabel', tier: 'hint', bg: '.stat' },
  { name: '指标数值', fg: '.stval', tier: 'body', bg: '.stat' },
  { name: '指标单位（三级）', fg: '.stunit', tier: 'hint', bg: '.stat' },
  { name: '进步卡标题', fg: '.prtitle', tier: 'sub', bg: '.prcard' },
  { name: '进步·动作名', fg: '.prname', tier: 'sub', bg: '.prcard' },
  { name: '进步·数值', fg: '.prval', tier: 'sub', bg: '.prcard' },
  { name: '进步·增量', fg: '.prdelta', tier: 'sub', bg: '.prcard' },
  { name: '明细·动作名', fg: '.exname', tier: 'sub', bg: '.blockcard' },
  { name: '明细·组数容量', fg: '.exmain', tier: 'sub', bg: '.blockcard' },
  { name: '明细·最高组（三级）', fg: '.extop', tier: 'hint', bg: '.blockcard' },
  { name: '明细·PR 徽标', fg: '.expr', tier: 'sub', bg: '.expr' },
  { name: '肌群芯片 lv3（主攻）', fg: '.muschip.lv3', tier: 'sub', bg: '.muschip.lv3' },
  { name: '肌群芯片 lv2（辅助）', fg: '.muschip.lv2', tier: 'sub', bg: '.muschip.lv2' },
  { name: '肌群芯片 lv1（稳定）', fg: '.muschip.lv1', tier: 'sub', bg: '.muschip.lv1' },
  { name: '卡标题（h3）', fg: '.hintcard h3', tier: 'sub', bg: '.hintcard' },
  { name: '下次建议正文', fg: '.hintcard p', tier: 'body', bg: '.hintcard' },
]

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

let DEBUG_PORT = 9338
let ws
let msgId = 0
const pending = new Map()
const results = []

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
    // 把**实际发出的表达式**打进错误里：这类"页面里报 JSON.stringify is not a
    // function"的错几乎都是模板插值把字面量 ${...} 送进了页面，
    // 而只看错误文本完全看不出是哪一行插坏了。
    const head = expression.slice(0, 400).replace(/\n/g, '\\n')
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.text) + '\\n--- 表达式开头 ---\\n' + head)
  }
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- PNG 解码（Node 侧，避开 evaluate 传参体积上限） ---------------- */

function decodePng(buf) {
  let off = 8
  let w = 0
  let h = 0
  let channels = 4
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      const colorType = data[9]
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
      if (channels === 0) throw new Error('暂不支持调色板/灰度 PNG')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const px = Buffer.alloc(h * stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = px.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return { w, h, channels, px }
}

function pixelAt(img, x, y) {
  const xi = Math.max(0, Math.min(img.w - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(img.h - 1, Math.round(y)))
  const i = (yi * img.w + xi) * img.channels
  return [img.px[i], img.px[i + 1], img.px[i + 2]]
}

function ratio(a, b) {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const [hi, lo] = L(a) > L(b) ? [L(a), L(b)] : [L(b), L(a)]
  return (hi + 0.05) / (lo + 0.05)
}

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1400)
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
    // DPR=2：字芯要有足够像素，1x 下 17px 正文几乎全是抗锯齿中间色
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true })
    await cdp('Page.navigate', { url: `${APP}/#/sports/plans/ppl-push` })
    await sleep(3000)
    await evalJS(`(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rein.mock.')) localStorage.removeItem(k)
      let s = document.getElementById('__e2e-stable')
      if (!s) { s = document.createElement('style'); s.id = '__e2e-stable'
        s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
        document.head.appendChild(s) }
      return true
    })()`)
    await cdp('Page.reload')
    await sleep(3000)
    // 清掉可能残留的 active 会话：session.start 撞上已有会话会**静默返回 conflict**
    // 而不新开一节，于是脚本后面的所有操作都跑在「课没开」的状态上 ——
    // 症状是页面停在课程详情页、截图里盖着倒数覆盖层，颜色全读成覆盖层的玫红。
    await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      for (let i = 0; i < 5; i++) {
        const rec = await invoke('session_active')
        if (!rec) break
        await invoke('session_abort', { id: rec.id })
      }
      return true
    })()`)
    await cdp('Page.reload')
    await sleep(2800)

    // 走**真实 UI 流程**开课：沉浸层由 openImmersive 驱动异步挂载，
    // 直接调 store 的 start() 不会打开那层壳，脚本就量不到总结页。
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始'))
      if (btn) btn.click()
      return !!btn
    })()`)
    await sleep(2500)
    // 热身组先清掉，否则它挡在热身阶段（且它的 rest 会打断脚本的直推）
    await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      let guard = 0
      while (guard++ < 60) {
        if (s.phase === 'warmup') { s.completeWarmup(); continue }
        if (s.phase === 'rest') { s.skipRest(); continue }
        break
      }
      return s.phase
    })()`)
    await sleep(600)
    // 关掉更新弹窗（**只 display:none，不 remove()** —— 那是 Vue 管理的节点）
    await evalJS(`(() => {
      for (const el of document.querySelectorAll('body > *')) {
        if (el.textContent.includes('发现新版本')) el.style.display = 'none'
      }
      return true
    })()`)
    await sleep(500)

    // 推到总结阶段；杠铃卧推做到 70 kg（mock 种子历史最高 62.5）让 PR 区块真的渲染
    const phase = await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      let guard = 0
      while (s.phase !== 'summary' && guard++ < 300) {
        if (s.phase === 'rest') { s.skipRest(); continue }
        if (s.phase === 'warmup') { s.completeWarmup(); continue }
        const ex = s.currentEx
        if (!ex) break
        if (ex.kind !== 'strength') { s.skipCurrentSet(); continue }
        s.setWeight(s.exIndex === 0 ? 70 : 50)
        s.setReps(8)
        s.completeSet()
      }
      return s.phase
    })()`)
    if (phase !== 'summary') throw new Error('未进入总结阶段，当前 ' + phase)
    // 沉浸层壳要等形变动画结束才铺满；量色前确认总结页真的在屏上，
    // 否则量到的是课程详情页 + 倒数覆盖层（玫红），读数全无意义
    let onScreen = false
    for (let i = 0; i < 30; i++) {
      onScreen = await evalJS(`(() => {
        const el = document.querySelector('.sumpane')
        if (!el) return false
        const r = el.getBoundingClientRect()
        return r.width > 200 && r.height > 200
      })()`)
      if (onScreen) break
      await sleep(200)
    }
    if (!onScreen) throw new Error('总结页未铺满视口（沉浸层可能没打开）')
    // 等 PR 历史校正回来（异步）
    for (let i = 0; i < 30; i++) {
      if (await evalJS(`Boolean(document.querySelector('.prcard'))`)) break
      await sleep(200)
    }

    mkdirSync(OUT, { recursive: true })

    for (const mode of ['light', 'dark']) {
      await cdp('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: mode }],
        media: 'screen',
      })
      await sleep(500)
      // 自检：媒体查询真的切过去了吗。亮色档若读到深色 --bg，
      // 后面每个读数都是「暗色像素 × 亮色令牌」的错值（症状是亮色几乎全红）。
      const themeCheck = await evalJS(`(async () => {
        const d = document.createElement('div')
        d.style.color = 'var(--surface)'
        document.body.appendChild(d)
        const v = getComputedStyle(d).color
        d.remove()
        return v
      })()`)
      const m2 = String(themeCheck).match(/[0-9]+/g)?.map(Number) ?? [255]
      const lum0 = 0.2126*m2[0] + 0.7152*m2[1] + 0.0722*m2[2]
      if (mode === 'light' && lum0 < 200) throw new Error('亮色档未生效：--surface=' + themeCheck)
      if (mode === 'dark' && lum0 > 100) throw new Error('暗色档未生效：--surface=' + themeCheck)
      console.log('  主题自检 --surface=' + themeCheck + ' 亮度=' + lum0.toFixed(0))
      const shot = await cdp('Page.captureScreenshot', { format: 'png' })
      const img = decodePng(Buffer.from(shot.data, 'base64'))
      writeFileSync(`${OUT}/audit-summary-${mode}.png`, Buffer.from(shot.data, 'base64'))
      const dpr = await evalJS(`window.devicePixelRatio || 1`)

      console.log(`\n===== ${mode} （图 ${img.w}×${img.h}, dpr=${dpr}） =====`)
      for (const t of TARGETS) {
        /**
         * 前景 = 元素的 color 计算值；背景 = **逐层向上**的第一个不透明底。
         *
         * 为什么不用像素：中心点会撞到环/遮罩，角落会落进绿弧，
         * 两者都造出过整档假红（见文件头第 2 条）。
         * 为什么不用「元素自己的 background-color」就完事：
         * 这一页的芯片底是半透明的（--c-exercise-soft alpha 0.2），
         * 停在半透明层等于把玻璃当白纸（见文件头第 3 条），必须往上合成。
         */
        const info = await evalJS(`(() => {
          // rgb(240 252 225 / 0.64) 这类新记法：分量 0..1，斜杠后是 alpha。
          // 必须**定义在 parse 之前** —— const 有 TDZ，parse 里引用它时若声明在后，
          // 首次调用就抛 ReferenceError（报 "Uncaught"，看不出是哪个函数）。
          const slashAlpha = (str) => {
            const m = /\\/\\s*([0-9.]+)\\s*\\)/.exec(str)
            return m ? +m[1] : null
          }
          const parse = (c) => {
            const s = String(c).trim()
            if (!s || s === 'transparent' || s === 'none') return null
            if (s.startsWith('#')) {
              const h = s.slice(1)
              const n = h.length === 3 ? [...h].map((x) => x + x).join('') : h
              return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), 1]
            }
            // color-mix(in srgb, ...) 在 Chromium 里算成 color(srgb r g b / a)，
            // **分量是 0..1 而不是 0..255**。用统一的数字正则去抓会得到
            // [0.94, 0.98, 0.88, 0.64] 当成 0..255 → 合成出 rgb(89,89,89)
            // 这种中间灰，于是亮色档整档假红（白卡被算成深灰）。
            // 这与文件头第 2、3 条是同一类错误：把「读到的数字」当成「它看起来的意思」。
            const srgb = /^color\\(srgb\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)(?:\\s*\\/\\s*([0-9.]+))?\\s*\\)$/.exec(s)
            if (srgb) {
              return [Math.round(+srgb[1] * 255), Math.round(+srgb[2] * 255), Math.round(+srgb[3] * 255),
                srgb[4] != null ? +srgb[4] : 1]
            }
            const m = s.match(/[0-9.]+/g)
            if (!m) return null
            const sa = slashAlpha(s)
            if (m.length > 3 && sa != null) {
              return [Math.round(+m[0] * 255), Math.round(+m[1] * 255), Math.round(+m[2] * 255), sa]
            }
            return [+m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1]
          }
          // 找前景元素（取第一个可见的）
          let fg = null
          for (const el of document.querySelectorAll(${JSON.stringify(t.fg)})) {
            const r = el.getBoundingClientRect()
            if (r.width > 1 && r.height > 1) { fg = el; break }
          }
          if (!fg) return { missing: true }
          const fcs = getComputedStyle(fg)
          // 背景：从「指定的背景元素」起，逐层向上找到第一个不透明底。
          // 起点用 aria/选择器都行，但**必须显式给** —— 让脚本自己往上猜
          // 就会猜到 body，把整页的渐变底当成局部底。
          let seed = null
          for (const el of document.querySelectorAll(${JSON.stringify(t.bg)})) {
            const r = el.getBoundingClientRect()
            if (r.width > 2 && r.height > 2) { seed = el; break }
          }
          if (!seed) return { noBg: true }
          const stack = []
          let opaqueFound = false
          for (let el = seed; el; el = el.parentElement) {
            const c = parse(getComputedStyle(el).backgroundColor)
            if (c && c[3] > 0) {
              stack.push(c)
              if (c[3] >= 1) { opaqueFound = true; break }
            }
          }
          // 一直走到根都没遇到不透明层（.sumpane / .scrollbody 都透明，
          // 底其实来自 body 的渐变 + var(--bg)）→ 用 --bg 令牌兜底。
          // **不能因为「找到一个半透明层」就 break**：那等于把半透明芯片底
          // 当成最终底，亮色档会把白卡算成深灰（实测 rgb(89,89,89)），
          // 于是整档假红 —— 这就是半透明层当终止条件那个坑的现场。
          if (!opaqueFound) {
            const bgToken = parse(getComputedStyle(document.documentElement).getPropertyValue('--bg'))
            const bodyBg = parse(getComputedStyle(document.body).backgroundColor)
            const fallback = bodyBg && bodyBg[3] >= 1 ? bodyBg : bgToken
            if (fallback) stack.push(fallback)
          }
          return {
            color: fcs.color,
            fontSize: fcs.fontSize,
            fontWeight: fcs.fontWeight,
            stack,
            chipBg: parse(getComputedStyle(seed).backgroundColor),
          }
        })()`)

        if (info.missing) {
          console.log('  ??  ' + t.name + ' —— 前景元素不存在（该分支未渲染）')
          results.push({ mode, name: t.name, pass: null })
          continue
        }
        if (info.noBg) {
          console.log('  ??  ' + t.name + ' —— 背景元素不存在')
          results.push({ mode, name: t.name, pass: null })
          continue
        }
        const fm = String(info.color).match(/[0-9.]+/g)?.map(Number) ?? []
        if (fm.length < 3) {
          console.log('  ??  ' + t.name + ' —— 前景色无法解析（' + info.color + '）')
          results.push({ mode, name: t.name, pass: null })
          continue
        }
        if (!info.stack?.length) {
          console.log('  ??  ' + t.name + ' —— 找不到不透明底（背景链全透明）')
          results.push({ mode, name: t.name, pass: null })
          continue
        }
        // 自底向上合成：stack[0] 是最贴近文字的那层
        let bgPx = null
        for (let i = info.stack.length - 1; i >= 0; i--) {
          const c = info.stack[i]
          bgPx = bgPx == null
            ? [c[0], c[1], c[2]]
            : [c[0] * c[3] + bgPx[0] * (1 - c[3]), c[1] * c[3] + bgPx[1] * (1 - c[3]), c[2] * c[3] + bgPx[2] * (1 - c[3])]
        }
        bgPx = bgPx.map((v) => Math.round(v))
        // 前景若也带 alpha（暗色 --text-2/--text-3 是 rgba），先合成到同一条底上
        const fa = fm.length > 3 ? fm[3] : 1
        const fgPx = fa < 1
          ? [fm[0] * fa + bgPx[0] * (1 - fa), fm[1] * fa + bgPx[1] * (1 - fa), fm[2] * fa + bgPx[2] * (1 - fa)]
          : [fm[0], fm[1], fm[2]]
        const cr = ratio(fgPx, bgPx)
        const need = TIER[t.tier]
        const pass = cr >= need
        results.push({ mode, name: t.name, pass, cr, need })
        console.log(
          '  ' + (pass ? 'PASS' : 'FAIL') + '  ' + t.name.padEnd(22) + ' ' + cr.toFixed(2) + ':1  (需 ' + need + ')  ' +
          'fg=' + info.color + ' @' + info.fontSize + '/' + info.fontWeight +
          '  bg=rgb(' + bgPx + ')' + (info.chipBg ? '  芯片底alpha=' + info.chipBg[3] : '')
          + '  底链=' + JSON.stringify((info.stack ?? []).map((c) => c.join(','))),
        )
      }
    }

    const fails = results.filter((r) => r.pass === false)
    const unknown = results.filter((r) => r.pass === null)
    console.log(`\n${results.length - fails.length - unknown.length} 通过 / ${fails.length} 失败 / ${unknown.length} 未渲染`)
    if (fails.length) {
      console.log('失败项:')
      for (const f of fails) console.log(`  ${f.mode}:${f.name} ${f.cr?.toFixed(2)} (需 ${f.need})`)
      process.exit(1)
    }
  } catch (e) {
    console.error('审计中断:', e?.message ?? e)
    // 堆栈：这类"页面里报 JSON.stringify is not a function"的错，
    // 错误文本本身完全指不出位置（它其实来自 evalJS 之外的某个 promise），
    // 只有堆栈能定位到是哪一行发出去的表达式。
    console.error(e?.stack ?? '(无堆栈)')
    process.exit(1)
  } finally {
    edge.kill()
  }
}

main()
