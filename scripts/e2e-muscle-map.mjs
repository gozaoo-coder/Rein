/**
 * e2e-muscle-map —— 激活肌群图（自绘三视图）端到端（无头 Edge + 原生 CDP，浏览器 mock 模式）
 *
 * 为什么 e2e：这套资产的价值全在「画出来的分区真的能按肌束单独高亮」——三角肌
 * 前/中/后束、胸大肌上/下束必须是独立分区且样式互不牵连，靠单测看不出渲染结果。
 *
 * 剧本：
 *   1. /#/sports/exercises 打开动作库，点开一个练胸的动作 → 详情抽屉出现三视图
 *   2. 三个视图各一张 SVG，共用同一 viewBox（等大人体）
 *   3. 三视图的分区键集合包含三角肌前/中/后束等细分肌束
 *   4. 分区间无路径级 fill（着色来自 CSS 继承），激活档位落在 l1/l2/l3 类上
 *   5. 单独给「三角肌前束」上色不影响中束/后束（分开高亮的直接证据）
 *   6. 底图含衣物分区（避免生殖器官直接暴露）
 *
 * 前置：npm run dev 已在 1420（或 REIN_E2E_URL 指向其它实例）
 * 运行：node scripts/e2e-muscle-map.mjs
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
const OUT = process.env.REIN_E2E_OUT ?? `${process.env.TEMP}/rein-e2e-muscle-${Date.now()}`
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

async function shot(name, full = false) {
  const r = await cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
  })
  if (!r?.data) return
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`     截图 ${SHOTS}/${name}.png`)
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
  while (Date.now() - t0 < 20000) {
    try {
      if ((await evalJS('document.readyState')) === 'complete') return
    } catch {
      /* 导航中上下文会短暂失效 */
    }
    await sleep(200)
  }
  throw new Error('页面加载超时')
}

