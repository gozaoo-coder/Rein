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
  | 'text' // 纯文本气泡
  | 'photo' // 用户上传的照片气泡（imageBase64 为压缩缩略图）
  | 'food-parse' // 附带可确认的食物解析卡片
  | 'analysis' // 今日饮食分析卡片
  | 'tools' // AI 工具调用过程卡（可折叠）

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
}

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
  /** LLM 回复的思考内容（气泡上方可折叠展示） */
  thinking?: string
  /** 被引用的消息文本（发送时引用了某条消息） */
  quoteText?: string
  /** kind=tools 时本轮流次的工具调用记录 */
  toolCalls?: ToolCallRecord[]
}

/* ---------- 模型配置（Rust modules/ai · ai_models） ---------- */

/** 一条用户添加的 AI 模型配置；能力探测结果三态：null=未知 */
export interface AiModel {
  id: number
  name: string
  /** UI 预设标识（deepseek | openai-compatible），请求格式按 baseUrl 自动探测 */
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  isDefault: boolean
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  lastError: string | null
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
}

/** max_tokens=1 探测包结果 */
export interface AiProbeResult {
  vision: boolean | null
  thinking: boolean | null
  effort: boolean | null
  error: string | null
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
