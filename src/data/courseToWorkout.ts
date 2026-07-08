/**
 * Course → WorkoutPlan 转换工具
 *
 * 将课程 (Course) 数据结构转换为训练执行 (WorkoutPlan) 结构：
 *  - 创建训练/休息交替的 WorkoutStep[]
 *  - 为每个训练步填充详细动作指南（来自 Exercise.executionDetails / cautions / equipment / muscleGroup）
 *  - 热身 / 拉伸作为单独的 training 步（按秒计时）
 *  - 器械动作自动生成配重建议文案（基于难度与类型）
 */

import type { Course, CourseExercise } from "@/types/course";
import type { Exercise } from "@/types/exercise";
import { useExerciseStore } from "@/stores/exerciseStore";
import {
  MediaType,
  StepType,
  type WorkoutPlan,
  type WorkoutStep,
} from "@/types/workout";
import { MUSCLE_GROUP_LABEL, EXERCISE_DIFFICULTY_LABEL } from "@/types/exercise";

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

function buildStep(order: number, ce: CourseExercise, exercise: Exercise, phase: string): WorkoutStep {
  const isRepBased = !!ce.reps;
  const parts: string[] = [];
  if (exercise.executionDetails) parts.push(exercise.executionDetails);
  else if (exercise.description) parts.push(exercise.description);
  else parts.push(exercise.name);

  const md = parts.join("\n\n");

  return {
    type: StepType.TRAINING,
    phase,
    timer: isRepBased
      ? { enabled: false, unit: "reps", value: ce.reps ?? 0 }
      : { enabled: true, unit: "seconds", value: ce.duration ?? 30 },
    sets: ce.sets ?? 1,
    restBetweenSets: ce.restAfterSet ?? ce.rest ?? 0,
    details: {
      title: `${order}. ${exercise.name}`,
      guide: {
        type: exercise.guide?.type ?? MediaType.MARKDOWN_TEXT,
        url: exercise.guide?.url,
        content: md,
      },
      equipment: exercise.equipment ?? "徒手",
      muscleGroup: MUSCLE_GROUP_LABEL[exercise.muscleGroup] ?? "",
      weight: suggestWeight(exercise),
      cautions: exercise.cautions ?? undefined,
    },
  };
}

function stretchStep(order: number, exercise: Exercise, durationSec: number, phase: string): WorkoutStep {
  return {
    type: StepType.TRAINING,
    phase,
    timer: { enabled: true, unit: "seconds", value: durationSec },
    sets: 1,
    details: {
      title: `${order}. ${exercise.name}`,
      guide: {
        type: MediaType.MARKDOWN_TEXT,
        content: exercise.executionDetails ?? exercise.description ?? exercise.name,
      },
      equipment: exercise.equipment ?? "徒手",
      muscleGroup: MUSCLE_GROUP_LABEL[exercise.muscleGroup] ?? "",
      cautions: exercise.cautions ?? undefined,
    },
  };
}

function restStep(seconds: number, label = "组间休息"): WorkoutStep {
  return {
    type: StepType.RESTING,
    phase: "休息",
    timer: { enabled: true, unit: "seconds", value: seconds },
    details: {
      title: label,
      guide: { type: MediaType.MARKDOWN_TEXT, content: `${seconds}秒 深呼吸、调整节奏、小口补水。` },
    },
  };
}

export function courseToWorkoutPlan(course: Course): WorkoutPlan {
  const steps: WorkoutStep[] = [];
  let order = 1;

  if (course.warmup?.length) {
    for (const we of course.warmup) {
      const ex = resolveExercise(we.exerciseId);
      if (!ex) continue;
      steps.push(stretchStep(order++, ex, we.duration, "热身"));
      if (we.restAfter) steps.push(restStep(we.restAfter, "热身间休息"));
    }
  }

  if (course.mainWorkout?.length) {
    for (const ce of course.mainWorkout) {
      const ex = resolveExercise(ce.exerciseId);
      if (!ex) continue;
      steps.push(buildStep(order++, ce, ex, "主训练"));
      if (ce.rest) steps.push(restStep(ce.rest, "动作间休息"));
    }
  }

  if (course.coolDown?.length) {
    for (const we of course.coolDown) {
      const ex = resolveExercise(we.exerciseId);
      if (!ex) continue;
      steps.push(stretchStep(order++, ex, we.duration, "拉伸"));
      if (we.restAfter) steps.push(restStep(we.restAfter, "拉伸间休息"));
    }
  }

  return {
    name: course.name,
    level: EXERCISE_DIFFICULTY_LABEL[course.level],
    steps,
  };
}
