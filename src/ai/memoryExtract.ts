/**
 * 长期记忆抽取：会话结束时，把「本轮对话 + 现有记忆清单」交给模型，
 * 一次调用同时完成**抽取与去重合并**，产出增/改/删。
 *
 * 为什么编排在前端：模型请求由 WebView 里的 pi-ai 直连 provider，Rust 不调模型
 * （见 src-tauri/src/modules/ai/mod.rs）。Rust 侧只负责落库（kb_memory_apply）。
 *
 * 为什么只调一次：把现有记忆一并放进上下文（记忆是几十条量级，很便宜），
 * 模型就能直接给出「这条该合并到哪条」，省掉 OpenViking 那套「抽取 → 向量预筛 → LLM 去重」
 * 的第二轮调用。这是本实现相对原方案的主要降本点。
 */

import type { AiModel, KbMemory, KbMemoryType, MemoryCandidate } from '@/types'
import type { ChatTurn } from './chat'
import { lastAssistantText } from './json'
import { buildRuntime } from './runtime'

/** 单次抽取允许的最大变更条数。防止模型把整段对话逐句复述成记忆。 */
const MAX_OPS = 8;
const MEMORY_TYPES: KbMemoryType[] = ['preference', 'constraint', 'event', 'entity', 'profile', 'pattern']

function systemPrompt(): string {
  return `你是 Rein 健康应用的长期记忆整理器。任务：从一段刚结束的对话里提炼**值得长期记住的、关于用户本人的稳定信息**，并与现有记忆合并。

只记录这些类型：
- preference 偏好：喜欢/讨厌、习惯性选择（「不喜欢香菜」「偏好早上训练」）
- constraint 约束：伤病、禁忌、硬性时间限制（「膝盖不适，深蹲不宜超过 60kg」「工作日 19 点前没空」）
- event 事件：发生过的、**带原因或结论**的事（「因为膝盖不适，把深蹲换成了腿举」）
- entity 实体：反复出现的人、地点、器械、课程名称
- profile 稳定画像：作息、经验水平、身体基础（「健身两年，能独立完成引体向上」）
- pattern 规律：反复出现的行为模式（「每周三、周六练腿」）

**不要记录**：一次性的任务内容（那已经在应用数据里）、临时状态（「今天有点累」）、
对话里的寒暄与助手说的话、用户没表达过的推测。
**宁缺毋滥**：一条都提炼不出来就返回空数组，这是完全正常的输出。

合并规则（重要）：
- 新信息与某条现有记忆是同一件事 → 用 update 并带上那条的 id，把内容改写成合并后的完整表述
- 新信息与现有记忆矛盾 → 用 update 带上 id，以用户本次说法为准
- 用户明确表示某条不再成立 → 用 delete 带上 id
- 与现有记忆完全重复 → 什么都不要输出
- 确实是全新的信息 → 用 add

内容写法：一句话、完整、自洽、脱离对话上下文也能读懂；不要写「用户说」「他提到」这类转述壳子；
单条不超过 60 个字。

只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"ops":[{"op":"add","memType":"constraint","topic":"膝盖","content":"膝盖不适，深蹲不宜超过 60kg","confidence":0.9}]}
update 与 delete 必须带 "id"。没有可记的就输出 {"ops":[]}。`
}

function userPrompt(turns: ChatTurn[], existing: KbMemory[]): string {
  const convo = turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text.trim().slice(0, 1500)}`)
    .join('\n')

  const mem = existing.length
    ? existing
        .map((m) => `id=${m.id} [${m.memType}]${m.topic ? `(${m.topic})` : ''} ${m.content}`)
        .join('\n')
    : '（暂无）'

  return `【现有记忆】\n${mem}\n\n【刚结束的对话】\n${convo}\n\n请输出 JSON。`
}

/** 从模型输出里取 JSON 对象（可能被 markdown 代码块或解释文字包裹）。 */
function extractJsonObject(raw: string): unknown {
  const t = raw.trim()
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : t).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  return JSON.parse(body.slice(start, end + 1))
}

/** 校验并收敛模型输出：丢弃形状不对的条目，而不是让坏数据进库。 */
export function toCandidates(raw: string, maxOps = MAX_OPS): MemoryCandidate[] {
  const parsed = extractJsonObject(raw) as { ops?: unknown }
  if (!Array.isArray(parsed.ops)) return []

  const out: MemoryCandidate[] = []
  for (const item of parsed.ops) {
    if (out.length >= maxOps) break
    const o = item as Record<string, unknown>
    const op = String(o.op ?? '')
    if (op !== 'add' && op !== 'update' && op !== 'delete') continue

    if (op === 'delete') {
      const id = Number(o.id)
      if (Number.isFinite(id)) out.push({ op: 'delete', id })
      continue
    }

    const content = String(o.content ?? '').trim().slice(0, 200)
    if (!content) continue
    const memType = MEMORY_TYPES.includes(o.memType as KbMemoryType)
      ? (o.memType as KbMemoryType)
      : 'preference'
    const topic = String(o.topic ?? '').trim().slice(0, 40)
    const conf = Number(o.confidence)
    const candidate: MemoryCandidate = {
      op,
      memType,
      topic,
      content,
      confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : undefined,
    }
    if (op === 'update') {
      const id = Number(o.id)
      // update 没有 id 是无意义的（不知道该改哪条），丢弃而不是猜
      if (!Number.isFinite(id)) continue
      candidate.id = id
    }
    out.push(candidate)
  }
  return out
}

export interface ExtractMemoriesInput {
  config: AiModel
  /** 本次会话的可见轮次（通常取最近若干条） */
  turns: ChatTurn[]
  /** 现有记忆，让模型直接做合并决策 */
  existing: KbMemory[]
}

/**
 * 跑一次记忆抽取。失败不应影响对话，所以调用方要吞掉异常（见 stores/ai.ts）。
 * 轮次太少或没有用户发言时直接跳过，省掉一次无意义的模型调用。
 */
export async function extractMemories(input: ExtractMemoriesInput): Promise<MemoryCandidate[]> {
  const userTurns = input.turns.filter((t) => t.role === 'user' && t.text.trim())
  if (userTurns.length === 0) return []

  const { models, byId } = buildRuntime([input.config])
  const entry = byId.get(input.config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(),
      model: entry.model,
      thinkingLevel: 'off',
      // 抽取是纯文本变形，不需要任何工具；挂工具反而会诱使模型去查数据
      tools: [],
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  await agent.prompt(userPrompt(input.turns, input.existing), undefined)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  return toCandidates(raw ?? '')
}

/** 与 Rust 侧 MEMORY_TYPES 对应的中文标签，供 UI 展示。 */
export const MEMORY_TYPE_LABELS: Record<KbMemoryType, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}
