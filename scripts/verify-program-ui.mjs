/**
 * 健康方案「溶解」重构的端到端验证（浏览器 mock 模式）。
 *
 * 流程：setup 向导（约束 → 三档矩阵 → 科学依据）→ 启用 →
 *      生效态一屏（状态条 / 周期进度 / 操作区 / 调整历史）→
 *      主页方案状态卡 → 营养页今日菜单卡 → 复盘深链 → 纯函数口径（周期 / 执行 / 日程展开）。
 *
 * 运行前需先起 dev 服务器（默认 1420）；端口被占时用 REIN_E2E_URL 指过去。
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const OUT = `${process.env.TEMP ?? '/tmp'}/rein-program-shots`
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

  /* ---------- 2. setup：约束向导 → 三档矩阵 ---------- */
  const genBtn = page.getByRole('button', { name: /计算三套方案|按新条件重新计算/ })
  ok('setup 阶段有计算按钮', (await genBtn.count()) > 0)
  if (await genBtn.count()) {
    await genBtn.first().click()
    await page.waitForTimeout(2500)
  }
  const matrixText = (await page.locator('table.matrix').count())
    ? (await page.locator('table.matrix').first().textContent()) ?? ''
    : ''
  ok(
    '三档对比矩阵渲染',
    /保守/.test(matrixText) && /均衡/.test(matrixText) && /进取/.test(matrixText),
    '',
  )
  await shot('02-tiers')

  /* ---------- 3. 科学依据（setup 入口） ---------- */
  const whyLink = page.getByRole('button', { name: /看研究曲线/ })
  ok('setup 阶段有科学依据入口', (await whyLink.count()) > 0)
  if (await whyLink.count()) {
    await whyLink.first().click()
    await page.waitForTimeout(900)
    const sheetText = (await page.textContent('body')) ?? ''
    ok('科学依据弹层打开', /明白了/.test(sheetText))
    await shot('03-evidence')
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
    if (await confirmBtn.count()) await confirmBtn.first().click()
    await page.waitForTimeout(3000)
  }

  /* ---------- 5. 生效态一屏：状态条 + 进度条 + 操作区 + 调整历史 ---------- */
  const activeText = (await page.textContent('body')) ?? ''
  ok('进入生效态（状态条出现）', /第 1 周/.test(activeText) && /减脂/.test(activeText))
  ok('周期进度条渲染', (await page.locator('.head-strip .strip-bar i').count()) === 1)
  const actCount = await page.locator('.acts-grid .act').count()
  ok('操作区四格（复盘 / 采购 / 调参 / 依据）', actCount === 4, `实际 ${actCount} 格`)
  ok('归档 / 删除胶囊在页内', (await page.locator('.acts-minor .cap').count()) === 2)
  ok('调整历史初始不显示', (await page.locator('.log-list li').count()) === 0)
  ok('被删掉的六卡不再出现（驾驶舱 / 周期地图 / 航道 / 演进图）', await page.evaluate(
    () =>
      !document.querySelector('.cockpit') &&
      !document.querySelector('.cell') &&
      !document.querySelector('.records') &&
      !(document.body.textContent ?? '').includes('目标走廊'),
  ))
  await shot('04-active')

  // 数据口径：方案日程只落训练条目（category=workout、标题「方案·」），没有饮食锚点
  const sched = await page.evaluate(async () => {
    const { invoke } = await import('/src/services/transport.ts')
    const all = await invoke('list_all_todos', {})
    const mine = all.filter((t) => t.programId != null)
    return {
      total: mine.length,
      allWorkout: mine.every((t) => t.category === 'workout'),
      anyHealth: mine.some((t) => t.category === 'health'),
      titled: mine.every((t) => t.title.startsWith('方案·')),
      sample: mine[0]?.title ?? '',
    }
  })
  ok('日程只含训练条目（无饮食锚点）', sched.total > 0 && sched.allWorkout && !sched.anyHealth && sched.titled, JSON.stringify(sched))

  /* ---------- 6. 手动调参 → 调整历史 + 版本号 ---------- */
  await page.getByRole('button', { name: /手动调参/ }).first().click()
  await page.waitForTimeout(700)
  {
    const st = page.locator('.stepper').filter({ hasText: '每日热量偏移' }).first()
    const dec = st.getByRole('button', { name: '减少' })
    await dec.click()
    await page.waitForTimeout(150)
    await dec.click()
    await page.waitForTimeout(150)
  }
  await page.getByRole('button', { name: /应用并重排今日起的日程/ }).click()
  await page.waitForTimeout(1800)
  ok('调整历史出现一条', (await page.locator('.log-list li').count()) === 1)
  const logText = (await page.locator('.log-list').textContent()) ?? ''
  ok('历史含 v2 与 before → after', logText.includes('v2') && logText.includes('→'), logText.replace(/\s+/g, ' ').slice(0, 80))
  ok('状态条版本升到 v2', /v2/.test((await page.locator('.head-strip .strip').textContent()) ?? ''))
  await shot('05-adjust-log')

  /* ---------- 7. 复盘深链：/program?review=1 自动发起（无模型 → 可读错误） ---------- */
  // 先离开再进入（同路由只变 query 的路径由页面 watcher 覆盖，这里验全新挂载）
  await page.evaluate(`location.hash = '#/'`)
  await page.waitForTimeout(900)
  await page.evaluate(`location.hash = '#/program?review=1'`)
  await page.waitForTimeout(1200)
  await page.waitForSelector('.review', { timeout: 10000 }).catch(() => {})
  const reviewErr = (await page.textContent('.err').catch(() => '')) ?? ''
  ok(
    '复盘深链自动发起且无模型时报可读错误',
    /未配置/.test(reviewErr) || /未配置/.test((await page.textContent('body')) ?? ''),
    reviewErr.slice(0, 60),
  )
  await shot('06-review')
  await page.evaluate(`document.querySelector('.review')?.closest('.panel')?.querySelector('.close')?.click()`)
  await page.waitForTimeout(800)

  /* ---------- 8. 主页方案状态卡 ---------- */
  await page.goto(`${APP}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  const cardCount = await page.locator('[data-testid="program-card"]').count()
  const cardText = cardCount ? ((await page.locator('[data-testid="program-card"]').textContent()) ?? '') : ''
  ok('主页出现方案状态卡', cardCount === 1 && /第 1 周/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 80))
  ok('状态卡含今日动作或开跑说明', /今天|开跑|已结束/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 80))
  await shot('07-home-card')
  await page.locator('[data-testid="program-card"] .main').click()
  await page.waitForTimeout(1200)
  ok('点卡回到方案页', await page.evaluate(`location.hash.includes('/program')`))

  /* ---------- 9. 营养页今日菜单卡 ---------- */
  await page.goto(`${APP}/#/nutrition`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const menuCount = await page.locator('[data-testid="program-menu"]').count()
  ok('营养页出现今日菜单卡', menuCount === 1)
  if (menuCount) {
    ok(
      '菜单卡结构（供能堆叠 + 三行宏量 + 蛋白对照 + 餐次列表）',
      await page.evaluate(() => {
        const card = document.querySelector('[data-testid="program-menu"]')
        if (!card) return false
        return (
          !!card.querySelector('.stack') &&
          card.querySelectorAll('.macro-row').length === 3 &&
          !!card.querySelector('.ptarget-track') &&
          card.querySelectorAll('.menu li').length >= 3 &&
          !!card.querySelector('.verdict')
        )
      }),
    )
    ok('未生成时回落模板菜单标注', /模板菜单/.test((await page.locator('[data-testid="program-menu"]').textContent()) ?? ''))
    await shot('08-nutrition-menu')
  }

  /* ---------- 10. 纯函数：周期 / 执行 / 日程展开 ---------- */
  const logic = await page.evaluate(async () => {
    const [{ programStatus, courseOnDate, reviewDue, markReviewed }, exec, eng] = await Promise.all([
      import('/src/utils/programCycle.ts'),
      import('/src/utils/programExec.ts'),
      import('/src/utils/programEngine.ts'),
    ])
    const pad = (n) => String(n).padStart(2, '0')
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const shift = (n) => {
      const d = new Date()
      d.setDate(d.getDate() + n)
      return iso(d)
    }
    const mkDay = (date, i, rest) => ({
      date,
      dayIndex: i,
      rest,
      courseId: rest ? null : 'planA',
      courseName: rest ? null : '课程A',
      courseDurationMin: rest ? null : 45,
      meals: [],
      rules: [],
    })
    // 起于 8 天前、共 14 天的方案（今天落在第 2 周）
    const days = Array.from({ length: 14 }, (_, i) => mkDay(shift(-8 + i), i, i % 7 === 5))
    const blob = { params: {}, days }
    const rec = { id: 9, weeks: 2 }
    const st = programStatus(rec, blob)
    const course = courseOnDate(blob, days[0].date)

    const mkWorkout = (date, min, kcal, sessionId) => ({
      id: Math.random(), name: 'w', type: 'strength', date, startMin: null,
      durationMin: min, kcal, intensity: 'moderate', effort: null, note: '', sessionId, createdAt: '',
    })
    const mkTodo = (date, status) => ({
      id: Math.random(), title: 't', notes: null, date, startMin: 600, durationMin: 45,
      category: 'workout', priority: 0, status, completedAt: null, createdAt: '', programId: 9,
    })
    // 执行并集：A 日有运动记录（含一次课程会话）、B 日勾了日程、C 日两者都没有
    const planDays = days.filter((d) => !d.rest).map((d) => d.date)
    const [a, b, c] = planDays
    const workouts = [mkWorkout(a, 50, 300, 7), mkWorkout(a, 20, 100, null)]
    const todos = [mkTodo(b, 'done'), mkTodo(c, 'todo')]
    const te = exec.trainingExec(blob, planDays[0], days.at(-1).date, workouts, todos, 9)
    const agg = exec.aggregateWorkouts(workouts, planDays[0], days.at(-1).date)

    // 日程展开：训练日数 = 待办数、全部 workout
    const profile = {
      sex: 'male', birthday: '1995-06-15', heightCm: 175, weightKg: 70,
      activityLevel: 'moderate', goal: 'cut', trainingDaysPerWeek: 4,
      preferredTimeSlots: ['evening'], equipment: 'gym', dietRestrictions: [],
      experience: 'intermediate', targets: { kcal: 2000, protein: 140, carb: 200, fat: 60, sodiumMg: 1500, waterMl: 2100 },
      weightKgTarget: null, targetWeightKg: null,
    }
    const courses = ['ppl-push', 'ppl-pull', 'ppl-legs', 'core', 'gym-fullbody'].map((id) => ({
      id, name: id, equipment: 'gym', estDurationMin: 45,
    }))
    const plans = eng.buildProgramPlans(profile, shift(1), 2, courses, [], 0)
    const plan = plans.find((p) => p.tier === 'balanced')
    const built = eng.buildScheduleTodos({ params: plan.params, days: plan.days }, profile.preferredTimeSlots)
    const trainDays = plan.days.filter((d) => !d.rest && d.courseId && d.courseName).length

    // 复盘到期：起于 8 天前 → 未复盘则到期；标记一次后不再到期
    localStorage.removeItem('rein.program.reviewed.9')
    const dueNow = reviewDue(rec, blob)
    markReviewed(9)
    const dueAfter = reviewDue(rec, blob)

    return {
      st: { week: st.week, weeks: st.weeks, ended: st.ended, upcoming: st.upcoming, progress: st.progress },
      course: course ? course.courseId : null,
      exec: te,
      agg,
      built: { count: built.length, trainDays, allWorkout: built.every((t) => t.category === 'workout') },
      due: { now: dueNow, after: dueAfter },
    }
  })

  ok(
    '周期口径：第 2 周 / 未结束 / 进度 0<x<1',
    logic.st.week === 2 && logic.st.weeks === 2 && !logic.st.ended && !logic.st.upcoming && logic.st.progress > 0 && logic.st.progress < 1,
    JSON.stringify(logic.st),
  )
  ok('当日课程解析', logic.course === 'planA', String(logic.course))
  ok(
    '执行并集：有记录 ∪ 勾日程，缺勤进 missedDates',
    logic.exec.planned > 0 && logic.exec.doneByRecord >= 1 && logic.exec.missedDates.length >= 1,
    JSON.stringify({ planned: logic.exec.planned, done: logic.exec.done, byRecord: logic.exec.doneByRecord, missed: logic.exec.missedDates.length }),
  )
  ok(
    '运动聚合：2 条 / 1 次会话 / 70 分钟 / 400 大卡',
    logic.agg.count === 2 && logic.agg.sessions === 1 && logic.agg.minutes === 70 && logic.agg.kcal === 400,
    JSON.stringify(logic.agg),
  )
  ok(
    '日程展开：条数=训练日数且全为 workout',
    logic.built.count === logic.built.trainDays && logic.built.allWorkout && logic.built.count > 0,
    JSON.stringify(logic.built),
  )
  ok('复盘到期：未复盘→到期，标记后→未到期', logic.due.now === true && logic.due.after === false, JSON.stringify(logic.due))

  /* ---------- 11. 控制台无错误 ---------- */
  ok('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '))
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
