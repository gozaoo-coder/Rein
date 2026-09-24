import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** 是否运行在 Tauri（桌面端）环境。浏览器直连 vite 时为 false。 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 后端错误的统一形态。
 *
 * Rust 侧 `ReinError` 序列化为 `{ code, message }`；这里归一成 Error 子类，
 * 于是既有的 `e instanceof Error ? e.message : String(e)` 全部照旧，
 * 需要分派时看 `code`（如 `session_lost`），**不再解析文案**。
 */
export class IpcError extends Error {
  readonly cmd: string
  readonly code: string

  constructor(cmd: string, message: string, code = 'internal') {
    super(message)
    this.name = 'IpcError'
    this.cmd = cmd
    this.code = code
  }
}

/** 把任意 reject 值归一为 IpcError（mock 的 Error、Rust 的 `{code,message}` 对象、裸字符串都在这兜住）。 */
function toIpcError(cmd: string, raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw
  if (raw !== null && typeof raw === 'object') {
    const o = raw as { message?: unknown; code?: unknown }
    const message = typeof o.message === 'string' ? o.message : String(raw)
    const code = typeof o.code === 'string' ? o.code : 'internal'
    return new IpcError(cmd, message, code)
  }
  return new IpcError(cmd, String(raw))
}

/**
 * 全应用唯一 IPC 出口。
 * - Tauri 环境：转发给 Rust 后端
 * - 纯浏览器开发：转发到内存 mock（src/mock/server.ts），便于 UI 迭代与截图测试
 * - 两条路线的失败都归一为 IpcError 再抛（错误文案一字不改，只是多了 `code`）
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauri) return await tauriInvoke<T>(cmd, args ?? {})
    const { mockInvoke } = await import('@/mock/server')
    return await mockInvoke<T>(cmd, args ?? {})
  } catch (e) {
    throw toIpcError(cmd, e)
  }
}
