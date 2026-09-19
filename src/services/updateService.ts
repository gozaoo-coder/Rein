/**
 * 更新域 IPC 封装 · 对应 Rust `modules/update/commands.rs`。
 *
 * 下载进度是事件驱动（`update://progress`），但事件可能丢（页面刚挂载、
 * App 被系统挂起过），所以除了订阅还提供一次 `progress()` 兜底拉取。
 */
import type {
  DownloadState,
  InstallResult,
  OnlineServiceStatus,
  UpdateCheck,
  UpdateSettingsPatch,
  UpdateSnapshot,
} from '@/types'
import { invoke, isTauri } from './transport'

/** 进度事件名（与 Rust `PROGRESS_EVENT` 必须一致） */
export const UPDATE_PROGRESS_EVENT = 'update://progress'

export const updateService = {
  status: () => invoke<UpdateSnapshot>('update_status'),

  saveSettings: (patch: UpdateSettingsPatch) => invoke<UpdateSnapshot>('update_settings_set', { patch }),

  check: (force = false) => invoke<UpdateCheck>('update_check', { force }),

  download: () => invoke<DownloadState>('update_download'),

  cancel: () => invoke<boolean>('update_cancel'),

  discard: () => invoke<void>('update_discard'),

  install: () => invoke<InstallResult>('update_install'),

  progress: () => invoke<DownloadState>('update_progress'),

  /** 清理下载目录里与本候选无关的残留，返回释放的字节数 */
  pruneCache: () => invoke<number>('update_prune_cache'),

  /** 探测 Rein 在线服务（更新源之外的能力：模型网关等） */
  onlineServiceStatus: (baseUrl?: string) =>
    invoke<OnlineServiceStatus>('online_service_status', { baseUrl: baseUrl ?? null }),
}

/**
 * 订阅下载进度。返回退订函数。
 *
 * 两个细节都不能省：
 * - `listen` 是**动态** import 的（与 campus/voice 同款）：事件模块没必要进主包，
 *   静态引入会让首屏多背一份代码。
 * - `listen` 是异步的：组件在它 resolve 之前就卸载时，必须把已经建好的监听补一次
 *   退订，否则会留下一个永远不会被清理的监听器（切页面几次就开始漏）。
 */
export function onUpdateProgress(cb: (state: DownloadState) => void): () => void {
  if (!isTauri) return () => {}
  let disposed = false
  let unlisten: (() => void) | null = null
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<DownloadState>(UPDATE_PROGRESS_EVENT, (event) => cb(event.payload)))
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}
