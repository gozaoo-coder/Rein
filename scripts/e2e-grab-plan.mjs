/**
 * e2e-grab-plan —— 抢课计划端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 这条链路要证明的是一件**用户看不到过程**的事：提前把「我想抢 高数 张」写下来，
 * 剩下的全由引擎自己完成 —— 等名单、模糊匹配、排成志愿、到点出手。
 * 所以断言分两段看：
 *
 *   1. **写之前能确认**：模糊匹配给出「会抢哪些班」，顺序就是出手顺序（有余量的先）；
 *      没匹配到要说清是「教务还没公布」还是「你的词不行」。
 *   2. **写完之后不用管**：引擎自己解析成志愿任务、自己抢到；
 *      就算批次还没出现，计划也先存着，等批次一出现就自动接上。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-grab-plan.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-plan-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    await sleep(100)
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

/** 计划面板里正在写的这句查询 —— 走真实的 input 事件（v-model） */
async function writeQuery(text) {
  await setInput('.plan .entry input', text)
  await sleep(80)
}

/** 点「预览」并等结果落下来 */
async function preview() {
  await evalJS(`document.querySelector('.plan .entry-go').click()`)
  await waitFor(`!!document.querySelector('.plan .preview, .plan .err')`, 6000, '预览返回')
}

/** 预览列表里的一行（按课名找） */
const previewRowExpr = (name) =>
  `[...document.querySelectorAll('.plan .preview .matches li')].find((e) => e.textContent.includes(${JSON.stringify(name)}))`

/** 计划行（按查询词找） */
const planRowExpr = (query) =>
  `[...document.querySelectorAll('.plan .plans .plan-row')].find((e) => e.querySelector('.q')?.textContent.trim() === ${JSON.stringify(query)})`

const planChipExpr = (query) => `((${planRowExpr(query)})?.querySelector('.chip')?.textContent.trim() ?? '')`

/** 计划行里列出的候选教学班课名 */
const candidateRowsExpr = (query) =>
  `[...((${planRowExpr(query)})?.querySelectorAll('.matches li') ?? [])]`

