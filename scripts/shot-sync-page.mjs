/**
 * 同步页外观检查：起无头 Edge 打开 #/settings/sync，亮/暗两色截图；
 * 再点一次「开码」，把配对后的状态也截下来（mock 会在第一次轮询时返回一台设备）。
 *
 *   node shot-sync-page.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.env.REIN_E2E_SHOTS || fileURLToPath(new URL('.', import.meta.url))
const PORT = 9411
const URL_BASE = 'http://localhost:5180/#/settings/sync'

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!EDGE) throw new Error('找不到 Edge')
  const userData = path.join(process.env.TEMP || '.', `rein-shot-${Date.now()}`)
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--disable-extensions',
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let target = null
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(300)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) throw new Error('连不上调试端口')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' })
    if (res?.data) {
      fs.writeFileSync(path.join(OUT, `sync-${name}.png`), Buffer.from(res.data, 'base64'))
      console.log('saved', `sync-${name}.png`)
    } else {
      console.log('shot failed', name, JSON.stringify(res))
    }
  }
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return res?.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 932,
    deviceScaleFactor: 2,
    mobile: true,
  })

  for (const theme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await send('Page.navigate', { url: `${URL_BASE}?theme=${theme}` })
    await sleep(2500)
    // 首启可能弹引导：能点掉就点掉
    await evaluate(`(() => {
      const words = ['稍后', '跳过', '知道了', '开始使用']
      for (const b of document.querySelectorAll('button')) {
        if (words.some((w) => (b.textContent || '').includes(w))) { b.click(); return 'dismissed' }
      }
      return 'none'
    })()`)
    await sleep(600)
    await shot(`${theme}-paired`)

    if (theme === 'light') {
      // 点「立即同步」：路径标签换成一条新路，并出现「这次走…」那一行
      await evaluate(`(() => {
        for (const b of document.querySelectorAll('button')) {
          if ((b.textContent || '').includes('立即同步')) { b.click(); return 'clicked' }
        }
        return 'no-button'
      })()`)
      await sleep(1600)
      await shot('light-synced')
    }
  }

  ws.close()
  child.kill()
  await sleep(300)
  console.log('done')
}

main().catch((e) => {
  console.error('probe failed:', e?.message ?? e)
  process.exit(1)
})
