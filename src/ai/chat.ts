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
import { estimateRequestBytes, estimateResponseBytes, recordTurn } from './usageLedger'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** 用户轮次可携带图片（base64，无 data: 前缀），用于把照片/文档图片加入上下文再提问 */
  image?: { data: string; mimeType: string }
  /** 多图版本（消息带 N 张图）；与 image 互斥，images 优先 */
  images?: { data: string; mimeType: string }[]
}

export interface ChatResult {
  /** 最后一条 assistant 消息的完整文本（原始输出） */
  text: string
  /** 思考内容（thinking 块拼接；无则 null） */
  thinking: string | null
}

/** 本轮用户消息：纯文本，或文字 + 附图（N 张，图作为 content 图片块发给模型） */
export interface ChatOutgoing {
  text: string
  image?: { data: string; mimeType: string }
  images?: { data: string; mimeType: string }[]
}

/** 流式回调：文本/思考各自的累计增量（每次给全量），以及工具执行过程 */
export interface ChatStreamHandlers {
  onText?: (partial: string) => void
  onThinking?: (partial: string) => void
  /** 工具开始执行（args 为模型原始入参） */
  onToolStart?: (toolName: string, args: unknown) => void
  /** 工具执行结束；brief 为给用户看的结果摘要；resultImage 为放大镜等工具返回的图片；details 为其元数据 */
  onToolEnd?: (
    toolName: string,
    ok: boolean,
    brief: string,
    resultImage?: { base64: string; mime: string },
    details?: unknown,
  ) => void
}

/**
 * 系统提示词：身份 + 系统提示词目录 + 用户认知 + 用户记忆 + 工具使用规则 + 数据约定 + JSON 输出协议。
 * 今天日期动态注入，模型据此解析「今天/明天」等相对时间；
 * `cognition` 是知识库给出的长期记忆块（见 stores/ai.ts 的注入链路），
 * `injection` 是工作区的全量注入区（系统提示词/ 与 用户记忆/ 目录，见 docs/ai-workspace.md §3.4）。
 * 做成「预注入」而不是又一个工具，是因为模型每轮都该直接知道自己面对的是谁，
 * 而不是先花一次工具调用去「发现自己是谁」。
 */
