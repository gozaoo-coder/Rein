/**
 * 记忆整理（“做梦”）：把整个记忆库拿出来做一次全局去噪与重组。
 *
 * 与抽取的分工：抽取是「会话结束时往库里增量写」，只看得到最近一段对话；
 * 整理是「定期把整个库看一遍」，做抽取做不了的四件事——
 * 合并跨会话重复/重叠的条目、把零散分类收敛成统一层级、把过时或琐碎的噪声归档、
 * 把归档区里确认无价值的条目永久清掉（或把被误判的复活）。
 *
 * 与抽取一样，编排在前端（模型请求由 WebView 直连 provider，Rust 不调模型），
 * 落库复用同一条 `kb_memory_apply`（多支持一个 archive 操作）。
 * 触发与节流见 stores/ai.ts 的 scheduleMemoryConsolidation（每天最多一次）。
 */

import type { AiModel, KbMemory, MemoryCandidate } from '@/types'
import { lastAssistantText } from './json'
import { buildRuntime } from './runtime'
import { toCandidates } from './memoryExtract'

/** 单次整理允许的最大变更条数。整理只该动少数条目，开太大反而容易误伤。 */
const MAX_OPS = 16
/** 送给模型的记忆清单上限（活跃在前、归档在后）。 */
const MAX_INPUT = 160

function systemPrompt(): string {
  return `你是 Rein 健康应用的长期记忆整理器。任务：对**整个记忆库**做一次谨慎的去噪与重组，让它更小、更准、更有条理。

你可以做五件事：
1. 合并：两条记忆说的是同一件事（措辞不同、详略不同、跨会话重复抽取）→ 用 update 把信息最全的表述写到信息量最大的那条上，其余用 delete 删掉。宁保留细节，不丢事实。
2. 归类：给条目补上统一的 category（1~2 层「大类/小类」路径，如 健康/训练、饮食/禁忌）。同义分类必须收敛成一个（如「训练」「健身」→「健康/训练」）。
3. 校准：confidence 明显与实际不符时改掉（含糊推测调低、明确确认过的调高）。
4. 归档：明确过时（如已放弃的目标）、被后续记忆取代、或纯属一次性的琐碎信息 → 用 archive 并给 reason（outdated / superseded / noise）。
5. 清理归档区：标了 [已归档] 的条目，确认永远不会再用 → delete 永久删除；如果其实还有价值（当时被误判）→ update 复活。

硬约束：
- 不许发明新事实，不许把两条不相干的信息拼成一条。
- 拿不准的条目保持原样，能不动就不动；整库健康时输出 {"ops":[]} 完全正常。
- 最多输出 ${MAX_OPS} 个操作，优先做合并与归档，其次是归类。
- archive 是软删除、可以后悔；delete 是永久删除，只对「确认无价值」的条目用。

输出格式（唯一 JSON 对象，不要 markdown、不要解释）：
{"ops":[{"op":"update","id":3,"memType":"constraint","topic":"膝盖","category":"健康/训练","content":"...","confidence":0.9},{"op":"delete","id":7},{"op":"archive","id":12,"reason":"outdated"}]}`
}

function userPrompt(memories: KbMemory[]): string {
  const lines = memories.slice(0, MAX_INPUT).map((m) =>
    [
      `id=${m.id}`,
      `[${m.memType}]`,
      m.topic ? `(${m.topic})` : '',
      m.category ? `{${m.category}}` : '',
      m.archivedAt ? '[已归档]' : '',
      m.content,
      `置信度 ${m.confidence.toFixed(2)}`,
      `显著性 ${m.salience.toFixed(2)}`,
      `注入 ${m.activeCount} 次`,
      `更新于 ${m.updatedAt.slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join(' '),
  )
  const categories = [...new Set(memories.map((m) => m.category).filter(Boolean))]
  return `【现有分类】${categories.length ? categories.join('、') : '（暂无）'}
【记忆库】共 ${memories.length} 条${memories.length > MAX_INPUT ? `（只展示前 ${MAX_INPUT} 条）` : ''}
${lines.join('\n')}

请输出整理操作 JSON。`
}

export interface ConsolidateMemoriesInput {
  config: AiModel
  /** 全量记忆（活跃 + 归档），顺序即优先级 */
  memories: KbMemory[]
}

/**
 * 跑一次整库整理。失败不应影响对话，所以调用方要吞掉异常（见 stores/ai.ts）。
 * 记忆太少（< 4 条）时跳过：没什么可合并的，不值得一次模型调用。
 */
export async function consolidateMemories(
  input: ConsolidateMemoriesInput,
): Promise<MemoryCandidate[]> {
  if (input.memories.length < 4) return []

  const { models, byId } = buildRuntime([input.config])
  const entry = byId.get(input.config.id)
  if (!entry) throw new Error('模型运行时构建失败')

  const { Agent } = await import('@earendil-works/pi-agent-core')
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(),
      model: entry.model,
      thinkingLevel: 'off',
      // 整理是纯文本变形，不需要任何工具
      tools: [],
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  })

  await agent.prompt(userPrompt(input.memories), undefined)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  return toCandidates(raw ?? '', { maxOps: MAX_OPS, allowArchive: true })
}
