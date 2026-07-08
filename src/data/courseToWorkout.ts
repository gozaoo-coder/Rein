/**
 * Course → WorkoutPlan 转换工具
 *
 * 将课程 (Course) 数据结构转换为训练执行 (WorkoutPlan) 结构：
 *  - 遍历 course.steps: CourseStep[]，按 phase 分类映射
 *  - 为每个训练步填充详细动作指南（来自 Exercise.executionDetails / cautions / equipment / muscleGroup）
 *  - 热身 / 拉伸作为按时长的 training 步
 *  - 主训练步：有 reps → 计次；有 durationSec → 计时；restSec → 组间休息
 *  - phase=rest → 独立 resting 步
 *  - 器械动作自动生成配重建议文案（基于难度与类型）
 */

import type { Course, CourseStep, StepPhase } from "@/types/course";
import { DIFFICULTY_LABEL } from "@/types/course";
import type { Exercise } from "@/types/exercise";
import { MUSCLE_GROUP_LABEL } from "@/types/exercise";
import { useExerciseStore } from "@/stores/exerciseStore";
import {
  MediaType,
  StepType,
  type WorkoutPlan,
  type WorkoutStep,
} from "@/types/workout";

const PHASE_LABEL: Record<StepPhase, string> = {
  warmup: "热身",
  main: "主训练",
  stretch: "拉伸",
  rest: "休息",
};

function resolveExercise(id: string): Exercise | undefined {
  try {
    return useExerciseStore().getById(id);
  } catch {
    return undefined;
  }
}

function suggestWeight(exercise: Exercise): string {
  const eq = exercise.equipment ?? "";
  if (eq.includes("杠铃")) {
    return exercise.difficulty === "beginner" ? "建议起始：空杆 20kg"
      : exercise.difficulty === "intermediate" ? "建议：60-70% 1RM"
      : "建议：80% 1RM，需保护";
  }
  if (eq.includes("哑铃")) {
    return exercise.difficulty === "beginner" ? "建议起始：2-5kg/只"
      : exercise.difficulty === "intermediate" ? "建议：6-12kg/只"
      : "建议：12kg+/只";
  }
  if (exercise.category === "bodyweight" && !eq) return "自重";
  if (eq) return "按能力选择配重";
  return "自重";
}

function buildGuide(exercise: Exercise, note?: string): string {
  const parts: string[] = [];
  if (exercise.executionDetails) parts.push(exercise.executionDetails);
  else if (exercise.description) parts.push(exercise.description);
  else parts.push(exercise.name);
  if (note) parts.push(`备注：${note}`);
  return parts.join("\n\n");
}

function buildTrainingStep(order: number, cs: CourseStep, exercise: Exercise, phase: StepPhase): WorkoutStep {
  const isRepBased = cs.reps != null && cs.reps > 0;
  const isTimeBased = !isRepBased && cs.durationSec != null && cs.durationSec > 0;
  const timer = isRepBased
    ? { enabled: false, unit: "reps" as const, value: cs.reps ?? 0 }
    : isTimeBased
      ? { enabled: true, unit: "seconds" as const, value: cs.durationSec ?? 30 }
      : { enabled: false, unit: "reps" as const, value: 0 };

  return {
    type: StepType.TRAINING,
    phase: PHASE_LABEL[phase],
    timer,
    sets: Math.max(1, cs.sets),
    restBetweenSets: cs.restSec > 0 ? cs.restSec : undefined,
    details: {
      title: `${order}. ${cs.exerciseName || exercise.name}`,
      guide: {
        type: exercise.guide?.type ?? MediaType.MARKDOWN_TEXT,
        url: exercise.guide?.url,
        content: buildGuide(exercise, cs.note),
      },
      equipment: exercise.equipment ?? "徒手",
      muscleGroup: MUSCLE_GROUP_LABEL[exercise.muscleGroup] ?? "",
      weight: cs.weight ?? suggestWeight(exercise),
      cautions: cs.cautions ?? exercise.cautions ?? undefined,
    },
  };
}

function buildRestStep(cs: CourseStep, order: number): WorkoutStep {
  const seconds = cs.durationSec && cs.durationSec > 0 ? cs.durationSec : cs.restSec || 60;
  return {
    type: StepType.RESTING,
    phase: "休息",
    timer: { enabled: true, unit: "seconds", value: seconds },
    details: {
      title: cs.exerciseName || `${order}. 休息`,
      guide: {
        type: MediaType.MARKDOWN_TEXT,
        content: cs.note ?? `${seconds}秒 深呼吸、调整节奏、小口补水。`,
      },
    },
  };
}

export function courseToWorkoutPlan(course: Course): WorkoutPlan {
  const steps: WorkoutStep[] = [];
  let order = 1;

  for (const cs of course.steps) {
    if (cs.phase === "rest") {
      steps.push(buildRestStep(cs, order++));
      continue;
    }
    const ex = resolveExercise(cs.exerciseId);
    if (!ex) {
      // 动作库查不到时兜底：用 CourseStep 自带字段构造一个最小训练步
      const isRepBased = cs.reps != null && cs.reps > 0;
      const isTimeBased = !isRepBased && cs.durationSec != null && cs.durationSec > 0;
      steps.push({
        type: StepType.TRAINING,
        phase: PHASE_LABEL[cs.phase],
        timer: isRepBased
          ? { enabled: false, unit: "reps", value: cs.reps ?? 0 }
          : isTimeBased
            ? { enabled: true, unit: "seconds", value: cs.durationSec ?? 30 }
            : { enabled: false, unit: "reps", value: 0 },
        sets: Math.max(1, cs.sets),
        restBetweenSets: cs.restSec > 0 ? cs.restSec : undefined,
        details: {
          title: `${order}. ${cs.exerciseName}`,
          guide: {
            type: MediaType.MARKDOWN_TEXT,
            content: cs.note ?? cs.exerciseName,
          },
          weight: cs.weight,
          cautions: cs.cautions,
        },
      });
      order++;
      continue;
    }
    steps.push(buildTrainingStep(order++, cs, ex, cs.phase));
  }

  return {
    name: course.name,
    level: DIFFICULTY_LABEL[course.difficulty] ?? course.difficulty,
    steps,
  };
}
