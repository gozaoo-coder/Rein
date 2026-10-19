/**
 * 爆点抽帧 + 拼贴。
 *
 * 每个爆点抓一张「停留中段」的静帧（进入已结束、退场未开始），
 * 再拼成一张 contact sheet —— 审核代理先看整张拼贴建立全局印象，
 * 再看自己被分配的那几张单帧抠细节。
 *
 * 用法：node render/shots.mjs [--hold=0.5] [--no-build]
 * 产物：promo/out/beats/NN-<id>.png + promo/out/contact-sheet.jpg + promo/out/beats.json
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import { launch, waitReady } from './browser.mjs'
import { serve } from './serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'out')
const BEATS = join(OUT, 'beats')
const BEATS_SM = join(OUT, 'beats-sm')
const reviewers = JSON.parse(readFileSync(join(ROOT, 'review', 'reviewers.json'), 'utf8'))

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

function findFfmpeg() {
  for (const p of [process.env.FFMPEG, 'C:/ProgramData/chocolatey/bin/ffmpeg.exe', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    if (p && existsSync(p)) return p
  }
  return 'ffmpeg'
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
      // 停留中段：进入 0.5s 结束后再往后退一点，避开退场
      const t = b.at + Math.min(hold, Math.max(0.35, b.dur * 0.55))
      await page.evaluate((tt) => globalThis.__promo.seek(tt), t)
      // 纯序号命名：ffmpeg 的 image2 序列（%02d）在 Windows 上比 glob 可靠
      const file = join(BEATS, `${String(i).padStart(2, '0')}.png`)
      await page.screenshot({ path: file, type: 'png' })
      rows.push({ index: i, id: b.id, label: b.label, at: b.at, dur: b.dur, holdAt: Number(t.toFixed(3)), file: `beats/${String(i).padStart(2, '0')}.png` })
      process.stdout.write(`\r  抽帧 ${i + 1}/${beats.length}   `)
    }
    process.stdout.write('\n')
  } finally {
    await browser.close()
    await srv.close()
  }

  const ffmpeg = findFfmpeg()

  // 审核代理读的是**降采样版**（1280×720）：10 张 1080p PNG 的请求体太大，
  // 实测在并发下会大批量撞 API 连接失败；降到 720p 后判定质量不掉，成功率明显回升。
  // 全分辨率的 beats/ 留着给人看（read_file 逐张核）。
  if (existsSync(BEATS_SM)) rmSync(BEATS_SM, { recursive: true, force: true })
  mkdirSync(BEATS_SM, { recursive: true })
  await run(ffmpeg, ['-y', '-v', 'error', '-i', join(BEATS, '%02d.png'), '-vf', 'scale=1280:720', join(BEATS_SM, '%02d.png')])

  const sm = readdirSync(BEATS_SM)
    .filter((f) => f.endsWith('.png'))
    .sort()

  writeFileSync(join(OUT, 'beats.json'), JSON.stringify({ beats: rows }, null, 2))
  writeFileSync(
    join(OUT, 'review-manifest.json'),
    JSON.stringify(
      {
        subject: 'Rein 宣传片',
        contactSheet: join(OUT, 'contact-sheet.jpg'),
        items: rows.map((r, i) => ({
          id: r.id,
          label: r.label,
          at: r.at,
          image: join(BEATS_SM, sm[i]),
          full: join(BEATS, `${String(r.index).padStart(2, '0')}.png`),
        })),
        lenses: reviewers.video.lenses,
        criticsPerLens: reviewers.video.criticsPerLens,
      },
      null,
      2,
    ),
  )

  const cols = Math.min(6, Math.max(1, rows.length))
  const rowsCount = Math.ceil(rows.length / cols)
  const sheet = join(OUT, 'contact-sheet.jpg')
  await run(findFfmpeg(), [
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
  console.log(`✓ 抽帧完成：${rows.length} 张 → ${BEATS}`)
  console.log(`✓ 拼贴：${sheet}`)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
