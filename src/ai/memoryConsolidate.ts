/**
 * 记忆整理（“做梦”）：把整个记忆库拿出来做一次全局去噪与重组。
 *
 * 与抽取的分工：抽取是「会话结束时往库里增量写」，只看得到最近一段对话；
 * 整理是「定期把整个库看一遍」，做抽取做不了的五件事——
 * 合并跨会话重复/重叠的条目、把零散分类收敛成统一层级、校准置信度、
 * 把过时或琐碎的噪声归档、把归档区里确认无价值的条目永久清掉（或把被误判的复活）。
 *
 * 与抽取一样，编排在前端（模型请求由 Rust 内核发起，落库复用同一条 `kb_memory_apply`）。
 * 触发与节流见 stores/ai.ts 的 scheduleMemoryConsolidation（每天最多一次）。
 *
 * **分批（2026-10-07 起）**：记忆库可能远大于单次 prompt 的合理规模，
 * 「只取前 N 条」的老做法会让尾部记忆永远没人整理。现在按批次窗口轮转，
 * 每批处理完**立即落库**（下一批看到整理后的库，不会与前一批的改动打架），
 * 单次最多跑 [`CONSOLIDATE_MAX_BATCHES`] 批，游标由调用方带回，下次从断点继续。
 *
 * **向量查重提示**：模型对「哪两条在说同一件事」的判断远不如向量稳。
 * 调用方用 `kb_memory_duplicates`（本地余弦，零模型成本）拿到疑似重复对，
 * 作为「重点怀疑对象」写进 prompt —— 合并的召回率与准确率都因此上来了。
 */

import type { AiModel, KbMemory, KbMemoryDuplicate, MemoryCandidate } from '@/types'
import { lastAssistantText } from './json'
import { RustAgent } from './rustAgent'
import { toCandidates } from './memoryExtract'

/** 单批允许的最大变更条数。整理只该动少数条目，开太大反而容易误伤。 */
const MAX_OPS_PER_BATCH = 12
/** 一批送给模型的记忆条数。 */
const BATCH_SIZE = 80
/** 单次整理最多跑几批（覆盖全库轮转，不至于一次调用十几轮）。 */
const MAX_BATCHES = 3
/** 每批写入 prompt 的疑似重复对上限（只给最像的那些）。 */
const MAX_DUP_HINTS = 12

function systemPrompt(): string {
  return `你是 Rein 健康应用的长期记忆整理器。任务：对**这一批记忆**做一次谨慎的去噪与重组，让它更小、更准、更有条理。

你可以做五件事：
1. 合并：两条记忆说的是同一件事（措辞不同、详略不同、跨会话重复抽取）→ 用 update 把信息最全的表述写到信息量最大的那条上，其余用 delete 删掉。宁保留细节，不丢事实。
2. 归类：给条目补上统一的 category（1~2 层「大类/小类」路径，如 健康/训练、饮食/禁忌）。同义分类必须收敛成一个（如「训练」「健身」→「健康/训练」）。
3. 校准：confidence 明显与实际不符时改掉（含糊推测调低、明确确认过的调高）。
4. 归档：明确过时（如已放弃的目标）、被后续记忆取代、或纯属一次性的琐碎信息 → 用 archive 并给 reason（outdated / superseded / noise）。
5. 清理归档区：标了 [已归档] 的条目，确认永远不会再用 → delete 永久删除；如果其实还有价值（当时被误判）→ update 复活。

硬约束：
- 不许发明新事实，不许把两条不相干的信息拼成一条。
- 拿不准的条目保持原样，能不动就不动；整批健康时输出 {"ops":[]} 完全正常。
- 最多输出 ${MAX_OPS_PER_BATCH} 个操作，优先做合并与归档，其次是归类。
- archive 是软删除、可以后悔；delete 是永久删除，只对「确认无价值」的条目用。
- 只处理本批清单里的 id，不要提及其他 id。

输出格式（唯一 JSON 对象，不要 markdown、不要解释）：
{"ops":[{"op":"update","id":3,"memType":"constraint","topic":"膝盖","category":"健康/训练","content":"...","confidence":0.9},{"op":"delete","id":7},{"op":"archive","id":12,"reason":"outdated"}]}`
}

function userPrompt(
  batch: KbMemory[],
  dups: KbMemoryDuplicate[],
  batchNo: number,
  batches: number,
): string {
  const lines = batch.map((m) =>
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
  const categories = [...new Set(batch.map((m) => m.category).filter(Boolean))]
  const dupBlock = dups.length
    ? `
【疑似重复对（本地向量算出，重点核对；向量也会错，拿不准就别动）】
${dups
  .map(
    (d) =>
      `- #${d.aId} ↔ #${d.bId}（相似度 ${d.score.toFixed(2)}）：${d.aContent} ｜ ${d.bContent}`,
  )
  .join('\n')}
