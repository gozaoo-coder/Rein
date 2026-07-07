/**
 * Course (课程) — 训练计划数据结构
 * 课程 = 一组动作步骤 (CourseStep) 的有序集合
 */

export type CourseDifficulty = "beginner" | "intermediate" | "advanced";

export type CourseCategory =
  | "push" // 健身房三分化：推（胸/肩/三头）
  | "pull" // 拉（背/二头）
  | "legs" // 腿
  | "fullbody" // 全身
  | "upper" // 上肢
  | "lower" // 下肢
  | "core" // 核心
  | "cardio" // 有氧
  | "mobility" // 灵活性/拉伸
  | "custom"; // 自定义

export type StepPhase = "warmup" | "main" | "stretch" | "rest";

export interface CourseStep {
  id: string;
  exerciseId: string;
  exerciseName: string; // 冗余字段，便于列表显示
  sets: number;
  reps?: number; // 每组次数（若按次数计）
  durationSec?: number; // 每组时长（若按时长计）
  restSec: number; // 组间休息
  phase: StepPhase;
  note?: string;
}

export interface Course {
  id: string;
  name: string;
  description?: string;
  difficulty: CourseDifficulty;
  category: CourseCategory;
  estimatedMinutes: number;
  estimatedCalories: number;
  steps: CourseStep[];
  pinned: boolean;
  custom: boolean; // 用户自定义 vs 预设
  createdAt: number;
  updatedAt: number;
  lastPracticedAt?: number;
  practiceCount: number;
}

export interface CourseGroup {
  key: CourseCategory;
  label: string;
  courses: Course[];
}

/** 课程排序与分组辅助函数 */
export const DIFFICULTY_ORDER: Record<CourseDifficulty, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

export const DIFFICULTY_LABEL: Record<CourseDifficulty, string> = {
  beginner: "入门",
  intermediate: "进阶",
  advanced: "高级",
};

export const CATEGORY_LABEL: Record<CourseCategory, string> = {
  push: "推（胸/肩/三头）",
  pull: "拉（背/二头）",
  legs: "腿",
  fullbody: "全身",
  upper: "上肢",
  lower: "下肢",
  core: "核心",
  cardio: "有氧",
  mobility: "拉伸/灵活性",
  custom: "自定义",
};
