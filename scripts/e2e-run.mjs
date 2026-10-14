/**
 * E2E 套件运行器 —— 起一次 dev server，把要跑的套件依次指向它。
 *
 * 为什么需要它：本机 Windows 常把 1420 划进「保留端口范围」，`npm run dev` 直接
 * `listen EACCES`；而套件自己只认 `REIN_E2E_URL ?? http://localhost:1420`。
 * 于是每次跑 e2e 都要人工挑端口、起服、设环境变量、跑完再收 —— 这里把这段固化：
 *
 *   1 自己挑一个**本机允许监听**的端口（候选表逐个真 listen 试，EACCES/EPERM 视为不可用）；
 *   2 用 `vite --port <N> --strictPort` 起 dev server（cwd = 仓库根，与 npm run dev 同）；
 *   3 轮询 HTTP 直到 200（默认 90s 超时，冷启动 vite 在本机约 2–5s）；
 *   4 依次跑套件，把 REIN_E2E_URL 指过去，退出码逐个记录；
 *   5 finally 收掉 dev server（Windows 走 taskkill /T 杀进程树，否则 vite 会留孤儿）。
 *
 * 用法：
 *   node scripts/e2e-run.mjs scripts/e2e-desktop-shell.mjs
 *   node scripts/e2e-run.mjs --keep-going scripts/e2e-desktop-shell.mjs scripts/e2e-layout-guard.mjs
 *   node scripts/e2e-run.mjs --url http://localhost:17420 scripts/ui-shots.mjs   # 复用已在跑的服
 *   node scripts/e2e-run.mjs --port 18080 scripts/e2e-record.mjs                # 指定端口
 *
 * 退出码：首个失败套件的退出码（--keep-going 时取最后一个非零）；全部通过为 0。
 * 环境语义与直接跑套件一致（REIN_EDGE / DARK / PERF 等照常透传）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATE_PORTS = [17420, 17421, 17422, 17431, 18080, 18081, 19090, 25080]

const argv = process.argv.slice(2)
let keepGoing = false
let fixedPort = null
let reuseUrl = null
let suiteArgs = []
const suites = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--') { suiteArgs = argv.slice(i + 1); break }
  else if (a === '--keep-going') keepGoing = true
  else if (a === '--port') { fixedPort = Number(argv[++i]); }
  else if (a === '--url') { reuseUrl = argv[++i]; }
  else suites.push(a)
}
if (!suites.length) {
  console.error('用法: node scripts/e2e-run.mjs [--keep-going] [--port N | --url URL] <套件.mjs> [...]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 真 listen 一次：能绑上就是本机允许的端口（EACCES/EPERM/EADDRINUSE 都算不可用） */
function canListen(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function pickPort() {
  if (fixedPort) {
    if (!(await canListen(fixedPort))) {
      console.error(`端口 ${fixedPort} 不可用（被占或被系统排除）`)
      process.exit(3)
    }
    return fixedPort
  }
  // 候选表按 pid 错开起点：两个运行器同时起服时不会都从 17420 开始抢（抢输的一方要等 90s 超时）
  const start = process.pid % CANDIDATE_PORTS.length
  for (let i = 0; i < CANDIDATE_PORTS.length; i += 1) {
    const p = CANDIDATE_PORTS[(start + i) % CANDIDATE_PORTS.length]
    if (await canListen(p)) return p
  }
  // 候选表全被占（多个 agent 同时在跑 e2e 时会这样）：再到一个宽区间里随机试几个，
  // 免得两边都去抢同一个端口、后者起不来还要等 90s 超时
  for (let i = 0; i < 8; i += 1) {
    const p = 20000 + Math.floor(Math.random() * 25000)
    if (await canListen(p)) return p
  }
  console.error(`候选端口全不可用：${CANDIDATE_PORTS.join(', ')} —— 用 --port 指定一个`)
  process.exit(3)
}

async function waitReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok || res.status === 304) return true
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  return false
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ } }
  }
}

let server = null
let url = reuseUrl

try {
  if (!url) {
    const port = await pickPort()
    url = `http://127.0.0.1:${port}`
    console.log(`[e2e-run] 起 dev server：${url}`)
    server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let serverLog = ''
    server.stdout.on('data', (d) => { serverLog += d })
    server.stderr.on('data', (d) => { serverLog += d })
    server.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[e2e-run] dev server 退出（code ${code}）\n${serverLog.slice(-2000)}`)
    })
    if (!(await waitReady(url, 90000))) {
      console.error(`[e2e-run] dev server 90s 内没就绪：\n${serverLog.slice(-2000)}`)
      killTree(server.pid)
      process.exit(4)
    }
    console.log('[e2e-run] dev server 就绪')
  } else {
    console.log(`[e2e-run] 复用 ${url}`)
  }

  const results = []
  for (const suite of suites) {
    console.log(`\n[e2e-run] ▶ ${suite}`)
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [suite, ...suiteArgs], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, REIN_E2E_URL: url },
      })
      child.on('exit', (c) => resolve(c ?? 1))
    })
    results.push({ suite, code })
    console.log(`[e2e-run] ${code === 0 ? 'PASS' : 'FAIL'} ${suite}（退出码 ${code}）`)
    if (code !== 0 && !keepGoing) break
  }

  const failed = results.filter((r) => r.code !== 0)
  console.log('\n[e2e-run] —— 汇总 ——')
  for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.suite}`)
  process.exitCode = failed.length ? (failed[0]?.code ?? 1) : 0
} finally {
  if (server?.pid) killTree(server.pid)
}
