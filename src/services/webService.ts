/** Web 抓取域 IPC 封装 · 命令名与 src-tauri/src/modules/web/commands.rs 一一对应。
 *  真实抓取在 Rust 侧完成（WebView 内 JS fetch 会被 CORS 拦），默认搜索引擎为必应。 */

import { invoke } from './transport'

export interface WebFetchResult {
  /** 实际抓取到的最终地址（请求重定向后） */
  url: string
  /** Rust 侧 `WebFetchResult.content_type` 序列化后的键（camelCase） */
  contentType: string
  /** HTML 转纯文本后的正文（已按 maxChars 截断） */
  text: string
  truncated: boolean
  chars: number
}

export const webService = {
  /** 抓取任意 http/https 页面并转纯文本 */
  webFetch: (url: string, maxChars?: number) =>
    invoke<WebFetchResult>('web_fetch', { url, maxChars: maxChars ?? null }),

  /** 网络搜索（默认必应），返回搜索结果页转文本 */
  webSearch: (query: string, maxChars?: number) =>
    invoke<WebFetchResult>('web_search', { query, maxChars: maxChars ?? null }),
}
