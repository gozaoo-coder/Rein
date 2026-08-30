/**
 * 运动系统运行时 · 应用级单例（main.ts 装载，与组件树生命周期解耦）。
 *
 * 运动的计时 / 步骤 / 开始 / 暂停状态机在 stores/run（跑步）与
 * stores/session（训练课）——两者是 Pinia 应用级单例，组件挂载与卸载
 * 不影响计时、GPS 与落盘。本模块在状态机之上承担三件事：
 *
 * 1. 应用启动时接管服务端未正常结束的会话（原各页「检测到未完成的
 *    训练」恢复卡逻辑收敛于此）：跑步恢复为暂停态，课程续跑；
 * 2. 为沉浸页与悬浮运动条（ActiveWorkoutBar）提供统一的数据与动作
 *    入口——两者都只从这里取「当前运动」的展示与控制；
 * 3. whenReady()：沉浸页挂载时先等接管完成，再决定进入哪个阶段，
 *    避免与启动接管竞态（如直接冷开 #/session/run）。
 *
 * 使用约定：Pinia 在 main.ts 中先于 init() 安装；本模块所有 store
 * 访问都在函数内延迟进行，保证模块顶层 import 无副作用。
 */

import { computed } from 'vue'

import { sessionService } from '@/services/sessionService'
import { fmtClock, fmtPace, useRunStore } from '@/stores/run'
import { useSessionStore } from '@/stores/session'
import type { SessionFinishResult } from '@/stores/session'
import { RUN_PLAN_ID } from '@/types'

export type WorkoutKind = 'none' | 'run' | 'course'

/** 悬浮运动条 / 外部控制用的统一视图（无运动时为 null） */
export interface WorkoutBarView {
  kind: 'run' | 'course'
  /** 正在记录（跑步计时中；课程任意进行阶段） */
  running: boolean
  /** 仅跑步：暂停中（结束前必须先暂停） */
  paused: boolean
  /** 已到总结、待保存 */
  summary: boolean
  title: string
  /** 主统计行：跑步 = 时长 · 配速 · 里程；课程 = 动作名 · 组进度 */
  stat: string
  /** 方块泊车态的一行短统计（64px 方块内只放得下它）：跑步=时长，课程=组/休息进度 */
  blob: string
  /** 课程主动作按钮文案（完成本组 / 完成）；无则为 null */
  completeLabel: string | null
  /** 允许走「结束 → 二级确认」；跑步仅暂停后为 true（必须暂停再结束） */
  canEnd: boolean
}

/* ---------- 启动接管 ---------- */

let takeover: Promise<void> | null = null

/**
 * 应用启动调用（幂等）：服务端存在 active 行 = 上次未正常结束
 * （切页 / 收起 / 关窗 / 崩溃），接管进对应状态机。
 */
function init(): Promise<void> {
  if (takeover) return takeover
  takeover = (async () => {
    let planId: string | null = null
    try {
      const rec = await sessionService.getActive()
      planId = rec?.planId ?? null
    } catch {
      planId = null // 后端暂不可用：沉浸页自身的 hydrate 仍会兜底
    }
    if (planId === RUN_PLAN_ID) await useRunStore().hydrateFromServer()
    else if (planId != null) await useSessionStore().hydrateFromServer()
  })()
  return takeover
}

/** 等待启动接管完成（沉浸页 onMounted 先 await 此函数） */
function whenReady(): Promise<void> {
  return takeover ?? init()
}

/* ---------- 派生 ---------- */

/** 当前运动类别：两台状态机任一非 idle 即有运动（ready 阶段不算） */
const kind = computed<WorkoutKind>(() => {
  if (useRunStore().isActive) return 'run'
  if (useSessionStore().isActive) return 'course'
  return 'none'
})

/** 恢复沉浸模式的目标路由 */
const immersiveRoute = computed(() => (kind.value === 'run' ? '/session/run' : '/session'))

