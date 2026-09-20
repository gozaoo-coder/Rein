/**
 * AI 虚拟工作区端到端（docs/ai-workspace.md v2）：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-ai-workspace.mjs   （前置：npm run dev 已在 1420，或用 REIN_E2E_URL 指向别的实例）
 *
 * 覆盖四条链路：
 *   A. 全量注入区 —— 系统提示词播种 / 用户记忆全量注入 / 预算与截断标记；
 *   B. 模态层 —— 上传本体（音频）→ 模态清单 → 取本体 / 不兼容模态降级为文本 / read_modal 工具；
 *   C. 目录治理 —— 收件箱 → classify_move 归类 → 审计 → pin 保护 → 撤销 → 保留区让位；
 *   D. UI —— AI 页左上角文件入口 → 文件管理器（命名空间、下钻、模态预览、钉住）。
 *
 * 浏览器 mock 与 Rust 实现同构（路径规则/降级链/治理约束都在两侧各跑一遍），断言在真实现上同样成立。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/** 本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），可用 E2E_CDP_PORT 换端口 */
const DEBUG_PORT = Number(process.env.E2E_CDP_PORT ?? 9334)
/** 目标应用地址：默认 1420；端口被系统排除或并发会话时用 REIN_E2E_URL 指向独立实例 */
const APP = process.env.REIN_E2E_URL ?? 'http://localhost:1420'
const USER_DATA = `${process.env.TEMP}/rein-e2e-workspace-${Date.now()}`

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
  if (r?.exceptionDetails) {
    throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  // 页面正在跳转（hash 变更 / HMR 重载）时上下文会被销毁，取不到 result —— 返回 undefined 交给调用方
  return r?.result?.value
}

/** 只读命令：上下文销毁时重试是安全的；写命令绝不能重试（会重复执行） */
const KB_READ_ONLY = new Set(['status', 'search', 'read', 'memories', 'glob', 'cognition', 'injection', 'fsMoves', 'mediaGet', 'fileGet', 'settingsGet', 'probeEmbedder', 'reindex'])

