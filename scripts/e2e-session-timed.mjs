/**
 * 计时动作多组流程专项 E2E（无头 Edge + 原生 CDP，浏览器 mock 模式）。
 * 运行：node scripts/e2e-session-timed.mjs（前置：npm run dev 已在 1420）
 *
 * 为什么单独一条：计时动作（开合跳/平板支撑这类多组动作）在「组间休息结束后」
 * 曾掉回力量做组态——第 2 组起界面变成重量×次数的做组卡，计时器再也起不来，
 * 点「完成」还会写出一条没有秒数的空记录。这里把整条计时链路钉住：
 * 准备 → 3·2·1 → 计时 → 完成/跳过 → 休息 → 下一组仍回准备页，
 * 逐组登记的是秒数而不是空行；另外「接下来」的处方按类型取单位、
 * 加练后准备页组数跟着走，旧快照的阶段按动作类型归一。
 *
 * 用课程：居家燃脂间歇（home-hiit）——首个动作即计时（开合跳 4×40s，组间 20s），
 * 其后是力量动作（波比跳），正好验证跨类型切换。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-timed-${Date.now()}`

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
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 异步条件（evalJS 里 await 一个 Promise）——waitFor 的 Boolean(Promise) 恒真，不能复用 */
async function waitAsync(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`(async () => Boolean(await (${expr})))()`)
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

async function dockButtons() {
  return evalJS(`[...document.querySelectorAll('.ctrl-dock button')].map(b => b.textContent.trim())`)
}

async function paneEyebrow() {
  return evalJS(`document.querySelector('.pane .eyebrow')?.textContent.trim() ?? ''`)
}

/** 准备页的「目标 …」行（去空白后比对，避免模板缝隙里的换行干扰） */
async function paneMeta() {
  return evalJS(`(document.querySelector('.pane .meta')?.textContent ?? '').replace(/\\s+/g, '')`)
}

/** 顶栏「n/N 组」 */
async function topCounter() {
  return evalJS(`(document.querySelector('.ctrl-top .pcapsule .num')?.textContent ?? '').trim()`)
}

/** 计时秒表读数（mm:ss.d）→ 秒 */
async function timerSeconds() {
  const t = await evalJS(`document.querySelector('.pane .timernum')?.textContent?.trim() ?? ''`)
  const m = /^(\d+):(\d{2})\.(\d)$/.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 : NaN
}

