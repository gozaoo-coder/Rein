/** 训练课会话 IPC 封装 · 对应 modules/session/commands.rs */

import type { RunSnapshot, SessionRecord, SessionSnapshotState, Workout } from '@/types'
import { invoke } from './transport'

/** 会话状态快照：课程与跑步两种结构（Rust state_json 透传） */
type SessionState = SessionSnapshotState | RunSnapshot

export const sessionService = {
  start: (p: { planId: string; planName: string; startedAt: string; state: SessionState }) =>
    invoke<SessionRecord>('session_start', {
      planId: p.planId,
      planName: p.planName,
      startedAt: p.startedAt,
      stateJson: p.state,
    }),

  /** 事件级快照（做组/休息/计时/重量调整后调用）。elapsedSec 由服务端累加。 */
  snapshot: (p: {
    id: number
    exIndex: number
    setIndex: number
    weightKg: number
    state: SessionState
  }) =>
    invoke<void>('session_snapshot', {
      id: p.id,
      exIndex: p.exIndex,
      setIndex: p.setIndex,
      weightKg: p.weightKg,
      stateJson: p.state,
    }),

  /** 存在进行中（含异常中断）的训练时返回记录，否则 null */
  getActive: () => invoke<SessionRecord | null>('session_active'),

  /** 正常结束（保存）：事务内写入训练记录并关闭会话 */
  finish: (p: {
    id: number
    name: string
    workoutType: string
    date: string
    durationMin: number
    intensity: string
    kcal: number
    note: string | null
  }) => invoke<Workout>('session_finish', { input: p }),

  /** 正常结束（放弃）：仅关闭会话 */
  abort: (id: number) => invoke<void>('session_abort', { id }),

  /** 按训练记录反查来源会话（含最后一帧快照）；手动添加的记录返回 null */
  forWorkout: (workoutId: number) =>
    invoke<SessionRecord | null>('session_for_workout', { workoutId }),
}