/** 页内调 kbService（UI 走的就是它）。只读调用带一次重试，抵御 dev 服务器 HMR 重载。 */
async function kb(method, ...args) {
  const expr = `(async () => {
    const { kbService } = await import('/src/services/kbService.ts')
    return await kbService[${JSON.stringify(method)}](${args.map((a) => JSON.stringify(a)).join(', ')})
  })()`
  const v = await evalJS(expr)
  return v === undefined && KB_READ_ONLY.has(method) ? evalJS(expr) : v
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(expr, timeoutMs = 8000, label = expr.slice(0, 60)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJS(`Boolean(${expr})`)
    if (v) return true
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

async function connect(url) {
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
  await cdp('Page.navigate', { url })
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    try {
      const href = await evalJS('location.href')
      if (String(href).startsWith(APP)) break
    } catch { /* 尚未就绪 */ }
    await sleep(250)
  }
}

/** 页内调 kbService（UI 走的就是它） —— 见上方带重试的实现 */

/** 只读工具：重试安全。写类工具（mediaWrite/classify_move/pin_file/make_folder）不重试 */
const TOOL_READ_ONLY = new Set(['search_knowledge', 'read_knowledge', 'glob_knowledge', 'list_memories', 'read_modal'])

/** 页内调某个 AI 工具的 execute（与模型调用同一条路径） */
async function runTool(name, args) {
  const expr = `(async () => {
    const { findAppTool } = await import('/src/ai/tools/registry.ts')
    const t = findAppTool(${JSON.stringify(name)})
    if (!t) throw new Error('工具不存在: ${name}')
    return await t.execute(${JSON.stringify(args)})
  })()`
  const v = await evalJS(expr)
  return v === undefined && TOOL_READ_ONLY.has(name) ? evalJS(expr) : v
}

/** 1 秒静音 wav 的 data URL（真实音频本体，浏览器里可解码播放） */
const WAV_B64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-first-run',
    '--window-size=430,900',
    'about:blank',
  ])
  await sleep(1800)

  try {
    await connect(APP)
    await waitFor("document.querySelector('h1')", 12000, '应用挂载')
    await sleep(600)

    /* ---------- A. 全量注入区 ---------- */

    const inj0 = await kb('injection')
    ok(
      '注入：系统提示词已播种并进入注入块',
      inj0.system.includes('系统提示词/角色与语气.md') && inj0.system.includes('Rein AI'),
      inj0.files.map((f) => f.path).join(', '),
    )
    ok('注入：预算为 12000 字符且未超限', inj0.budget === 12000 && inj0.truncated === false, `total=${inj0.totalChars}`)
    ok('注入：用户记忆模板（纯注释）不占预算', !inj0.memory.includes('角色设定'), '')

    await kb('fileWrite', { path: '用户记忆/角色设定.md', content: '用户是程序员，回答要简洁，直接给结论。' })
    await kb('fileWrite', { path: '用户记忆/全局规范.md', content: '所有回复用简体中文。' })
    const inj1 = await kb('injection')
    ok(
      '注入：写进 用户记忆/ 的内容每轮全量注入',
      inj1.memory.includes('程序员') && inj1.memory.includes('简体中文'),
      '',
    )
    const order1 = inj1.memory.indexOf('程序员')
    const order2 = inj1.memory.indexOf('简体中文')
    ok('注入：角色设定优先于全局规范', order1 >= 0 && order2 > order1, `role@${order1} rules@${order2}`)

    const longMemory = '很长的规范。'.repeat(4000)
    await kb('fileWrite', { path: '用户记忆/角色设定.md', content: longMemory })
    const inj2 = await kb('injection')
    ok('注入：超预算时截断并标记', inj2.truncated === true && inj2.totalChars <= inj2.budget + 200, `total=${inj2.totalChars}`)
    ok('注入：被截断的文件有 truncated 标记', inj2.files.some((f) => f.truncated), '')
    await kb('fileWrite', { path: '用户记忆/角色设定.md', content: '用户是程序员，回答要简洁。' })

    /* ---------- B. 模态层 ---------- */

    // 上传一段音频本体：文本模态（转录）自动成为可检索内容，本体落引用
    const media = await kb('mediaWrite', {
      path: '未分类数据/晨会录音.wav',
      name: '晨会录音.wav',
      mime: 'audio/wav',
      dataBase64: `data:audio/wav;base64,${WAV_B64}`,
      text: '周一晨会：确认本周排班与训练计划。',
    })
    ok('模态：多模态节点落库', media.kind === 'multimodal' && media.path === '未分类数据/晨会录音.wav', media.path)
    ok(
      '模态：文件节点带本体模态（音频）',
      media.modalities.some((m) => m.modal === 'audio'),
      media.modalities.map((m) => m.modal).join(','),
    )
    ok('模态：未转写的音频标记 transcriptState=none', media.modalities.find((m) => m.modal === 'audio')?.transcriptState === 'none', '')

    const docId = (await kb('glob', '未分类数据/*')).find((f) => f.path === '未分类数据/晨会录音.wav')?.id
    ok('模态：节点进入文件树（glob 可见）', Number.isFinite(docId), `docId=${docId}`)

    const listOnly = await kb('mediaGet', docId)
    ok(
      '模态：读取清单同时含文本与音频（同一节点的两种模态）',
      listOnly.modalities.some((m) => m.modal === 'audio') && listOnly.modalities.some((m) => m.modal === 'text'),
      listOnly.modalities.map((m) => m.modal).join(','),
    )

    const audio = await kb('mediaGet', docId, 'audio')
    ok('模态：取音频本体成功且带 data URL', audio.degraded === false && String(audio.dataUrl).startsWith('data:audio/wav'), '')
    ok('模态：未转写给出可操作提示', String(audio.hint ?? '').includes('转写'), audio.hint)

    const videoTry = await kb('mediaGet', docId, 'video')
    ok('模态：不兼容模态降级为文本（永不报错）', videoTry.degraded === true && String(videoTry.text).includes('排班'), videoTry.degradeReason)

    const rm = await runTool('read_modal', { docId })
    ok('read_modal：返回模态清单与元信息', rm.ok === true && rm.modalities.length >= 2 && rm.hasBody === false, rm.modalities.map((m) => m.modal).join(','))
    const rmText = await runTool('read_modal', { docId, modal: 'text' })
    ok('read_modal：文本模态给正文', String(rmText.text).includes('排班'), '')
    const rmAudio = await runTool('read_modal', { docId, modal: 'audio' })
    ok(
      'read_modal：音频给本体引用而不把字节灌进上下文',
      rmAudio.hasBody === true && !JSON.stringify(rmAudio).includes(WAV_B64.slice(0, 24)),
      '字节未进模型上下文',
    )

    const hitMedia = await runTool('search_knowledge', { query: '排班', sources: ['note'] })
    ok('模态：文本模态进索引可检索', hitMedia.items.some((i) => i.path === '未分类数据/晨会录音.wav'), hitMedia.items[0]?.path)
    ok('模态：检索结果不泄漏本体 base64', !JSON.stringify(hitMedia).includes(WAV_B64.slice(0, 24)), '')

    /* ---------- C. 目录治理 ---------- */

    const mk = await runTool('make_folder', { path: '运动/知识', reason: '训练资料归档' })
    ok('治理：make_folder 建目录', mk.ok === true && mk.path === '运动/知识', mk.path)
    const folderGlob = await kb('glob', '运动/知识')
    ok('治理：空目录在文件树里可见', folderGlob.some((f) => f.kind === 'folder'), folderGlob.map((f) => f.path).join(','))

    const moved = await runTool('classify_move', { docId, toDir: '运动/知识', reason: '晨会里讨论了训练计划' })
    ok('治理：AI 归类移动成功', moved.ok === true && moved.path === '运动/知识/晨会录音.wav', moved.path)
    const afterMove = await kb('glob', '运动/知识/*')
    ok('治理：移动后旧位置消失、新位置可见', afterMove.some((f) => f.path === '运动/知识/晨会录音.wav') && !(await kb('glob', '未分类数据/*')).some((f) => f.path === '未分类数据/晨会录音.wav'), '')

    let debounceErr = ''
    try {
      await runTool('classify_move', { docId, toDir: '笔记', reason: '再挪一次' })
    } catch (e) {
      debounceErr = e.message ?? String(e)
    }
    ok('治理：AI 24h 防抖拦住反复搬家', debounceErr.includes('防抖'), debounceErr.slice(0, 50))

    const pinned = await runTool('pin_file', { docId, pinned: true })
    ok('治理：钉住成功', pinned.ok === true && pinned.pinned === true, '')
    let pinErr = ''
    try {
      await runTool('classify_move', { docId, toDir: '笔记', reason: '钉住了还想挪' })
    } catch (e) {
      pinErr = e.message ?? String(e)
    }
    ok('治理：钉住后 AI 不得移动', pinErr.includes('钉住'), pinErr.slice(0, 50))
    await runTool('pin_file', { docId, pinned: false })

    const moves = await kb('fsMoves', 20)
    ok('治理：审计流水记录移动与钉住', moves.some((m) => m.op === 'move') && moves.some((m) => m.op === 'pin'), moves.slice(0, 3).map((m) => m.op).join(','))
    const batch = moves.find((m) => m.op === 'move')?.batchId
    const undone = await kb('fsUndo', batch)
    ok('治理：整批撤销生效', undone >= 1 && (await kb('glob', '未分类数据/*')).some((f) => f.path === '未分类数据/晨会录音.wav'), `撤销 ${undone} 条`)

    // 撤销后重新归类（撤销会把上一次 AI 移动标记为 undone，防抖不再拦），供下面的 UI 断言用
    const reMoved = await runTool('classify_move', { docId, toDir: '运动/知识', reason: '撤销后重新归类' })
    ok('治理：撤销后可再次归类', reMoved.ok === true && reMoved.path === '运动/知识/晨会录音.wav', reMoved.path)

    // 保留区：写进派生路径形态的必须自动让位，不覆盖投影
    const reserved = await kb('fileWrite', { path: '运动/2026-09-10/腿部-42.md', content: '用户文件不该占用派生路径' })
    ok('治理：保留区路径自动让位', reserved.path.includes('-v2'), reserved.path)

    let sysErr = ''
    try {
      await kb('fileWrite', { path: '系统提示词/伪造.md', content: 'x' })
    } catch (e) {
      sysErr = e.message ?? String(e)
    }
    ok('治理：系统区写入被拒', sysErr.includes('系统命名空间'), sysErr.slice(0, 50))

    /* ---------- D. UI：AI 页入口 + 文件管理器 ---------- */

    await evalJS("location.hash = '#/ai'")
    await waitFor("document.querySelector('button[aria-label=\"文件\"]')", 8000, 'AI 页文件按钮')
    ok('UI：AI 页左上角有文件按钮', true, '')

    await evalJS(`(() => {
      const btn = document.querySelector('button[aria-label="文件"]')
      btn.click()
      return true
    })()`)
    await sleep(700)
    const hash = await evalJS('location.hash')
    ok('UI：点击进入文件管理器', String(hash) === '#/ai/files', String(hash))
    await waitFor("document.body.innerText.includes('虚拟文件系统')", 8000, '文件管理器渲染')
    let text = await evalJS('document.body.innerText')
    ok(
      'UI：命名空间覆盖四区',
      ['系统提示词', '用户记忆', '未分类数据', '语音', '视频', '运动', '笔记', '规范'].every((n) => text.includes(n)),
      '',
    )

    // 下钻 运动/知识：看到归类后的音频节点与它的模态预览
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.querySelector('b')?.textContent === '运动')
      if (!btn) throw new Error('找不到「运动」目录')
      btn.click()
      return true
    })()`)
    await sleep(600)
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.querySelector('b')?.textContent === '知识')
      if (!btn) throw new Error('找不到「知识」子目录')
      btn.click()
      return true
    })()`)
    await sleep(700)
    text = await evalJS('document.body.innerText')
    ok('UI：下钻可见 AI 归类的文件', text.includes('晨会录音.wav'), '')

    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('晨会录音.wav'))
      if (!btn) throw new Error('找不到音频节点')
      btn.click()
      return true
    })()`)
    await sleep(800)
    // 本体读取是异步 IPC，等播放器挂上再断言
    try {
      await waitFor("!!document.querySelector('audio')", 8000, '音频播放器渲染')
    } catch { /* 断言会给出更清晰的失败信息 */ }
    const hasAudioEl = await evalJS("!!document.querySelector('audio')")
    text = await evalJS('document.body.innerText')
    ok('UI：阅读器渲染音频本体播放器', hasAudioEl === true, '')
    ok('UI：阅读器展示路径与归类状态', text.includes('运动/知识/晨会录音.wav') && text.includes('已归类'), '')
    ok('UI：模态可切换（文本/音频）', text.includes('文本') && text.includes('音频'), '')

    // 钉住
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('钉住') && !b.textContent.includes('取消'))
      if (!btn) throw new Error('找不到钉住按钮')
      btn.click()
      return true
    })()`)
    await sleep(600)
    text = await evalJS('document.body.innerText')
    ok('UI：钉住后显示状态与提示', text.includes('已钉住'), '')

    // 清理：把测试节点删掉，不污染真实数据
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('取消钉住'))
      btn?.click()
      return true
    })()`)
    await sleep(400)
    const delOk = await evalJS(`(async () => {
      const { kbService } = await import('/src/services/kbService.ts')
      const hits = await kbService.glob('运动/知识/*', 50)
      const hit = hits.find((f) => f.path === '运动/知识/晨会录音.wav')
      if (!hit) return 'not-found'
      await kbService.fileDelete(hit.id)
      return 'deleted'
    })()`)
    ok('UI：清理测试节点', delOk === 'deleted', String(delOk))
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
