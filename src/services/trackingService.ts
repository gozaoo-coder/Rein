/**
 * 跑步保活（Android 前台定位服务）。
 *
 * 安卓上锁屏后 WebView 的 GPS/计时器会随进程被冻结而停摆，开跑前必须
 * 拉起 location 类型的前台服务；桌面端为空操作，纯浏览器 mock 下命令
 * 不存在——统一吞错降级，不影响无保活环境的正常流程。
 * 契约见 Rust `modules/tracking/commands.rs`。
 */
import { invoke } from './transport'

export interface TrackingStatus {
  /** 定位权限已授予 */
  granted: boolean
  /** 权限弹窗待答或状态尚未同步（false + !granted = 用户明确拒绝） */
  busy: boolean
}

export const trackingService = {
  async setKeepalive(enable: boolean): Promise<void> {
    try {
      await invoke('tracking_keepalive', { enable })
    } catch (e) {
      console.warn('[tracking] 保活命令不可用', e)
    }
  },

  async status(): Promise<TrackingStatus> {
    try {
      return await invoke<TrackingStatus>('tracking_status')
    } catch {
      // 查询不可用：视为已就绪，交回 GPS 自身的失败路径兜底
      return { granted: true, busy: false }
    }
  },
}
