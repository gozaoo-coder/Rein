/** 上下文域工具：跨会话检索全部历史聊天 · 对应 aiService.aiChatSearch */

import { Type } from '@earendil-works/pi-ai'

import { aiService } from '@/services/aiService'
import { defineTool, type AppTool } from './types'

export const contextTools: AppTool[] = [
  defineTool({
    name: 'search_history',
    group: 'context',
    label: '搜索历史聊天',
    description: '跨所有会话搜索 Rein 的全部历史聊天记录。用户问「我之前/上次说过什么」或需要回忆历史内容时调用。',
    parameters: Type.Object({
      keyword: Type.String({ description: '搜索关键词' }),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 8' })),
    }),
    async execute(args) {
      const hits = await aiService.aiChatSearch(args.keyword, Math.min(Math.max(1, args.limit ?? 8), 30))
      return hits.map((h) => ({
        chat: h.chatTitle,
        role: h.role,
        at: h.createdAt,
        text: (h.text ?? '').slice(0, 200),
      }))
    },
  }),
]
