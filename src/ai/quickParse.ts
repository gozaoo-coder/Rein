/**
 * 一句话记待办：一句自然语言 → 待办草稿（TodoDraft[]）。
 *
 * 与 smartGen 同架构：**单轮** RustAgent + 关思考（thinkingLevel: 'off'）+ **不挂任何工具**，
 * 系统提示只允许输出一个 JSON 对象，前端拿到 assistant 文本后再做字段合法化。
 *
 * 为什么不直接复用 todoGen.generateTodosFromText：
 * - todoGen 面向「粘贴一大段文本 / 一张课程表图片」的**批量**抽取，提示里只喂了今天日期；
 *   本入口面向「一句话」，像「今天晚上7:30」「半小时后」这类相对时间要落到正确的分钟数上，
 *   所以提示里除了今天日期，还必须带上**当前本地时间**；
 * - 输出包成 `{todos:[...]}` 对象（与 smartGen 一致）而非顶层数组，日后并挂其它字段即可。
 * 字段合法化仍复用 todoGen 的 `toDrafts` / `RawTodoRow`，两处口径一致（日期默认今天、
 * startMin 0–1439 钳制、分类落白名单、priority 归一到 0–3），不另抄一份。
 */

import type { AiModel, TodoDraft } from '@/types'
import { minToHHmm, nowMin, todayStr } from '@/utils/date'
import { extractJsonObject, lastAssistantText } from './json'
import { RustAgent } from './rustAgent'
import { toDrafts, type RawTodoRow } from './todoGen'

function systemPrompt(today: string, now: string): string {
  return `你是 Rein 的待办解析助手。用户会输入一句自然语言（随手记的想法、要办的事），请把它解析成待办。
今天是 ${today}，现在是 ${now}。
只能输出一个 JSON 对象（不要 markdown 代码块、不要任何解释文字）：
{"todos":[{"title":"简洁的待办标题（动词短语）","date":"YYYY-MM-DD（以今天 ${today} 为基准推断；今天就说今天）","startMin":"一日内开始时间对应的分钟数（如 19:30 填 1170；「晚上7:30」「半小时后」这类相对说法要结合当前时间 ${now} 换算；没提到时间则省略该字段）","durationMin":"预计分钟数（没提到则省略）","category":"general|workout|health|study|work（运动相关选 workout，健康作息饮食选 health，学习选 study，工作选 work，其余 general）","priority":0|1|2|3（四象限：0 不重要不紧急、1 重要不紧急、2 紧急不重要、3 重要且紧急）","notes":"来源或其他说明（可省略）"}]}
规则：一句话通常就是一条待办，只有明确提到多件事时才拆成多条；只输出实际提到或直接合理推断的内容，不要编造；完全没有可记录的事就输出 {"todos":[]}。`
}

/** 一句话 → 待办草稿（模型必须已配置，由调用方保证；失败抛中文错误） */
export async function parseQuickTodo(config: AiModel, text: string): Promise<TodoDraft[]> {
  const clean = text.trim()
  if (!clean) throw new Error('请先输入一句话')

  const today = todayStr()
  const now = minToHHmm(nowMin())
  const agent = new RustAgent({
    initialState: {
      systemPrompt: systemPrompt(today, now),
      modelPk: config.id,
      thinkingLevel: 'off',
      messages: [],
    },
  })

  await agent.prompt(clean)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const body = extractJsonObject(raw) as { todos?: unknown } | null
  const rows = Array.isArray(body?.todos) ? (body.todos as RawTodoRow[]) : []
  return toDrafts(rows, today)
}
