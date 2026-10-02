/**
 * 右侧历史抽屉 · 玻璃材质的逐元素可读性实测。
 *
 * 两个必须做对的地方（第一版脚本都做错了，记在这里免得再犯）：
 *
 * 1. **颜色不能用正则抠数字**。令牌里 `#hex` 与 `rgba()` 混着写，
 *    对 `#1d1d1f` 用 `[\d.]+` 会抠出 `[1,1,1]` —— 数字看着合理、其实是错的。
 *    这里统一用 canvas 的 `fillStyle` + `getImageData` 归一化。
 *
 * 2. **要按元素回溯它的真实底**，不能拿"玻璃底"一把尺子量所有文字。
 *    抽屉里多数文字坐在 `.dk-item` 的 `--surface-2` chip 上（不透明），
 *    真正直接压在玻璃上的只有标题 —— 只用玻璃底去算，会把 chip 上的文字
 *    也判成"不可读"，得出错误结论（第一版就报了 text-2 只有 1.37:1）。
 *
 * 每个元素从自己往上走到面板，把沿途每个非透明背景依次叠起来；
 * 面板这一层的玻璃底按**背后内容的两个极端**（纯白 / 纯黑正文）各算一次，
 * 取较差值 —— 玻璃背后的东西会变，只看一种背景等于没测。
 *
 * 运行：node scripts/colorlab/audit_history_drawer.mjs
 */
import { chromium } from 'playwright-core'

const URL = process.env.REIN_E2E_URL ?? 'http://127.0.0.1:1420'
/**
 * 逐个取样点 + **它自己的门槛**（门槛表在文件下方 `MIN`，判定时用）。
 *
 * 门槛必须跟着令牌走，不能一把尺子量到底：同一个抽屉里
 * `--text-1`（正文，7:1）、`--text-2`（次要，4.5:1）、`--text-3`（三级，3:1）、
 * `--accent-strong`（选中态文字，4.5:1）、`--on-accent`（实底上的前景，4.5:1）
 * 各有各的定位 —— 拿正文的 7:1 去量选中态，会把一个**按设计成立**的 4.6:1
 * 报成不达标（2026-10-02 第一版就这么误报过一次）。
 * 门槛出处：docs/design/home-color-palettes.md 的「门槛」表 + tokens.css 各令牌注释。
 */
const MIN = {
  'text-1': 7,
  'text-2': 4.5,
  'text-3': 3,
  'accent-strong': 4.5,
  'on-accent': 4.5,
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
})

const PROBE = () => {
  /** 取样点：选中项与未选中项都要量 —— 它们底不同（浅蓝 vs 中性灰），结论也不同 */
  const SAMPLES = [
    { sel: '.dk-head h2', token: 'text-1', name: '标题「历史记录」' },
    { sel: '.dk-item.on .dk-title', token: 'accent-strong', name: '会话标题（选中）' },
    { sel: '.dk-item.on .dk-time', token: 'text-2', name: '会话时间（选中）' },
    { sel: '.dk-item:not(.on) .dk-title', token: 'text-1', name: '会话标题（未选中）' },
    { sel: '.dk-item:not(.on) .dk-time', token: 'text-3', name: '会话时间（未选中）' },
    { sel: '.dk-new', token: 'on-accent', name: '「新对话」按钮文字' },
  ]
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d')
  /** 任意 CSS 颜色 → [r,g,b,a]（a 为 0..1）；canvas 负责解析 hex / rgba / color-mix */
  const norm = (s) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = s
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const lum = ([r, g, b]) => {
    const f = (c) => {
      c /= 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
  }
  const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]))

  const cs = getComputedStyle(document.documentElement)
  const panel = document.querySelector('.dk-panel')
  const pcs0 = getComputedStyle(panel)
  // ⚠️ `--glass-fill` 要读**面板自己的**计算值，不是 `:root` 的。
  // 抽屉就地为可读性换过浓度（`.dk-panel` 上覆盖了 `--glass-fill`），
  // 从 `:root` 读会一直拿到出厂那一份，于是"改了浓度"这件事在报告里看不出来
  // ——探针自己骗自己（2026-10-02 第一版就这么漏掉了覆盖）。
  const glassFill = norm(pcs0.getPropertyValue('--glass-fill').trim())
  const scrim = norm(cs.getPropertyValue('--scrim').trim())

  /** 玻璃底：glass-fill 叠在（scrim 叠在背后内容）之上 */
  const glassOver = (content) => over(glassFill, over(scrim, content))
  const GLASS_BG = { '背后=浅色正文': glassOver([255, 255, 255]), '背后=深色正文': glassOver([0, 0, 0]) }

  /** 从 el 到 panel 之间所有祖先的背景，自外向内叠在 base 上 */
  function effBg(el, base) {
    const chain = []
    let n = el
    while (n && n !== panel.parentElement) {
      chain.push(n)
      if (n === panel) break
      n = n.parentElement
    }
    // 自外向内叠：panel 的底已经是 base（玻璃），只叠它里面那些
    let bg = base
    for (const node of chain.reverse()) {
      if (node === panel) continue
      const s = getComputedStyle(node)
      const c = norm(s.backgroundColor)
      if (c[3] > 0) bg = over(c, bg)
    }
    return bg
  }

  const rows = []
  for (const [bgName, base] of Object.entries(GLASS_BG)) {
    for (const s of SAMPLES) {
      const el = document.querySelector(s.sel)
      if (!el) continue
      const ecs = getComputedStyle(el)
      const col = norm(ecs.color)
      const bg = effBg(el, base)
      const fg = col[3] < 1 ? over(col, bg) : col.slice(0, 3)
      rows.push({
        bg: bgName,
        sample: s.name,
        token: s.token,
        bgRGB: bg.map(Math.round),
        fgRGB: fg.map(Math.round),
        ratio: +ratio(fg, bg).toFixed(2),
      })
    }
  }
  return {
    rows,
    facts: {
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      glassFill: glassFill.map((x, i) => (i === 3 ? +x.toFixed(2) : Math.round(x))),
      scrim: scrim.map((x, i) => (i === 3 ? +x.toFixed(2) : Math.round(x))),
      blur: (getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter || 'none').slice(0, 32),
      bgIsGlass: getComputedStyle(panel).backgroundImage.includes('gradient'),
      radius: getComputedStyle(panel).borderRadius,
      rect: (() => {
        const r = panel.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
      })(),
      itemBg: (() => {
        const it = document.querySelector('.dk-item')
        return it
          ? norm(getComputedStyle(it).backgroundColor).map((x, i) => (i === 3 ? +x.toFixed(2) : Math.round(x)))
          : null
      })(),
      itemCount: document.querySelectorAll('.dk-item').length,
    },
  }
}

