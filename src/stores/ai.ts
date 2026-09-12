/** AI 域：对话消息流（Rust SQLite 持久化）+ 解析确认写入饮食。 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { aiService } from '@/services/aiService'
import { dietService } from '@/services/dietService'
import { kbService } from '@/services/kbService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { useModelsStore } from '@/stores/models'
import { hasImage, getEntry, registerImage, registerSourceImage, resetChat, setActiveChat, setViewEdgeCap } from '@/ai/imageZoom'
import { chatStreamView } from '@/ai/streamExtract'
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
  TargetAdjustProposal,
  ToolCallRecord,
  VoiceMemo,
} from '@/types'
import type { MemoGenResult } from '@/ai/memoGen'
import { useToast } from '@/composables/useToast'

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
  if (m.kind === 'tools') {
    for (const c of m.toolCalls ?? []) {
      if (!c.resultImage || !c.zoomId || hasImage(chatId, c.zoomId)) continue
      const depth = Number(c.zoomId.match(/z(\d+)(?:-\d+)?$/)?.[1] ?? 0)
      const rootId = c.zoomId.replace(/z\d+(?:-\d+)?$/, '')
      const root = depth > 0 ? getEntry(chatId, rootId) : null
      if (root && c.zoomRect) {
        registerImage(chatId, {
          id: c.zoomId,
          label: c.label,
          depth,
          viewW: c.zoomW ?? 0,
          viewH: c.zoomH ?? 0,
          resolve: root.resolve,
          rect: c.zoomRect,
        })
      } else {
        registerSourceImage(chatId, {
          id: c.zoomId,
          label: c.label,
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

/** 工具入参摘要：截断 JSON，过程卡单行展示 */
function argsBrief(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? ''
    return s.length > 48 ? `${s.slice(0, 45)}…` : s
  } catch {
    return ''
  }
}

/** 倒序找最近一条同名的执行中记录 */
function lastRunningCall(calls: ToolCallRecord[], name: string): ToolCallRecord | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c && c.name === name && c.status === 'running') return c
  }
  return undefined
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
        if (p.quote) m.quoteText = p.quote
        if (p.doc) m.doc = p.doc
        if (p.images) m.images = p.images
        if (p.imgNote) m.imgNote = p.imgNote
        if (p.voice) m.voiceMeta = p.voice
      } catch {
        /* 损坏的历史 payload 忽略，卡片仍可展示文本 */
      }
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
      attachChatContext(chatId.value, messages.value)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
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

      const existing = await kbService.memories()
      const { extractMemories } = await import('@/ai/memoryExtract')
      const candidates = await extractMemories({ config: cfg, turns, existing })
      if (candidates.length === 0) return

      const r = await kbService.memoryApply(
        candidates,
        snapshotChatId,
        snapshot.map((m) => m.id),
      )
      invalidateCognitionCache()
      const changed = r.added + r.updated + r.deleted
      if (changed > 0) toast.toast(`已更新 ${changed} 条长期记忆`)
    })().catch(() => {})
  }

  /** 切换会话（历史抽屉选择） */
  async function selectChat(id: string): Promise<void> {
    if (busy.value || id === chatId.value) return
    // 离开当前会话 = 一次会话结束，先拿快照再切
    scheduleMemoryExtraction(chatId.value, messages.value)
    chatId.value = id
    try {
      messages.value = (await aiService.aiChatMessages(id)).map(fromStored)
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

  /** LLM 回复定稿：原地把流式占位气泡 morph 成解析卡或文本气泡，并持久化 */
  async function applyLlmReply(msg: AiMessage, raw: string, thinking: string | null): Promise<void> {
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
        msg.thinking = thinking ?? undefined
        persist(msg)
        return
      }
    }
    msg.text = obj && typeof obj.text === 'string' ? obj.text : raw
    msg.thinking = thinking ?? undefined
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
    // 工具过程卡：本轮有工具调用时创建，插在回复占位气泡之前，结束（含失败）后统一持久化
    let toolsMsg: AiMessage | null = null
    // 流式占位气泡：增量实时更新文本/思考，定稿后 morph 成卡片或终稿
    let placeholder: AiMessage | null = null
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
      // 流式占位气泡：增量实时更新文本/思考，定稿后 morph 成卡片或终稿
      const bubble = pushAssistant({ kind: 'text', text: '', streaming: true }, false)
      placeholder = bubble
      let thinkingAcc: string | null = null
      // 长期记忆作为「事实前提」预注入，而不是等模型自己去调工具发现
      const cognition = await cognitionForPrompt()
      const r = await chatWithModel(cfg, history, { text: outgoingText, images: outgoingImages.length > 0 ? outgoingImages : undefined }, {
        onText: (p) => {
          // 从 JSON 协议流里解出正文实时展示；food 卡 / 未定型阶段保持打字态
          const view = chatStreamView(p)
          bubble.text = view.mode === 'chat' || view.mode === 'plain' ? view.text : ''
        },
        onThinking: (p) => {
          thinkingAcc = p
          bubble.thinking = p
        },
        onToolStart: (name, args) => {
          if (!toolsMsg) {
            const m: AiMessage = { id: uid(), role: 'assistant', kind: 'tools', at: new Date().toISOString(), toolCalls: [] }
            const idx = messages.value.indexOf(bubble)
            messages.value.splice(idx >= 0 ? idx : messages.value.length, 0, m)
            toolsMsg = m
          }
          toolsMsg.toolCalls?.push({
            name,
            label: findAppTool(name)?.label ?? name,
            argsBrief: argsBrief(args),
            resultBrief: null,
            status: 'running',
          })
        },
        onToolEnd: (name, ok, brief, resultImage, details) => {
          const calls = toolsMsg?.toolCalls
          if (!calls) return
          const rec = lastRunningCall(calls, name)
          if (rec) {
            rec.status = ok ? 'ok' : 'error'
            rec.resultBrief = brief
            if (resultImage) rec.resultImage = resultImage
            const d = details as
              | { zoomId?: string; zoomW?: number; zoomH?: number; zoomRect?: { x: number; y: number; w: number; h: number } }
              | undefined
            if (d?.zoomId) {
              rec.zoomId = d.zoomId
              rec.zoomW = d.zoomW
              rec.zoomH = d.zoomH
              if (d.zoomRect) rec.zoomRect = d.zoomRect
            }
          }
        },
      }, { cognition })
      if (toolsMsg) persist(toolsMsg)
      await applyLlmReply(bubble, r.text, thinkingAcc ?? r.thinking)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (toolsMsg) persist(toolsMsg)
      // 占位气泡已流出部分正文就保留为终稿；空占位直接撤掉再提示失败
      if (placeholder) {
        if (placeholder.text) {
          placeholder.streaming = false
          persist(placeholder)
        } else {
          const idx = messages.value.indexOf(placeholder)
          if (idx >= 0) messages.value.splice(idx, 1)
        }
      }
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
      const memo = await voiceService.memoCreate({
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
      pushAssistant({ text: `纪要整理失败：${msg}。转写内容已保存。` })
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
    init,
    greet,
    selectChat,
    newChat,
    clearContext,
    /** 知识库页改过记忆后调它，让下一轮的认知注入立刻反映改动而不是等 TTL 过期 */
    invalidateCognitionCache,
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
