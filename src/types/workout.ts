export enum StepType {
  TRAINING = "training",
  RESTING = "resting",
}

export enum MediaType {
  VIDEO = "video",
  IMAGE = "image",
  MARKDOWN_TEXT = "markdownText",
}

export type TimerUnit = "seconds" | "reps";

export interface TimerConfig {
  enabled: boolean;
  unit: TimerUnit;
  value: number;
}

export interface Guide {
  type: MediaType;
  content?: string;
  url?: string;
}

export interface StepDetails {
  title: string;
  guide: Guide;
  /** 器械名（哑铃 / 杠铃 / 徒手…） */
  equipment?: string;
  /** 目标肌群标签 */
  muscleGroup?: string;
  /** 配重（kg 或 自重） */
  weight?: string;
  /** 注意事项 */
  cautions?: string;
}

export interface WorkoutStep {
  type: StepType;
  phase: string;
  timer: TimerConfig;
  details: StepDetails;
  /** 训练步的组数（默认 1），resting 步忽略 */
  sets?: number;
  /** 同一步内组间休息秒数（默认 0 = 无休息） */
  restBetweenSets?: number;
}

export interface WorkoutPlan {
  name: string;
  level: string;
  steps: WorkoutStep[];
}

export type WorkoutState = "idle" | "running" | "paused" | "finished" | "interrupted";
export type StepSubState = "exercising" | "resting";

/** 小休息预设（秒） — 30s ~ 2.5min */
export const QUICK_REST_PRESETS: number[] = [30, 60, 90, 120, 150];

/**
 * WorkoutSnapshot — 运动运行时快照，用于异常打断后恢复。
 * 序列化后通过 useStorage 持久化，重启 / 异常退出后可恢复训练。
 */
export interface WorkoutSnapshot {
  /** 快照写入时间戳 */
  savedAt: number;
  /** 训练开始时间 */
  startedAt: number;
  /** 课程 id（用于从 courseStore 重新拉回 Course 对象） */
  courseId: string;
  /** Plan 名称（兜底展示） */
  planName: string;
  planLevel: string;
  /** 序列化的 plan（含 steps） */
  plan: WorkoutPlan;
  currentStepIndex: number;
  workoutState: WorkoutState;
  subState: StepSubState;
  stepSecondsRemaining: number;
  totalElapsedSeconds: number;
  caloriesBurned: number;
  heartRate: number | null;
  heartRateConnected: boolean;
  phaseCarouselIndex: number;
  completedSets: number;
  currentSetInStep: number;
  inSetRest: boolean;
  /** 标记是否处于小休息（quick rest） */
  inQuickRest: boolean;
  /** 小休息剩余秒数 */
  quickRestRemaining: number;
  /** 心率采样 */
  heartRateSamples: number[];
}

export interface WorkoutRuntime {
  currentStepIndex: number;
  elapsedSeconds: number;
  stepSecondsRemaining: number;
  totalElapsedSeconds: number;
  caloriesBurned: number;
  heartRate: number | null;
  heartRateConnected: boolean;
  workoutState: WorkoutState;
  subState: StepSubState;
  setCount: number;
  totalSets: number;
}
