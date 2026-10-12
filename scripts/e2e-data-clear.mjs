/**
 * 清除软件数据端到端（/settings → DataClearSheet）：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-data-clear.mjs
 * 前置：npm run dev（默认 1420；端口被排除或并发会话时用 REIN_E2E_URL 指向独立实例）
 *
 * 覆盖这条链路：设置页「数据」组入口 → 抽屉四档选择 → 每档的真实统计清单（条数/字节）
 * → 警示语 → 长按 1.5 秒确认（含「提前松手=取消」的反例）→ 完成页报告。
 * 守住三条回归：确认按钮不点满时长绝不执行（双击/误触都过不去）、档位互不包含
 * （业务档清单里不许出现 AI 配置类目）、缓存档不触发重启提示而深层档必须提示。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内，可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9338)
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-dataclear-${Date.now()}`
const SHOT_DIR = process.env.TEMP ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

async function waitFor(expr, timeoutMs = 9000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch { /* 上下文销毁（HMR）时重试 */ }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (!r?.data) return null
  const file = `${SHOT_DIR}/rein-dataclear-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
  return file
}

/** 直接派发 PointerEvent 驱动长按：按住 holdMs 毫秒再松开 */
async function hold(holdMs) {
  await evalJS(`(() => {
    const b = document.querySelector('[data-testid="data-clear-hold"]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
    return true
  })()`)
  await sleep(holdMs)
  await evalJS(`(() => {
    const b = document.querySelector('[data-testid="data-clear-hold"]')
    b?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
    return true
  })()`)
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,932',
    'about:blank',
  ])
  await sleep(1800)

  try {
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

    await cdp('Page.navigate', { url: APP })
    await waitFor("document.readyState === 'complete'", 15000, '应用加载')
    await sleep(1200)

    /* ---------- 服务层契约（mock 形状） ---------- */
    const svc = await evalJS(`(async () => {
      const { maintenanceService } = await import('/src/services/maintenanceService.ts')
      const p = await maintenanceService.preview('ai')
      const r = await maintenanceService.clear('cache')
      return { restarts: p.restartsApp, n: p.items.length, freed: r.freedBytes > 0 }
    })()`)
    ok('service：ai 档预览要重启', svc?.restarts === true)
    ok('service：ai 档清单 4 组', svc?.n === 4, String(svc?.n))
    ok('service：清除报告带释放字节', svc?.freed === true)

    /* ---------- 入口与抽屉 ---------- */
    await evalJS("location.hash = '#/settings'")
    await waitFor(`document.querySelector('[data-testid="settings-data-clear"]')`, 8000, '设置页入口行')
    await evalJS(`document.querySelector('[data-testid="settings-data-clear"]').click()`)
    await waitFor(`document.querySelector('[data-testid="data-clear-scope-cache"]')`, 8000, '抽屉四档')
    ok('抽屉：四个档位都在', await evalJS(`['cache','ai','business','factory'].every((s) =>
      Boolean(document.querySelector('[data-testid="data-clear-scope-' + s + '"]')))`))

    /* ---------- 档位互不包含（mock 清单断言） ---------- */
    await evalJS(`document.querySelector('[data-testid="data-clear-scope-business"]').click()`)
    await evalJS(`document.querySelector('[data-testid="data-clear-continue"]').click()`)
    await waitFor(`document.querySelector('[data-testid^="data-clear-item-"]')`, 8000, '业务档清单')
    const bizLabels = await evalJS(`[...document.querySelectorAll('[data-testid^="data-clear-item-"] > span:first-child')]
      .map((el) => el.textContent.trim())`)
    ok('业务档：清单里没有 AI 配置类目', !bizLabels.some((l) => l.includes('密钥') || l.includes('工作区')),
      bizLabels.join(' / '))
    ok('业务档：警示块在', Boolean(await evalJS(`document.querySelector('.warn')`)))
    await shot('business-confirm')

    /* ---------- 长按反例：提前松手 = 取消 ---------- */
    await hold(400)
    await sleep(300)
    ok('长按 400ms 松手：不清除（仍在确认页）', Boolean(await evalJS(
      `document.querySelector('[data-testid="data-clear-hold"]') && document.querySelector('[data-testid^="data-clear-item-"]')`)))

    /* ---------- 长按反例 2：重选档位清单要跟着换 ---------- */
    await evalJS(`document.querySelector('[data-testid="data-clear-back"]').click()`)
    await waitFor(`document.querySelector('[data-testid="data-clear-scope-factory"]')`, 8000, '回到选档')
    await evalJS(`document.querySelector('[data-testid="data-clear-scope-factory"]').click()`)
    await evalJS(`document.querySelector('[data-testid="data-clear-continue"]').click()`)
    await waitFor(`[...document.querySelectorAll('[data-testid^="data-clear-item-"]')].length >= 8`, 8000, 'factory 清单')
    const facN = await evalJS(`[...document.querySelectorAll('[data-testid^="data-clear-item-"]')].length`)
    ok('恢复出厂：清单 8 组（含密钥与工作区）', facN === 8, String(facN))

    /* ---------- 长按正例：按满 1.7 秒执行 ---------- */
    await hold(1700)
    await waitFor(`document.querySelector('[data-testid="data-clear-restarting"]')`, 8000, '重启提示')
    ok('恢复出厂：完成页提示自动重启', true)
    await shot('factory-done')

    /* ---------- 缓存档：完成页是「完成」不是重启 ---------- */
    // factory 的完成页没有「完成」按钮（等重启）——先关抽屉再重开
    await sleep(2200)
    await evalJS(`document.querySelector('.panel .head .close')?.click()`)
    await sleep(500)
    await evalJS(`document.querySelector('[data-testid="settings-data-clear"]').click()`)
    await waitFor(`document.querySelector('[data-testid="data-clear-scope-cache"]')`, 8000, '重开抽屉')
    await evalJS(`document.querySelector('[data-testid="data-clear-scope-cache"]').click()`)
    await evalJS(`document.querySelector('[data-testid="data-clear-continue"]').click()`)
    await waitFor(`document.querySelector('[data-testid^="data-clear-item-"]')`, 8000, '缓存档清单')
    const cacheHasNoCount = await evalJS(
      `[...document.querySelectorAll('[data-testid^="data-clear-item-"]')].every(
        (el) => !el.textContent.includes('条'))`)
    ok('缓存档：清单只报字节不报条数（纯磁盘档）', cacheHasNoCount === true)
    await hold(1700)
    await waitFor(`document.querySelector('[data-testid="data-clear-done"]')`, 8000, '缓存完成按钮')
    ok('缓存档：完成页是「完成」按钮，无重启提示', !await evalJS(
      `Boolean(document.querySelector('[data-testid="data-clear-restarting"]'))`))
    await shot('cache-done')
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    edge.kill()
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('运行失败：', e)
    process.exit(1)
  })
