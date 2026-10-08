/**
 * RustAgent：AI 内核（Rust agent loop）的前端壳。
 *
 * 目标是与 pi 的 `Agent` 表面等价，让 8 个 AI 入口只改「构造」两行、
 * 回调契约零改动（`message_update` / `tool_execution_start|end` 照旧）。
 *
 * 职责：
 * - 订阅 `ai://agent` 事件（按 runId 认领，含认领前缓冲），把内核事件翻译成入口消费的事件流；
 * - **工具执行分两路**：`toolStarted.kernel:true` 的工具已迁移进 Rust 注册表，
 *   由内核自己执行（壳只把结果翻译成 `tool_execution_end`）；`kernel:false` 的仍在
 *   TS 侧跑注册表工具，把结果经 `ai_agent_tool_result` 送回内核（session 域常驻）；
 * - `load_tools` 动态装载：执行完装载工具后调用 `prepareNextTurnWithContext`
 *   取新的提示词与工具清单，先 `ai_agent_update_context` 再回传结果，
 *   保证内核下一步用上新上下文（「先更新后回传」保证顺序确定）。
 *
 * 增量语义对齐 pi：`text_delta` / `thinking_delta` 是增量，`thinking_end` 是该步
 * 思考全文；唯一新增的是 `stepRetry`（内核重试会给该步重发增量，壳据此重置本步累积）。
 *
 * 纯逻辑（消息转换 / 工具结果编码 / 单步累积）在 `agentProtocol.ts`，可被 Node 直跑断言
 * （`scripts/probe-rust-agent.mjs`）；本文件只负责与内核的时序与副作用。
 */

import { agentService } from '@/services/agentService'
import type { AgentEvent, AgentFinalMessage, AgentToolOutcome, AgentUsage } from '@/types'

import {
  blocksFromOutcome,
  emptyUsage,
  finalMessage,
  imageFromToolResult,
  outcomeFromToolResult,
  StepAccumulator,
  toLlmMessages,
  toolDetailsFromResult,
} from './agentProtocol'

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

export interface RustAgentInit {
  initialState: {
    systemPrompt: string
    /** ai_models 主键（内核据此读 baseUrl / apiKey / modelId） */
    modelPk: number
    thinkingLevel?: string
    tools?: AgentToolLike[]
    /** 装载中的工具组（Rust 注册表据此补已迁移工具的 defs 与执行） */
    toolGroups?: string[]
    /** 历史（仅 user/assistant 文本与图片；工具中间轮不回放） */
    messages: AgentFinalMessage[]
  }
  /** 仅聊天主链路使用：load_tools 扩载后换 context（语义与 pi 一致） */
  prepareNextTurnWithContext?: (ctx: {
    toolResults: { toolName: string; content: unknown }[]
    context: { messages: unknown[] }
  }) => { context: { systemPrompt: string; messages: unknown[]; tools: AgentToolLike[]; toolGroups?: string[] } } | undefined
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
  private acc = new StepAccumulator()
  private usage: AgentUsage = emptyUsage()
  private tools: AgentToolLike[]
  private toolGroups: string[]
  private systemPrompt: string

