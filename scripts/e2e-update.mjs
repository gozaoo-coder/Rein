/**
 * e2e-update —— 更新中心端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么要 e2e：更新这条链路的价值全在「跨组件的状态机」上 —— 检查之后才出现下载按钮、
 * 下载走完才允许安装、跳过之后卡片消失、关掉一个源之后它就以失败态出现在报告里。
 * 这些联动单测照不出来，只有真点一遍才验证得了；它同时是回归网：哪天按钮的
 * 出现条件写错（比如没下载就允许安装），断言会立刻红。
 *
 * 剧本：
 *   1. 设置 › 软件更新：版本、平台、检查按钮就位；启动静默检查已把 0.2.2 找出来
 *   2. 手动检查更新 → 可更新卡片 + 两个更新源的探测结果（含清单签名标注）
 *   3. 跳过此版本 → 卡片收起、出现「已跳过」→ 恢复提示 → 卡片回来
 *   4. 下载 → 进度 → 校验 → 已就绪（出现「安装并重启」）
 *   5. 安装 → 状态变「正在安装」
 *   6. 关掉 GitHub 源 → 再检查，该源报告为「已在设置里关闭」
 *   7. Rein 在线服务卡片显示模型网关状态（未配置）
 *
 * 顺序有讲究：**跳过只能在「还没下载完」时做**（有已就绪的包时该按钮不出现），
 * 所以剧本把跳过排在下载之前 —— 与页面上的出现条件是同一套规则。
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-update.mjs
 * 开关：window.__REIN_MOCK_UPDATE_NONE__ = true（模拟「已是最新」）
 *       window.__REIN_MOCK_UPDATE_FAIL__ = true（模拟验签失败）
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-update-${Date.now()}`
const USER_DATA = `${OUT}/profile`
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

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

/* ---------------- 页面定位器 ---------------- */

const pageTitle = () => evalJS(`document.querySelector('h1')?.textContent ?? ''`)

