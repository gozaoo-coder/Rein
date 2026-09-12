/**
 * 分享收件箱运行时：把系统分享/打开的文件接进 AI 聊天。
 *
 * 双通道感知（文件本体由 Kotlin ShareReceiver 落在 Rust 可读的收件箱）：
 * - 启动 poll 一次：覆盖冷启动即带 intent 的场景（页面未就绪时事件会丢）；
 * - 运行中收 Kotlin evaluateJavascript 派发的 `rein-share` 事件后再 poll：
 *   覆盖 singleTask onNewIntent（应用在后台被分享唤起）场景。
 * 取到的文件暂存 pending 并路由到 /ai?intent=share，AIPage 消费预填
 * （takePending 一次性取走）。
 */

import { router } from '@/router'
import { shareService, type SharedFileMeta } from '@/services/shareService'

export interface PendingShare {
  name: string
  mime: string
  /** 文件内容 base64（无 data: 前缀） */
  base64: string
}

let pending: PendingShare | null = null
let initialized = false
/** poll 进行中标记：事件与启动轮询并发时去重 */
let polling = false

export const shareInbox = {
  /** main.ts 启动时调用一次：挂事件监听 + 首轮 poll */
  init(): void {
    if (initialized) return
    initialized = true
    window.addEventListener('rein-share', () => void takeAndRoute())
    void takeAndRoute()
  },

  /** AIPage 消费：取出待预填文件（一次性，取后即清） */
  takePending(): PendingShare | null {
    const p = pending
    pending = null
    return p
  },
}

async function takeAndRoute(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const list = await shareService.sharePoll()
    const first: SharedFileMeta | undefined = list[0]
    if (!first) return
    const data = await shareService.shareRead(first.file)
    pending = { name: data.name, mime: data.mime, base64: data.dataBase64 }
    // 已在 AI 页时 query 不变不会触发页面 watch：先跳走再跳回（hash 路由轻量）
    const target = { path: '/ai', query: { intent: 'share' } }
    if (router.currentRoute.value.path === '/ai' && router.currentRoute.value.query.intent === 'share') {
      await router.replace({ path: '/ai', query: {} })
    }
    await router.push(target)
  } catch {
    /* 非 Tauri 环境 / 收件箱为空 / 读取失败：静默 */
  } finally {
    polling = false
  }
}
