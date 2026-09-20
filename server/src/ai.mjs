/**
 * Rein 在线大模型 API 网关（预留接口，当前即可用的 OpenAI 兼容转发）。
 *
 * 定位：Rein 桌面/移动端本来就在 WebView 里直连 provider（见 docs/ARCHITECTURE.md
 * 的 AI 域说明）。这个网关不是要替换那条链路，而是给它留一条「托管」的路：
 * 客户端把 baseUrl 指过来，密钥与配额都留在服务端，用户设备上不再落明文 key。
 * 因为对外只说 OpenAI 协议，前端的 pi-ai 不需要任何改动就能接上。
 *
 * 当前状态（刻意的边界）：
 *   - 转发 + 流式（SSE）+ 用量记账已可用；
 *   - 鉴权走客户端令牌（sha256 摘要存盘，明文只在签发那一次出现），令牌可带模型白名单；
 *   - /v1/models 由服务端决定「这个密钥能用哪些模型」，并连同官方单价一起下发；
 *   - 每条用量都记成本：token 费（官方页价，不溢价）+ 流量费（默认 0.8 元/GB，只算出方向）；
 *   - 未配置任何 provider 时返回 503 ai_not_configured，而不是假装成功。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { clientIp, createBucket, hashToken, nowIso, readJsonBody, sendError, sendJson, timingSafeEqual } from './util.mjs'

const CHAT_BODY_LIMIT = 24 * 1024 * 1024 // 带图的消息可能几 MB，留足余量

/** 服务端默认模型的别名：客户端只认这一个名字，换后端模型不必改客户端。 */
const AUTO_MODEL = 'auto-model'
/** 不写死模型名的老写法（auto / rein-auto / 空）：由服务端挑，与 AUTO_MODEL 同义。 */
const isAutoAlias = (model) => !model || model === 'auto' || model === 'rein-auto'

/**
 * 「账户级」故障的判据：只有这类错误换 provider 才有意义 —— 欠费/超额换一家立刻能用，
 * 而参数写错、模型没开通换到哪都一样，还会白烧一份备选额度。
 *
 * 火山方舟欠费的真实报文是 403 + `{"error":{"code":"AccountOverdueError",
 * "message":"The request failed because your account has an overdue balance."}}`，
 * 所以按「403/429 + 文案里出现余额/欠费字样」识别；402 无需文案，本身就是支付要求。
 */
const ACCOUNT_BLOCK_HINTS = /(insufficient|balance|overdue|arrears|欠费|余额|recharge|credit)/i
function isAccountBlocked(status, text) {
  if (status === 402) return true
  if (status !== 403 && status !== 429) return false
  return ACCOUNT_BLOCK_HINTS.test(String(text ?? ''))
}

/** 金额按「元」浮点存：单次请求的流量费常是 1e-7 量级，逐笔四舍五入会把零头抹平。 */
const round6 = (n) => Math.round(n * 1e6) / 1e6
const round9 = (n) => Math.round(n * 1e9) / 1e9
const money = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)

