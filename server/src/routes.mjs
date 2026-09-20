/**
 * 路由表。
 *
 * 三条线：
 *   1. 更新分发（公开）：清单 + 安装包 + 公钥，客户端只读这些。
 *   2. 发布管理（admin token）：上传安装包、登记版本、回滚、镜像 GitHub Release。
 *   3. 在线模型网关（预留）：OpenAI 兼容的 /v1/*，见 ai.mjs。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { compareVersions } from './store.mjs'
import { normalizePricing, normalizeProviders } from './config.mjs'
import {
  clientIp,
  dirSize,
  mimeOf,
  nowIso,
  readJsonBody,
  safeChannel,
  safeFileName,
  safeVersion,
  send,
  sendError,
  sendJson,
  timingSafeEqual,
  writeAtomic,
} from './util.mjs'
import { parsePublicKey } from './verify.mjs'

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024 // 单个安装包上限 512MB

function bearer(req) {
  const h = String(req.headers.authorization ?? '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

function replaceBase(url, from, to) {
  return typeof url === 'string' && url.startsWith(from) ? `${to}${url.slice(from.length)}` : url
}

export function createRouter({ cfg, store, ai, log }) {
  const channels = cfg.update.channels

  // ---------- 公开：清单 ----------

  /** 解析 Tauri 风格的清单地址（支持 {{target}}/{{current_version}} 占位后的路径形态）。 */
  function resolveManifestRequest(parts, query) {
    const q = query.channel
    if (parts.length === 0) return { channel: safeChannel(q ?? cfg.update.defaultChannel, channels) }
    if (parts.length === 1) {
      const one = parts[0].replace(/\.json$/i, '')
      if (channels.includes(one)) return { channel: one }
      if (one === 'latest') return { channel: safeChannel(q ?? cfg.update.defaultChannel, channels) }
      return { channel: safeChannel(q ?? cfg.update.defaultChannel, channels), target: one }
    }
    if (parts.length === 2) {
      const [a, b] = parts
      if (channels.includes(a)) return { channel: a, target: b }
      return { channel: safeChannel(q ?? cfg.update.defaultChannel, channels), target: a, current: b }
    }
    return { channel: safeChannel(parts[0], channels), target: parts[1], current: parts[2] }
  }

  function serveManifest(res, channel) {
    const file = store.manifestPath(channel)
    if (!fs.existsSync(file)) {
      return sendError(res, 404, 'no_release', `通道 ${channel} 尚未发布任何版本`)
    }
    const body = fs.readFileSync(file)
    const sig = store.readManifestSignature(channel)
    sendJson(res, 200, JSON.parse(body.toString('utf8')), {
      'Cache-Control': 'public, max-age=60',
      ETag: `"${Buffer.from(body).length}-${hashTag(body)}"`,
      'X-Rein-Manifest-Signature': sig ? 'present' : 'none',
    })
  }

  /**
   * 清单的伴随签名。
   *
   * 刻意做成 `<清单地址>.sig` —— 客户端与校验脚本都是「给个清单 URL，顺手 .sig 一下」，
   * 服务端如果不认这个后缀会回落到清单本体，结果是「签名页拿到一段 JSON」这种
   * 看起来像签名坏了、其实是路由坏了的故障。
   */
  function serveManifestSignature(res, channel) {
    const sig = store.readManifestSignature(channel)
    if (!sig) return sendError(res, 404, 'no_signature', `通道 ${channel} 的清单没有伴随签名`)
    send(res, 200, sig, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    })
  }

  // ---------- 公开：下载（支持 Range 断点续传） ----------

  function serveDownload(req, res, channel, version, fileName, headOnly) {
    const clean = safeFileName(fileName)
    if (!clean) return sendError(res, 400, 'bad_request', '非法文件名')
    const abs = path.join(store.releaseDir(channel, version), clean)
    if (!abs.startsWith(store.releaseDir(channel, version)) || !fs.existsSync(abs)) {
      return sendError(res, 404, 'not_found', '文件不存在')
    }
    const stat = fs.statSync(abs)
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    const headers = {
      'Content-Type': mimeOf(clean),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': `attachment; filename="${clean}"`,
    }

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      return res.end()
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
    if (range && (range[1] !== '' || range[2] !== '')) {
      let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1])
      let end = range[2] === '' || range[1] === '' ? stat.size - 1 : Number(range[2])
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        return res.end()
      }
      start = Math.max(0, start)
      end = Math.min(end, stat.size - 1)
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      })
      if (headOnly) return res.end()
      return fs.createReadStream(abs, { start, end }).pipe(res)
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (headOnly) return res.end()
    fs.createReadStream(abs).pipe(res)
  }

  // ---------- admin ----------

  function requireAdmin(req, res) {
    const token = bearer(req) || String(req.headers['x-rein-token'] ?? '')
    if (!timingSafeEqual(token, cfg.adminToken)) {
      sendError(res, 401, 'admin_unauthorized', '管理令牌无效')
      return false
    }
    return true
  }

  /** 镜像：把一个远端清单（如 GitHub Release 的 latest.json）搬到本机并改写下载地址。 */
  async function mirror(body) {
    const channel = safeChannel(body.channel, channels)
    if (!channel) throw Object.assign(new Error(`通道非法：${body.channel}`), { status: 400 })
    if (typeof body.manifestUrl !== 'string' || !/^https?:\/\//.test(body.manifestUrl)) {
      throw Object.assign(new Error('manifestUrl 必须是 http(s) 地址'), { status: 400 })
    }

    const manifestRes = await fetch(body.manifestUrl, { signal: AbortSignal.timeout(60_000) })
    if (!manifestRes.ok) {
      throw Object.assign(new Error(`拉取远端清单失败：HTTP ${manifestRes.status}`), { status: 502 })
    }
    const manifestText = await manifestRes.text()
    let remote
    try {
      remote = JSON.parse(manifestText)
    } catch {
      throw Object.assign(new Error('远端清单不是合法 JSON'), { status: 502 })
    }

    // 远端清单若带签名就验一次（证明「我们镜像的清单本身是发布方发的」）；
    // 不带签名不阻塞 —— 真正的信任根在安装包签名，下面逐个校验。
    let manifestSignatureCheck = 'absent'
    if (body.signatureUrl) {
      const sigRes = await fetch(body.signatureUrl, { signal: AbortSignal.timeout(30_000) })
      if (sigRes.ok) {
        const sigText = (await sigRes.text()).trim()
        const check = store.verifyManifestText(ensureNl(manifestText), sigText)
        manifestSignatureCheck = check.ok ? 'verified' : `failed: ${check.reason}`
        if (body.requireSignature && !check.ok) {
          throw Object.assign(new Error(`远端清单签名校验失败：${check.reason}`), { status: 400 })
        }
      } else {
        manifestSignatureCheck = `fetch_failed: ${sigRes.status}`
      }
    }

    const version = safeVersion(remote.version)
    if (!version) throw Object.assign(new Error(`远端清单版本号非法：${remote.version}`), { status: 502 })

    const platforms = {}
    const saved = []
    for (const [target, entry] of Object.entries(remote.platforms ?? {})) {
      if (!entry?.url) continue
      const fileName = safeFileName(
        entry.name ?? decodeURIComponent(new URL(entry.url).pathname.split('/').pop() ?? ''),
      )
      if (!fileName) throw Object.assign(new Error(`[${target}] 远端文件名非法`), { status: 502 })

      // 先下到 release 目录（流式，边下边算 sha256）
      const res = await fetch(entry.url, { signal: AbortSignal.timeout(30 * 60_000) })
      if (!res.ok || !res.body) {
        throw Object.assign(new Error(`[${target}] 下载失败：HTTP ${res.status}`), { status: 502 })
      }
      const readable = Readable_fromWeb(res.body)
      const info = await store.saveArtifact(channel, version, fileName, readable)

      // 逐个校验：sha256 + 安装包签名。任一不过就删掉，绝不让一个未验签的包进目录
      const check = await store.verifyArtifactFile({
        channel,
        version,
        file: info.file,
        sha256: entry.sha256 ?? info.sha256,
        signature: entry.signature,
      })
      if (!check.ok) {
        fs.rmSync(path.join(store.releaseDir(channel, version), info.file), { force: true })
        throw Object.assign(new Error(`[${target}] 校验失败：${check.reason}`), { status: 400 })
      }
      saved.push({ target, file: info.file, sha256: info.sha256, size: info.size })
      platforms[target] = {
        file: info.file,
        signature: entry.signature ?? null,
        sha256: info.sha256,
        size: info.size,
        mirrors: [entry.url],
      }
    }

    if (saved.length === 0) throw Object.assign(new Error('远端清单里没有可用的平台条目'), { status: 400 })

    const record = await store.publish(
      {
        channel,
        version,
        notes: remote.notes ?? '',
        publishedAt: remote.pub_date ?? nowIso(),
        mandatory: Boolean(remote.mandatory),
        publish: body.publish !== false,
        platforms,
        mirroredFrom: { manifestUrl: body.manifestUrl, signatureCheck: manifestSignatureCheck, mirroredAt: nowIso() },
      },
      {},
    )
    log('mirror', { channel, version, targets: saved.map((s) => s.target), manifestSignatureCheck })
    return { ok: true, version, saved, manifestSignatureCheck, record }
  }

  // ---------- 主分发 ----------

  async function handle(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean)
    const query = Object.fromEntries(url.searchParams.entries())
    const ip = clientIp(req)

    // ===== 跨域（AI 接口）=====
    // App 里的聊天请求是 **WebView 侧的 pi-ai 直接发出**的（目录/用量那两条才走 Rust），
    // 所以网关必须自己给 CORS —— 少了它，WebView 只会看到 `Failed to fetch`：
    // 401「密钥不对」、429「限流」、503「provider 全冷却」这些**真正有用**的信息
    // 全被浏览器吞掉，用户看到的是一句没有下文的 connection error（线上踩过）。
    // 只对 AI 接口开，且是 Bearer 令牌鉴权、不带 Cookie，所以允许 * 不引入凭据泄露面。
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/v1/ai/')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      // **回显**浏览器要发的头，而不是写死一份白名单：WebView 里的 pi-ai 走 OpenAI SDK，
      // 它会带 `x-stainless-*` 一类自定义头 —— 白名单少一项，预检就失败，
      // 表现同样是「一句 connection error，什么都看不到」。
      const asked = req.headers['access-control-request-headers']
      res.setHeader('Access-Control-Allow-Headers', asked || 'Authorization, Content-Type')
      res.setHeader('Access-Control-Max-Age', '86400')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
    }

    // ===== 服务信息 / 健康 =====
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return sendJson(res, 200, {
        ok: true,
        service: 'rein-online-service',
        version: '1.0.0',
        time: nowIso(),
        baseUrl: cfg.publicBaseUrl,
        channels: channels.map((c) => ({ channel: c, current: store.currentVersion(c) })),
        update: {
          manifest: `${cfg.publicBaseUrl}/updates/latest.json`,
          publicKey: `${cfg.publicBaseUrl}/keys/update.pub`,
          verify: 'Ed25519(minisign) over artifact + sha256',
        },
        ai: ai.health(),
      })
    }

    // ===== 更新清单 =====
    if (req.method === 'GET' && parts[0] === 'updates') {
      const rest = parts.slice(1)
      if (rest.length === 1 && rest[0].endsWith('.json.sig')) {
        const name = rest[0].slice(0, -'.json.sig'.length)
        const channel = safeChannel(channels.includes(name) ? name : (query.channel ?? cfg.update.defaultChannel), channels)
        if (!channel) return sendError(res, 400, 'bad_request', '通道名非法')
        return serveManifestSignature(res, channel)
      }
      const target = resolveManifestRequest(rest, query)
      if (!target.channel) return sendError(res, 400, 'bad_request', '通道名非法')
      return serveManifest(res, target.channel)
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'update') {
      if (parts[3] === 'manifest' || parts[3] === 'latest') {
        const channel = safeChannel(query.channel ?? cfg.update.defaultChannel, channels)
        if (!channel) return sendError(res, 400, 'bad_request', '通道名非法')
        return serveManifest(res, channel)
      }
      if (parts[3] === 'releases') {
        const channel = safeChannel(query.channel ?? cfg.update.defaultChannel, channels)
        if (!channel) return sendError(res, 400, 'bad_request', '通道名非法')
        return sendJson(res, 200, store.stats(channel), { 'Cache-Control': 'no-store' })
      }
    }

    // ===== 公钥（客户端可自行核对内置公钥） =====
    if (req.method === 'GET' && url.pathname === '/keys/update.pub') {
      if (!cfg.update.publicKey) return sendError(res, 404, 'no_key', '服务端未配置更新公钥')
      return sendJson(res, 200, { publicKey: cfg.update.publicKey }, { 'Cache-Control': 'public, max-age=3600' })
    }

    // ===== 安装包下载 =====
    if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'dl') {
      const [, channelRaw, versionRaw, ...rest] = parts
      const channel = safeChannel(channelRaw, channels)
      const version = safeVersion(versionRaw)
      if (!channel || !version || rest.length === 0) {
        return sendError(res, 400, 'bad_request', '下载地址格式：/dl/<通道>/<版本>/<文件名>')
      }
      return serveDownload(req, res, channel, version, rest.join('/'), req.method === 'HEAD')
    }

    // ===== 在线模型网关（预留） =====
    if (url.pathname === '/v1/models' || url.pathname === '/api/v1/ai/models') {
      if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', '仅支持 GET')
      return ai.models(req, res)
    }
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/api/v1/ai/chat/completions') {
      if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', '仅支持 POST')
      return ai.chatCompletions(req, res, { ip })
    }
    if (url.pathname === '/api/v1/ai/health') {
      return sendJson(res, 200, ai.health())
    }
    if (url.pathname === '/api/v1/ai/usage') {
      if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', '仅支持 GET')
      // 客户端令牌鉴权：只回自己的用量与总成本（服务端是成本的权威口径）
      return ai.usageForRequest(req, res, Number(query.days ?? 7) || 7)
    }
    if (url.pathname === '/api/v1/ai/selfcheck') {
      return ai.selfcheck(req, res)
    }

    // ===== admin =====
    if (parts[0] === 'admin') {
      if (!requireAdmin(req, res)) {
        log('admin-denied', { ip, path: url.pathname })
        return
      }
      // 管理接口前缀是 /admin/api/...，这里把 api 剥掉，下面按业务段匹配
      const adminPath = parts[1] === 'api' ? parts.slice(2) : parts.slice(1)
      return handleAdmin(req, res, adminPath, query)
    }

    return sendError(res, 404, 'not_found', `未知路径：${url.pathname}`)
  }

  async function handleAdmin(req, res, parts, query) {
    // 总览
    if (req.method === 'GET' && parts[0] === 'state') {
      return sendJson(res, 200, {
        ok: true,
        time: nowIso(),
        baseUrl: cfg.publicBaseUrl,
        dataDir: cfg.dataDir,
        dataBytes: dirSize(cfg.dataDir),
        publicKeyConfigured: Boolean(cfg.update.publicKey),
        publicKeyKeyId: cfg.update.publicKey ? parsePublicKey(cfg.update.publicKey).keyId : null,
        channels: channels.map((c) => store.stats(c)),
        ai: ai.health(),
      })
    }

    // 上传安装包（原样字节流）
    if (req.method === 'POST' && parts[0] === 'artifacts' && parts.length === 4) {
      const channel = safeChannel(parts[1], channels)
      const version = safeVersion(parts[2])
      if (!channel || !version) return sendError(res, 400, 'bad_request', '通道或版本非法')
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > MAX_ARTIFACT_BYTES) return sendError(res, 413, 'too_large', '安装包超过 512MB')
      try {
        const info = await store.saveArtifact(channel, version, parts[3], req)
        log('artifact-uploaded', { channel, version, ...info, ip: clientIp(req) })
        return sendJson(res, 200, { ok: true, ...info })
      } catch (e) {
        return sendError(res, e.status ?? 500, 'upload_failed', e.message)
      }
    }

    // 登记并发布版本
    if (req.method === 'POST' && parts[0] === 'releases' && parts.length === 1) {
      const body = await readJsonBody(req)
      const record = await store.publish(body, {
        manifest: body.manifest,
        manifestText: body.manifestText,
        manifestSignature: body.manifestSignature,
      })
      return sendJson(res, 200, { ok: true, release: record })
    }

    // 发布历史
    if (req.method === 'GET' && parts[0] === 'releases') {
      const channel = safeChannel(query.channel ?? cfg.update.defaultChannel, channels)
      if (!channel) return sendError(res, 400, 'bad_request', '通道名非法')
      return sendJson(res, 200, store.stats(channel))
    }

    // 版本操作：置为当前 / 删除
    if (parts[0] === 'releases' && parts.length >= 3) {
      const channel = safeChannel(parts[1], channels)
      const version = safeVersion(parts[2])
      if (!channel || !version) return sendError(res, 400, 'bad_request', '通道或版本非法')
      if (req.method === 'POST' && parts[3] === 'publish') {
        const manifest = store.setLatest(channel, version)
        return sendJson(res, 200, { ok: true, version, manifest })
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        store.deleteRelease(channel, version)
        // 删掉的正好是当前版本时，自动回落到最新的剩余版本，避免通道悬空
        const index = store.listReleases(channel)
        if (store.currentVersion(channel) === version) {
          const next = index.filter((r) => r.version !== version).sort((a, b) => compareVersions(b.version, a.version))[0]
          if (next) store.setLatest(channel, next.version)
        }
        return sendJson(res, 200, { ok: true })
      }
    }

    // 镜像远端发布
    if (req.method === 'POST' && parts[0] === 'mirror') {
      const body = await readJsonBody(req)
      const result = await mirror(body)
      return sendJson(res, 200, result)
    }

    // ===== AI 管理（预留服务的配置面） =====
    if (parts[0] === 'ai') {
      if (req.method === 'GET' && parts[1] === 'state') {
        const usage = ai.usage(7)
        return sendJson(res, 200, {
          ...ai.health(),
          pricing: ai.pricingInfo(true),
          // 每个令牌最近 7 天的调用与花费：谁在用、花了多少，一眼看完
          clients: (cfg.ai.clients ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            scopes: c.scopes,
            rpm: c.rpm,
            models: c.models ?? [],
            createdAt: c.createdAt,
            disabled: Boolean(c.disabled),
            usage7d: usage.byClient.find((x) => x.clientId === c.id) ?? null,
          })),
          totals7d: usage.totals,
        })
      }
      if (req.method === 'PUT' && parts[1] === 'providers') {
        const body = await readJsonBody(req)
        if (!Array.isArray(body.providers)) return sendError(res, 400, 'bad_request', 'providers 必须是数组')
        cfg.ai.providers = normalizeProviders(body.providers)
        writeJsonFile(cfg.configFile, cfg)
        log('ai-providers-updated', { count: cfg.ai.providers.length, ip: clientIp(req) })
        return sendJson(res, 200, { ok: true, providers: cfg.ai.providers.map((p) => ({ ...p, apiKey: p.apiKey ? '***' : '' })) })
      }
      if (req.method === 'POST' && parts[1] === 'clients') {
        const body = await readJsonBody(req)
        const { client, token } = ai.issueClientToken(body)
        writeJsonFile(cfg.configFile, cfg)
        log('ai-client-issued', { id: client.id, name: client.name, models: client.models, ip: clientIp(req) })
        return sendJson(res, 200, { ok: true, client: { ...client, tokenHash: undefined, tokenSalt: undefined }, token })
      }
      // 计价：流量单价 / 计费口径 / 模型价表（模型价与官方同价，服务端不溢价）
      if (parts[1] === 'pricing') {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, pricing: ai.pricingInfo(true) })
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          // 只覆盖传进来的字段：改一个模型价不必把整张表贴回来
          const hasModels = body.models !== undefined
          cfg.ai.pricing = normalizePricing({
            ...cfg.ai.pricing,
            ...('currency' in body ? { currency: body.currency } : {}),
            ...('traffic' in body ? { traffic: { ...cfg.ai.pricing.traffic, ...body.traffic } } : {}),
            ...('default' in body ? { default: body.default } : {}),
            ...(hasModels
              ? { models: body.replace ? body.models : { ...cfg.ai.pricing.models, ...body.models } }
              : {}),
          })
          writeJsonFile(cfg.configFile, cfg)
          log('ai-pricing-updated', { trafficPerGb: cfg.ai.pricing.traffic.perGb, models: Object.keys(cfg.ai.pricing.models).length, ip: clientIp(req) })
          return sendJson(res, 200, { ok: true, pricing: ai.pricingInfo(true) })
        }
        return sendError(res, 405, 'method_not_allowed', '仅支持 GET / PUT')
      }
      if (req.method === 'DELETE' && parts[1] === 'clients' && parts[2]) {
        cfg.ai.clients = (cfg.ai.clients ?? []).filter((c) => c.id !== parts[2])
        writeJsonFile(cfg.configFile, cfg)
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'POST' && parts[1] === 'clients' && parts[2] && parts[3] === 'disable') {
        const c = (cfg.ai.clients ?? []).find((x) => x.id === parts[2])
        if (!c) return sendError(res, 404, 'not_found', '客户端不存在')
        c.disabled = true
        writeJsonFile(cfg.configFile, cfg)
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'GET' && parts[1] === 'usage') {
        const d = Math.min(Math.max(Number(query.days ?? 7) || 7, 1), 90)
        return sendJson(res, 200, { ok: true, days: d, pricing: ai.pricingInfo(), ...ai.usage(d) })
      }
    }

    return sendError(res, 404, 'not_found', '未知管理接口')
  }

  return { handle }
}

function writeJsonFile(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

function hashTag(buffer) {
  return buffer.toString('base64url').slice(0, 12)
}

function ensureNl(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** Web ReadableStream → Node Readable（镜像下载用）。 */
function Readable_fromWeb(webStream) {
  return Readable.fromWeb(webStream)
}
