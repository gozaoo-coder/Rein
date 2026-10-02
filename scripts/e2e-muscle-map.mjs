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
      hit.querySelector('.main').click()
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
      // 深层结构与补充肌束（激活时以叠加层绘制在浅层之上）
      'teres-major',
      'rhomboids',
      'rotator-cuff',
      'serratus-ant',
      'iliopsoas',
      'glute-min',
      'vastus-intermedius',
      'levator-scapulae',
      'tibialis-post',
      'fibularis',
      'plantaris',
      'popliteus',
      'quadratus-femoris',
    ]
    const missing = expected.filter((k) => !all.has(k))
    ok('肌束级分区齐备（39 键）', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '')
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

    // ---------- 深度分层：越靠观察者越实（见 MuscleMap 文件头） ----------
    //
    // 这一组是 2026-09-26 加的那层设计：三档颜色本身说不清"是哪一块肌肉"，
    // 于是按 data-depth 分成外层 / 中层 / 后层，各自乘一个透明度。
    // 断言分两半：**分组正确**（结构与阈值对得上）与**顺序正确**（外层确实比后层实）。
    const BANDS = `(() => {
      const svgs = [...document.querySelectorAll('.mapcard .mmap .figwrap svg')]
      const alpha = (el) => Number(getComputedStyle(el).opacity)
      const bandsOf = (svg) => [...svg.children].filter((c) => c.classList.contains('band'))
      return svgs.map((svg) => {
        const bands = bandsOf(svg)
        return {
          // 组的顺序必须是 0（后层）→ 1 → 2（外层）：绘制顺序即从远到近
          order: bands.map((b) => Number([...b.classList].find((c) => /^band-\\d$/.test(c)).slice(5))),
          // 每组里每块肌肉自己的 depth 必须落在这一组的区间里（分组没串）
          depthOk: bands.every((b) => {
            const idx = Number([...b.classList].find((c) => /^band-\\d$/.test(c)).slice(5))
            return [...b.querySelectorAll('g[data-m]')].every((g) => {
              const d = Number(g.dataset.depth)
              const want = d >= 6 ? 2 : d >= 3.2 ? 1 : 0
              return want === idx
            })
          }),
          // 组上的透明度：外层 > 中层 > 后层
          alpha: bands.map(alpha),
          // 每块肌肉的 data-depth 与所在组对得上（供上面 depthOk 之外单独看）
          reordered: bands.map((b) => [...b.querySelectorAll('g[data-m]')].length),
          keys: bands.map((b) => [...b.querySelectorAll('g[data-m]')].map((g) => g.dataset.m)),
          filters: bands.map((b) => String(getComputedStyle(b).filter)),
          unit: getComputedStyle(document.querySelector('.mapcard .mmap')).getPropertyValue('--mmap-u').trim(),
        }
      })
    })()`

    const bands = await evalJS(BANDS)
    ok(
      '三个视图都分成 后层/中层/外层 三组，且按从远到近排列',
      bands.every((v) => v.order.length === 3 && v.order.join(',') === '0,1,2'),
      JSON.stringify(bands.map((v) => v.order)),
    )
    ok(
      '每块肌肉都落在与它 data-depth 相符的组里（没有串组）',
      bands.every((v) => v.depthOk),
      JSON.stringify(bands.map((v) => v.reordered)),
    )
    ok(
      '透明度梯度：外层 > 中层 > 后层（三个视图一致）',
      bands.every((v) => v.alpha[2] > v.alpha[1] && v.alpha[1] > v.alpha[0]),
      bands.map((v) => v.alpha.map((a) => a.toFixed(2)).join('>')).join(' | '),
    )
    const frontKeys = bands[0]?.keys ?? []
    ok(
      '正面视图里 背阔肌（后层）与 上胸（外层）分在不同的组',
      frontKeys[0]?.includes('lats') && frontKeys[2]?.includes('chest-up'),
      `后层 ${(frontKeys[0] ?? []).join(',')} · 外层 ${(frontKeys[2] ?? []).join(',')}`,
    )
    // 非极致档不加景深模糊：模糊是"更贵但更像真玻璃"那一档的pay-for
    ok(
      '非极致档不给分层加模糊（高画质下三组都是 none）',
      bands.every((v) => v.filters.every((f) => f === 'none' || f === '')),
      JSON.stringify(bands[0]?.filters),
    )

    // ---------- 极致档：被表层覆盖的肌肉加 1px / 2px 景深模糊 ----------
    // 单位换算见 MuscleMap 的 --mmap-u：SVG 里的模糊按**用户坐标**算，直接写 1px
    // 只有 0.13 个屏幕像素（等于没加），所以必须由 JS 量出缩放比再换算 ——
    // 这里同时验「模糊真的挂上了」与「换算真的做过」（--mmap-u 被量出来而不是回落默认值）。
    // 单位是 **CSS 像素**（量出来的就是用户单位/CSS 像素，不除 dpr）：景深是视觉线索，
    // 「1px」要在手机与桌面上是同一个观感量级，除 dpr 会让手机上的模糊缩到 1/3。
    //
    // 换档必须**真的重载**：档位是模块初始化时从 localStorage 读的，而
    // `Page.navigate` 到一个**与当前相同**的 URL 不会重新加载文档 —— 于是
    // localStorage 写了、页面却还停在上一档（第一版就是这么假通过了一条断言）。
    const setTier = async (tier) => {
      await evalJS(`localStorage.setItem('rein.perf.v1', ${JSON.stringify(tier)}); location.reload()`)
      await sleep(2600)
    }
    await setTier('extreme')
    await cdp('Page.navigate', { url: `${APP}/#/sports/exercises` })
    await waitFor(`document.querySelector('.exrow')`, 15000, '动作库列表（极致档）')
    await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.exrow')]
      const hit = rows.find((r) => /卧推|俯卧撑|飞鸟|夹胸/.test(r.textContent)) || rows[0]
      hit.querySelector('.main').click()
      return true
    })()`)
    await waitFor(`document.querySelector('.mapcard .mmap svg')`, 10000, '肌群图渲染（极致档）')
    await sleep(500)
    const extreme = await evalJS(BANDS)
    const tierNow = await evalJS(`document.documentElement.dataset.perf`)
    const blurPx = (s) => {
      const m = /blur\(([\d.]+)px\)/.exec(s)
      return m ? Number(m[1]) : null
    }
    ok('档位真的切到了极致（换档要重载，否则量到的还是上一档）', tierNow === 'extreme', `data-perf=${tierNow}`)
    // 索引与 band 编号一致：0 = 后层（最远）、1 = 中层、2 = 外层（最近），
    // 上面的 order 断言已经钉住这一点，所以下面直接按这个顺序读
    ok(
      '极致档 · 后层（最远、被盖得最实）加 2 个 CSS 像素的模糊',
      extreme.every((v) => {
        const b = blurPx(v.filters[0])
        const u = Number(v.unit)
        return b !== null && u > 1 && Math.abs(b - u * 2) < 0.6
      }),
      `后层 filter=${extreme[0]?.filters[0]} · --mmap-u=${extreme[0]?.unit}`,
    )
    ok(
      '极致档 · 中层加 1 个 CSS 像素的模糊（正好是后层的一半）',
      extreme.every((v) => {
        const mid = blurPx(v.filters[1])
        const far = blurPx(v.filters[0])
        return mid !== null && far !== null && Math.abs(far - mid * 2) < 1.2
      }),
      `中层=${extreme[0]?.filters[1]} · 后层=${extreme[0]?.filters[0]}`,
    )
    ok(
      '极致档 · 外层（没被表层覆盖）不加模糊 —— 只有被盖住的才有景深',
      extreme.every((v) => v.filters[2] === 'none' || v.filters[2] === ''),
      `外层 filter=${extreme[0]?.filters[2]}`,
    )
    ok(
      '极致档 · 分组的透明度梯度仍在（模糊是加在这条之上，不是换掉它）',
      extreme.every((v) => v.alpha[2] > v.alpha[1] && v.alpha[1] > v.alpha[0]),
      extreme.map((v) => v.alpha.map((a) => a.toFixed(2)).join('>')).join(' | '),
    )
    await evalJS(`localStorage.removeItem('rein.perf.v1')`)
    await evalJS('location.reload()')
    await sleep(2600)
    await cdp('Page.navigate', { url: `${APP}/#/sports/exercises` })
    await waitFor(`document.querySelector('.exrow')`, 15000, '动作库列表（收尾）')
    ok(
      '收尾 · 档位已回到默认（后面的用例不该还在极致档上）',
      (await evalJS(`document.documentElement.dataset.perf`)) !== 'extreme',
      `data-perf=${await evalJS(`document.documentElement.dataset.perf`)}`,
    )

    // 深层键：激活后必须真的看得见（叠画在浅层之上），否则「标了等于没标」
    await cdp('Page.navigate', { url: `${APP}/#/sports/exercises` })
    await waitFor(`document.querySelector('.exrow')`, 15000, '动作库列表（深层键用例）')
    const pickedDeep = await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.exrow')]
      const hit = rows.find((r) => /面拉/.test(r.textContent))
      if (!hit) return null
      hit.querySelector('.main').click()
      return hit.textContent.trim().slice(0, 20)
    })()`)
    ok('动作库含面拉（肩袖深层键用例）', !!pickedDeep, pickedDeep ?? '未找到')
    if (pickedDeep) {
      await waitFor(`document.querySelector('.mapcard .mmap svg')`, 10000, '肌群图渲染（面拉）')
      await sleep(300)
      const deepInfo = await evalJS(`(() => {
        const svgs = [...document.querySelectorAll('.mapcard .mmap .figwrap svg')]
        const cls = (el) => el.getAttribute('class') || ''
        const lv = (el) => /(^|\\s)l[123](\\s|$)/.test(cls(el))
        return {
          regions: svgs.map((s) => s.querySelectorAll('g[data-m="rotator-cuff"]').length),
          colored: svgs.map((s) => [...s.querySelectorAll('g[data-m="rotator-cuff"]')].filter(lv).length),
          overlays: svgs.map((s) => s.querySelectorAll('g.overlay').length),
          overlayColored: svgs.map((s) => [...s.querySelectorAll('g.overlay')].filter(lv).length),
        }
      })()`)
      ok(
        '深层键（肩袖）有独立可高亮分区',
        deepInfo.regions.every((n) => n >= 1),
        JSON.stringify(deepInfo.regions),
      )
      ok(
        '深层键激活后按档位着色',
        deepInfo.colored.every((n) => n >= 1),
        JSON.stringify(deepInfo.colored),
      )
      ok(
        '深层键激活后出现叠加层（不被浅层盖住）',
        deepInfo.overlays.every((n) => n >= 1) && deepInfo.overlayColored.every((n) => n >= 1),
        JSON.stringify({ overlays: deepInfo.overlays, colored: deepInfo.overlayColored }),
      )
    }

    await cdp('Page.navigate', { url: `${APP}/#/sports/exercises` })
    await waitFor(`document.querySelector('.exrow')`, 15000, '动作库列表（截图用）')
    await evalJS(`(() => {
      const rows = [...document.querySelectorAll('.exrow')]
      const hit = rows.find((r) => /卧推|俯卧撑|飞鸟|夹胸/.test(r.textContent)) || rows[0]
      hit.querySelector('.main').click()
      return true
    })()`)
    await waitFor(`document.querySelector('.mapcard .mmap svg')`, 10000, '肌群图渲染（截图用）')
    await sleep(250)

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
