/**
 * streamBubbles —— 流式气泡聚合（照搬 EffiBuddy useChatStreaming 的聚合语义）
 *
 * 气泡聚合规则:
 *  - 过程气泡:连续多轮推理 + 工具调用合并为一个过程区块(期间无正文)
 *  - 正文气泡:一旦出现正文即"断开本次合并"——正文另起气泡,后续推理/工具另起新过程气泡
 *  - 工具结果后新一轮推理:当前仍为纯过程气泡(无正文)则继续合并,实现连续推理+工具合并
 *
 * 与 EffiBuddy 的差异（仅数据投喂方式，规则本身不变）:
 *  - Rein 的流式回调给的是「累计全文」而非 delta，调用方先按已展示长度切成增量再投喂本模块；
 *  - 气泡的新建/入列/入场动画/落库时机由宿主（store）提供，本模块只管聚合状态；
 *  - 拆成独立模块是为了能脱离 pinia/Tauri 直接用 Node 跑断言（scripts/probe-stream-bubbles.mjs）。
 */
import { reactive, ref, type Ref } from 'vue'
import { markThinkingStart, markThinkingEnd, type ThinkTrack } from './thinkTimer.ts'
import type { ProcessSegment, ProcessToolCall } from '../types'

/** 本模块关心的气泡最小组件契约：id / 正文 / 流式标志 */
export interface StreamBubble {
  id: string
  role: 'user' | 'assistant'
  text?: string
  streaming?: boolean
}

/** 每个气泡的流式元数据（reasoning / 工具调用 / 过程段） */
export interface StreamBubbleMeta extends ThinkTrack {
  reasoning: string
  /** 已完成思考段的累计秒数（跨段累加；数据层持有，跨组件重建存活） */
  thinkingSec: number
  /** 当前思考段的开始时间戳（null = 未在思考；用于结束时按真实耗时累计） */
  thinkingStartedAt: number | null
  toolCalls: ProcessToolCall[]
  /** 推理过程段(思考文字与工具调用按到达顺序穿插)，渲染时按此顺序展示 */
  segments: ProcessSegment[]
  /** 历史恢复时被吸收进前一条纯过程容器(渲染跳过，内容已合并) */
  absorbed?: boolean
}

/** 一次工具结果的回填内容（与 chat 回调对齐） */
export interface ToolResultPayload {
  ok: boolean
  brief: string
  resultImage?: { base64: string; mime: string }
  /** 放大镜等工具返回的元数据（zoomId / zoomW / zoomH / zoomRect） */
  details?: unknown
}

export interface StreamHost<T extends StreamBubble> {
  /** 当前消息列表（会话切换会整体替换，故用取值函数而非数组引用） */
  messages(): T[]
  /** 新建空气泡：宿主负责 id 入列、入场动画与持久化时机，同步返回新建的消息 */
  createBubble(id: string, withAnim: boolean): T
  /** 生成气泡 id */
  nextId(): string
  /** 每次流式事件后的回调（页面跟随滚动，等价 EffiBuddy 的 scrollBottom） */
  onEvent(): void
}

export interface StreamAggregator {
  /** 当前正在写入的气泡 id（渲染层据此判定 final） */
  streamingBubbleId: Ref<string | null>
  /** 工具结果后置位：下一个文本/推理 token 应新建气泡 */
  needNewBubbleAfterTool: Ref<boolean>
  getMeta(id: string): StreamBubbleMeta | null
  ensureMeta(id: string): StreamBubbleMeta
  /** 预建一个空占位气泡（Rein 特有：保住「打字点」与 food 卡的 morph 目标） */
  openBubble(withAnim: boolean): string
  /** 正文 token 入列（EffiBuddy appendStreamToken） */
  appendText(token: string): void
  /** 推理增量入列（EffiBuddy onReasoning） */
  appendReasoning(delta: string): void
  /** 工具调用入列（EffiBuddy onToolCall）；displayName 为注册表中文短名 */
  toolCall(name: string, displayName: string, args: string): void
  /** 工具结果回填（EffiBuddy onToolResult；Rein 回调不带 call_id，倒序按工具名匹配） */
  toolResult(name: string, payload: ToolResultPayload): void
  /** 流式收尾：结束思考计时、清空流式指针（EffiBuddy finalizeStream 的状态部分） */
  finalize(): void
  /** 会话切换/清空：清空全部聚合状态 */
  reset(): void
}

