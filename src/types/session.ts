/** 训练课域类型 · 纯前端状态机（保存时落库为 Workout） */

import type { ActivationMap } from '@/config/muscles'

import type { WorkoutType } from './exercise'

export type PlanExerciseKind = 'strength' | 'timed' | 'cardio'

/** 力量动作的激活热身组：小重量找发力感 / 复合动作渐进 ramp-up */
export interface WarmupSet {
  /** 热身重量 kg（约为正式组的一半起步） */
  weightKg: number
  reps: number
}

/** 计划中的一个动作 */
export interface PlanExercise {
  id: string
  /**
   * 动作库 id（`exercises.id`）——动作的唯一真源。
   * 课程条目只是「用哪个动作 + 什么处方」；展示名/肌群/要点优先取库内数据，
   * 库里查不到（老数据未回填、自建动作被删）时回落下面的 name 快照。
   */
  exerciseId: string
  /** 动作名快照：库内名缺失时展示用（写入时由后端按名称挂库） */
  name: string
  kind: PlanExerciseKind
  /** 力量：组数 */
  sets: number
  /** 力量：每组次数 */
  reps: number | null
  /** 力量：建议重量 kg */
  weightKg: number | null
  /**
   * 激活热身组（strength 用，可选）：正式组前依次完成；不计入组数进度与总容量。
   * 约定：≥30kg 复合项两段 ramp（50%×8 + 75%×4）；12~30kg 单组激活（50%×12）；<12kg 不配。
   */
  warmups?: WarmupSet[]
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
  /**
   * 显式肌群激活表（AI/种子提供时优先展示；缺省按动作名关键词匹配）。
   * exercises_json 旧数据无此字段，读取时按 undefined 处理。
   */
  muscles?: ActivationMap
}

export interface WorkoutPlan {
  id: string
  name: string
  subtitle: string
  /** 保存训练时使用的运动类型 */
  workoutType: WorkoutType
  exercises: PlanExercise[]
}

/** 一组已完成记录：力量存重量，计时存秒数；热身组带 warmup 标记（不计入正式进度） */
export interface DoneSet {
  weight: number | null
  sec: number | null
  /**
   * 该组实际完成次数（完成瞬间登记：正式组取现场次数，热身组取热身定义次数）。
   * 逐组登记而非回读课程定义——课程可能事后被编辑/删除，回读会让历史记录失真。
   * 旧快照没有此字段，读取时按 undefined 处理并回落到课程定义。
   */
  reps?: number | null
  /** true = 激活热身组 */
  warmup?: boolean
}

export type SessionPhase =
  | 'idle'
  | 'warmup' // 力量：激活热身中（动作配了 warmups 且未完成/跳过）
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
  /** 激活热身组间休息：不推进正式组数 */
  restWarmup?: boolean
  /** 当前组现场次数（力量动作可临时改写；null = 该动作未配次数） */
  reps?: number | null
  /** 「再加一组」：动作 id → 追加的组数 */
  extraSets?: Record<string, number>
  /** 已跳过的正式组：动作 id → 被跳过的组号（1-based）。跳过 = 未做，不计入完成统计 */
  skippedSets?: Record<string, number[]>
  /**
   * 今日状态自评（1=很差 … 5=很好）；null / 缺省 = 未自评（建议引擎纯自动推断）。
   * 随快照落盘，训练中断恢复后不丢。
   */
  readiness?: number | null
}

/** 全课扁平化后每一组的状态（抽屉与顶部进度格条的唯一数据源） */
export type SessionSetState =
  | 'done' // 已真实完成（进入统计）
  | 'skipped' // 已跳过（未做 / 不统计）
  | 'current' // 当前待做（或正在做）
  | 'pending' // 排在后面，尚未轮到

/** 全课组清单的一格：动作坐标 + 组号 + 状态 + 完成登记值 */
export interface SessionSetSlot {
  /** 该组所属动作在课程中的下标 */
  exIdx: number
  exId: string
  exName: string
  kind: PlanExerciseKind
  /** 1-based 组号；热身组单独从 1 计，不占正式组号 */
  setNo: number
  /** true = 激活热身组（只出现在 courseSlots，不进进度格条与游标计算） */
  warmup?: boolean
  state: SessionSetState
  /** 已完成组登记的实际次数 / 重量 / 秒数；其余状态为 null */
  done: { weight: number | null; sec: number | null; reps?: number | null } | null
}

/** 逐组重量落库行（session_finish 事务内写入 workout_sets 表；重量曲线的数据源） */
export interface StrengthSetRow {
  exerciseKey: string
  /** 动作库 id —— 重量曲线的聚合键 */
  exerciseId: string
  exerciseName: string
  kind: PlanExerciseKind
  setNo: number
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
}

/** workout_sets 查询返回行（含 JOIN workouts 的日期）；exerciseName 只是历史快照 */
export interface StrengthSetRecord {
  workoutId: number
  date: string
  exerciseKey: string
  exerciseId: string | null
  exerciseName: string
  kind: PlanExerciseKind
  setNo: number
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
}

/** 单次训练里某动作的聚合（曲线/明细展示用，由前端按 date 聚合） */
export interface StrengthDayEntry {
  workoutId: number
  date: string
  planName?: string
  sets: { setNo: number; weightKg: number | null; reps: number | null; warmup: boolean }[]
}

/** 有力量记录的动作（按最近训练排序）。exerciseId 为空 = 老库未回填，回落 name 作键 */
export interface StrengthExerciseRef {
  exerciseId: string
  name: string
  lastDate: string
  sessions: number
}

/** 某动作最近一次做组重量（沉浸页「上次重量」预填用） */
export interface StrengthLastWeight {
  exerciseId: string
  name: string
  weightKg: number
  reps: number | null
  date: string
}

/**
 * 沉浸页「更换动作」的候选（来自动作库）：
 * 只换动作本体，编排（组数/次数/休息/热身）沿用课程当前动作。
 */
export interface SwapCandidate {
  exerciseId: string
  name: string
  tips: string
  muscles?: ActivationMap
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
