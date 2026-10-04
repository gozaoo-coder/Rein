/** Web 域工具：联网搜索（默认必应）与抓取网页 · 对应 webService（Rust 侧抓取，绕开 CORS） */

import { Type } from '@earendil-works/pi-ai'

import { webService } from '@/services/webService'
import { defineTool, type AppTool } from './types'

export const webTools: AppTool[] = [
  defineTool({
    name: 'web_search',
    group: 'web',
    label: '联网搜索',
    description:
      '用必应搜索网页，返回结果列表（每条含标题、可点击的真实链接、摘要）。应用数据之外的事实都先用它查：食物营养与配料表、品牌/连锁餐品规格、菜谱做法与配比、时效性信息、拿不准的名词。关键词写具体（「杨枝甘露 每100g 热量」优于「杨枝甘露」）；拿到链接后用 web_fetch 读正文再下结论。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词，尽量具体（如「可乐 每100g 热量」）' }),
      maxChars: Type.Optional(Type.Number({ description: '最多返回字符数，默认 6000' })),
    }),
    async execute(args) {
      const r = await webService.webSearch(args.query, args.maxChars)
      return { engine: 'bing', url: r.url, text: r.text, truncated: r.truncated }
    },
  }),

  defineTool({
    name: 'web_fetch',
    group: 'web',
    label: '抓取网页',
    description:
      '抓取任意 http/https 页面并转成纯文本。用于阅读 web_search 结果里具体某一条的全文（优先选权威来源：官方营养标签、百科、专业站），或用户给出的网址内容。',
    parameters: Type.Object({
      url: Type.String({ description: '完整网址，如 https://www.example.com/page' }),
      maxChars: Type.Optional(Type.Number({ description: '最多返回字符数，默认 6000' })),
    }),
    async execute(args) {
      const r = await webService.webFetch(args.url, args.maxChars)
      return { url: r.url, contentType: r.contentType, text: r.text, truncated: r.truncated }
    },
  }),
]