export class AiGateway {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.logDir = path.join(cfg.dataDir, 'logs')
    fs.mkdirSync(this.logDir, { recursive: true })
    const rpm = Number(cfg.ai?.rate?.rpm ?? 60)
    const burst = Number(cfg.ai?.rate?.burst ?? 10)
    this.limiter = createBucket({ rpm, burst })
    this.authLimiter = createBucket({ rpm: 30, burst: 10 })
    // 上游账户级故障的冷却表：providerId → 冷却截止时间戳（见 tripBreaker）
    this.broken = new Map()
  }

  /** 主上游是否还在冷却中（刚撞过欠费，暂时别去撞第二遍）。 */
  breakerOpen(providerId) {
    return Date.now() < (this.broken.get(providerId) ?? 0)
  }

  /** 记一次账户级故障：欠费会持续到充值，冷却期内直接走备选。 */
  tripBreaker(providerId, seconds) {
    this.broken.set(providerId, Date.now() + Math.max(1, seconds) * 1000)
  }

  /** 已启用的 provider（配置里 enabled 且带 key）。 */
  activeProviders() {
    return (this.cfg.ai?.providers ?? []).filter((p) => p.enabled && p.apiKey)
  }

  /** 找一个能服务该 model 的 provider；model 缺省/auto 时取第一个启用的。 */
  pickProvider(model) {
    const active = this.activeProviders()
    if (active.length === 0) return null
    if (!model || model === 'auto' || model === 'rein-auto') return active[0]
    const exact = active.find((p) => p.models?.includes(model))
    if (exact) return exact
    // 未登记在册的模型名：交给第一个 provider 试（很多 provider 直接认全量模型名）
    return active[0]
  }

  /**
   * 主 provider 扛不住时的备选：配置里写了 fallback、这个模型有映射、备选 provider
   * 也确实挂着映射后的模型 —— 三条都满足才算数，否则宁可原地报错也不乱转。
   */
  fallbackOf(provider, model) {
    const fb = provider?.fallback
    const to = fb?.models?.[model]
    if (!fb || !to) return null
    const target = this.activeProviders().find((p) => p.id === fb.providerId && p.models?.includes(to))
    return target ? { provider: target, model: to } : null
  }

  /** 转发链：主 provider 打头，账户级故障（欠费）时沿链往下退。 */
  chainFor(model) {
    const primary = this.pickProvider(model)
    if (!primary) return []
    const chain = [{ provider: primary, model }]
    const fb = this.fallbackOf(primary, model)
    if (fb) chain.push(fb)
    return chain
  }

  // ---- 计价 -------------------------------------------------------------
  //
  // 口径：模型费 = token 数 × 官方页价（服务端不溢价）；流量费 = 计费字节 / 1GB × 单价。
  // 流量默认只算出方向（egress），与云厂商「按使用流量计费」一致，入方向的图片上传不计。
  // 缓存命中的输入 token 若配了 cacheIn 就按它算，否则按未命中价（宁可保守多算，不少算）。

  /** 模型单价（元 / 百万 tokens）；未登记走 pricing.default。 */
  priceOf(model) {
    const pricing = this.cfg.ai?.pricing ?? {}
    const raw = pricing.models?.[model] ?? pricing.default ?? {}
    return {
      in: money(raw.in),
      out: money(raw.out),
      cacheIn: raw.cacheIn === undefined || raw.cacheIn === null ? null : money(raw.cacheIn),
    }
  }

  /** 是否登记过价格：没有的话只有流量费，客户端可据此显示「未定价」。 */
  priced(model) {
    const p = this.priceOf(model)
    return p.in > 0 || p.out > 0
  }

  /** 一次请求的成本（元）。usage 缺失（上游没回）时只算流量。 */
  costOf({ model, usage, requestBytes = 0, responseBytes = 0 }) {
    const pricing = this.cfg.ai?.pricing ?? {}
    const price = this.priceOf(model)
    const prompt = Math.max(0, Number(usage?.prompt_tokens) || 0)
    const completion = Math.max(0, Number(usage?.completion_tokens) || 0)
    const cached = Math.max(
      0,
      Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens) || 0,
    )
    const missIn = Math.max(0, prompt - cached)
    const cacheRate = price.cacheIn === null ? price.in : price.cacheIn
    const tokenCost = (missIn * price.in + cached * cacheRate + completion * price.out) / 1e6

    const perGb = money(pricing.traffic?.perGb)
    const scope = pricing.traffic?.scope ?? 'egress'
    const bytes =
      scope === 'ingress'
        ? requestBytes
        : scope === 'both'
          ? requestBytes + responseBytes
          : responseBytes
    const trafficCost = (bytes / 1e9) * perGb

    return {
      currency: pricing.currency ?? 'CNY',
      model,
      priced: this.priced(model),
      tokensIn: prompt,
      tokensOut: completion,
      cachedTokens: cached,
      // 逐笔保留原始精度，展示/汇总时再收敛（见 round9）
      tokenCost,
      trafficBytes: bytes,
      trafficCost,
      total: tokenCost + trafficCost,
    }
  }

  /** 计价口径摘要（health / 管理面展示用）。 */
  pricingInfo(includeTable = false) {
    const pricing = this.cfg.ai?.pricing ?? {}
    const info = {
      currency: pricing.currency ?? 'CNY',
      unit: 'per_1m_tokens',
      trafficPerGb: money(pricing.traffic?.perGb),
      trafficScope: pricing.traffic?.scope ?? 'egress',
      modelCount: Object.keys(pricing.models ?? {}).length,
    }
    if (includeTable) {
      info.default = pricing.default ?? { in: 0, out: 0 }
      info.models = pricing.models ?? {}
    }
    return info
  }

  /** 令牌白名单：空数组（或未配置令牌）= 不限制。auto 交给服务端挑，不拦。 */
  modelAllowed(client, model) {
    if (!client) return true
    if (isAutoAlias(model)) return true
    // auto-model 的解析结果一定落在白名单里，所以放不放行取决于「默认模型能不能用」
    if (model === AUTO_MODEL) return Boolean(this.autoTarget(client))
    const allow = client.models ?? []
    return allow.length === 0 || allow.includes(model)
  }

  /**
   * auto-model 指向谁：配置里的默认模型，但必须同时满足「本令牌能用它」和
   * 「它真的挂在启用中的 provider 上」。任一条不满足就不下发这个别名 ——
   * 别名绝不能成为绕开令牌白名单的后门。
   */
  autoTarget(client = null) {
    const want = String(this.cfg.ai?.autoModel ?? '').trim()
    if (!want) return null
    const allow = client?.models ?? []
    if (client && allow.length > 0 && !allow.includes(want)) return null
    return this.activeProviders().some((p) => p.models?.includes(want)) ? want : null
  }

  /** 真正转发给上游的模型名：auto 系列别名在这里落定成具体模型。 */
  resolveModel(client, requested) {
    if (requested && requested !== AUTO_MODEL && !isAutoAlias(requested)) return requested
    return this.autoTarget(client) ?? this.realModels(client)[0]?.id ?? null
  }

  /**
   * 把模型包成 OpenAI 列表项；rein 扩展带单价与所属 provider（客户端据此显示与算账）。
   * 价格按 `priceModel` 查而不是按条目自身：auto-model 是按目标模型的价转发出去的，
   * 拿别名去价格表里查只会查到「未定价」，客户端就会把默认模型的 token 费算成 0。
   */
  modelEntry(model, provider, { priceModel = model, ...extra } = {}) {
    const price = this.priceOf(priceModel)
    return {
      id: model,
      object: 'model',
      owned_by: provider.id,
      created: 0,
      rein: {
        providerId: provider.id,
        providerName: provider.name,
        priceIn: price.in,
        priceOut: price.out,
        cacheIn: price.cacheIn,
        priced: this.priced(priceModel),
        currency: this.cfg.ai?.pricing?.currency ?? 'CNY',
        unit: 'per_1m_tokens',
        ...extra,
      },
    }
  }

  /** 真实模型清单（不含 auto-model 别名本身）：按 provider 摊平并过令牌白名单。 */
  realModels(client = null) {
    const out = []
    for (const p of this.activeProviders()) {
      // hidden 的 provider 只做备选，不摆到清单里让用户直接挑
      if (p.hidden) continue
      for (const m of p.models ?? []) {
        if (!this.modelAllowed(client, m)) continue
        out.push(this.modelEntry(m, p))
      }
    }
    return out
  }

  /** 当前令牌可见的模型清单：auto-model 别名在前，真实模型在后。 */
  catalog(client = null) {
    const out = []
    const target = this.autoTarget(client)
    if (target) {
      const owner = this.activeProviders().find((p) => p.models?.includes(target))
      // auto: true + target：客户端可据此提示「这个别名此刻指向哪款模型」；
      // priceModel：别名的单价照抄目标模型，别让默认模型显示成「未定价」
      if (owner) out.push(this.modelEntry(AUTO_MODEL, owner, { priceModel: target, auto: true, target }))
    }
    return out.concat(this.realModels(client))
  }

  /** 校验 Authorization: Bearer <token>。 */
  authenticate(req) {
    const header = String(req.headers.authorization ?? '')
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const clients = this.cfg.ai?.clients ?? []

    // 未配置任何客户端令牌：按配置决定是开放还是拒绝（默认拒绝）
    if (clients.length === 0) {
      if (this.cfg.ai?.requireToken === false) return { ok: true, client: null }
      return { ok: false, status: 401, code: 'ai_unauthorized', message: '尚未签发客户端令牌' }
    }
    if (!token) return { ok: false, status: 401, code: 'ai_unauthorized', message: '缺少 Bearer 令牌' }

    for (const c of clients) {
      if (c.disabled) continue
      if (timingSafeEqual(hashToken(token, c.tokenSalt), c.tokenHash)) {
        return { ok: true, client: c }
      }
    }

    // 限流只记「猜错令牌」：它是防爆破的闸门（每个客户端另有按令牌的 rpm），
    // 顺手把正常流量也掐掉的话，同一出口 IP 下的多台设备会互相拖累。
    const ip = clientIp(req)
    const gate = this.authLimiter.take(`auth:${ip}`)
    if (!gate.ok) return { ok: false, status: 429, code: 'rate_limited', message: '尝试过于频繁' }
    return { ok: false, status: 401, code: 'ai_unauthorized', message: '令牌无效' }
  }

  /** 签发客户端令牌：返回明文一次，配置里只留摘要。models 为可用模型白名单（空 = 全部）。 */
  issueClientToken({ name, scopes = ['chat'], rpm = 60, models = [] }) {
    const token = `rein_sk_${crypto.randomBytes(24).toString('hex')}`
    const tokenSalt = crypto.randomBytes(16).toString('hex')
    const client = {
      id: `c_${crypto.randomBytes(6).toString('hex')}`,
      name: String(name ?? 'unnamed').slice(0, 64),
      tokenSalt,
      tokenHash: hashToken(token, tokenSalt),
      scopes,
      rpm,
      models: Array.isArray(models) ? models.map((m) => String(m)).slice(0, 64) : [],
      createdAt: nowIso(),
      disabled: false,
    }
    this.cfg.ai.clients = [...(this.cfg.ai.clients ?? []), client]
    return { client, token }
  }

  /** 记一条用量（附带成本）。成本在这一处统一计算，三条出口不会漏账。 */
  record(entry) {
    if (this.cfg.ai?.logUsage === false) return
    const file = path.join(this.logDir, `ai-usage-${new Date().toISOString().slice(0, 10)}.jsonl`)
    const cost = this.costOf({
      model: entry.model,
      usage: entry.usage,
      requestBytes: entry.requestBytes ?? 0,
      responseBytes: entry.responseBytes ?? 0,
    })
    try {
      fs.appendFileSync(file, `${JSON.stringify({ ts: nowIso(), ...entry, cost })}\n`)
    } catch (e) {
      this.log('ai-usage-error', { error: String(e) })
    }
  }

  // ---- 路由处理 ---------------------------------------------------------

  health() {
    const active = this.activeProviders()
    return {
      ok: true,
      service: 'rein-ai-gateway',
      reserved: true,
      enabled: Boolean(this.cfg.ai?.enabled),
      status: active.length > 0 ? 'ready' : 'not_configured',
      baseUrl: this.cfg.publicBaseUrl,
      providers: (this.cfg.ai?.providers ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        models: p.models ?? [],
        // 欠费兜底：退路是谁、此刻是否在冷却（在冷却 = 流量已经切到备选上了）
        fallbackTo: p.fallback?.providerId ?? null,
        coolingDown: this.breakerOpen(p.id),
      })),
      pricing: this.pricingInfo(),
      // auto-model 别名此刻指向哪款模型（没配就是空串，清单里也不会出现这个别名）
      autoModel: String(this.cfg.ai?.autoModel ?? ''),
      requireToken: this.cfg.ai?.requireToken !== false,
      clientCount: (this.cfg.ai?.clients ?? []).length,
      endpoints: {
        models: '/v1/models',
        chatCompletions: '/v1/chat/completions',
        usage: '/api/v1/ai/usage',
        selfCheck: '/api/v1/ai/selfcheck',
      },
    }
  }

  /** GET /v1/models —— 服务端指定客户端可用模型：白名单过滤 + 官方单价一并下发。 */
  async models(req, res) {
    const auth = this.authenticate(req)
    if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)

    const client = auth.client
    const pricing = this.pricingInfo()
    sendJson(res, 200, {
      object: 'list',
      data: this.catalog(client),
      rein: {
        service: 'rein-ai-gateway',
        currency: pricing.currency,
        unit: pricing.unit,
        trafficPerGb: pricing.trafficPerGb,
        trafficScope: pricing.trafficScope,
        // 令牌可见范围：客户端据此提示「这个密钥能用哪些模型」
        client: client
          ? { id: client.id, name: client.name, rpm: client.rpm, models: client.models ?? [] }
          : null,
        updatedAt: nowIso(),
      },
    })
  }

  /** POST /v1/chat/completions —— 流式/非流式透传。 */
  async chatCompletions(req, res, ctx) {
    const auth = this.authenticate(req)
    if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)

    const client = auth.client
    if (client) {
      const gate = this.limiter.take(client.id, 1)
      if (!gate.ok) {
        res.setHeader('Retry-After', String(gate.retryAfter))
        return sendError(res, 429, 'rate_limited', '超出配额，稍后再试', { retryAfter: gate.retryAfter })
      }
    }

    const active = this.activeProviders()
    if (!this.cfg.ai?.enabled || active.length === 0) {
      return sendError(
        res,
        503,
        'ai_not_configured',
        '在线模型服务尚未配置 provider。请在服务端 config.json 的 ai.providers 填入 baseUrl/apiKey 并置 enabled=true。',
        { hint: 'GET /api/v1/ai/health 可查看当前状态' },
      )
    }

    let body
    try {
      body = await readJsonBody(req, CHAT_BODY_LIMIT)
    } catch (e) {
      return sendError(res, e.status ?? 400, 'bad_request', e.message)
    }

    // 令牌白名单：服务端签发的密钥决定这个客户端能用哪些模型
    const requested = String(body?.model ?? '')
    if (!this.modelAllowed(client, requested)) {
      return sendError(res, 403, 'model_not_allowed', `当前密钥无权使用模型 ${requested}`, {
        allowed: client?.models ?? [],
      })
    }

    // auto 系列别名（含 auto-model）在这里落定成真实模型名，再按它挑 provider
    const model = this.resolveModel(client, requested)
    if (!model) {
      return sendError(res, 400, 'bad_request', '无法确定模型名（provider 未配置 models）')
    }
    // 转发链：主 provider 打头；主家欠费时沿链退到备选（模型名按配置的映射改写）
    const chain = this.chainFor(model)
    if (chain.length === 0) return sendError(res, 503, 'ai_not_configured', '没有可用的 provider')

    const started = Date.now()
    const wantStream = Boolean(body?.stream)
    // 主上游刚撞过欠费、还在冷却里：直接走备选，不必每个请求都去撞一遍已经欠费的墙
    const steps = chain.length > 1 && this.breakerOpen(chain[0].provider.id) ? chain.slice(1) : chain

    let upstream = null
    let provider = null
    let upstreamBody = null
    let requestBytes = 0

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      const payload = { ...body, model: step.model }
      if (wantStream) {
        // 让上游一定回 usage：否则流式请求只能算出流量费，token 费会漏账
        payload.stream_options = { ...(payload.stream_options ?? {}), include_usage: true }
      }
      const url = `${step.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
      // 请求体里可能带图（base64），先量一下体积，记账用
      const bytes = Buffer.byteLength(JSON.stringify(payload))

      let attempt
      try {
        attempt = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${step.provider.apiKey}`,
            Accept: wantStream ? 'text/event-stream' : 'application/json',
            'User-Agent': 'rein-ai-gateway/1.0',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(300_000),
        })
      } catch (e) {
        this.record({
          clientId: client?.id ?? null,
          clientName: client?.name ?? null,
          provider: step.provider.id,
          model: step.model,
          status: 'upstream_error',
          error: String(e),
          ms: Date.now() - started,
        })
        const next = steps[i + 1]
        // 连不上也是「换一家就能服务」的故障；没有备选就照原样报错
        if (!next) return sendError(res, 502, 'upstream_unreachable', `无法连接上游 provider：${e.message}`)
        this.log('ai-failover', { from: step.provider.id, to: next.provider.id, reason: 'unreachable' })
        continue
      }

      if (attempt.ok) {
        upstream = attempt
        provider = step.provider
        upstreamBody = payload
        requestBytes = bytes
        break
      }

      const text = await attempt.text().catch(() => '')
      this.record({
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        provider: step.provider.id,
        model: step.model,
        status: attempt.status,
        ms: Date.now() - started,
      })

      const next = steps[i + 1]
      // 只有账户级故障才换：欠费换一家立刻能服务，参数写错换到哪都一样还白烧备选额度
      if (next && isAccountBlocked(attempt.status, text)) {
        const cooldownSec = Number(step.provider.fallback?.cooldownSec ?? 120)
        this.tripBreaker(step.provider.id, cooldownSec)
        this.log('ai-failover', {
          from: step.provider.id,
          to: next.provider.id,
          model: step.model,
          status: attempt.status,
          cooldownSec,
          detail: text.slice(0, 300),
        })
        continue
      }

      // 上游报错：原样把状态码与响应体带回去，便于客户端排错（key 不会被回显）
      res.writeHead(attempt.status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(text || JSON.stringify({ error: { code: 'upstream_error', message: '上游返回错误' } }))
      return
    }

    if (!wantStream) {
      const text = await upstream.text()
      let usage = null
      try {
        usage = JSON.parse(text)?.usage ?? null
      } catch {
        /* 上游不是 JSON，原样透传 */
      }
      const responseBytes = Buffer.byteLength(text)
      const cost = this.costOf({ model: upstreamBody.model, usage, requestBytes, responseBytes })
      this.record({
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        provider: provider.id,
        model: upstreamBody.model,
        status: upstream.status,
        requestBytes,
        responseBytes,
        usage,
        ms: Date.now() - started,
      })
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        // 成本直接写进响应头，客户端不必再算一遍（流式拿不到，见 /api/v1/ai/usage）
        'X-Rein-Cost-Cny': String(round9(cost.total)),
        'X-Rein-Cost-Model-Cny': String(round9(cost.tokenCost)),
        'X-Rein-Cost-Traffic-Cny': String(round9(cost.trafficCost)),
        'X-Rein-Bytes-Out': String(cost.trafficBytes),
      })
      res.end(text)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let responseBytes = 0
    let usage = null
    let tail = ''
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        responseBytes += value.length
        res.write(value)
        // 用量通常在最后几个 chunk 的 SSE 里，只留尾巴做解析，别囤整条流
        tail = (tail + Buffer.from(value).toString('utf8')).slice(-4096)
        const m = /"usage"\s*:\s*(\{[^}]*\})/.exec(tail)
        if (m) {
          try {
            usage = JSON.parse(m[1])
          } catch {
            /* 分片截断，下一轮再试 */
          }
        }
      }
    } catch (e) {
      this.log('ai-stream-error', { error: String(e), clientId: client?.id ?? null })
    } finally {
      res.end()
      this.record({
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        provider: provider.id,
        model: upstreamBody.model,
        status: 200,
        stream: true,
        requestBytes,
        responseBytes,
        usage,
        ms: Date.now() - started,
        ip: ctx?.ip ?? null,
      })
    }
  }

  /** 自检：真正打一次上游（1 token 的极小请求），把「配置对不对」一次问清。 */
  async selfcheck(req, res) {
    const auth = this.authenticate(req)
    if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)

    const active = this.activeProviders()
    if (active.length === 0) {
      return sendJson(res, 503, {
        ok: false,
        status: 'not_configured',
        message: '没有启用的 provider',
        providers: this.health().providers,
      })
    }

    const results = []
    for (const p of active) {
      const model = p.models?.[0]
      const started = Date.now()
      try {
        const r = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.apiKey}`,
          },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await r.text()
        results.push({
          provider: p.id,
          model,
          ok: r.ok,
          status: r.status,
          ms: Date.now() - started,
          detail: r.ok ? 'ok' : text.slice(0, 500),
        })
      } catch (e) {
        results.push({ provider: p.id, model, ok: false, ms: Date.now() - started, detail: String(e) })
      }
    }
    sendJson(res, 200, { ok: results.every((r) => r.ok), results })
  }

  /** 读最近 N 天的用量明细（按天分文件；半截行是进程被杀留下的，跳过即可）。 */
  readUsageEntries(days = 7) {
    const out = []
    for (let i = 0; i < days; i += 1) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      const file = path.join(this.logDir, `ai-usage-${date}.jsonl`)
      if (!fs.existsSync(file)) continue
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          out.push({ ...JSON.parse(line), date })
        } catch {
          /* 坏行忽略 */
        }
      }
    }
    return out
  }

  /** 明细 → 成本汇总：总量 / 按天 / 按模型 / 按令牌。成本在记账时已算好，这里只累加。 */
  summarize(entries) {
    const blank = () => ({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      bytesIn: 0,
      bytesOut: 0,
      costCNY: { tokens: 0, traffic: 0, total: 0 },
    })
    const add = (b, e) => {
      b.calls += 1
      b.promptTokens += e.usage?.prompt_tokens ?? 0
      b.completionTokens += e.usage?.completion_tokens ?? 0
      b.bytesIn += e.requestBytes ?? 0
      b.bytesOut += e.responseBytes ?? 0
      // 累加用原始精度：单笔流量费约 1e-7，逐笔取整会让「用得多却不出钱」
      b.costCNY.tokens += e.cost?.tokenCost ?? 0
      b.costCNY.traffic += e.cost?.trafficCost ?? 0
      b.costCNY.total += e.cost?.total ?? 0
    }
    // 出口处收敛到 1e-9 元：既不是科学计数法糊脸，也不丢小额流量费
    const settle = (b) => {
      b.costCNY.tokens = round9(b.costCNY.tokens)
      b.costCNY.traffic = round9(b.costCNY.traffic)
      b.costCNY.total = round9(b.costCNY.total)
      return b
    }

    const totals = blank()
    const days = new Map()
    const models = new Map()
    const clients = new Map()
    for (const e of entries) {
      add(totals, e)

      const day = days.get(e.date) ?? { date: e.date, ...blank(), byModel: {} }
      add(day, e)
      const modelKey = `${e.provider ?? '?'}/${e.model ?? '?'}`
      day.byModel[modelKey] = (day.byModel[modelKey] ?? 0) + 1
      days.set(e.date, day)

      const m = models.get(modelKey) ?? { key: modelKey, provider: e.provider ?? null, model: e.model ?? null, ...blank() }
      add(m, e)
      models.set(modelKey, m)

      const ck = e.clientId ?? 'open'
      const c = clients.get(ck) ?? { clientId: e.clientId ?? null, clientName: e.clientName ?? null, ...blank() }
      add(c, e)
      clients.set(ck, c)
    }

    const byCost = (m) => [...m.values()].sort((a, b) => b.costCNY.total - a.costCNY.total)
    return {
      totals: settle(totals),
      byDay: [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).map(settle),
      byModel: byCost(models).map(settle),
      byClient: byCost(clients).map(settle),
    }
  }

  /** 最近 N 天的全局用量与成本（管理面）。 */
  usage(days = 7) {
    return this.summarize(this.readUsageEntries(days))
  }

  /** 单个令牌的用量与总成本（客户端自查「我一共花了多少」）。 */
  clientUsage(client, days = 7) {
    const own = this.readUsageEntries(days).filter((e) => e.clientId === (client?.id ?? null))
    return {
      client: client
        ? { id: client.id, name: client.name, rpm: client.rpm, models: client.models ?? [] }
        : null,
      ...this.summarize(own),
    }
  }

  /** GET /api/v1/ai/usage —— 客户端令牌鉴权，只回自己的账（服务端为准）。 */
  async usageForRequest(req, res, days = 7) {
    const auth = this.authenticate(req)
    if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
    const d = Math.min(Math.max(Number(days) || 7, 1), 90)
    sendJson(
      res,
      200,
      { ok: true, days: d, pricing: this.pricingInfo(), ...this.clientUsage(auth.client, d) },
      { 'Cache-Control': 'no-store' },
    )
  }
}
