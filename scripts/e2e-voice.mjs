/**
 * 语音对话端到端：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：E2E_CDP_PORT=9444 REIN_E2E_URL=http://localhost:1740 node scripts/e2e-voice.mjs
 *
 * mock 侧伪造豆包 ASR 事件流（4 句压缩到 ~3.4s）与 TTS 音频，
 * 无 AI 模型场景下纪要走「仅转写」兜底（标题=语音 HH:MM、无总结条目），
 * 覆盖：主页入口 → 未配置引导 → 配置语音服务 → 录音转写 → 完成整理 →
 *       纪要详情（全览/转文字）→ 全部纪要 → AI 页语音气泡 → @纪要 →
 *       收起浮条后台转写 → 取消流不落纪要。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9333)
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-voice-${Date.now()}`

import { spawn } from 'node:child_process'

const results = []
let ws
let msgId = 0
const pending = new Map()

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 6000, label = expr.slice(0, 50)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

/** v-model 输入：赋值 + input 事件 */
async function typeInput(selector, value) {
  return evalJS(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return false
    el.value = ${JSON.stringify(value)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

/** 按序号填表单输入（v-model 靠 input 事件同步） */
async function typeInputAt(index, value) {
  return evalJS(`(() => {
    const el = document.querySelectorAll('.form input')[${index}]
    if (!el) return false
    el.value = ${JSON.stringify(value)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function clickButton(text, scope = 'body') {
  return evalJS(`(() => {
    const t = ${JSON.stringify(text)}
    const els = [...document.querySelectorAll('${scope} button')]
    const el = els.find(b => (b.textContent.includes(t) || (b.getAttribute('aria-label') ?? '').includes(t)) && b.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  })()`)
}

async function goto(hash) {
  await evalJS(`location.hash = '${hash}'`)
  await sleep(500)
}

async function connect(pageTargetUrl) {
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
  await cdp('Page.navigate', { url: pageTargetUrl })
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`, '--no-first-run', '--window-size=430,932',
    // Chromium 假麦克风设备：真实 getUserMedia 返回带音轨的 MediaStream（正弦音），Worklet 采集链路真实可用
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    await sleep(1500)
    await connect(`${APP}/#/`)
    await sleep(1500)
    await evalJS(`(() => {
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push(String(e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)))
      return true
    })()`)

    /* ---------- A. 主页入口与未配置引导 ---------- */
    ok('A1 主页工具格有语音对话小卡', await evalJS(
      `[...document.querySelectorAll('.tool')].some(t => t.textContent.includes('语音对话'))`,
    ))
    ok('A2 点语音对话 → 未配置引导进模型页', await (async () => {
      await clickButton('语音对话')
      await sleep(900)
      const hash = await evalJS('location.hash')
      const toastHit = await evalJS(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('豆包语音服务'))`)
      return String(hash).includes('/ai/models') && toastHit
    })())

    /* ---------- B. 配置豆包语音服务 ---------- */
    ok('B1 语音服务卡渲染（未配置态）', await evalJS(
      `!!document.querySelector('.vcfg') && !!document.querySelector('.vcfg .v-no')`,
    ))
    await evalJS(`document.querySelector('.vcfg')?.click()`)
    await waitFor(`!!document.querySelector('.form input')`, 5000, '语音配置抽屉')
    await typeInputAt(1, '123456789') // 旧版模式：App ID（inputs[0] = baseURL）
    await typeInputAt(2, 'my-access-token') // Access Token
    ok('B2 保存语音配置', await (async () => {
      await clickButton('保存')
      await sleep(700)
      return evalJS(`!!document.querySelector('.vcfg .v-ok')`)
    })())

    /* ---------- C. 录音转写 → 完成整理 ---------- */
    await goto('/')
    await sleep(600)
    ok('C1 点语音对话 → 会话视图待机态', await (async () => {
      await clickButton('语音对话')
      await waitFor(`!!document.querySelector('.vs-root')`, 5000, '语音会话视图')
      return evalJS(`!!document.querySelector('.ready-orb') && !!document.querySelector('[aria-label="开始说话"]')`)
    })())
    ok('C2 开始录音 → 转写态（状态带 + 计时）', await (async () => {
      await clickButton('开始说话')
      await waitFor(`!!document.querySelector('.vs-root .live')`, 5000, '转写状态带')
      return evalJS(`!!document.querySelector('.vs-root .live .time')`)
    })())
    ok('C3 mock 转写逐句上屏（4 句）', await (async () => {
      await waitFor(`document.querySelectorAll('.vs-root .tr .tl:not(.partial)').length >= 4`, 9000, '4 句定稿')
      return evalJS(`document.querySelectorAll('.vs-root .tr .tl:not(.partial)').length >= 4`)
    })())
    ok('C4 收起浮条（后台转写）', await (async () => {
      await evalJS(`document.querySelector('[aria-label="收起为浮条"]')?.click()`)
      await sleep(500)
      const hidden = await evalJS(`!document.querySelector('.vs-root')`)
      const bar = await evalJS(`!!document.querySelector('.vdock-root') && [...document.querySelectorAll('.vdock-root .info')].some(e => e.textContent.includes('转写中'))`)
      return hidden && bar
    })())
    ok('C5 浮条「完成」→ 纪要详情（整理完成）', await (async () => {
      await evalJS(`[...document.querySelectorAll('.vdock-root button')].find(b => b.textContent.includes('完成'))?.click()`)
      await waitFor(`!!document.querySelector('.vm-head')`, 6000, '纪要详情')
      await sleep(600)
      return evalJS(`!document.querySelector('.vdock-root') && !!document.querySelector('.vm-head b')`)
    })())
    const title = await evalJS(`document.querySelector('.vm-head b')?.textContent`)
    ok('C6 纪要标题自动生成（无模型兜底「语音 HH:MM」）', typeof title === 'string' && title.startsWith('语音'), title)

    /* ---------- D. 纪要详情：全览 / 转文字 ---------- */
    ok('D1 全览页：无模型兜底提示 + 无重放条（mock 无音频）', await evalJS(
      `!!document.querySelector('.body .vs-hint') && !document.querySelector('.player')`,
    ))
    ok('D2 切「转文字」→ 逐句 item 渲染', await (async () => {
      await clickButton('转文字')
      await sleep(400)
      return evalJS(`document.querySelectorAll('.tr-sec .tl.seek').length >= 4`)
    })())
    ok('D3 句子含音频偏移时间戳', await evalJS(
      `[...document.querySelectorAll('.tr-sec .tl.seek time')].some(t => /^0?\\d:\\d\\d$/.test(t.textContent.trim()))`,
    ))

    /* ---------- E. 全部纪要 ---------- */
    ok('E1 全部纪要入口 → 列表 1 条', await (async () => {
      await clickButton('全部纪要')
      await waitFor(`[...document.querySelectorAll('.list .row')].length >= 1`, 5000, '纪要列表')
      return evalJS(`[...document.querySelectorAll('.list .row')].length >= 1`)
    })())
    ok('E2 点条目 → 打开该纪要详情', await (async () => {
      await evalJS(`document.querySelector('.list .row')?.click()`)
      await sleep(600)
      return evalJS(`!!document.querySelector('.vm-head')`)
    })())

    /* ---------- F. AI 页：语音气泡 + @纪要 ---------- */
    await goto('/ai')
    await sleep(1000)
    ok('F1 语音轮气泡渲染（含纪要入口）', await evalJS(
      `!!document.querySelector('.voice-bub') && document.querySelector('.voice-bub .vb-head').textContent.includes('会议纪要')`,
    ))
    ok('F2 点语音气泡 → 打开对应纪要', await (async () => {
      await evalJS(`document.querySelector('.voice-bub')?.click()`)
      await waitFor(`!!document.querySelector('.vm-head')`, 5000, '语音视图纪要')
      return evalJS(`!!document.querySelector('.vm-head')`)
    })())
    // 回 AI 页测 @纪要
    await goto('/ai')
    await sleep(800)
    ok('F3 输入 @ 弹出纪要选择器', await (async () => {
      await typeInput('.inbar input', '@')
      await waitFor(`[...document.querySelectorAll('.head h2')].some(e => e.textContent === '引用纪要')`, 5000, '纪要选择器')
      return true
    })())
    ok('F4 选择纪要 → 出现 @chip', await (async () => {
      await waitFor(`document.querySelectorAll('.list .row').length >= 1`, 5000, '选择器行')
      await evalJS(`document.querySelector('.list .row')?.click()`)
      await waitFor(`!!document.querySelector('.memo-chip')`, 5000, 'chip')
      return true
    })())
    ok('F5 带 @chip 发送 → 用户消息入列', await (async () => {
      await typeInput('.inbar input', '按这份纪要帮我安排今天')
      await clickButton('发送')
      await sleep(1200)
      return evalJS(`[...document.querySelectorAll('.msg.user .bubble')].some(b => b.textContent.includes('按这份纪要帮我安排今天'))`)
    })())
    ok('F6 助手回复走 Markdown 渲染器', await evalJS(`!!document.querySelector('.msg.assistant .bubble .md')`))

    /* ---------- G. 取消流 ---------- */
    // E1 时列表应为 1 条（此前只完成过一次转写）
    ok('G1 录音后取消 → 不落纪要', await (async () => {
      await goto('/')
      await sleep(600)
      await clickButton('语音对话')
      await waitFor(`!!document.querySelector('.vs-root')`, 5000, '语音视图')
      await clickButton('开始说话')
      await waitFor(`!!document.querySelector('.vs-root .live')`, 5000, '转写态')
      await sleep(1200)
      await clickButton('取消')
      await sleep(600)
      // 打开全部纪要比对：仍应只有此前那 1 条
      await clickButton('全部纪要')
      await waitFor(`[...document.querySelectorAll('.list .row')].length >= 1`, 5000, '列表再开')
      const count = await evalJS(`[...document.querySelectorAll('.list .row')].length`)
      await evalJS(`document.querySelector('[aria-label="关闭"]')?.click()`)
      await sleep(400)
      return count === 1
    })())

    /* ---------- H. ASR 适配器双层自动选择 ---------- */
    await goto('/ai/models')
    await sleep(800)
    await evalJS(`document.querySelector('.vcfg')?.click()`)
    await waitFor(`!!document.querySelector('.form .mode-seg')`, 5000, '配置抽屉')
    // 第一层：自动模式下输入 Qwen baseURL → 程序自动替选 Qwen 并提示
    ok('H1 自动层：输入 qwen baseURL → 自动选中 Qwen + 提示', await (async () => {
      await typeInputAt(0, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference')
      await sleep(400)
      return evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        const qwenOn = [...seg.querySelectorAll('button')].find(b => b.textContent === 'Qwen')?.classList.contains('on')
        const notice = document.querySelector('.form .auto-notice')?.textContent ?? ''
        return !!qwenOn && notice.includes('Qwen')
      })()`)
    })())
    // 自动层换向：qwen 删了填 doubao → 撤回并改选豆包
    ok('H2 自动层换向：填 doubao baseURL → 自动改选豆包', await (async () => {
      await typeInputAt(0, 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async')
      await sleep(400)
      return evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        const doubaoOn = [...seg.querySelectorAll('button')].find(b => b.textContent === '豆包')?.classList.contains('on')
        const notice = document.querySelector('.form .auto-notice')?.textContent ?? ''
        return !!doubaoOn && notice.includes('豆包')
      })()`)
    })())
    // 第二层：手动选 Qwen（touched）后 baseURL 指向 doubao → 只推荐不强改
    ok('H3 手选层：仅弹推荐气泡，不覆盖选择', await (async () => {
      await evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        ;[...seg.querySelectorAll('button')].find(b => b.textContent === 'Qwen')?.click()
      })()`)
      await sleep(300)
      const stillQwen = await evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        return [...seg.querySelectorAll('button')].find(b => b.textContent === 'Qwen')?.classList.contains('on')
      })()`)
      const bubble = await evalJS(`(() => {
        const s = document.querySelector('.form .suggestion')
        return !!s && s.textContent.includes('豆包') && !!s.querySelector('.sgo')
      })()`)
      return stillQwen && bubble
    })())
    ok('H4 点「切换到豆包」→ 接受推荐', await (async () => {
      await evalJS(`document.querySelector('.form .suggestion .sgo')?.click()`)
      await sleep(300)
      return evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        return [...seg.querySelectorAll('button')].find(b => b.textContent === '豆包')?.classList.contains('on') && !document.querySelector('.form .suggestion')
      })()`)
    })())
    ok('H5 「忽略」→ 气泡消失且选择保持', await (async () => {
      await evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        ;[...seg.querySelectorAll('button')].find(b => b.textContent === 'Qwen')?.click()
      })()`)
      await sleep(300)
      await evalJS(`document.querySelector('.form .suggestion .sgx')?.click()`)
      await sleep(300)
      return evalJS(`(() => {
        const seg = document.querySelector('.form .mode-seg')
        const qwenOn = [...seg.querySelectorAll('button')].find(b => b.textContent === 'Qwen')?.classList.contains('on')
        return !!qwenOn && !document.querySelector('.form .suggestion')
      })()`)
    })())
    // 不保存，关闭抽屉（保持原配置给后续用例）
    await evalJS(`document.querySelector('[aria-label="关闭"]')?.click()`)
    await sleep(500)

    /* ---------- 收尾 ---------- */
    const errs = await evalJS('window.__errs?.join(" | ") ?? ""')
    ok('Z0 无页面错误', errs === '', errs)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
    process.exitCode = failed.length > 0 ? 1 : 0
  } finally {
    // 关闭 Edge
    try {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json())
      for (const t of list) {
        if (String(t.url).startsWith(APP)) await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${t.id}`)
      }
    } catch { /* 忽略 */ }
    edge.kill()
  }
}

main().catch((e) => {
  console.error('E2E 执行失败:', e)
  process.exit(1)
})
