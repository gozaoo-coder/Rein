/**
 * 外部访问授权弹窗的单例状态机。
 *
 * 与 `system/voiceRuntime.ts` / `system/shareInbox.ts` 同一范式：组件只读状态、
 * 运行时管数据与副作用。职责：
 * - 订阅 `gateway://authorization-required`（有新请求待裁决，经 gatewayService 桥接）；
 * - 订阅 `gateway://authorization-changed`，据此**再拉一次**待决列表兜底丢事件
 *   （冷启动也先拉一次 `gateway_authorization_pending`）；
 * - 维护「同一时刻只展示一条、其余排队」的队列；
 * - 请求超时（`GatewayAuthRequest.timeoutMs`，协议默认 30s）按「忽略」处理。
 *
 * 裁决只经 `decide()` 一个出口，四态按钮与超时、抽屉关闭（Esc/背景/×）共用它 ——
 * 「什么都不选就退出」在语义上就是「忽略」（contract §8.2）。
 */

import { reactive, readonly } from 'vue'

import { gatewayService } from '@/services/gatewayService'
import type { GatewayAuthDecision, GatewayAuthRequest } from '@/types'

/** 协议默认超时；`timeoutMs` 异常时兜底用（与 `protocol.rs` 的 30000 一致）。 */
const DEFAULT_TIMEOUT_MS = 30_000

const state = reactive<{ current: GatewayAuthRequest | null; queued: number }>({
  current: null,
  queued: 0,
})

/** 等待展示的请求（先进先出）。 */
const queue: GatewayAuthRequest[] = []
/** 本端已裁决过（含超时按忽略）的 requestId：轮询兜底时不再重复弹出。 */
const decided = new Set<string>()
let initialized = false
let timer: number | undefined

function armTimeout(req: GatewayAuthRequest): void {
  disarmTimeout()
  const ms = req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS
  timer = window.setTimeout(() => void decide('ignore'), ms)
}

function disarmTimeout(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
}

function syncQueued(): void {
  state.queued = queue.length + (state.current ? 1 : 0)
}

/** 展示队列里的下一条；队列空则收起弹窗。 */
function showNext(): void {
  const next = queue.shift()
  if (!next) {
    state.current = null
    disarmTimeout()
    syncQueued()
    return
  }
  state.current = next
  armTimeout(next)
  syncQueued()
}

/** 入队（按 requestId 去重）；当前无待决则立即展示，否则排队。 */
function enqueue(req: GatewayAuthRequest): void {
  if (decided.has(req.requestId)) return
  if (state.current?.requestId === req.requestId) return
  if (queue.some((r) => r.requestId === req.requestId)) return
  queue.push(req)
  if (state.current) syncQueued()
  else showNext()
}

/** 兜底拉取：取回全部待决请求补齐队列（已裁决 / 已在队列的不重复）。 */
async function pullPending(): Promise<void> {
  try {
    const list = await gatewayService.authorizationPending()
    for (const req of list) enqueue(req)
  } catch {
    /* 服务未启动 / 非支持环境：静默，等下一次事件或下一轮轮询 */
  }
}

/** 唯一裁决出口：记已决 → 展示下一条 → 回传后端（回传失败不打断用户、也不重弹）。
 *
 * `scopes` 是用户在弹窗里**逐项勾选**的结果；省略时回退到请求方建议的 `req.scopes`
 * （超时 / 关闭走「忽略」时不带 scopes，后端不落决策）。写权限必须由用户显式勾选才生效。 */
async function decide(decision: GatewayAuthDecision, scopes?: string[]): Promise<void> {
  const req = state.current
  if (!req) return
  disarmTimeout()
  decided.add(req.requestId)
  state.current = null
  showNext()
  try {
    await gatewayService.authorizationRespond(req.requestId, decision, scopes ?? req.scopes)
  } catch {
    /* 请求可能已被后端处置（超时 / 断链）：静默 */
  }
}

export const externalAccessRuntime = {
  /** 只读状态：`current` 非空即授权弹窗可见；`queued` 为待展示总数（含当前一条）。 */
  state: readonly(state),

  /** main.ts 启动时调用一次（幂等）：订阅事件 + 首轮兜底拉取。 */
  init(): void {
    if (initialized) return
    initialized = true
    void gatewayService.onAuthorizationRequired((req) => enqueue(req))
    void gatewayService.onAuthorizationChanged(() => void pullPending())
    void pullPending()
  },

  /** 弹窗四态按钮、超时、抽屉关闭共用入口。 */
  decide,
}
