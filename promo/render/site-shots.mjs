/**
 * 官网抽帧（给审核代理用）。
 *
 * 与视频不同，官网是**响应式页面**，所以每个视口各抽一遍：
 * 桌面 1440×900 与手机 430×932。区块按 `section[id]` 自动发现（不写死 id）。
 * 顺手把 console 错误与 4xx/5xx 请求记进 console.json —— 「构建产物完整性」
 * 那个维度需要的是**证据**，不是印象。
 *
 * 用法：node render/site-shots.mjs [--site=../site/dist] [--out=out/site]
 * 产物：promo/out/site/{desktop,mobile}/*.png + manifest.json + console.json
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './browser.mjs'
import { serve } from './serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const REPO = resolve(ROOT, '..')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const SITE = resolve(REPO, String(flag('site', join('site', 'dist'))))
const OUT = resolve(ROOT, String(flag('out', join('out', 'site'))))
const reviewers = JSON.parse(readFileSync(join(ROOT, 'review', 'reviewers.json'), 'utf8'))

const VIEWPORTS = [
  { id: 'desktop', label: '桌面', width: 1440, height: 900 },
  { id: 'mobile', label: '手机', width: 430, height: 932 },
]

async function main() {
  if (!existsSync(join(SITE, 'index.html'))) throw new Error(`站点产物不存在：${SITE}（先 cd site && npm run build）`)
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const srv = await serve(SITE)
  const { browser, page } = await launch({ width: 1440, height: 900, scale: 1 })
  const problems = []
  const items = []

  page.on('console', (m) => {
    if (m.type() === 'error') problems.push({ kind: 'console', text: m.text() })
  })
  page.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: e.message }))
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push({ kind: 'http', status: r.status(), url: r.url() })
  })

  try {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto(srv.url, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts?.ready)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)))

      const dir = join(OUT, vp.id)
      mkdirSync(dir, { recursive: true })

      // 首屏
      const hero = join(dir, '00-hero.png')
      await page.screenshot({ path: hero })
      items.push({ id: `${vp.id}-hero`, label: `${vp.label} · 首屏`, image: hero, at: 0 })

      // 逐区块（只认 section，index 与 nth-of-type 才对齐）
      const ids = await page.$$eval('section', (nodes) =>
        nodes.map((n, i) => ({
          id: n.id || `block-${i}`,
          label: (n.querySelector('h1,h2,h3')?.textContent || '').trim().slice(0, 24) || `区块 ${i}`,
        })),
      )
      for (let i = 0; i < ids.length; i += 1) {
        const el = await page.$(`section:nth-of-type(${i + 1})`)
        if (!el) continue
        const box = await el.boundingBox()
        if (!box || box.height < 40) continue
        const slug = ids[i].id.replace(/[^\w-]/g, '') || `block-${i}`
        const file = join(dir, `${String(i + 1).padStart(2, '0')}-${slug}.png`)
        await el.screenshot({ path: file })
        items.push({ id: `${vp.id}-${slug}`, label: `${vp.label} · ${ids[i].label}`, image: file, at: i + 1 })
      }

      // 整页（供总览）
      const full = join(dir, 'zz-full.png')
      await page.screenshot({ path: full, fullPage: true })
      items.push({ id: `${vp.id}-full`, label: `${vp.label} · 整页`, image: full, at: 99 })
      console.log(`  ${vp.label}：${items.length} 张`)
    }
  } finally {
    await browser.close()
    await srv.close()
  }

  writeFileSync(join(OUT, 'console.json'), JSON.stringify({ problems }, null, 2))

  const desktopItems = items.filter((i) => i.id.startsWith('desktop'))
  writeFileSync(
    join(OUT, 'manifest.json'),
    JSON.stringify(
      {
        subject: 'Rein 官网',
        contactSheet: desktopItems.find((i) => i.id === 'desktop-full')?.image ?? desktopItems[0]?.image,
        items,
        lenses: reviewers.site.lenses,
        criticsPerLens: reviewers.site.criticsPerLens,
        evidence: { console: join(OUT, 'console.json') },
      },
      null,
      2,
    ),
  )

  console.log(`✓ 官网抽帧 ${items.length} 张 → ${OUT}`)
  if (problems.length) {
    console.log(`⚠ 页面有 ${problems.length} 条问题（详见 console.json）：`)
    for (const p of problems.slice(0, 8)) console.log(`   - ${p.kind} ${p.status ?? ''} ${String(p.text ?? p.url).slice(0, 120)}`)
  } else {
    console.log('✓ 页面零 console 错误、零 4xx/5xx')
  }
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
