/**
 * e2e-model-providers —— 模型页改版端到端：服务模型四槽位 + 提供商账号 + 模型目录
 *
 * 为什么值得 e2e：这次改版把「配一个模型」从「手填四件套」换成「配一个服务商账号 →
 * 拉一次目录 → 逐条启用」，链路跨越了四个执行位（ai_models / 语音配置 / 知识库设置 /
 * 界面偏好）。单测照不出「启用之后服务模型卡真的跟着变了」这类联动，所以这里把
 * UI 与工具层一起跑一遍。
 *
 * 剧本（浏览器 mock 模式）：
 *   A. 页面结构：服务模型卡四行 / 在线服务入口 / 提供商区；那句 max_tokens=1 的说明已移除
 *   B. 服务模型卡：主模型来自 ai_models 默认项；主模型无视觉能力时「多模态」行可点
 *   C. 选择抽屉：搜索过滤、提供商前缀与折叠两条渲染声明（含落库）、点一行切换主模型
 *   D. 提供商：添加（适配器 + 接入方式 + Key）→ 自动拉目录 → 卡片摘要 → 详情预览 →
 *      全部目录（筛选/启用/手填）→ 启用向量与识别模型后服务模型卡跟着变
 *   E. 全部模型抽屉：本机模型一览（含在线/手动）
 *   F. 工具层（按需装载的那套）：list_providers / list_model_roles / set_model_role /
 *      activate_provider_model —— 用户在聊天里让 AI 配置时走的就是它们
 *   G. 主模型探测出视觉能力后，「多模态」行自动暗下去（只在需要时才配）
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-model-providers.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-providers-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const DEBUG_PORT = 9900 + (process.pid % 90)

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

async function waitFor(expr, timeoutMs = 10000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJS(`Boolean(${expr})`)) return true
    await sleep(120)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${SHOTS}/${name}.png`)
}

async function shotDark(name) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(350)
  await shot(name)
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(250)
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
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

/* ---------------- 定位器与操作 ---------------- */

const pageText = () => evalJS(`document.querySelector('.page')?.innerText ?? ''`)

