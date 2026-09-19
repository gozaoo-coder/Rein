/** AI 域：对话消息流（Rust SQLite 持久化）+ 解析确认写入饮食。 */

import { nextTick, ref } from 'vue'
import { defineStore } from 'pinia'
import { animate } from 'animejs'

import { aiService } from '@/services/aiService'
import { dietService } from '@/services/dietService'
import { kbService } from '@/services/kbService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { useModelsStore } from '@/stores/models'
import { hasImage, getEntry, registerImage, registerSourceImage, resetChat, setActiveChat, setViewEdgeCap } from '@/ai/imageZoom'
import { chatStreamView } from '@/ai/streamExtract'
import { createStreamAggregator } from '@/ai/streamBubbles'
import { toParsedItems, type ModelFoodRow } from '@/ai/foodMatch'
import { findAppTool } from '@/ai/tools/registry'
import type { ChatTurn } from '@/ai/chat'
import { DEFAULT_IMAGE_EDGE } from '@/utils/image'
import { todayStr } from '@/utils/date'
import { voiceService } from '@/services/voiceService'
import type {
  AiChat,
  AiChatMessage,
  AiChatMessageInput,
  AiDocMeta,
  AiMessage,
  MealType,
  ParsedFoodItem,
  ProcessSegment,
  ProcessToolCall,
  TargetAdjustProposal,
  ToolCallRecord,
  VoiceMemo,
} from '@/types'
import type { MemoGenResult } from '@/ai/memoGen'
import { useToast } from '@/composables/useToast'
import { perfDegraded } from '@/system/perf'

let seq = 0
const uid = () => `m${Date.now().toString(36)}${++seq}`
const newChatId = () => `c${Date.now().toString(36)}${++seq}`

/** 待发送图片：base64 视图（发模型）+ 原始来源（放大镜按需解码取细节） */
export interface SendImage {
  base64: string
  mime: string
  /** 视图尺寸（= 发给模型的图的实际尺寸，坐标空间） */
  w: number
  h: number
  /** 图片清单说明：'附图' / '文档《x》第3页' */
  label: string
  /** 原始来源（File/Blob 或 dataURL），供放大镜解码高分辨率位图 */
  source: Blob | string
}

/** 归档路径与发送时写入的一致（files::normalize_path 会补 .md 后缀） */
function docArchivePath(name: string): string {
  return `文档/${name.replace(/\.[a-z0-9]+$/i, '')}.md`
}

/** 用户轮发给模型的文本：文档全文块 + 用户输入 + 图片清单 */
function composeOutgoingText(clean: string, doc: AiDocMeta | undefined, imgNote: string | undefined): string {
  const parts: string[] = []
  if (doc) {
    // 截断时告知全文归档位置：模型在用户追问「继续看后面」时才能自己定位并分页取全文
    const archiveNote =
      doc.truncated && doc.fullText?.trim()
        ? `\n（全文已归档到知识库「${docArchivePath(doc.name)}」，需要未展示的部分时用 glob_knowledge 查「文档/**」拿 id，再 read_knowledge level=l2 分页读取）`
        : ''
    parts.push(`（附带文档《${doc.name}》，已解析全文如下）${archiveNote}\n${doc.text}`)
  }
  if (clean) parts.push(clean)
  if (imgNote) parts.push(imgNote)
  return parts.join('\n\n')
}

/** 把消息里的图片（含放大镜结果图）注册进放大镜注册表（幂等）。
 * 放大条目优先共享根图条目的位图解码器并按 zoomRect 恢复「裁原图」语义；
 * 旧数据（无 zoomRect）或根图缺失时退化为对结果图本身继续放大。 */
function registerMessageImages(chatId: string, m: AiMessage): void {
  for (const [k, im] of (m.images ?? []).entries()) {
    const id = `img-${m.id}-${k}`
    if (hasImage(chatId, id)) continue
    registerSourceImage(chatId, {
      id,
      label: im.label,
      source: `data:${im.mime};base64,${im.base64}`,
      viewW: im.w,
      viewH: im.h,
    })
  }
  if (m.kind === 'tools' || m.segments?.length) {
    for (const seg of m.segments ?? []) {
      if (seg.kind !== 'tool') continue
      const c = seg.call
      if (!c.resultImage || !c.zoomId || hasImage(chatId, c.zoomId)) continue
      const depth = Number(c.zoomId.match(/z(\d+)(?:-\d+)?$/)?.[1] ?? 0)
      const rootId = c.zoomId.replace(/z\d+(?:-\d+)?$/, '')
      const root = depth > 0 ? getEntry(chatId, rootId) : null
      if (root && c.zoomRect) {
        registerImage(chatId, {
          id: c.zoomId,
          label: c.toolName,
          depth,
          viewW: c.zoomW ?? 0,
          viewH: c.zoomH ?? 0,
          resolve: root.resolve,
          rect: c.zoomRect,
        })
      } else {
        registerSourceImage(chatId, {
          id: c.zoomId,
          label: c.toolName,
          source: `data:${c.resultImage.mime};base64,${c.resultImage.base64}`,
          viewW: c.zoomW ?? 0,
          viewH: c.zoomH ?? 0,
          depth,
        })
      }
    }
  }
}

/** 恢复/切换会话后重建图片注册表 */
function attachChatContext(chatId: string, messages: AiMessage[]): void {
  setActiveChat(chatId)
  for (const m of messages) registerMessageImages(chatId, m)
}

/** 工具入参 → 原始 JSON 字符串（过程段展示用） */
function safeArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? ''
  } catch {
    return ''
  }
}

/** 过程段工具调用 → 旧版持久化记录（保留放大镜元数据；兼容既有读法） */
function legacyToolRecord(c: ProcessToolCall): ToolCallRecord {
  return {
    name: c.rawName ?? c.toolName,
    label: c.toolName,
    argsBrief: c.arguments.length > 48 ? `${c.arguments.slice(0, 45)}…` : c.arguments,
    resultBrief: c.result,
    status: c.pending ? 'running' : c.isError ? 'error' : 'ok',
    ...(c.resultImage ? { resultImage: c.resultImage } : {}),
    ...(c.zoomId
      ? { zoomId: c.zoomId, zoomW: c.zoomW, zoomH: c.zoomH, ...(c.zoomRect ? { zoomRect: c.zoomRect } : {}) }
      : {}),
  }
}