const planCandidates = (query) =>
  evalJS(`${candidateRowsExpr(query)}.map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)

/** 任务单里某门课那一行（与 e2e-auto-grab 同一套选择器） */
const taskRowExpr = (name) =>
  `[...document.querySelectorAll('.grab .task')].find((e) => e.querySelector('.name')?.textContent.includes(${JSON.stringify(name)}))`

async function login(user, pass) {
  await evalJS(`location.hash = '#/campus/settings'`)
  await waitFor(`document.querySelector('h1')?.textContent === '课表配置与设置'`, 12000, '配置页挂载')
  await waitFor(`document.querySelectorAll('.sys').length >= 1`, 8000, '学校系统选择器有选项')
  await waitFor(
    `!!document.querySelector('input[autocomplete="username"]') && !!document.querySelector('input[autocomplete="current-password"]')`,
    8000,
    '登录表单挂载',
  )
  const filled =
    (await setInput('input[autocomplete="username"]', user)) &&
    (await setInput('input[autocomplete="current-password"]', pass))
  if (!filled) throw new Error('登录表单没填上')
  await clickText('button', '登录')
  await waitFor(`document.body.textContent.includes('已登录')`, 15000, '登录成功')
}

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9900 + (process.pid % 90)

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
    await connect(`${APP}/#/campus/course-select`)

    /* ---- 0. 登录 + 计划面板就在（不用先进批次） ---- */
    await waitFor(`document.querySelector('h1')?.textContent === '选课'`, 15000, '选课页挂载')
    await login('2600350118', 'demo1234')
    await evalJS(`location.hash = '#/campus/course-select'`)
    await waitFor(`!!document.querySelector('.plan')`, 8000, '计划面板出现')
    ok('计划面板在批次列表之上（窗口没开时也有事可做）', true)
    ok(
      '面板讲清了模糊匹配怎么用',
      (await evalJS(`document.querySelector('.plan')?.textContent ?? ''`)).includes('模糊匹配'),
    )

    /* ---- 1. 预览：先看清会抢哪些班 ---- */
    await writeQuery('高数 张')
    await preview()
    const hit = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.plan .preview .matches li')]
      const r = ${previewRowExpr('高等数学')}
      return { count: rows.length, text: r?.textContent.replace(/\\s+/g, ' ').trim() ?? '' }
    })()`)
    ok('模糊匹配：散落子序列「高数」+ 教师「张」命中同一个班', hit.count === 1 && hit.text.includes('张伟'), hit.text)
    ok(
      '命中字段被解释出来（课程名 / 教师）',
      hit.text.includes('课程名') && hit.text.includes('教师'),
      hit.text,
    )
    ok('预览给出出手顺序编号', (await evalJS(`!!document.querySelector('.plan .preview .ord')`)) === true)
    await shot('1-preview')

    /* ---- 2. 排序是抢课语义：有余量的班排满员的前面 ---- */
    await writeQuery('000001')
    await preview()
    const ranked = await evalJS(`[...document.querySelectorAll('.plan .preview .matches li')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)
    ok('按课程代码能列出同一门课的全部教学班', ranked.length === 2, JSON.stringify(ranked))
    ok(
      '同一门课的两个班（同分）：有余量的排在满员之前',
      ranked[0].includes('余 2') && ranked[1].includes('已满'),
      JSON.stringify(ranked),
    )
    await shot('2-ranked')

    /* ---- 2b. 指定老师：打全名字 = 只抢他；打错字 = 退回模糊 ---- */
    // 名单里 9006 的老师叫「张伟」、9007 的老师叫「张伟明」—— 名字互相包含，
    // 这正是「指定」与「沾边」必须分开的那种情况。
    await writeQuery('张伟')
    await preview()
    const exact = await evalJS(`[...document.querySelectorAll('.plan .preview .matches li')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)
    ok(
      '打全老师名字 = 指定：名字沾边的另一位老师被滤掉',
      exact.length === 1 && exact[0].includes('高等数学') && exact[0].includes('张伟'),
      JSON.stringify(exact),
    )
    ok(
      '「教师精确」徽标 + 一句「按指定处理」的说明',
      exact[0]?.includes('教师精确') &&
        (await evalJS(`document.querySelector('.plan .preview')?.textContent ?? ''`)).includes('按'),
    )

    // 打错一个字（张玮 → 张伟）：不能一门都搜不到，也不能当成「指定」
    await writeQuery('张玮')
    await preview()
    const typo = await evalJS(`[...document.querySelectorAll('.plan .preview .matches li')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)
    ok(
      '名字打错 → 退回模糊：仍然命中最接近的那位老师',
      typo.length >= 1 && typo[0].includes('张伟'),
      JSON.stringify(typo),
    )
    ok(
      '更像的那位先出手（哪怕它满员，也不能因为有余量就把目标换成另一位老师）',
      typo[0]?.includes('高等数学') && typo[0]?.includes('已满') && typo[0]?.includes('张伟'),
      JSON.stringify(typo),
    )
    ok('「教师近似」徽标 + 提醒这是猜的', typo[0]?.includes('教师近似') &&
      (await evalJS(`document.querySelector('.plan .preview')?.textContent ?? ''`)).includes('猜'))
    await shot('2b-teacher')

    /* ---- 3. 没匹配到 vs 教务还没公布：两种「空」要分开说 ---- */
    await writeQuery('量子力学')
    await preview()
    const emptyText = await evalJS(`document.querySelector('.plan .preview, .plan .err')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
    ok('没匹配到时会说清「教务有几个班、你的词没中」', /7\s*个教学班/.test(emptyText) && emptyText.includes('没匹配到'), emptyText)

    /* ---- 3b. 跨课程：一句查询命中两门课 → 拦下来，不排队 ---- */
    // 「大学」同时命中 大学英语（一）/000002 与 大学物理（含实验）/000011 ——
    // 真实名单里最危险的那一版是年级双开（大一 000004 / 大二 000006 的同一门体育课）：
    // 「中一个就够」时把两门课一起排进志愿组，引擎可能抢回**另一个年级**那门。
    // 所以这类查询不该闷头排队，而要让人补上课程代码。
    await writeQuery('大学')
    await preview()
    const ambText = await evalJS(`document.querySelector('.plan .preview')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
    ok(
      '跨课程的查询在预览里就说清「命中了 2 门课」',
      ambText.includes('同时命中') && ambText.includes('000002') && ambText.includes('000011'),
      ambText.slice(0, 140),
    )
    await clickText('.plan .primary', '加入计划')
    await waitFor(`${planRowExpr('大学')} != null`, 6000, '计划行出现')
    await waitFor(`(${planChipExpr('大学')}) === '要补课程代码'`, 8000, '引擎判定为跨课程')
    ok('引擎不排队：计划停在「要补课程代码」', true, await planChipExpr('大学'))
    ok(
      '计划行不给候选班（没排志愿，也就没有「会抢哪些班」）',
      (await evalJS(`(${planRowExpr('大学')}).querySelectorAll('.matches li').length`)) === 0,
    )
    ok(
      '同一时间没有任何任务被排出来',
      (await evalJS(`document.querySelectorAll('.grab .task').length`)) === 0,
      `任务 ${await evalJS(`document.querySelectorAll('.grab .task').length`)} 条`,
    )
    // 补上课程代码 → 只命中那一门（「写上代码就锁死课程」的用户可见效果）
    await evalJS(`(${planRowExpr('大学')}).querySelector('[aria-label="移除计划"]').click()`)
    await waitFor(`${planRowExpr('大学')} == null`, 6000, '移除歧义计划')
    await writeQuery('大学英语 000002')
    await preview()
    const pinned = await evalJS(`[...document.querySelectorAll('.plan .preview .matches li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`)
    ok(
      '补上课程代码后只命中那一门（不再跨课程）',
      pinned.length > 0 && pinned.every((t) => t.includes('000002')),
      JSON.stringify(pinned).slice(0, 140),
    )
    await shot('2c-ambiguous')

    /* ---- 4. 加入计划 → 引擎自己解析成志愿任务 → 自己抢到 ---- */
    await writeQuery('高数 张')
    await preview()
    await clickText('.plan .primary', '加入计划')
    await waitFor(`${planRowExpr('高数 张')} != null`, 6000, '计划行出现')
    // 清空输入框是异步完成的（提交是先落库再回头清界面），所以这里也要等
    await waitFor(`document.querySelector('.plan .entry input').value === ''`, 4000, '输入框清空')
    ok('计划落进列表（输入框被清空，避免误以为还没提交）', true)

    // 引擎解析：候选教学班出现在计划行里 —— 这就是「提前确认会抢哪些班」
    await waitFor(candidateRowsExpr('高数 张') + '.length > 0', 8000, '引擎解析出候选教学班')
    const cands = await planCandidates('高数 张')
    ok('计划行列出会抢的教学班', cands.length === 1 && cands[0].includes('张伟'), JSON.stringify(cands))

    // 解析出来的任务会立刻出现在任务单里，并由引擎抢到
    await waitFor(`${taskRowExpr('高等数学')} != null`, 8000, '任务单出现该课')
    ok('解析结果落成任务单里的志愿任务', true)
    await waitFor(`(${planChipExpr('高数 张')}) === '已抢到'`, 20000, '计划自动抢到')
    ok('全程没有再操作：计划自己走到了「已抢到」', true, await planChipExpr('高数 张'))
    await shot('3-grabbed')

    /* ---- 5. 重新解析 & 移除（移除要连任务一起收） ---- */
    await evalJS(`(${planRowExpr('高数 张')}).querySelector('[aria-label="重新解析"]').click()`)
    await waitFor(`(${planChipExpr('高数 张')}) !== '已抢到'`, 6000, '回到解析中')
    ok('可以手动重新解析（改了名单/想换策略时用）', true, await planChipExpr('高数 张'))

    const taskCountBefore = await evalJS(`document.querySelectorAll('.grab .task').length`)
    await evalJS(`(${planRowExpr('高数 张')}).querySelector('[aria-label="移除计划"]').click()`)
    await waitFor(`${planRowExpr('高数 张')} == null`, 6000, '计划行消失')
    ok('可以移除计划', true)
    const after = await evalJS(`[...document.querySelectorAll('.grab .task')].map((e) => e.querySelector('.chip')?.textContent.trim())`)
    const DONE = ['已抢到', '已取消', '未成功', '需办免听', '已暂停']
    const stillRunning = after.filter((c) => !DONE.includes(c))
    ok(
      '移除计划会连它派出去的任务一起取消（不留「计划没了、课还在抢」）',
      after.length <= taskCountBefore && stillRunning.length === 0,
      JSON.stringify(after),
    )
    await evalJS(`[...document.querySelectorAll('.grab .foot button')].find((b) => b.textContent.includes('清掉已结束'))?.click()`)
    await sleep(400)

    /* ---- 6. 批次还没出现就先写计划：等它出现自己接上 ---- */
    // 用页面上的刷新按钮，而不是走一遍 hash 往返 —— 后者在同一个 tick 里改两次路由，
    // 终点与起点相同，组件根本不会重挂载，也就不会重新去问一次批次。
    await evalJS(`window.__REIN_MOCK_NO_SELECT_TURN__ = true`)
    await evalJS(`document.querySelector('[aria-label="立即刷新"]').click()`)
    await waitFor(`document.body.textContent.includes('当前没有开放的选课批次')`, 8000, '批次消失（窗口未开）')
    ok(
      '批次还没出现时，计划面板照样可用',
      (await evalJS(`!!document.querySelector('.plan .entry input')`)) === true,
    )

    await writeQuery('体育')
    await evalJS(`document.querySelector('.plan .primary').click()`)
    await waitFor(`${planRowExpr('体育')} != null`, 6000, '计划先存下来')
    await waitFor(
      `((${planRowExpr('体育')})?.textContent ?? '').includes('还没看到这个选课批次')`,
      8000,
      '说明「等批次」而不是报错',
    )
    ok('批次未公布：计划先存着并说明原因，不报错也不丢', true, await evalJS(`(${planRowExpr('体育')})?.textContent.replace(/\\s+/g,' ').trim()`))
    ok(
      '此时预览也会如实说「还没公布」',
      await (async () => {
        await writeQuery('体育')
        await preview()
        const t = await evalJS(`document.querySelector('.plan .err, .plan .preview')?.textContent ?? ''`)
        return /还没公布选课批次/.test(t)
      })(),
    )
    await shot('4-awaiting-turn')

    // 批次一出现，引擎自己接上
    await evalJS(`window.__REIN_MOCK_NO_SELECT_TURN__ = false`)
    await evalJS(`document.querySelector('[aria-label="立即刷新"]').click()`)
    await waitFor(`(${planChipExpr('体育')}) === '已抢到'`, 25000, '批次出现后自动抢到')
    ok('批次一出现就自动接上并抢到（提前输入的价值就在这一步）', true, await planChipExpr('体育'))
    await shot('5-late-turn')

    /* ---- 7. 多选：每门课都要 vs 只中一个 ---- */
    await clickText('.plan .seg-item', '每门课都要')
    await writeQuery('数学')
    await evalJS(`document.querySelector('.plan .primary').click()`)
    await waitFor(`${planRowExpr('数学')} != null`, 6000, 'spread 模式计划落库')
    ok(
      '「每门课都要」写在计划行上（抢法可见）',
      (await evalJS(`(${planRowExpr('数学')})?.textContent ?? ''`)).includes('每门课都要'),
    )
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
