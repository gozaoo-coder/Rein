/**
 * Exercise (动作库) — 单个训练动作定义
 * 动作库分为：徒手 (bodyweight) 与 器械 (equipment)
 * 预设动作库的数据填充待办（TODO），先完成数据结构与二级页面
 */

export type ExerciseCategory = "bodyweight" | "equipment";

export type MuscleGroup =
  | "chest"
  | "back"
  | "shoulder"
  | "biceps"
  | "triceps"
  | "legs"
  | "glutes"
  | "core"
  | "fullbody"
  | "cardio";

export type ExerciseDifficulty = "beginner" | "intermediate" | "advanced";

export type GuideType = "video" | "image" | "markdownText";

export interface ExerciseGuide {
  type: GuideType;
  content?: string; // markdown 文本
  url?: string; // 视频/图片 URL
}

export interface Exercise {
  id: string;
  name: string;
  category: ExerciseCategory;
  muscleGroup: MuscleGroup;
  difficulty: ExerciseDifficulty;
  equipment?: string; // 器械名（哑铃/杠铃/...）
  description?: string;
  guide?: ExerciseGuide;
  custom: boolean; // 用户自定义
  createdAt: number;
  updatedAt: number;
}

export const MUSCLE_GROUP_LABEL: Record<MuscleGroup, string> = {
  chest: "胸部",
  back: "背部",
  shoulder: "肩部",
  biceps: "二头",
  triceps: "三头",
  legs: "腿部",
  glutes: "臀部",
  core: "核心",
  fullbody: "全身",
  cardio: "有氧",
};

export const EXERCISE_DIFFICULTY_LABEL: Record<ExerciseDifficulty, string> = {
  beginner: "入门",
  intermediate: "进阶",
  advanced: "高级",
};

export const EXERCISE_CATEGORY_LABEL: Record<ExerciseCategory, string> = {
  bodyweight: "徒手",
  equipment: "器械",
};
