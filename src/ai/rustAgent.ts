/**
 * RustAgent：AI 内核（Rust agent loop）的前端壳。
 *
 * 目标是与 pi 的 `Agent` 表面等价，让 8 个 AI 入口只改「构造」两行、
 * 回调契约零改动（`message_update` / `tool_execution_start|end` 照旧）。
 *
 * 职责：
 * - 订阅 `ai://agent` 事件（按 runId 认领），把内核事件翻译成入口消费的事件流；
 * - **工具执行仍在 TS 侧**（过渡期 + session 域常驻）：收到 `toolStarted` 就跑
 *   注册表里的工具，把结果经 `ai_agent_tool_result` 送回内核；
 * - `load_tools` 动态装载：执行完装载工具后调用 `prepareNextTurnWithContext`
 *   取新的提示词与工具清单，先 `ai_agent_update_context` 再回传结果，
 *   保证内核下一步用上新上下文（顺序确定性由「先更新后回传」保证）。
 *
 * 增量语义对齐 pi：`text_delta` / `thinking_delta` 是增量，`thinking_end` 是该步
 * 思考全文；不一致处唯一的差异是新增 `stepRetry`（内核重试会给该步重新发一遍
 * 增量，壳据此重置本步累积，避免重复显示）。
 */

import type { AgentEvent, AgentFinalMessage, AgentImage, AgentMessageInput, AgentToolOutcome } from '@/types'
import { agentService } from '@/services/agentService'

/** 注册表工具（pi AgentTool 的结构子集；parameters 为 JSON Schema） */
export interface AgentToolLike {
  name: string
  description: string
  parameters: unknown
  execute: (toolCallId: string, params: unknown) => Promise<unknown> | unknown
}

/** 内核事件的「入口视角」形状（与 pi 的 subscribe 事件同名同形） */
export type RustAgentEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'message_update'; assistantMessageEvent: { type: 'thinking_delta'; delta: string } }
  | { type: 'message_update'; assistantMessageEvent: { type: 'thinking_end'; content: string } }
  | { type: 'tool_execution_start'; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean; result: unknown }

/** 终稿消息（入口读 content / usage；形状与 pi 的 AssistantMessage 对齐） */
interface AssistantBlock {
  type: 'text' | 'thinking'
  text?: string
  thinking?: string
}

interface FinalAssistantMessage {
  role: 'assistant'
  content: AssistantBlock[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  stopReason: string
}

export interface RustAgentInit {
  initialState: {
    systemPrompt: string
    /** ai_models 主键（内核据此读 baseUrl / apiKey / modelId） */
    modelPk: number
    thinkingLevel?: string
    tools?: AgentToolLike[]
    /** 历史（pi Message[] 形状；仅 user/assistant 文本与图片，工具中间轮不回放） */
    messages: AgentFinalMessage[]
  }
  /** 仅聊天主链路使用：load_tools 扩载后换 context（队内语义与 pi 一致） */
  prepareNextTurnWithContext?: (ctx: {
    toolResults: { toolName: string; content: unknown }[]
    context: { messages: unknown[] }
  }) => { context: { systemPrompt: string; messages: unknown[]; tools: AgentToolLike[] } } | undefined
}

type Subscriber = (e: RustAgentEvent) => void

export class RustAgent {
  readonly state: { messages: AgentFinalMessage[]; errorMessage?: string } = { messages: [] }

  private readonly init: RustAgentInit
  private subscribers: Subscriber[] = []
  private unlisten: (() => void) | null = null
  private runId: string | null = null
  private settle: (() => void) | null = null
  /** runId 认领前到达的事件（invoke 返回与事件推送存在竞态，先缓冲再回放） */
  private pendingEvents: AgentEvent[] = []

  /** 本步累积（工具调用/重试时重置，与 pi 的「工具后文本重新起算」一致） */
  private stepText = ''
  private stepThinking = ''
  private stepToolResults: { toolName: string; content: unknown }[] = []
  private usage: FinalAssistantMessage['usage'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  }
  private tools: AgentToolLike[]
  private systemPrompt: string

