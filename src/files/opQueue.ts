/**
 * 文件操作队列。
 *
 * 成熟的文件管理器里「复制」不是一个函数调用，而是一个**任务**：
 * 异步执行、看得见进度、可取消、失败了知道是哪一条、部分成功也如实报告。
 * 这里就是那层壳 —— 它不认识具体操作（provider 的原子函数才是），
 * 只负责把一批原子操作串成一条有进度、可取消、逐条报错的队列。
 *
 * 三条约定：
 * 1. **串行**：同一时刻只跑一条操作。并发写库没有收益，顺序错乱却会带来
 *    「移动完又把它复制回来」这类真问题；
 * 2. **取消是协作式的**：每个条目开始前检查一次取消标志，**未做的条目会被记住**
 *    ——「继续未完成」就是从这里恢复（断点续传的粒度是条目：工作区里的文件都是
 *    整行写入，条目内部分块续写没有意义，也不安全）；
 * 3. **失败不整体失败**：逐条执行、逐条记录，最后把失败清单交给调用方展示。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { FileOp, OpKind } from './types'

/** 一次操作的执行上下文：进度推进 + 取消检查 */
export interface OpContext {
  /** 完成一条（带可选标签，用于进度文案） */
  step(label?: string): void
  /** 记一条失败（不中断队列） */
  fail(reason: string): void
  /** 用户点了取消：调用方应在下一条开始前中止 */
  readonly cancelled: boolean
}

export interface OpRun<T> {
  op: FileOp
  /** 是否从头跑完（false = 被取消） */
  completed: boolean
  result: T | null
}

export interface BatchResult {
  done: number
  failed: number
  /** 还没做的条目数（> 0 时队列里留一条「继续未完成」） */
  remaining: number
}

interface ResumeState {
  kind: OpKind
  label: string
  total: number
  done: number
  failures: string[]
  /** 还没做的部分（继续时从这里接着跑） */
  remaining: unknown[]
  worker: (item: unknown, ctx: OpContext) => Promise<void>
}

export interface OpQueueApi {
  /** 队列里的操作（最近的在前，UI 只显示正在跑的与刚结束的） */
  ops: Ref<FileOp[]>
  /** 当前正在跑的操作（没有则 null） */
  current: ComputedRef<FileOp | null>
  busy: ComputedRef<boolean>
  /** 跑一条单件操作。返回它是否完成与业务结果。 */
  run<T>(
    kind: OpKind,
    label: string,
    total: number,
    work: (ctx: OpContext) => Promise<T>,
  ): Promise<OpRun<T>>
  /**
   * 跑一批（每条一次 worker）。取消/中断后可以在队列条上「继续未完成」，
   * 从断掉的那一条接着走，已经做完的不会重做。
   */
  runBatch<T>(
    kind: OpKind,
    label: string,
    items: T[],
    worker: (item: T, ctx: OpContext) => Promise<void>,
  ): Promise<BatchResult>
  /** 继续一条未完成的操作 */
  resume(opId: number): Promise<void>
  /** 请求取消当前操作（协作式，下一条生效） */
  cancel(): void
  /** 收起已结束的操作条 */
  dismiss(id: number): void
  dismissAllDone(): void
}

