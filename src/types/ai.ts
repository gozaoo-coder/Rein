/** AI 域类型 · 与 Rust `modules/ai` 对应 */

import type { DailyTargets } from './nutrition'

export interface ParsedFoodItem {
  foodId: number | null
  foodName: string
  grams: number
  kcalEstimate: number
  /** 0~1，关键词解析给低置信度，未来接入视觉/LLM 后提高 */
  confidence: number
  note: string | null
}

/** 可被 AI 调整的目标字段（DailyTargets 的键） */
export type TargetField = keyof DailyTargets

/** 目标调整建议中的单项变更（展示 old → new） */
export interface TargetChange {
  field: TargetField
  label: string
  unit: string
  from: number
  to: number
}

/** AI 目标调整建议：完整新目标 + 变更清单 + 面向用户的解释 */
export interface TargetAdjustProposal {
  targets: DailyTargets
  changes: TargetChange[]
  reply: string
}

export type AiRole = 'user' | 'assistant'

export type AiMessageKind =
  | 'text' // 纯文本气泡（Markdown 渲染）
  | 'photo' // 用户上传的照片气泡（imageBase64 为压缩缩略图）
  | 'doc' // 用户上传的 Office 文档气泡（含解析文本与选中图片）
  | 'food-parse' // 附带可确认的食物解析卡片
  | 'analysis' // 今日饮食分析卡片
  | 'tools' // AI 工具调用过程卡（可折叠）
  | 'voice' // 用户语音轮：转写文本 + 关联纪要（点开语音会话视图回看/重放）

/** 单次工具调用的过程记录（持久化在 payload.calls） */
export interface ToolCallRecord {
  name: string
  /** 中文短名（注册表 label） */
  label: string
  /** 入参摘要（截断 JSON） */
  argsBrief: string
  /** 结果摘要；执行中为 null */
  resultBrief: string | null
  status: 'running' | 'ok' | 'error'
  /** 工具返回的图片（放大镜结果），随过程卡展示 */
  resultImage?: { base64: string; mime: string }
  /** 放大镜结果图的注册 id 与视图尺寸（历史重建时恢复可继续放大） */
  zoomId?: string
  zoomW?: number
  zoomH?: number
  /** 放大区域在根位图坐标中的区域（历史重建时恢复「裁原图」语义） */
  zoomRect?: { x: number; y: number; w: number; h: number }
}

/** kind=doc 消息携带的文档信息（持久化在 payload.doc） */
export interface AiDocMeta {
  name: string
  kind: 'docx' | 'pptx' | 'xlsx' | 'text'
  /** 抽取文本（已截断，随用户轮发给模型） */
  text: string
  /** 全文（未截断，仅本轮内存）：发送时自动归档进知识库 文档/ 命名空间，AI 经分页读全文 */
  fullText?: string
  chars: number
  truncated: boolean
  imagesTotal: number
  skippedImages: number
}

/** 推理过程段里的单次工具调用（照搬 EffiBuddy ToolCallRecord 展示形态） */
export interface ProcessToolCall {
  callId: string
  /** 展示名（注册表中文短名 label）；rawName 为匹配工具结果的原始名 */
  toolName: string
  rawName?: string
  /** 原始 JSON 字符串参数 */
  arguments: string
  /** 执行结果（未到达时为 null） */
  result: string | null
  isError: boolean
  /** 是否正在执行中 */
  pending: boolean
  /** 工具返回的图片（放大镜结果），随详情展示 */
  resultImage?: { base64: string; mime: string }
  /** 放大镜结果图的注册 id 与视图尺寸（历史重建时恢复可继续放大） */
  zoomId?: string
  zoomW?: number
  zoomH?: number
  /** 放大区域在根位图坐标中的区域（历史重建时恢复「裁原图」语义） */
  zoomRect?: { x: number; y: number; w: number; h: number }
}

/** 推理过程段：按流式到达顺序穿插的「思考文字 / 工具调用」片段，
 * 用于把工具执行结果插入到思考文字之间展示，而非与思考文字隔开单独成块。 */
export type ProcessSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; call: ProcessToolCall }

export interface AiMessage {
  id: string
  role: AiRole
  kind: AiMessageKind
  at: string
  text?: string
  /** kind=food-parse 时的解析结果 */
  items?: ParsedFoodItem[]
  /** 解析结果是否已写入今日饮食 */
  committed?: boolean
  /** 解析来源（写入饮食记录时使用） */
  source?: 'photo_ai' | 'text_ai'
  /** kind=photo 时的压缩缩略图（base64，无 data: 前缀） */
  imageBase64?: string
  mime?: string
  /** kind=doc 时的文档信息 */
  doc?: AiDocMeta
  /** 多图消息（kind=doc / photo）：随消息发给模型的图片；w/h 为发给模型的视图尺寸，label 为图片清单说明 */
  images?: { base64: string; mime: string; w: number; h: number; label: string }[]
  /** 图片清单文本（含 img-xx 编号与视图尺寸），随用户轮发给模型供放大镜引用 */
  imgNote?: string
  /** LLM 回复的思考内容（气泡上方可折叠展示） */
  thinking?: string
  /** 推理过程段（思考文字与工具调用按到达顺序穿插；持久化在 payload.segments） */
  segments?: ProcessSegment[]
  /** 已完成思考段的累计秒数（跨段累加；持久化在 payload.thinkingSec） */
  thinkingSec?: number
  /** 被引用的消息文本（发送时引用了某条消息） */
  quoteText?: string
  /** kind=tools 时本轮流次的工具调用记录 */
  toolCalls?: ToolCallRecord[]
  /** kind=voice 时关联的纪要信息（payload 持久化；点气泡打开语音会话回看/重放） */
  voiceMeta?: { memoId: string; durationMs: number; words: number }
  /** 流式生成中（仅内存占位气泡；定稿/出错即清除，不持久化） */
  streaming?: boolean
}

