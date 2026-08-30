/**
 * AI 聊天：pi-agent-core 单轮 Agent（带历史上下文），挂载统一工具注册表，
 * 模型可查询/修改 Rein 全部应用数据。回复含思考内容；系统提示约定最终输出
 * JSON 对象（food 卡片 / 纯聊天文本），由调用方（store）解析展示。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'

import type { AiModel } from '@/types'
import { lastAssistantText } from './json'
import { buildAppAgentTools } from './tools/registry'
import { buildRuntime } from './runtime'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** 用户轮次可携带图片（base64，无 data: 前缀），用于把照片加入上下文再提问 */
  image?: { data: string; mimeType: string }
}

export interface ChatResult {
  /** 最后一条 assistant 消息的完整文本（原始输出） */
  text: string
  /** 思考内容（thinking 块拼接；无则 null） */
  thinking: string | null
}

/** 本轮用户消息：纯文本，或文字 + 附图（图作为 content 图片块发给模型） */
export interface ChatOutgoing {
  text: string
  image?: { data: string; mimeType: string }
}

/** 流式回调：文本/思考各自的累计增量（每次给全量），以及工具执行过程 */
export interface ChatStreamHandlers {
  onText?: (partial: string) => void
  onThinking?: (partial: string) => void
  /** 工具开始执行（args 为模型原始入参） */
  onToolStart?: (toolName: string, args: unknown) => void
  /** 工具执行结束；brief 为给用户看的结果摘要 */
  onToolEnd?: (toolName: string, ok: boolean, brief: string) => void
}

/**
 * 系统提示词：身份 + 工具使用规则 + 数据约定 + JSON 输出协议。
 * 今天日期动态注入，模型据此解析「今天/明天」等相对时间。
 */
export function buildChatSystemPrompt(now = new Date()): string {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const week = '日一二三四五六'[now.getDay()]
  return `你是 Rein AI，Rein 健康生活应用的内置助手，语气自然亲切，什么话题都能聊，回复用简体中文。

【工具】你连接着 Rein 的全部数据，可以查询和修改：食物库与饮食记录、营养目标与个人资料与体重身高、待办、记账流水与月度预算、运动记录、训练课程模板（upsert_plan 可为力量动作配 warmups 激活热身组：≥30kg 复合动作 [50%×8, 75%×4]，12~30kg 单组 [50%×12]）、力量重量记录（get_strength_progress 查动作的重量变化曲线与逐组明细，用户问进步/是否加重时调用）、健康方案（get_program 查询 / generate_program 在用户明确要求时生成并启用新方案 / adjust_program 调参 / get_shopping_list 按方案菜单聚合采购清单，用户问买什么菜/备料/买菜清单时调用）、番茄钟记录、进行中的训练、历史聊天。涉及应用内数据的查询或修改都必须调用工具完成，禁止编造数据或假装已保存。工具返回 ok:false 时按 error 信息修正参数重试；查列表拿到 id 后再做修改/删除。你也可以联网：web_search 用必应搜索网页、web_fetch 抓取任意页面全文——需要应用内数据之外的事实（食物营养数据、菜谱做法、时事新闻等）时，先用 web_search 搜索，再按需 web_fetch 读具体页面。
【约定】今天是 ${today}（周${week}）。日期一律 YYYY-MM-DD，工具不传日期默认处理今天；金额以元为单位；删除类操作仅在本条消息里用户明确要求时才调用。
【分寸】用户只是陈述吃了什么时，优先输出 food 卡片让用户确认后再入库；用户明确要求"直接记下来 / 帮我改掉 / 删掉某条"时才直接调用写工具。用户发来照片时先看图：图里是饮食/食物就按 food 卡约定输出卡片（哪怕没有配文字）；是其他内容就结合图片正常回答文字问题。search_food 搜不到匹配的食品时，直接用 create_food 手动补录进库（营养由你按每 100g 估算并完整填入）并继续完成当前动作（写入记录或放进 food 卡），在回复里提一句已新增即可，不需要先征求同意。
【food 卡约定】输出 kind:"food" 前，必须对每个食物用简短通用关键词（如「米饭」「鸡蛋」）调用 search_food，从结果中选定最贴近的一项：foodName 用选定的库内名称、foodId 用它的 id（模糊搜索会按相似度排序，直接取第一项）。库里搜不到匹配的食品时，不要留空也不要反复追问——直接调用 create_food 手动新建（名称用通用名，营养按每 100g 估算填 kcal/protein/carb/fat），用返回的新 id；仅当创建失败时才省略 foodId。grams 按常见份量估算（如一个鸡蛋约50g、一碗米饭约200g、一杯牛奶约250g），不要一律填 100。
【输出】无论是否调用了工具，最终回复只能输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：
- 只有用户明确聊到食物/一顿饭（提到吃了喝了什么，或发来图片中的食物）且可估算份量时：{"kind":"food","items":[{"foodName":"选定食物名","grams":克重数字,"kcalEstimate":估算大卡数字,"foodId":选定的食物id,"nutrition":{"kcal":每100g大卡,"protein":每100g蛋白克数,"carb":每100g碳水克数,"fat":每100g脂肪克数}}]}（nutrition 仅在食物为库中新建时必填，其余情况可省略）；
- 其他任何情况：{"kind":"chat","text":"你的回复"}。已通过工具完成的操作（含 create_food 新增的食品）要在 text 里简要确认结果。字段名严格用 foodName / grams / kcalEstimate / foodId / nutrition，不要发明其他键名。`
}

