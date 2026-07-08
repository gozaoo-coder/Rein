/**
 * Course → WorkoutPlan 适配器
 * Course (业务模型) 转换为 WorkoutPlan (运行时模型)，
 * 让现有 WorkoutPage / workoutStore 可直接消费。
 */

import type { Course, CourseStep } from "@/types/course";
import type { WorkoutPlan, WorkoutStep, TimerConfig } from "@/types/workout";
import { StepType, MediaType } from "@/types/workout";
import type { Exercise } from "@/types/exercise";
import { useExerciseStore } from "@/stores/exerciseStore";

const PHASE_LABEL: Record<CourseStep["phase"], string> = {
  warmup: "热身",
  main: "正式",
  stretch: "拉伸",
  rest: "休息",
};

function phaseLabel(phase: CourseStep["phase"]): string {
  return PHASE_LABEL[phase] ?? "正式";
}

function stepTimer(step: CourseStep): TimerConfig {
  // 时长计：用 durationSec；次数计：用 reps + 组间休息时间作为 step 计时
  if (step.durationSec != null) {
    return { enabled: true, unit: "seconds", value: step.durationSec };
  }
  return { enabled: false, unit: "reps", value: step.reps ?? 10 };
}

function stepTitle(step: CourseStep, exercise?: Exercise): string {
  const name = exercise?.name ?? step.exerciseName;
  const sets = step.sets;
  const reps = step.reps;
  const dur = step.durationSec;
  const detail = reps != null ? `${sets}×${reps}` : dur != null ? `${sets}×${dur}s` : `${sets}组`;
  return `${name}  ${detail}`;
}

function stepGuide(step: CourseStep, exercise?: Exercise): string {
  const lines: string[] = [];
  if (exercise?.description) lines.push(exercise.description);
  if (step.note) lines.push(`备注：${step.note}`);
  lines.push(`组数：${step.sets}`);
  if (step.reps != null) lines.push(`每组次数：${step.reps}`);
  if (step.durationSec != null) lines.push(`每组时长：${step.durationSec} 秒`);
  lines.push(`组间休息：${step.restSec} 秒`);
  return lines.join("\n");
}

/** 将 Course 转换为 WorkoutPlan：每个 CourseStep 映射为一个带 sets 的训练步 */
export function courseToWorkoutPlan(course: Course): WorkoutPlan {
  const exerciseStore = useExerciseStore();
  const steps: WorkoutStep[] = [];

  for (const cs of course.steps) {
    const exercise = exerciseStore.getById(cs.exerciseId);
    const phase = phaseLabel(cs.phase);

    // 训练步（含组数与组间休息，由 store 内部循环处理）
    steps.push({
      type: StepType.TRAINING,
      phase,
      timer: stepTimer(cs),
      sets: cs.sets,
      restBetweenSets: cs.restSec,
      details: {
        title: stepTitle(cs, exercise),
        guide: {
          type: MediaType.MARKDOWN_TEXT,
          content: stepGuide(cs, exercise),
        },
      },
    });
  }

  return {
    name: course.name,
    level: course.difficulty,
    steps,
  };
}
