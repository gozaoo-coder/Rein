/**
 * 热身重量「跟随推荐重量」+ AI 会话工具 运行时实测（浏览器 + mock 后端）。
 *
 * 为什么单独一条：这两件事都是**口径**问题，不是文案问题 ——
 * 热身重量是不是真按当天推荐重量换算的、AI 改现场会不会把状态机弄崩，
 * 只有跑起来才知道。static import 一次都验不到。
 *
 * 覆盖：
 *  W. 热身处方 = 推荐重量的 50%/75%（取整到 2.5、严格小于工作重量），界面与 store 一致
 *  R. 界面脚注写明「按推荐重量 X kg 换算」（用户看得到换算依据）
 *  Q. AI 查询：get_active_session / get_warmup_rule 能取到推荐重量与处方
 *  M. AI 写入：update_active_session 改重量 / 跳过热身 / 加练生效，且越界与非法 action 只返回
 *     {updated:false} 不抛错（切屏断流后重放安全）
 *
 * 运行：node scripts/e2e-session-warmup.mjs
 *   （前置：另起一个**非 Tauri** 的 vite —— `npx vite --port 5173 --strictPort`）
 *   ⚠️ 本机 1420 / 1430 落在 Windows 保留端口段（WSL/Hyper-V 占位），listen 直接 EACCES，
 *      所以用 REIN_E2E_URL 指到别的端口。
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:5173'
const OUT = 'docs/shots'
const PLAN = 'ppl-push'
let pass = 0
let fail = 0

function ok(cond, msg, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg + (detail ? ` — ${detail}` : ''))
  } else {
    fail++
    console.log('  ✗ ' + msg + (detail ? ` — ${detail}` : ''))
  }
}

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('    [pageerror] ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('    [console.error] ' + m.text())
})

/** 页面内直取会话 store（与 e2e-session-summary 同一套路） */
const evalStore = (fn) => page.evaluate(fn)

// 工具直调钩子由 ai/tools/registry.ts 在模块加载时挂上；运动页不会加载它，
// 所以先动态 import 一次（等价于用户打开过一次 AI 页）
async function ensureToolHook() {
  await page.evaluate(async () => {
    if (typeof window.__REIN_TOOL__ !== 'function') {
      await import('/src/ai/tools/registry.ts')
    }
  })
}

/** 页面内调 AI 工具（registry 在非 Tauri 下把工具直调挂到 window.__REIN_TOOL__） */
const callTool = (name, args) =>
  page.evaluate(
    ([n, a]) => window.__REIN_TOOL__(n, a),
    [name, args ?? {}],
  )

await page.goto(`${BASE}/#/sports/plans/${PLAN}`, { waitUntil: 'networkidle' })
// mock 的做组明细跨运行累积，清干净才有稳定的建议基线
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('rein.mock.')) localStorage.removeItem(k)
  }
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2200)

// 更新弹窗盖住整页：摘掉（不能 remove，会破坏 Vue 的 DOM 记账）
await page.evaluate(() => {
  for (const sel of ['.up-backdrop', '.up-card']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }
})

console.log('\n[S] 开课')
await page.locator('button.start', { hasText: '开始' }).first().click()
await page.waitForSelector('.pane .eyebrow', { timeout: 15000 })
await page.waitForTimeout(800)

const phase = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().phase
})
ok(phase === 'warmup', 'ppl-push 首动作带热身，进入激活热身相位', phase)

// 进课会弹「今日状态」自评 —— 它是建议引擎的乘项，会改推荐重量。
// 先跳过拿一个纯自动推断的基线，顺带覆盖「自评变化 → 建议重算 → 热身预填对齐」这条链路。
const skipReadiness = page.getByText('跳过（不影响计算）', { exact: false })
if ((await skipReadiness.count()) > 0) {
  await skipReadiness.first().click()
  await page.waitForTimeout(900)
}
const dialogGone = await page.evaluate(() => !document.body.textContent.includes('不影响计算'))
ok(dialogGone, '跳过今日自评后弹窗关闭（自评变化会触发建议重算）')

console.log('\n[W] 热身处方跟随推荐重量')
const rx = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  const ex = s.currentEx
  const working = s.workingWeightFor(ex)
  const rx = s.warmupsFor(ex)
  return {
    name: ex.name,
    working,
    planWeight: ex.weightKg,
    advised: s.adviceFor(ex)?.suggestedWeight ?? null,
    rx,
    planWarmups: ex.warmups ?? null,
  }
})
console.log(
  `    动作=${rx.name} plan=${rx.planWeight}kg 推荐=${rx.advised}kg 工作=${rx.working}kg ` +
    `处方=${rx.rx.map((d) => `${d.weightKg}×${d.reps}`).join(' / ')}`,
)
ok(rx.working > 0, '工作重量可读（建议 / 上次 / 计划 三级回落）', `${rx.working}kg`)
ok(rx.rx.length > 0, '处方非空')
ok(
  rx.rx.every((d) => d.weightKg < rx.working),
  '每一段都严格小于工作重量',
  rx.rx.map((d) => d.weightKg).join(','),
)
ok(
  rx.rx.every((d) => Math.abs(d.weightKg / 2.5 - Math.round(d.weightKg / 2.5)) < 1e-9),
  '重量取整到 2.5kg 步进',
  rx.rx.map((d) => d.weightKg).join(','),
)
const pcts = rx.rx.map((d) => Math.round((d.weightKg / rx.working) * 100))
ok(
  pcts.every((p) => p >= 45 && p <= 80),
  '百分比落在热身区间（40%~75% 附近，含取整误差）',
  pcts.join('% / ') + '%',
)
// 核心断言：处方不是课程里写死的那份
const sameAsPlan =
  rx.planWarmups != null &&
  rx.planWarmups.length === rx.rx.length &&
  rx.planWarmups.every((d, i) => d.weightKg === rx.rx[i].weightKg)