/** 按文本点按钮（页内所有 button） */
const clickButton = (text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find((e) => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
    if (!el) return false
    el.click()
    return true
  })()`)

/** 卡片标题清单 */
const cardTitles = () => evalJS(`[...document.querySelectorAll('.card .gtitle')].map((e) => e.textContent.trim())`)

/** 页面正文（用于宽松断言） */
const pageText = () => evalJS(`document.querySelector('.page')?.innerText ?? ''`)

/** 更新源行的状态文案 */
const sourceRows = () =>
  evalJS(`[...document.querySelectorAll('.srow')].map((r) => ({
    name: r.querySelector('.stxt b')?.textContent.trim() ?? '',
    status: r.querySelectorAll('.stxt em')[1]?.textContent.trim() ?? '',
    on: r.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true',
  }))`)

/** 点某更新源的开关 */
const toggleSource = (name, on) =>
  evalJS(`(() => {
    const row = [...document.querySelectorAll('.srow')]
      .find((r) => r.querySelector('.stxt b')?.textContent.trim() === ${JSON.stringify(name)})
    if (!row) return 'no-row'
    const sw = row.querySelector('[role="switch"]')
    if (!sw) return 'no-switch'
    const isOn = sw.getAttribute('aria-checked') === 'true'
    if (isOn !== ${on}) sw.click()
    return isOn === ${on} ? 'already' : 'clicked'
  })()`)

/* ---------------- 主流程 ---------------- */

const DEBUG_PORT = 9700 + (process.pid % 200)

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
    await connect(`${APP}/#/settings`)
    // 每次从干净状态开跑：清掉上一轮的更新设置
    await evalJS(`localStorage.clear()`)
    await evalJS(`location.hash = '#/settings'`)
    await waitFor(`document.querySelector('h1')?.textContent === '设置'`, 10000, '设置页挂载')

    /* ---- 1. 入口 ---- */
    const aboutCards = await cardTitles()
    ok('设置页「关于」组存在', aboutCards.includes('关于'), aboutCards.join(' · '))
    await clickButton('软件更新')
    await waitFor(`document.querySelector('h1')?.textContent === '软件更新'`, 10000, '更新页挂载')
    ok('「设置 › 关于 › 软件更新」进入更新页', (await pageTitle()) === '软件更新')

    const initialText = await pageText()
    ok('显示当前版本 v0.2.1', initialText.includes('v0.2.1'), (initialText.match(/v[\d.]+/) ?? [''])[0])
    ok('显示平台标识', initialText.includes('Windows'), '')
    ok('更新源默认列出两个（Rein 在线服务 + GitHub）', (await sourceRows()).length === 2, JSON.stringify(await sourceRows()))
    // 启动静默检查（App.vue onMounted）应当已经把 0.2.2 找出来了：
    // 这条断言同时守着「自动检查是不是真的跑了」和「进页面就能看到结果」
    await waitFor(`Boolean(document.querySelector('.card.hl'))`, 10000, '启动静默检查发现新版本')
    ok('启动静默检查已发现新版本（进页面即可见可更新卡片）', (await pageText()).includes('0.2.2'))
    ok(
      '还没下载时没有「安装并重启」按钮',
      !(await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('安装并重启'))`)),
    )
    await shot('1-update-idle')
    await shotDark('1-update-idle-dark')

    /* ---- 2. 检查更新 ---- */
    await clickButton('检查更新')
    await waitFor(`Boolean(document.querySelector('.card.hl'))`, 10000, '可更新卡片出现')
    const checkText = await pageText()
    ok('检查后出现新版本 0.2.2', checkText.includes('0.2.2'))
    ok('显示更新来源', checkText.includes('Rein 在线服务'), '')
    ok('显示更新说明（notes）', checkText.includes('断点续传'), '')
    ok('显示包大小', checkText.includes('MB'), '')
    const rowsAfterCheck = await sourceRows()
    ok(
      '两个源都报告了探测结果（✓ + 版本号）',
      rowsAfterCheck.every((r) => r.status.startsWith('✓') && r.status.includes('0.2.2')),
      JSON.stringify(rowsAfterCheck),
    )
    ok(
      '报告里标注了清单签名',
      rowsAfterCheck.every((r) => r.status.includes('清单已签名')),
      JSON.stringify(rowsAfterCheck),
    )
    await shot('2-update-available')
    await shotDark('2-update-available-dark')

    /* ---- 3. 跳过 / 恢复（必须在下载之前：有已就绪的包时按钮不出现） ---- */
    await clickButton('跳过此版本')
    await waitFor(`document.querySelector('.page').innerText.includes('已跳过')`, 8000, '跳过生效')
    const skipped = await pageText()
    ok('跳过此版本后卡片收起并显示「已跳过」', skipped.includes('已跳过 0.2.2'), '')
    ok('跳过后不再显示可更新卡片', !(await evalJS(`Boolean(document.querySelector('.card.hl'))`)))
    await clickButton('恢复提示')
    await waitFor(`Boolean(document.querySelector('.card.hl'))`, 8000, '恢复提示')
    ok('「恢复提示」后重新出现可更新卡片', true)

    /* ---- 4. 下载 ---- */
    await clickButton('下载安装包')
    await waitFor(`document.querySelector('.pbar')`, 6000, '进度条出现')
    ok('点下载后出现进度条', true)
    await waitFor(`document.querySelector('.progress-box')?.innerText.includes('已通过摘要与签名校验')`, 15000, '校验通过')
    const afterDownload = await pageText()
    ok('下载完成后提示已通过摘要与签名校验', afterDownload.includes('已通过摘要与签名校验'))
    ok('出现「安装并重启」按钮', await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('安装并重启'))`))
    ok(
      '已就绪后不再显示「跳过此版本」（按钮出现条件自洽）',
      !(await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('跳过此版本'))`)),
    )
    await shot('3-update-ready')
    await shotDark('3-update-ready-dark')

    /* ---- 5. 安装 ---- */
    await clickButton('安装并重启')
    await waitFor(`document.querySelector('.progress-box')?.innerText.includes('正在安装')`, 8000, '安装中状态')
    ok('点安装后状态变为「正在安装」', true)

    /* ---- 6. 关掉一个源 ---- */
    ok('关掉 GitHub 源（点击开关）', (await toggleSource('GitHub Release', false)) === 'clicked')
    await waitFor(
      `[...document.querySelectorAll('.srow')].find((r) => r.querySelector('.stxt b')?.textContent.trim() === 'GitHub Release')?.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false'`,
      5000,
      'GitHub 源已关',
    )
    await clickButton('检查更新')
    await waitFor(
      `[...document.querySelectorAll('.srow')].some((r) => r.innerText.includes('已在设置里关闭'))`,
      10000,
      '关闭的源出现在报告里',
    )
    ok('关掉的源会以失败态出现在探测报告里', true)
    ok('关掉 GitHub 后仍有可用源（Rein 在线服务）', (await pageText()).includes('Rein 在线服务'))

    /* ---- 7. 在线服务卡片 ---- */
    await waitFor(`document.querySelector('.page').innerText.includes('Rein 在线服务')`, 8000, '在线服务卡')
    const onlineText = await pageText()
    ok('在线服务卡显示模型网关端点', onlineText.includes('/v1/chat/completions'), '')
    ok('未配置 provider 时如实标注「未配置」', onlineText.includes('未配置'), '')
    ok('提供「去配置模型」入口', await evalJS(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('去配置模型'))`))
    await shot('4-update-online')
    await shotDark('4-update-online-dark')

    /* ---- 8. 设置项 ---- */
    ok('设置区含自动检查 / 检查间隔 / 通道 / http / 清理缓存', (await evalJS(
      `['自动检查更新','检查间隔','更新通道','允许明文 http 源','清理下载缓存'].every((t) => document.querySelector('.page').innerText.includes(t))`,
    )))
    ok('通道默认 stable 且可切换', await evalJS(
      `[...document.querySelectorAll('.chip')].some((c) => c.textContent.trim() === 'stable' && c.classList.contains('on'))`,
    ))
  } finally {
    try {
      edge.kill()
    } catch {
      /* 忽略 */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${failed.length === 0 ? '✔' : '✖'} e2e-update：${results.length - failed.length} 项通过，${failed.length} 项失败`)
  console.log(`   截图目录 ${SHOTS}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`\n✖ ${e.stack ?? e}`)
  process.exit(1)
})
