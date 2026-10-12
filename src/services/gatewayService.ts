/** 外部访问（对外服务网关）管理面 IPC 封装 · 对应 modules/gateway/commands.rs。
 *
 * 除 6 条管理命令外，还负责把 Rust 的 2 个事件桥接成订阅回调：
 * - Tauri 环境：@tauri-apps/api/event listen；
 * - 浏览器 mock：mock/server.ts 的 mockGateway 挂钩（伪造授权请求 / 状态变更）。
 * 事件名字符串严格照抄 Rust 常量（contract §4.5），一个字符都不改。 */

import type { GatewayAuthDecision, GatewayAuthRequest, GatewayBindMode, GatewayStatus } from '@/types'
import { invoke, isTauri } from './transport'

type AuthRequestListener = (e: GatewayAuthRequest) => void
type StatusListener = (s: GatewayStatus) => void

const requiredListeners = new Set<AuthRequestListener>()
const changedListeners = new Set<StatusListener>()
let bridged = false

function dispatchRequired(e: GatewayAuthRequest): void {
  for (const l of requiredListeners) l(e)
}

function dispatchChanged(s: GatewayStatus): void {
  for (const l of changedListeners) l(s)
}

async function bridgeEvents(): Promise<void> {
  if (bridged) return
  bridged = true
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<GatewayAuthRequest>('gateway://authorization-required', (e) => dispatchRequired(e.payload))
    await listen<GatewayStatus>('gateway://authorization-changed', (e) => dispatchChanged(e.payload))
    return
  }
  const { mockGateway } = await import('@/mock/server')
  mockGateway.onRequired = dispatchRequired as (e: unknown) => void
  mockGateway.onChanged = dispatchChanged as (s: unknown) => void
}

export const gatewayService = {
  /* ---- 事件订阅（授权弹窗与设置页各自订一份） ---- */

  /** 订阅「有新的授权请求待裁决」；返回取消订阅函数。 */
  async onAuthorizationRequired(cb: AuthRequestListener): Promise<() => void> {
    await bridgeEvents()
    requiredListeners.add(cb)
    return () => requiredListeners.delete(cb)
  },

  /** 订阅「服务状态变了」（开关 / 绑定 / 授权 / 撤销后各来一发）；返回取消订阅函数。 */
  async onAuthorizationChanged(cb: StatusListener): Promise<() => void> {
    await bridgeEvents()
    changedListeners.add(cb)
    return () => changedListeners.delete(cb)
  },

  /* ---- 管理面命令 ---- */

  /** 服务状态：开关 / 绑定模式 / 端口 / 待决数 / 已授权客户端列表。 */
  status: () => invoke<GatewayStatus>('gateway_status', {}),

  /** 开 / 关服务；开启时按当前绑定设置监听，返回的状态里是**实际**端口。 */
  setEnabled: (enabled: boolean) => invoke<GatewayStatus>('gateway_set_enabled', { enabled }),

  /** 设置绑定模式与端口（port 传 null = 用默认端口起，被占则顺延并把实际端口写回）。 */
  setBind: (bindMode: GatewayBindMode, port: number | null) =>
    invoke<GatewayStatus>('gateway_set_bind', { bindMode, port }),

  /** 冷启动补漏：所有尚未裁决的授权请求。 */
  authorizationPending: () => invoke<GatewayAuthRequest[]>('gateway_authorization_pending', {}),

  /** 回传用户裁决；成功返回空对象。 */
  authorizationRespond: (requestId: string, decision: GatewayAuthDecision, scopes: string[]) =>
    invoke<Record<string, never>>('gateway_authorization_respond', { requestId, decision, scopes }),

  /** 撤销某个客户端的授权（allow 行置撤销位、deny 行删行，两情形都清活动会话授权）。 */
  revokeClient: (clientId: string) => invoke<GatewayStatus>('gateway_revoke_client', { clientId }),
}
