/**
 * 逐帧录制器。
 *
 * 为什么不用浏览器的实时录屏：这一片子的动效是**确定性时间轴**——
 * 页面暴露 window.__promo.seek(t)，所以我们按 t = i / fps 逐帧 seek 再截图，
 * 得到的是「与机器性能无关」的帧序列；掉帧、卡顿都不可能发生。
 * 再把帧序列交给 ffmpeg 编成 mp4。
 *
 * 用法：
 *   node render/record.mjs [--fps=30] [--scale=1] [--from=6] [--to=12]
 *                          [--keep-frames] [--no-build] [--webm] [--out=out/rein-promo.mp4]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { launch, waitReady } from './browser.mjs'
import { serve } from './serve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')
const FRAMES = join(ROOT, '.frames')
const OUT = join(ROOT, 'out')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

const FPS = Number(flag('fps', 60))
const SCALE = Number(flag('scale', 1))
const FROM = Number(flag('from', 0))
const KEEP = Boolean(flag('keep-frames', false))
const NO_BUILD = Boolean(flag('no-build', false))
const NO_MUSIC = Boolean(flag('no-music', false))
const WANT_WEBM = Boolean(flag('webm', false))
const OUT_FILE = resolve(ROOT, String(flag('out', join('out', 'rein-promo.mp4'))))
const MUSIC = join(ROOT, 'out', 'rein-promo.wav')

function findFfmpeg() {
  for (const p of [
    process.env.FFMPEG,
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ]) {
    if (p && existsSync(p)) return p
  }
  return 'ffmpeg'
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('error', fail)
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} 退出码 ${code}`))))
  })
}

async function main() {
  const ffmpeg = findFfmpeg()

  if (!NO_BUILD) {
    console.log('· vite build …')
    await build({ root: ROOT, logLevel: 'warn' })
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html 不存在，先跑 vite build（或去掉 --no-build）')
  }

  if (existsSync(FRAMES)) rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  mkdirSync(dirname(OUT_FILE), { recursive: true })

  const srv = await serve(DIST)
  const { browser, page } = await launch({ width: 1920, height: 1080, scale: SCALE })
  let failures = 0

  try {
    page.on('pageerror', (e) => {
      failures += 1
      console.error('  ✗ 页面异常：', e.message)
    })
    console.log(`· 打开 ${srv.url}`)
    await page.goto(srv.url, { waitUntil: 'load' })
    await waitReady(page)

    const meta = await page.evaluate(() => ({ duration: globalThis.__promo.duration, beats: globalThis.__promo.beats }))
    const total = meta.duration
    const to = Number(flag('to', total))
    const count = Math.max(1, Math.round((to - FROM) * FPS))
    console.log(`· 时长 ${total}s · 帧率 ${FPS} · 导出 ${FROM}s → ${to}s（${count} 帧）`)

    const t0 = Date.now()
    for (let i = 0; i < count; i += 1) {
      const t = FROM + i / FPS
      await page.evaluate((tt) => globalThis.__promo.seek(tt), t)
      const file = join(FRAMES, `f_${String(i + 1).padStart(5, '0')}.png`)
      await page.screenshot({ path: file, type: 'png' })
      if (i % 30 === 0 || i === count - 1) {
        const pct = (((i + 1) / count) * 100).toFixed(0)
        const el = ((Date.now() - t0) / 1000).toFixed(0)
        process.stdout.write(`\r  ${pct}%  (${i + 1}/${count})  ${el}s   `)
      }
    }
    process.stdout.write('\n')

    const poster = join(OUT, 'poster.png')
    await page.evaluate((tt) => globalThis.__promo.seek(tt), Math.min(1.1, total))
    await page.screenshot({ path: poster, type: 'png' })
  } finally {
    await browser.close()
    await srv.close()
  }

  if (failures) throw new Error(`渲染期有 ${failures} 条页面异常，先修好再出片`)

  const frames = readdirSync(FRAMES).filter((f) => f.endsWith('.png')).length
  if (!frames) throw new Error('没有截到任何帧')

  // 音轨：把 render/music.mjs 渲染出来的卡点配乐混进来（--no-music 可关；
  // 缺 wav 时自动跳过并告警，不阻塞出片）。
  const withMusic = !NO_MUSIC && existsSync(MUSIC)
  if (!NO_MUSIC && !existsSync(MUSIC)) {
    console.warn('· 没有找到 out/rein-promo.wav —— 先跑 `npm run music`。本次出无声片。')
  }

  console.log(`· ffmpeg 编码 → ${OUT_FILE}${withMusic ? '（含音轨）' : '（静音）'}`)
  const args = withMusic
    ? [
        '-y',
        '-framerate', String(FPS),
        '-i', join(FRAMES, 'f_%05d.png'),
        '-i', MUSIC,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '16',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-shortest',
        OUT_FILE,
      ]
    : [
        '-y',
        '-framerate', String(FPS),
        '-i', join(FRAMES, 'f_%05d.png'),
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '16',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        OUT_FILE,
      ]
  await run(ffmpeg, args)

  if (WANT_WEBM) {
    const webm = OUT_FILE.replace(/\.mp4$/, '.webm')
    console.log(`· ffmpeg 编码 webm → ${webm}`)
    await run(ffmpeg, ['-y', '-framerate', String(FPS), '-i', join(FRAMES, 'f_%05d.png'), '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', webm])
  }

  if (!KEEP) rmSync(FRAMES, { recursive: true, force: true })

  const size = (statSync(OUT_FILE).size / 1024 / 1024).toFixed(1)
  writeFileSync(
    join(OUT, 'render.json'),
    JSON.stringify({ file: OUT_FILE, fps: FPS, scale: SCALE, from: FROM, sizeMB: Number(size), at: new Date().toISOString() }, null, 2),
  )
  console.log(`✓ 完成：${OUT_FILE}（${size} MB）`)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
