/**
 * WorkoutRecord & WorkoutStats — 运动记录与统计系统
 * 每次 startWorkout 完成/终止后写入一条 WorkoutRecord；
 * WorkoutStats 由记录聚合而来，同时持久化以便快速展示。
 */

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
}

export interface DailyStat {
  date: string; // YYYY-MM-DD
  sessions: number;
  durationSec: number;
  calories: number;
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
