/**
 * AI 内核（Rust agent）的前端出入口。
 *
 * 与 voiceService 同一范式：`isTauri` 时 `listen('ai://agent')`，浏览器直连
 * （`npm run dev`）时挂到 mock 的事件槽 `mockAgent.onEvent`。所有事件先汇到
 * 本模块的分发器，再由 {@link RustAgent} 按 runId 认领。
 */

import type { AgentEvent, AgentRunParams, AgentToolDef, AgentToolOutcome, AiProbeResult } from '@/types'

import { invoke, isTauri } from './transport'

type AgentListener = (e: AgentEvent) => void

const listeners = new Set<AgentListener>()
let bridged = false

function dispatch(e: AgentEvent): void {
  for (const cb of [...listeners]) cb(e)
}

/** 事件桥：同一进程只建立一次（重启由页面刷新负责） */
async function bridgeEvents(): Promise<void> {
  if (bridged) return
  bridged = true
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<AgentEvent>('ai://agent', (e) => dispatch(e.payload))
    return
  }
  const { mockAgent } = await import('@/mock/server')
  mockAgent.onEvent = dispatch as (e: unknown) => void
}

export const agentService = {
  /** 订阅内核事件；返回取消订阅函数 */
  async onEvent(cb: AgentListener): Promise<() => void> {
    await bridgeEvents()
    listeners.add(cb)
    return () => listeners.delete(cb)
  },

  /** 启动一次 run，返回 runId */
  run: (params: AgentRunParams): Promise<string> => invoke<string>('ai_agent_run', { params }),

  /** 取消 run（中止后台循环） */
  cancel: (runId: string): Promise<boolean> => invoke<boolean>('ai_agent_cancel', { runId }),

  /** 回传工具执行结果（过渡期桥接） */
  toolResult: (
    runId: string,
    callId: string,
    outcome: AgentToolOutcome,
  ): Promise<boolean> =>
    invoke<boolean>('ai_agent_tool_result', {
      runId,
      callId,
      content: outcome.content,
      isError: outcome.isError,
      images: outcome.images ?? null,
    }),

  /** 热更新 run 的系统提示词与工具集（load_tools 动态装载；toolGroups 供 Rust 注册表补 defs） */
  updateContext: (
    runId: string,
    systemPrompt: string,
    tools: AgentToolDef[],
    toolGroups?: string[],
  ): Promise<boolean> =>
    invoke<boolean>('ai_agent_update_context', { runId, systemPrompt, tools, toolGroups: toolGroups ?? null }),

  /** 六发能力探测（请求在 Rust 侧发起） */
  probe: (modelId: number): Promise<AiProbeResult> => invoke<AiProbeResult>('ai_probe', { modelId }),
}