export function useOpQueue(): OpQueueApi {
  const ops = ref<FileOp[]>([])
  let seq = 0
  let cancelled = false
  /** 串行闸门：后一条等前一条收尾 */
  let tail: Promise<unknown> = Promise.resolve()
  /** 未完成的操作（opId → 断点），「继续」时用 */
  const resumeStates = new Map<number, ResumeState>()

  const current = computed(() => ops.value.find((o) => o.status === 'running') ?? null)
  const busy = computed(() => current.value !== null)

  function touch(): void {
    ops.value = [...ops.value]
  }

  async function gate(): Promise<() => void> {
    const prev = tail
    let release: () => void = () => {}
    tail = new Promise<void>((r) => (release = r))
    await prev
    return release
  }

  async function run<T>(
    kind: OpKind,
    label: string,
    total: number,
    work: (ctx: OpContext) => Promise<T>,
  ): Promise<OpRun<T>> {
    const id = ++seq
    const op: FileOp = { id, kind, label, total, done: 0, status: 'running', failures: [] }
    ops.value = [op, ...ops.value].slice(0, 8)
    const release = await gate()
    // 取消标记在拿到闸门之后才清：排队期间清掉，会让正在跑的那一批看不见用户的「取消」
    cancelled = false

    const ctx: OpContext = {
      step: () => {
        op.done += 1
        touch()
      },
      fail: (reason: string) => {
        op.failures.push(reason)
        touch()
      },
      get cancelled() {
        return cancelled
      },
    }

    let result: T | null = null
    try {
      result = await work(ctx)
      op.status = cancelled ? 'cancelled' : op.failures.length ? 'failed' : 'done'
    } catch (e) {
      op.failures.push(e instanceof Error ? e.message : String(e))
      op.status = 'failed'
    } finally {
      touch()
      release()
    }
    return { op, completed: op.status === 'done' || op.status === 'failed', result }
  }

  /**
   * 批量：按条推进，断点记在 `resumeStates`。
   * 中途取消 → 剩余条目留在状态里，队列条上出现「继续」；已经完成的绝不重做。
   */
  async function runBatch<T>(
    kind: OpKind,
    label: string,
    items: T[],
    worker: (item: T, ctx: OpContext) => Promise<void>,
  ): Promise<BatchResult> {
    const id = ++seq
    const op: FileOp = {
      id,
      kind,
      label,
      total: items.length,
      done: 0,
      status: 'running',
      failures: [],
      resumable: false,
    }
    ops.value = [op, ...ops.value].slice(0, 8)

    const state: ResumeState = {
      kind,
      label,
      total: items.length,
      done: 0,
      failures: [],
      remaining: [...items],
      worker: worker as (item: unknown, ctx: OpContext) => Promise<void>,
    }
    resumeStates.set(id, state)

    await drain(op, state)
    return {
      done: op.done,
      failed: op.failures.length,
      remaining: state.remaining.length,
    }
  }

  /** 把 state.remaining 里的条目跑完（runBatch 与 resume 共用） */
  async function drain(op: FileOp, state: ResumeState): Promise<void> {
    const release = await gate()
    // 取消标记在这里（拿到闸门 = 上一批已收尾）才清。
    // 入队时就清的话，正在跑的那一批会看不见用户刚点的「取消」，继续往下搬。
    cancelled = false
    op.status = 'running'
    touch()
    const ctx: OpContext = {
      step: () => {
        op.done += 1
        state.done += 1
        touch()
      },
      fail: (reason: string) => {
        op.failures.push(reason)
        state.failures.push(reason)
        touch()
      },
      get cancelled() {
        return cancelled
      },
    }
    try {
      while (state.remaining.length) {
        if (cancelled) break
        const item = state.remaining[0]
        try {
          await state.worker(item, ctx)
        } catch (e) {
          ctx.fail(e instanceof Error ? e.message : String(e))
        }
        // 无论成功失败都出队：失败已经记在 failures 里，留在队列里重试会变成死循环
        state.remaining.shift()
        touch()
      }
      const stopped = cancelled && state.remaining.length > 0
      op.status = stopped ? 'cancelled' : op.failures.length ? 'failed' : 'done'
      op.resumable = stopped
    } finally {
      if (!op.resumable) resumeStates.delete(op.id)
      touch()
      release()
    }
  }

  async function resume(opId: number): Promise<void> {
    const state = resumeStates.get(opId)
    const op = ops.value.find((o) => o.id === opId)
    if (!state || !op || !state.remaining.length) return
    cancelled = false
    await drain(op, state)
  }

  function cancel(): void {
    cancelled = true
  }

  function dismiss(id: number): void {
    resumeStates.delete(id)
    ops.value = ops.value.filter((o) => o.id !== id)
  }

  function dismissAllDone(): void {
    for (const o of ops.value) if (o.status !== 'running') resumeStates.delete(o.id)
    ops.value = ops.value.filter((o) => o.status === 'running')
  }

  return { ops, current, busy, run, runBatch, resume, cancel, dismiss, dismissAllDone }
}
