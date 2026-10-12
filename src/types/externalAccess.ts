/**
 * 外部访问（对外服务网关）域类型 · 对应 Rust `modules/gateway/{commands,models,auth}.rs`。
 *
 * 字段名是 IPC 契约（Rust 端 serde camelCase）：改这里必须同步改 Rust 结构体。
 * scope 串的**唯一真源**是 Rust `gateway/models.rs` 的 `Scope` 枚举 —— 前端只消费同名
 * 字符串，不做前缀 / 通配推导（contract §5.3）。
 */

/** 可授权的 7 个 scope 串，顺序与 Rust `Scope::ALL`（界面展示顺序）一致。 */
export const GATEWAY_SCOPES = [
  'schedule.read',
  'schedule.create',
  'schedule.write',
  'workout.read',
  'workout.write',
  'pomodoro.read',
  'pomodoro.write',
] as const

export type GatewayScope = (typeof GATEWAY_SCOPES)[number]

/** scope → 中文名（授权弹窗逐项勾选、客户端列表的权限摘要共用同一份文案）。 */
export const GATEWAY_SCOPE_LABELS: Record<GatewayScope, string> = {
  'schedule.read': '查看日程',
  'schedule.create': '新增日程',
  'schedule.write': '修改与删除日程',
  'workout.read': '查看运动数据',
  'workout.write': '写入运动数据',
  'pomodoro.read': '查看番茄钟记录',
  'pomodoro.write': '写入番茄钟记录',
}

/** 授权持久度：`session` 随连接消亡，`always` 持令牌直到撤销（contract §5.1）。 */
export type GatewayGrant = 'session' | 'always'

/** 弹窗四态裁决（contract §5.1）。 */
export type GatewayAuthDecision = 'allow-session' | 'allow-always' | 'ignore' | 'deny'

/** 绑定模式：仅本机（127.0.0.1 / ::1）或局域网（0.0.0.0，必须带配对令牌）。 */
export type GatewayBindMode = 'local' | 'lan'

/** 一条待裁决的授权请求（`gateway://authorization-required` 负载、`gateway_authorization_pending` 元素）。 */
export interface GatewayAuthRequest {
  requestId: string
  clientId: string
  clientName: string
  /** 握手时的 Origin；带 Origin 的连接已在握手被拒，故通常为 null。 */
  origin: string | null
  /** 请求来源 IP（服务端从 socket 取，请求方无法伪造）。 */
  ip: string | null
  scopes: string[]
  /** ISO-8601。 */
  createdAt: string
  timeoutMs: number
}

/** 一个已授权客户端（设置页列表项）。 */
export interface GatewayClient {
  clientId: string
  name: string
  grant: GatewayGrant
  scopes: string[]
  /** ISO-8601；从未活跃为 null。 */
  lastSeen: string | null
  online: boolean
  ip: string | null
}

/** 一个被拦下的客户端（拒绝 / 已撤销 / 静默限频中）——设置页要能看到并解除。 */
export interface GatewayBlocked {
  clientId: string
  name: string
  /** 被拦下的原因：拒绝 / 已撤销 / 连续忽略进入静默。 */
  reason: 'deny' | 'revoked' | 'ignore'
  /** ISO-8601；从未活跃为 null。 */
  lastSeen: string | null
  ip: string | null
}

/** 服务状态（`gateway_status` 的返回、`gateway://authorization-changed` 的负载）。 */
export interface GatewayStatus {
  enabled: boolean
  bindMode: GatewayBindMode
  /** 实际监听端口；服务未监听时为 null。 */
  port: number | null
  /** 安装级配对令牌（LAN 模式必填）；未生成为 null。仅设置页本机可见，别外传。 */
  pairToken: string | null
  pendingCount: number
  clients: GatewayClient[]
  /** 被拒绝 / 已撤销 / 静默限频中的客户端（可解除）。 */
  blocked: GatewayBlocked[]
}