/** 旧版持久化记录 → 过程段工具调用（历史恢复用） */
function legacyCallToProcess(t: ToolCallRecord, i: number, msgId: string): ProcessToolCall {
  return {
    callId: t.zoomId ?? `tc-${msgId}-${i}`,
    toolName: t.label || t.name,
    rawName: t.name,
    arguments: t.argsBrief,
    result: t.resultBrief,
    isError: t.status === 'error',
    pending: false,
    ...(t.resultImage ? { resultImage: t.resultImage } : {}),
    ...(t.zoomId
      ? { zoomId: t.zoomId, zoomW: t.zoomW, zoomH: t.zoomH, ...(t.zoomRect ? { zoomRect: t.zoomRect } : {}) }
      : {}),
  }
}

/** 无障碍：reduce 下不做入场位移动画 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const useAiStore = defineStore('ai', () => {
  const toast = useToast()
  const messages = ref<AiMessage[]>([])
  const busy = ref(false)
  /** 当前会话 id（多会话；历史抽屉可切换） */
  const chatId = ref('')
  /** 会话列表（最新置顶，来自 ai_chat_list） */
  const chats = ref<AiChat[]>([])
  /** 是否已初始化（页面重复挂载不重载） */
  const loaded = ref(false)
  /** 目标调整建议：解析后待用户确认，不直接生效 */
  const targetProposal = ref<TargetAdjustProposal | null>(null)

  function greet(): void {
    if (messages.value.length > 0) return
    const m: AiMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'text',
      at: new Date().toISOString(),
      text: '你好，我是 Rein AI。可以直接告诉我你吃了什么（比如「一个鸡蛋和一碗米饭」），也可以让我查改应用里的数据：记一笔账、加个待办、看这周运动量、建一套训练课都行，或者随便聊聊天。',
    }
    messages.value.push(m)
    persist(m)
  }

  /* ---------- 持久化 ---------- */

  /** 内存消息 → 存储消息（结构化信息统一放 payload：food-parse 卡 / thinking / quote） */
  function toInput(m: AiMessage): AiChatMessageInput {
    const meta: Record<string, unknown> = {}
    if (m.kind === 'food-parse') {
      meta.items = m.items
      meta.source = m.source
      meta.committedAt = m.committed ? m.at : null
    }
    if (m.kind === 'tools' && m.toolCalls) meta.calls = m.toolCalls
    if (m.kind === 'tools' && m.segments?.length) meta.segments = m.segments
    if (m.kind === 'tools' && m.thinkingSec) meta.thinkingSec = m.thinkingSec
    if (m.thinking) meta.thinking = m.thinking
    if (m.quoteText) meta.quote = m.quoteText
    if (m.voiceMeta) meta.voice = m.voiceMeta
    return {
      id: m.id,
      role: m.role,
      kind: m.kind,
      text: m.text ?? null,
      imageBase64: m.imageBase64 ?? null,
      mime: m.mime ?? null,
      payload: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
    }
  }

  function persist(m: AiMessage): void {
    if (!chatId.value) return
    void aiService.aiChatAppend(chatId.value, toInput(m))
  }

  function fromStored(s: AiChatMessage): AiMessage {
    const m: AiMessage = { id: s.id, role: s.role, kind: s.kind, at: s.createdAt }
    if (s.text) m.text = s.text
    if (s.imageBase64) {
      m.imageBase64 = s.imageBase64
      m.mime = s.mime ?? 'image/jpeg'
    }
    if (s.payload) {
      try {
        const p = JSON.parse(s.payload) as {
          items?: AiMessage['items']
          source?: AiMessage['source']
          committedAt?: string | null
          thinking?: string
          thinkingSec?: number
          segments?: ProcessSegment[]
          quote?: string
          calls?: ToolCallRecord[]
          doc?: AiDocMeta
          images?: AiMessage['images']
          imgNote?: string
          voice?: AiMessage['voiceMeta']
        }
        if (s.kind === 'food-parse') {
          m.items = p.items
          m.source = p.source
          if (p.committedAt) m.committed = true
          if (p.thinking) m.thinking = p.thinking
        } else if (p.thinking) {
          m.thinking = p.thinking
        }
        if (s.kind === 'tools' && p.calls) m.toolCalls = p.calls
        if (p.segments?.length) m.segments = p.segments
        if (typeof p.thinkingSec === 'number') m.thinkingSec = p.thinkingSec
        if (p.quote) m.quoteText = p.quote
        if (p.doc) m.doc = p.doc
        if (p.images) m.images = p.images
        if (p.imgNote) m.imgNote = p.imgNote
        if (p.voice) m.voiceMeta = p.voice
      } catch {
        /* 损坏的历史 payload 忽略，卡片仍可展示文本 */
      }
    }
    // 旧格式（无 payload.segments）补出过程段：推理在前、工具在后，供统一渲染与放大镜注册
    if (!m.segments?.length) {
      const segs: ProcessSegment[] = []
      if (m.thinking) segs.push({ kind: 'reasoning', text: m.thinking })
      for (const [i, t] of (m.toolCalls ?? []).entries()) {
        segs.push({ kind: 'tool', call: legacyCallToProcess(t, i, m.id) })
      }
      if (segs.length > 0) m.segments = segs
    }
    return m
  }

  /** 启动载入：取最近会话（无则新建），并恢复其消息 */
  async function init(): Promise<void> {
    if (loaded.value) return
    loaded.value = true
    try {
      chats.value = await aiService.aiChatList()
      if (chats.value.length > 0) {
        chatId.value = chats.value[0]!.id
      } else {
        chatId.value = newChatId()
        await aiService.aiChatEnsure(chatId.value, null)
        chats.value = await aiService.aiChatList()
      }
      messages.value = (await aiService.aiChatMessages(chatId.value)).map(fromStored)
      resetStreaming()
      restoreBubbleMetaFromHistory()
      attachChatContext(chatId.value, messages.value)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
    // 启动时检查一次整库整理是否到期（每天最多一次；模型未配置则直接跳过）
    scheduleMemoryConsolidation()
  }

  async function refreshChats(): Promise<void> {
    chats.value = await aiService.aiChatList()
  }

  /* ---------- 知识库 / 长期记忆 ---------- */

  /** 认知块短 TTL 缓存：每轮都查库是浪费，但刚改过记忆要能很快生效 */
  const COGNITION_TTL_MS = 60_000
  let cognitionCache: { at: number; text: string; ids: number[] } | null = null

  function invalidateCognitionCache(): void {
    cognitionCache = null
  }

  /**
   * 取喂给系统提示词的「用户认知」块。
   * 知识库不可用（未初始化、模型加载失败）时返回 undefined，绝不因此让对话发不出去。
   */
  async function cognitionForPrompt(): Promise<string | undefined> {
    const now = Date.now()
    if (!cognitionCache || now - cognitionCache.at > COGNITION_TTL_MS) {
      try {
        const c = await kbService.cognition()
        cognitionCache = { at: now, text: c.text, ids: c.memories.map((m) => m.id) }
        // 注入即「用到」，用于后续排序。只在真正刷新时计一次，不是每轮都加。
        if (cognitionCache.ids.length > 0) {
          kbService.memoryBump(cognitionCache.ids).catch(() => {})
        }
      } catch {
        return cognitionCache?.text || undefined
      }
    }
    return cognitionCache.text || undefined
  }

  /**
   * 取喂给系统提示词的「全量注入区」：系统提示词目录 + 用户记忆目录（docs/ai-workspace.md §3.4）。
   * 与认知块同样的短 TTL 缓存：改完用户记忆要能很快生效，但也不必每轮都查库。
   * 知识库不可用时返回 undefined，绝不因此让对话发不出去。
   */
  let injectionCache: { at: number; value: { system: string; memory: string; truncated: boolean } } | null =
    null

  async function injectionForPrompt(): Promise<
    { system: string; memory: string; truncated: boolean } | undefined
  > {
    const now = Date.now()
    if (!injectionCache || now - injectionCache.at > COGNITION_TTL_MS) {
      try {
        const inj = await kbService.injection()
        injectionCache = {
          at: now,
          value: { system: inj.system, memory: inj.memory, truncated: inj.truncated },
        }
      } catch {
        return injectionCache?.value
      }
    }
    const v = injectionCache.value
    return v.system.trim() || v.memory.trim() ? v : undefined
  }

  /* ---------- 记忆整理（定期去噪的“做梦”任务） ---------- */

  /** LLM 整理的最小间隔：24 小时。多次启动/多次会话共用它节流。 */
  const CONSOLIDATE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000
  /** 并发护栏：同一时刻只允许一次整理在跑。 */
  let consolidating = false
  /** 上次检查时间：避免一次启动里反复查库。 */
  let lastConsolidateCheck = 0

  /** SQLite 的 datetime('now') 是 UTC 的 `YYYY-MM-DD HH:MM:SS`，转成毫秒时间戳。 */
  function sqliteUtcMs(raw: string | null): number {
    if (!raw) return 0
    const ms = Date.parse(`${raw.replace(' ', 'T')}Z`)
    return Number.isFinite(ms) ? ms : 0
  }

  /**
   * 跑一次整库记忆整理（合并重叠 / 统一分类 / 归档噪声 / 清理归档区）。
   * `force=true` 供 UI 手动触发，跳过开关与 24h 节流；返回实际改动的条数。
   * 全程静默：整理失败（模型不可用、网络失败）绝不能影响对话。
   */
  async function consolidateMemoriesNow(force = false): Promise<number> {
    if (consolidating) return 0
    consolidating = true
    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const cfg = models.defaultModel()
      if (!cfg) return 0

      const s = await kbService.settingsGet()
      if (!force) {
        if (!s.autoConsolidate) return 0
        if (Date.now() - sqliteUtcMs(s.lastConsolidateAt) < CONSOLIDATE_MIN_INTERVAL_MS) return 0
      }

      const memories = await kbService.memories(undefined, 'all')
      const { consolidateMemories } = await import('@/ai/memoryConsolidate')
      const candidates = await consolidateMemories({ config: cfg, memories })
      if (candidates.length > 0) {
        const r = await kbService.memoryApply(candidates)
        invalidateCognitionCache()
        const changed = r.added + r.updated + r.deleted + r.archived + r.restored
        if (changed > 0 && force) toast.toast(`已整理 ${changed} 条长期记忆`)
        // 无论有无变更都记一次：整库健康时不该被反复检查打扰
        await kbService.memoryConsolidated()
        return changed
      }
      await kbService.memoryConsolidated()
      return 0
    } catch {
      return 0
    } finally {
      consolidating = false
    }
  }

  /** 会话结束时（抽取之后）检查是否到期需要整理；受开关与节流约束。 */
  function scheduleMemoryConsolidation(): void {
    const now = Date.now()
    // 同一次会话里不必反复查库：节流本身是 24h 粒度
    if (now - lastConsolidateCheck < 5 * 60_000) return
    lastConsolidateCheck = now
    void consolidateMemoriesNow(false).catch(() => {})
  }

  /**
   * 会话结束时的记忆抽取。刻意做成**不 await 的后台任务**：
   * 一次模型调用要 1~3 秒，让用户等它结束才切会话是不可接受的。
   * 传快照而非读 messages.value，是因为调用方随后就会清空消息。
   */
  function scheduleMemoryExtraction(snapshotChatId: string, snapshot: AiMessage[]): void {
    const turns = snapshot
      .filter(
        (m) =>
          (m.kind === 'text' || m.kind === 'analysis' || m.kind === 'voice') && (m.text ?? '').trim(),
      )
      .map((m) => ({ role: m.role, text: m.text as string }))
      .slice(-24)
    if (turns.filter((t) => t.role === 'user').length === 0) return

    void (async () => {
      // 记忆抽取失败绝不能影响对话，整段静默
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const cfg = models.defaultModel()
      if (!cfg) return
      const s = await kbService.settingsGet()
      if (!s.autoMemory) return

      // 带上归档条目：模型据此判断「这次提到的旧事该不该复活」
      const existing = await kbService.memories(undefined, 'all')
      const { extractMemories } = await import('@/ai/memoryExtract')
      const candidates = await extractMemories({ config: cfg, turns, existing })
      if (candidates.length === 0) return

      const r = await kbService.memoryApply(
        candidates,
        snapshotChatId,
        snapshot.map((m) => m.id),
      )
      invalidateCognitionCache()
      const changed = r.added + r.updated + r.deleted + r.restored
      if (changed > 0) toast.toast(`已更新 ${changed} 条长期记忆`)
    })()
      .catch(() => {})
      .finally(() => {
        // 抽取之后顺带检查一次整库整理是否到期（每天最多一次）
        scheduleMemoryConsolidation()
      })
  }

  /** 切换会话（历史抽屉选择） */
  async function selectChat(id: string): Promise<void> {
    if (busy.value || id === chatId.value) return
    // 离开当前会话 = 一次会话结束，先拿快照再切
    scheduleMemoryExtraction(chatId.value, messages.value)
    chatId.value = id
    try {
      messages.value = (await aiService.aiChatMessages(id)).map(fromStored)
      resetStreaming()
      restoreBubbleMetaFromHistory()
      attachChatContext(id, messages.value)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
  }

  /** 新对话：新建空会话并写入欢迎语 */
  async function newChat(): Promise<void> {
    if (busy.value) return
    busy.value = true
    // 清空之前先快照，否则抽取看不到刚聊完的内容
    scheduleMemoryExtraction(chatId.value, messages.value)
    try {
      chatId.value = newChatId()
      resetChat(chatId.value)
      await aiService.aiChatEnsure(chatId.value, null)
      messages.value = []
      resetStreaming()
      greet()
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 清空当前会话上下文（消息删除，会话保留） */
  async function clearContext(): Promise<void> {
    if (busy.value) return
    busy.value = true
    scheduleMemoryExtraction(chatId.value, messages.value)
    try {
      await aiService.aiChatClear(chatId.value)
      resetChat(chatId.value)
      messages.value = []
      resetStreaming()
      greet()
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 撤回用户消息：连同其后（按顺序）的对话一起删除 */
  async function retract(messageId: string): Promise<void> {
    if (busy.value) return
    const idx = messages.value.findIndex((m) => m.id === messageId)
    if (idx === -1 || messages.value[idx]!.role !== 'user') return
    busy.value = true
    try {
      await aiService.aiChatCut(chatId.value, messageId)
      messages.value = messages.value.slice(0, idx)
      await refreshChats()
    } finally {
      busy.value = false
    }
  }

  /** 会话首条用户消息后，把默认标题改成消息摘要 */
  async function maybeRename(firstText: string): Promise<void> {
    const chat = chats.value.find((c) => c.id === chatId.value)
    if (!chat || chat.title !== 'AI 对话') return
    const title = firstText.replace(/\s+/g, ' ').slice(0, 16) || '照片'
    try {
      await aiService.aiChatRename(chatId.value, title)
      chat.title = title
    } catch {
      /* 重命名失败不阻塞聊天 */
    }
  }

  function pushAssistant(msg: Partial<AiMessage>, persistNow = true): AiMessage {
    const m: AiMessage = { id: uid(), role: 'assistant', kind: 'text', at: new Date().toISOString(), ...msg }
    messages.value.push(m)
    if (persistNow) persist(m)
    return m
  }

  function pushUser(msg: Partial<AiMessage>): AiMessage {
    const m: AiMessage = { id: uid(), role: 'user', kind: 'text', at: new Date().toISOString(), ...msg }
    messages.value.push(m)
    persist(m)
    return m
  }

  /* ---------- 流式气泡聚合 ----------
   * 聚合规则与数据结构见 @/ai/streamBubbles（照搬 EffiBuddy useChatStreaming）；
   * 本 store 只负责：消息入列 + 入场动画、增量切片投喂、定稿持久化、历史恢复。 */

  const streamSeq = ref(0)
  /** 本轮流式创建的消息（定稿时统一收尾/持久化） */
  let streamCreated: AiMessage[] = []

  function createBubble(id: string, withAnim: boolean): AiMessage {
    const msg: AiMessage = {
      id,
      role: 'assistant',
      kind: 'text',
      at: new Date().toISOString(),
      text: '',
      streaming: true,
    }
    messages.value.push(msg)
    streamCreated.push(msg)
    streamSeq.value++
    // 入场动画仅 opacity + scale，不动 height（思考/工具占位气泡跳过；
    // 掉帧降级期同样跳过——每个气泡一次合成在弱机上是纯负担）
    if (withAnim && !prefersReducedMotion() && !perfDegraded.value) {
      void nextTick(() => {
        const el = document.getElementById('msg-' + id)
        if (!el) return
        // 初始状态:透明 + 缩放 0.96(轻微,避免大幅缩放导致内容模糊)
        el.style.opacity = '0'
        el.style.transform = 'scale(0.96)'
        el.style.transformOrigin = 'center top'
        void el.offsetHeight // 强制 reflow 确保 anime.js 起点准确
        animate(el, {
          opacity: [0, 1],
          scale: [0.96, 1],
          duration: 280,
          ease: 'out(3)',
          onComplete: () => {
            el.style.opacity = ''
            el.style.transform = ''
            el.style.transformOrigin = ''
          },
        })
      })
    }
    return msg
  }

  const agg = createStreamAggregator<AiMessage>({
    messages: () => messages.value,
    createBubble,
    nextId: uid,
    onEvent: () => {
      streamSeq.value++
    },
  })

  /** 纯过程气泡定稿：morph 成 tools 载体并附上推理/过程段/工具记录（供历史与放大镜读回） */
  function settleProcessMessage(m: AiMessage): void {
    const meta = agg.getMeta(m.id)
    if (!meta) return
    m.streaming = false
    m.kind = 'tools'
    m.thinking = meta.reasoning || undefined
    m.thinkingSec = meta.thinkingSec
    m.segments = meta.segments
    m.toolCalls = meta.toolCalls.map(legacyToolRecord)
  }

  /** 本轮创建的流式消息收尾：过程气泡定格、正文气泡保留、纯空占位撤掉 */
  function settleStreamMessages(finalBubble: AiMessage | null): void {
    for (const m of streamCreated) {
      m.streaming = false
      if (m === finalBubble) continue
      const meta = agg.getMeta(m.id)
      if (!m.text && meta && (meta.reasoning || meta.toolCalls.length)) {
        settleProcessMessage(m)
        persist(m)
        continue
      }
      if (m.text) {
        persist(m)
        continue
      }
      // 无正文也无过程的纯空占位 → 从列表撤掉（不落库）
      const idx = messages.value.indexOf(m)
      if (idx >= 0) messages.value.splice(idx, 1)
    }
    // 注：不清空 streamCreated —— 定稿后若再抛错，catch 里还能补一次收尾（落库按 id 幂等）
  }

  /** 会话切换/清空:清空全部流式与渲染状态 */
  function resetStreaming(): void {
    agg.reset()
    streamCreated = []
  }

  /** 历史恢复：从持久化消息重建气泡元数据（照搬 EffiBuddy restoreBubbleMetaFromHistory） */
  function restoreBubbleMetaFromHistory(): void {
    // 第一遍：合并连续「纯过程消息」（kind=tools）到同一个容器。
    // 后端按消息边界分条落盘，流式期间这些轮次共用同一气泡；恢复时若逐条渲染
    // 会出现多个独立的推理框。这里把紧随其后的纯过程消息内容并入前一条（容器）。
    let containerId: string | null = null
    for (const m of messages.value) {
      if (m.role !== 'assistant') {
        containerId = null
        continue
      }
      const isProcessOnly = m.kind === 'tools' && !m.text
      if (isProcessOnly && containerId) {
        const host = messages.value.find((x) => x.id === containerId)
        if (host) {
          if (m.thinking) host.thinking = (host.thinking ?? '') + m.thinking
          host.thinkingSec = (host.thinkingSec ?? 0) + (m.thinkingSec ?? 0)
          host.segments = [...(host.segments ?? []), ...(m.segments ?? [])]
          host.toolCalls = [...(host.toolCalls ?? []), ...(m.toolCalls ?? [])]
        }
        // 被吸收消息清空内容，仅保留 id/kind 空壳，渲染跳过
        agg.ensureMeta(m.id).absorbed = true
        m.thinking = undefined
        m.segments = []
        m.toolCalls = []
        continue
      }
      containerId = isProcessOnly ? m.id : null
    }
    // 第二遍：逐条恢复 meta（被吸收消息跳过）
    for (const m of messages.value) {
      if (m.role !== 'assistant') continue
      if (agg.getMeta(m.id)?.absorbed) continue
      const meta = agg.ensureMeta(m.id)
      // 思考时长 → 「已思考 X 秒」（历史中视为已思考完成）
      meta.thinkingSec = m.thinkingSec ?? 0
      meta.isThinking = false
      if (m.segments?.length) {
        // 新格式：过程段按持久化顺序原样恢复（历史记录总是已完成，pending=false）
        meta.segments = m.segments.map((s) =>
          s.kind === 'tool' ? { kind: 'tool', call: { ...s.call, pending: false } } : s,
        )
        meta.reasoning = m.thinking ?? ''
      } else {
        // 旧格式：推理在前、工具在后，按持久化顺序还原过程段
        if (m.thinking) {
          meta.reasoning = m.thinking
          meta.segments.push({ kind: 'reasoning', text: m.thinking })
        }
        for (const [i, t] of (m.toolCalls ?? []).entries()) {
          meta.segments.push({ kind: 'tool', call: legacyCallToProcess(t, i, m.id) })
        }
      }
    }
  }

  /* ---------- 会话 ---------- */

  /** 无模型时的兜底：本地关键词解析（无网络依赖） */
  async function keywordParse(clean: string): Promise<void> {
    const items = await aiService.parseFoodText(clean)
    if (items.length === 0) {
      pushAssistant({ text: '暂时没能从这句话里识别出食物。试试「一个苹果」「200克鸡胸肉」这样的说法。' })
    } else {
      pushAssistant({ kind: 'food-parse', source: 'text_ai', items })
    }
  }

  /** LLM 回复定稿：原地把流式气泡 morph 成解析卡或文本气泡，并持久化。
   * 思考已在过程气泡上（ProcessSection），此处不再回填 thinking。 */
  async function applyLlmReply(msg: AiMessage, raw: string): Promise<void> {
    msg.streaming = false
    let body: unknown = null
    try {
      const s = raw.indexOf('{')
      const e = raw.lastIndexOf('}')
      if (s !== -1 && e > s) body = JSON.parse(raw.slice(s, e + 1))
    } catch {
      /* 非 JSON 输出：整段当纯文本回复 */
    }
    const obj = body as { kind?: unknown; items?: unknown; text?: unknown } | null
    if (obj && obj.kind === 'food' && Array.isArray(obj.items)) {
      const rows = normalizeFoodRows(obj.items)
      if (rows.length > 0) {
        msg.kind = 'food-parse'
        msg.source = 'text_ai'
        msg.items = await toParsedItems(rows)
        msg.text = undefined
        persist(msg)
        return
      }
    }
    const parsed = obj && typeof obj.text === 'string' ? obj.text : raw
    // 解析出的正文可能为空（模型只回了结构或空串）：此时保住流式期间已经显示出来的正文，
    // 不能因为定稿解析这一下把用户刚才看到的内容清掉
    msg.text = parsed.trim() ? parsed : (msg.text ?? '')
    if (!msg.text.trim()) {
      // 模型没输出任何内容：撤掉空正文气泡（过程气泡已由 settleStreamMessages 落库），不写空消息。
      // 注意这里不再按「有没有过程段」豁免——撇开空文字本身就说明它没有正文可留，
      // 而承载过程段的气泡在 settleStreamMessages 里已另走一趟，不会走到这里。
      const idx = messages.value.indexOf(msg)
      if (idx >= 0) messages.value.splice(idx, 1)
      return
    }
    persist(msg)
  }

  /** 模型输出的 items 行 → 标准识别行（容忍变体键名；克重缺省 100g；foodId 透传待校验） */
  function normalizeFoodRows(items: unknown[]): ModelFoodRow[] {
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null
    const gramsFromQuantity = (v: unknown): number | null => {
      const m = typeof v === 'string' ? v.match(/(\d+(?:\.\d+)?)\s*(克|g|kg|公斤)/i) : null
      if (!m) return null
      return /^kg|公斤$/i.test(m[2]!) ? Number(m[1]!) * 1000 : Number(m[1]!)
    }
    const rows: ModelFoodRow[] = []
    for (const r of items) {
      if (typeof r !== 'object' || r === null) continue
      const o = r as Record<string, unknown>
      const foodName =
        typeof o.foodName === 'string' ? o.foodName.trim() : typeof o.name === 'string' ? o.name.trim() : ''
      if (!foodName) continue
      // 每 100g 营养估算（库中不存在时自动补录用）；容忍 kcal 放在 nutrition 外层
      const n = (typeof o.nutrition === 'object' && o.nutrition !== null ? o.nutrition : {}) as Record<string, unknown>
      const nutrition = {
        kcal: num(n.kcal) ?? num(o.nutritionKcal) ?? undefined,
        protein: num(n.protein) ?? undefined,
        carb: num(n.carb) ?? undefined,
        fat: num(n.fat) ?? undefined,
        fiber: num(n.fiber) ?? undefined,
        sugar: num(n.sugar) ?? undefined,
        sodiumMg: num(n.sodiumMg) ?? undefined,
      }
      rows.push({
        foodName,
        grams: num(o.grams) ?? num(o.weight) ?? gramsFromQuantity(o.quantity) ?? 100,
        kcalEstimate: num(o.kcalEstimate) ?? num(o.kcal) ?? num(o.calories) ?? 0,
        foodId: typeof o.foodId === 'number' && Number.isFinite(o.foodId) ? o.foodId : null,
        nutrition,
      })
    }
    return rows
  }

  /** 发送一轮消息：纯文本 / 文字+附图 / 文档（含解析文本与选中图片）。
   * 图片随消息发给模型并注册进放大镜注册表（生成 img-xx 编号清单）；
   * 带图时自动改用视觉模型；模型看图决定出 food 卡（智能填入）还是回答问题。
   * memoRefs：@纪要引用——把纪要总结与逐句转写注入本轮文本。 */
  async function sendText(
    text: string,
    opts: { quoteText?: string; images?: SendImage[]; doc?: AiDocMeta; memoRefs?: VoiceMemo[] } = {},
  ): Promise<void> {
    const clean = text.trim()
    const sendImages = opts.images ?? []
    if ((!clean && sendImages.length === 0 && !opts.doc) || busy.value) return
    const quote = opts.quoteText?.trim()
    setActiveChat(chatId.value)
    // 预注册历史轮图片（幂等），保证放大镜 id 与历史清单一致
    for (const m of messages.value) registerMessageImages(chatId.value, m)
    const mid = uid()
    // 注册本轮图片 → 生成图片清单文本（随用户轮发给模型，供 view_image_detail 引用）
    const outImages = sendImages.map((im) => ({ base64: im.base64, mime: im.mime, w: im.w, h: im.h, label: im.label }))
    sendImages.forEach((im, k) => {
      registerSourceImage(chatId.value, {
        id: `img-${mid}-${k}`,
        label: im.label,
        source: im.source,
        viewW: im.w,
        viewH: im.h,
      })
    })
    const imgNote =
      outImages.length > 0
        ? `[图片清单] ${outImages.map((im, k) => `img-${mid}-${k}（视图 ${im.w}×${im.h}，${im.label}）`).join('；')}`
        : undefined
    if (opts.doc) {
      pushUser({ id: mid, kind: 'doc', text: clean || undefined, doc: opts.doc, images: outImages.length > 0 ? outImages : undefined, imgNote })
    } else if (outImages.length > 0) {
      pushUser({
        id: mid,
        kind: 'photo',
        text: clean || undefined,
        imageBase64: outImages[0]!.base64,
        mime: outImages[0]!.mime,
        images: outImages.length > 1 ? outImages : undefined,
        imgNote,
        quoteText: quote || undefined,
      })
    } else {
      pushUser({ id: mid, text: clean, quoteText: quote || undefined })
    }
    void maybeRename(clean)
    busy.value = true
    // 本轮流式聚合状态：过程气泡 + 正文气泡按 EffiBuddy 聚合规则生成
    streamCreated = []
    // 增量基准：协议流回调给的是「累计全文」，按已展示长度切片投喂聚合器
    let textShown = ''
    let thinkingShown = ''
    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const { chatWithModel } = await import('@/ai/chat')
      // 上下文：历史轮次（文本/照片/文档），最多 16 轮；图片随轮次重建
      const history = messages.value
        .slice(0, -1)
        .flatMap((mm): ChatTurn[] => {
          const imgs = (mm.images ?? []).map((im) => ({ data: im.base64, mimeType: im.mime }))
          const turnImgs = imgs.length > 0 ? imgs : mm.imageBase64 ? [{ data: mm.imageBase64, mimeType: mm.mime ?? 'image/jpeg' }] : undefined
          if (mm.kind === 'doc' && mm.doc) {
            return [{ role: 'user', text: composeOutgoingText(mm.text ?? '', mm.doc, mm.imgNote), images: turnImgs }]
          }
          if (mm.kind === 'photo' && (turnImgs || mm.text || mm.imgNote)) {
            return [{ role: 'user', text: [mm.text, mm.imgNote].filter(Boolean).join('\n'), images: turnImgs }]
          }
          if ((mm.kind === 'text' || mm.kind === 'analysis' || mm.kind === 'voice') && mm.text) {
            return [{ role: mm.role, text: mm.text }]
          }
          return []
        })
        .slice(-16)
      // 本轮带图或历史带图：自动降级用视觉模型（默认不支持视觉时改用任一已证实视觉的）
      const outgoingImages = outImages.map((im) => ({ data: im.base64, mimeType: im.mime }))
      const needsVision =
        outgoingImages.length > 0 || history.some((h) => h.role === 'user' && (!!h.images?.length || !!h.image))
      const cfg = needsVision ? models.bestVisionModel() : models.defaultModel()
      if (!cfg) {
        if (outgoingImages.length > 0) {
          pushAssistant({ text: '识别图片需要先在「模型」页添加并探测 AI 模型。' })
        } else {
          await keywordParse(clean)
        }
        return
      }
      // 同步放大镜的视图/输出上限到所选模型配置（发送视图在选图时已按视觉模型压好）
      setViewEdgeCap(cfg.imageMaxEdge ?? DEFAULT_IMAGE_EDGE)
      // @纪要引用：把总结+逐句转写注入本轮文本，模型据此回答针对录音内容的问题
      const memoContext = (opts.memoRefs ?? [])
        .map((memo) => {
          const sums = memo.summary.map((it) => `- [${it.kind}] ${it.text}`).join('\n') || '（无总结条目）'
          const sents = memo.sentences.map((s) => `${s.idx}. ${s.text}`).join('\n')
          return `（引用语音纪要《${memo.title}》\n总结：\n${sums}\n逐句转写：\n${sents}）`
        })
        .join('\n\n')
      const outgoingText =
        (memoContext ? memoContext + '\n\n' : '') +
        composeOutgoingText(
          quote ? `（引用我之前的一条消息：「${quote}」）\n${clean}` : clean,
          opts.doc,
          imgNote,
        )
      // 上传文档的**全文**自动归档进知识库（prompt 只带截断版，全文靠 read_knowledge 分页读）。
      // 归档要 await：落库完成后模型本轮就能 read_knowledge 到全文；失败只提示，不影响本轮对话。
      if (opts.doc?.fullText?.trim()) {
        const docPath = docArchivePath(opts.doc.name)
        await kbService
          .fileWrite({ path: docPath, content: opts.doc.fullText })
          .then(() => {
            invalidateCognitionCache()
            toast.toast(`已归档到知识库：${docPath}`)
          })
          .catch(() => {})
      }
      // 流式占位气泡：先建一个空 text 气泡承载推理/工具（无内容不播入场动画）；
      // 正文出现时按聚合规则「断开合并」另起正文气泡
      agg.openBubble(false)
      // 长期记忆作为「事实前提」预注入，而不是等模型自己去调工具发现；
      // 系统提示词 + 用户记忆一并全量注入（§3.4）
      const cognition = await cognitionForPrompt()
      const injection = await injectionForPrompt()
      const r = await chatWithModel(cfg, history, { text: outgoingText, images: outgoingImages.length > 0 ? outgoingImages : undefined }, {
        onText: (p) => {
          // 从 JSON 协议流里解出正文；food 卡 / 未定型阶段保持打字态
          const view = chatStreamView(p)
          const visible = view.mode === 'chat' || view.mode === 'plain' ? view.text : ''
          if (visible.length >= textShown.length && visible.startsWith(textShown)) {
            const delta = visible.slice(textShown.length)
            textShown = visible
            if (delta) agg.appendText(delta)
          } else {
            // 基准失效（工具后 textAcc 清零重新累计）→ 仅重置基准
            textShown = visible
          }
        },
        onThinking: (p) => {
          // thinking_delta 给累计增量、thinking_end 重发全量；统一按已展示长度切增量
          if (p.length >= thinkingShown.length && p.startsWith(thinkingShown)) {
            const delta = p.slice(thinkingShown.length)
            thinkingShown = p
            if (delta) agg.appendReasoning(delta)
          } else {
            thinkingShown = p
          }
        },
        onToolStart: (name, args) => {
          agg.toolCall(name, findAppTool(name)?.label ?? name, safeArgs(args))
        },
        onToolEnd: (name, ok, brief, resultImage, details) => {
          agg.toolResult(name, { ok, brief, resultImage, details })
        },
      }, { cognition, injection })
      // 流式收尾：结束思考计时（照搬 EffiBuddy finalizeStream 的状态语义）
      const lastStreamBubble = agg.streamingBubbleId.value
        ? (messages.value.find((m) => m.id === agg.streamingBubbleId.value) ?? null)
        : null
      agg.finalize()
      // 正文承载气泡：流式指针上的气泡已有正文、或它本就是纯占位（无过程段）时由它承载；
      // 指针上是纯过程气泡（有推理/工具无正文）则取最后一条有正文的气泡
      let bodyBubble: AiMessage | null =
        lastStreamBubble && (lastStreamBubble.text || !(agg.getMeta(lastStreamBubble.id)?.segments.length))
          ? lastStreamBubble
          : ([...streamCreated].reverse().find((m) => m.text) ?? null)
      if (!bodyBubble) {
        // 全程只有过程（模型直接出 food 卡 / 空回复）：另起一个空正文气泡承接定稿
        bodyBubble = pushAssistant({ kind: 'text', text: '', streaming: false }, false)
        streamCreated.push(bodyBubble)
      }
      settleStreamMessages(bodyBubble)
      await applyLlmReply(bodyBubble, r.text)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 流式中断：结束思考计时，过程气泡与已有正文保留，纯空占位撤掉
      agg.finalize()
      settleStreamMessages(null)
      pushAssistant({ text: `AI 回复失败：${msg}` })
    } finally {
      busy.value = false
    }
  }

  /** 语音轮：转写文本入会话（kind=voice 用户消息）+ 调 memoGen 整理纪要。
   * 整理期间回复流每 ~1s upsert 一次（实时持久化：崩溃最多丢最后一秒，不丢整段）。
   * 返回创建的纪要（无模型/失败时 null，转写内容始终已入会话）。 */
  async function sendVoiceTurn(input: {
    lines: { idx: number; text: string; startMs: number; endMs: number }[]
    memoId: string
    audioPath?: string | null
    durationMs: number
  }): Promise<VoiceMemo | null> {
    const transcript = input.lines.map((l) => l.text).join('')
    pushUser({
      kind: 'voice',
      text: transcript,
      voiceMeta: { memoId: input.memoId, durationMs: input.durationMs, words: transcript.length },
    })
    void maybeRename(transcript.slice(0, 16) || '语音')
    busy.value = true
    // 占位气泡：流式期间周期 upsert（原始协议文本，定稿后替换为 markdown 回复）
    const bubble = pushAssistant({ kind: 'text', text: '', streaming: true }, false)
    let lastPersist = 0

    /** 把这一段（转写 + 音频 + 纪要条目）落进历史。
     *  **无论 AI 整理成功与否都必须调用** —— 记录与音频是用户自己的东西，
     *  不该因为模型没配置、没额度或整理报错就从历史里消失。 */
    const persistMemo = (result: MemoGenResult | null): Promise<VoiceMemo> =>
      voiceService.memoCreate({
        id: input.memoId,
        chatId: chatId.value,
        messageId: bubble.id,
        title: result?.title || `语音 ${new Date().toTimeString().slice(0, 5)}`,
        audioPath: input.audioPath ?? null,
        durationMs: input.durationMs,
        words: transcript.length,
        sentencesJson: JSON.stringify(input.lines),
        summaryJson: JSON.stringify((result?.items ?? []).map((it) => ({ ...it, written: false }))),
      })

    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const cfg = models.defaultModel()
      let result: MemoGenResult | null = null
      if (cfg) {
        const { generateMemo } = await import('@/ai/memoGen')
        result = await generateMemo(cfg, input.lines, {
          onText: (raw) => {
            bubble.text = raw
            const now = Date.now()
            if (now - lastPersist > 1000) {
              lastPersist = now
              persist(bubble)
            }
          },
        })
      }
      bubble.streaming = false
      bubble.text = result?.reply ?? '还没有配置 AI 模型，转写已保存，配置后可整理纪要。'
      persist(bubble)
      const memo = await persistMemo(result)
      void refreshChats()
      return memo
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bubble.streaming = false
      if (bubble.text) {
        persist(bubble)
      } else {
        const idx = messages.value.indexOf(bubble)
        if (idx >= 0) messages.value.splice(idx, 1)
      }
      // 整理失败也必须落库：记录与音频不能因为模型报错就丢
      try {
        await persistMemo(null)
        void refreshChats()
      } catch {
        /* 连纪要行都写不进去：下面的提示已说明转写仍留在会话里 */
      }
      pushAssistant({ text: `纪要整理失败：${msg}。转写与录音已存入历史。` })
      return null
    } finally {
      busy.value = false
    }
  }

  /** 解析条目 → 写入某日饮食（跳过未匹配项）。聊天解析卡与拍照识别弹层共用。 */
  async function commitParsedItems(
    items: ParsedFoodItem[],
    mealType: MealType,
    source: 'photo_ai' | 'text_ai' = 'text_ai',
    date = todayStr(),
  ): Promise<{ written: number }> {
    let written = 0
    for (const item of items) {
      if (item.foodId == null) continue
      await dietService.logMeal({
        foodId: item.foodId,
        date,
        mealType,
        quantityMode: 'grams',
        grams: item.grams,
        units: null,
        unitName: null,
        source,
        note: null,
      })
      written++
    }
    await Promise.all([useDietStore().load(date), useNutritionStore().loadSummary(date)])
    return { written }
  }

  /** 确认聊天里的解析卡：写入今日饮食并标记完成 */
  async function commitParse(messageId: string, mealType: MealType): Promise<void> {
    const msg = messages.value.find((m) => m.id === messageId)
    if (!msg?.items?.length || msg.committed) return
    const r = await commitParsedItems(msg.items, mealType, msg.source ?? 'text_ai')
    msg.committed = true
    persist(msg)
    const skipped = msg.items.length - r.written
    if (skipped > 0) toast.toast(`已写入 ${r.written} 项，跳过 ${skipped} 项未匹配`)
  }

  /** 基于真实汇总数据生成今日饮食分析 */
  async function analyzeToday(): Promise<void> {
    const n = useNutritionStore()
    await n.loadSummary(todayStr())
    const s = n.summary
    if (!s) {
      pushAssistant({ text: '还没有今天的饮食数据。' })
      return
    }
    const lines: string[] = []
    lines.push(`今天已摄入约 ${Math.round(s.intake.kcal)} 大卡（目标 ${Math.round(s.targets.kcal)}），运动消耗 ${Math.round(s.exerciseKcal)} 大卡。`)
    const proteinLeft = Math.max(0, Math.round(s.targets.protein - s.intake.protein))
    lines.push(
      proteinLeft > 0
        ? `蛋白质还差 ${proteinLeft}g，可以来一份鸡胸肉、鸡蛋或酸奶。`
        : '蛋白质已经达标，很棒。',
    )
    if (s.intake.sodiumMg > s.targets.sodiumMg) {
      lines.push('钠摄入偏高，晚上请清淡一些、多喝水。')
    }
    if (s.intake.fiber < 10) {
      lines.push('膳食纤维偏少，建议补充蔬菜、水果或全谷物。')
    }
    pushAssistant({ kind: 'analysis', text: lines.join('\n') })
  }

  /** 自然语言 → 目标调整建议（仅生成待确认方案；失败时抛错由页面提示） */
  async function requestTargetAdjust(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean || busy.value) return
    const n = useNutritionStore()
    if (!n.profile) await n.loadProfile()
    if (!n.profile) throw new Error('profile 不可用')
    busy.value = true
    try {
      targetProposal.value = await aiService.parseTargetAdjust(clean, n.profile.targets)
    } finally {
      busy.value = false
    }
  }

  /** 确认采用 AI 建议的新目标（跨域联动：经 nutrition store 落库并刷新） */
  async function applyTargetProposal(): Promise<void> {
    const p = targetProposal.value
    if (!p) return
    await useNutritionStore().saveTargets(p.targets)
    targetProposal.value = null
  }

  function dismissTargetProposal(): void {
    targetProposal.value = null
  }

  return {
    messages,
    busy,
    chatId,
    chats,
    targetProposal,
    /** 流式渲染状态（AIPage 用：过程段 / 思考计时 / 流式指针） */
    streamingBubbleId: agg.streamingBubbleId,
    streamSeq,
    getMeta: agg.getMeta,
    init,
    greet,
    selectChat,
    newChat,
    clearContext,
    /** 知识库页改过记忆后调它，让下一轮的认知注入立刻反映改动而不是等 TTL 过期 */
    invalidateCognitionCache,
    /** 知识库页「AI 整理」按钮：手动跑一次整库整理（跳过开关与节流），返回改动条数 */
    consolidateMemoriesNow,
    retract,
    sendText,
    sendVoiceTurn,
    commitParse,
    commitParsedItems,
    analyzeToday,
    requestTargetAdjust,
    applyTargetProposal,
    dismissTargetProposal,
  }
})