ok(!sameAsPlan, '处方来自推荐重量换算，不再是课程里的静态值（除非两者恰好相等）')

console.log('\n[R] 界面显示的重量与脚注')
const ui = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('.wlist .wstep')].map((e) => e.textContent.trim())
  const hint = document.querySelector('.whint')?.textContent?.trim() ?? ''
  return { chips, hint }
})
ok(ui.chips.length === rx.rx.length, '界面热身格数与处方一致', `${ui.chips.length} 格`)
ok(
  rx.rx.every((d, i) => (ui.chips[i] ?? '').includes(String(d.weightKg))),
  '界面每格重量与处方一致',
  ui.chips.join(' | '),
)
ok(ui.hint.includes('推荐重量'), '脚注写明换算依据（按推荐重量 … kg）', ui.hint)

// 预填重量必须已经对齐到处方第一组（自评/建议异步到达后 store 会 resync）
const prefill = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  return { weight: s.weight, first: s.warmupsFor(s.currentEx)[0]?.weightKg ?? null }
})
ok(
  prefill.first != null && prefill.weight === prefill.first,
  '当前重量已对齐到处方第一组（建议异步到达后重预填）',
  `${prefill.weight} vs ${prefill.first}`,
)

mkdirSync(OUT, { recursive: true })
await page.screenshot({ path: `${OUT}/session-warmup-rx.png` })
console.log(`    截图 → ${OUT}/session-warmup-rx.png`)

console.log('\n[Q] AI 查询')
await ensureToolHook()
const active = await callTool('get_active_session')
ok(!!active, 'get_active_session 返回会话')
ok(
  active?.warmup?.prescribed?.length === rx.rx.length,
  '查询结果里的热身处方与界面同源',
  JSON.stringify(active?.warmup?.prescribed),
)
ok(
  active?.warmup?.basisWeightKg === rx.working,
  '查询结果给出换算基准重量',
  `${active?.warmup?.basisWeightKg}kg`,
)
const rule = await callTool('get_warmup_rule', { workingWeightKg: rx.working })
ok(!!rule?.rule && rule?.prescribed?.length === rx.rx.length, 'get_warmup_rule 试算一致', rule?.rule)

console.log('\n[M] AI 改现场')
const before = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().weight
})
const wRes = await callTool('update_active_session', { action: 'set_weight', weightKg: 12.5 })
const after = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().weight
})
ok(wRes?.updated === true && after === 12.5, 'set_weight 生效并回执 updated:true', `${before} → ${after}`)

const skipW = await callTool('update_active_session', { action: 'skip_warmup' })
const ph2 = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  return useSessionStore().phase
})
ok(skipW?.updated === true && ph2 === 'exercise', 'skip_warmup 跳到正式组', ph2)

const addRes = await callTool('update_active_session', { action: 'add_set' })
const eff = await evalStore(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const s = useSessionStore()
  return { eff: s.effSets(s.currentEx), plan: s.currentEx.sets }
})
ok(addRes?.updated === true && eff.eff === eff.plan + 1, 'add_set 追加一组', JSON.stringify(eff))

console.log('\n[E] 鲁棒性（这些都不能抛错）')
const badRange = await callTool('update_active_session', {
  action: 'goto_set',
  exerciseIndex: 999,
  setNo: 1,
})
ok(badRange?.updated === false && typeof badRange?.reason === 'string', '越界 goto_set → 结构化拒绝', badRange?.reason)
const badAction = await callTool('update_active_session', { action: 'nuke' })
ok(badAction?.updated === false, '非法 action → 不抛错，返回 updated:false', badAction?.reason)
const badWeight = await callTool('update_active_session', { action: 'set_weight', weightKg: -5 })
ok(badWeight?.updated === false, '非法重量 → 结构化拒绝', badWeight?.reason)
const badReps = await callTool('update_active_session', { action: 'set_reps' })
ok(badReps?.updated === false, '缺参 set_reps → 结构化拒绝', badReps?.reason)

console.log('\n[Z] 无会话时查询返回 null')
const nullCase = await page.evaluate(async () => {
  const { useSessionStore } = await import('/src/stores/session.ts')
  const { sessionService } = await import('/src/services/sessionService.ts')
  const s = useSessionStore()
  await s.discard()
  await new Promise((r) => setTimeout(r, 300))
  const active = await sessionService.getActive()
  const q = await window.__REIN_TOOL__('get_active_session', {})
  const w = await window.__REIN_TOOL__('update_active_session', { action: 'skip_set' })
  return { serverActive: !!active, q, w }
})
ok(nullCase.q === null, '无会话时 get_active_session 返回 null', JSON.stringify(nullCase.q))
ok(nullCase.w?.updated === false, '无会话时写入被拒绝而不是崩', nullCase.w?.reason)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
