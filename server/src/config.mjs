/**
 * 配置装载。
 *
 * 首次启动没有 config.json 时会生成一份（含随机 admin token），并把 token 打印到
 * 标准输出，免得部署完还要人肉去编文件。之后所有改动都以文件为准 —— 运维改配置
 * 只需 `systemctl restart`，不用重新部署代码。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 国内可直连的 OpenAI 兼容 provider 预设（key 留空 = 未启用）。 */
const PROVIDER_PRESETS = [
  {
    id: 'ark',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: '',
    models: ['doubao-seed-1-6-250615', 'deepseek-v4-pro-250915'],
    enabled: false,
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen3-max', 'qwen-plus'],
    enabled: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    enabled: false,
  },
]

/**
 * 计价默认值：模型按各家官方页价、服务端不溢价；服务器流量 0.8 元/GB。
 *
 * 价格单位是「元 / 百万 tokens」。未登记的模型落到 default（0 = 只计流量费，
 * 不会算成免费而误报）。DeepSeek 官网 2026-09 高峰时段价：deepseek-flash 2/8、
 * deepseek-v4-pro 9/27；空闲时段是高峰价的一半，要按空闲价计就自行下调
 * （见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing）。
 */
function defaultPricing() {
  return {
    currency: 'CNY',
    unit: 'per_1m_tokens',
    // 流量计费口径：egress（只算出方向，同阿里云按流量计费）| ingress | both
    traffic: { perGb: 0.8, scope: 'egress' },
    default: { in: 0, out: 0 },
    models: {
      'deepseek-flash': { in: 2, out: 8 },
      'deepseek-v4-pro': { in: 9, out: 27 },
    },
  }
}

/** 价格表清洗：负数/非数字一律归零，口径只认三个合法值。 */
export function normalizePricing(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const models = {}
  for (const [name, price] of Object.entries(p.models ?? {})) {
    if (!name || !price || typeof price !== 'object') continue
    const entry = { in: money(price.in), out: money(price.out) }
    if (price.cacheIn !== undefined && price.cacheIn !== null) entry.cacheIn = money(price.cacheIn)
    models[String(name).slice(0, 128)] = entry
  }
  const scope = ['egress', 'ingress', 'both'].includes(p.traffic?.scope) ? p.traffic.scope : 'egress'
  return {
    currency: String(p.currency ?? 'CNY').slice(0, 8),
    unit: 'per_1m_tokens',
    traffic: { perGb: money(p.traffic?.perGb ?? 0.8), scope },
    default: { in: money(p.default?.in), out: money(p.default?.out) },
    models,
  }
}

function money(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function defaultConfig(publicBaseUrl) {
  return {
    port: 8787,
    host: '0.0.0.0',
    publicBaseUrl,
    adminToken: `rein_${crypto.randomBytes(24).toString('hex')}`,
    update: {
      defaultChannel: 'stable',
      channels: ['stable', 'beta', 'canary'],
      publicKey: null,
      requireSignature: true,
      keepVersions: 8,
      notes: 'Rein 更新分发：清单与安装包均带 Ed25519 签名，客户端下载后验签通过才安装。',
    },
    ai: {
      enabled: true,
      requireToken: true,
      providers: PROVIDER_PRESETS,
      clients: [],
      rate: { rpm: 60, burst: 10 },
      pricing: defaultPricing(),
    },
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 深合并（数组整体替换），用于「配置文件缺字段时回落默认值」。 */
function mergeDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) {
      target[k] = v
    } else if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === 'object' &&
      !Array.isArray(target[k])
    ) {
      mergeDefaults(target[k], v)
    }
  }
  return target
}

export function loadConfig() {
  const dataDir = path.resolve(process.env.REIN_DATA_DIR ?? path.join(SERVER_DIR, 'data'))
  const configFile = path.resolve(process.env.REIN_CONFIG ?? path.join(SERVER_DIR, 'config.json'))
  const publicBaseUrl =
    process.env.REIN_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? `http://127.0.0.1:8787`

  fs.mkdirSync(dataDir, { recursive: true })

  let cfg = readJson(configFile)
  let created = false
  if (!cfg) {
    cfg = defaultConfig(publicBaseUrl)
    writeJsonAtomic(configFile, cfg)
    created = true
  } else {
    // 端口/密钥这类单值字段以环境变量优先（systemd 里改端口比改文件更顺手）
    mergeDefaults(cfg, defaultConfig(publicBaseUrl))
    cfg.dataDir = dataDir
    cfg.configFile = configFile
    if (created) writeJsonAtomic(configFile, cfg)
  }

  cfg.dataDir = dataDir
  cfg.configFile = configFile
  if (process.env.REIN_PORT) cfg.port = Number(process.env.REIN_PORT)
  if (process.env.REIN_HOST) cfg.host = process.env.REIN_HOST
  if (process.env.REIN_ADMIN_TOKEN) cfg.adminToken = process.env.REIN_ADMIN_TOKEN
  cfg.publicBaseUrl = String(cfg.publicBaseUrl ?? publicBaseUrl).replace(/\/+$/, '')

  // 配置里允许写相对路径（data 目录内），部署脚本从别处拷配置时不会踩空
  cfg.update.publicKey = cfg.update.publicKey ? String(cfg.update.publicKey) : null
  for (const p of cfg.ai.providers) {
    p.enabled = Boolean(p.enabled && p.apiKey)
  }
  cfg.ai.clients = (cfg.ai.clients ?? []).map((c) => ({
    ...c,
    // 旧配置没有白名单字段：空数组 = 该令牌可用全部模型
    models: Array.isArray(c.models) ? c.models.map((m) => String(m)) : [],
  }))
  cfg.ai.pricing = normalizePricing(cfg.ai.pricing)

  return { cfg, created }
}
