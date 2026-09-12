/**
 * 智能添加：文本 / 图片 → 待办草稿 + 食物解析卡（供 SmartAddSheet 使用）。
 *
 * 与聊天同一套 pi-agent-core 单轮 Agent，但挂载最小食物工具集
 * （search_food / create_food / get_food），让模型在输出前自行把每个食物
 * 匹配到库内 foodId（搜不到就新建），输出 JSON 对象后前端再做合法性处理。
 * 要求：图片/文本里的"任务类内容"→待办；"吃吃喝喝"→食物并估算重量。
 */

import type { AiModel, ParsedFoodItem, TodoDraft } from '@/types'
import { todayStr } from '@/utils/date'
import { extractJsonObject, lastAssistantText } from './json'
import { jsonArrayItems } from './streamExtract'
import { toParsedItems, type ModelFoodRow } from './foodMatch'
import { buildRuntime } from './runtime'
import { buildAppAgentTools, findAppTool } from './tools/registry'
import { toDrafts, type RawTodoRow } from './todoGen'

export interface SmartResult {
  todos: TodoDraft[]
  foods: ParsedFoodItem[]
}

/** 生成过程的流式回调：行完整才产出（草稿可直接上屏，定稿以返回值为准） */
export interface SmartStreamHandlers {
  /** 已流出的待办草稿（全量快照，按输出顺序） */
  onTodos?: (drafts: TodoDraft[]) => void
  /** 已流出的食物行（原始预览，尚未做库匹配/补录） */
  onFoodRows?: (rows: { foodName: string; grams: number | null }[]) => void
  /** 工具调用开始（食物库匹配过程），brief 为单行摘要 */
  onTool?: (brief: string) => void
}

function systemPrompt(today: string): string {
  return `你是 Rein 的智能解析助手。用户会粘贴一段文本（便签、聊天记录、随手记的想法）或发来一张图片（课程表、待办截图、菜单、餐食照片、白板等），里面可能是要做的任务，也可能是吃的喝的。请把"疑似任务类"的内容——要干的事情、安排、清单项、想法——全部抽取为待办；把被提到的或出现在图里的吃吃喝喝抽取为食物，并估算每份重量（如一个鸡蛋约50g、一碗米饭约200g、一杯牛奶约250g、一片面包约40g，不要一律填100）。
今天是 ${today}。
只能输出一个 JSON 对象（不要 markdown 代码块、不要任何解释文字）：
{"todos":[{"title":"简洁的待办标题（动词短语）","date":"YYYY-MM-DD（以今天 ${today} 为基准合理推断）","startMin":"一日内开始时间对应的分钟数（如 14:30 填 870；没提到时间则省略）","durationMin":"预计分钟数（没提到则省略）","category":"general|workout|health|study|work（运动相关选 workout，健康作息饮食选 health，学习选 study，工作选 work，其余 general）","priority":0|1|2（0 普通、1 重要、2 紧急）","notes":"来源或其他说明（可省略）"}],"foods":[{"foodName":"食物名称","grams":克重数字,"kcalEstimate":估算大卡数字,"foodId":食物id}]}
食物匹配规则：每个食物先用 search_food 工具搜索食物库（用简短通用关键词，如「米饭」「鸡蛋」），从结果中选定最贴近的一项，foodId 填它的 id；库里搜不到的直接用 create_food 新建（名称用通用名，营养按每 100g 估算填 kcal/protein/carb/fat），foodId 填返回的 id，并在该食物元素里补 nutrition 字段（每 100g 的 kcal/protein/carb/fat）。只输出实际出现或直接合理推断的内容，不要编造；完全没有待办时 todos 给 []，没有食物时 foods 给 []。`
}

interface RawSmartBody {
  todos?: unknown[]
  foods?: unknown[]
}

/** 单轮解析：文本 + 可选图片 → 待办草稿 + 食物卡 */
async function runGenerate(
  config: AiModel,
  text: string,
  image?: { data: string; mimeType: string },
  stream?: SmartStreamHandlers,
): Promise<SmartResult> {
  const today = todayStr()
  const { models, byId } = buildRuntime([config])
  const entry = byId.get(config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(today),
      model: entry.model,
      thinkingLevel: 'off',
      tools: buildAppAgentTools(['search_food', 'create_food', 'get_food']),
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  if (stream) {
    let acc = ''
    let todoCount = 0
    const drafts: TodoDraft[] = []
    let foodRows: { foodName: string; grams: number | null }[] = []
    agent.subscribe((e) => {
      if (e.type === 'message_update') {
        const ev = e.assistantMessageEvent
        if (ev.type !== 'text_delta') return
        acc += ev.delta
        // todos 数组：行完整才转换（toDrafts 纯前端），新增行保持 key 稳定
        const todoRows = jsonArrayItems(acc, 'todos')
        for (; todoCount < todoRows.length; todoCount++) {
          drafts.push(...toDrafts([todoRows[todoCount] as RawTodoRow], today))
        }
        if (drafts.length > 0) stream.onTodos?.(drafts)
        // foods 数组：只做展示预览，不触发建库（toParsedItems 会自动补录）
        const rawFoods = jsonArrayItems(acc, 'foods')
        if (rawFoods.length !== foodRows.length) {
          foodRows = rawFoods
            .map((r) => {
              const o = r as Record<string, unknown>
              return {
                foodName: typeof o.foodName === 'string' ? o.foodName.trim() : '',
                grams: typeof o.grams === 'number' && Number.isFinite(o.grams) ? o.grams : null,
              }
            })
            .filter((r) => r.foodName)
          stream.onFoodRows?.(foodRows)
        }
      } else if (e.type === 'tool_execution_start') {
        // 工具后模型重新输出最终答复：累积从头计，避免工具前零星文本混进协议流
        acc = ''
        todoCount = 0
        drafts.length = 0
        foodRows = []
        let brief = findAppTool(e.toolName)?.label ?? e.toolName
        try {
          const s = JSON.stringify(e.args) ?? ''
          if (s && s !== '{}') brief += ` ${s.length > 40 ? `${s.slice(0, 37)}…` : s}`
        } catch {
          /* 入参不可序列化时只显示工具名 */
        }
        stream.onTool?.(brief)
      }
    })
  }

  const prompt = text || '请解析这张图片中的待办事项和食物。'
  if (image) {
    await agent.prompt(prompt, [{ type: 'image', data: image.data, mimeType: image.mimeType }])
  } else {
    await agent.prompt(prompt)
  }
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const body = extractJsonObject(raw) as RawSmartBody | null
  const todos = toDrafts(Array.isArray(body?.todos) ? (body.todos as RawTodoRow[]) : [], today)
  const foods = await toParsedItems(
    (Array.isArray(body?.foods) ? body.foods : []) as unknown as ModelFoodRow[],
  )
  return { todos, foods }
}

/** 文本/图片 → 智能结果（模型必须已配置，由调用方保证） */
export async function generateSmart(
  config: AiModel,
  text: string,
  image?: { data: string; mimeType: string },
  stream?: SmartStreamHandlers,
): Promise<SmartResult> {
  const clean = text.trim()
  if (!clean && !image) throw new Error('请先粘贴内容或选择图片')
  return runGenerate(config, clean, image, stream)
}
