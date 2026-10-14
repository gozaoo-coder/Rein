/**
 * 外部访问（对外服务网关）域类型 · 对应 Rust `modules/gateway/{commands,models,auth}.rs`。
 *
 * 字段名是 IPC 契约（Rust 端 serde camelCase）：改这里必须同步改 Rust 结构体。
 * scope 串的**唯一真源**是 Rust `gateway/models.rs` 的 `Scope` 枚举 —— 前端只消费同名
 * 字符串，不做前缀 / 通配推导（contract §5.3）。
 */

import type { SessionSnapshotState, StrengthSetRow } from './session'

/** 可授权的 10 个 scope 串，顺序与 Rust `Scope::ALL`（界面展示顺序）一致。 */
export const GATEWAY_SCOPES = [
  'schedule.read',
  'schedule.create',
  'schedule.write',
  'schedule.delete',
  'workout.read',
  'workout.write',
  'workout.delete',
  'pomodoro.read',
  'pomodoro.write',
  'pomodoro.control',
] as const

export type GatewayScope = (typeof GATEWAY_SCOPES)[number]

/** scope → 中文名（授权弹窗逐项勾选、客户端列表的权限摘要共用同一份文案）。 */
export const GATEWAY_SCOPE_LABELS: Record<GatewayScope, string> = {
  'schedule.read': '查看日程',
  'schedule.create': '新增日程',
  'schedule.write': '修改日程',
  // 第二轮从 write 拆出：有写权不等于有删权（contract §13.1）
  'schedule.delete': '删除日程',
  'workout.read': '查看运动数据',
  'workout.write': '写入运动数据',
  'workout.delete': '删除运动记录',
  'pomodoro.read': '查看番茄钟记录',
  'pomodoro.write': '写入番茄钟记录',
  'pomodoro.control': '控制番茄钟计时',
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
  /** 握手时的 Origin；缺失（原生客户端）为 null，非空时必须命中白名单才放行（contract §15）。 */
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

/** 审计结局（`ext_audit.decision`）：成功 / 被拒 / 出错。 */
export type GatewayAuditDecision = 'allowed' | 'denied' | 'error'

/** 一行访问审计（`gateway_audit_recent` 元素、`ext_audit` 一行，contract §5.4）。
 *
 * `method` 为空串 = 连接/鉴权阶段的事件（detail 是原因文案）；非空 = 一次方法调用
 * （detail = 写操作参数摘要，或出错时的错误串）。只读成功不记（detail 为 null）。 */
export interface GatewayAuditEntry {
  id: number
  /** ISO-8601。 */
  at: string
  /** 调用方 clientId；连接/鉴权阶段的事件为 null（那时还没认出来是谁）。 */
  clientId: string | null
  method: string
  scope: string
  decision: GatewayAuditDecision
  detail: string | null
  ip: string | null
  durationMs: number
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
  /** 已批准的网页来源（`Origin`）白名单：精确字符串相等，`file://` 就是字面量 `"null"`（contract §15）。 */
  allowedOrigins: string[]
  /** 被 Origin 闸门拒过、且尚未加白的来源（设置页一键「加入白名单」）。 */
  blockedOrigins: string[]
}

/* ---------------- 运行态上报与下行控制（contract §14，第二轮） ---------------- */

/**
 * 番茄钟运行态快照（`app_meta` 键 `runtime.focus.v1` 的值，`pomodoro.status` 的返回）。
 *
 * 形状由 contract §14.1 冻结（后端只存原样 JSON，不解析）。**只写 `app_meta`**：
 * 写 `pomodoro_sessions` 会被同步钩子当成本地改动广播到其他设备。
 */
export interface FocusRuntime {
  phase: 'focus' | 'break'
  running: boolean
  /** 本阶段剩余秒数（计时真源是前端的 endAt，这里如实上报）。 */
  remainingSec: number
  plannedFocusMin: number
  plannedBreakMin: number
  /** 本阶段计时锚点（墙钟）：`phaseStartedAt + remainingSec` = 预计结束时刻，
   *  后端 `recover_focus` 据此判断「关闭期间是否已走完」。 */
  phaseStartedAt: string
  linkedTodoId: number | null
  completedRounds: number
  /** 本次上报时刻（UTC）。后端的陈旧判定用**自己的**写入时刻，不信这个字段。 */
  reportedAt: string
}

/** `pomodoro.start/pause/stop` 经 `gateway://pomodoro-command` 发来的载荷（contract §14.3）。 */
export interface GatewayPomodoroCommand {
  action: 'start' | 'pause' | 'stop'
  args: { focusMin?: number; breakMin?: number; todoId?: number | null }
}

/**
 * 一条训练课结束载荷（contract §13.2 `SessionFinishInput`，形同 Rust `FinishInput`）。
 *
 * `sets` 用 `StrengthSetRow`（`sessionService.finish` 的入参）：契约里 `FinishSet` 的
 * `exerciseId/weightKg/reps/sec/warmup` 标为可选，实际由前端 `buildSetRows()` 逐项填满。
 */
export interface GatewaySessionFinish {
  id: number
  name: string
  workoutType: string
  date: string
  durationMin: number
  intensity?: string | null
  kcal: number
  note?: string | null
  sets: StrengthSetRow[]
}

/**
 * `workout.sessionStart/sessionSnapshot/sessionFinish/sessionAbort` 经
 * `gateway://session-command` 发来的载荷（contract §14.3）。四个动作各带自己的 `args` 子集：
 * - `start` → `{planId, planName, startedAt, state?}`
 * - `snapshot` → `{id, exIndex, setIndex, weightKg, state}`
 * - `finish` → `{sessionFinish}`
 * - `abort` → `{id}`
 */
export interface GatewaySessionCommand {
  action: 'start' | 'snapshot' | 'finish' | 'abort'
  args: {
    planId?: string
    planName?: string
    startedAt?: string
    state?: SessionSnapshotState
    id?: number
    exIndex?: number
    setIndex?: number
    weightKg?: number
    sessionFinish?: GatewaySessionFinish
  }
}
