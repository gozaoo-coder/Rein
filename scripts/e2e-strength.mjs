/**
 * 重量标记功能专项 E2E（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：node scripts/e2e-strength.mjs（前置：npm run dev 已在 1420）
 *
 * 覆盖：力量进步卡曲线渲染 / 课程内激活热身流程 / 重量调节条与上次重量预填 /
 * 完成组登记 / 结束保存逐组落库（strength_history）/ 重量曲线更新 /
 * 运动详情抽屉热身芯片 / 动作详解抽屉重量曲线。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-profile-${Date.now()}`

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

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

let DEBUG_PORT = 9333

const results = []
let ws
let msgId = 0
const pending = new Map()

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

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const els = [...document.querySelectorAll('${scope} button, ${scope} [role="tab"]')]
    const el = els.find(b => b.textContent.includes(${JSON.stringify(text)}) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function injectStableCSS() {
  await evalJS(`(() => {
    let s = document.getElementById('__e2e-stable')
    if (!s) {
      s = document.createElement('style')
      s.id = '__e2e-stable'
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important }'
      document.head.appendChild(s)
    }
    return true
  })()`)
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
  await cdp('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1 }).catch(() => undefined)
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
  await injectStableCSS()
}

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/`)
    await cdp('Page.reload')
    await injectStableCSS()
    await sleep(1500)

    /* ---------- S1. 种子内容版本刷新：内置课带 warmups ---------- */
    const seedInfo = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const p = await invoke('get_workout_plan', { id: 'ppl-push' })
      const bench = p.exercises.find(e => e.id === 'ppl-push-bench')
      return {
        warmups: bench?.warmups ?? null,
        lateral: p.exercises.find(e => e.id === 'ppl-push-lateral')?.warmups ?? null,
      }
    })()`)
    ok('S1a 种子刷新：卧推含 ramp 热身 [30×8, 45×4]',
      JSON.stringify(seedInfo.warmups) === JSON.stringify([{ weightKg: 30, reps: 8 }, { weightKg: 45, reps: 4 }]),
      JSON.stringify(seedInfo.warmups))
    ok('S1b 小重量动作不配热身（侧平举 8kg）', seedInfo.lateral == null, JSON.stringify(seedInfo.lateral))

    /* ---------- S2. 运动页力量进步卡：演示数据曲线 ---------- */
    await evalJS(`location.hash = '#/sports'`)
    await sleep(900)
    ok('S2a 力量进步卡渲染（有演示记录才显示）', await evalJS(
      `[...document.querySelectorAll('.card h2')].some(h => h.textContent.includes('重量曲线'))`,
    ))
    // 默认选中 = 最近一次训练的动作（腿日演示在昨天 → 深蹲），此处显式切换到卧推
    await evalJS(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('重量曲线'))
      ;[...card.querySelectorAll('.chip')].find(c => c.textContent.includes('杠铃卧推'))?.click()
    })()`)
    await sleep(700)
    ok('S2b 切到卧推后曲线点数 = 4 次演示训练', await evalJS(
      `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('重量曲线'))
        if (!card) return false
        return card.querySelector('.chip.on')?.textContent.includes('杠铃卧推') &&
               card.querySelectorAll('svg circle').length === 4
      })()`,
    ))
    const legendBefore = await evalJS(
      `[...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('重量曲线'))?.querySelector('.legend')?.textContent ?? ''`,
    )
    ok('S2c 曲线摘要含次数与最新重量', legendBefore.includes('4 次训练') && legendBefore.includes('最新 62.5'), legendBefore)

    /* ---------- S3. 开始推日：进入激活热身阶段 ---------- */
    await evalJS(`(() => {
      const li = [...document.querySelectorAll('.card li')].find(l => l.querySelector('.name')?.textContent.includes('推日'))
      li?.querySelector('.play')?.click()
    })()`)
    // 训练课沉浸层不再走路由：以「.session-layer 可见」为进入判据（fixed 层 offsetParent 恒 null，勿用）
    await waitFor(
      `(() => { const el = document.querySelector('.session-layer'); return !!el && el.getClientRects().length > 0 })()`,
      8000,
      '进入沉浸页',
    )
    await sleep(1000)
    ok('S3a 首动作进入激活热身阶段', await evalJS(
      `[...document.querySelectorAll('.eyebrow')].some(e => e.textContent.includes('激活热身 · 第 1 / 2 组'))`,
    ))
    ok('S3b 热身清单展示小重量组', await evalJS(
      `(() => {
        const list = document.querySelector('.wlist')
        return !!list && list.textContent.includes('30 kg × 8') && list.textContent.includes('45 kg × 4')
      })()`,
    ))
    ok('S3c 热身坞有完成与跳过两键', await evalJS(
      `[...document.querySelectorAll('.dock button')].some(b => b.textContent.includes('完成热身组')) &&
       [...document.querySelectorAll('.dock button')].some(b => b.textContent.includes('跳过热身'))`,
    ))

    /* ---------- S4. 完成两组热身 → 进入正式组 ---------- */
    await clickButton('完成热身组')
    await sleep(600)
    ok('S4a 热身组间休息提示', await evalJS(
      `[...document.querySelectorAll('.eyebrow')].some(e => e.textContent.includes('热身组间'))`,
    ))
    await clickButton('跳过休息')
    await sleep(600)
    ok('S4b 回到热身第 2 组', await evalJS(
      `[...document.querySelectorAll('.eyebrow')].some(e => e.textContent.includes('激活热身 · 第 2 / 2 组'))`,
    ))
    await clickButton('完成热身组')
    await sleep(500)
    await clickButton('跳过休息')
    await sleep(2600) // 闪现 overlay 约阻塞 2s
    ok('S4c 热身完成进入第 1 正式组', await evalJS(
      `[...document.querySelectorAll('.eyebrow')].some(e => e.textContent.includes('当前动作 · 第 1 / 4 组'))`,
    ))

    /* ---------- S5. 重量调节条：上次重量预填 + ±2.5 + 参照 chips ---------- */
    ok('S5a 上次重量预填（演示数据最近一次 62.5）', await evalJS(
      `document.querySelector('.weightcard .wval b')?.textContent.trim() === '62.5'`,
    ))
    ok('S5b 上次/计划参照 chips 齐全', await evalJS(
      `(() => {
        const chips = [...document.querySelectorAll('.weightcard .wchip')].map(c => c.textContent)
        return chips.some(t => t.includes('上次 62.5kg × 8')) && chips.some(t => t.includes('计划 60kg'))
      })()`,
    ))
    // 动作库建议：平均状态（近 3 次 e1RM 基线）× 今日状态（恢复/容量/趋势/自评）
    ok('S5b2 今日建议 chip 与依据行齐全', await evalJS(
      `(() => {
        const chip = [...document.querySelectorAll('.weightcard .wchip.primary')].find(c => c.textContent.includes('建议'))
        const why = document.querySelector('.whyline')?.textContent ?? ''
        return !!chip && chip.textContent.includes('62.5kg') && why.includes('上次 62.5kg × 8')
      })()`,
    ))
    await evalJS(`[...document.querySelectorAll('.weightcard .wbtn')].find(b => b.textContent.includes('＋'))?.click()`)
    await sleep(300)
    ok('S5c ＋2.5kg 生效', await evalJS(
      `document.querySelector('.weightcard .wval b')?.textContent.trim() === '65'`,
    ))
    await evalJS(`[...document.querySelectorAll('.weightcard .wchip')].find(c => c.textContent.includes('计划'))?.click()`)
    await sleep(300)
    ok('S5d 点「计划」chip 回到 60kg', await evalJS(
      `document.querySelector('.weightcard .wval b')?.textContent.trim() === '60'`,
    ))
    await evalJS(`[...document.querySelectorAll('.weightcard .wchip')].find(c => c.textContent.includes('上次'))?.click()`)
    await sleep(300)
    ok('S5e 点「上次」chip 设回 62.5kg', await evalJS(
      `document.querySelector('.weightcard .wval b')?.textContent.trim() === '62.5'`,
    ))

    /* ---------- S6. 当前动作详解内嵌重量曲线（演示历史 4 次） ---------- */
    await evalJS(`document.querySelector('.dock .iconbtn[aria-label="更多功能"]')?.click()`)
    await sleep(500)
    await clickButton('当前动作详解')
    await sleep(900)
    ok('S6a 动作详解显示重量曲线区', await evalJS(
      `(() => {
        const panels = [...document.querySelectorAll('.panel')]
        return panels.some(p => p.textContent.includes('重量曲线') && p.querySelector('.curvebox svg'))
      })()`,
    ))
    await evalJS(`(() => {
      const panel = [...document.querySelectorAll('.panel')].find(p => p.querySelector('.curvebox'))
      panel?.querySelector('.close')?.click()
    })()`)
    await sleep(500)

    /* ---------- S7. 完成一组（登记 62.5kg）→ 结束并保存 ---------- */
    await clickButton('完成第 1 组', '.dock')
    await sleep(600)
    ok('S7a 顶栏组数 +1（不含热身）', await evalJS(
      `/^1\\//.test(document.querySelector('.shead .pcapsule .num')?.textContent.trim() ?? '')`,
    ))
    ok('S7b 休息页显示下一组重量', await evalJS(
      `(() => {
        const meta = document.querySelector('.pane .meta')
        return !!meta && meta.textContent.includes('62.5 kg')
      })()`,
    ))
    await clickButton('结束', '.shead')
    await sleep(500)
    await clickButton('结束并保存')
    await waitFor(`location.hash.includes('/sports')`, 8000, '保存后回运动页')
    await sleep(1200)

    /* ---------- S8. 逐组落库 + 曲线更新 + 详情抽屉 ---------- */
    const hist = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const today = new Date()
      const ds = \`\${today.getFullYear()}-\${String(today.getMonth() + 1).padStart(2, '0')}-\${String(today.getDate()).padStart(2, '0')}\`
      // 曲线按动作库 id 聚合（0025）；传动作名同样命中，两条路径都要能取到
      const rows = await invoke('strength_history', { exerciseId: 'barbell-bench-press' })
      const byName = await invoke('strength_history', { exerciseId: '杠铃卧推' })
      return { today: rows.filter(r => r.date === ds), total: rows.length, nameRows: byName.length }
    })()`)
    ok('S8a 今日逐组记录落库（2 热身 + 1 正式）',
      hist.today.length === 3 && hist.today.filter((r) => r.warmup).length === 2 &&
      hist.today.some((r) => !r.warmup && r.weightKg === 62.5 && r.setNo === 1),
      JSON.stringify(hist.today))
    ok('S8a2 按库 id 与按名查询结果一致（4 演示×5 + 今日 3 行）',
      hist.total === 23 && hist.nameRows === 23, `id=${hist.total} name=${hist.nameRows}`)

    ok('S8b 力量进步卡曲线点数 5（4 演示 + 今日）', await evalJS(
      `(() => {
        const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('重量曲线'))
        return card ? card.querySelectorAll('svg circle').length === 5 : false
      })()`,
    ))

    // 最近运动第一条 = 刚保存的推日 → 详情抽屉：热身芯片与正式组芯片区分
    // （只找「最近运动」卡：PlanRecentCard 的课程列表里也有 .item.name=推日，点它跳课程页）
    await evalJS(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('最近运动'))
      card?.querySelector('.item')?.click()
    })()`)
    await sleep(900)
    ok('S8c 详情抽屉热身芯片（热身 30kg × 8）', await evalJS(
      `(() => {
        const panels = [...document.querySelectorAll('.panel')]
        return panels.some(p => [...p.querySelectorAll('.chip.warm')].some(c => c.textContent.includes('热身 30kg × 8')))
      })()`,
    ))
    ok('S8d 详情抽屉正式组芯片 62.5kg × 8', await evalJS(
      `(() => {
        const panels = [...document.querySelectorAll('.panel')]
        return panels.some(p => [...p.querySelectorAll('.chip:not(.warm):not(.miss)')].some(c => c.textContent.includes('62.5kg × 8')))
      })()`,
    ))
    ok('S8e 完成组数不含热身（1/4 组）', await evalJS(
      `(() => {
        const panels = [...document.querySelectorAll('.panel')]
        return panels.some(p => [...p.querySelectorAll('.excount')].some(c => c.textContent.includes('1/4')))
      })()`,
    ))
    await evalJS(`(() => {
      const panel = [...document.querySelectorAll('.panel')].find(p => p.querySelector('.chips'))
      panel?.querySelector('.close')?.click()
    })()`)
    await sleep(400)

    /* ---------- S9. 恢复清理：无 active 会话残留 ---------- */
    ok('S9 保存后无 active 会话', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      return (await invoke('session_active')) === null
    })()`))

    /* ---------- 汇总 ---------- */
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) process.exit(1)
  } catch (e) {
    console.error('E2E 中断:', e.message)
    process.exit(1)
  } finally {
    edge.kill()
  }
}

main()
