/** 第三方健康数据 IPC 封装 · 对应 modules/healthsync/commands.rs */

import type {
  HealthCategoryKey,
  HealthMetricSeries,
  HealthSyncStatus,
  HealthSyncStep,
} from '@/types'
import { invoke } from './transport'

export const healthSyncService = {
  /** 平台 / 授权（含分组）/ 开关 / 计数快照。顺带让原生侧重算一遍授权。 */
  status: () => invoke<HealthSyncStatus>('health_sync_status'),

  /**
   * 拉起 Health Connect 的授权页。
   * `mode` 决定这次要哪些权限：'read' 全部读权限，'write' 连写权限一起要
   * （只有开了「回写 HC」才需要），分组 key 只要那一组（按组引导补授权）。
   * 注意这不是系统运行时权限弹窗 —— HC 的权限只能在它自己的界面上授予，
   * 弹完之后回来调 `status()` 才看得到结果。
   */
  authorize: (mode: 'read' | 'write' | HealthCategoryKey) =>
    invoke<void>('health_sync_authorize', { mode }),

  /** 开关「把本地记录回写进 Health Connect」 */
  setPush: (enabled: boolean) => invoke<void>('health_sync_set_push', { enabled }),

  /** 起一轮同步（不阻塞）。返回 pending 表示已让原生侧去读，接着轮询 `step`。 */
  start: (push: boolean, maxHr: number | null, utcOffsetSeconds: number) =>
    invoke<HealthSyncStep>('health_sync_start', { push, maxHr, utcOffsetSeconds }),

  /** 推进一步。相位不再是 pending 时结束轮询。 */
  step: () => invoke<HealthSyncStep>('health_sync_step'),

  /** 健康数据查询：每个指标的镜像序列（90 天窗口全量，预览与详情共用） */
  metrics: () => invoke<HealthMetricSeries[]>('health_metrics_all'),
}