function assistantThink(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const parts = m.content
      .filter((c) => c.type === 'thinking' && typeof (c as { thinking?: unknown }).thinking === 'string')
      .map((c) => (c as { thinking: string }).thinking)
    if (parts.length > 0) return parts.join('\n')
  }
  return null
}

/** 历史轮次 → AgentMessage：assistant 回复以文本块表达（agent 的 convertToLlm 原样透传）；
 * 必须带零值 usage —— pi-ai 估算上下文时会读 assistant.usage.totalTokens，缺失即抛 TypeError。 */
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function toAgentMessages(history: ChatTurn[]): Message[] {
  return history.map((h) => {
    if (h.role === 'user') {
      // 有图时用块数组（文本 + 图片块）；DeepSeek 只允许 user 消息带图
      const content = h.image
        ? [
            { type: 'text' as const, text: h.text || '（照片）' },
            { type: 'image' as const, data: h.image.data, mimeType: h.image.mimeType },
          ]
        : h.text
      return { role: 'user', content, timestamp: Date.now() }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: h.text }],
      timestamp: Date.now(),
      usage: EMPTY_USAGE,
      stopReason: 'stop',
    }
  }) as unknown as Message[]
}

/** 工具结果首段文本截断为过程卡摘要 */
function resultBrief(result: unknown): string {
  const first = (result as { content?: { type: string; text?: string }[] } | null)?.content?.[0]
  const text = first?.type === 'text' ? (first.text ?? '') : ''
  if (!text) return '已完成'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** 单轮聊天：历史纯文本轮次回灌为 AgentMessage，思考档取 low（快且有思考过程）。
 * 工具由统一注册表提供；handlers 可选流式回调与工具过程回调。
 * message 可为纯文本，或文字+附图（图片作为本轮 user 消息的图片块）。 */
export async function chatWithModel(
  config: AiModel,
  history: ChatTurn[],
  message: string | ChatOutgoing,
  handlers?: ChatStreamHandlers,
): Promise<ChatResult> {
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const outgoing: ChatOutgoing = typeof message === 'string' ? { text: message } : message

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: buildChatSystemPrompt(),
      model: entry.model,
      thinkingLevel: 'low',
      tools: buildAppAgentTools(),
      messages: toAgentMessages(history),
    },
    streamFn: models.streamSimple.bind(models),
  })

  if (handlers) {
    let textAcc = ''
    let thinkingAcc = ''
    agent.subscribe((e) => {
      if (e.type === 'message_update') {
        const ev = e.assistantMessageEvent
        if (ev.type === 'text_delta') {
          textAcc += ev.delta
          handlers.onText?.(textAcc)
        } else if (ev.type === 'thinking_delta') {
          thinkingAcc += ev.delta
          handlers.onThinking?.(thinkingAcc)
        } else if (ev.type === 'thinking_end') {
          thinkingAcc = ev.content
          handlers.onThinking?.(thinkingAcc)
        }
      } else if (e.type === 'tool_execution_start') {
        handlers.onToolStart?.(e.toolName, e.args)
      } else if (e.type === 'tool_execution_end') {
        handlers.onToolEnd?.(e.toolName, !e.isError, resultBrief(e.result))
      }
    })
  }

  await agent.prompt(
    outgoing.text || '（用户发来一张照片，请结合图片内容回应）',
    outgoing.image ? [{ type: 'image' as const, data: outgoing.image.data, mimeType: outgoing.image.mimeType }] : undefined,
  )
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  return {
    text: lastAssistantText(agent.state.messages),
    thinking: assistantThink(agent.state.messages),
  }
}
