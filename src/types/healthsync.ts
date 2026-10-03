/**
 * 第三方健康数据域类型 · 与 Rust `modules/healthsync` 对应。
 *
 * 这一域自己不落新表：导入的运动记录就写进 `workouts`（靠 `source` 区分本地/导入），
 * 所以这里只有「同步状态」与「一次同步的回执」两组类型。
 */

/**
 * Health Connect 在本机的可用性。
 * `unknown` = 原生侧还没算完（授权状态要问 HC 的 binder，是异步写出来的），
 * 别把它当成「不可用」—— 对用户而言那是两句话。
 */
export type HealthAvailability = 'available' | 'unavailable' | 'update_required' | 'unknown'

export interface HealthSyncStatus {
  /** 当前平台是否可能支持（桌面端恒 false） */
  supported: boolean
  availability: HealthAvailability
  /** Rein 是否已拿到读授权（在 Health Connect 界面上授予的） */
  readGranted: boolean
  /** 是否已拿到写授权（只有开了「回写 HC」才需要） */
  writeGranted: boolean
  /** 是否把本地记录回写进 Health Connect */
  pushEnabled: boolean
  lastSyncAt: string | null
  /** 已导入的镜像记录数 */
  importedCount: number
  /** 已导出到 HC 的本地记录数 */
  exportedCount: number
}

/** 一次同步的进度相位：前端按 `pending` 继续轮询，其余都是终态 */
export type HealthSyncPhase =
  | 'unsupported'
  | 'unavailable'
  | 'needs_auth'
  | 'idle'
  | 'pending'
  | 'done'
  | 'error'

/** 一次同步做了什么（`done` 时回执才有值） */
export interface HealthSyncReport {
  /** HC → Rein：新导入 */
  imported: number
  /** HC → Rein：按 HC 侧变更覆盖 */
  updated: number
  /** HC → Rein：HC 里已删除，本地镜像跟着收掉 */
  removed: number
  /** Rein → HC：本地记录新导出 */
  exported: number
  /** Rein → HC：导出过的记录内容变了，重写 */
  reExported: number
  /** Rein → HC：删除本地记录时收掉的 HC 副本 */
  unexported: number
  /** Rein → HC：没有开始时间、在 HC 里无处安放的记录 */
  skipped: number
  /** 读到的 HC 记录总数（含未变化的） */
  scanned: number
  /** 本轮是否跑了导出方向 */
  pushed: boolean
}

export interface HealthSyncStep {
  phase: HealthSyncPhase
  report: HealthSyncReport | null
  message: string | null
}
