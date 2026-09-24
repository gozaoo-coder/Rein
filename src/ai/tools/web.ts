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
      '用必应搜索网页，返回搜索结果转成的纯文本（含标题与摘要）。用户问到应用内数据之外的事实、营养数据、菜谱做法、最新信息时调用；拿到页面地址后再用 web_fetch 读全文。',
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
      '抓取任意 http/https 页面并转成纯文本。用于阅读 web_search 找到的具体页面全文、或用户给出的网址内容。',
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
