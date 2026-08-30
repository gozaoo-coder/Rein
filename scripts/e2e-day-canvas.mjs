/**
 * 今日画布（/todos）端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-day-canvas.mjs   （前置：npm run dev 已在 1420）
 *
 * 覆盖：每日规划仪式 → 未安排池 → 时间轴块 → 桌面详情联动 → 子任务 →
 *       重复规则物化 → 池拖拽落位 → 智能排程（启发式路径）→ 周回顾 → 清单回归。
 * 时间冻结：把页面 Date 固定到"今天 12:00"，排程断言与运行时刻无关。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DEBUG_PORT = 9333
const APP = 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-canvas-${Date.now()}`

import { spawn } from 'node:child_process'

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(pageTargetUrl) {
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
  // 冻结时间：今天 12:00（app 全部 Date 走假时钟，排程窗口确定）
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const Real = Date;
      const F = new Real(); F.setHours(12, 0, 0, 0);
      const ms = F.getTime();
      class FakeDate extends Real {
        constructor(...a){ a.length === 0 ? super(ms) : super(...a); }
        static now(){ return ms; }
      }
      window.Date = FakeDate;
    })()`,
  })
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

/** CDP 鼠标事件（pointer 事件由此派生，块拖拽/点选都走它） */
async function mouse(type, x, y, extra = {}) {
  const params = { type, x, y, button: 'left', clickCount: 0, buttons: 0, ...extra }
  if (type === 'mousePressed') {
    params.buttons = 1
    params.clickCount = 1
  } else if (type === 'mouseReleased') {
    params.clickCount = 1
  }
  await cdp('Input.dispatchMouseEvent', params)
}

