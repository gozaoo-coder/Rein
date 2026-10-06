/** 记忆工具：查看 / 显式记住 / 忘掉长期记忆 · 对应 kbService */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import type { KbMemory, KbMemoryType } from '@/types'
import { defineTool, type AppTool } from './types'

const MEMORY_TYPES: KbMemoryType[] = [
  'preference',
  'constraint',
  'event',
  'entity',
  'profile',
  'pattern',
]

const TYPE_ENUM = Type.Optional(
  Type.Union(
    MEMORY_TYPES.map((t) => Type.Literal(t)),
    {
      description:
        '记忆类型：preference=偏好（喜欢/讨厌）、constraint=约束（伤病/禁忌/时间限制）、event=事件（做过什么及其原因）、entity=实体（人/地点/器械/课程）、profile=稳定画像（作息/经验水平）、pattern=反复出现的规律。不传默认 preference',
    },
  ),
)

/** 只回给模型看的投影：带 id 便于后续 forget，内容截断防撑上下文 */
function brief(m: KbMemory) {
  return {
    id: m.id,
    type: m.memType,
    topic: m.topic || undefined,
    content: m.content.slice(0, 200),
    confidence: Number(m.confidence.toFixed(2)),
  }
}

export const memoryTools: AppTool[] = [
  defineTool({
    name: 'list_memories',
    group: 'memory',
    label: '查看长期记忆',
    description:
      '列出已经记住的关于用户的长期记忆（偏好、约束、事件、实体、画像、规律）。' +
      '用户问「你记得我什么」「你了解我哪些」时调用。系统提示词里已经带了最相关的若干条，所以一般不必先调它。',
    parameters: Type.Object({
      memType: TYPE_ENUM,
    }),
    async execute(args) {
      const items = await kbService.memories(args.memType as KbMemoryType | undefined)
      return {
        total: items.length,
        items: items.slice(0, 50).map(brief),
      }
    },
  }),

  defineTool({
    name: 'remember',
    group: 'memory',
    label: '记住一件事',
    description:
      '把一条关于用户的长期信息写进记忆。**仅当用户明确要求记住时调用**（如「记住我不吃香菜」）；' +
      '日常对话里的偏好由系统在会话结束时自动提炼，不要主动调用本工具刷记忆。',
    parameters: Type.Object({
      content: Type.String({
        description: '要记住的内容，写成一句完整、自洽、脱离上下文也能读懂的话，如「膝盖不适，深蹲不宜超过 60kg」',
      }),
      memType: TYPE_ENUM,
      topic: Type.Optional(Type.String({ description: '主题短标签，如「膝盖」「饮食」，便于分组与去重' })),
    }),
    async execute(args) {
      const content = args.content.trim()
      if (!content) throw new Error('要记住的内容不能为空')
      const r = await kbService.memoryApply([
        {
          op: 'add',
          memType: (args.memType as KbMemoryType | undefined) ?? 'preference',
          topic: args.topic?.trim() ?? '',
          content,
        },
      ])
      // skipped 表示已存在同一条，不是失败
      return r.added > 0
        ? { ok: true, message: `已记住：${content}` }
        : { ok: true, message: `这条已经记过了：${content}` }
    },
  }),

  defineTool({
    name: 'edit_memory',
    group: 'memory',
    label: '修改记忆',
    description:
      '修改一条已有长期记忆的内容/主题/类型（先 list_memories 拿 id）。' +
      '用户说「我改主意了/这条不对/更新一下」时用它；只传要改的字段。',
    parameters: Type.Object({
      memoryId: Type.Number({ description: 'list_memories 返回的 id' }),
      content: Type.Optional(Type.String({ description: '改后的内容（一句话、自洽）' })),
      topic: Type.Optional(Type.String({ description: '改后的主题短标签' })),
      memType: TYPE_ENUM,
    }),
    async execute(args) {
      const patch: { op: 'update'; id: number; memType?: KbMemoryType; topic?: string; content?: string } = {
        op: 'update',
        id: args.memoryId,
      }
      if (args.memType) patch.memType = args.memType
      if (args.topic?.trim()) patch.topic = args.topic.trim()
      if (args.content?.trim()) patch.content = args.content.trim()
      if (!patch.memType && !patch.topic && !patch.content) {
        throw new Error('没有要修改的字段：content / topic / memType 至少传一个')
      }
      const r = await kbService.memoryApply([patch])
      if (r.updated === 0) {
        throw new Error(`记忆不存在：id=${args.memoryId}（先用 list_memories 查 id）`)
      }
      return { ok: true, message: '已更新该条记忆' }
    },
  }),

  defineTool({
    name: 'forget',
    group: 'memory',
    label: '忘掉一条记忆',
    description:
      '按 id 删除一条长期记忆。**仅当用户明确要求忘掉/删掉某条记忆时调用**，先用 list_memories 拿到 id。',
    parameters: Type.Object({
      memoryId: Type.Number({ description: 'list_memories 返回的 id' }),
    }),
    dangerous: true,
    async execute(args) {
      const ok = await kbService.memoryDelete(args.memoryId)
      if (!ok) {
        throw new Error(`记忆不存在：id=${args.memoryId}（先用 list_memories 查 id）`)
      }
      return { ok: true, message: '已删除该条记忆' }
    },
  }),
]