/** 只读会话 store：断言阶段与组序时以状态机为准，DOM 断言语义（文案/按钮） */
async function storeState() {
  return evalJS(`(async () => {
    const { useSessionStore } = await import('/src/stores/session.ts')
    const s = useSessionStore()
    return {
      phase: s.phase,
      exIndex: s.exIndex,
      setIndex: s.setIndex,
      exName: s.currentEx?.name ?? null,
      exKind: s.currentEx?.kind ?? null,
      effSets: s.currentEx ? s.effSets(s.currentEx) : 0,
      doneCount: s.doneCount,
      totalCount: s.totalCount,
    }
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

async function main() {
  DEBUG_PORT = await freePort()
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,900', 'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/sports/plans/home-hiit`)
    await cdp('Page.reload')
    await injectStableCSS()
    await sleep(2200)

    /* ---------- S1. 课程详情页开课，首个动作即进入计时准备 ---------- */
    await waitFor(
      `[...document.querySelectorAll('button.start')].some(b => b.textContent.includes('开始「居家燃脂间歇」'))`,
      15000,
      '课程详情页就绪',
    )
    ok('S1a 课程详情页就绪（开始按钮）', true)
    await clickButton('开始「居家燃脂间歇」')
    await waitFor(
      `[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('计时动作'))`,
      10000,
      '进入计时准备页',
    )
    let st = await storeState()
    ok('S1b 首动作 = 开合跳（timed），准备页阶段正确', st.phase === 'timed-ready' && st.exKind === 'timed' && st.exName === '开合跳', JSON.stringify(st))
    ok('S1c 准备页文案：计时动作 + 目标 40s × 4 组', (await paneMeta()).includes('目标40s×4组·组间休息20s'), await paneMeta())
    ok('S1d 准备坞主按钮 = 我准备好了', (await dockButtons()).some((b) => b.includes('我准备好了')), JSON.stringify(await dockButtons()))

    /* ---------- S2. 加练一组 → 准备页组数跟走（effSets） ---------- */
    await evalJS(`document.querySelector('.ctrl-dock .iconbtn[aria-label="更多功能"]')?.click()`)
    await sleep(400)
    await clickButton('再加一组')
    await sleep(500)
    ok('S2a 加练后准备页显示 5 组', (await paneMeta()).includes('目标40s×5组'), await paneMeta())
    ok('S2b 顶栏分母 = 19 组（18 + 加练 1）', (await topCounter()).startsWith('0/19'), await topCounter())

    /* ---------- S3. 我准备好了 → 3·2·1 → 计时中 ---------- */
    await clickButton('我准备好了')
    await sleep(600)
    ok('S3a 倒数覆盖层出现', await evalJS(`/^(3|2|1|GO!)$/.test((document.querySelector('.overlay .big')?.textContent ?? '').trim())`))
    await waitFor(`document.querySelector('.pane .timernum')`, 9000, '计时中界面')
    await sleep(400)
    ok('S3b 计时中：秒表 + 目标 00:40 + 完成/放弃', await evalJS(
      `(document.querySelector('.pane .hint')?.textContent ?? '').includes('目标 00:40')`,
    ) && (await dockButtons()).some((b) => b.includes('完成')) && (await dockButtons()).some((b) => b.includes('放弃')), JSON.stringify(await dockButtons()))
    const t1 = await timerSeconds()
    await sleep(1300)
    const t2 = await timerSeconds()
    ok('S3c 秒表在走（墙钟锚定）', Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1, `${t1} → ${t2}`)

    /* ---------- S4. 完成第 1 组 → 休息 → 第 2 组必须回准备页（本次修复的核心） ---------- */
    await clickButton('完成', '.ctrl-dock')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('组间休息'))`, 5000, '组间休息')
    ok('S4a 完成后进入组间休息（1/19）', (await topCounter()).startsWith('1/19'), await topCounter())
    ok('S4b 休息坞 = 跳过休息', (await dockButtons()).some((b) => b.includes('跳过休息')), JSON.stringify(await dockButtons()))
    await clickButton('跳过休息')
    await sleep(700)
    st = await storeState()
    ok('S4c 第 2 组回到计时准备（不是力量做组态）', st.phase === 'timed-ready' && st.setIndex === 2, JSON.stringify(st))
    ok('S4d 第 2 组界面为计时准备页', (await paneEyebrow()).includes('计时动作'), await paneEyebrow())
    ok('S4e 第 2 组坞内没有「完成第 2 组」', !(await dockButtons()).some((b) => b.includes('完成第 2 组')), JSON.stringify(await dockButtons()))

    /* ---------- S5. 第 2 组跑完 → 第 3 组同样回准备页 ---------- */
    await clickButton('我准备好了')
    await waitFor(`document.querySelector('.pane .timernum')`, 9000, '第 2 组计时')
    await sleep(600)
    await clickButton('完成', '.ctrl-dock')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('组间休息'))`, 5000, '第 2 组后休息')
    await clickButton('跳过休息')
    await sleep(700)
    st = await storeState()
    ok('S5a 第 3 组回到计时准备', st.phase === 'timed-ready' && st.setIndex === 3, JSON.stringify(st))
    ok('S5b 完成两组：2/19', (await topCounter()).startsWith('2/19'), await topCounter())

    /* ---------- S6. 跳过路径：跳过第 3 组 → 第 4 组仍回准备页 ---------- */
    await evalJS(`document.querySelector('.ctrl-dock .iconbtn[aria-label="更多功能"]')?.click()`)
    await sleep(400)
    await clickButton('跳过当前组')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('组间休息'))`, 5000, '跳过后休息')
    await clickButton('跳过休息')
    await sleep(700)
    st = await storeState()
    ok('S6a 跳过后第 4 组回计时准备', st.phase === 'timed-ready' && st.setIndex === 4, JSON.stringify(st))
    ok('S6b 跳过不计入完成（2/19）', (await topCounter()).startsWith('2/19'), await topCounter())

    /* ---------- S7. 跳过第 4 组 → 加练的第 5 组（最后一组）---------- */
    await evalJS(`document.querySelector('.ctrl-dock .iconbtn[aria-label="更多功能"]')?.click()`)
    await sleep(400)
    await clickButton('跳过当前组')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('组间休息'))`, 5000, '跳过后休息')
    await clickButton('跳过休息')
    await sleep(700)
    st = await storeState()
    ok('S7 到达最后一组（第 5 组，计时准备）', st.phase === 'timed-ready' && st.setIndex === 5 && st.effSets === 5, JSON.stringify(st))

    /* ---------- S8. 最后一组跑完 → 跨动作切到力量动作（波比跳） ---------- */
    await clickButton('我准备好了')
    await waitFor(`document.querySelector('.pane .timernum')`, 9000, '第 5 组计时')
    await sleep(600)
    await clickButton('完成', '.ctrl-dock')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('组间休息'))`, 5000, '换动作前休息')
    ok('S8a 换动作前休息按下限 45s', (await evalJS(`document.querySelector('.pane .restnum')?.textContent?.trim() ?? ''`)) === '45', await evalJS(`document.querySelector('.pane .restnum')?.textContent?.trim() ?? ''`))
    await clickButton('开始下一动作')
    await waitFor(`[...document.querySelectorAll('.pane .eyebrow')].some(e => e.textContent.includes('当前动作 · 第 1 / 4 组'))`, 6000, '波比跳做组页')
    st = await storeState()
    ok('S8b 下一动作 = 波比跳（strength）做组态', st.phase === 'exercise' && st.exKind === 'strength' && st.exName === '波比跳', JSON.stringify(st))
    const nextDesc = await evalJS(`(() => {
      const card = [...document.querySelectorAll('.blockcard')].find(b => b.querySelector('h3')?.textContent.includes('接下来'))
      return card?.querySelector('.nextrow')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
    })()`)
    ok('S8c 「接下来」按类型取单位：高抬腿 4 组 · 30 秒（不是 10 次）',
      nextDesc.includes('4 组 · 30 秒') && !nextDesc.includes('10 次'), nextDesc)

    /* ---------- S9. 逐组登记不变量：每个计时组都有秒数、无空行 ---------- */
    const timedSets = await evalJS(`(async () => {
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      // 响应式数组经 CDP 序列化会变成空对象：先 JSON 深拷贝成纯值
      return {
        done: JSON.parse(JSON.stringify(s.doneSets['home-hiit-jumping-jack'] ?? [])),
        skipped: JSON.parse(JSON.stringify(s.skippedSets['home-hiit-jumping-jack'] ?? [])),
      }
    })()`)
    ok('S9a 计时组逐组登记为秒数（3 组完成、3/4 跳过）',
      timedSets.done.length === 3 && timedSets.skipped.join() === '3,4' &&
      timedSets.done.every((d) => typeof d.sec === 'number' && d.sec >= 1 && d.sec <= 120),
      JSON.stringify(timedSets))
    ok('S9b 计时组不写重量/次数（没有空记录）',
      timedSets.done.every((d) => d.weight == null && d.reps == null), JSON.stringify(timedSets.done))

    /* ---------- S10. 结束并保存 → 会话关闭 ---------- */
    await clickButton('结束', '.ctrl-top')
    await sleep(500)
    await clickButton('结束并保存')
    await waitAsync(
      `(async () => { const { invoke } = await import('/src/services/transport.ts'); return (await invoke('session_active')) === null })()`,
      9000,
      '保存后会话关闭',
    )
    ok('S10 保存后无 active 会话残留', true)

    /* ---------- S11. 旧快照阶段按动作类型归一（本次缺陷的脏快照自愈） ---------- */
    const restored = await evalJS(`(async () => {
      const { invoke } = await import('/src/services/transport.ts')
      await invoke('session_start', {
        planId: 'home-hiit',
        planName: '居家燃脂间歇',
        startedAt: new Date().toISOString(),
        stateJson: {
          doneSets: {}, exIndex: 0, setIndex: 2, weight: 0, phase: 'exercise',
          restLeft: 0, restTargetIsNextSet: true, timedTotal: 40, restIsTemp: false,
          resumePhase: 'exercise', restWarmup: false, reps: null, extraSets: {}, skippedSets: {}, readiness: null,
        },
      })
      const { useSessionStore } = await import('/src/stores/session.ts')
      const s = useSessionStore()
      await s.hydrateFromServer()
      const phase = s.phase
      await s.discard()
      return { phase }
    })()`)
    ok('S11a 快照记成做组态的计时动作恢复回准备页', restored?.phase === 'timed-ready', JSON.stringify(restored))
    ok('S11b 清理后无 active 会话', await evalJS(`(async () => {
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
