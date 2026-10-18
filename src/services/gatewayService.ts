/** 外部访问（对外服务网关）管理面 IPC 封装 · 对应 modules/gateway/commands.rs。
 *
 * 除管理命令外，还负责把 Rust 的事件桥接成订阅回调：
 * - Tauri 环境：@tauri-apps/api/event listen；
 * - 浏览器 mock：mock/server.ts 的 mockGateway 挂钩（伪造授权请求 / 状态变更 / 下行控制）。
 * 事件名字符串严格照抄 Rust 常量（contract §4.5、§14.3），一个字符都不改。 */

import type {
  FocusRuntime,
  GatewayAuditEntry,
  GatewayAuthDecision,
  GatewayAuthRequest,
  GatewayBindMode,
  GatewayPomodoroCommand,
  GatewaySessionCommand,
  GatewayStatus,
} from '@/types'
import { invoke, isTauri } from './transport'

type AuthRequestListener = (e: GatewayAuthRequest) => void
type StatusListener = (s: GatewayStatus) => void
type PomodoroCommandListener = (c: GatewayPomodoroCommand) => void
type SessionCommandListener = (c: GatewaySessionCommand) => void

const requiredListeners = new Set<AuthRequestListener>()
const changedListeners = new Set<StatusListener>()
const pomodoroCommandListeners = new Set<PomodoroCommandListener>()
const sessionCommandListeners = new Set<SessionCommandListener>()
let bridged = false

function dispatchRequired(e: GatewayAuthRequest): void {
  for (const l of requiredListeners) l(e)
}

function dispatchChanged(s: GatewayStatus): void {
  for (const l of changedListeners) l(s)
}

function dispatchPomodoroCommand(c: GatewayPomodoroCommand): void {
  for (const l of pomodoroCommandListeners) l(c)
}

function dispatchSessionCommand(c: GatewaySessionCommand): void {
  for (const l of sessionCommandListeners) l(c)
}

async function bridgeEvents(): Promise<void> {
  if (bridged) return
  bridged = true
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<GatewayAuthRequest>('gateway://authorization-required', (e) => dispatchRequired(e.payload))
    await listen<GatewayStatus>('gateway://authorization-changed', (e) => dispatchChanged(e.payload))
    await listen<GatewayPomodoroCommand>('gateway://pomodoro-command', (e) => dispatchPomodoroCommand(e.payload))
    await listen<GatewaySessionCommand>('gateway://session-command', (e) => dispatchSessionCommand(e.payload))
    return
  }
  const { mockGateway } = await import('@/mock/server')
  mockGateway.onRequired = dispatchRequired as (e: unknown) => void
  mockGateway.onChanged = dispatchChanged as (s: unknown) => void
  mockGateway.onPomodoroCommand = dispatchPomodoroCommand as (c: unknown) => void
  mockGateway.onSessionCommand = dispatchSessionCommand as (c: unknown) => void
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

  /** 订阅外部发来的番茄钟控制（`gateway://pomodoro-command`）；返回取消订阅函数。 */
  async onPomodoroCommand(cb: PomodoroCommandListener): Promise<() => void> {
    await bridgeEvents()
    pomodoroCommandListeners.add(cb)
    return () => pomodoroCommandListeners.delete(cb)
  },

  /** 订阅外部发来的训练课控制（`gateway://session-command`）；返回取消订阅函数。 */
  async onSessionCommand(cb: SessionCommandListener): Promise<() => void> {
    await bridgeEvents()
    sessionCommandListeners.add(cb)
    return () => sessionCommandListeners.delete(cb)
  },

  /* ---- 运行态上报（前端 → 后端，contract §14.1） ---- */

  /** 上报一份番茄钟运行态快照（写 `app_meta:runtime.focus.v1`）；失败静默由调用方决定。 */
  focusPublish: (snapshot: FocusRuntime) => invoke<Record<string, never>>('focus_publish', { snapshot }),

  /** 清除运行态快照（pause / reset / 相位结束）；幂等。 */
  focusUnpublish: () => invoke<Record<string, never>>('focus_unpublish', {}),

  /* ---- 管理面命令 ---- */

  /** 服务状态：开关 / 绑定模式 / 端口 / 待决数 / 已授权客户端列表。 */
  status: () => invoke<GatewayStatus>('gateway_status', {}),

  /** 开 / 关服务；开启时按当前绑定设置监听，返回的状态里是**实际**端口。 */
  setEnabled: (enabled: boolean) => invoke<GatewayStatus>('gateway_set_enabled', { enabled }),

  /** 设置绑定模式与端口（port 传 null = 用默认端口起，被占则顺延并把实际端口写回）。 */
  setBind: (bindMode: GatewayBindMode, port: number | null) =>
    invoke<GatewayStatus>('gateway_set_bind', { bindMode, port }),

  /** 推一份「已启用的功能模块 id」快照（**整表替换**）。网关据此对已关闭模块的对外方法
   * 回 `module_disabled`（contract §4.7）—— 关闭开关是界面动作，但接口必须跟着一起关，
   * 否则外部程序仍能驱动一个界面上已经关掉的功能（`pomodoro.start` 就是一例）。
   * 返回清洗后的列表。调用点是 `App.vue` 对功能开关的 watcher（启动 + 每次拨动）。 */
  setEnabledModules: (ids: string[]) =>
    invoke<string[]>('gateway_set_enabled_modules', { ids }),

  /** 冷启动补漏：所有尚未裁决的授权请求。 */
  authorizationPending: () => invoke<GatewayAuthRequest[]>('gateway_authorization_pending', {}),

  /** 回传用户裁决；成功返回空对象。 */
  authorizationRespond: (requestId: string, decision: GatewayAuthDecision, scopes: string[]) =>
    invoke<Record<string, never>>('gateway_authorization_respond', { requestId, decision, scopes }),

  /** 撤销某个客户端的授权（allow 行置撤销位、deny/ignore 行删行，两情形都清活动会话授权）。 */
  revokeClient: (clientId: string) => invoke<GatewayStatus>('gateway_revoke_client', { clientId }),

  /** 覆写「允许的网页来源」白名单（**整表替换**：设置页的加 / 删都走它，contract §15.2a）。
   * 传空数组即清空 —— 此后只放行不带 `Origin` 的原生客户端。 */
  setAllowedOrigins: (origins: string[]) =>
    invoke<GatewayStatus>('gateway_set_allowed_origins', { origins }),

  /** 最近若干条访问审计（谁 / 何时 / 方法 / 结果 / 参数摘要）。`limit` 缺省 50、夹到 [1, 500]；
   * `clientId` 给了就只看那个客户端（设置页不做筛选，此处留口给别的调用方）。 */
  auditRecent: (limit?: number | null, clientId?: string | null) =>
    invoke<GatewayAuditEntry[]>('gateway_audit_recent', { limit: limit ?? null, clientId: clientId ?? null }),
}
