/**
 * 外部访问授权弹窗的单例状态机。
 *
 * 与 `system/voiceRuntime.ts` / `system/shareInbox.ts` 同一范式：组件只读状态、
 * 运行时管数据与副作用。职责：
 * - 订阅 `gateway://authorization-required`（有新请求待裁决，经 gatewayService 桥接）；
 * - 订阅 `gateway://authorization-changed`，据此**再拉一次**待决列表兜底丢事件
 *   （冷启动也先拉一次 `gateway_authorization_pending`）；
 * - 维护「同一时刻只展示一条、其余排队」的队列；
 * - 请求超时（`GatewayAuthRequest.timeoutMs`，协议默认 60s）按「忽略」处理；
 * - 应用不在前台时，除弹窗队列外**同时**发一条系统通知做降级；通知权限不可得则把该请求
 *   按「忽略」处理（contract §16 规则 3）；
 * - 订阅两条**下行控制**事件（`gateway://pomodoro-command` / `gateway://session-command`），
 *   把外部请求落到本地 store 状态机（contract §14.3）。
 *
 * 裁决只经 `decide()` 一个出口，四态按钮与超时、抽屉关闭（Esc/背景/×）共用它 ——
 * 「什么都不选就退出」在语义上就是「忽略」（contract §8.2）。
 */

import { reactive, readonly } from 'vue'

import { gatewayService } from '@/services/gatewayService'
import { notifyGrabResult } from '@/services/notifyService'
import { isTauri } from '@/services/transport'
import { usePlanStore } from '@/stores/plan'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useSessionStore } from '@/stores/session'
import type { GatewayAuthDecision, GatewayAuthRequest, GatewayPomodoroCommand, GatewaySessionCommand } from '@/types'

/** 协议默认超时；`timeoutMs` 异常时兜底用（与 `auth.rs` 的 `AUTH_PENDING_TIMEOUT_MS` 60000 一致）。 */
const DEFAULT_TIMEOUT_MS = 60_000

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
  // 应用不在前台：全局弹窗用户看不到，先发一条系统通知降级（contract §16 规则 3）。
  // 通知权限不可得时该请求按「忽略」处理（下同），连接维持 pending、限频照常计入。
  // 只在 Tauri 里做：浏览器/mock 没有通知通道，直接判「不可得」会把正常请求也忽略掉。
  if (isTauri && !isForeground()) {
    void notifyBackgroundRequest(req)
  }
  queue.push(req)
  if (state.current) syncQueued()
  else showNext()
}

/** 应用是否在前台（主窗口有焦点）。后台/最小化时 false。 */
function isForeground(): boolean {
  return typeof document === 'undefined' ? true : document.hasFocus()
}

/**
 * 后台请求的系统通知降级（contract §16 规则 3）：通知发出去了就仍保留弹窗队列
 * （用户回到前台能看见）；通知权限不可得则该请求立即按「忽略」上报，不占着队列。
 */
async function notifyBackgroundRequest(req: GatewayAuthRequest): Promise<void> {
  const sent = await notifyGrabResult('外部程序请求访问', `${req.clientName} 想连接 Rein，请回到应用确认`)
  if (sent) return
  // 通知发不出去：按「忽略」处理（后端只记限频、连接维持 pending）。
  decided.add(req.requestId)
  const qi = queue.indexOf(req)
  if (qi >= 0) queue.splice(qi, 1)
  if (state.current?.requestId === req.requestId) {
    disarmTimeout()
    state.current = null
    showNext()
  } else {
    syncQueued()
  }
  try {
    await gatewayService.authorizationRespond(req.requestId, 'ignore', req.scopes)
  } catch {
    /* 请求可能已被后端处置（超时 / 断链）：静默 */
  }
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

/* ---------------- 下行控制（contract §14.3） ---------------- */

/**
 * 外部番茄钟控制：落到本地计时状态机。
 *
 * 幂等由 store 保证：`start` 已在跑就忽略（`src/stores/pomodoro.ts` 的守卫）、
 * `pause` 没在跑就忽略、`reset` 复位到初始态（重复来结果相同）。契约把这三个动作
 * 映射到 store 的 `start/pause/reset`，所以载荷里的 `focusMin/breakMin/todoId`
 * 只作为外部请求的意图记录，不在这里改写用户保存在 localStorage 的番茄钟设置。
 */
function applyPomodoroCommand(cmd: GatewayPomodoroCommand): void {
  const pomo = usePomodoroStore()
  switch (cmd.action) {
    case 'start':
      pomo.start()
      break
    case 'pause':
      pomo.pause()
      break
    case 'stop':
      pomo.reset()
      break
  }
}

/**
 * 外部训练课控制：落到本地会话状态机（contract §14.3）。
 *
 * 冲突守卫：本机 UI 正持有活跃会话时 `start` 被**拒绝**（不再新开），外部经
 * `workout.sessionActive` 观察到即知；`snapshot/finish/abort` 只对本地在跑的那一场生效
 * （见 `applyExternalSnapshot` / `finishFromExternal` 的说明）。
 */
async function applySessionCommand(cmd: GatewaySessionCommand): Promise<void> {
  const store = useSessionStore()
  const args = cmd.args
  switch (cmd.action) {
    case 'start': {
      if (store.isActive || store.sessionId != null) return
      const planId = args.planId
      if (!planId) return
      const plans = usePlanStore()
      if (!plans.byId(planId)) {
        try {
          await plans.ensureLoaded()
        } catch {
          /* 课程库拉不到：按「该课程不存在」处理，不新开 */
        }
      }
      const plan = plans.byId(planId)
      if (!plan) return
      // start() 内部还会再查一次服务端 active：撞上竞态时回 'conflict'，同样不新开
      await store.start(plan)
      break
    }
    case 'snapshot': {
      const state = args.state
      if (args.id == null || !state) return
      await store.applyExternalSnapshot({
        id: args.id,
        exIndex: args.exIndex ?? 0,
        setIndex: args.setIndex ?? 1,
        weightKg: args.weightKg ?? 0,
        state,
      })
      break
    }
    case 'finish': {
      if (!args.sessionFinish) return
      await store.finishFromExternal(args.sessionFinish)
      break
    }
    case 'abort': {
      if (args.id == null) return
      await store.discardById(args.id)
      break
    }
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
    void gatewayService.onPomodoroCommand((cmd) => applyPomodoroCommand(cmd))
    void gatewayService.onSessionCommand((cmd) => {
      void applySessionCommand(cmd).catch((e: unknown) => {
        // 外部控制的失败不该打断本机 UI：记录后由外部经 status/sessionActive 观察到没生效
        console.warn('[gateway] 外部控制执行失败', e)
      })
    })
    void pullPending()
  },

  /** 弹窗四态按钮、超时、抽屉关闭共用入口。 */
  decide,
}
