/**
 * AI 语音输入端到端（/ai → 输入框麦克风按钮 → VoiceInputMask）：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-ai-voice-input.mjs
 * 前置：npm run dev（默认 1420；端口被排除或并发会话时用 REIN_E2E_URL 指向独立实例）
 *
 * 覆盖这条链路：按住说话（松开上屏）/ 轻点说话（转入连听 → 遮罩常显 → 手动点遮罩停止）
 * → 识别文字追加进输入框（中英文空格规则）→ 遮罩渐出回收 → 取消不动草稿。
 * 假麦克风走 --use-fake-device-for-media-stream（真实音频在无头环境拿不到）；
 * mock ASR 按脚本节奏伪造 partial/final 事件（mock/server.ts voice_asr_start），
 * 停止信号（音量 VAD）在假麦克风的持续音调下不会自动触发，自动结束路径由真机验证。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内，可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9338)
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-aivoice-${Date.now()}`
const SHOT_DIR = process.env.TEMP ?? '.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- CDP ---------------- */

let ws
let msgId = 0
const pending = new Map()

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r?.result?.value
}

async function waitFor(expr, timeoutMs = 9000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(`Boolean(${expr})`)) return true
    } catch { /* 上下文销毁（HMR）时重试 */ }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function shot(name) {
  await evalJS('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (!r?.data) return null
  const file = `${SHOT_DIR}/rein-aivoice-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`      [截图] ${file}`)
  return file
}

/** 在麦克风按钮上派发 pointerdown（松开由调用方控制：窗口级监听结算） */
async function voiceDown() {
  return evalJS(`(() => {
    const b = document.querySelector('[data-testid="ai-voice-btn"]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 }))
    return true
  })()`)
}

async function voiceUp() {
  return evalJS(`(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 }))
    return true
  })()`)
}

async function draftValue() {
  return evalJS(`document.querySelector('.inbar textarea')?.value ?? null`)
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,932',
    // 假麦克风：无头环境拿不到真实音频设备；假 UI 自动授权 getUserMedia
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    'about:blank',
  ])
  await sleep(1800)

  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    const target = await res.json()
    await sleep(300)
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
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

    await cdp('Page.navigate', { url: APP })
    await waitFor("document.readyState === 'complete'", 15000, '应用加载')
    await sleep(1200)

    /* ---------- 纯函数契约：中英文邻接的空格规则 ---------- */
    const join = await evalJS(`(async () => {
      const m = await import('/src/system/aiVoiceInput.ts')
      return [m.appendVoiceText('今天', '吃了饭'), m.appendVoiceText('call me', 'later'), m.appendVoiceText('', '你好')]
    })()`)
    ok('拼接：中文相邻不加空格', join?.[0] === '今天吃了饭', join?.[0])
    ok('拼接：英文相邻补空格', join?.[1] === 'call me later', join?.[1])
    ok('拼接：空起点直接落文字', join?.[2] === '你好', join?.[2])

    /* ---------- mock 默认未配置 ASR：先存一份凭据（真链路会先查 configStatus 快失败） ---------- */
    const cfg = await evalJS(`(async () => {
      const { voiceService } = await import('/src/services/voiceService.ts')
      await voiceService.configSave({
        mode: 'legacy', appKey: 'e2e', accessKey: 'e2e', asrAdapter: 'auto', asrAdapterUserPicked: false,
        asrBaseUrl: '', asrResourceId: 'volc.seedasr.sauc.duration', ttsResourceId: 'seed-tts-2.0',
        ttsCredential: null, voiceName: '', speed: 1,
      })
      const st = await voiceService.configStatus()
      return st.asrReady === true
    })()`)
    ok('mock：ASR 凭据已配置', cfg === true)

    /* ---------- 入口：麦克风按钮 ---------- */
    await evalJS("location.hash = '#/ai'")
    await waitFor(`document.querySelector('[data-testid="ai-voice-btn"]')`, 8000, '麦克风按钮')
    ok('输入栏有麦克风按钮', true)
    const before = await draftValue()

    /* ---------- 轻点：转入连听，遮罩渐入并常显 ---------- */
    ok('按下开始采集', await voiceDown() === true)
    await sleep(120)
    await voiceUp()
    await waitFor(`document.querySelector('[data-testid="ai-voice-mask"]')`, 6000, '遮罩出现')
    const modeTap = await evalJS(`document.querySelector('[data-testid="ai-voice-mode"]')?.textContent?.trim()`)
    ok('轻点后模式=轻点说话（连听）', modeTap === '轻点说话', modeTap)
    ok('连听模式有取消按钮', Boolean(await evalJS(`document.querySelector('[data-testid="ai-voice-cancel"]')`)))
    await sleep(2600) // mock 首句 final 在 700ms，留足时间
    const preview = await evalJS(`document.querySelector('[data-testid="ai-voice-text"]')?.textContent ?? ''`)
    ok('遮罩里看到转写', preview.includes('鸡胸肉汉堡'), preview.slice(0, 24))
    await shot('listening')

    /* ---------- 连听中点遮罩 = 手动停止：文字上屏、遮罩回收 ---------- */
    await evalJS(`document.querySelector('[data-testid="ai-voice-mask"]').click()`)
    await waitFor(`!document.querySelector('[data-testid="ai-voice-mask"]')`, 8000, '遮罩回收')
    ok('停止后遮罩已移除', true)
    await waitFor(`(document.querySelector('.inbar textarea')?.value ?? '').includes('鸡胸肉汉堡')`, 8000, '文字上屏')
    const afterTap = await draftValue()
    ok('识别文字进了输入框', (afterTap ?? '').length > (before ?? '').length, `len ${before?.length}→${afterTap?.length}`)

    /* ---------- 按住：按住 ≥ 阈值松开 = 立即结束（遮罩消失） ---------- */
    ok('再次按下', await voiceDown() === true)
    await sleep(900) // 超过 VOICE_TAP_MS(320)，判定为按住
    await voiceUp()
    await waitFor(`!document.querySelector('[data-testid="ai-voice-mask"]')`, 8000, '按住松开后遮罩回收')
    await waitFor(`(document.querySelector('.inbar textarea')?.value ?? '').length > ${afterTap.length}`, 8000, '按住内容追加')
    const afterHold = await draftValue()
    ok('按住松开：内容继续追加', (afterHold ?? '').length > (afterTap ?? '').length)
    await shot('committed')

    /* ---------- 取消：丢弃本次内容 ---------- */
    ok('第三次按下', await voiceDown() === true)
    await sleep(120)
    await voiceUp()
    await waitFor(`document.querySelector('[data-testid="ai-voice-mask"]')`, 6000, '遮罩再现')
    await sleep(900) // 让 mock 出几句话，确认取消真的丢掉
    await evalJS(`document.querySelector('[data-testid="ai-voice-cancel"]').click()`)
    await waitFor(`!document.querySelector('[data-testid="ai-voice-mask"]')`, 8000, '取消后遮罩回收')
    const afterCancel = await draftValue()
    ok('取消：草稿保持不变', afterCancel === afterHold, `len ${afterHold?.length}→${afterCancel?.length}`)
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    edge.kill()
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 通过`)
    if (failed.length) {
      console.log('失败项：')
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('运行失败：', e)
    process.exit(1)
  })