`
    : ''
  return `【现有分类】${categories.length ? categories.join('、') : '（暂无）'}
【本批记忆】第 ${batchNo}/${batches} 批，共 ${batch.length} 条
${lines.join('\n')}
${dupBlock}
请输出整理操作 JSON。`
}

export interface ConsolidateMemoriesInput {
  config: AiModel
  /** 全量记忆（活跃 + 归档），顺序即优先级 */
  memories: KbMemory[]
  /** 疑似重复对（kbService.memoryDuplicates 的结果；keyword 模式为空） */
  duplicates?: KbMemoryDuplicate[]
  /** 分批游标：从第几条开始取窗口（循环取模，保证尾部也会被整理到） */
  offset?: number
}

export interface ConsolidateBatchResult {
  candidates: MemoryCandidate[]
  /** 本批处理的条数 */
  size: number
  /** 下一个游标（调用方存起来，下次从这里继续） */
  nextOffset: number
  /**
   * 本批**已经覆盖整个记忆库** → 调用方直接收工，不要再跑下一批。
   *
   * 用这个布尔量而不是让调用方拿 `size` 跟库长度比：那正是上一版把终止条件
   * 写反的地方（`size < 总数` 在库 > 一批时第一轮就 break，永远只跑一批）。
   */
  coveredAll: boolean
}

/**
 * 选出本批要送给模型的记忆：从 `offset` 开始循环取 [`BATCH_SIZE`] 条。
 *
 * 循环取模（而不是简单切片）是为了让**库尾部的记忆也有机会被整理**：
 * 库大于一批时，"永远只看得到头部" 是最常见的疏漏。
 */
export function pickBatch(
  memories: KbMemory[],
  offset: number,
): { batch: KbMemory[]; nextOffset: number } {
  const n = memories.length
  if (n <= BATCH_SIZE) return { batch: memories, nextOffset: 0 }
  const start = ((offset % n) + n) % n
  const batch: KbMemory[] = []
  for (let i = 0; i < BATCH_SIZE; i++) batch.push(memories[(start + i) % n])
  return { batch, nextOffset: (start + BATCH_SIZE) % n }
}

/** 只保留与本批相关的疑似重复对（两条都在批内，或至少一条在）。 */
function relevantDups(dups: KbMemoryDuplicate[], batch: KbMemory[]): KbMemoryDuplicate[] {
  if (!dups.length) return []
  const ids = new Set(batch.map((m) => m.id))
  return dups.filter((d) => ids.has(d.aId) || ids.has(d.bId)).slice(0, MAX_DUP_HINTS)
}

/**
 * 跑**一批**整理。失败不应影响对话，所以调用方要吞掉异常。
 * 记忆太少（< 4 条）时跳过：没什么可合并的，不值得一次模型调用。
 */
export async function consolidateMemories(
  input: ConsolidateMemoriesInput,
): Promise<ConsolidateBatchResult> {
  const { batch, nextOffset } = pickBatch(input.memories, input.offset ?? 0)
  const coveredAll = input.memories.length <= BATCH_SIZE
  if (input.memories.length < 4) {
    return { candidates: [], size: 0, nextOffset: 0, coveredAll: true }
  }

  const dups = relevantDups(input.duplicates ?? [], batch)
  const batches = Math.max(1, Math.ceil(input.memories.length / BATCH_SIZE))
  const batchNo = Math.floor((input.offset ?? 0) / BATCH_SIZE) + 1
  const agent = new RustAgent({
    initialState: {
      systemPrompt: systemPrompt(),
      modelPk: input.config.id,
      thinkingLevel: 'off',
      // 整理是纯文本变形，不需要任何工具
      tools: [],
      messages: [],
    },
  })

  await agent.prompt(userPrompt(batch, dups, batchNo, batches), undefined)
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage)

  const raw = lastAssistantText(agent.state.messages)
  const candidates = toCandidates(raw ?? '', { maxOps: MAX_OPS_PER_BATCH, allowArchive: true })
  return { candidates, size: batch.length, nextOffset, coveredAll }
}

/** 单次整理最多跑几批（供 stores/ai.ts 循环）；导出以免两处写死不一致。 */
export const CONSOLIDATE_MAX_BATCHES = MAX_BATCHES
