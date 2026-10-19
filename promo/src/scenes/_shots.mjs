/**
 * 本地抽帧（仅 S-C 自测用，不参与宣传片产物）。
 *
 * render/shots.mjs 依赖 promo/review/reviewers.json，而该文件当前不是合法 JSON
 * （第 10/14/16 行的引号未转义），JSON.parse 直接抛错；本工作单只允许在
 * promo/src/scenes/ 下加文件，不能去改 review/。于是这里复刻同一套抽帧逻辑，
 * 唯一差别是不读花名册。
 *
 * 用法：node src/scenes/_shots.mjs [--hold=0.55] [--no-build]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { launch, waitReady } from '../../render/browser.mjs'
import { serve } from '../../render/serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'out')
const BEATS = join(OUT, 'beats')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const run = (cmd, args) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('error', fail)
    p.on('close', (c) => (c === 0 ? ok() : fail(new Error(`${cmd} 退出码 ${c}`))))
  })

async function main() {
  const hold = Number(flag('hold', 0.55))
  if (!flag('no-build', false)) await build({ root: ROOT, logLevel: 'warn' })

  if (existsSync(BEATS)) rmSync(BEATS, { recursive: true, force: true })
  mkdirSync(BEATS, { recursive: true })

  const srv = await serve(DIST)
  const { browser, page } = await launch({ width: 1920, height: 1080, scale: 1 })
  const rows = []
  try {
    await page.goto(srv.url, { waitUntil: 'load' })
    await waitReady(page)
    const beats = await page.evaluate(() => globalThis.__promo.beats)
    for (let i = 0; i < beats.length; i += 1) {
      const b = beats[i]
      const t = b.at + Math.min(hold, Math.max(0.35, b.dur * 0.55))
      await page.evaluate((tt) => globalThis.__promo.seek(tt), t)
      const file = join(BEATS, `${String(i).padStart(2, '0')}.png`)
      await page.screenshot({ path: file, type: 'png' })
      rows.push({ index: i, id: b.id, label: b.label, at: b.at, holdAt: Number(t.toFixed(3)) })
      process.stdout.write(`\r  抽帧 ${i + 1}/${beats.length}   `)
    }
    process.stdout.write('\n')
  } finally {
    await browser.close()
    await srv.close()
  }

  writeFileSync(join(OUT, 'beats-local.json'), JSON.stringify({ beats: rows }, null, 2))

  const cols = Math.min(6, Math.max(1, rows.length))
  const rowsCount = Math.ceil(rows.length / cols)
  const sheet = join(OUT, 'contact-sheet.jpg')
  try {
    await run('ffmpeg', [
      '-y',
      '-framerate', '1',
      '-start_number', '0',
      '-i', join(BEATS, '%02d.png'),
      '-vf', `scale=320:180,tile=${cols}x${rowsCount}:padding=6:color=0x111111`,
      '-frames:v', '1',
      '-update', '1',
      '-q:v', '3',
      sheet,
    ])
    console.log(`✓ 拼贴：${sheet}`)
  } catch (e) {
    console.warn(`! 拼贴跳过：${e.message}`)
  }
  console.log(`✓ 抽帧完成：${rows.length} 张 → ${BEATS}`)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
