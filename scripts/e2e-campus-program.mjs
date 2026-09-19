/**
 * e2e-campus-program —— 培养方案页端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：培养方案是**数据形状最脏**的一页——学分分布是教务那种多层嵌套树、
 * 课程清单上百条、学分进度要跨「已修（账号）/ 需修（方案）」两个来源拼。这些全靠
 * 前端摊平与派生，Rust 侧只保证「把 JSON 原样拿回来」，钉不到渲染。
 *
 * 剧本：
 *   1. 未登录 → 空态提示先绑定账号
 *   2. 从配置页入口点进培养方案（不是直接改 hash）
 *   3. 方案档案：方案名 / 年级 / 学历 / 院系 / 专业
 *   4. 学分进度：已修 / 需修 + 进度条宽度 = 比例
 *   5. 学分分布：多层级树摊平成带缩进的行
 *   6. 课程清单：计数、按名搜索、按代码搜索
 *   7. 顶栏刷新
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-campus-program.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
]
const BROWSER = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) {
  console.error('找不到 Edge/Chrome，无法运行 e2e')
  process.exit(1)
}

const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-program-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 断言与结果汇总 ---------------- */

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let nextId = 1
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
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

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  const file = `${SHOTS}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${file}`)
}

async function connect(url) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
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
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    try {
      const ready = await evalJS('document.readyState')
      if (ready === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

const setInput = (selector, value) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

const clickText = (selector, text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9333 + (process.pid % 200)

async function main() {
  const edge = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${USER_DATA}`,
      '--no-first-run',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    await sleep(1500)
    await connect(`${APP}/#/campus/program`)

    /* ---- 1. 未登录空态 ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '培养方案'`, 12000, '培养方案页挂载')
    await waitFor(`document.body.textContent.includes('还没有绑定教务系统账号')`, 8000, '未登录提示')
    ok('未登录时提示先绑定账号', true)
    await shot('1-empty')

    /* ---- 2. 登录后从配置页入口进来 ---- */
    await evalJS(`location.hash = '#/campus/settings'`)
    await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '配置页挂载')
    await setInput('input[autocomplete="username"]', '2600350118')
    await setInput('input[autocomplete="current-password"]', 'demo1234')
    await clickText('button', '登录')
    await waitFor(`document.body.textContent.includes('已登录')`, 12000, '登录成功')
    await waitFor(`document.body.textContent.includes('培养方案')`, 6000, '入口出现')
    await clickText('.link-row', '查看培养方案')
    await waitFor(`document.querySelector('h1')?.textContent === '培养方案'`, 8000, '培养方案页挂载')
    await waitFor(`!!document.querySelector('.meta-grid')`, 10000, '方案档案渲染')
    ok('从配置页可以点进培养方案', true)

    /* ---- 3. 方案档案 ---- */
    const meta = await evalJS(`(() => {
      const g = {}
      for (const d of document.querySelectorAll('.meta-grid > div')) {
        g[d.querySelector('.k')?.textContent.trim()] = d.querySelector('.v')?.textContent.trim()
      }
      return { title: document.querySelector('h1')?.parentElement?.textContent.replace(/\\s+/g, ' ').trim(), ...g }
    })()`)
    ok('页头显示方案名', /培养方案/.test(meta.title ?? ''), meta.title)
    ok('档案含年级 / 学历 / 院系 / 专业', ['年级', '学历', '院系', '专业'].every((k) => k in meta), JSON.stringify(meta))

    /* ---- 4. 学分进度 ---- */
    const prog = await evalJS(`(() => {
      const el = document.querySelector('.prog')
      if (!el) return null
      const m = (el.querySelector('.prog-num')?.textContent ?? '').match(/([\\d.]+)\\s*\\/\\s*([\\d.]+)/)
      const fill = el.querySelector('.bar .fill')
      return {
        got: m ? Number(m[1]) : null,
        need: m ? Number(m[2]) : null,
        width: fill ? fill.getBoundingClientRect().width / fill.parentElement.getBoundingClientRect().width : null,
      }
    })()`)
    ok('显示已修 / 需修学分', prog?.got > 0 && prog?.need > prog?.got, JSON.stringify(prog))
    ok(
      '进度条宽度 = 已修/需修',
      Math.abs(prog.width - prog.got / prog.need) < 0.02,
      `${(prog.width * 100).toFixed(1)}% vs ${((prog.got / prog.need) * 100).toFixed(1)}%`,
    )

    /* ---- 5. 学分分布树 ---- */
    const credit = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.credit .crow')]
      const l1 = rows.filter((e) => e.classList.contains('l1'))
      const l2 = rows.filter((e) => e.classList.contains('l2'))
      const w = (e) => getComputedStyle(e.querySelector('.cname')).fontWeight
      return {
        total: rows.length,
        l1: l1.length,
        l2: l2.length,
        l1w: l1[0] ? w(l1[0]) : '',
        l2w: l2[0] ? w(l2[0]) : '',
        first: rows[0]?.textContent.replace(/\\s+/g, ' ').trim(),
      }
    })()`)
    ok('学分分布摊平成多行', credit.total >= 4, `${credit.total} 行（一级 ${credit.l1} / 下级 ${credit.l2}）`)
    ok(
      '二级模块与一级在视觉上分层（字重不同）',
      credit.l2 > 0 && credit.l1w !== credit.l2w,
      `一级 ${credit.l1w} / 二级 ${credit.l2w}（一级 ${credit.l1} 行、二级 ${credit.l2} 行）`,
    )

    /* ---- 6. 课程清单 ---- */
    const total = await evalJS(`(() => {
      const sec = [...document.querySelectorAll('.sec')].find((h) => h.textContent.includes('课程清单'))
      const m = sec?.textContent.match(/(\\d+)\\/(\\d+)/)
      return { shown: Number(m?.[1] ?? 0), all: Number(m?.[2] ?? 0) }
    })()`)
    ok('课程清单显示条数', total.all > 0, `${total.shown}/${total.all}`)

    await setInput('.search input', '英语')
    await waitFor(
      `document.querySelectorAll('.courses .course').length < ${total.all}`,
      6000,
      '按课程名过滤',
    )
    const byName = await evalJS(`document.querySelectorAll('.courses .course').length`)
    ok('按课程名过滤', byName > 0 && byName < total.all, `${total.all} → ${byName}`)

    await setInput('.search input', '0001')
    await sleep(200)
    const byCode = await evalJS(`document.querySelectorAll('.courses .course').length`)
    ok('按课程代码过滤', byCode > 0 && byCode < total.all, `0001 → ${byCode}`)

    await setInput('.search input', 'zzz-不存在的课')
    await waitFor(`document.querySelectorAll('.courses .course').length === 0`, 6000, '无结果')
    ok('搜不到时列表为空（不是显示全部）', true)

    await setInput('.search input', '')
    await waitFor(`document.querySelectorAll('.courses .course').length === ${total.all}`, 6000, '清空恢复')
    ok('清空搜索恢复全部', true)
    await shot('2-program')

    /* ---- 7. 刷新 ---- */
    await evalJS(`document.querySelector('.hdr-btn').click()`)
    await waitFor(`document.body.textContent.includes('培养方案已更新')`, 8000, '刷新回执')
    ok('顶栏刷新可强制重拉', true)
  } finally {
    try {
      ws?.close()
    } catch {
      /* 忽略 */
    }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  console.log(`截图目录：${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('e2e 失败：', e.message)
  process.exit(1)
})
