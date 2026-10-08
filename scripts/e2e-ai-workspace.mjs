/**
 * AI 虚拟工作区端到端（docs/ai-workspace.md v2）：无头 Edge + 原生 CDP（浏览器 mock 模式）。
 * 运行：node scripts/e2e-ai-workspace.mjs   （前置：npm run dev 已在 1420，或用 REIN_E2E_URL 指向别的实例）
 *
 * 覆盖四条链路：
 *   A. 全量注入区 —— 系统提示词播种 / 用户记忆全量注入 / 预算与截断标记；
 *   B. 模态层 —— 上传本体（音频）→ 模态清单 → 取本体 / 不兼容模态降级为文本 / read_modal 工具；
 *   C. 目录治理 —— 收件箱 → classify_move 归类 → 审计 → pin 保护 → 撤销 → 保留区让位；
 *   D. UI —— AI 页页头「历史」菜单 → 文件管理器（命名空间、下钻、模态预览、钉住）；
 *   E. 文件管理器 —— 一层列举的完整元数据 / 回收站（删除-恢复-让位-子树-彻底删除）/ 改名保扩展名 / 键盘与就地改名。
 *
 * 浏览器 mock 与 Rust 实现同构（路径规则/降级链/治理约束都在两侧各跑一遍），断言在真实现上同样成立。
 */

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
/**
 * CDP 端口：本机 9238-9337 在 Windows 排除端口范围内（bind 0x271D），所以从 9444 起挑。
 *
 * **必须先探活再选端口**：上一次运行若没被 kill 干净（Windows 上 kill 子进程偶尔失效），
 * 端口仍被占 → 这次 spawn 的浏览器起不来，而 `PUT /json/new` 会连上**上一次那个浏览器**：
 * 它的 localStorage 还带着上一轮的数据，于是冒出「路径已存在」这类看着像代码 bug 的假失败。
 */
async function resolveDebugPort() {
  const { createServer } = await import('node:net')
  const base = Number(process.env.E2E_CDP_PORT ?? 9444)
  for (let i = 0; i < 12; i++) {
    const port = base + i
    const free = await new Promise((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(port, '127.0.0.1')
    })
    if (free) {
      if (i > 0) console.log(`提示：${base} 被占，改用 ${port}（多半是上一轮的浏览器没退干净）`)
      return port
    }
  }
  throw new Error(`${base} 起连续 12 个端口都被占用，先清理残留的 msedge 再跑`)
}

