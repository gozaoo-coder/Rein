/**
 * 数据维护域 IPC 封装 · 对应 Rust `modules/maintenance/commands.rs`。
 *
 * `clear` 不可撤销；「清完自动重启」不是这里的职责——报告先回给 UI toast 完，
 * 再由 UI 主动调 `restart()`（与 update_install「先回包再退进程」同一条时序纪律）。
 */
import type { DataClearPreview, DataClearReport, DataClearScope } from '@/types'
import { invoke } from './transport'

export const maintenanceService = {
  /** 某档会清什么：每组的行数与字节，给确认页当清单 */
  preview: (scope: DataClearScope) => invoke<DataClearPreview>('data_clear_preview', { scope }),

  /** 执行清除（不可撤销） */
  clear: (scope: DataClearScope) => invoke<DataClearReport>('data_clear', { scope }),

  /** 清除完成后的应用重启（深层档的收尾一步） */
  restart: () => invoke<void>('data_app_restart'),
}
