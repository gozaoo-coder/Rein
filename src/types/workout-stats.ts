/**
 * WorkoutRecord & WorkoutStats — 运动记录与统计系统
 * 每次 startWorkout 完成/终止后写入一条 WorkoutRecord；
 * WorkoutStats 由记录聚合而来，同时持久化以便快速展示。
 */

/**
 * 单步训练执行快照 — 写入 WorkoutRecord.steps 时使用。
 * 仅记录 TRAINING 类型步骤，resting 步骤不写入。
 */
export interface WorkoutRecordStep {
  exerciseId?: string;
  exerciseName: string;
  sets: number;
  reps?: number;
  durationSec?: number;
  weight?: string;
  restBetweenSets?: number;
  completedSets: number;
}

export interface WorkoutRecord {
  id: string;
  courseId: string;
  courseName: string;
  courseCategory: string;
  startedAt: number; // epoch ms
  endedAt: number;
  durationSec: number;
  caloriesBurned: number;
  completedSets: number;
  totalSets: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  finished: boolean; // true=正常完成 false=中途退出
  /** 本次训练实际执行的步骤明细（仅 TRAINING 步） */
  steps?: WorkoutRecordStep[];
}

export interface DailyStat {
  date: string; // YYYY-MM-DD
  sessions: number;
  durationSec: number;
  calories: number;
}

/** 月聚合统计 — yearMonth 格式 YYYY-MM */
export interface MonthlyStat {
  yearMonth: string;
  sessions: number;
  durationSec: number;
  calories: number;
  completedSets: number;
  totalSets: number;
}

/** 年聚合统计 */
export interface YearlyStat {
  year: number;
  sessions: number;
  durationSec: number;
  calories: number;
  completedSets: number;
  totalSets: number;
}

export interface WorkoutStats {
  totalSessions: number;
  totalDurationSec: number;
  totalCalories: number;
  totalSets: number;
  totalCompletedSets: number;
  streakDays: number;
  lastActiveAt?: number;
  last7Days: DailyStat[];
  last30Days: DailyStat[];
  perCategoryCount: Record<string, number>;
  perDifficultyCount: Record<string, number>;
}

export function emptyStats(): WorkoutStats {
  return {
    totalSessions: 0,
    totalDurationSec: 0,
    totalCalories: 0,
    totalSets: 0,
    totalCompletedSets: 0,
    streakDays: 0,
    last7Days: [],
    last30Days: [],
    perCategoryCount: {},
    perDifficultyCount: {},
  };
}
