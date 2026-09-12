/** 知识库工具：跨来源的混合检索与分层读取 · 对应 kbService */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import type { KbSourceType } from '@/types'
import { defineTool, type AppTool } from './types'

const SOURCES: KbSourceType[] = [
  'todo',
  'workout',
  'plan',
  'meal',
  'body_metric',
  'food',
  'program',
  'program_meal',
  'voice_memo',
  'chat_message',
  'memory',
]

const SOURCE_ENUM = Type.Optional(
  Type.Array(
    Type.Union(
      SOURCES.map((s) => Type.Literal(s)),
      { description: '限定来源类别：todo=日程/附件、workout=运动、plan=课程、meal=饮食、body_metric=体测、food=自建食物、program=方案、program_meal=方案菜单、voice_memo=语音纪要、chat_message=历史聊天、memory=长期记忆。不传=全部' },
    ),
  ),
)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function optDay(v: string | undefined, field: string): string | undefined {
  const d = v?.trim()
  if (!d) return undefined
  if (!DATE_RE.test(d)) {
    throw new Error(`${field} 格式应为 YYYY-MM-DD，收到「${v}」`)
  }
  return d
}

export const knowledgeTools: AppTool[] = [
  defineTool({
    name: 'search_knowledge',
    group: 'knowledge',
    label: '检索知识库',
    description:
      '在用户的全部应用数据与长期记忆中做跨来源检索（日程与附件、运动记录、训练课程、饮食与体测、健康方案、语音纪要、历史聊天、长期记忆）。' +
      '用户问「我之前/上周/有没有……」「我是不是……」「关于膝盖的记录」这类需要跨来源回忆或找规律的问题时用它。' +
      '返回的是摘要级命中（标题 + 命中片段），要正文再用 read_knowledge。不传 query 表示按日期倒序浏览最近内容。',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            '检索词。建议用 2~6 个字的简短关键词（如「膝盖」「腿部训练」「蛋白质」）；中文两字词也能命中。留空表示按日期倒序浏览最近内容。',
        }),
      ),
      sources: SOURCE_ENUM,
      from: Type.Optional(Type.String({ description: '起始日期 YYYY-MM-DD（含），按内容所属日期过滤' })),
      to: Type.Optional(Type.String({ description: '结束日期 YYYY-MM-DD（含）' })),
      tags: Type.Optional(Type.Array(Type.String({ description: '标签精确匹配，如分类名' }))),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 8，上限 20' })),
    }),
    async execute(args) {
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 8), 1), 20)
      const hits = await kbService.search({
        query: args.query?.trim() ?? '',
        sources: args.sources as KbSourceType[] | undefined,
        from: optDay(args.from, 'from'),
        to: optDay(args.to, 'to'),
        tags: args.tags,
        limit,
      })
      return {
        total: hits.length,
        items: hits.map((h) => ({
          id: h.id,
          path: h.path ?? undefined,
          editable: h.editable,
          source: h.sourceType,
          title: h.title,
          snippet: h.snippet,
          date: h.occurredOn,
          tags: h.tags,
        })),
        hint: hits.length
          ? '要某条的完整内容，用 read_knowledge 传它的 id。'
          : '没有命中。可以换个更短的关键词，或去掉日期/来源限制再试。',
      }
    },
  }),

  defineTool({
    name: 'read_knowledge',
    group: 'knowledge',
    label: '读取知识库条目',
    description:
      '按 search_knowledge 返回的 id 读取完整内容。默认 level=l1 只给摘要与首段（够判断相关性）；' +
      '确实需要全部细节时才用 level=l2。',
    parameters: Type.Object({
      docId: Type.Number({ description: 'search_knowledge 返回的 id' }),
      level: Type.Optional(
        Type.Union([Type.Literal('l1'), Type.Literal('l2')], {
          description: 'l1=概览（摘要+首段，默认）；l2=分块正文（可分页）',
        }),
      ),
      offset: Type.Optional(Type.Number({ description: 'l2 起始块序（从 0 起），默认 0' })),
      limit: Type.Optional(Type.Number({ description: 'l2 最多取几块，默认 8，上限 64' })),
    }),
    async execute(args) {
      const level = args.level === 'l2' ? 'l2' : 'l1'
      const d = await kbService.read(args.docId, level, args.offset, args.limit)
      const nextOffset = d.offset + d.chunks.length
      return {
        id: d.id,
        path: d.path ?? undefined,
        source: d.sourceType,
        editable: d.editable,
        title: d.title,
        date: d.occurredOn,
        tags: d.tags,
        summary: d.summary,
        content: d.chunks.map((c) => c.text.slice(0, level === 'l2' ? 1200 : 300)),
        totalChunks: d.totalChunks,
        offset: d.offset,
        hasMore: d.hasMore,
        // 分页语义：hasMore 时用 nextOffset 继续读，避免一次性倾倒长文撑爆上下文
        nextOffset: d.hasMore ? nextOffset : undefined,
        hint: d.hasMore
          ? `共 ${d.totalChunks} 块，当前到第 ${nextOffset} 块；继续读请传 offset: ${nextOffset}。`
          : undefined,
      }
    },
  }),

  defineTool({
    name: 'glob_knowledge',
    group: 'knowledge',
    label: '按路径列文件',
    description:
      '在知识库的虚拟文件系统里按路径模式列文档（ls）。* 不跨目录、** 跨目录、? 单字符。' +
      '例：笔记/*.md 列全部笔记、对话/**/*.md 列全部对话内容、日程/2026-09-10/*.md 列某天的日程、附件/** 列全部附件编目。' +
      '用户问「有哪些笔记」「我的文件」「某天记了什么」或想按文件名找东西时用它——关键词搜正文用 search_knowledge，按名字找文件用这个。',
    parameters: Type.Object({
      pattern: Type.String({ description: '路径模式，如 笔记/*.md、对话/**、附件/**' }),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 50，上限 200' })),
    }),
    async execute(args) {
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 200)
      const items = await kbService.glob(args.pattern, limit)
      return {
        total: items.length,
        items: items.map((f) => ({
          id: f.id,
          path: f.path,
          source: f.sourceType,
          kind: f.kind,
          editable: f.editable,
          date: f.occurredOn ?? undefined,
          title: f.title,
        })),
        hint: items.length
          ? '要某条的正文用 read_knowledge 传 id；要改某条先看 editable 字段。'
          : '没有匹配的路径。检查目录名（日程/运动/课程/饮食/体测/食物/方案/菜单/纪要/对话/附件/记忆/笔记/规范）或换 * / ** 试。',
      }
    },
  }),
]