export function buildChatSystemPrompt(
  now = new Date(),
  cognition?: string,
  injection?: { system?: string; memory?: string; truncated?: boolean },
): string {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const week = '日一二三四五六'[now.getDay()]
  const cognitionBlock = cognition?.trim()
    ? `\n【用户认知】以下是从过去对话中提炼的长期记忆，作为事实前提使用，不要向用户复述「我记得……」这类元话术；与用户当下说法冲突时以当下为准：\n${cognition.trim()}\n`
    : ''
  // 系统提示词目录（系统区）与用户记忆（记忆区）每轮全量注入；超预算时后端已按优先级截断并标注
  const systemBlock = injection?.system?.trim()
    ? `\n【系统提示词】以下条目由用户/应用维护，优先级高于本文其余风格约定：\n${injection.system.trim()}\n`
    : ''
  const memoryBlock = injection?.memory?.trim()
    ? `\n【用户记忆】用户亲自维护的长期设定与规则，始终遵守、不要复述：\n${injection.memory.trim()}\n`
    : ''
  return `你是 Rein AI，Rein 健康生活应用的内置助手，语气自然亲切，什么话题都能聊，回复用简体中文。
${systemBlock}${memoryBlock}
AI 模型配置也由你直接管理：list_models 查看已配置的模型与能力、add_model 添加、update_model 修改（只传要改的字段，apiKey 不传则保留原值）、set_default_model 切换默认、probe_model 用 6 个 max_tokens=1 的最小请求探测连通与视觉/思考能力（添加或修改后建议探测一次）、delete_model 删除（仅限用户明确要求）。用户让你「加模型 / 换模型 / 换 Key / 测模型」时用这组工具完成，工具结果里不回传密钥明文，改动从下一条消息起生效。语音对话（实时转写 + 纪要朗读）服务也由你配置和排障：get_voice_status 看识别（ASR）与朗读（TTS）各自是否就绪、update_voice_config 修改凭据/适配器/音色/语速（合并式，只传要改的字段）、test_voice_asr 测试识别连通、test_voice_tts 试听合成（音频会直接播放给用户）、list_voice_presets 查推荐音色。用户说「语音对话不能用 / 转写失败 / 朗读失败 / 帮我配语音 / 换个音色」时，先用 get_voice_status 诊断，再按需修改并测试验证；识别配了 Qwen 时朗读必须单独配豆包凭据（ttsStandalone），这是最常见的故障原因。
【知识库】你的全部数据与用户文件都编目在一棵虚拟文件树里（日程/运动/课程/饮食/体测/食物/方案/菜单/语音/对话/附件/记忆/笔记/文档/未分类数据/用户记忆/系统提示词/规范）。search_knowledge 在其中做跨来源语义与关键词检索，返回摘要级命中；要正文用 read_knowledge 传 id（默认只给概览；长文分块了，用 level:"l2" 配 offset/limit 逐页读，返回里有 hasMore 与 nextOffset）。用户问「之前/上周/有没有……」「我是不是……」这类需要跨来源回忆、找规律或翻旧记录的问题时用它，而不是逐个调各域的列表工具。检索词用 2~6 个字的简短关键词命中率最高（如「膝盖」而不是「我膝盖那边的情况怎么样」）；可配 from/to 限定日期区间、sources 限定来源。按文件名或目录找东西用 glob_knowledge（* 不跨目录、** 跨目录，如 笔记/*.md、对话/**）。长期记忆由你维护：list_memories 查看、remember 仅在用户明确要求「记住」时写入、edit_memory 在用户改主意时更新、forget 仅按用户明确要求删除（先 list_memories 拿 id）。用户明确要求「写个笔记/记下来」时用 write_note 建 markdown 笔记（rename_note 改名、delete_note 删除）。文件不仅有文本：音频/视频/图片是同一节点的不同模态，需要原件或问「录音里说了什么」时用 read_modal（不可用会降级为文本并说明原因，这是正常结果，不要反复重试）。你有整理职责：新内容常落在 未分类数据/，看内容用 classify_move 归到语义合适的目录并写清 reason；用户说「别乱动」时用 pin_file 钉住；确实需要新层级才用 make_folder。系统区（系统提示词/、规范/）只读，派生文档（带日期目录或 -编号 的文件）不可改不可移——要改内容就改源数据。${cognitionBlock}
【图片】消息带图片/文档时，每张图在消息文字里有编号清单（如 img-xxx（视图 2048×1536，附图），视图宽高即该图的像素坐标范围）。图片里文字或细节太小看不清时，调用 view_image_detail 按当前那张图的像素坐标放大局部区域——放大永远从原图裁切，放大结果会以新编号回给你，可继续递归放大（最多 3 层）；坐标越界会自动裁剪、区域过小会报错，按错误提示调整即可。
【约定】今天是 ${today}（周${week}）。日期一律 YYYY-MM-DD，工具不传日期默认处理今天；金额以元为单位；删除类操作仅在本条消息里用户明确要求时才调用。
【输入格式】用户消息可能是 Markdown 格式（标题、列表、加粗、代码块、表格等）。遇到 Markdown 文本时按 Markdown 语义理解其结构与层级，不要当成纯文本逐字读。
【分寸】用户只是陈述吃了什么时，优先输出 food 卡片让用户确认后再入库；用户明确要求"直接记下来 / 帮我改掉 / 删掉某条"时才直接调用写工具。用户发来照片时先看图：图里是饮食/食物就按 food 卡约定输出卡片（哪怕没有配文字）；是其他内容就结合图片正常回答文字问题。search_food 搜不到匹配的食品时，直接用 create_food 手动补录进库（营养由你按每 100g 估算并完整填入）并继续完成当前动作（写入记录或放进 food 卡），在回复里提一句已新增即可，不需要先征求同意。
【food 卡约定】输出 kind:"food" 前，必须对每个食物用简短通用关键词（如「米饭」「鸡蛋」）调用 search_food，从结果中选定最贴近的一项：foodName 用选定的库内名称、foodId 用它的 id（模糊搜索会按相似度排序，直接取第一项）。库里搜不到匹配的食品时，不要留空也不要反复追问——直接调用 create_food 手动新建（名称用通用名，营养按每 100g 估算填 kcal/protein/carb/fat），用返回的新 id；仅当创建失败时才省略 foodId。grams 按常见份量估算（如一个鸡蛋约50g、一碗米饭约200g、一杯牛奶约250g），不要一律填 100。
【输出】无论是否调用了工具，最终回复只能输出一个 JSON 对象（不要 markdown 代码块、不要解释文字）：
- 只有用户明确聊到食物/一顿饭（提到吃了喝了什么，或发来图片中的食物）且可估算份量时：{"kind":"food","items":[{"foodName":"选定食物名","grams":克重数字,"kcalEstimate":估算大卡数字,"foodId":选定的食物id,"nutrition":{"kcal":每100g大卡,"protein":每100g蛋白克数,"carb":每100g碳水克数,"fat":每100g脂肪克数}}]}（nutrition 仅在食物为库中新建时必填，其余情况可省略）；
- 其他任何情况：{"kind":"chat","text":"你的回复"}。已通过工具完成的操作（含 create_food 新增的食品）要在 text 里简要确认结果。字段名严格用 foodName / grams / kcalEstimate / foodId / nutrition，不要发明其他键名。`
}