  constructor(init: RustAgentInit) {
    this.init = init
    this.tools = [...(init.initialState.tools ?? [])]
    this.toolGroups = [...(init.initialState.toolGroups ?? [])]
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
    this.acc = new StepAccumulator()

    const runId = await agentService.run({
      modelId: this.init.initialState.modelPk,
      systemPrompt: this.systemPrompt,
      messages: toLlmMessages(this.init.initialState.messages),
      prompt: text,
      images: (images ?? []).map((i) => ({ data: i.data, mime: i.mimeType })),
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      toolGroups: this.toolGroups,
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

  /** 退订。agent 是一次性的（每个入口/抽取/整理各用一个），跑完必须放手：
   *  否则它会一直收着本进程**所有** run 的事件，谁也活不到被回收。 */
  private unsubscribe(): void {
    const off = this.unlisten
    this.unlisten = null
    off?.()
  }

  private onEvent(e: AgentEvent): void {
    if (e.type === 'started') return
    if (!this.runId) {
      // 只为「订阅已建立、runId 还没认领」这一小段窗口缓冲（invoke 返回与事件
      // 推送有竞态）。给个上限兜底：万一谁又忘了退订，也不会无界增长。
      if (this.pendingEvents.length < 500) this.pendingEvents.push(e)
      return
    }
    if (e.runId !== this.runId) return
    switch (e.type) {
      case 'textDelta':
        this.acc.onTextDelta(e.delta)
        this.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: e.delta },
        })
        break
      case 'thinkingDelta':
        this.acc.onThinkingDelta(e.delta)
        this.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: e.delta },
        })
        break
      case 'thinkingEnd':
        this.acc.onThinkingEnd(e.content)
        this.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_end', content: e.content },
        })
        break
      case 'stepRetry':
        this.acc.onStepRetry()
        break
      case 'toolStarted':
        // 新一步开始：文本/思考从头计（工具后模型重新输出答复）
        this.acc.onStepBoundary()
        this.emit({ type: 'tool_execution_start', toolName: e.name, args: e.args })
        // 内核工具（Rust 注册表）在 Rust 侧执行：这里**不能**再跑一遍 TS 工具，
        // 否则同一次副作用做两遍、还多付一次往返 IPC（结果会被桥接层按「早到」丢弃）。
        if (!e.kernel) void this.runTool(e.callId, e.name, e.args)
        break
      case 'toolCompleted': {
        // 内核工具的结果从内核回传（桥接工具的结果由 runTool 上报，跳过避免重复）
        if (!e.kernel) break
        const outcome: AgentToolOutcome = { content: e.content, isError: e.isError }
        this.acc.pushToolResult(e.name, outcome)
        const blocks = blocksFromOutcome(outcome)
        this.emit({
          type: 'tool_execution_end',
          toolName: e.name,
          isError: e.isError,
          // details 是给前端自己用的结构化载荷（文件卡片 / 放大镜元数据），
          // 与回灌模型的文本同源但不同用途（见 agentProtocol::toolDetailsFromResult）
          result: { content: blocks, details: toolDetailsFromResult({ content: blocks }) },
        })
        break
      }
      case 'usage':
        this.usage = e.usage
        break
      case 'done':
        this.state.messages = [
          ...this.state.messages,
          finalMessage(e.text, e.thinking, this.usage, e.stopReason),
        ]
        this.finish()
        break
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
    let raw: unknown = null
    if (!tool) {
      outcome = { content: `未知工具: ${name}`, isError: true }
    } else {
      try {
        raw = await tool.execute(callId, args)
        outcome = outcomeFromToolResult(raw)
      } catch (e) {
        outcome = { content: e instanceof Error ? e.message : String(e), isError: true }
      }
    }
    this.acc.pushToolResult(name, outcome)

    // load_tools：先把新上下文推给内核（下一步生效），再回传结果
    const patch = this.nextTurnPatch()
    if (patch) {
      try {
        await agentService.updateContext(this.runId as string, patch.systemPrompt, patch.tools, patch.toolGroups)
        this.systemPrompt = patch.systemPrompt
        this.tools = patch.tools
        if (patch.toolGroups) this.toolGroups = patch.toolGroups
      } catch {
        /* 上下文更新失败不致命：模型下一轮会再尝试装载 */
      }
    }

    await agentService.toolResult(this.runId as string, callId, outcome).catch(() => undefined)
    const blocks = blocksFromOutcome(outcome)
    this.emit({
      type: 'tool_execution_end',
      toolName: name,
      isError: outcome.isError,
      // 结构化载荷（details / {ok,data} 信封里的 data）与结果图一起带上：
      // 过程卡的文件卡片、放大镜结果图与元数据都从这两项读（见 agentProtocol）
      result: {
        content: blocks,
        details: toolDetailsFromResult(raw ?? { content: blocks }),
        image: imageFromToolResult(raw ?? { content: blocks }),
      },
    })
  }

  /** 走入口给的 prepareNextTurnWithContext 取新 context（仅聊天主链路有） */
  private nextTurnPatch(): { systemPrompt: string; tools: AgentToolLike[]; toolGroups?: string[] } | null {
    const hook = this.init.prepareNextTurnWithContext
    if (!hook) return null
    const patch = hook({
      toolResults: this.acc.toolResults,
      context: { messages: this.state.messages },
    })
    if (!patch) return null
    return {
      systemPrompt: patch.context.systemPrompt,
      tools: patch.context.tools as AgentToolLike[],
      toolGroups: patch.context.toolGroups,
    }
  }

  private emit(e: RustAgentEvent): void {
    for (const cb of [...this.subscribers]) cb(e)
  }

  private finish(errorMessage?: string): void {
    this.runId = null
    if (errorMessage) this.state.errorMessage = errorMessage
    // 跑完就退订 + 清空缓冲：不留僵尸订阅（流式文本会一直累积在 pendingEvents 里）
    this.pendingEvents = []
    this.unsubscribe()
    const settle = this.settle
    this.settle = null
    settle?.()
  }
}
