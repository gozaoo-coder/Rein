/**
 * 待办编辑抽屉「时长步进器」端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-todo-duration.mjs   （前置：npm run dev；1420 被系统排除时
 *       REIN_E2E_URL=http://localhost:<port> 另起实例，9333 被排除时 E2E_CDP_PORT 换端口）
 *
 * 覆盖：无时长初态（减号禁用）→ ± 步进（空态起步 30 分钟）→ 点数字进入输入态 →
 *       输入提交格式化（90 → 1 小时 30 分）→ 越界钳制（2→5、3000→1440）→ Esc 取消 →
 *       清空提交 = 无时长 → 保存后清单视图重开回显 45 分钟。
 * 截帧：$TEMP/rein-e2e-duration/*.png
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9333)
/** 目标应用地址：默认 1420；端口被系统排除或并发会话时用 REIN_E2E_URL 指向独立实例（与 e2e-cdp 同约定） */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-dur-${Date.now()}`
const SHOT_DIR = `${process.env.TEMP}/rein-e2e-duration`

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const results = []
let ws
let msgId = 0
const pending = new Map()
let shotIdx = 0

function ok(name, pass, detail = '') {
  results.push({ name, pass })
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

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOT_DIR}/${String(++shotIdx).padStart(2, '0')}-${name}.png`, Buffer.from(r.data, 'base64'))
}

