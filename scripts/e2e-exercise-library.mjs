/**
 * 动作库专项 E2E（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：node scripts/e2e-exercise-library.mjs（前置：npm run dev 已在 1420）
 *
 * 覆盖：动作库页浏览/搜索/分类 → 动作详情（肌群图 / 重量曲线 / 今日建议）→
 * 自建动作新建与编辑 → 内置动作只读（可隐藏/恢复）→ 课程编辑用库内动作 →
 * 沉浸页今日建议 chip 与自评 chips → 运动页本周容量卡 → 命令契约（按库 id 聚合）。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-lib-${Date.now()}`

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

let DEBUG_PORT = 9334

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
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
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

/** 抽屉/弹层里某个面板的可见文本 */
const PANEL_TEXT = `[...document.querySelectorAll('.panel')].map(p => p.textContent).join(' | ')`

/** 动作库列表里按「准确名称」找行（避免「杠铃卧推」被「上斜杠铃卧推」子串命中） */
function rowNamed(name) {
  return `[...document.querySelectorAll('.exrow')].find(r => {
    const t = r.querySelector('.ename')?.textContent ?? ''
    return t.replace(/自建|已隐藏/g, '').trim() === ${JSON.stringify(name)}
  })`
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
    await connect(`${APP}/#/sports/exercises`)
    await cdp('Page.reload')
    await injectStableCSS()
    await sleep(1800)

    /* ---------- L1. 命令契约：动作库按种子上架 + 曲线按库 id 聚合 ---------- */
    const contract = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const lib = await invoke('list_exercises', {})
      const bench = lib.find(e => e.id === 'barbell-bench-press')
      const hist = await invoke('strength_history', { exerciseId: 'barbell-bench-press' })
      const byName = await invoke('strength_history', { exerciseId: '杠铃卧推' })
      const refs = await invoke('strength_exercises')
      const recent = await invoke('strength_recent_sets', { days: 42 })
      const plan = await invoke('get_workout_plan', { id: 'ppl-push' })
      const benchItem = plan.exercises.find(e => e.id === 'ppl-push-bench')
      return {
        count: lib.length,
        benchName: bench?.name ?? null,
        benchMuscles: bench?.muscles ?? null,
        histRows: hist.length,
        histSameAsName: byName.length === hist.length,
        benchRef: refs.find(r => r.exerciseId === 'barbell-bench-press') ?? null,
        recentRows: recent.length,
        planExerciseId: benchItem?.exerciseId ?? null,
        legacyUnlinked: lib.filter(e => e.isCustom && e.name.includes('卧推')).map(e => e.name),
      }
    })()`)
    ok('L1a 内置动作库已上架（60 条）', contract.count === 60, String(contract.count))
    ok(
      'L1b 内置动作带显式肌群表（含胸大肌上/下束细分）',
      contract.benchMuscles?.['chest-low'] === 3 && contract.benchMuscles?.['chest-up'] === 2,
      JSON.stringify(contract.benchMuscles),
    )
    ok('L1c 重量曲线按库 id 聚合（4 次演示 × 5 行 = 20）', contract.histRows === 20, String(contract.histRows))
    ok('L1d 传动作名也能命中同一曲线（兼容旧调用）', contract.histSameAsName === true)
    ok('L1e 曲线动作清单带 exerciseId', contract.benchRef?.sessions === 4, JSON.stringify(contract.benchRef))
    ok('L1f 内置课程条目已挂库 id', contract.planExerciseId === 'barbell-bench-press', String(contract.planExerciseId))
    ok('L1g 未产生重复的自建卧推', contract.legacyUnlinked.length === 0, JSON.stringify(contract.legacyUnlinked))
    ok('L1h 近 42 天记录一次取回（建议引擎原料）', contract.recentRows >= 20, String(contract.recentRows))

    /* ---------- L2. 动作库页：列表 / 分类 / 搜索 ---------- */
    ok('L2a 动作库页渲染列表', await evalJS(
      `[...document.querySelectorAll('.exrow')].some(r => r.textContent.includes('杠铃卧推'))`,
    ))
    ok('L2b 副标题显示数量与来源', await evalJS(
      `document.querySelector('.pagehead')?.textContent.includes('个动作') || document.body.textContent.includes('课程的唯一动作来源')`,
    ))
    await evalJS(`(() => {
      const chips = [...document.querySelectorAll('.chips .chip')]
      chips.find(c => c.textContent.trim() === '腿')?.click()
    })()`)
    await sleep(400)
    ok('L2c 分类筛选（腿）只留腿部动作', await evalJS(
      `(() => {
        const rows = [...document.querySelectorAll('.exrow')].map(r => r.textContent)
        return rows.length > 0 && rows.some(t => t.includes('杠铃深蹲')) && !rows.some(t => t.includes('杠铃卧推'))
      })()`,
    ))
    await evalJS(`[...document.querySelectorAll('.chips .chip')].find(c => c.textContent.trim() === '全部')?.click()`)
    await sleep(300)
    await evalJS(`(() => {
      const input = document.querySelector('.search')
      input.value = '卧推'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(400)
    ok('L2d 搜索「卧推」命中别名/名称', await evalJS(
      `(() => {
        const rows = [...document.querySelectorAll('.exrow')].map(r => r.textContent)
        return rows.some(t => t.includes('杠铃卧推')) && !rows.some(t => t.includes('杠铃深蹲'))
      })()`,
    ))
    await evalJS(`(() => {
      const input = document.querySelector('.search')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(300)

    /* ---------- L3. 动作详情：肌群图 / 重量曲线 / 今日建议 ---------- */
    await evalJS(`(${rowNamed('杠铃卧推')})?.click()`)
    await sleep(900)
    const detailText = await evalJS(PANEL_TEXT)
    ok('L3a 详情含激活肌群与训练参数', detailText.includes('激活肌群') && detailText.includes('默认组数'))
    ok('L3b 详情含重量曲线（演示 4 次）', await evalJS(
      `[...document.querySelectorAll('.panel')].some(p => p.querySelector('.curvebox svg') && p.textContent.includes('重量曲线'))`,
    ))
    ok('L3c 详情含今日建议（按历史推算）', await evalJS(
      `(() => {
        const panels = [...document.querySelectorAll('.panel')]
        return panels.some(p => p.querySelector('.adviceline')?.textContent.includes('建议') )
      })()`,
    ))
    ok('L3d 内置动作只读：无编辑按钮，只有隐藏', await evalJS(
      `(() => {
        const panel = [...document.querySelectorAll('.panel')].find(p => p.querySelector('.adviceline'))
        const ops = panel ? [...panel.querySelectorAll('.op')].map(b => b.textContent.trim()) : []
        return ops.includes('从库中隐藏') && !ops.includes('编辑动作')
      })()`,
    ))

    /* ---------- L4. 隐藏内置动作 → 列表消失 → 显示已隐藏可恢复 ---------- */
    await clickButton('从库中隐藏')
    await sleep(1000)
    ok('L4a 隐藏后从列表消失', await evalJS(`!(${rowNamed('杠铃卧推')})`))
    ok('L4b 出现「显示已隐藏」开关', await evalJS(
      `document.body.textContent.includes('显示已隐藏的动作')`,
    ))
    await evalJS(`(() => {
      const sw = document.querySelector('.hiddenrow .sw') || document.querySelector('.hiddenrow [role="switch"]')
      sw?.click()
    })()`)
    await sleep(700)
    ok('L4c 打开后可见且带「已隐藏」标记', await evalJS(
      `(() => { const row = ${rowNamed('杠铃卧推')}; return !!row && row.textContent.includes('已隐藏') })()`,
    ))
    await evalJS(`(${rowNamed('杠铃卧推')})?.click()`)
    await sleep(800)
    ok('L4d 隐藏态提供恢复入口', await evalJS(`${PANEL_TEXT}.includes('恢复显示')`))
    await clickButton('恢复显示')
    await sleep(1000)
    ok('L4e 恢复显示后回到列表', await evalJS(`(() => { const row = ${rowNamed('杠铃卧推')}; return !!row && !row.textContent.includes('已隐藏') })()`))

    /* ---------- L5. 新建 / 编辑自建动作 ---------- */
    await clickButton('新建自定义动作')
    await sleep(600)
    await evalJS(`(() => {
      const input = [...document.querySelectorAll('.panel input')].find(i => i.placeholder?.includes('反向飞鸟'))
      input.value = '弹力带划船'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await clickButton('创建动作')
    await sleep(1100)
    ok('L5a 自建动作创建成功（列表出现 + 自建标记）', await evalJS(
      `(() => {
        const row = [...document.querySelectorAll('.exrow')].find(r => r.textContent.includes('弹力带划船'))
        return !!row && row.textContent.includes('自建')
      })()`,
    ))
    ok('L5b 库里只有一条同名动作（同名查重）', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const lib = await invoke('list_exercises', { includeHidden: true })
      return lib.filter(e => e.name === '弹力带划船').length === 1
    })()`))
    // 详情里编辑自建动作：默认组数 3 → 5（NumberStepper 是 ± 按钮，不是输入框）
    await evalJS(`(${rowNamed('弹力带划船')})?.click()`)
    await sleep(800)
    await clickButton('编辑动作')
    await sleep(700)
    await evalJS(`(() => {
      const row = [...document.querySelectorAll('.stepper')].find(s => s.textContent.includes('默认组数'))
      row?.querySelector('button[aria-label="增加"]')?.click()
    })()`)
    await sleep(250)
    await evalJS(`(() => {
      const row = [...document.querySelectorAll('.stepper')].find(s => s.textContent.includes('默认组数'))
      row?.querySelector('button[aria-label="增加"]')?.click()
    })()`)
    await sleep(400)
    await clickButton('保存修改')
    await sleep(1100)
    ok('L5c 自建动作可编辑并落库', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const lib = await invoke('list_exercises', { includeHidden: true })
      return lib.find(e => e.name === '弹力带划船')?.defaultSets === 5
    })()`))

    /* ---------- L6. 课程编辑：从动作库选择动作 ---------- */
    await evalJS(`location.hash = '#/sports/plans/new/edit'`)
    await sleep(1200)
    await evalJS(`(() => {
      const input = [...document.querySelectorAll('input')].find(i => i.placeholder?.includes('推力日'))
      input.value = 'E2E 课程'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await clickButton('点击从动作库选择')
    await sleep(900)
    ok('L6a 选择器弹层打开（含分类 chips 与搜索结果）', await evalJS(
      `${PANEL_TEXT}.includes('从动作库选择') && document.querySelectorAll('.panel .chip').length > 3`,
    ))
    await waitFor(`[...document.querySelectorAll('.panel .rowitem')].some(r => r.textContent.includes('杠铃深蹲'))`, 6000, '选择器列出杠铃深蹲')
    await evalJS(`(() => {
      ;[...document.querySelectorAll('.panel .rowitem')].find(r => r.textContent.includes('杠铃深蹲'))?.click()
    })()`)
    await sleep(800)
    ok('L6b 选择后展示库内名称与肌群', await evalJS(
      `(() => {
        const btn = document.querySelector('.expick')
        return !!btn && btn.textContent.includes('杠铃深蹲') && btn.textContent.includes('腿')
      })()`,
    ))
    await clickButton('创建课程')
    await waitFor(`location.hash.includes('/sports/plans/')`, 8000, '保存后跳课程详情')
    await sleep(1000)
    const savedPlan = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const plans = await invoke('list_workout_plans')
      const p = plans.find(x => x.name === 'E2E 课程')
      return p ? { id: p.id, exerciseId: p.exercises[0]?.exerciseId ?? null, name: p.exercises[0]?.name ?? null } : null
    })()`)
    ok('L6c 课程条目落库带动作库 id', savedPlan?.exerciseId === 'barbell-squat', JSON.stringify(savedPlan))
    ok('L6d 课程详情显示库内动作名', await evalJS(`document.body.textContent.includes('杠铃深蹲')`))

    /* ---------- L7. 沉浸页：今日建议 chip + 自评 chips ---------- */
    await evalJS(`location.hash = '#/sports'`)
    await sleep(1200)
    await evalJS(`(() => {
      const li = [...document.querySelectorAll('.card li')].find(l => l.querySelector('.name')?.textContent.includes('推日'))
      li?.querySelector('.play')?.click()
    })()`)
    await waitFor(`(() => { const el = document.querySelector('.session-layer'); return !!el && el.getClientRects().length > 0 })()`, 8000, '进入沉浸页')
    await sleep(1200)
    ok('L7a 首次进入有今日状态自评 chips', await evalJS(
      `[...document.querySelectorAll('.readiness .rchip')].map(b => b.textContent.trim()).join(',') === '很好,不错,一般,疲惫,很差'`,
    ))
    await clickButton('一般', '.readiness')
    await sleep(800)
    ok('L7b 自评后提示消失', await evalJS(`document.querySelectorAll('.readiness').length === 0`))
    ok('L7c 自评写入快照', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      const rec = await invoke('session_active')
      return rec?.state?.readiness === 3
    })()`))
    // 跳到正式组：完成两组热身
    await clickButton('跳过热身')
    await sleep(2600)
    ok('L7d 正式组出现「建议」chip 且预填 = 建议值', await evalJS(`(() => {
      const chip = [...document.querySelectorAll('.weightcard .wchip.primary')]
        .find(c => c.textContent.includes('建议'))
      if (!chip) return false
      const v = document.querySelector('.weightcard .wval b')?.textContent.trim()
      const suggested = chip.textContent.replace('建议', '').replace('kg', '').trim()
      return !!v && v === suggested
    })()`))
    ok('L7e 建议依据行可展开（平均状态 × 今日状态）', await evalJS(`(() => {
      document.querySelector('.whyline')?.click()
      return true
    })()`))
    await sleep(400)
    ok('L7e-b 依据逐条列出', await evalJS(`(() => {
      const items = [...document.querySelectorAll('.whylist li')].map(li => li.textContent)
      return items.length >= 2 && items.some(t => t.includes('今日状态')) && items.some(t => t.includes('建议'))
    })()`))
    // 收尾：放弃本次训练，避免污染后续断言
    await evalJS(`document.querySelector('.shead .end')?.click()`)
    await sleep(500)
    await clickButton('放弃本次训练')
    await sleep(900)
    ok('L7f 放弃后无 active 会话', await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      return (await invoke('session_active')) === null
    })()`))

    /* ---------- L8. 运动页本周容量卡 ---------- */
    await evalJS(`location.hash = '#/sports'`)
    await sleep(1400)
    const volume = await evalJS(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('本周容量'))
      if (!card) return null
      return {
        rows: [...card.querySelectorAll('.vrow')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
        foot: card.querySelector('.foot')?.textContent ?? '',
      }
    })()`)
    ok('L8a 本周容量卡渲染肌群行', !!volume && volume.rows.length > 0, JSON.stringify(volume?.rows?.slice(0, 3)))
    ok('L8b 容量行含「已完成/建议」组数', !!volume && /\d+(\.\d+)?\/\d+/.test(volume.rows[0] ?? ''), volume?.rows?.[0])
    ok('L8c 脚注写明折算与依据', !!volume && volume.foot.includes('辅助') && volume.foot.includes('组/周'))

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
