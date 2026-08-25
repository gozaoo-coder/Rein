/** 训练课域类型 · 纯前端状态机（保存时落库为 Workout） */

import type { WorkoutType } from './exercise'

export type PlanExerciseKind = 'strength' | 'timed' | 'cardio'

/** 计划中的一个动作 */
export interface PlanExercise {
  id: string
  name: string
  kind: PlanExerciseKind
  /** 力量：组数 */
  sets: number
  /** 力量：每组次数 */
  reps: number | null
  /** 力量：建议重量 kg */
  weightKg: number | null
  /** 计时动作：每组目标秒 */
  targetSec: number | null
  /** 有氧：时长分钟 */
  durationMin: number | null
  /** 组间休息秒 */
  restSec: number
  /** 超级组等分组标签（A1 / A2） */
  group?: string
  /** 动作要点（列表展开显示） */
  tips: string
}

export interface WorkoutPlan {
  id: string
  name: string
  subtitle: string
  /** 保存训练时使用的运动类型 */
  workoutType: WorkoutType
  exercises: PlanExercise[]
}

/** 一组已完成记录：力量存重量，计时存秒数 */
export interface DoneSet {
  weight: number | null
  sec: number | null
}

export type SessionPhase =
  | 'idle'
  | 'exercise' // 力量：做组中
  | 'rest' // 组间休息
  | 'timed-ready' // 计时/有氧：准备
  | 'timed-run' // 计时中
  | 'summary' // 全部完成

/** 落盘用的状态快照（与 Rust state_json 对应） */
export interface SessionSnapshotState {
  doneSets: Record<string, DoneSet[]>
  exIndex: number
  setIndex: number
  weight: number
  phase: Exclude<SessionPhase, 'idle'>
  restLeft?: number
  restTargetIsNextSet?: boolean
  timedTotal?: number
  /** 临时休息：不推进流程，倒计时结束回到 resumePhase */
  restIsTemp?: boolean
  resumePhase?: 'exercise' | 'timed-ready' | 'timed-run'
  /** 「再加一组」：动作 id → 追加的组数 */
  extraSets?: Record<string, number>
}

/** 跑步目标类型 */
export type RunGoalKind = 'open' | 'time' | 'distance'

/** 轨迹点：t = 记录时的累计运动毫秒（旧快照可能缺失），alt = GPS 海拔米 */
export interface RunTrackPoint {
  lat: number
  lon: number
  t?: number
  alt?: number
}

/**
 * 跑步会话的落盘快照（state_json 里以 kind:'run' 区分于课程快照）。
 * points 为轨迹面包屑（写入前抽稀）；早期快照可能缺失，恢复时按空处理。
 */
export interface RunSnapshot {
  kind: 'run'
  phase: 'running' | 'paused' | 'summary'
  goalKind: RunGoalKind
  goalTimeMin: number
  goalDistanceKm: number
  /** 已累计运动毫秒（不含被打断的当前段） */
  accumMs: number
  /** 当前段起点（running 时存在）；恢复时强制暂停、丢弃该段 */
  segStartedAt: string | null
  distanceM: number
  /** 轨迹点（崩溃恢复后整条轨迹重画） */
  points?: RunTrackPoint[]
}

/** 服务端的进行中会话记录 */
export interface SessionRecord {
  id: number
  planId: string
  planName: string
  status: 'active' | 'finished' | 'aborted'
  startedAt: string
  /** SQLite datetime('now')，UTC */
  updatedAt: string
  exIndex: number
  setIndex: number
  weightKg: number
  /** 服务端按快照间隔自动累加的真实流逝秒数 */
  elapsedSec: number
  state: SessionSnapshotState
}
