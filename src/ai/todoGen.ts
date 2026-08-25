/**
 * 待办智能解析：文本 / 图片 → TodoDraft[]（待用户确认，不直接落库）。
 * 与照片食物识别同一套 pi-ai 单轮 Agent 模式：系统提示只输出 JSON 数组，
 * 运行结束解析为草稿，并对字段做合法化（日期默认今天、时间 0–1439 钳制等）。
 */

import type { AiModel, TodoCategory, TodoDraft } from '@/types'
import { TODO_CATEGORIES } from '@/types'
import { todayStr } from '@/utils/date'
import { extractJsonArray, lastAssistantText } from './json'
import { buildRuntime } from './runtime'

const CATEGORY_SET = new Set<string>(TODO_CATEGORIES)

function systemPrompt(today: string): string {
  return `你是 Rein 的待办解析助手。用户会粘贴一段文本（便签、聊天记录、随手记的想法）或发来一张图片（课程表、待办截图、白板照片等），请抽取其中值得记录的待办事项。
今天是 ${today}。
只能输出一个 JSON 数组（不要 markdown 代码块、不要任何解释文字），数组元素结构：
{"title": "简洁的待办标题（动词短语）", "date": "YYYY-MM-DD（以今天 ${today} 为基准合理推断）", "startMin": 一日内开始时间对应的分钟数（如 14:30 填 870；没提到时间则省略）", "durationMin": 预计分钟数（没提到则省略）", "category": "general|workout|health|study|work（运动相关选 workout，健康作息饮食选 health，学习选 study，工作选 work，其余 general）", "priority": 0|1|2（0 普通、1 重要、2 紧急）", "notes": "来源或其他说明（可省略）"}
规则：只输出实际出现或直接合理推断的待办，每条一条，不要编造；完全没有待办时输出 []；文本/图片里的其他内容一律不要。`
}

let seq = 0
export const draftKey = () => `d${Date.now().toString(36)}${++seq}`

export interface RawTodoRow {
  title?: unknown
  date?: unknown
  startMin?: unknown
  durationMin?: unknown
  category?: unknown
  priority?: unknown
  notes?: unknown
}

const isDateStr = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** 模型输出行 → 待办草稿（字段合法化；供 todoGen 与 smartGen 共用） */
export function toDrafts(rows: RawTodoRow[], today: string): TodoDraft[] {
  const drafts: TodoDraft[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (!title) continue
    const date = typeof r.date === 'string' && isDateStr(r.date) ? r.date : today
    const clampMin = (v: unknown, max: number): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null
    const category =
      typeof r.category === 'string' && CATEGORY_SET.has(r.category)
        ? (r.category as TodoCategory)
        : 'general'
    const p = typeof r.priority === 'number' ? Math.round(r.priority) : 0
    drafts.push({
      key: draftKey(),
      title,
      notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null,
      date,
      startMin: clampMin(r.startMin, 1439),
      durationMin: clampMin(r.durationMin, 1440),
      category,
      priority: p === 2 ? 2 : p === 1 ? 1 : 0,
      checked: true,
      added: false,
    })
  }
  return drafts
}

async function runParse(
  config: AiModel,
  userText: string,
  image?: { data: string; mimeType: string },
): Promise<TodoDraft[]> {
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
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  if (image) {
    await agent.prompt(userText, [{ type: 'image', data: image.data, mimeType: image.mimeType }])
  } else {
    await agent.prompt(userText)
  }
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const parsed = extractJsonArray(raw)
  if (!Array.isArray(parsed)) throw new Error('模型输出不是 JSON 数组')
  return toDrafts(parsed as RawTodoRow[], today)
}

/** 文本 → 待办草稿（模型必须已配置，由调用方保证） */
export async function generateTodosFromText(config: AiModel, text: string): Promise<TodoDraft[]> {
  const clean = text.trim()
  if (!clean) throw new Error('请先粘贴要解析的内容')
  return runParse(config, clean)
}

/** 图片 → 待办草稿（传视觉模型配置；图片先压缩再送入） */
export async function generateTodosFromPhoto(
  config: AiModel,
  imageBase64: string,
  mime: string,
): Promise<TodoDraft[]> {
  return runParse(config, '请从这张图片中抽取待办事项。', { data: imageBase64, mimeType: mime })
}