const view = computed<WorkoutBarView | null>(() => {
  if (kind.value === 'run') {
    const r = useRunStore()
    const paused = r.phase === 'paused'
    const pace = r.paceSecPerKm != null ? fmtPace(r.paceSecPerKm) : '—'
    const km = r.km > 0.005 ? r.km.toFixed(2) : '—'
    return {
      kind: 'run',
      running: r.phase === 'running',
      paused,
      summary: r.phase === 'summary',
      title: paused ? '户外跑 · 已暂停' : '户外跑',
      stat: `${fmtClock(r.elapsedSec)} · ${pace}/km · ${km} km`,
      blob: fmtClock(r.elapsedSec),
      completeLabel: null,
      canEnd: paused,
    }
  }
  if (kind.value === 'course') {
    const s = useSessionStore()
    const ex = s.currentEx
    const summary = s.phase === 'summary'
    let stat = ''
    let blob = ''
    switch (s.phase) {
      case 'warmup':
        stat = ex ? `${ex.name} · 激活热身 ${s.warmupDone(ex)}/${ex.warmups?.length ?? 0}` : ''
        blob = '热身'
        break
      case 'exercise':
        stat = ex ? `${ex.name} · 第 ${s.setIndex}/${s.effSets(ex)} 组 × ${ex.reps ?? '—'} 次` : ''
        blob = ex ? `${s.setIndex}/${s.effSets(ex)} 组` : ''
        break
      case 'rest':
        stat =
          `休息 ${s.restLeft}s · ` +
          (s.restWarmup
            ? '热身中'
            : s.restTargetIsNextSet
              ? `第 ${s.setIndex + 1} 组`
              : `下一个 ${s.plan?.exercises[s.exIndex + 1]?.name ?? ''}`)
        blob = `${s.restLeft}s`
        break
      case 'timed-ready':
        stat = ex ? `${ex.name} · 准备中` : ''
        blob = '准备'
        break
      case 'timed-run':
        stat = ex ? `${ex.name} · ${Math.floor(s.timedElapsed)} / ${s.timedTotal}s` : ''
        blob = `${Math.floor(s.timedElapsed)}s`
        break
      case 'summary':
        stat = `已完成 ${s.doneCount}/${s.totalCount} 组 · 待保存`
        blob = `${s.doneCount} 组`
        break
    }
    return {
      kind: 'course',
      running: !summary,
      paused: false,
      summary,
      title: s.plan?.name ?? '训练课',
      stat,
      blob,
      completeLabel:
        s.phase === 'exercise' ? '完成本组' : s.phase === 'timed-run' ? '完成' : null,
      canEnd: !summary,
    }
  }
  return null
})

/* ---------- 动作（转发到对应状态机） ---------- */

function pauseActive(): void {
  if (kind.value === 'run') useRunStore().pause()
}

function resumeActive(): void {
  if (kind.value === 'run') useRunStore().resume()
}

/** 课程主动作：做组中 = 完成本组（与沉浸页坞内一致）；计时中 = 完成计时 */
function completeCurrentSet(): void {
  if (kind.value !== 'course') return
  const s = useSessionStore()
  if (s.phase === 'exercise') s.completeSet()
  else if (s.phase === 'timed-run') s.finishTimed()
}

/** 跑步「结束并保存」：冻结计时进总结页（距离补填在沉浸页完成） */
function enterRunSummary(): void {
  useRunStore().enterSummary()
}

/** 课程「结束并保存」：直接落库并关闭会话 */
async function finishCourse(): Promise<SessionFinishResult | null> {
  if (kind.value !== 'course') return null
  return useSessionStore().finishAndSave()
}

/** 放弃当前运动（已经过二级确认）：关闭会话、不写记录 */
async function discardActive(): Promise<void> {
  if (kind.value === 'run') await useRunStore().discard()
  else if (kind.value === 'course') await useSessionStore().discard()
}

export const workoutRuntime = {
  init,
  whenReady,
  kind,
  view,
  immersiveRoute,
  pauseActive,
  resumeActive,
  completeCurrentSet,
  enterRunSummary,
  finishCourse,
  discardActive,
}