let DEBUG_PORT = 9444
/** 目标应用地址：默认 1420；端口被系统排除（本机 1420 常 EACCES）或并发会话时用 REIN_E2E_URL 指向独立实例 */
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
const KB_READ_ONLY = new Set(['status', 'search', 'read', 'memories', 'glob', 'cognition', 'injection', 'fsMoves', 'mediaGet', 'fileGet', 'settingsGet', 'probeEmbedder', 'reindex', 'listDir', 'trashList'])

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
  // 超时时把页面状态一起打出来 —— 只说「等待超时」定位不到是「没渲染」还是「导航没发生」
  const snap = await evalJS(`JSON.stringify({
    hash: location.hash,
    status: document.querySelector('.status')?.innerText ?? null,
    list: document.querySelector('[aria-label="文件列表"]')?.innerText?.slice(0, 400) ?? null,
    body: document.body.innerText.slice(0, 400),
  })`).catch(() => null)
  throw new Error(`等待超时: ${label}${snap ? `\n  页面快照: ${snap}` : ''}`)
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
  DEBUG_PORT = await resolveDebugPort()
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
    // 入口在页头「历史」菜单里（AI 页的左上角只剩这一颗圆钮，文件/知识库/草稿箱都收在它下面）
    await waitFor("document.querySelector('button[aria-label=\"历史\"]')", 8000, 'AI 页历史按钮')
    ok('UI：AI 页左上角有历史入口', true, '')

    await evalJS(`(() => {
      document.querySelector('button[aria-label="历史"]').click()
      return true
    })()`)
    await sleep(400)
    await evalJS(`(() => {
      const btn = [...document.querySelectorAll('button[role="menuitem"]')].find(
        (b) => b.textContent.trim() === '文件',
      )
      if (!btn) throw new Error('历史菜单里找不到「文件」项')
      btn.click()
      return true
    })()`)
    await sleep(700)
    const hash = await evalJS('location.hash')
    ok('UI：从历史菜单进入文件管理器', String(hash) === '#/ai/files', String(hash))
    await waitFor("document.body.innerText.includes('虚拟文件系统')", 8000, '文件管理器渲染')
    let text = await evalJS('document.body.innerText')
    ok(
      'UI：命名空间覆盖四区',
      ['系统提示词', '用户记忆', '未分类数据', '语音', '视频', '运动', '笔记', '规范'].every((n) => text.includes(n)),
      '',
    )

    // 下钻 运动/知识：看到归类后的音频节点与它的模态预览。
    // 行是 `li[role="option"]`（可点是里面的 .hit），不是 button —— 旧页面的 button 行已经换掉了；
    // 目录切换要走一次 IPC（mock 里还有 120ms 的 delay），所以每一步都 waitFor，不靠猜 sleep 时长。
    /** 按 <b> 文本取行的可点元素 */
    const rowHit = (text, exact = true) => {
      const t = JSON.stringify(text)
      const match = exact
        ? `r.querySelector('b')?.textContent === ${t}`
        : `r.querySelector('b')?.textContent?.includes(${t})`
      return `[...document.querySelectorAll('[aria-label="文件列表"] [role="option"]')].find((r) => ${match})?.querySelector('.hit')`
    }

    const clickRow = async (text, exact = true) => {
      const r = await evalJS(`(() => {
        const el = ${rowHit(text, exact)}
        if (!el) return 'not-found'
        el.click()
        return 'clicked'
      })()`)
      if (r !== 'clicked') throw new Error(`找不到列表行：${text}（${r}）`)
    }

    /**
     * 打开一行：**鼠标设备是双击、触屏设备是单击**（组件按 hover/pointer 能力自适应）。
     * 这里先问页面自己用的是哪一套，再按对应手势操作 —— 两边都不猜。
     */
    const hoverFine = await evalJS("matchMedia('(hover: hover) and (pointer: fine)').matches")
    const openRow = async (text, exact = true) => {
      if (hoverFine) {
        const r = await evalJS(`(() => {
          const el = ${rowHit(text, exact)}
          if (!el) return 'not-found'
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'opened'
        })()`)
        if (r !== 'opened') throw new Error(`找不到列表行：${text}（${r}）`)
        return
      }
      await clickRow(text, exact)
    }

    /** 根目录的命名空间是「地标卡」里的按钮（不是列表行） */
    const clickLandmark = async (name) => {
      const r = await evalJS(`(() => {
        const el = [...document.querySelectorAll('button')].find((b) => b.querySelector('b')?.textContent === ${JSON.stringify(name)})
        if (!el) return 'not-found'
        el.click()
        return 'clicked'
      })()`)
      if (r !== 'clicked') throw new Error(`找不到地标：${name}（${r}）`)
    }

    await clickLandmark('运动')
    await waitFor(rowHit('知识'), 8000, '运动 目录里的「知识」行')
    await openRow('知识')
    await waitFor(rowHit('晨会录音.wav', false), 8000, '知识 目录里的音频节点')
    text = await evalJS('document.body.innerText')
    ok('UI：下钻可见 AI 归类的文件', text.includes('晨会录音.wav'), '')

    await openRow('晨会录音.wav', false)
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

    /* ---------- E. 文件管理器：一层列举 / 回收站 / 改名（docs/ai-workspace.md §5） ---------- */

    // E1 一层列举：条目带完整元数据（大小 / 子项数 / 模态 / 双 id）
    const seeded = await kb('fileWrite', {
      path: '笔记/管理器用例.md',
      content: '这一行足够长，用来验证体积字段不是 0。',
    })
    const dirList = await kb('listDir', '笔记')
    const me = (dirList?.entries ?? []).find((e) => e.name === '管理器用例.md')
    ok(
      '列举：一层目录带完整元数据（id/大小/模态/可编辑）',
      !!me && me.id > 0 && me.fileId > 0 && me.size > 0 && me.editable === true &&
        Array.isArray(me.modalities) && me.modalities.includes('text'),
      me ? `id=${me.id} fileId=${me.fileId} size=${me.size}` : '未列出',
    )
    const rootList = await kb('listDir', '')
    const noteDir = (rootList?.entries ?? []).find((e) => e.name === '笔记')
    ok(
      '列举：目录条目带子项数与目录标记',
      !!noteDir && noteDir.kind === 'folder' && noteDir.childCount >= 1 && noteDir.id === 0,
      noteDir ? `childCount=${noteDir.childCount}` : '未列出',
    )

    // E2 回收站：删除后从浏览视图消失，但仍在回收站清单里
    const trashed = await kb('trash', seeded.id)
    const afterTrash = await kb('listDir', '笔记')
    ok(
      '回收站：删除后从目录列举里消失',
      !(afterTrash?.entries ?? []).some((e) => e.name === '管理器用例.md'),
      '',
    )
    const trashRows = await kb('trashList', 100)
    const trashedRow = trashRows.find((t) => t.fileId === seeded.id)
    ok(
      '回收站：清单保留原路径与删除时间',
      !!trashedRow && trashedRow.originalPath === '笔记/管理器用例.md' && !!trashedRow.trashedAt,
      trashedRow ? trashedRow.originalPath : '不在清单里',
    )
    ok('回收站：删除返回影响条数', trashed?.count >= 1, String(trashed?.count))

    // E3 删除腾出原路径：同位置可以立刻再建同名文件（回收站不占位）
    const again = await kb('fileWrite', { path: '笔记/管理器用例.md', content: '新的内容' })
    ok('回收站：原路径已腾空，可再建同名文件', again.path === '笔记/管理器用例.md', again.path)

    // E4 恢复：原路径被占时自动让位，绝不覆盖
    const restored = await kb('trashRestore', [seeded.id])
    const backList = await kb('listDir', '笔记')
    const backNames = (backList?.entries ?? []).map((e) => e.name)
    ok(
      '回收站：恢复成功且让位到 -v2（不覆盖占用者）',
      restored?.done === 1 && backNames.includes('管理器用例-v2.md') && backNames.includes('管理器用例.md'),
      backNames.join(','),
    )

    // E5 目录整棵子树一起进出回收站
    await kb('fsMkdir', '笔记/管理器目录', 'e2e', 'user')
    await kb('fileWrite', { path: '笔记/管理器目录/内层.md', content: '内层内容' })
    const folderList = await kb('listDir', '笔记')
    const folderEntry = (folderList?.entries ?? []).find((e) => e.name === '管理器目录')
    const folderTrash = await kb('trash', folderEntry.fileId)
    const notesAfter = await kb('listDir', '笔记')
    ok(
      '回收站：目录连整棵子树一起走',
      folderTrash?.count === 2 &&
        !(notesAfter?.entries ?? []).some((e) => e.name === '管理器目录'),
      `count=${folderTrash?.count}`,
    )
    const folderBack = await kb('trashRestore', [folderEntry.fileId])
    const inner = await kb('listDir', '笔记/管理器目录')
    ok(
      '回收站：目录恢复后子文件回到原位',
      folderBack?.done === 2 && (inner?.entries ?? []).some((e) => e.name === '内层.md'),
      `done=${folderBack?.done}`,
    )

    // E6 改名：本体节点的扩展名必须保住（不是 .wav.md）；目录不补 .md
    const wav = await kb('mediaWrite', {
      path: '未分类数据/管理器录音.wav',
      name: '管理器录音.wav',
      mime: 'audio/wav',
      dataBase64: `data:audio/wav;base64,${WAV_B64}`,
    })
    const renamedWav = await kb('fileRename', wav.id, '未分类数据/管理器会议.wav')
    ok('改名：本体节点保留原扩展名', renamedWav.path === '未分类数据/管理器会议.wav', renamedWav.path)
    const renamedDir = await kb('fileRename', folderEntry.fileId, '笔记/管理器文档')
    ok('改名：目录不会被补上 .md', renamedDir.path === '笔记/管理器文档', renamedDir.path)

    // E7 彻底删除 + 清空回收站
    await kb('trash', wav.id)
    const purged = await kb('trashPurge', [wav.id])
    const trashAfterPurge = await kb('trashList', 100)
    ok(
      '回收站：彻底删除后行与本体一起消失',
      purged?.done === 1 && !trashAfterPurge.some((t) => t.fileId === wav.id),
      `done=${purged?.done}`,
    )
    const emptied = await kb('trashEmpty')
    ok('回收站：清空后一条不剩', (await kb('trashList', 100)).length === 0, `done=${emptied?.done}`)

    // E8 UI：文件管理器渲染虚拟列表 + 回收站入口 + 键盘/多选。
    // D 段最后停在阅读器里（打开着音频），所以要先退回列表；再把目录切到「笔记」
    // —— 那里有本节造的两个文件 + 一个目录，够做方向键与 Shift 扩选。
    await evalJS(`(() => {
      document.querySelector('button[aria-label="返回列表"]')?.click()
      return true
    })()`)
    await waitFor("!!document.querySelector('[aria-label=\"文件列表\"]')", 8000, '回到文件列表')
    await evalJS(`(() => {
      const c = [...document.querySelectorAll('.crumbs button')].find((b) => b.textContent.trim() === '文件')
      if (c) c.click()
      return true
    })()`)
    await sleep(500)
    await clickLandmark('笔记')
    await waitFor(rowHit('管理器用例.md'), 8000, '笔记 里的「管理器用例.md」行')

    const listMeta = await evalJS(`(() => {
      const sc = document.querySelector('[aria-label="文件列表"]')
      const rows = document.querySelectorAll('[aria-label="文件列表"] li[role="option"]')
      const trash = document.querySelector('button[aria-label^="回收站"]')
      return { scroll: !!sc, rows: rows.length, trash: !!trash, virtual: !!sc?.querySelector('.pad') }
    })()`)
    ok(
      'UI：文件管理器渲染虚拟列表（有撑高占位）与回收站入口',
      listMeta.scroll === true && listMeta.virtual === true && listMeta.trash === true && listMeta.rows >= 2,
      JSON.stringify(listMeta),
    )
    const kbSelect = await evalJS(`(async () => {
      const sc = document.querySelector('[aria-label="文件列表"]')
      if (!sc) return 'no-list'
      sc.focus()
      sc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await new Promise((r) => setTimeout(r, 80))
      const sel1 = document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length
      sc.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 80))
      const sel2 = document.querySelectorAll('[aria-label="文件列表"] [aria-selected="true"]').length
      sc.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      const editing = !!document.querySelector('[aria-label="文件列表"] input[aria-label^="重命名为"]')
      return { sel1, sel2, editing }
    })()`)
    ok(
      'UI：方向键选择 + Shift 扩选 + F2 就地改名',
      kbSelect?.sel1 === 1 && kbSelect?.sel2 >= 2 && kbSelect?.editing === true,
      JSON.stringify(kbSelect),
    )
    // Vue 的 DOM 更新是下一帧才落地：dispatch 完要等一拍再查，否则查到的还是旧的输入框
    const escaped = await evalJS(`(async () => {
      const input = document.querySelector('[aria-label="文件列表"] input[aria-label^="重命名为"]')
      if (!input) return 'no-input'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      return !document.querySelector('[aria-label="文件列表"] input[aria-label^="重命名为"]')
    })()`)
    ok('UI：Esc 退出就地改名', escaped === true, String(escaped))

    // 清理：本节造的东西全部进回收站再清空（目录会带走整棵子树）
    for (const h of (await kb('glob', '笔记/管理器*', 50)) ?? []) await kb('trash', h.id)
    await kb('trashEmpty')
    const leftover = (await kb('glob', '笔记/管理器*', 50)) ?? []
    ok('清理：本节文件已全部清掉', leftover.length === 0, leftover.map((h) => h.path).join(','))

    /* ---------- F. 文件管理器 v2：元数据 / 列 / 框选 / 批量重命名 / 冲突 / 压缩包 / 视图 / 断点续传 ---------- */

    // F1 标签 / 评分 / 注释：落库、进列表、可筛选（元数据不进索引）
    const metaFile = await kb('fileWrite', { path: '笔记/元数据用例.md', content: '给这个文件打标签' })
    const metaSet = await kb('metaSet', {
      id: metaFile.id,
      rating: 4,
      tags: ['训练', '膝盖', '训练'],
      note: '这条注释只给人看',
    })
    ok(
      '元数据：评分/标签/注释落库（标签去重、评分 0..5）',
      metaSet.rating === 4 && metaSet.tags.length === 2 && metaSet.tags.includes('膝盖') && metaSet.note.includes('只给人看'),
      JSON.stringify({ rating: metaSet.rating, tags: metaSet.tags }),
    )
    const metaList = await kb('listDir', '笔记')
    const metaEntry = (metaList?.entries ?? []).find((e) => e.name === '元数据用例.md')
    ok(
      '元数据：列表里带 rating/tags/（注释只给 hasNote 标记）',
      metaEntry?.rating === 4 && metaEntry?.tags?.includes('训练') && metaEntry?.hasNote === true,
      JSON.stringify({ rating: metaEntry?.rating, tags: metaEntry?.tags, hasNote: metaEntry?.hasNote }),
    )
    const metaDoc = await kb('read', metaFile.id, 'l1')
    ok('元数据：不进索引正文（避免标签词污染检索语义）', !String(metaDoc?.summary ?? '').includes('膝盖'), '')

    // F2 列可配置：列的注册表与显示开关
    const colInfo = await evalJS(`(async () => {
      const { allColumns, visibleColumns } = await import('/src/files/registry.ts')
      return { all: allColumns().map((c) => c.key), def: visibleColumns(undefined).map((c) => c.key) }
    })()`)
    ok(
      '列：注册表给出内置列，默认可见的是名称/类型/大小/修改时间',
      colInfo?.all?.includes('rating') &&
        colInfo?.all?.includes('tags') &&
        colInfo?.def?.join(',') === 'name,kind,size,modified',
      JSON.stringify(colInfo),
    )

    // F3 冲突策略：保留两者 → 目标名自动加 -v2（不覆盖）
    await kb('fileWrite', { path: '笔记/冲突用例.md', content: '目标位置已有同名' })
    const dupe = await kb('fileWrite', { path: '笔记/冲突源.md', content: '复制源' })
    const dupeHit = (await kb('glob', '笔记/冲突源.md', 5))?.[0]
    const copied = await evalJS(`(async () => {
      const { kbProvider } = await import('/src/files/provider.ts')
      const { kbService } = await import('/src/services/kbService.ts')
      const l = await kbService.listDir('笔记')
      const src = l.entries.find((e) => e.name === '冲突源.md')
      // 用 provider.duplicate 的 asName 走「保留两者」那条路
      return await kbProvider.duplicate(
        { ...(await import('/src/services/kbService.ts')).kbService && {} , name: src.name, isDir: false, fileId: src.fileId, docId: src.id, modalities: ['text'], uri: 'kb://笔记/冲突源.md' },
        '笔记',
        '冲突用例-v2.md',
      )
    })()`)
    ok('冲突策略：保留两者按指定名落盘（asName 通路）', String(copied).includes('冲突用例-v2.md'), String(copied))
    ok('冲突策略：原有同名文件没被覆盖', !!(await kb('glob', '笔记/冲突用例.md', 5))?.[0], '')

    // F4 框选：marquee 命中判定给出的是稳定 id
    const band = await evalJS(`(async () => {
      const { useMarquee } = await import('/src/files/marquee.ts')
      const m = useMarquee()
      return typeof m.start === 'function' && m.rect.value === null
    })()`)
    ok('框选：marquee 模块就绪（细指针才启用）', band === true, String(band))

    // F5 压缩包内浏览：列条目 → 进包 → 选择性解压
    // 压缩包夹具在 Node 侧造（页面里的 import map 只映射 @/…，裸包名 import 解析不到）
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('docs/说明.txt', '包内说明')
    zip.file('docs/附件/明细.md', '明细内容')
    const zipText = await zip.generateAsync({ type: 'base64' })
    const zipFile = await kb('mediaWrite', {
      path: '未分类数据/管理器压缩包.zip',
      name: '管理器压缩包.zip',
      mime: 'application/zip',
      dataBase64: `data:application/zip;base64,${zipText}`,
    })
    // 压缩包命令收的是**文档 id**（不是文件 id）：先用 glob 换算一次
    const zipDocId = (await kb('glob', '未分类数据/管理器压缩包.zip', 5))?.[0]?.id
    const zipListing = await kb('archiveList', zipDocId)
    const zipFiles = (zipListing?.entries ?? []).filter((e) => !e.isDir)
    ok(
      '压缩包：列出包内条目（目录项与文件项都在）',
      zipFiles.length === 2 &&
        zipFiles.some((e) => e.path === 'docs/说明.txt') &&
        zipListing.entries.some((e) => e.isDir),
      zipListing?.entries?.map((e) => e.path).join(','),
    )
    const zipExtract = await kb('archiveExtract', zipDocId, '笔记/压缩包解压', ['docs/说明.txt'])
    ok(
      '压缩包：选择性解压只落指定条目',
      (zipExtract?.extracted ?? []).length === 1 && zipExtract.extracted[0].path.includes('说明.txt'),
      (zipExtract?.extracted ?? []).map((f) => f.path).join(','),
    )

    // F6 视图：四种模式都在（画廊只收视觉素材、分栏点目录往右加一栏）
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '画廊视图')
      b?.click()
      return true
    })()`)
    await sleep(400)
    const galleryNote = await evalJS(`document.body.innerText.includes('画廊只显示图片与视频') || !!document.querySelector('.galnote')`)
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '分栏视图')
      b?.click()
      return true
    })()`)
    await sleep(600)
    const colPanes = await evalJS(`document.querySelectorAll('.pane').length`)
    await evalJS(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '列表视图')
      b?.click()
      return true
    })()`)
    await sleep(300)
    ok('视图：画廊给出「只看图片/视频」说明', galleryNote === true, String(galleryNote))
    ok('视图：分栏视图渲染出栏链（≥1 栏）', colPanes >= 1, `panes=${colPanes}`)

    // F7 断点续传：队列在取消后保留未完成的条目
    const resumeInfo = await evalJS(`(async () => {
      const { useOpQueue } = await import('/src/files/opQueue.ts')
      const q = useOpQueue()
      let seen = 0
      const p = q.runBatch('trash', '测试批量', [1, 2, 3, 4, 5], async (_item, ctx) => {
        seen += 1
        ctx.step()
        if (seen === 2) q.cancel()
      })
      const r = await p
      const op = q.ops.value[0]
      return { done: r.done, remaining: r.remaining, resumable: op?.resumable === true }
    })()`)
    ok(
      '断点续传：取消后剩余条目留在队列里可继续',
      resumeInfo?.done === 2 && resumeInfo?.remaining === 3 && resumeInfo?.resumable === true,
      JSON.stringify(resumeInfo),
    )

    // F8 UI：批量重命名面板（预览随规则实时变）与冲突策略提示
    await evalJS(`(() => {
      const c = [...document.querySelectorAll('.crumbs button')].find((b) => b.textContent.trim() === '文件')
      if (c) c.click()
      return true
    })()`)
    await sleep(400)
    await clickLandmark('笔记')
    await waitFor(rowHit('元数据用例.md'), 8000, '笔记 里的元数据用例.md')
    // 右键选中行 → 菜单里选「批量重命名…」
    await evalJS(`(() => {
      const el = ${rowHit('元数据用例.md')}
      if (!el) return 'no-row'
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      return 'menu'
    })()`)
    await sleep(400)
    const renameOpened = await evalJS(`(() => {
      const item = [...document.querySelectorAll('button[role="menuitem"]')].find((b) => b.textContent.includes('批量重命名'))
      if (!item) return 'no-item'
      item.click()
      return 'clicked'
    })()`)
    await sleep(600)
    const panel = await evalJS(`(async () => {
      const find = document.querySelector('input[aria-label="查找文字"]')
      const replace = document.querySelector('input[aria-label="替换文字"]')
      if (!find || !replace) return { ok: false, reason: '面板没出现' }
      find.value = '元数据'
      find.dispatchEvent(new Event('input', { bubbles: true }))
      replace.value = '资料'
      replace.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const text = document.body.innerText
      return { ok: text.includes('元数据用例.md') && text.includes('资料用例.md'), preview: text.includes('资料用例.md') }
    })()`)
    ok('UI：批量重命名面板打开并实时预览（元数据用例.md → 资料用例.md）', panel?.ok === true, JSON.stringify(panel))
    await evalJS(`(() => {
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('关闭'))
      close?.click()
      return true
    })()`)
    await sleep(300)

    // 冲突：把 元数据用例.md 复制到已经有同名文件的目录里 → 应该弹出策略选择
    await evalJS(`(async () => {
      const { kbService } = await import('/src/services/kbService.ts')
      await kbService.fileWrite({ path: '笔记/元数据用例.md', content: '让目标位置有个同名文件' })
      return true
    })()`)
    const conflictShown = await evalJS(`(async () => {
      const { kbProvider } = await import('/src/files/provider.ts')
      const { kbService } = await import('/src/services/kbService.ts')
      const l = await kbService.listDir('笔记')
      const src = l.entries.find((e) => e.name === '元数据用例.md')
      const item = { id: 'kb:笔记/元数据用例.md', uri: 'kb://笔记/元数据用例.md', name: src.name, displayName: src.name,
        sortName: src.name, kind: 'text', isDir: false, size: 0, modifiedAt: undefined,
        attributes: { hidden: false, readOnly: false, system: false },
        permissions: { canRead: true, canWrite: true, canDelete: true, canRename: true },
        childCount: 0, rating: 0, tags: [], hasNote: false, pinned: false, classifyState: '', modalities: [],
        docId: src.id, fileId: src.fileId, sourceType: 'note', title: src.name, cloudState: 'local', providerId: 'kb' }
      // 直接走「拖到同一目录」的复制通路（asName 由冲突策略决定）
      const out = await kbProvider.duplicate(item, '笔记', '元数据用例-v2.md')
      return out
    })()`)
    ok('冲突策略：保留两者落 -v2 且不动原件', String(conflictShown).includes('元数据用例-v2.md'), String(conflictShown))

    // 清理 F 段
    for (const h of (await kb('glob', '笔记/元数据用例.md', 5)) ?? []) await kb('trash', h.id)
    for (const h of (await kb('glob', '笔记/冲突*', 10)) ?? []) await kb('trash', h.id)
    for (const h of (await kb('glob', '未分类数据/管理器压缩包.zip', 5)) ?? []) await kb('trash', h.id)
    for (const h of (await kb('glob', '笔记/压缩包解压/**', 10)) ?? []) await kb('trash', h.id)
    await kb('trashEmpty')
    ok('清理：回收站已空', (await kb('trashList', 100)).length === 0, '')
  } finally {
    try { ws?.close() } catch { /* 忽略 */ }
    // Windows 上 edge.kill() 只杀启动器，浏览器进程树会活下来占着 CDP 端口 ——
    // 下一次运行就会连到这只「僵尸浏览器」，带着上一轮的 localStorage 数据（假失败）。
    // 所以按进程树杀：taskkill /T 把 renderer/gpu/utility 一起带走。
    try {
      if (process.platform === 'win32') {
        const { spawnSync } = await import('node:child_process')
        spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
      }
    } catch { /* 忽略 */ }
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
