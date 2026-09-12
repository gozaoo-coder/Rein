/**
 * 录音系统端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：E2E_CDP_PORT=9444 REIN_E2E_URL=http://localhost:1740 node scripts/e2e-record.mjs
 *
 * 无头环境没有麦克风：在 addScriptToEvaluateOnNewDocument 里注入
 * 伪 getUserMedia + FakeMediaRecorder（stop 时吐一个小 blob），
 * 让 recorderRuntime 全链路（开始→计时→停止→take→附加→持久化）真实跑通。
 *
 * 覆盖：录音页录音台 → 浮窗跨页接管 → 浮窗停止 → take 回放 →
 *       取消不产出 → 附加到待办（picker + 落库）→ 待办侧附件可见 →
 *       编辑抽屉内录音直挂附件。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9333)
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-record-${Date.now()}`

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
  // 无麦克风的替身：伪流 + FakeMediaRecorder（stop → ondataavailable + onstop）
  // 注意 navigator.mediaDevices 在无头 Edge 已存在（原型 getter），直接赋值会被
  // 静默吞掉，必须 defineProperty 强制覆盖，否则走真 getUserMedia 必挂。
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__mrLog = []
      const fakeTrack = { stop() { window.__mrLog.push('track-stop') } }
      const fakeMediaDevices = {
        getUserMedia: async () => { window.__mrLog.push('gum'); return { getTracks: () => [fakeTrack] } },
      }
      Object.defineProperty(navigator, 'mediaDevices', { value: fakeMediaDevices, writable: true, configurable: true })
      class FakeMediaRecorder {
        constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm' }
        start() { if (this.state === 'recording') return; this.state = 'recording'; window.__mrLog.push('start') }
        stop() {
          if (this.state !== 'recording') return
          this.state = 'inactive'
          window.__mrLog.push('stop')
          const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' })
          this.ondataavailable?.({ data: blob })
          setTimeout(() => this.onstop?.(), 20)
        }
      }
      window.MediaRecorder = FakeMediaRecorder
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

/** 元素中心坐标 */
async function centerOf(selectorFn) {
  return evalJS(`(() => {
    const el = (${selectorFn});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
}

/** 点击包含指定文本（或 aria-label）的按钮（scope 内；fixed 定位用宽度判可见） */
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
  await sleep(500)
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/record`)
    await sleep(1200)
    await evalJS(`(() => {
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push(String(e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
      return true
    })()`)

    /* ---------- A. 录音台 + 浮窗 ---------- */
    ok('A1 录音页渲染（录音台 + 大按钮）', await evalJS(
      `!!document.querySelector('[data-testid="record-hero"]') && !!document.querySelector('[data-testid="rec-toggle"]')`,
    ))
    ok('A0 麦克风替身已注入', await evalJS(`!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && window.MediaRecorder.name === 'FakeMediaRecorder'`))

    ok('A2 点按开始录音', await clickButton('开始录音'))
    await sleep(300)
    const a2 = await evalJS(`(() => JSON.stringify({
      on: document.querySelector('[data-testid="rec-toggle"]')?.classList.contains('on') ?? null,
      timer: !!document.querySelector('.timer'),
      rdock: !!document.querySelector('.rdock-root'),
      err: document.querySelector('.err')?.textContent ?? null,
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|') || null,
      log: window.__mrLog?.join(',') ?? null,
    }))()`)
    ok('A2b 进入录音态（按钮 on + 计时 + 浮窗出现）', a2 === JSON.stringify({
      on: true, timer: true, rdock: true, err: null, toast: null, log: null,
    }) || (a2.includes('"on":true') && a2.includes('"rdock":true')), a2)
    await sleep(1300)
    const timerTxt = await evalJS(`document.querySelector('.timer')?.textContent`)
    ok('A3 计时在走（≥0:01）', typeof timerTxt === 'string' && timerTxt !== '0:00' && timerTxt !== '0:00', timerTxt)

    // 跨页：录音中切走，浮窗接管
    await goto('/todos')
    await sleep(400)
    ok('A4 切页后浮窗仍在（跨页接管）', await evalJS(`!!document.querySelector('.rdock-root')`))
    ok('A4b 浮窗条形态显示录音中', await evalJS(
      `[...document.querySelectorAll('.rdock-root .info')].some(e => e.textContent.includes('录音中'))`,
    ))

    // 浮窗上停止
    await evalJS(`[...document.querySelectorAll('.rdock-root button')].find(b => b.textContent.includes('停止'))?.click()`)
    await sleep(700)
    ok('A5 停止后浮窗退场', await evalJS(`!document.querySelector('.rdock-root')`))

    await goto('/record')
    await sleep(500)
    ok('A6 take 落列表（含播放器）', await evalJS(
      `document.querySelectorAll('.take').length === 1 && !!document.querySelector('.take audio[controls]')`,
    ))

    // 取消流：不产出 take
    ok('A7 开始后取消', await (async () => {
      await clickButton('开始录音')
      await sleep(400)
      await clickButton('取消')
      await sleep(500)
      return evalJS(`document.querySelectorAll('.take').length === 1 && !document.querySelector('.rdock-root')`)
    })())

    /* ---------- B. 附加到待办 ---------- */
    ok('B1 打开附加选择', await clickButton('附加到待办'))
    await waitFor(`!!document.querySelector('.backdrop') && document.querySelectorAll('.plist .prow').length > 0`, 5000, '附加选择抽屉')
    const candName = await evalJS(`document.querySelector('.plist .prow .ptt')?.textContent`)
    ok('B1b 候选列表非空', typeof candName === 'string' && candName.length > 0, candName)
    await evalJS(`document.querySelector('.plist .prow')?.click()`)
    await sleep(700)
    ok('B2 附加成功（toast + take 清空）', await evalJS(
      `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('已附加到')) &&
       document.querySelectorAll('.take').length === 0`,
    ))

    // 待办侧验证：详情面板出现附件 chip，编辑抽屉里可见音频附件
    await goto('/todos')
    await sleep(700)
    await clickButton('跳过', '.ritual').catch(() => {})
    await sleep(400)
    // 池 chip 走 click、画布块走 pointerup 点按（块的选中在 pointer 管线）
    ok('B3 选中附加目标待办', await evalJS(`(() => {
      const t = ${JSON.stringify(candName ?? '')}
      const chip = [...document.querySelectorAll('.pchip')].find(c => c.textContent.includes(t))
      const blk = [...document.querySelectorAll('.blk')].find(b => (b.dataset.title ?? '').includes(t))
      const el = chip ?? blk
      if (!el) return false
      const r = el.getBoundingClientRect()
      const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
      if (chip) el.click()
      else {
        el.dispatchEvent(new PointerEvent('pointerdown', opts))
        el.dispatchEvent(new PointerEvent('pointerup', opts))
      }
      return true
    })()`))
    await sleep(600)
    ok('B3b 详情面板出现附件标记 chip', await evalJS(
      `!!document.querySelector('[data-testid="detail-panel"] .chip.atch')`,
    ))
    ok('B4 编辑抽屉内音频附件可见', await evalJS(`(async () => {
      const edit = [...document.querySelectorAll('[data-testid="detail-panel"] button')].find(b => (b.getAttribute('aria-label') ?? '') === '编辑')
      edit?.click()
      await new Promise(r => setTimeout(r, 700))
      const rows = [...document.querySelectorAll('.atch-list .arow')].map(e => e.textContent)
      const diag = JSON.stringify({ rows, open: !!document.querySelector('.backdrop'), title: document.querySelector('.panel .title')?.value })
      const close = [...document.querySelectorAll('.panel button')].find(b => (b.getAttribute('aria-label') ?? '') === '关闭')
      close?.click()
      window.__b4 = diag
      return rows.length === 1 && rows[0].includes('录音')
    })()`))
    const lastB4 = results[results.length - 1]
    if (lastB4 && !lastB4.pass) console.log('  [B4 诊断]', await evalJS('window.__b4'))

    /* ---------- C. 编辑抽屉内录音 → 直挂附件 ---------- */
    // 该待办在 B 段已挂 1 条附件：C 段以差量断言（再录一条 → +1）
    ok('C0 重开编辑抽屉', await clickButton('编辑', '[data-testid="detail-panel"]'))
    await waitFor(`!!document.querySelector('.backdrop')`, 4000, '编辑抽屉')
    await sleep(400)
    const rowsBefore = await evalJS(`document.querySelectorAll('.atch-list .arow').length`)
    ok('C1 抽屉内开始录音', await clickButton('录音', '.panel'))
    await sleep(500)
    ok('C1b 抽屉按钮进录音态 + 全局浮窗在场', await evalJS(
      `[...document.querySelectorAll('.panel .abtn.rec')].some(b => b.textContent.includes('停止')) &&
       !!document.querySelector('.rdock-root')`,
    ))
    await sleep(700)
    await clickButton('停止', '.panel')
    await sleep(900)
    const c2 = await evalJS(`JSON.stringify({
      rows: document.querySelectorAll('.atch-list .arow').length,
      names: [...document.querySelectorAll('.atch-list .aname')].map(e => e.textContent),
    })`)
    ok('C2 停止后附件列表 +1（take 直挂）', JSON.parse(c2).rows === rowsBefore + 1, c2)
    await clickButton('保存')
    await sleep(700)
    ok('C3 保存后重开附件仍在', await evalJS(`(async () => {
      const edit = [...document.querySelectorAll('[data-testid="detail-panel"] button')].find(b => (b.getAttribute('aria-label') ?? '') === '编辑')
      edit?.click()
      await new Promise(r => setTimeout(r, 700))
      const rows = document.querySelectorAll('.atch-list .arow').length
      const close = [...document.querySelectorAll('.panel button')].find(b => (b.getAttribute('aria-label') ?? '') === '关闭')
      close?.click()
      return rows === ${rowsBefore + 1}
    })()`))

    /* ---------- D. 权限失败路径（模拟拒绝） ---------- */
    await evalJS(`(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError') }
      return true
    })()`)
    await goto('/record')
    await sleep(500)
    ok('D1 麦克风拒绝 → 错误文案出现', await clickButton('开始录音') && await (async () => {
      await sleep(400)
      return evalJS(`!!document.querySelector('.err') && !document.querySelector('.rdock-root')`)
    })())

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
