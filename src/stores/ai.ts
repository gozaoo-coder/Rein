/** AI 域：对话消息流（Rust SQLite 持久化）+ 解析确认写入饮食。 */

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { aiService } from '@/services/aiService'
import { dietService } from '@/services/dietService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { useModelsStore } from '@/stores/models'
import { toParsedItems, type ModelFoodRow } from '@/ai/foodMatch'
import { findAppTool } from '@/ai/tools/registry'
import type { ChatTurn } from '@/ai/chat'
import { todayStr } from '@/utils/date'
import type {
  AiChat,
  AiChatMessage,
  AiChatMessageInput,
  AiMessage,
  MealType,
  ParsedFoodItem,
  TargetAdjustProposal,
  ToolCallRecord,
} from '@/types'
import { useToast } from '@/composables/useToast'

let seq = 0
const uid = () => `m${Date.now().toString(36)}${++seq}`
const newChatId = () => `c${Date.now().toString(36)}${++seq}`

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
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
  }

  async function refreshChats(): Promise<void> {
    chats.value = await aiService.aiChatList()
  }

  /** 切换会话（历史抽屉选择） */
  async function selectChat(id: string): Promise<void> {
    if (busy.value || id === chatId.value) return
    chatId.value = id
    try {
      messages.value = (await aiService.aiChatMessages(id)).map(fromStored)
    } catch {
      messages.value = []
    }
    if (messages.value.length === 0) greet()
  }

  /** 新对话：新建空会话并写入欢迎语 */
  async function newChat(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      chatId.value = newChatId()
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
    try {
      await aiService.aiChatClear(chatId.value)
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

  /** 发送一轮消息：纯文本，或文字 + 附图（图与文同属一条 user 消息，渲染为图/文两个气泡）。
   * 带图时自动改用视觉模型；模型看图决定出 food 卡（智能填入）还是回答问题。 */
  async function sendText(
    text: string,
    quoteText?: string,
    image?: { base64: string; mime: string },
  ): Promise<void> {
    const clean = text.trim()
    if ((!clean && !image) || busy.value) return
    const quote = quoteText?.trim()
    if (image) {
      pushUser({
        kind: 'photo',
        text: clean || undefined,
        imageBase64: image.base64,
        mime: image.mime || 'image/jpeg',
        quoteText: quote || undefined,
      })
      void maybeRename(clean)
    } else {
      pushUser({ text: clean, quoteText: quote || undefined })
      void maybeRename(clean)
    }
    busy.value = true
    // 工具过程卡：本轮有工具调用时创建，插在回复占位气泡之前，结束（含失败）后统一持久化
    let toolsMsg: AiMessage | null = null
    try {
      const models = useModelsStore()
      if (!models.loaded) await models.load()
      const { chatWithModel } = await import('@/ai/chat')
      // 上下文：历史纯文本轮次 + 照片轮次（带图，供后续追问），最多 16 轮
      const history = messages.value
        .slice(0, -1)
        .flatMap((mm): ChatTurn[] => {
          if (mm.kind === 'photo' && mm.imageBase64) {
            return [{ role: 'user', text: mm.text ?? '', image: { data: mm.imageBase64, mimeType: mm.mime ?? 'image/jpeg' } }]
          }
          if ((mm.kind === 'text' || mm.kind === 'analysis') && mm.text) {
            return [{ role: mm.role, text: mm.text }]
          }
          return []
        })
        .slice(-16)
      // 本轮带图或历史带图：自动降级用视觉模型（默认不支持视觉时改用任一已证实视觉的）
      const outgoingImage = image ? { data: image.base64, mimeType: image.mime || 'image/jpeg' } : undefined
      const needsVision = !!outgoingImage || history.some((h) => h.role === 'user' && !!h.image)
      const cfg = needsVision ? models.bestVisionModel() : models.defaultModel()
      if (!cfg) {
        if (outgoingImage) {
          pushAssistant({ text: '识别图片需要先在「模型」页添加并探测 AI 模型。' })
        } else {
          await keywordParse(clean)
        }
        return
      }
      // 引用：作为本轮文字的前置上下文发给模型
      const outgoingText = quote ? `（引用我之前的一条消息：「${quote}」）\n${clean}` : clean
      // 流式占位气泡：增量实时更新文本/思考，定稿后 morph 成卡片或终稿
      const placeholder = pushAssistant({ kind: 'text', text: '' }, false)
      let thinkingAcc: string | null = null
      const r = await chatWithModel(cfg, history, { text: outgoingText, image: outgoingImage }, {
        onText: (p) => {
          placeholder.text = p
        },
        onThinking: (p) => {
          thinkingAcc = p
          placeholder.thinking = p
        },
        onToolStart: (name, args) => {
          if (!toolsMsg) {
            const m: AiMessage = { id: uid(), role: 'assistant', kind: 'tools', at: new Date().toISOString(), toolCalls: [] }
            const idx = messages.value.indexOf(placeholder)
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
        onToolEnd: (name, ok, brief) => {
          const calls = toolsMsg?.toolCalls
          if (!calls) return
          const rec = lastRunningCall(calls, name)
          if (rec) {
            rec.status = ok ? 'ok' : 'error'
            rec.resultBrief = brief
          }
        },
      })
      if (toolsMsg) persist(toolsMsg)
      await applyLlmReply(placeholder, r.text, thinkingAcc ?? r.thinking)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (toolsMsg) persist(toolsMsg)
      pushAssistant({ text: `AI 回复失败：${msg}` })
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
    retract,
    sendText,
    commitParse,
    commitParsedItems,
    analyzeToday,
    requestTargetAdjust,
    applyTargetProposal,
    dismissTargetProposal,
  }
})