/** 点击包含指定文本（或 aria-label）的按钮 */
async function clickButton(text) {
  return evalJS(`(() => {
    const t = ${JSON.stringify(text)}
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent.includes(t) || (b.getAttribute('aria-label') ?? '').includes(t)) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function pressKey(key, code, vk) {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

/** 点中间数字进入输入态，等输入框聚焦后插入文本（覆盖 openDurationEdit 的 select() 全选） */
async function typeDuration(text) {
  const clicked = await evalJS(`(() => {
    const el = document.querySelector('.dval')
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!clicked) throw new Error('找不到 .dval')
  await waitFor(`document.activeElement === document.querySelector('.dinput')`, 3000, '时长输入框聚焦')
  if (text) await cdp('Input.insertText', { text })
  await sleep(80)
}

async function durText() {
  return evalJS(`document.querySelector('.dval')?.textContent.trim() ?? ''`)
}

/** 保存后 SmartAddSheet 仍开着：点最上层可见的「关闭」 */
async function closeTopSheet() {
  return evalJS(`(() => {
    const btns = [...document.querySelectorAll('[aria-label="关闭"]')].filter(b => b.getBoundingClientRect().width > 0)
    if (!btns.length) return false
    btns[btns.length - 1].click()
    return true
  })()`)
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
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
    // 预置：跳过每日规划仪式自动弹出（本地时区的 today key）
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const d = new Date();
        const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        localStorage.setItem('rein.ritual.' + today, '1');
        window.__errs = [];
        window.addEventListener('error', e => window.__errs.push(String(e.message)));
        window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));
      })()`,
    })
    await cdp('Page.navigate', { url: `${APP}/#/todos` })
    await waitFor(`document.querySelector('[aria-label="添加待办"]')`, 10000, '待办页加载')
    await sleep(800)

    /* ---------- 01 打开编辑抽屉 ---------- */
    await evalJS(`document.querySelector('[aria-label="添加待办"]').click()`)
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('手动填写待办') && b.getBoundingClientRect().width > 0)`, 5000, '智能添加抽屉')
    await clickButton('手动填写待办')
    await waitFor(`document.querySelector('.dval')`, 5000, '编辑抽屉时长步进器')

    /* ---------- 02 初态：无时长，减号禁用 ---------- */
    const t0 = await durText()
    ok('初态显示「无时长」', t0 === '无时长', `got="${t0}"`)
    const minusDisabled = await evalJS(`document.querySelector('[aria-label="减少 5 分钟"]').disabled`)
    ok('无时长时减号禁用', minusDisabled === true, `disabled=${minusDisabled}`)
    await shot('initial-null')

    /* ---------- 03 步进：空态 + 起步 30，之后 ±5 ---------- */
    await evalJS(`document.querySelector('[aria-label="增加 5 分钟"]').click()`)
    await sleep(120)
    const t1 = await durText()
    ok('无时长按 + 起步 30 分钟', t1 === '30 分钟', `got="${t1}"`)
    await evalJS(`document.querySelector('[aria-label="增加 5 分钟"]').click()`)
    await sleep(120)
    ok('+ 递增到 35 分钟', (await durText()) === '35 分钟')
    await evalJS(`document.querySelector('[aria-label="减少 5 分钟"]').click()`)
    await sleep(120)
    ok('- 回落到 30 分钟', (await durText()) === '30 分钟')
    await shot('stepped-30')

    /* ---------- 04 点数字输入：90 → 「1 小时 30 分」 ---------- */
    await typeDuration('90')
    await pressKey('Enter', 'Enter', 13)
    await sleep(120)
    const t2 = await durText()
    ok('输入 90 分钟显示「1 小时 30 分」', t2 === '1 小时 30 分', `got="${t2}"`)
    await shot('formatted-90')

    /* ---------- 05 越界钳制：下限 / 上限 ---------- */
    await typeDuration('2')
    await pressKey('Enter', 'Enter', 13)
    await sleep(120)
    ok('输入 2 钳制到下限 5 分钟', (await durText()) === '5 分钟')

    await typeDuration('3000')
    await pressKey('Enter', 'Enter', 13)
    await sleep(120)
    const t3 = await durText()
    ok('输入 3000 钳制到上限 24 小时', t3 === '24 小时', `got="${t3}"`)
    await shot('clamped-1440')

    /* ---------- 06 Esc 取消：不落值 ---------- */
    await typeDuration('77')
    await pressKey('Escape', 'Escape', 27)
    await sleep(120)
    ok('Esc 取消后保持 24 小时', (await durText()) === '24 小时')

    /* ---------- 07 清空提交 = 无时长 ---------- */
    await typeDuration('') // 点开输入态（草稿 1440 全选），不发文本
    await pressKey('Delete', 'Delete', 46)
    await evalJS(`document.querySelector('input[placeholder="要做什么？"]').focus()`)
    await sleep(120)
    const t4 = await durText()
    ok('清空输入提交回「无时长」', t4 === '无时长', `got="${t4}"`)
    await shot('cleared-null')

    /* ---------- 08 保存 → 清单视图重开回显 ---------- */
    await typeDuration('45')
    await pressKey('Enter', 'Enter', 13)
    await sleep(100)
    await evalJS(`document.querySelector('input[placeholder="要做什么？"]').focus()`)
    await cdp('Input.insertText', { text: '时长步进测试' })
    await sleep(100)
    await clickButton('保存')
    await waitFor(`!document.querySelector('.dval')`, 5000, '编辑抽屉关闭')
    await closeTopSheet()
    await sleep(300)
    await evalJS(`document.querySelector('[data-testid="seg-list"]').click()`)
    await waitFor(`[...document.querySelectorAll('li.item .title')].some(p => p.textContent.includes('时长步进测试'))`, 5000, '清单里出现新待办')
    await evalJS(`(() => {
      const li = [...document.querySelectorAll('li.item')].find(l => l.textContent.includes('时长步进测试'))
      li.querySelector('[aria-label="编辑待办"]').click()
    })()`)
    await waitFor(`document.querySelector('.dval')`, 5000, '重开编辑抽屉')
    await sleep(200)
    const t5 = await durText()
    ok('保存 45 分钟后重开回显', t5 === '45 分钟', `got="${t5}"`)
    await shot('reopened-45')

    /* ---------- 汇总 ---------- */
    const errs = await evalJS('window.__errs')
    ok('无运行时报错', Array.isArray(errs) && errs.length === 0, (errs ?? []).join('; '))
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${failed ? `✗ ${failed} 项失败` : '✓ 全部通过'}（${results.length} 项）— 截帧: ${SHOT_DIR}`)
    if (failed) process.exitCode = 1
  } finally {
    ws?.close()
    edge.kill()
  }
}

main().catch((e) => {
  console.error('E2E 异常:', e.message)
  process.exitCode = 1
})