  constructor(init: RustAgentInit) {
    this.init = init
    this.tools = [...(init.initialState.tools ?? [])]
    this.systemPrompt = init.initialState.systemPrompt
    this.state.messages = [...init.initialState.messages]
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.push(cb)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== cb)
    }
  }

  /** 跑一轮（resolve 即轮次结束；失败写 state.errorMessage，与 pi 一致不 reject） */
  async prompt(text: string, images?: { type: 'image'; data: string; mimeType: string }[]): Promise<void> {
    await this.ensureSubscribed()
    this.state.errorMessage = undefined
    this.stepText = ''
    this.stepThinking = ''
    this.stepToolResults = []

    const runId = await agentService.run({
      modelId: this.init.initialState.modelPk,
      systemPrompt: this.systemPrompt,
      messages: toLlmMessages(this.init.initialState.messages),
      prompt: text,
      images: (images ?? []).map((i) => ({ data: i.data, mime: i.mimeType })),
      tools: this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      thinkingLevel: this.init.initialState.thinkingLevel ?? null,
    })
    this.runId = runId
    // 回放认领前到达的事件（顺序保持）
    const buffered = this.pendingEvents
    this.pendingEvents = []
    for (const ev of buffered) this.onEvent(ev)
    await new Promise<void>((resolve) => {
      this.settle = resolve
    })
  }

  /** 取消当前 run（内核中止后台循环；本地立即收敛，不等内核回事件） */
  async cancel(): Promise<void> {
    const runId = this.runId
    if (!runId) return
    this.runId = null
    await agentService.cancel(runId).catch(() => undefined)
    this.finish('已取消')
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.unlisten) return
    this.unlisten = await agentService.onEvent((e) => this.onEvent(e))
  }

  private onEvent(e: AgentEvent): void {
    if (e.type === 'started') return
    if (!this.runId) {
      // 还没认领 runId：先缓冲（见 pendingEvents）
      this.pendingEvents.push(e)
      return
    }
    if (e.runId !== this.runId) return
    switch (e.type) {
      case 'textDelta':
        this.stepText += e.delta
        this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: e.delta } })
        break
      case 'thinkingDelta':
        this.stepThinking += e.delta
        this.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: e.delta },
        })
        break
      case 'thinkingEnd':
        this.stepThinking = e.content
        this.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_end', content: e.content },
        })
        break
      case 'stepRetry':
        // 内核会把该步增量重发一遍：先清本步累积，避免重复显示
        this.stepText = ''
        this.stepThinking = ''
        break
      case 'toolStarted':
        this.stepText = ''
        this.stepThinking = ''
        this.emit({ type: 'tool_execution_start', toolName: e.name, args: e.args })
        void this.runTool(e.callId, e.name, e.args)
        break
      case 'usage':
        this.usage = {
          input: e.usage.input,
          output: e.usage.output,
          cacheRead: e.usage.cacheRead,
          cacheWrite: e.usage.cacheWrite,
          totalTokens: e.usage.total,
        }
        break
      case 'done': {
        this.state.messages = [
          ...this.state.messages,
          finalMessage(e.text, e.thinking, this.usage, e.stopReason),
        ]
        this.finish()
        break
      }
      case 'error':
        this.finish(e.message)
        break
      default:
        break
    }
  }

  /** 执行一次工具并把结果回传内核（失败也回传错误结果，让模型自纠正） */
  private async runTool(callId: string, name: string, args: unknown): Promise<void> {
    const tool = this.tools.find((t) => t.name === name)
    let outcome: AgentToolOutcome
    if (!tool) {
      outcome = { content: `未知工具: ${name}`, isError: true }
    } else {
      try {
        outcome = outcomeFromToolResult(await tool.execute(callId, args))
      } catch (e) {
        outcome = { content: e instanceof Error ? e.message : String(e), isError: true }
      }
    }

    // load_tools：先把新上下文推给内核（下一步生效），再回传结果
    const patch = this.nextTurnPatch(name, outcome, callId)
    if (patch) {
      try {
        await agentService.updateContext(this.runId as string, patch.systemPrompt, patch.tools)
        this.systemPrompt = patch.systemPrompt
        this.tools = patch.tools
      } catch {
        /* 上下文更新失败不致命：模型下一轮会再尝试装载 */
      }
    }

    await agentService
      .toolResult(this.runId as string, callId, outcome)
      .catch(() => undefined)
    this.emit({
      type: 'tool_execution_end',
      toolName: name,
      isError: outcome.isError,
      result: { content: blocksFromOutcome(outcome) },
    })
  }

  /** 走入口给的 prepareNextTurnWithContext 取新 context（仅聊天主链路有） */
  private nextTurnPatch(
    name: string,
    outcome: AgentToolOutcome,
    callId: string,
  ): { systemPrompt: string; tools: AgentToolLike[] } | null {
    const hook = this.init.prepareNextTurnWithContext
    if (!hook) return null
    this.stepToolResults.push({
      toolName: name,
      content: blocksFromOutcome(outcome),
    })
    void callId
    const patch = hook({
      toolResults: this.stepToolResults,
      context: { messages: this.state.messages },
    })
    if (!patch) return null
    return {
      systemPrompt: patch.context.systemPrompt,
      tools: patch.context.tools as AgentToolLike[],
    }
  }

  private emit(e: RustAgentEvent): void {
    for (const cb of [...this.subscribers]) cb(e)
  }

  private finish(errorMessage?: string): void {
    this.runId = null
    if (errorMessage) this.state.errorMessage = errorMessage
    const settle = this.settle
    this.settle = null
    settle?.()
  }
}

/** pi Message[] → 内核 LlmMessage[]（历史回灌） */
function toLlmMessages(history: unknown[]): AgentMessageInput[] {
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

/** 终稿 assistant 消息（含 thinking 块与 usage，供入口的读取函数消费） */
function finalMessage(
  text: string,
  thinking: string | null,
  usage: FinalAssistantMessage['usage'],
  stopReason: string,
): FinalAssistantMessage {
  const content: AssistantBlock[] = [{ type: 'text', text }]
  if (thinking) content.unshift({ type: 'thinking', thinking })
  return { role: 'assistant', content, usage, stopReason }
}

/** 注册表工具返回值 → 内核工具结果（文本拼接 + 图片块） */
function outcomeFromToolResult(res: unknown): AgentToolOutcome {
  const content = (res as { content?: unknown })?.content
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
function blocksFromOutcome(outcome: AgentToolOutcome): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: outcome.content }]
  for (const img of outcome.images ?? []) {
    blocks.push({ type: 'image', data: img.data, mimeType: img.mime })
  }
  return blocks
}