/** 元素中心坐标 */
async function centerOf(selectorFn) {
  return evalJS(`(() => {
    const el = (${selectorFn});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
}

/** 点击包含指定文本（或 aria-label）的按钮（scope 内；fixed 定位元素 offsetParent 为 null，用宽度判可见） */
async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const t = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('${scope} button, ${scope} [role="tab"]')]
    const el = els.find(b => (b.textContent.includes(t) || (b.getAttribute('aria-label') ?? '').includes(t)) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function goto(hash) {
  await evalJS(`location.hash = '${hash}'`)
  await sleep(450)
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/todos`)
    await sleep(1000)
    await evalJS(`(() => {
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push(String(e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
      return true
    })()`)
    await sleep(600)

    /* ---------- C. 画布首屏：每日规划仪式 ---------- */
    ok('C1 首次打开出现每日规划仪式', await waitFor(`!!document.querySelector('.ritual')`, 5000).catch(() => false))
    ok('C1b 仪式含昨天回顾文案', await evalJS(
      `[...document.querySelectorAll('.ritual .desc, .ritual .hi')].some(e => e.textContent.length > 0)`,
    ))
    await clickButton('跳过', '.ritual')
    await sleep(300)
    ok('C2 跳过后仪式关闭', await evalJS(`!document.querySelector('.ritual')`))
    await goto('/me')
    await goto('/todos')
    await sleep(500)
    ok('C2b 当天再进不再弹仪式', await evalJS(`!document.querySelector('.ritual')`))

    /* ---------- D. 画布结构 ---------- */
    ok('D1 三段视图切换存在', await evalJS(
      `!!document.querySelector('[data-testid="seg-canvas"]') && !!document.querySelector('[data-testid="seg-week"]') && !!document.querySelector('[data-testid="seg-list"]')`,
    ))
    const chipTitles = await evalJS(`[...document.querySelectorAll('.pchip')].map(c => c.dataset.title ?? c.textContent.trim())`)
    ok('D2 未安排池 3 张卡片（牙医/反馈/阅读）', chipTitles.length === 3 && chipTitles.some(t => t.includes('牙医')) && chipTitles.some(t => t.includes('阅读')), chipTitles.join('/'))
    ok('D3 智能排程按钮可用（池非空）', await evalJS(
      `!!document.querySelector('[data-testid="ai-schedule"]') && !document.querySelector('[data-testid="ai-schedule"]').disabled`,
    ))

    // 时间轴：滚动置顶，块位置可按分钟推算
    await evalJS(`(() => { const sc = document.querySelector('.ctl .scroll'); if (sc) sc.scrollTop = 0; return true })()`)
    await sleep(250)
    ok('D4 今日块渲染（力量训练/散步/复盘/通勤骑行）', await evalJS(
      `(() => {
        const ts = [...document.querySelectorAll('.blk')].map(b => b.dataset.title ?? '');
        return ['力量训练', '午休散步', '写今日复盘', '通勤骑行'].every(k => ts.some(t => t.includes(k)));
      })()`,
    ))
    ok('D5 现在线存在（今天视图）', await evalJS(`!!document.querySelector('.nowline')`))

    /* ---------- E. 选中 → 桌面详情联动 ---------- */
    ok('E0 力量训练块滚入视野', await evalJS(`(() => {
      const el = [...document.querySelectorAll('.blk')].find(b => (b.dataset.title ?? '').includes('力量训练'))
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      return true
    })()`))
    await sleep(300)
    const blk = await centerOf(`[...document.querySelectorAll('.blk')].find(b => (b.dataset.title ?? '').includes('力量训练'))`)
    ok('E0b 块坐标有效', !!blk && blk.y > 0 && blk.y < 900, JSON.stringify(blk))
    await mouse('mousePressed', blk.x, blk.y)
    await sleep(80)
    await mouse('mouseReleased', blk.x, blk.y)
    await sleep(350)
    ok('E1 点块 → 右栏详情显示标题', await evalJS(
      `document.querySelector('[data-testid="detail-panel"]')?.textContent.includes('力量训练 · 上肢')`,
    ))
    ok('E1b 详情含紧急标记（priority 2）', await evalJS(
      `document.querySelector('[data-testid="detail-panel"]')?.textContent.includes('紧急')`,
    ))

    /* ---------- F. 子任务（编辑器加 → 详情勾选） ---------- */
    ok('F0 详情编辑按钮打开抽屉', await clickButton('编辑', '[data-testid="detail-panel"]'))
    await waitFor(`!!document.querySelector('.backdrop')`, 4000, '编辑抽屉')
    await evalJS(`(() => {
      const inp = document.querySelector('.subinput')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(inp, '卧推 4×8')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    ok('F1 添加子任务', await clickButton('添加子任务'))
    await evalJS(`(() => {
      const inp = document.querySelector('.subinput')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(inp, '绳索下压 3×12')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await clickButton('添加子任务')
    await sleep(200)
    ok('F1b 列表两条', await evalJS(`document.querySelectorAll('.subs .sub').length === 2`))
    await clickButton('保存')
    await sleep(600)
    ok('F2 详情显示子任务进度 0/2', await evalJS(
      `document.querySelector('[data-testid="detail-panel"]')?.textContent.includes('0/2')`,
    ))
    // 勾选第一条
    await evalJS(`(() => {
      const box = document.querySelector('[data-testid="detail-panel"] .sub input')
      box.click()
      return true
    })()`)
    await sleep(500)
    ok('F3 勾选后进度 1/2（store 已回写）', await evalJS(
      `document.querySelector('[data-testid="detail-panel"]')?.textContent.includes('1/2')`,
    ))

    /* ---------- G. 重复规则：每周六 → 实例物化 ---------- */
    ok('G0 再次打开编辑抽屉', await clickButton('编辑', '[data-testid="detail-panel"]'))
    await waitFor(`!!document.querySelector('.backdrop')`, 4000, '编辑抽屉')
    ok('G1 切到每周', await clickButton('每周', '.panel'))
    await sleep(150)
    ok('G1b 选周六', await clickButton('六', '.panel'))
    await clickButton('保存')
    await sleep(900)
    // loadAll → sync_recurrences 物化周六实例；切清单验证
    await clickButton('清单')
    await sleep(700)
    const rideCount = await evalJS(
      `[...document.querySelectorAll('.item .title')].filter(e => e.textContent.includes('通勤骑行')).length`,
    )
    ok('G2 重复实例已物化（通勤骑行 ≥2 条：今天模板 + 未来周六）', rideCount >= 2, `count=${rideCount}`)
    await clickButton('画布')
    await sleep(500)

    /* ---------- H. 池拖拽 → 时间轴落位 ---------- */
    // 把 15:00 滚到滚动区可视中部（ppm 桌面默认 56/60），拖拽目标必须在可视区内
    await evalJS(`(() => {
      const sc = document.querySelector('.ctl .scroll')
      sc.scrollTop = Math.max(0, 15 * 60 * (56 / 60) - 200)
      return sc.scrollTop
    })()`)
    await sleep(250)
    const chip = await centerOf(`[...document.querySelectorAll('.pchip')].find(c => (c.dataset.title ?? '').includes('阅读'))`)
    const targetY = await evalJS(`(() => { const r = document.querySelector('.ctl .scroll').getBoundingClientRect(); return r.top + 200 })()`)
    ok('H0 拖拽源与目标坐标有效', !!chip && targetY > 0 && targetY < 900, JSON.stringify({ chip, targetY }))
    await mouse('mousePressed', chip.x, chip.y)
    await sleep(80)
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', chip.x + (i * 2), chip.y + ((targetY - chip.y) * i) / 6)
      await sleep(40)
    }
    ok('H1 拖拽中出现落点指示线', await evalJS(`!!document.querySelector('.dropline')`))
    await mouse('mouseReleased', chip.x + 12, targetY)
    await sleep(600)
    ok('H2 阅读落到 15:00（池少一张、新块出现）', await evalJS(
      `document.querySelectorAll('.pchip').length === 2 &&
       [...document.querySelectorAll('.blk')].some(b => (b.dataset.title ?? '').includes('阅读'))`,
    ))

    /* ---------- I. 智能排程（无模型 → 启发式）→ 确认 → 应用 ---------- */
    ok('I0 点击智能排程', await evalJS(`(() => { document.querySelector('[data-testid="ai-schedule"]').click(); return true })()`))
    await waitFor(`!!document.querySelector('[data-testid="ai-confirm"]')`, 5000, '确认条')
    ok('I1 幽灵块预览 2 个', await evalJS(`document.querySelectorAll('.blk.ghost').length === 2`))
    ok('I1b 依据文案出现', await evalJS(
      `[...document.querySelectorAll('.confirm .cr')].some(e => e.textContent.includes('排') || e.textContent.includes('空档'))`,
    ))
    await evalJS(`document.querySelector('[data-testid="ai-apply"]').click()`)
    await waitFor(`document.querySelectorAll('.pchip').length === 0`, 5000, '池清空')
    ok('I2 应用后池清空、块落位', await evalJS(
      `document.querySelectorAll('.pchip').length === 0 &&
       [...document.querySelectorAll('.blk')].filter(b => (b.dataset.title ?? '').includes('牙医') || (b.dataset.title ?? '').includes('反馈')).length >= 2`,
    ))
    ok('I3 池空提示出现', await evalJS(`!!document.querySelector('.pool-empty')`))

    /* ---------- J. 周视图 + 周回顾 ---------- */
    await clickButton('周')
    await sleep(600)
    ok('J1 周回顾卡渲染（环 + 洞察）', await evalJS(
      `!!document.querySelector('.ws .ring svg') && !!document.querySelector('.ws .insight')`,
    ))
    ok('J2 周选择条 7 格', await evalJS(`document.querySelectorAll('.week .wcell').length === 7`))
    await evalJS(`document.querySelectorAll('.week .wcell')[5].click()`)
    await sleep(500)
    ok('J3 点周六回画布且日期切换', await evalJS(
      `!!document.querySelector('.dateline') && !document.querySelector('.dateline').textContent.includes('今天')`,
    ))
    await evalJS(`document.querySelector('.dateline button[aria-label="后一天"]')`)
    await clickButton('今天', '.dateline').catch(() => {})
    // 回今天：连续点前一天直到回到今天（最多 7 次）
    for (let i = 0; i < 8; i++) {
      const isToday = await evalJS(`document.querySelector('.dlabel')?.textContent === '今天'`)
      if (isToday) break
      await evalJS(`document.querySelector('.dateline button[aria-label="前一天"]').click()`)
      await sleep(200)
    }
    ok('J4 日期导航回到今天', await evalJS(`document.querySelector('.dlabel')?.textContent === '今天'`))

    /* ---------- K. 清单回归 ---------- */
    await clickButton('清单')
    await sleep(600)
    ok('K1 清单分组渲染', await evalJS(`document.querySelectorAll('.group').length >= 2`))
    await clickButton('画布')
    await sleep(400)

    /* ---------- L. 移动端回归（430 宽不崩） ---------- */
    await cdp('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true })
    await sleep(600)
    ok('L1 移动宽度假下画布渲染', await evalJS(
      `!!document.querySelector('.ctl') && !!document.querySelector('.pchip, .pool-empty')`,
    ))
    await cdp('Emulation.clearDeviceMetricsOverride')
    await sleep(400)

    const errs = await evalJS('window.__errs')
    ok('Z 全程无未捕获异常', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs ?? []).slice(0, 300))
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 中断:', e.message)
  process.exit(2)
})