/** 最后一条 assistant 消息的真实 token 用量（pi-ai 流式结束后写入），用于记账 */
function lastAssistantUsage(
  messages: AgentMessage[],
): { promptTokens: number; completionTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const usage = (m as { usage?: { input?: number; output?: number } }).usage
    const promptTokens = Number(usage?.input ?? 0)
    const completionTokens = Number(usage?.output ?? 0)
    return promptTokens || completionTokens ? { promptTokens, completionTokens } : null
  }
  return null
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
      const imgs = h.images ?? (h.image ? [h.image] : [])
      if (imgs.length > 0) {
        const content: unknown[] = [
          { type: 'text' as const, text: h.text || `（图片 ×${imgs.length}）` },
          ...imgs.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType })),
        ]
        return { role: 'user', content, timestamp: Date.now() }
      }
      return { role: 'user', content: h.text, timestamp: Date.now() }
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
 * message 可为纯文本，或文字+附图（图片作为本轮 user 消息的图片块）。
 * opts.systemPrompt 可覆盖默认系统提示词（纪要整理等非聊天任务复用同一条链路）；
 * opts.cognition 为知识库注入的长期记忆块，opts.injection 为工作区全量注入区（系统提示词/用户记忆），
 * 两者都仅在走默认提示词时生效。 */
export async function chatWithModel(
  config: AiModel,
  history: ChatTurn[],
  message: string | ChatOutgoing,
  handlers?: ChatStreamHandlers,
  opts?: {
    systemPrompt?: string
    cognition?: string
    injection?: { system?: string; memory?: string; truncated?: boolean }
  },
): Promise<ChatResult> {
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const outgoing: ChatOutgoing = typeof message === 'string' ? { text: message } : message

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt:
        opts?.systemPrompt ??
        buildChatSystemPrompt(new Date(), opts?.cognition, opts?.injection),
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
        // 工具后模型重新输出最终答复：文本累积从头计，避免工具前零星文本混进协议流
        textAcc = ''
        handlers.onToolStart?.(e.toolName, e.args)
      } else if (e.type === 'tool_execution_end') {
        handlers.onToolEnd?.(e.toolName, !e.isError, resultBrief(e.result))
      }
    })
  }

  const outgoingImgs = outgoing.images ?? (outgoing.image ? [outgoing.image] : [])
  await agent.prompt(
    outgoing.text || `（用户发来 ${outgoingImgs.length || 1} 张图片，请结合图片内容回应）`,
    outgoingImgs.length > 0
      ? outgoingImgs.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))
      : undefined,
  )
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const text = lastAssistantText(agent.state.messages)
  const thinking = assistantThink(agent.state.messages)

  // 本机记账：服务端（在线模型）另有权威账本，这里保证离线也看得见成本
  const usage = lastAssistantUsage(agent.state.messages)
  if (usage) {
    await recordTurn(config, usage, {
      request: estimateRequestBytes(outgoing.text, outgoingImgs.map((im) => im.data)),
      response: estimateResponseBytes(text, thinking),
    })
  }

  return { text, thinking }
}