/* ---------- 模型配置（Rust modules/ai · ai_models） ---------- */

/** 一条用户添加的 AI 模型配置；能力探测结果三态：null=未知 */
export interface AiModel {
  id: number
  name: string
  /** UI 预设标识（deepseek | openai-compatible | rein-online），请求格式按 baseUrl 自动探测 */
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault: boolean
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  /** 发给模型的图片最长边（像素）；null = 用前端默认（DEFAULT_IMAGE_EDGE） */
  imageMaxEdge: number | null
  lastError: string | null
  /** manual = 自己填的（BYOK）；online = 由 Rein 在线服务下发导入 */
  source: string
  /** online 模型的来源服务地址 */
  serviceBase: string | null
  /** 单价（元 / 百万 tokens）；null = 不计模型费（自填 key 的模型默认如此） */
  priceIn: number | null
  priceOut: number | null
  priceCurrency: string | null
  /** 该服务的出方向流量单价（元 / GB），服务端下发 */
  trafficPerGb: number | null
  createdAt: string
  updatedAt: string
}

/** 添加/编辑模型表单 */
export interface AiModelInput {
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault: boolean
  /** 图片发送分辨率上限；缺省/null 用前端默认 */
  imageMaxEdge?: number | null
  /** 单价（元/百万 tokens），可空；online 模型忽略（以服务端为准） */
  priceIn?: number | null
  priceOut?: number | null
}

/** max_tokens=1 探测包结果 */
export interface AiProbeResult {
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  error: string | null
}

/* ---------- Rein 在线服务（模型由服务端下发 · 密钥 · 成本） ---------- */

export interface OnlineServiceSettings {
  baseUrl: string
  /** 服务端签发的客户端密钥（rein_sk_…） */
  apiKey: string
  savedAt: string | null
}

/** 服务端下发的单个模型 */
export interface OnlineModel {
  id: string
  providerId: string
  providerName: string
  /** 元 / 百万 tokens（官方价） */
  priceIn: number
  priceOut: number
  /** false = 服务端未登记价格，只计流量费 */
  priced: boolean
  currency: string
  unit: string
}

/** 用密钥换来的模型目录 */
export interface OnlineCatalog {
  baseUrl: string
  ok: boolean
  /** ready | not_configured | unauthorized | forbidden | error | unreachable */
  status: string
  modelsEndpoint: string
  chatEndpoint: string
  currency: string
  trafficPerGb: number
  /** egress | ingress | both */
  trafficScope: string
  clientName: string | null
  /** 密钥可见的模型白名单（空 = 全部） */
  clientModels: string[]
  models: OnlineModel[]
  error: string | null
  checkedAt: string
  elapsedMs: number
}

/** 服务端记的账（与本机账本对账用） */
export interface OnlineUsage {
  ok: boolean
  baseUrl: string
  days: number
  calls: number
  promptTokens: number
  completionTokens: number
  bytesIn: number
  bytesOut: number
  costTokens: number
  costTraffic: number
  costTotal: number
  currency: string
  error: string | null
}

export interface OnlineSyncResult {
  added: number
  updated: number
  removed: number
  models: AiModel[]
}

/* ---------- 本机成本账本（金额一律纳元：1e-9 元） ---------- */

export interface AiUsageInput {
  chatId?: string | null
  modelPk?: number | null
  modelName: string
  modelId: string
  provider?: string
  source?: string
  promptTokens?: number
  completionTokens?: number
  requestBytes?: number
  responseBytes?: number
  costModelNano?: number
  costTrafficNano?: number
  note?: string | null
}

export interface AiUsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  requestBytes: number
  responseBytes: number
  costModelNano: number
  costTrafficNano: number
  costTotalNano: number
}

export interface AiUsageDay extends AiUsageTotals {
  date: string
}

export interface AiUsageByModel extends AiUsageTotals {
  modelPk: number | null
  modelName: string
  modelId: string
  source: string
}

export interface AiUsageSummary {
  days: number
  since: string
  today: AiUsageTotals
  total: AiUsageTotals
  byDay: AiUsageDay[]
  byModel: AiUsageByModel[]
}

/* ---------- 聊天历史（Rust modules/ai · ai_chats / ai_chat_messages） ---------- */

export interface AiChat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** 持久化消息；food-parse 的 items 序列化在 payload 里 */
export interface AiChatMessage {
  id: string
  chatId: string
  seq: number
  role: AiRole
  kind: AiMessageKind
  text: string | null
  imageBase64: string | null
  mime: string | null
  payload: string | null
  createdAt: string
}

export interface AiChatMessageInput {
  id: string
  role: AiRole
  kind: AiMessageKind
  text: string | null
  imageBase64: string | null
  mime: string | null
  payload: string | null
}

/** 跨会话搜索命中（AI 工具「搜索全部上下文」用） */
export interface ChatSearchHit {
  chatId: string
  chatTitle: string
  seq: number
  role: AiRole
  kind: AiMessageKind
  text: string | null
  createdAt: string
}
