import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** 是否运行在 Tauri（桌面端）环境。浏览器直连 vite 时为 false。 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 全应用唯一 IPC 出口。
 * - Tauri 环境：转发给 Rust 后端
 * - 纯浏览器开发：转发到内存 mock（src/mock/server.ts），便于 UI 迭代与截图测试
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args ?? {})
  const { mockInvoke } = await import('@/mock/server')
  return mockInvoke<T>(cmd, args ?? {})
}

/** 后端不可用 / 命令失败时统一抛出的错误 */
export class IpcError extends Error {
  constructor(
    public cmd: string,
    message: string,
  ) {
    super(`[${cmd}] ${message}`)
    this.name = 'IpcError'
  }
}