/** Vue v-model 认的是原生 input 事件，直接改 .value 不生效 */
const setInput = (selector, value) =>
  evalJS(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/** 在某一层抽屉（按 aria-label 定位）里点按钮 */
const clickIn = (panelLabel, text) =>
  evalJS(`(() => {
    const panel = document.querySelector('.panel[aria-label=${JSON.stringify(panelLabel)}]')
    const scope = panel ?? document
    const el = [...scope.querySelectorAll('button')]
      .find((e) => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
    if (!el) return false
    el.click()
    return true
  })()`)

const clickByText = (text) => clickIn('', text)

const panelText = (label) =>
  evalJS(`document.querySelector('.panel[aria-label=${JSON.stringify(label)}]')?.innerText ?? ''`)

async function closeSheet() {
  await evalJS(`(() => {
    const panels = [...document.querySelectorAll('.panel')]
    const p = panels[panels.length - 1]
    p?.querySelector('.close')?.click()
    return true
  })()`)
  await sleep(420)
}

/** 服务模型卡的四行（标签 + 当前值 + 是否可点） */
const serviceSlots = () =>
  evalJS(`[...document.querySelectorAll('.sm .slot')].map((s) => ({
    label: s.querySelector('.label')?.textContent.trim() ?? '',
    value: s.querySelector('b')?.textContent.trim() ?? '',
    sub: s.querySelector('small')?.textContent.trim() ?? '',
    disabled: s.disabled === true,
  }))`)

/** 选择抽屉里的行（提供商前缀后的显示名 + 是否当前项） */
const pickerRows = () =>
  evalJS(`[...document.querySelectorAll('.panel .item')].map((r) => ({
    text: r.querySelector('b')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    sub: r.querySelector('small')?.textContent.trim() ?? '',
    on: r.classList.contains('on'),
  }))`)

/** 提供商卡片（页面上的） */
const providerCards = () =>
  evalJS(`[...document.querySelectorAll('.pv')].map((c) => ({
    name: c.querySelector('.vt b')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    summary: c.querySelector('.vt em')?.textContent.trim() ?? '',
  }))`)

/** 工具直调（浏览器 mock 下 __REIN_TOOL__ 可用，与 transport.isTauri 同一判据） */
const tool = (name, args) =>
  evalJS(`window.__REIN_TOOL__(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})`)

/** 在目录抽屉里点某一行的「启用」（按模型 ID 定位，避免点到第一条） */
const clickRowUse = (panelLabel, modelId) =>
  evalJS(`(() => {
    const panel = document.querySelector('.panel[aria-label=${JSON.stringify(panelLabel)}]')
    if (!panel) return false
    const li = [...panel.querySelectorAll('.item')].find(
      (r) => r.querySelector('.main b')?.textContent.trim() === ${JSON.stringify(modelId)},
    )
    if (!li) return false
    const btn = li.querySelector('.use')
    if (!btn) return false
    btn.click()
    return true
  })()`)

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
    await connect(`${APP}/#/ai/models`)
    await evalJS(`localStorage.clear()`)

    /* ---- 0. 预置两条模型：默认项（无视觉能力）+ 百炼对话（用于跨提供商列表） ---- */
    await evalJS(`(() => {
      const now = new Date().toISOString()
      const rows = [
        {
          id: 1, name: 'DeepSeek 快档', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-e2e-aaaa', modelId: 'deepseek-flash', isDefault: true,
          vision: false, thinking: null, effort: null, imageMaxEdge: null, lastError: null,
          source: 'manual', serviceBase: null, priceIn: null, priceOut: null, priceCurrency: null,
          trafficPerGb: null, createdAt: now, updatedAt: now,
        },
        {
          id: 2, name: '百炼对话', provider: 'dashscope',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'sk-e2e-bbbb', modelId: 'qwen3-max', isDefault: false,
          vision: null, thinking: null, effort: null, imageMaxEdge: null, lastError: null,
          source: 'manual', serviceBase: null, priceIn: null, priceOut: null, priceCurrency: null,
          trafficPerGb: null, createdAt: now, updatedAt: now,
        },
      ]
      localStorage.setItem('rein.mock.ai_models.v1', JSON.stringify(rows))
      return true
    })()`)
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelector('h1')?.textContent === '管理模型'`, 15000, '模型页挂载')
    await waitFor(`document.querySelectorAll('.sm .slot').length === 4`, 10000, '服务模型卡渲染')
    await sleep(700)

    /* ---- A. 页面结构 ---- */
    const text = await pageText()
    ok('页头是「管理模型」', await evalJS(`document.querySelector('h1')?.textContent === '管理模型'`))
    ok('有「服务模型」卡', text.includes('服务模型'))
    const labels = (await serviceSlots()).map((s) => s.label)
    ok(
      '服务模型卡四行齐全（主 LLM / 多模态 / ASR / 向量）',
      labels.join('|') === '主 LLM 模型|多模态 LLM（备选）|ASR 语音识别模型|向量模型',
      labels.join(' · '),
    )
    ok('已移除「每条模型保存后会自动发送 max_tokens=1」的说明', !text.includes('每条模型保存后会自动发送'))
    ok('有「Rein 在线服务」入口卡', text.includes('Rein 在线服务'))
    ok('提供商区有标题与「全部模型」入口', text.includes('提供商') && text.includes('全部模型'))
    ok('有「添加提供商」入口', text.includes('添加提供商'))
    await shot('a-page')

    /* ---- B. 服务模型卡当前值 ---- */
    let slots = await serviceSlots()
    ok('主 LLM 显示默认项（DeepSeek 快档）', slots[0].value === 'DeepSeek 快档', JSON.stringify(slots[0]))
    ok('主模型无视觉能力 → 多模态行可点', slots[1].disabled === false, JSON.stringify(slots[1]))
    ok('ASR 行未配置（还没启用识别模型）', slots[2].value === '未配置', JSON.stringify(slots[2]))
    ok(
      '向量行显示知识库当前设置',
      /关键词|本机|bge|未读取/.test(slots[3].value) || slots[3].sub.includes('知识库'),
      JSON.stringify(slots[3]),
    )

    /* ---- C. 选择抽屉：搜索 + 渲染声明 + 切换主模型 ---- */
    await evalJS(`document.querySelectorAll('.sm .slot')[0].click()`)
    await waitFor(`Boolean(document.querySelector('.panel[aria-label="选择主 LLM 模型"]'))`, 6000, '主模型选择抽屉')
    ok('抽屉里有搜索框', await evalJS(`Boolean(document.querySelector('.panel .bar .finder input'))`))
    const rowsAll = await pickerRows()
    ok('列出全部已配置模型（2 条）', rowsAll.length === 2, JSON.stringify(rowsAll.map((r) => r.text)))
    ok(
      'provider name display = true：模型名前带提供商昵称',
      rowsAll.every((r) => r.text.includes('·')),
      JSON.stringify(rowsAll.map((r) => r.text)),
    )
    await shot('c-picker')

    ok('搜索过滤（qwen）', await setInput('.panel .bar .finder input', 'qwen'))
    await sleep(250)
    const rowsFiltered = await pickerRows()
    ok('过滤后只剩百炼那条', rowsFiltered.length === 1 && rowsFiltered[0].text.includes('qwen'), JSON.stringify(rowsFiltered))
    ok('清空搜索', await setInput('.panel .bar .finder input', ''))
    await sleep(250)

    // provider name folder = true：按提供商折叠（分组标题 + 折叠按钮）
    ok('默认开启「按提供商折叠」', await evalJS(`document.querySelectorAll('.panel .bar .flag')[1].classList.contains('on')`))
    const groupHeads = await evalJS(`[...document.querySelectorAll('.panel .grp-head b')].map((e) => e.textContent.trim())`)
    ok('折叠分组按提供商给出分组头', groupHeads.length === 2, groupHeads.join(' · '))
    await shot('c-picker-folded')

    // 关掉折叠 → 单组；关掉前缀 → 名字不带昵称
    await evalJS(`document.querySelectorAll('.panel .bar .flag')[1].click()`)
    await sleep(250)
    ok(
      'provider name folder = false：分组头消失',
      (await evalJS(`document.querySelectorAll('.panel .grp-head').length`)) === 0,
    )
    await evalJS(`document.querySelectorAll('.panel .bar .flag')[0].click()`)
    await sleep(250)
    const rowsFlat = await pickerRows()
    ok(
      'provider name display = false：模型名不带前缀',
      rowsFlat.every((r) => !r.text.includes('·')),
      JSON.stringify(rowsFlat.map((r) => r.text)),
    )
    const prefs = await evalJS(`JSON.parse(localStorage.getItem('rein.mock.ai_model_prefs.v1') ?? '{}')`)
    ok(
      '两条渲染声明已落库（下次打开还是这个状态）',
      prefs.providerNameDisplay === false && prefs.providerNameFolder === false,
      JSON.stringify(prefs),
    )
    // 复原成默认（前缀 + 折叠），后续断言按默认渲染
    await evalJS(`document.querySelectorAll('.panel .bar .flag')[0].click()`)
    await evalJS(`document.querySelectorAll('.panel .bar .flag')[1].click()`)
    await sleep(250)

    await clickIn('选择主 LLM 模型', '百炼 · 百炼对话')
    await waitFor(`!document.querySelector('.panel[aria-label="选择主 LLM 模型"]')`, 6000, '抽屉关闭')
    await sleep(300)
    slots = await serviceSlots()
    ok('点一行即切换主模型（服务模型卡跟着变）', slots[0].value === '百炼对话', JSON.stringify(slots[0]))
    ok('主模型副值显示提供商与模型 ID', slots[0].sub.includes('百炼') && slots[0].sub.includes('qwen3-max'), slots[0].sub)

    /* ---- D. 提供商：添加 → 拉目录 → 启用 ---- */
    await clickByText('添加提供商')
    await waitFor(`Boolean(document.querySelector('.panel[aria-label="添加提供商"]'))`, 6000, '提供商表单抽屉')
    ok('表单列出适配器（含火山方舟）', (await panelText('添加提供商')).includes('火山方舟'))
    ok('表单列出接入方式（含 Agent Plan API）', (await panelText('添加提供商')).includes('Agent Plan API'))
    ok('默认地址已按适配器预填', await evalJS(`document.querySelector('#pv-base')?.value.includes('ark.cn-beijing.volces.com')`))
    ok('密钥输入是专用组件（默认遮住 + 可粘贴）', await evalJS(`document.querySelector('#pv-key')?.type === 'password'`))
    await setInput('#pv-key', 'ark-e2e-key-1234')
    await shot('d-provider-form')
    await clickIn('添加提供商', '保存并拉取模型')
    await waitFor(`document.querySelectorAll('.pv').length === 1`, 12000, '提供商卡片出现')
    await closeSheet()
    const cards = await providerCards()
    ok('提供商卡片出现（昵称 + 适配器）', cards[0].name.includes('火山方舟'), JSON.stringify(cards[0]))
    ok(
      '卡片摘要按类别计数（对话 / 视觉 / 向量 / 识别）',
      cards[0].summary.includes('对话') && cards[0].summary.includes('向量') && cards[0].summary.includes('识别'),
      cards[0].summary,
    )
    await shot('d-provider-card')

    // 详情：预览 + 「查看全部」
    await evalJS(`document.querySelector('.pv').click()`)
    await waitFor(`Boolean(document.querySelector('.panel[aria-label="火山方舟"]'))`, 6000, '提供商详情抽屉')
    ok('详情里有凭据摘要（地址 + 密钥末四位）', (await panelText('火山方舟')).includes('****1234'))
    ok('详情里有目录预览与「查看全部」', (await panelText('火山方舟')).includes('查看全部'))
    await shot('d-provider-sheet')
    await clickIn('火山方舟', '查看全部')
    await waitFor(`Boolean(document.querySelector('.panel[aria-label="火山方舟 · 模型目录"]'))`, 6000, '目录抽屉')
    const catalog = await panelText('火山方舟 · 模型目录')
    ok('目录里有向量与识别模型', catalog.includes('doubao-embedding-text-240715') && catalog.includes('volc.seedasr.sauc.duration'))
    ok('类别筛选 chips 齐全', catalog.includes('全部') && catalog.includes('向量') && catalog.includes('语音识别'))

    // 筛选到向量 → 只剩向量模型
    await clickIn('火山方舟 · 模型目录', '向量')
    await sleep(300)
    const kindRows = await evalJS(`[...document.querySelectorAll('.panel[aria-label="火山方舟 · 模型目录"] .item')].map((r) => r.querySelector('b')?.textContent.trim())`)
    ok('筛选「向量」后只剩向量模型', kindRows.length >= 1 && kindRows.every((t) => t.includes('embedding')), JSON.stringify(kindRows))
    await shot('d-catalog-embedding')

    // 启用向量模型 → 知识库设置被写
    ok(
      '点某一行「启用」',
      await clickRowUse('火山方舟 · 模型目录', 'doubao-embedding-text-240715'),
    )
    await sleep(1000)
    const kb = await evalJS(`JSON.parse(localStorage.getItem('rein.mock.kb_settings.v1') ?? '{}')`)
    ok(
      '启用向量模型 → 知识库切到云端端点',
      kb.embeddingMode === 'cloud' && kb.cloudModel === 'doubao-embedding-text-240715',
      JSON.stringify({ mode: kb.embeddingMode, model: kb.cloudModel, base: kb.cloudBaseUrl }),
    )
    ok('该行显示「使用中」', (await panelText('火山方舟 · 模型目录')).includes('使用中'))

    // 手填模型
    ok('手填输入框存在', await setInput('.panel[aria-label="火山方舟 · 模型目录"] .mid', 'my-custom-model'))
    await evalJS(`document.querySelector('.panel[aria-label="火山方舟 · 模型目录"] .add').click()`)
    await sleep(700)
    ok(
      '手填的模型进入目录（标记「手填」）',
      (await panelText('火山方舟 · 模型目录')).includes('my-custom-model') &&
        (await panelText('火山方舟 · 模型目录')).includes('手填'),
    )
    await shot('d-catalog-manual')

    // 筛选到识别 → 启用 ASR
    await clickIn('火山方舟 · 模型目录', '语音识别')
    await sleep(350)
    ok(
      '点识别模型的「启用」',
      await clickRowUse('火山方舟 · 模型目录', 'volc.seedasr.sauc.duration'),
    )
    await sleep(1000)
    await closeSheet()
    await closeSheet()
    await sleep(400)
    slots = await serviceSlots()
    ok('启用识别模型 → ASR 行显示 Resource-Id', slots[2].value.includes('seedasr'), JSON.stringify(slots[2]))
    ok('ASR 行标注豆包适配器与凭据已就绪', slots[2].sub.includes('豆包') && !slots[2].sub.includes('缺凭据'), slots[2].sub)
    ok('向量行显示刚启用的云端模型', slots[3].value === 'doubao-embedding-text-240715', JSON.stringify(slots[3]))
    ok('向量行标注提供商来源', slots[3].sub.includes('火山方舟'), slots[3].sub)
    await shot('d-service-models-after')
    await shotDark('d-service-models-dark')

    /* ---- E. 全部模型抽屉 ---- */
    await clickByText('全部模型')
    await waitFor(`Boolean(document.querySelector('.panel[aria-label="全部模型"]'))`, 6000, '全部模型抽屉')
    const allText = await panelText('全部模型')
    ok('全部模型里能看到本机模型', allText.includes('DeepSeek 快档') && allText.includes('百炼对话'))
    ok('全部模型里有搜索与渲染声明开关', await evalJS(`document.querySelectorAll('.panel[aria-label="全部模型"] .bar .flag').length === 2`))
    ok('行内有 设为默认 / 重新测试 / 编辑 / 删除 四个动作', await evalJS(`
      ['设为默认','重新测试能力','编辑模型','删除模型'].every((l) =>
        Boolean(document.querySelector('.panel[aria-label="全部模型"] button[aria-label="' + l + '"]')))
    `))
    await shot('e-all-models')
    await closeSheet()

    /* ---- F. 工具层（聊天里让 AI 配置时走的那套，按需装载） ---- */
    const listed = await tool('list_providers')
    ok('工具 list_providers：带适配器清单', listed.adapters.length >= 5 && listed.adapters.some((a) => a.id === 'volc-ark'))
    ok('工具 list_providers：带提供商与目录', listed.count === 1 && listed.providers[0].models.embedding.length >= 1)
    ok(
      '工具 list_providers：密钥只回末四位',
      listed.providers[0].apiKeyTail === '****1234',
      listed.providers[0].apiKeyTail,
    )
    const roles = await tool('list_model_roles')
    ok(
      '工具 list_model_roles：四个槽位齐全',
      roles.slots.map((s) => s.role).join('|') === 'llm|vision|asr|embedding',
    )
    ok(
      '工具 list_model_roles：向量候选含本机模型与云端模型',
      roles.slots[3].candidates.some((c) => c.ref.startsWith('local:')) &&
        roles.slots[3].candidates.some((c) => c.ref.startsWith('cloud:')),
    )
    await tool('set_model_role', { role: 'embedding', ref: 'keyword' })
    await sleep(600)
    const kbAfter = await evalJS(`JSON.parse(localStorage.getItem('rein.mock.kb_settings.v1') ?? '{}')`)
    ok('工具 set_model_role：切回关键词检索生效', kbAfter.embeddingMode === 'keyword', kbAfter.embeddingMode)
    const activated = await tool('activate_provider_model', {
      providerId: listed.providers[0].id,
      modelId: 'doubao-seed-1.6',
      setAsMain: false,
    })
    ok('工具 activate_provider_model：对话模型进 ai_models', activated.ok === true && activated.kind === 'llm', JSON.stringify(activated))
    const modelsList = await tool('list_models')
    ok(
      '新启用的对话模型出现在模型列表里',
      modelsList.models.some((m) => m.modelId === 'doubao-seed-1.6'),
      JSON.stringify(modelsList.models.map((m) => m.modelId)),
    )
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelectorAll('.sm .slot').length === 4`, 12000, '重载后模型页')

    /* ---- G. 主模型有视觉能力时，多模态行自动暗下去 ---- */
    await evalJS(`(() => {
      const rows = JSON.parse(localStorage.getItem('rein.mock.ai_models.v1') ?? '[]')
      const m = rows.find((x) => x.isDefault) ?? rows[0]
      m.vision = true
      localStorage.setItem('rein.mock.ai_models.v1', JSON.stringify(rows))
      return true
    })()`)
    await evalJS(`location.reload()`)
    await waitFor(`document.querySelectorAll('.sm .slot').length === 4`, 12000, '重载（视觉已支持）')
    await sleep(700)
    slots = await serviceSlots()
    ok('主模型支持视觉 → 多模态行不可点（不需要另配）', slots[1].disabled === true, JSON.stringify(slots[1]))
    ok('多模态行给出原因文案', slots[1].sub.includes('已具备视觉能力'), slots[1].sub)
    await shot('g-vision-not-needed')
  } finally {
    edge.kill()
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${failed === 0 ? '✔' : '✖'} 模型页改版 e2e：${results.length - failed} 项通过，${failed} 项失败`)
    console.log(`   截图目录：${SHOTS}`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.stack ?? e}`)
  process.exit(1)
})