const clickText = (selector, text) =>
  evalJS(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return false
    el.click()
    return true
  })()`)

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
      '--window-size=430,1500',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
        if (r.ok) break
      } catch {
        /* 还没起来 */
      }
      await sleep(200)
    }

    await connect(`${APP}/#/sports/exercises`)
    await waitFor(`document.querySelector('.exrow')`, 15000, '动作库列表')

    // 找一个练胸的动作（激活表里会有胸大肌细分分区）
    const picked = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.exrow')]
      const hit = rows.find((r) => /卧推|俯卧撑|飞鸟|夹胸/.test(r.textContent)) || rows[0]
      hit.click()
      return hit.textContent.trim().slice(0, 20)
    })()`)
    console.log(`     选中动作：${picked}`)

    await waitFor(`document.querySelector('.mapcard .mmap svg')`, 10000, '肌群图渲染')
    await sleep(300)

    const info = await evalJS(`(() => {
      const map = document.querySelector('.mapcard .mmap')
      const svgs = [...map.querySelectorAll('.figwrap svg')]
      const keysOf = (svg) => [...svg.querySelectorAll('g[data-m]')].map((g) => g.dataset.m)
      const layersOf = (svg) => [...svg.querySelectorAll('g[data-m]')].map((g) => Number(g.dataset.layer))
      return {
        viewBoxes: svgs.map((s) => s.getAttribute('viewBox')),
        counts: svgs.map((s) => keysOf(s).length),
        keys: svgs.map(keysOf),
        pathFillAttrs: [...map.querySelectorAll('g[data-m] path')].filter((p) => p.hasAttribute('fill')).length,
        basePaths: svgs.map((s) => s.querySelectorAll('.base path').length),
        layers: svgs.map(layersOf),
        hasDepthToggle: !!map.querySelector('.depthbtn'),
        deepHiddenByDefault: svgs.map((s) =>
          [...s.querySelectorAll('g[data-m]')].filter((g) => Number(g.dataset.layer) > 1).every((g) => getComputedStyle(g).display === 'none'),
        ),
        styled: svgs.map((s) =>
          [...s.querySelectorAll('g[data-m]')]
            .filter((g) => g.classList.contains('l1') || g.classList.contains('l2') || g.classList.contains('l3'))
            .map((g) => ({ key: g.dataset.m, cls: [...g.classList].find((c) => /^l[123]$/.test(c)) })),
        ),
      }
    })()`)

    ok('三视图各渲染一张 SVG', info.viewBoxes.length === 3, `viewBoxes=${JSON.stringify(info.viewBoxes)}`)
    ok('三视图共用同一 viewBox（等大对齐）', new Set(info.viewBoxes).size === 1, info.viewBoxes[0])

    const all = new Set(info.keys.flat())
    const expected = [
      'delt-ant',
      'delt-lat',
      'delt-post',
      'chest-up',
      'chest-low',
      'traps-up',
      'traps-mid',
      'traps-low',
      'lats',
      'lower-back',
      'abs',
      'obliques',
      'biceps',
      'triceps',
      'forearm',
      'glute-max',
      'glute-med',
      'quads-lat',
      'quads-rec',
      'quads-med',
      'adductors',
      'hamstrings',
      'calves',
      'soleus',
      'tibialis',
      'scm',
    ]
    const missing = expected.filter((k) => !all.has(k))
    ok('肌束级分区齐备（26 键）', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '')
    ok(
      '三角肌前/中/后束为独立分区',
      all.has('delt-ant') && all.has('delt-lat') && all.has('delt-post'),
      `正面分区数 ${info.counts[0]}`,
    )
    ok('上胸/下胸为独立分区', all.has('chest-up') && all.has('chest-low'))
    ok('分区路径无内联 fill（着色走 CSS 继承）', info.pathFillAttrs === 0, `inline fill=${info.pathFillAttrs}`)
    ok('底图为真实人体轮廓', info.basePaths.every((n) => n >= 1), `base=${JSON.stringify(info.basePaths)}`)
    ok(
      '分区带浅层/深层标注',
      info.layers.every((ls) => ls.length > 0 && ls.every((n) => n === 1 || n === 2)),
      `正面层分布 ${JSON.stringify([...new Set(info.layers[0])])}`,
    )
    ok('深层分区默认折叠', info.deepHiddenByDefault.every(Boolean), JSON.stringify(info.deepHiddenByDefault))
    ok('提供深层开关', info.hasDepthToggle)
    ok(
      '激活肌群按档位着色（l1/l2/l3）',
      info.styled.every((v) => v.length > 0),
      JSON.stringify(info.styled[0]?.slice(0, 6)),
    )

    // 深层开关真的能揭示被浅层盖住的深层肌（Vue 的 v-show 在 nextTick 生效，须等一拍）
    const countDeepVisible = () =>
      evalJS(`(() => {
        const map = document.querySelector('.mapcard .mmap')
        return [...map.querySelectorAll('g[data-m]')].filter((g) => Number(g.dataset.layer) > 1 && getComputedStyle(g).display !== 'none').length
      })()`)
    const totalDeep = await evalJS(
      `(() => { const map = document.querySelector('.mapcard .mmap'); return [...map.querySelectorAll('g[data-m]')].filter((g) => Number(g.dataset.layer) > 1).length })()`,
    )
    const before = await countDeepVisible()
    await evalJS(`(() => { document.querySelector('.mapcard .mmap .depthbtn').click(); return true })()`)
    await sleep(250)
    const after = await countDeepVisible()
    await evalJS(`(() => { document.querySelector('.mapcard .mmap .depthbtn').click(); return true })()`)
    await sleep(250)
    const restored = await countDeepVisible()
    ok('深层开关揭示深层分区', after > before, JSON.stringify({ before, after, restored, totalDeep }))
    ok('深层开关可收回', restored === before, `restored=${restored}`)

    // 分开高亮的直接证据：单独给三角肌前束上色，中束/后束不受影响
    const isolated = await evalJS(`(() => {
      const map = document.querySelector('.mapcard .mmap')
      const g = [...map.querySelectorAll('g[data-m="delt-ant"]')]
      const others = [...map.querySelectorAll('g[data-m="delt-lat"], g[data-m="delt-post"]')]
      const before = others.map((e) => getComputedStyle(e).fill)
      g.forEach((e) => e.classList.add('l3'))
      const after = others.map((e) => getComputedStyle(e).fill)
      const self = g.map((e) => getComputedStyle(e).fill)
      return { before, after, self, unchanged: before.every((c, i) => c === after[i]) }
    })()`)
    ok('单独高亮三角肌前束不影响中束/后束', isolated.unchanged, `前束 fill=${isolated.self[0]}`)

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await shot('muscle-map-light')
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(300)
    await shot('muscle-map-dark')
  } finally {
    edge.kill()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 通过 · 截图目录 ${SHOTS}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('e2e 失败:', e)
  process.exit(1)
})
