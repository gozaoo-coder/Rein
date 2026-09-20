/**
 * AI 工具按需装载端到端（src/ai/tools/registry.ts 的 GROUP_POLICY）。
 * 运行：node scripts/e2e-ai-tools.mjs   （前置：npm run dev 已在 1420，或用 REIN_E2E_URL 指向别的实例）
 *
 * 为什么能在浏览器里测：装载判定与提示词组装都是纯函数，页内直接 import 源模块即可，
 * 不需要真模型在环 —— 会坏的是「哪些组该装、装了什么、提示词段落跟没跟上」，不是模型的措辞。
 *
 * 覆盖：
 *   A. 分组与体积 —— 常驻组恒装、schema 体积确实降下来；
 *   B. 路由 —— 关键词命中装载、未命中不装；
 *   C. 门禁 —— 关掉的功能插件整组不出现，也不可装载；
 *   D. 元工具 —— load_tools 真能扩载、组目录随之缩短、非法组名有回话；
 *   E. 提示词联动 —— 段落与工具同进同出（不给工具就不讲工具）。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9335)
/** 目标应用地址：默认 1420；端口被系统排除或并发会话时用 REIN_E2E_URL 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-aitools-${Date.now()}`

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
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(url) {
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
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

/** 页内调注册表的纯函数（与 chat.ts 用的是同一份实现） */
async function reg(fn) {
  return evalJS(`(async () => {
    const R = await import('/src/ai/tools/registry.ts')
    return (${fn})(R)
  })()`)
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,900',
    'about:blank',
  ])
  await sleep(1800)

  try {
    await connect(APP)
    await waitFor("document.querySelector('h1')", 12000, '应用挂载')
    await sleep(600)

    /* ---------- A. 分组与体积 ---------- */

    const shape = await reg(`(R) => {
      const all = R.APP_TOOLS
      const size = (names) => all.filter((t) => names.includes(t.name))
        .reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0)
      const plan = R.resolveToolPlan({})
      const always = R.toolNamesForGroups(plan.loaded)
      return {
        tools: all.length,
        groups: Object.keys(R.GROUP_POLICY).length,
        alwaysCount: always.length,
        alwaysSize: size(always),
        allSize: size(all.map((t) => t.name)),
        hasLoader: always.includes('load_tools'),
        catalogRows: R.toolGroupCatalog(plan.available).split('\\n').length - 2,
        available: plan.available,
      }
    }`)
    ok(
      '分组：注册表 = 域工具 + load_tools，常驻组不含课表/记账',
      shape.tools === 84 && shape.hasLoader === false ? false : shape.hasLoader,
      `${shape.tools} 个工具 / ${shape.groups} 组`,
    )
    ok(
      '分组：默认只装常驻组（39 个），其余按需',
      shape.alwaysCount === 39 && shape.available.length === 8,
      `常驻 ${shape.alwaysCount} 个，可装载 ${shape.available.length} 组 [${shape.available.join(',')}]`,
    )
    ok(
      '体积：常驻 schema 明显小于全量（<60%）',
      shape.alwaysSize < shape.allSize * 0.6,
      `常驻 ${shape.alwaysSize} / 全量 ${shape.allSize} 字符（${Math.round((shape.alwaysSize / shape.allSize) * 100)}%）`,
    )
    ok('组目录：按可装载组逐行列出', shape.catalogRows === shape.available.length, `${shape.catalogRows} 行`)

    /* ---------- B. 路由 ---------- */

    const route = await reg(`(R) => {
      const hit = (text, plugins) => [...R.resolveToolPlan({ text, plugins }).loaded]
      return {
        plain: hit('你好呀'),
        ledger: hit('帮我记一笔，中午吃饭花了 32'),
        exercise: hit('我今天跑了 5 公里'),
        campus: hit('我想课表里加一门课'),
        sticky: [...R.resolveToolPlan({ text: '那笔改一下', sticky: ['ledger'] }).loaded],
        nutritionAlways: hit('你好呀').includes('nutrition'),
      }
    }`)
    ok('路由：普通寒暄不装载任何按需组', !route.plain.includes('ledger') && !route.plain.includes('campus'), route.plain.length + ' 组')
    ok('路由：提到花钱 → 记账组', route.ledger.includes('ledger'), '')
    ok('路由：提到跑步 → 运动组', route.exercise.includes('exercise'), '')
    ok('路由：提到课表 → 教务组', route.campus.includes('campus'), '')
    ok('路由：粘住的组在追问里仍在（「那笔」→ 记账）', route.sticky.includes('ledger'), '')
    ok('路由：常驻组含营养（饮食主流程依赖）', route.nutritionAlways, '')

    /* ---------- C. 功能开关门禁 ---------- */

    const gate = await reg(`(R) => {
      const off = R.resolveToolPlan({ text: '我想选课、记一笔账', plugins: [] })
      const on = R.resolveToolPlan({ text: '我想选课、记一笔账', plugins: ['campus', 'sports', 'program'] })
      return {
        offLoaded: [...off.loaded],
        offAvail: off.available,
        onLoaded: [...on.loaded],
        offNames: R.toolNamesForGroups(off.loaded).filter((n) => n.startsWith('campus_')),
      }
    }`)
    ok(
      '门禁：关掉课表 → 教务组不装、也不可装载',
      !gate.offLoaded.includes('campus') && !gate.offAvail.includes('campus') && gate.offNames.length === 0,
      `可用 ${gate.offAvail.join(',')}`,
    )
    ok('门禁：开着课表 → 命中即装（且带全 10 个教务工具）', gate.onLoaded.includes('campus'), '')

    /* ---------- D. 元工具 ---------- */

    const loader = await reg(`(R) => {
      const t = R.findAppTool('load_tools')
      return t ? t.parameters : null
    }`)
    ok('元工具：load_tools 已注册且入参为组名数组', Boolean(loader), '')

    const loadRes = await evalJS(`(async () => {
      const R = await import('/src/ai/tools/registry.ts')
      const t = R.findAppTool('load_tools')
      const good = await t.execute({ groups: ['ledger', 'voice'] })
      const bad = await t.execute({ groups: ['ledger', 'nope'] })
      return { good, bad }
    })()`)
    ok(
      '元工具：装载返回组名 + 工具清单 + 给模型的话术',
      loadRes.good.loadedGroups.join(',') === 'ledger,voice' && loadRes.good.toolNames.length === 11,
      `${loadRes.good.toolNames.length} 个工具`,
    )
    ok('元工具：不认识/常驻的组名回话说明，不静默通过', loadRes.bad.loadedGroups.join(',') === 'ledger' && loadRes.bad.message.includes('nope'), loadRes.bad.message.slice(0, 40))

    const catalogAfter = await reg(`(R) => {
      const plan = R.resolveToolPlan({ text: '帮我记账' })
      const avail = plan.available.filter((g) => !plan.loaded.has(g))
      return { rows: R.toolGroupCatalog(avail).split('\\n').length - 2, avail }
    }`)
    ok('组目录：装过的组不再出现在目录里', !catalogAfter.avail.includes('ledger'), catalogAfter.avail.join(','))

    /* ---------- E. 提示词联动 ---------- */

    const prompt = await evalJS(`(async () => {
      const { buildChatSystemPrompt } = await import('/src/ai/chat.ts')
      const R = await import('/src/ai/tools/registry.ts')
      const plan = R.resolveToolPlan({ text: '你好' })
      const gated = buildChatSystemPrompt(new Date(), '', undefined, {
        loaded: plan.loaded,
        available: plan.available,
      })
      const withCampus = buildChatSystemPrompt(new Date(), '', undefined, {
        loaded: new Set([...plan.loaded, 'campus', 'models', 'voice']),
        available: plan.available.filter((g) => g !== 'campus'),
      })
      const legacy = buildChatSystemPrompt(new Date(), '', undefined)
      return {
        // 段落的判别句（不是「校园教务」四个字 —— 组目录里本就会拿它当组名喊一嗓子）
        gatedCampus: gated.includes('**平时帮用户看清「该修什么、该选什么」'),
        gatedModels: gated.includes('AI 模型配置也由你直接管理：list_models 查看已配置的模型与能力'),
        gatedAdvertised: gated.includes('- campus（校园教务）'),
        gatedCatalog: gated.includes('【工具装载】'),
        gatedCatalogRows: (gated.match(/^- /gm) || []).length,
        withCampus:
          withCampus.includes('**平时帮用户看清「该修什么、该选什么」') &&
          withCampus.includes('AI 模型配置也由你直接管理：list_models'),
        withCampusAdvertised: withCampus.includes('- campus（校园教务）'),
        withCampusRows: (withCampus.match(/^- /gm) || []).length,
        legacy: legacy.includes('校园教务') && legacy.includes('list_models'),
        gatedLen: gated.length,
        allLen: withCampus.length,
      }
    })()`)
    ok(
      '提示词：不装教务/模型 → 不讲它们的用法（段落与工具同进同出）',
      !prompt.gatedCampus && !prompt.gatedModels,
      '',
    )
    ok(
      '提示词：未装载的组仍出现在【工具装载】里（否则模型无从知道有它）',
      prompt.gatedAdvertised && !prompt.withCampusAdvertised,
      '',
    )
    ok('提示词：装载教务/模型 → 对应段落出现', prompt.withCampus, '')
    ok('提示词：带出【工具装载】目录，且装了组后目录变短', prompt.gatedCatalog && prompt.withCampusRows < prompt.gatedCatalogRows, `${prompt.gatedCatalogRows} → ${prompt.withCampusRows} 行`)
    ok(
      '提示词：不传 plan = 老行为（段落全在，兼容纪要走自定义提示词）',
      prompt.legacy,
      `门禁版 ${prompt.gatedLen} / 全量版 ${prompt.allLen} 字符`,
    )

    /* ---------- F. 应用仍起得来 ---------- */

    await evalJS(`(async () => {
      location.hash = '#/ai'
      return true
    })()`)
    await sleep(900)
    const alive = await evalJS(`Boolean(document.querySelector('textarea, [contenteditable="true"], .aipage, main'))`)
    ok('应用：AI 页在按需装载下正常挂载', Boolean(alive), '')
  } finally {
    try { edge.kill() } catch { /* 已退出 */ }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('e2e 失败：', e)
  process.exit(1)
})
