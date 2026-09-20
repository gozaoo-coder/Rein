/**
 * 无依赖小工具：HTTP 应答、原子写盘、路径安全、定时安全比较、限流。
 *
 * 刻意不引 express：这台 ECS 只有 1.6G 内存，更新分发又是「一个大文件 + 几个小 JSON」
 * 的形状，node:http 直接用反而更可控（Range/ETag/流式下载都能拿到原生语义）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
  '.msi': 'application/octet-stream',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.deb': 'application/vnd.debian.binary-package',
  '.dmg': 'application/x-apple-diskimage',
  '.appimage': 'application/octet-stream',
}

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function send(res, status, body, headers = {}) {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body, null, 2)}\n`
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function sendJson(res, status, body, headers = {}) {
  send(res, status, body, headers)
}

export function sendError(res, status, code, message, extra = {}) {
  send(res, status, { error: { code, message, ...extra } })
}

export async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * 把用户给的文件名收敛成一个安全的 basename。
 * 任何 `/`、`\`、`..`、控制字符都拒绝 —— 这是唯一一处把外部字符串拼进路径的地方，
 * 上游只要漏一个，整台机器上的任意文件都可被覆盖/读取。
 */
export function safeFileName(name) {
  const base = path.basename(String(name ?? '').trim())
  if (!base || base === '.' || base === '..' || base.length > 200) return null
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) return null
  if (base.startsWith('.')) return null
  return base
}

/** 版本号收敛：只允许数字与点（语义化版本的前半段），并去掉前导 v。 */
export function safeVersion(version) {
  const v = String(version ?? '').trim().replace(/^v/i, '')
  if (!/^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/.test(v)) return null
  if (/[\\/]/.test(v)) return null
  return v
}

export function safeChannel(channel, allowed) {
  const c = String(channel ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(c)) return null
  if (allowed && !allowed.includes(c)) return null
  return c
}

/** 定时安全比较（长度不同也走满比较，避免用耗时泄漏长度）。 */
export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  const len = Math.max(ab.length, bb.length, 1)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  ab.copy(pa)
  bb.copy(pb)
  return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function hashToken(token, salt) {
  return crypto.createHash('sha256').update(`${salt}:${token}`).digest('hex')
}

/** 极简令牌桶（进程内）。AI 网关与 admin 登录失败都靠它兜底。 */
export function createBucket({ rpm, burst }) {
  const state = new Map()
  const refillPerMs = rpm / 60000
  function take(key, cost = 1) {
    const now = Date.now()
    const cur = state.get(key) ?? { tokens: burst, at: now }
    cur.tokens = Math.min(burst, cur.tokens + (now - cur.at) * refillPerMs)
    cur.at = now
    if (cur.tokens < cost) {
      state.set(key, cur)
      return { ok: false, retryAfter: Math.ceil((cost - cur.tokens) / refillPerMs / 1000) }
    }
    cur.tokens -= cost
    state.set(key, cur)
    if (state.size > 4096) {
      for (const [k, v] of state) if (now - v.at > 600_000) state.delete(k)
    }
    return { ok: true }
  }
  return { take }
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
}

export function nowIso() {
  return new Date().toISOString()
}

export function dirSize(fileOrDir) {
  let total = 0
  const st = fs.statSync(fileOrDir)
  if (!st.isDirectory()) return st.size
  for (const entry of fs.readdirSync(fileOrDir, { withFileTypes: true })) {
    total += dirSize(path.join(fileOrDir, entry.name))
  }
  return total
}