async function run(colorScheme) {
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    colorScheme,
  })
  // 全新 profile 里没有会话，抽屉会是空的 —— 那里恰好测不到「会话标题」这一项，
  // 而这正是最需要看的一行（它坐在 .dk-item 的 chip 上）。
  await page.addInitScript(() => {
    const now = new Date().toISOString()
    const mk = (id, title) => ({
      id,
      seq: 1,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: `${id}-m1`,
          chatId: id,
          seq: 1,
          role: 'user',
          kind: 'text',
          text: '用于可读性实测的一条消息',
          imageBase64: null,
          mime: null,
          payload: null,
        },
      ],
    })
    localStorage.setItem(
      'rein.mock.ai_chats.v1',
      JSON.stringify([mk('a', '本周训练安排与容量复盘'), mk('b', '午饭吃了什么'), mk('c', '膝盖的旧记录')]),
    )
  })
  await page.goto(URL + '/#/ai', { waitUntil: 'load' })
  await page.waitForTimeout(2600)
  await page.evaluate(() =>
    document.querySelectorAll('.up-backdrop,.up-card').forEach((n) => {
      if (n instanceof HTMLElement) n.style.display = 'none'
    }),
  )
  await page.evaluate(() => document.querySelector('button[aria-label="历史"]')?.click())
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.panel .item')].find((i) =>
      i.querySelector('.lbl')?.textContent.includes('历史会话'),
    )
    it?.click()
  })
  await page.waitForTimeout(1400)
  const r = await page.evaluate(PROBE)
  console.log(`\n=== ${colorScheme} ===`)
  console.log('事实:', JSON.stringify(r.facts))
  for (const row of r.rows) {
    console.log(
      `  ${row.bg.padEnd(12)} ${row.sample.padEnd(16)} fg=${row.fgRGB.join(',').padEnd(12)} bg=${row.bgRGB
        .join(',')
        .padEnd(12)} ${String(row.ratio).padStart(7)}:1`,
    )
  }
  await page.screenshot({ path: `docs/design/colorlab/shot-history-drawer-${colorScheme}.png` })
  await page.close()
  return r
}

const light = await run('light')
const dark = await run('dark')
await browser.close()

console.log('\n=== 判定（同一元素在两种背景下的较差值） ===')
let bad = 0
const bySample = new Map()
for (const r of [...light.rows, ...dark.rows]) {
  const key = `${r.sample}`
  const prev = bySample.get(key)
  if (!prev || r.ratio < prev.ratio) bySample.set(key, r)
}
for (const [name, worst] of bySample) {
  const ok = worst.ratio >= MIN[worst.token]
  if (!ok) bad++
  console.log(`  ${name.padEnd(16)} ${worst.token.padEnd(7)} 最差 ${String(worst.ratio).padStart(6)}:1 (门槛 ${MIN[worst.token]}) ${ok ? '✓' : '✗'}`)
}
console.log(bad ? `\n✗ ${bad} 处不达标` : '\n✓ 全部达标')
process.exit(bad ? 1 : 0)
