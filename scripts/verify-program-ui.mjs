/**
 * 健康方案页改造的端到端验证（浏览器 mock 模式）。
 * 流程：setup 阶段 → 科学依据三条曲线 → 启用方案 → 驾驶舱 / 周期地图。
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = 'http://localhost:1420'
const OUT = 'C:/Users/Administrator/AppData/Local/Temp/rein-program-shots'
mkdirSync(OUT, { recursive: true })

const results = []
const errors = []

function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
page.on('console', (m) => {
  // 忽略静态资源的 404（favicon 等），与本次改动无关；由 response 监听器覆盖真实 4xx
  if (m.type() !== 'error') return
  if (/Failed to load resource: the server responded with a status of 404/.test(m.text())) return
  errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('response', (r) => {
  // favicon 之类的静态 404 不计入（与本次改动无关）
  if (r.status() >= 400 && !/\.ico(\?|$)/.test(r.url())) {
    errors.push(`HTTP ${r.status()}: ${r.url()}`)
  }
})

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
}

try {
  await page.goto(`${APP}/#/program`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // mock 的 profile 缺性别与生日，方案引擎会判定「不可行」，无法走启用流程。
  // mock 是内存态（刷新即重置），所以必须在同一次会话内补全，并让 store 重新拉取。
  const seeded = await page
    .evaluate(async () => {
      const m = await import('/src/mock/server.ts')
      const p = await m.mockInvoke('get_profile', {})
      await m.mockInvoke('update_profile', {
        profile: {
          sex: 'male',
          birthday: '1995-06-15',
          heightCm: p.heightCm ?? 175,
          weightKg: p.weightKg ?? 70,
        },
      })
      // 让 nutrition store 丢掉旧缓存重新拉取（generateDrafts 只在 profile 为空时才拉）
      const el = document.querySelector('#app')
      const pinia = el?.__vue_app__?.config?.globalProperties?.$pinia
      const st = pinia?._s?.get('nutrition')
      if (st) await st.loadProfile()
      return st ? 'ok' : 'store-not-found'
    })
    .catch((e) => e.message)
  ok('补全 mock profile 并刷新 store', seeded === 'ok', String(seeded))

  /* ---------- 1. 页面能渲染 ---------- */
  const bodyText = await page.textContent('body')
  ok('页面渲染出健康方案标题', /健康方案/.test(bodyText ?? ''))
  await shot('01-initial')

  /* ---------- 2. 进入 setup 阶段：内联约束向导 → 计算三套方案 ---------- */
  const genBtn = page.getByRole('button', { name: /计算三套方案|按新条件重新计算/ })
  ok('setup 阶段有计算按钮', (await genBtn.count()) > 0)
  if (await genBtn.count()) {
    await genBtn.first().click()
    await page.waitForTimeout(2500)
  }
  // 档位以对比矩阵呈现（ProgramCompare），三列表头即三档
  const matrixCount = await page.locator('table.matrix').count()
  const matrixText = matrixCount ? (await page.locator('table.matrix').first().textContent()) ?? '' : ''
  ok(
    '三档对比矩阵渲染',
    /保守/.test(matrixText) && /均衡/.test(matrixText) && /进取/.test(matrixText),
    `matrix=${matrixCount}`,
  )
  await shot('02-tiers')

  /* ---------- 3. 科学依据：三条曲线 tab ---------- */
  const whyLink = page.getByRole('button', { name: /为什么是 3 \/ 4 \/ 5 练/ })
  ok('setup 阶段有科学依据入口', (await whyLink.count()) > 0)
  if (await whyLink.count()) {
    await whyLink.first().click()
    await page.waitForTimeout(900)

    const sheetText = await page.textContent('body')
    ok('科学依据弹层打开', /为什么是这样/.test(sheetText ?? ''))
    ok('频次曲线标题渲染', /每周练几次最划算/.test(sheetText ?? ''))
    ok('三档标记渲染在频次曲线', /保守[\s\S]*均衡[\s\S]*进取/.test(sheetText ?? ''))
    await shot('03-curve-freq')

    // 切到睡眠曲线
    await page.getByRole('tab', { name: '睡眠时长' }).click()
    await page.waitForTimeout(500)
    const sleepText = await page.textContent('body')
    ok('睡眠曲线切换', /每晚睡几小时最有利于练/.test(sleepText ?? ''))
    ok('睡眠关键发现表渲染', /黄金窗口/.test(sleepText ?? ''))
    await shot('04-curve-sleep')

    // 切到时差曲线
    await page.getByRole('tab', { name: '社交时差' }).click()
    await page.waitForTimeout(500)
    const jetText = await page.textContent('body')
    ok('时差曲线切换', /睡眠规律性有多重要/.test(jetText ?? ''))
    ok('时差耐受度表渲染', /抑制阈值/.test(jetText ?? '') && /档耐受/.test(jetText ?? ''))
    await shot('05-curve-jetlag')

    await page.getByRole('button', { name: '明白了' }).click()
    await page.waitForTimeout(600)
  }

  /* ---------- 4. 启用方案 ---------- */
  const activateBtn = page.getByRole('button', { name: /启用「.+」方案/ })
  ok('有启用按钮', (await activateBtn.count()) > 0)
  if (await activateBtn.count()) {
    await activateBtn.first().click()
    await page.waitForTimeout(700)
    const confirmBtn = page.getByRole('button', { name: '确认启用' })
    if (await confirmBtn.count()) {
      await confirmBtn.first().click()
    }
    await page.waitForTimeout(3000)
  }

  /* ---------- 5. 生效态：驾驶舱 + 周期地图 ---------- */
  const activeText = await page.textContent('body')
  ok('进入生效态（出现周期地图）', /周期地图/.test(activeText ?? ''))
  ok('驾驶舱进度条渲染', /今日训练/.test(activeText ?? '') && /餐次记录/.test(activeText ?? ''))

  const cellCount = await page.locator('.cell').count()
  ok('周期地图渲染 28 格', cellCount === 28, `实际 ${cellCount} 格`)

  // 方案默认从下周一开跑，今天可能尚未落在方案区间内，故 today 格为 0~1 均合理
  const todayCells = await page.locator('.cell.today').count()
  ok('周期地图 today 格至多 1 个', todayCells <= 1, `实际 ${todayCells} 个`)

  const futureCells = await page.locator('.cell.future, .cell.restFuture').count()
  ok('周期地图渲染未来日', futureCells > 0, `未来格 ${futureCells} 个`)

  // done / missed 的历史态由纯函数用例覆盖（见 verify-program-logic.mjs）

  await shot('06-active-dashboard')

  /* ---------- 6. 点格子切换聚焦日 ---------- */
  const cells = page.locator('.cell')
  const before = await page.textContent('.focus')
  await cells.nth(20).click()
  await page.waitForTimeout(500)
  const after = await page.textContent('.focus')
  ok('点格子切换聚焦日', before !== after, `${(before ?? '').trim().slice(0, 24)} → ${(after ?? '').trim().slice(0, 24)}`)
  await shot('07-cycle-focus')

  /* ---------- 7. 生效态的科学依据入口 ---------- */
  const whyAct = page.getByRole('button', { name: /为什么是这样/ })
  ok('生效态有科学依据入口', (await whyAct.count()) > 0)
  if (await whyAct.count()) {
    await whyAct.first().click()
    await page.waitForTimeout(800)
    const t = await page.textContent('body') ?? ''
    // 弹层可能在 setup 阶段看过时差后 tab 停在 jetlag，所以三条曲线任一标题出现即视为打开
    const opened =
      /每周练几次最划算|每晚睡几小时最有利于练|睡眠规律性有多重要/.test(t) &&
      /明白了/.test(t)
    ok('生效态科学依据可打开', opened, '')
    await shot('08-active-evidence')
    await page.getByRole('button', { name: '明白了' }).click()
    await page.waitForTimeout(500)
  }

  /* ---------- 8. 控制台无错误 ---------- */
  ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '))

  /* ---------- 9. 纯函数：格子状态判定 ----------
   * E2E 无法验证 done/missed（新方案从下周一开始，过去无格子），
   * 通过 import 真实 utils 跑覆盖全部六态的用例。 */
  const logicResults = await page.evaluate(async () => {
    const { buildDayCells, cycleStats } = await import('/src/utils/programProgress.ts')
    const today = '2026-08-28'
    // 28 天：7 天前到 20 天后
    const days = Array.from({ length: 28 }, (_, i) => {
      const d = new Date(today)
      d.setDate(d.getDate() - 7 + i)
      const iso = d.toISOString().slice(0, 10)
      const dayIndex = i
      const rest = dayIndex % 7 === 5 || dayIndex % 7 === 6
      return {
        date: iso,
        dayIndex,
        rest,
        courseId: rest ? null : 'planA',
        courseName: rest ? null : '课程A',
        courseDurationMin: rest ? null : 45,
        meals: [],
        rules: [],
      }
    })
    const blob = { params: { kcalDelta: -400, proteinPerKg: 1.8, trainingDays: 4, mealsCount: 4, weekTemplateId: 'w', equipment: null, targets: { kcal: 1620, protein: 124, carb: 200, fat: 60, sodiumMg: 1500, waterMl: 1700 }, bmr: 1650, tdee: 2020 }, days }
    const todo = (date, status, cat = 'workout') => ({
      id: 1, title: 't', notes: null, date, startMin: null, durationMin: null,
      category: cat, priority: 0, status, completedAt: null, createdAt: '', programId: 1,
    })
    const cells = buildDayCells(
      blob,
      [
        todo(days[2].date, 'done'),       // 5 天前完成
        todo(days[3].date, 'todo'),       // 4 天前未完成
        todo(days[10].date, 'done'),      // 3 天后，未来日（不影响状态）
      ],
      1,
      today,
    )
    const stats = cycleStats(cells)
    const cAt = (i) => cells[i] ? { date: cells[i].date, state: cells[i].state, rest: cells[i].rest } : null
    return {
      pastDone: cAt(2),     // 5 天前，done
      pastTodo: cAt(3),     // 4 天前，有 todo 未完成
      pastNoTodo: cAt(4),   // 3 天前，无 todo
      pastRest: cAt(6),     // 7 天前（restPast）
      today: cAt(7),        // 7 天前的下一个 = 今天
      futureTrain: cAt(8),  // 明天训练
      futureRest: cAt(13),  // 6 天后休息
      stats,
    }
  })

  ok('过去+done → done', logicResults.pastDone?.state === 'done', `state=${logicResults.pastDone?.state}`)
  ok('过去+未完成 todo → missed', logicResults.pastTodo?.state === 'missed', `state=${logicResults.pastTodo?.state}`)
  ok('过去+无 todo → missed', logicResults.pastNoTodo?.state === 'missed', `state=${logicResults.pastNoTodo?.state}`)
  ok('过去休息日 → restPast', logicResults.pastRest?.state === 'restPast', `state=${logicResults.pastRest?.state}`)
  ok('今天 → today', logicResults.today?.state === 'today', `state=${logicResults.today?.state}`)
  ok('未来训练日 → future', logicResults.futureTrain?.state === 'future', `state=${logicResults.futureTrain?.state}`)
  ok('未来休息日 → restFuture', logicResults.futureRest?.state === 'restFuture', `state=${logicResults.futureRest?.state}`)
  ok('统计 done=1 missed=4 rate=0.2', logicResults.stats.done === 1 && logicResults.stats.missed === 4 && Math.abs(logicResults.stats.rate - 0.2) < 1e-6, JSON.stringify(logicResults.stats))
} catch (e) {
  ok('脚本执行', false, e.message)
  await shot('99-error')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
if (errors.length) {
  console.log('\n控制台错误:')
  errors.slice(0, 10).forEach((e) => console.log('  - ' + e))
}
process.exit(failed.length ? 1 : 0)