export function createStreamAggregator<T extends StreamBubble>(host: StreamHost<T>): StreamAggregator {
  const streamingBubbleId = ref<string | null>(null)
  const needNewBubbleAfterTool = ref(false)
  const meta = reactive<Record<string, StreamBubbleMeta>>({})
  let callSeq = 0

  function getMeta(id: string): StreamBubbleMeta | null {
    return meta[id] ?? null
  }

  function ensureMeta(id: string): StreamBubbleMeta {
    if (!meta[id]) {
      meta[id] = {
        reasoning: '',
        isThinking: false,
        thinkingSec: 0,
        thinkingStartedAt: null,
        toolCalls: [],
        segments: [],
      }
    }
    return meta[id]
  }

  /** 当前正在写入的气泡 */
  function bubble(): T | null {
    return streamingBubbleId.value
      ? (host.messages().find((m) => m.id === streamingBubbleId.value) ?? null)
      : null
  }

  /** 另起一个空气泡（先占位指针，再交给宿主入列） */
  function openBubble(withAnim: boolean): string {
    const id = host.nextId()
    streamingBubbleId.value = id
    host.createBubble(id, withAnim)
    return id
  }

  function appendText(token: string): void {
    if (!token) return
    // 工具结果后下一段文本应新建气泡(实现"每段答复独立气泡")
    if (needNewBubbleAfterTool.value) {
      streamingBubbleId.value = null
      needNewBubbleAfterTool.value = false
    }
    // 正文内容则断开本次合并:当前为纯过程气泡(有推理/工具但无正文)时,
    // 正文应另起气泡,并结束该过程气泡的思考计时
    const cur = bubble()
    if (cur && !cur.text) {
      const m = streamingBubbleId.value ? meta[streamingBubbleId.value] : null
      if (m && (m.reasoning || m.toolCalls.length)) {
        if (m.isThinking) markThinkingEnd(m)
        streamingBubbleId.value = null
      }
    }
    const id = streamingBubbleId.value ?? openBubble(true)
    const target = host.messages().find((m) => m.id === id)
    if (target) target.text = (target.text ?? '') + token
    host.onEvent()
    // 收到文本 token 表示推理阶段已结束
    const m = meta[id]
    if (m?.isThinking) markThinkingEnd(m)
  }

  function appendReasoning(delta: string): void {
    if (!delta) return
    // 工具结果后新一轮推理:当前为纯过程气泡(无正文) → 合并进当前气泡;无气泡/已有正文 → 另起
    if (needNewBubbleAfterTool.value) {
      const cur = bubble()
      if (!cur || cur.text) streamingBubbleId.value = null
      needNewBubbleAfterTool.value = false
    }
    // 若当前气泡已有正文内容(该段答复已开始/完成),新一轮思考应另起气泡
    const cur = bubble()
    if (cur?.text) streamingBubbleId.value = null
    const id = streamingBubbleId.value ?? openBubble(false)
    const m = ensureMeta(id)
    markThinkingStart(m)
    m.reasoning += delta
    // 插入推理过程段：若上一段仍是思考文字则续写，否则新建一段
    // （工具调用会切段，从而实现工具执行结果穿插在思考文字之间展示）
    const last = m.segments[m.segments.length - 1]
    if (last && last.kind === 'reasoning') last.text += delta
    else m.segments.push({ kind: 'reasoning', text: delta })
    host.onEvent()
  }

  function toolCall(name: string, displayName: string, args: string): void {
    // 正文内容则断开合并:当前气泡已有正文,工具调用另起新过程气泡
    const cur = bubble()
    if (cur?.text) streamingBubbleId.value = null
    const id = streamingBubbleId.value ?? openBubble(false)
    const m = ensureMeta(id)
    // 收到 tool call 表示推理阶段结束
    markThinkingEnd(m)
    const rec: ProcessToolCall = {
      callId: `tc${Date.now().toString(36)}${++callSeq}`,
      toolName: displayName,
      rawName: name,
      arguments: args,
      result: null,
      isError: false,
      pending: true,
    }
    m.toolCalls.push(rec)
    // 插入工具过程段：独立成段，与前后思考文字穿插展示
    m.segments.push({ kind: 'tool', call: rec })
    host.onEvent()
  }

  function toolResult(name: string, payload: ToolResultPayload): void {
    if (!streamingBubbleId.value) return
    const m = meta[streamingBubbleId.value]
    if (!m) return
    let target: ProcessToolCall | undefined
    for (let i = m.toolCalls.length - 1; i >= 0; i--) {
      const c = m.toolCalls[i]!
      if (c.pending && (c.rawName ?? c.toolName) === name) {
        target = c
        break
      }
    }
    if (target) {
      target.result = payload.brief
      target.isError = !payload.ok
      target.pending = false
      if (payload.resultImage) target.resultImage = payload.resultImage
      const d = payload.details as
        | { zoomId?: string; zoomW?: number; zoomH?: number; zoomRect?: { x: number; y: number; w: number; h: number } }
        | undefined
      if (d?.zoomId) {
        target.zoomId = d.zoomId
        target.zoomW = d.zoomW
        target.zoomH = d.zoomH
        if (d.zoomRect) target.zoomRect = d.zoomRect
      }
    }
    // 标记:下一个文本/推理 token 应新建气泡
    needNewBubbleAfterTool.value = true
    host.onEvent()
  }

  function finalize(): void {
    const m = streamingBubbleId.value ? meta[streamingBubbleId.value] : null
    if (m?.isThinking) markThinkingEnd(m)
    streamingBubbleId.value = null
    needNewBubbleAfterTool.value = false
  }

  function reset(): void {
    Object.keys(meta).forEach((k) => delete meta[k])
    streamingBubbleId.value = null
    needNewBubbleAfterTool.value = false
  }

  return {
    streamingBubbleId,
    needNewBubbleAfterTool,
    getMeta,
    ensureMeta,
    openBubble,
    appendText,
    appendReasoning,
    toolCall,
    toolResult,
    finalize,
    reset,
  }
}
