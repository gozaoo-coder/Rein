/**
 * AI 内核协议层：RustAgent 壳里的**纯函数**部分。
 *
 * 单独成文件是为了能像 streamExtract / streamBubbles 那样被 Node 直跑（`probe-rust-agent.mjs`）：
 * 这些转换（历史回灌、工具结果编码、终稿构造、本步累积）是壳里最容易出错的地方，
 * 而它们全都与 Tauri / 网络无关，可以在进程内穷举断言。
 */

import type { AgentFinalMessage, AgentImage, AgentMessageInput, AgentToolOutcome, AgentUsage } from '@/types'

/** 内核工具的原始返回值（pi AgentToolResult 的结构子集） */
export interface RawToolResult {
  content?: unknown
}

/** pi Message[] → 内核 LlmMessage[]（历史回灌；工具中间轮不回放） */
export function toLlmMessages(history: AgentFinalMessage[]): AgentMessageInput[] {
  const out: AgentMessageInput[] = []
  for (const raw of history) {
    const m = raw as { role?: string; content?: unknown; toolCallId?: string }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
        continue
      }
      if (Array.isArray(m.content)) {
        const texts: string[] = []
        const images: AgentImage[] = []
        for (const b of m.content as { type?: string; text?: string; data?: string; mimeType?: string }[]) {
          if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b?.type === 'image' && typeof b.data === 'string') {
            images.push({ data: b.data, mime: b.mimeType ?? 'image/png' })
          }
        }
        out.push({ role: 'user', content: texts.join('\n'), images })
      }
      continue
    }
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content)
        ? (m.content as { type?: string; text?: string; thinking?: string }[])
        : []
      const text = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      const thinking = blocks
        .filter((b) => b?.type === 'thinking')
        .map((b) => b.thinking ?? '')
        .join('\n')
      out.push({ role: 'assistant', content: text, reasoning: thinking || null })
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: typeof m.content === 'string' ? m.content : '',
        toolCallId: m.toolCallId ?? null,
      })
    }
  }
  return out
}

/** 注册表工具返回值 → 内核工具结果（文本拼接 + 图片块） */
export function outcomeFromToolResult(res: unknown): AgentToolOutcome {
  const content = (res as RawToolResult | null)?.content
  if (!Array.isArray(content)) {
    return { content: typeof res === 'string' ? res : JSON.stringify(res ?? null), isError: false }
  }
  const texts: string[] = []
  const images: AgentImage[] = []
  for (const b of content as { type?: string; text?: string; data?: string; mimeType?: string }[]) {
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b?.type === 'image' && typeof b.data === 'string') {
      images.push({ data: b.data, mime: b.mimeType ?? 'image/png' })
    }
  }
  return { content: texts.join('\n') || '已完成', isError: false, images }
}

/** 内核工具结果 → pi 风格 content 块（工具行 brief 与放大镜图片都从这里读） */
export function blocksFromOutcome(outcome: AgentToolOutcome): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: outcome.content }]
  for (const img of outcome.images ?? []) {
    blocks.push({ type: 'image', data: img.data, mimeType: img.mime })
  }
  return blocks
}

/** 结果里的图片块 → 过程卡要展示的那张图（无图返回 undefined） */
export function imageFromToolResult(res: unknown): { base64: string; mime: string } | undefined {
  const blocks = (res as RawToolResult | null)?.content
  if (!Array.isArray(blocks)) return undefined
  for (const b of blocks as { type?: string; data?: string; mimeType?: string }[]) {
    if (b?.type === 'image' && typeof b.data === 'string') {
      return { base64: b.data, mime: b.mimeType ?? 'image/png' }
    }
  }
  return undefined
}

/**
 * 工具结果里的**结构化载荷**：给前端自己用的那部分（不是回灌给模型的文本）。
 *
 * 三条来路，形状不同，这里统一收口：
 * - 内核工具（Rust 注册表）：结果是工具返回值的紧凑 JSON 文本，载荷在根上（如 present_file 的 file）；
 * - TS 工具：注册表把返回值包成 `{ok,data}` 信封，载荷在 data 里；
 * - rawContent 工具（放大镜）：原始 AgentToolResult 自带 details 字段，直接用。
 * 解不出来返回 null —— 前端只少一张卡片，不影响对话本身。
 */
export function toolDetailsFromResult(res: unknown): unknown {
  const raw = res as { details?: unknown; content?: unknown } | null
  if (raw?.details !== undefined) return raw.details
  const blocks = Array.isArray(raw?.content) ? raw.content : null
  const text = (blocks as { type?: string; text?: string }[] | null)?.find(
    (b) => b?.type === 'text',
  )?.text
  if (typeof text !== 'string' || !text.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null // 纯文本结果（「已完成」之类）：没有结构化载荷
  }
  if (!parsed || typeof parsed !== 'object') return null
  const env = parsed as { ok?: unknown; data?: unknown }
  return typeof env.ok === 'boolean' && 'data' in env ? env.data : parsed
}

/** 终稿 assistant 消息（含 thinking 块与 usage，供入口的读取函数消费） */
export function finalMessage(
  text: string,
  thinking: string | null,
  usage: AgentUsage,
  stopReason: string,
): AgentFinalMessage {
  const content: { type: 'text' | 'thinking'; text?: string; thinking?: string }[] = [
    { type: 'text', text },
  ]
  if (thinking) content.unshift({ type: 'thinking', thinking })
  return { role: 'assistant', content, usage, stopReason }
}

/** 零值用量（内核未回 usage 时的兜底） */
export function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
}

/**
 * 单步累积器：正文与思考按步累计，工具开始/重试时重置。
 *
 * 语义对齐 pi：工具后模型重新输出答复，文本从头计；内核重试会给该步重发增量，
 * 因此也要重置（否则界面会出现重复内容）。
 */
export class StepAccumulator {
  text = ''
  thinking = ''
  /** 本步工具调用的结果（load_tools 的装载判定要用它） */
  readonly toolResults: { toolName: string; content: unknown }[] = []

  /** 文本增量 */
  onTextDelta(delta: string): void {
    this.text += delta
  }

  /** 思考增量 */
  onThinkingDelta(delta: string): void {
    this.thinking += delta
  }

  /** 该步思考全文（内核在步末重发） */
  onThinkingEnd(content: string): void {
    this.thinking = content
  }

  /** 新一步开始（收到工具请求）：文本与思考都从头计 */
  onStepBoundary(): void {
    this.text = ''
    this.thinking = ''
  }

  /** 内核重试当前步：该步增量会重发，先清空 */
  onStepRetry(): void {
    this.text = ''
    this.thinking = ''
  }

  /** 记一次工具结果（供 load_tools 判定） */
  pushToolResult(toolName: string, outcome: AgentToolOutcome): void {
    this.toolResults.push({ toolName, content: blocksFromOutcome(outcome) })
  }
}
