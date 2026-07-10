/**
 * usePiTools — 把课程/动作/统计工具改写为 pi-agent-core 的 AgentTool。
 * 使用 typebox 定义 parameters schema，execute 内部复用统一的 executeToolCall。
 *
 * 工具执行结果通过 AgentToolResult.details 字段携带我们的 ToolResult
 * （含 card / cardData / summary），供 UI 渲染卡片。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResult } from "@/types/ai";
import type { CourseCategory, CourseDifficulty, StepPhase } from "@/types/course";
import type { ExerciseCategory, ExerciseDifficulty, MuscleGroup } from "@/types/exercise";
import type { DietGoal, ActivityLevel } from "@/types/health";
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from "@/types/course";
import {
  MUSCLE_GROUP_LABEL,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
} from "@/types/exercise";
import { useCourseStore } from "@/stores/courseStore";
import { useExerciseStore } from "@/stores/exerciseStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useWorkoutStore } from "@/stores/workoutStore";
import { useUserStore } from "@/stores/userStore";
import { useTodoStore } from "@/stores/todoStore";
import { useHealthDataStore } from "@/stores/healthDataStore";
import type { TodoPriority } from "@/types/todo";
import { PRIORITY_LABEL } from "@/types/todo";
import { invoke } from "@tauri-apps/api/core";

// ===== Schemas =====

const CourseCategoryEnum = Type.Union(
  (Object.keys(CATEGORY_LABEL) as CourseCategory[]).map((k) => Type.Literal(k)),
  { description: "按部位筛选" },
);
const CourseDifficultyEnum = Type.Union(
  (Object.keys(DIFFICULTY_LABEL) as CourseDifficulty[]).map((k) => Type.Literal(k)),
  { description: "按难度筛选" },
);
const MuscleGroupEnum = Type.Union(
  (Object.keys(MUSCLE_GROUP_LABEL) as MuscleGroup[]).map((k) => Type.Literal(k)),
);
const ExerciseCategoryEnum = Type.Union(
  (Object.keys(EXERCISE_CATEGORY_LABEL) as ExerciseCategory[]).map((k) => Type.Literal(k)),
);
const ExerciseDifficultyEnum = Type.Union(
  (Object.keys(EXERCISE_DIFFICULTY_LABEL) as ExerciseDifficulty[]).map((k) => Type.Literal(k)),
);
const StepPhaseEnum = Type.Union(
  (["warmup", "main", "stretch", "rest"] as StepPhase[]).map((p) => Type.Literal(p)),
);

const StepSchema = Type.Object({
  exerciseId: Type.String(),
  exerciseName: Type.String(),
  sets: Type.Number(),
  reps: Type.Optional(Type.Number()),
  durationSec: Type.Optional(Type.Number()),
  restSec: Type.Number(),
  phase: StepPhaseEnum,
  note: Type.Optional(Type.String()),
  weight: Type.Optional(Type.String({ description: "配重描述，如 20kg / 自重 / RM 60%" })),
  cautions: Type.Optional(Type.String({ description: "注意事项，覆盖动作默认 cautions 时使用" })),
});

const MineralsSchema = Type.Object({
  calcium: Type.Optional(Type.Number({ description: "钙 mg/100g" })),
  iron: Type.Optional(Type.Number({ description: "铁 mg/100g" })),
  magnesium: Type.Optional(Type.Number({ description: "镁 mg/100g" })),
  phosphorus: Type.Optional(Type.Number({ description: "磷 mg/100g" })),
  potassium: Type.Optional(Type.Number({ description: "钾 mg/100g" })),
  sodium: Type.Optional(Type.Number({ description: "钠 mg/100g" })),
  zinc: Type.Optional(Type.Number({ description: "锌 mg/100g" })),
});

const VitaminsSchema = Type.Object({
  a: Type.Optional(Type.Number({ description: "维生素A μg RAE/100g" })),
  c: Type.Optional(Type.Number({ description: "维生素C mg/100g" })),
  d: Type.Optional(Type.Number({ description: "维生素D IU/100g" })),
  e: Type.Optional(Type.Number({ description: "维生素E mg/100g" })),
  k: Type.Optional(Type.Number({ description: "维生素K μg/100g" })),
  b1: Type.Optional(Type.Number({ description: "维生素B1 mg/100g" })),
  b2: Type.Optional(Type.Number({ description: "维生素B2 mg/100g" })),
  b3: Type.Optional(Type.Number({ description: "维生素B3(烟酸) mg/100g" })),
  b6: Type.Optional(Type.Number({ description: "维生素B6 mg/100g" })),
  b12: Type.Optional(Type.Number({ description: "维生素B12 μg/100g" })),
  folate: Type.Optional(Type.Number({ description: "叶酸 μg DFE/100g" })),
});

const CustomNutrientSchema = Type.Object({
  name: Type.String({ description: "营养素名，如 咖啡因" }),
  value: Type.Number({ description: "每100g数值" }),
  unit: Type.String({ description: "单位，如 mg" }),
});

// ===== Tool result details type =====

export interface PiToolDetails extends ToolResult {}

// ===== Shared execution helper =====

function genId(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeStep(s: Record<string, unknown>): import("@/types/course").CourseStep {
  return {
    id: typeof s.id === "string" ? s.id : genId("cs"),
    exerciseId: String(s.exerciseId ?? ""),
    exerciseName: String(s.exerciseName ?? ""),
    sets: Number(s.sets ?? 3),
    reps: s.reps != null ? Number(s.reps) : undefined,
    durationSec: s.durationSec != null ? Number(s.durationSec) : undefined,
    restSec: Number(s.restSec ?? 60),
    phase: (s.phase as StepPhase) ?? "main",
    note: typeof s.note === "string" ? s.note : undefined,
    weight: typeof s.weight === "string" && s.weight ? s.weight : undefined,
    cautions: typeof s.cautions === "string" && s.cautions ? s.cautions : undefined,
  };
}

function okSummary(name: string, text: string): string {
  return `${name}: ${text}`;
}

/** 把工具结果转为 pi 的 AgentToolResult */
function toToolResult(
  name: string,
  result: ToolResult,
): AgentToolResult<PiToolDetails> {
  return {
    content: [{ type: "text", text: result.content }],
    details: { ...result, name },
  };
}

// ===== Tool implementations =====

type AnyParams = Record<string, unknown>;

function executeCourseList(args: AnyParams): ToolResult {
  const store = useCourseStore();
  const cat = args.category as CourseCategory | undefined;
  const diff = args.difficulty as CourseDifficulty | undefined;
  let list = store.courses;
  if (cat) list = list.filter((c) => c.category === cat);
  if (diff) list = list.filter((c) => c.difficulty === diff);
  const summary = list.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    categoryLabel: CATEGORY_LABEL[c.category],
    difficulty: c.difficulty,
    difficultyLabel: DIFFICULTY_LABEL[c.difficulty],
    estimatedMinutes: c.estimatedMinutes,
    estimatedCalories: c.estimatedCalories,
    steps: c.steps.length,
    pinned: c.pinned,
  }));
  return {
    toolCallId: "",
    name: "course_list",
    ok: true,
    content: JSON.stringify(summary),
    summary: okSummary("course_list", `共 ${summary.length} 个课程`),
    card: "course-list",
    cardData: list,
  };
}

function executeCourseGet(args: AnyParams): ToolResult {
  const store = useCourseStore();
  const c = store.getById(String(args.id ?? ""));
  if (!c) throw new Error("课程不存在");
  return {
    toolCallId: "",
    name: "course_get",
    ok: true,
    content: JSON.stringify(c),
    summary: okSummary("course_get", c.name),
    card: "course",
    cardData: c,
  };
}

function executeCourseCreate(args: AnyParams): ToolResult {
  const store = useCourseStore();
  const steps = Array.isArray(args.steps)
    ? (args.steps as Record<string, unknown>[]).map(normalizeStep)
    : [];
  const created = store.createCourse({
    name: String(args.name ?? "未命名课程"),
    description: typeof args.description === "string" ? args.description : undefined,
    difficulty: (args.difficulty as CourseDifficulty) ?? "beginner",
    category: (args.category as CourseCategory) ?? "custom",
    estimatedMinutes: Number(args.estimatedMinutes ?? 0),
    estimatedCalories: Number(args.estimatedCalories ?? 0),
    pinned: Boolean(args.pinned),
    custom: true,
    steps,
  });
  return {
    toolCallId: "",
    name: "course_create",
    ok: true,
    content: JSON.stringify(created),
    summary: okSummary("course_create", `已创建「${created.name}」`),
    card: "course",
    cardData: created,
  };
}

function executeCourseUpdate(args: AnyParams): ToolResult {
  const store = useCourseStore();
  const id = String(args.id ?? "");
  const c = store.getById(id);
  if (!c) throw new Error("课程不存在");
  const patch: Partial<import("@/types/course").Course> = {};
  if (typeof args.name === "string") patch.name = args.name;
  if (typeof args.description === "string") patch.description = args.description;
  if (args.difficulty) patch.difficulty = args.difficulty as CourseDifficulty;
  if (args.category) patch.category = args.category as CourseCategory;
  if (args.estimatedMinutes != null) patch.estimatedMinutes = Number(args.estimatedMinutes);
  if (args.estimatedCalories != null) patch.estimatedCalories = Number(args.estimatedCalories);
  if (typeof args.pinned === "boolean") patch.pinned = args.pinned;
  if (Array.isArray(args.steps)) patch.steps = (args.steps as Record<string, unknown>[]).map(normalizeStep);
  store.updateCourse(id, patch);
  const updated = store.getById(id)!;
  return {
    toolCallId: "",
    name: "course_update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("course_update", `已更新「${updated.name}」`),
    card: "course",
    cardData: updated,
  };
}

function executeCourseDelete(args: AnyParams): ToolResult {
  const store = useCourseStore();
  const id = String(args.id ?? "");
  const c = store.getById(id);
  if (!c) throw new Error("课程不存在");
  const title = c.name;
  store.deleteCourse(id);
  return {
    toolCallId: "",
    name: "course_delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("course_delete", `已删除「${title}」`),
    card: "raw",
    cardData: { deleted: true, id, title },
  };
}

function executeExerciseList(args: AnyParams): ToolResult {
  const store = useExerciseStore();
  const mg = args.muscleGroup as MuscleGroup | undefined;
  const cat = args.category as ExerciseCategory | undefined;
  let list = store.exercises;
  if (mg) list = list.filter((e) => e.muscleGroup === mg);
  if (cat) list = list.filter((e) => e.category === cat);
  return {
    toolCallId: "",
    name: "exercise_list",
    ok: true,
    content: JSON.stringify(list),
    summary: okSummary("exercise_list", `共 ${list.length} 个动作`),
    card: "exercise-list",
    cardData: list,
  };
}

function executeExerciseCreate(args: AnyParams): ToolResult {
  const store = useExerciseStore();
  const ex = store.createExercise({
    name: String(args.name ?? "未命名动作"),
    category: (args.category as ExerciseCategory) ?? "bodyweight",
    muscleGroup: (args.muscleGroup as MuscleGroup) ?? "fullbody",
    difficulty: (args.difficulty as ExerciseDifficulty) ?? "beginner",
    equipment: typeof args.equipment === "string" ? args.equipment : undefined,
    description: typeof args.description === "string" ? args.description : undefined,
    executionDetails: typeof args.executionDetails === "string" ? args.executionDetails : undefined,
    cautions: typeof args.cautions === "string" ? args.cautions : undefined,
    custom: true,
  });
  return {
    toolCallId: "",
    name: "exercise_create",
    ok: true,
    content: JSON.stringify(ex),
    summary: okSummary("exercise_create", `已创建「${ex.name}」`),
    card: "exercise",
    cardData: ex,
  };
}

function executeExerciseUpdate(args: AnyParams): ToolResult {
  const store = useExerciseStore();
  const id = String(args.id ?? "");
  const ex = store.getById(id);
  if (!ex) throw new Error("动作不存在");
  const patch: Partial<import("@/types/exercise").Exercise> = {};
  if (typeof args.name === "string") patch.name = args.name;
  if (args.category) patch.category = args.category as ExerciseCategory;
  if (args.muscleGroup) patch.muscleGroup = args.muscleGroup as MuscleGroup;
  if (args.difficulty) patch.difficulty = args.difficulty as ExerciseDifficulty;
  if (typeof args.equipment === "string") patch.equipment = args.equipment;
  if (typeof args.description === "string") patch.description = args.description;
  if (typeof args.executionDetails === "string") patch.executionDetails = args.executionDetails;
  if (typeof args.cautions === "string") patch.cautions = args.cautions;
  store.updateExercise(id, patch);
  const updated = store.getById(id)!;
  return {
    toolCallId: "",
    name: "exercise_update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("exercise_update", `已更新「${updated.name}」`),
    card: "exercise",
    cardData: updated,
  };
}

function executeExerciseDelete(args: AnyParams): ToolResult {
  const store = useExerciseStore();
  const id = String(args.id ?? "");
  const ex = store.getById(id);
  if (!ex) throw new Error("动作不存在");
  if (!ex.custom) throw new Error("预设动作不可删除");
  const title = ex.name;
  store.deleteExercise(id);
  return {
    toolCallId: "",
    name: "exercise_delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("exercise_delete", `已删除「${title}」`),
    card: "raw",
    cardData: { deleted: true, id, title },
  };
}

function executeStatsGet(): ToolResult {
  const store = useWorkoutStatsStore();
  const s = store.stats;
  return {
    toolCallId: "",
    name: "stats_get",
    ok: true,
    content: JSON.stringify(s),
    summary: okSummary(
      "stats_get",
      `已训练 ${s.totalSessions} 次 / ${Math.round(s.totalDurationSec / 60)} 分钟 / ${Math.round(s.totalCalories)} 千卡`,
    ),
    card: "stats",
    cardData: s,
  };
}

// ===== Workout mode tools =====

function executeWorkoutCurrentGet(): ToolResult {
  const store = useWorkoutStore();
  if (!store.plan) throw new Error("当前没有进行中的训练");
  const step = store.currentStep;
  if (!step) throw new Error("无法获取当前步骤");
  const data = {
    planName: store.plan.name,
    planLevel: store.plan.level,
    totalSteps: store.plan.steps.length,
    currentStepIndex: store.currentStepIndex,
    currentSetInStep: store.currentSetInStep,
    inSetRest: store.inSetRest,
    inQuickRest: store.inQuickRest,
    stepSecondsRemaining: store.stepSecondsRemaining,
    totalElapsedSeconds: store.totalElapsedSeconds,
    completedSets: store.completedSets,
    totalSets: store.totalSets,
    step: {
      title: step.details.title,
      phase: step.phase,
      equipment: step.details.equipment,
      muscleGroup: step.details.muscleGroup,
      weight: step.details.weight,
      cautions: step.details.cautions,
      guide: step.details.guide.content,
      sets: step.sets,
      restBetweenSets: step.restBetweenSets,
      timer: step.timer,
    },
  };
  return {
    toolCallId: "",
    name: "workout_current_get",
    ok: true,
    content: JSON.stringify(data),
    summary: okSummary("workout_current_get", `当前：${step.details.title}`),
    card: "workout",
    cardData: data,
  };
}

function executeWorkoutStepSkip(): ToolResult {
  const store = useWorkoutStore();
  if (!store.plan) throw new Error("当前没有进行中的训练");
  const before = store.currentStep?.details.title ?? "";
  store.skipCurrentStep();
  const after = store.currentStep?.details.title ?? "训练结束";
  return {
    toolCallId: "",
    name: "workout_step_skip",
    ok: true,
    content: JSON.stringify({ skipped: before, now: after }),
    summary: okSummary("workout_step_skip", `跳过「${before}」→「${after}」`),
    card: "raw",
    cardData: { skipped: before, now: after },
  };
}

function executeWorkoutStepAdjustTemp(args: AnyParams): ToolResult {
  const store = useWorkoutStore();
  if (!store.plan) throw new Error("当前没有进行中的训练");
  const patch: {
    sets?: number;
    reps?: number;
    durationSec?: number;
    restSec?: number;
  } = {};
  if (args.sets != null) patch.sets = Number(args.sets);
  if (args.reps != null) patch.reps = Number(args.reps);
  if (args.durationSec != null) patch.durationSec = Number(args.durationSec);
  if (args.restSec != null) patch.restSec = Number(args.restSec);
  store.adjustCurrentStepTemp(patch);
  return {
    toolCallId: "",
    name: "workout_step_adjust_temp",
    ok: true,
    content: JSON.stringify({ applied: patch, temporary: true }),
    summary: okSummary("workout_step_adjust_temp", `已临时调整（仅本次训练）`),
    card: "raw",
    cardData: { applied: patch, temporary: true },
  };
}

function executeWorkoutCourseAdjustPermanent(args: AnyParams): ToolResult {
  const store = useWorkoutStore();
  if (!store.plan) throw new Error("当前没有进行中的训练");
  const stepIndex = Number(args.stepIndex ?? store.currentStepIndex);
  const patch: {
    sets?: number;
    reps?: number;
    durationSec?: number;
    restSec?: number;
    weight?: string;
    note?: string;
    cautions?: string;
  } = {};
  if (args.sets != null) patch.sets = Number(args.sets);
  if (args.reps != null) patch.reps = Number(args.reps);
  if (args.durationSec != null) patch.durationSec = Number(args.durationSec);
  if (args.restSec != null) patch.restSec = Number(args.restSec);
  if (typeof args.weight === "string") patch.weight = args.weight;
  if (typeof args.note === "string") patch.note = args.note;
  if (typeof args.cautions === "string") patch.cautions = args.cautions;
  const ok = store.adjustCoursePermanent(stepIndex, patch);
  if (!ok) throw new Error("无法永久调整：课程或步骤不存在");
  return {
    toolCallId: "",
    name: "workout_course_adjust_permanent",
    ok: true,
    content: JSON.stringify({ stepIndex, applied: patch, permanent: true }),
    summary: okSummary("workout_course_adjust_permanent", `已写回课程库（步骤 ${stepIndex + 1}）`),
    card: "raw",
    cardData: { stepIndex, applied: patch, permanent: true },
  };
}

function executeAppConfigGet(): ToolResult {
  const userStore = useUserStore();
  const p = userStore.profile;
  const data = {
    profile: {
      nickname: p.nickname,
      gender: p.gender,
      birthday: p.birthday,
      age: userStore.computedAge,
      height: p.height,
      weight: p.weight,
      targetWeight: p.targetWeight,
    },
    bmi: userStore.bmi,
  };
  return {
    toolCallId: "",
    name: "app_config_get",
    ok: true,
    content: JSON.stringify(data),
    summary: okSummary("app_config_get", `已获取用户配置`),
    card: "raw",
    cardData: data,
  };
}

function executeAppConfigUpdate(args: AnyParams): ToolResult {
  const userStore = useUserStore();
  const patch: Partial<typeof userStore.profile> = {};
  if (typeof args.nickname === "string") patch.nickname = args.nickname;
  if (typeof args.gender === "string" && ["male", "female", "other"].includes(args.gender)) {
    patch.gender = args.gender as "male" | "female" | "other";
  }
  if (typeof args.birthday === "string") patch.birthday = args.birthday;
  if (args.height != null) patch.height = Number(args.height);
  if (args.weight != null) patch.weight = Number(args.weight);
  if (args.targetWeight != null) patch.targetWeight = Number(args.targetWeight);
  userStore.setProfile(patch);
  return {
    toolCallId: "",
    name: "app_config_update",
    ok: true,
    content: JSON.stringify({ applied: patch }),
    summary: okSummary("app_config_update", `已更新用户配置`),
    card: "raw",
    cardData: { applied: patch },
  };
}

// ===== TodoList 工具 =====

function todoDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function executeTodoList(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const date = typeof args.date === "string" ? args.date : todoDateKey();
  const includeAll = Boolean(args.includeAll);
  const list = includeAll ? store.items : store.itemsOfDate(date);
  const summary = list.map((t) => ({
    id: t.id,
    title: t.title,
    note: t.note,
    kind: t.kind,
    dueDate: t.dueDate,
    dueTime: t.dueTime,
    startTime: t.startTime,
    endTime: t.endTime,
    recurrence: t.recurrence,
    checkin: t.checkin,
    subtasks: t.subtasks,
    location: t.location,
    priority: t.priority,
    priorityLabel: PRIORITY_LABEL[t.priority],
    urgent: t.urgent,
    categoryId: t.categoryId,
    done: t.done,
  }));
  return {
    toolCallId: "",
    name: "todo_list",
    ok: true,
    content: JSON.stringify(summary),
    summary: okSummary("todo_list", `${includeAll ? "全部" : date} 共 ${summary.length} 条`),
    card: "todo",
    cardData: { items: summary, date: includeAll ? "all" : date },
  };
}

function executeTodoCreate(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const priority = (args.priority as TodoPriority | undefined) ?? "normal";
  const kind = (args.kind as "all-day" | "deadline" | "time-range" | undefined) ?? "all-day";
  const subtasks = Array.isArray(args.subtasks)
    ? (args.subtasks as Record<string, unknown>[]).map((s) => ({
        title: String(s.title ?? ""),
        done: false,
        countMin: s.countMin != null ? Number(s.countMin) : undefined,
        countMax: s.countMax != null ? Number(s.countMax) : undefined,
        unit: typeof s.unit === "string" ? s.unit : undefined,
      }))
    : undefined;
  const dueDateStr = typeof args.dueDate === "string" ? args.dueDate : todoDateKey();
  const dueTimeStr = typeof args.dueTime === "string" && args.dueTime ? args.dueTime : undefined;
  const startTimeStr = typeof args.startTime === "string" && args.startTime ? args.startTime : undefined;
  const endTimeStr = typeof args.endTime === "string" && args.endTime ? args.endTime : undefined;
  const item = store.createItem({
    title: String(args.title ?? "未命名待办"),
    note: typeof args.note === "string" ? args.note : undefined,
    kind,
    dueDate: dueDateStr,
    dueTime: kind === "deadline" ? dueTimeStr : undefined,
    startTime: kind === "time-range" ? startTimeStr : undefined,
    endTime: kind === "time-range" ? endTimeStr : undefined,
    recurrence: args.recurrence as Record<string, unknown> | undefined,
    checkin: typeof args.checkin === "boolean" ? args.checkin : undefined,
    subtasks,
    location: typeof args.location === "string" ? args.location : undefined,
    priority,
    urgent: typeof args.urgent === "boolean" ? args.urgent : undefined,
    categoryId: typeof args.categoryId === "string" ? args.categoryId : undefined,
  });
  return {
    toolCallId: "",
    name: "todo_create",
    ok: true,
    content: JSON.stringify(item),
    summary: okSummary("todo_create", `已创建「${item.title}」`),
    card: "todo",
    cardData: { items: [item], date: item.dueDate ?? "today" },
  };
}

function executeTodoUpdate(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.id ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  const patch: Partial<typeof item> = {};
  if (typeof args.title === "string") patch.title = args.title;
  if (typeof args.note === "string") patch.note = args.note;
  const newKind = args.kind ? (args.kind as "all-day" | "deadline" | "time-range") : undefined;
  const effectiveKind = newKind ?? item.kind;
  if (newKind) patch.kind = newKind;
  if (typeof args.dueDate === "string") patch.dueDate = args.dueDate;
  if (args.dueTime !== undefined) {
    patch.dueTime = effectiveKind === "deadline" && typeof args.dueTime === "string" && args.dueTime
      ? args.dueTime : undefined;
  }
  if (args.startTime !== undefined) {
    patch.startTime = effectiveKind === "time-range" && typeof args.startTime === "string" && args.startTime ? args.startTime : undefined;
  }
  if (args.endTime !== undefined) {
    patch.endTime = effectiveKind === "time-range" && typeof args.endTime === "string" && args.endTime ? args.endTime : undefined;
  }
  if (effectiveKind === "all-day" && !newKind) {
    patch.dueTime = undefined;
    patch.startTime = undefined;
    patch.endTime = undefined;
  } else if (effectiveKind === "deadline" && newKind) {
    patch.startTime = undefined;
    patch.endTime = undefined;
  } else if (effectiveKind === "time-range" && newKind) {
    // time-range keeps all time fields
  }
  if (args.recurrence) patch.recurrence = args.recurrence as typeof item.recurrence;
  if (typeof args.checkin === "boolean") patch.checkin = args.checkin;
  if (typeof args.location === "string") patch.location = args.location;
  if (args.priority) patch.priority = args.priority as TodoPriority;
  if (typeof args.urgent === "boolean") patch.urgent = args.urgent;
  if (typeof args.categoryId === "string") patch.categoryId = args.categoryId;
  if (typeof args.done === "boolean") {
    patch.done = args.done;
    patch.completedAt = args.done ? Date.now() : 0;
  }
  store.updateItem(id, patch);
  const updated = store.items.find((t) => t.id === id)!;
  return {
    toolCallId: "",
    name: "todo_update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_update", `已更新「${updated.title}」`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

// ===== 子任务 / 分类工具 =====

function executeTodoSubtaskAdd(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.todoId ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  store.addSubtask(id, {
    title: String(args.title ?? ""),
    done: false,
    countMin: args.countMin != null ? Number(args.countMin) : undefined,
    countMax: args.countMax != null ? Number(args.countMax) : undefined,
    unit: typeof args.unit === "string" ? args.unit : undefined,
  });
  const updated = store.items.find((t) => t.id === id)!;
  return {
    toolCallId: "",
    name: "todo_subtask_add",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_subtask_add", `已添加子任务到「${updated.title}」`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

function executeTodoSubtaskToggle(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.todoId ?? "");
  const subId = String(args.subId ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  store.toggleSubtask(id, subId);
  const updated = store.items.find((t) => t.id === id)!;
  return {
    toolCallId: "",
    name: "todo_subtask_toggle",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_subtask_toggle", `子任务已切换`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

function executeTodoSubtaskRemove(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.todoId ?? "");
  const subId = String(args.subId ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  store.removeSubtask(id, subId);
  const updated = store.items.find((t) => t.id === id)!;
  return {
    toolCallId: "",
    name: "todo_subtask_remove",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_subtask_remove", `子任务已删除`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

function executeTodoCategoryList(): ToolResult {
  const store = useTodoStore();
  const cats = store.categories.map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
    preset: c.preset,
    count: store.byCategory[c.id]?.length ?? 0,
  }));
  return {
    toolCallId: "",
    name: "todo_category_list",
    ok: true,
    content: JSON.stringify(cats),
    summary: okSummary("todo_category_list", `共 ${cats.length} 个分类`),
    card: "raw",
    cardData: { categories: cats },
  };
}

function executeTodoCategoryCreate(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const cat = store.createCategory({
    name: String(args.name ?? "未命名分类"),
    icon: typeof args.icon === "string" ? args.icon : undefined,
    color: typeof args.color === "string" ? args.color : undefined,
  });
  return {
    toolCallId: "",
    name: "todo_category_create",
    ok: true,
    content: JSON.stringify(cat),
    summary: okSummary("todo_category_create", `已创建分类「${cat.name}」`),
    card: "raw",
    cardData: { category: cat },
  };
}

function executeTodoCategoryUpdate(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.id ?? "");
  const cat = store.categories.find((c) => c.id === id);
  if (!cat) throw new Error("分类不存在");
  store.updateCategory(id, {
    name: typeof args.name === "string" ? args.name : undefined,
    icon: typeof args.icon === "string" ? args.icon : undefined,
    color: typeof args.color === "string" ? args.color : undefined,
  });
  const updated = store.categories.find((c) => c.id === id)!;
  return {
    toolCallId: "",
    name: "todo_category_update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_category_update", `已更新分类「${updated.name}」`),
    card: "raw",
    cardData: { category: updated },
  };
}

function executeTodoCategoryDelete(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.id ?? "");
  const cat = store.categories.find((c) => c.id === id);
  if (!cat) throw new Error("分类不存在");
  const name = cat.name;
  store.deleteCategory(id);
  return {
    toolCallId: "",
    name: "todo_category_delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("todo_category_delete", `已删除分类「${name}」`),
    card: "raw",
    cardData: { deleted: true, id, name },
  };
}

function executeTodoMoveCategory(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const todoId = String(args.todoId ?? "");
  const categoryId = String(args.categoryId ?? "");
  const item = store.items.find((t) => t.id === todoId);
  if (!item) throw new Error("待办不存在");
  const cat = store.categories.find((c) => c.id === categoryId);
  if (!cat) throw new Error("分类不存在");
  store.moveToCategory(todoId, categoryId);
  const updated = store.items.find((t) => t.id === todoId)!;
  return {
    toolCallId: "",
    name: "todo_move_category",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_move_category", `「${updated.title}」已移至「${cat.name}」`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

function executeTodoDelete(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.id ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  const title = item.title;
  store.deleteItem(id);
  return {
    toolCallId: "",
    name: "todo_delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("todo_delete", `已删除「${title}」`),
    card: "raw",
    cardData: { deleted: true, id, title },
  };
}

function executeTodoToggleDone(args: AnyParams): ToolResult {
  const store = useTodoStore();
  const id = String(args.id ?? "");
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error("待办不存在");
  store.toggleDone(id);
  const updated = store.items.find((t) => t.id === id)!;
  return {
    toolCallId: "",
    name: "todo_toggle_done",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("todo_toggle_done", `「${updated.title}」${updated.done ? "已完成" : "未完成"}`),
    card: "todo",
    cardData: { items: [updated], date: updated.dueDate ?? "today" },
  };
}

// ===== 饮水工具 =====

function executeWaterAdd(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const amount = Number(args.amount ?? 0);
  if (amount <= 0) throw new Error("amount 必须 > 0");
  const rec = store.addWater(amount);
  return {
    toolCallId: "",
    name: "water_add",
    ok: true,
    content: JSON.stringify(rec),
    summary: okSummary("water_add", `已记录 ${amount}ml，今日累计 ${store.todayWaterAmount}ml`),
    card: "water",
    cardData: { amount, total: store.todayWaterAmount, goal: 2000 },
  };
}

function executeWaterToday(): ToolResult {
  const store = useHealthDataStore();
  const total = store.todayWaterAmount;
  return {
    toolCallId: "",
    name: "water_today",
    ok: true,
    content: JSON.stringify({ total, goal: 2000 }),
    summary: okSummary("water_today", `今日 ${total}ml / 2000ml`),
    card: "water",
    cardData: { amount: 0, total, goal: 2000 },
  };
}

// ===== 饮食记录工具 =====

function executeFoodRecordAdd(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const foodId = typeof args.foodId === "string" ? args.foodId : undefined;
  const grams = Number(args.grams ?? 0);
  if (grams <= 0) throw new Error("grams 必须 > 0");
  let foodName = typeof args.foodName === "string" ? args.foodName : "";
  if (foodId) {
    const food = store.findFood(foodId);
    if (!food) throw new Error(`食品 id ${foodId} 不存在`);
    foodName = food.name;
  }
  if (!foodName) throw new Error("需提供 foodId 或 foodName");
  const rec = store.addFoodRecord({
    foodId,
    foodName,
    grams,
    calories: typeof args.calories === "number" ? Number(args.calories) : undefined,
    carbs: typeof args.carbs === "number" ? Number(args.carbs) : undefined,
    protein: typeof args.protein === "number" ? Number(args.protein) : undefined,
    fat: typeof args.fat === "number" ? Number(args.fat) : undefined,
  });
  return {
    toolCallId: "",
    name: "food_record_add",
    ok: true,
    content: JSON.stringify(rec),
    summary: okSummary("food_record_add", `已记录 ${foodName} ${grams}g / ${rec.calories}千卡`),
    card: "food-record",
    cardData: {
      record: rec,
      todayTotals: {
        calories: store.todayCalories,
        carbs: store.todayCarbs,
        protein: store.todayProtein,
        fat: store.todayFat,
      },
    },
  };
}

function executeFoodToday(): ToolResult {
  const store = useHealthDataStore();
  const records = store.todayFoodRecords;
  return {
    toolCallId: "",
    name: "food_today",
    ok: true,
    content: JSON.stringify(records),
    summary: okSummary("food_today", `今日 ${records.length} 条 · ${store.todayCalories}千卡`),
    card: "food-record",
    cardData: {
      records,
      todayTotals: {
        calories: store.todayCalories,
        carbs: store.todayCarbs,
        protein: store.todayProtein,
        fat: store.todayFat,
      },
    },
  };
}

// ===== 食品库 CRUD =====

function executeFoodDbList(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const q = typeof args.query === "string" ? args.query : "";
  const list = store.searchFoods(q).slice(0, 50);
  return {
    toolCallId: "",
    name: "food_db_list",
    ok: true,
    content: JSON.stringify(list),
    summary: okSummary("food_db_list", `共 ${list.length} 个食品`),
    card: "food-db",
    cardData: { items: list },
  };
}

function executeFoodDbCreate(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const units = Array.isArray(args.units)
    ? (args.units as Record<string, unknown>[]).map((u) => ({
        name: String(u.name ?? ""),
        grams: Number(u.grams ?? 0),
      }))
    : [{ name: "100g", grams: 100 }];
  const customNutrients = Array.isArray(args.customNutrients)
    ? (args.customNutrients as Record<string, unknown>[]).map((n) => ({
        name: String(n.name ?? ""),
        value: Number(n.value ?? 0),
        unit: String(n.unit ?? "mg"),
      })).filter((n) => n.name)
    : undefined;
  const minerals = args.minerals && typeof args.minerals === "object"
    ? Object.fromEntries(
        Object.entries(args.minerals as Record<string, unknown>)
          .filter(([, v]) => v != null && typeof v === "number")
          .map(([k, v]) => [k, Number(v)]),
      )
    : undefined;
  const vitamins = args.vitamins && typeof args.vitamins === "object"
    ? Object.fromEntries(
        Object.entries(args.vitamins as Record<string, unknown>)
          .filter(([, v]) => v != null && typeof v === "number")
          .map(([k, v]) => [k, Number(v)]),
      )
    : undefined;
  const item = store.addFoodItem({
    name: String(args.name ?? "未命名食品"),
    category: typeof args.category === "string" ? args.category : "其他",
    caloriesPer100g: Number(args.caloriesPer100g ?? 0),
    carbsPer100g: Number(args.carbsPer100g ?? 0),
    proteinPer100g: Number(args.proteinPer100g ?? 0),
    fatPer100g: Number(args.fatPer100g ?? 0),
    fiberPer100g: args.fiberPer100g != null ? Number(args.fiberPer100g) : undefined,
    sugarPer100g: args.sugarPer100g != null ? Number(args.sugarPer100g) : undefined,
    saturatedFatPer100g: args.saturatedFatPer100g != null ? Number(args.saturatedFatPer100g) : undefined,
    cholesterolPer100g: args.cholesterolPer100g != null ? Number(args.cholesterolPer100g) : undefined,
    sodiumPer100g: args.sodiumPer100g != null ? Number(args.sodiumPer100g) : undefined,
    minerals: minerals && Object.keys(minerals).length > 0 ? minerals as import("@/types/health").FoodMinerals : undefined,
    vitamins: vitamins && Object.keys(vitamins).length > 0 ? vitamins as import("@/types/health").FoodVitamins : undefined,
    healthScore: (Number(args.healthScore ?? 3) as 0|1|2|3|4|5) || 3,
    description: typeof args.description === "string" ? args.description : undefined,
    units,
    customNutrients: customNutrients && customNutrients.length > 0 ? customNutrients : undefined,
  });
  return {
    toolCallId: "",
    name: "food_db_create",
    ok: true,
    content: JSON.stringify(item),
    summary: okSummary("food_db_create", `已创建「${item.name}」`),
    card: "food-db",
    cardData: { items: [item] },
  };
}

function executeFoodDbUpdate(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const id = String(args.id ?? "");
  const item = store.findFood(id);
  if (!item) throw new Error("食品不存在");
  const patch: Record<string, unknown> = {};
  if (typeof args.name === "string") patch.name = args.name;
  if (typeof args.category === "string") patch.category = args.category;
  if (args.caloriesPer100g != null) patch.caloriesPer100g = Number(args.caloriesPer100g);
  if (args.carbsPer100g != null) patch.carbsPer100g = Number(args.carbsPer100g);
  if (args.proteinPer100g != null) patch.proteinPer100g = Number(args.proteinPer100g);
  if (args.fatPer100g != null) patch.fatPer100g = Number(args.fatPer100g);
  if (args.fiberPer100g != null) patch.fiberPer100g = Number(args.fiberPer100g);
  if (args.sugarPer100g != null) patch.sugarPer100g = Number(args.sugarPer100g);
  if (args.saturatedFatPer100g != null) patch.saturatedFatPer100g = Number(args.saturatedFatPer100g);
  if (args.cholesterolPer100g != null) patch.cholesterolPer100g = Number(args.cholesterolPer100g);
  if (args.sodiumPer100g != null) patch.sodiumPer100g = Number(args.sodiumPer100g);
  if (args.healthScore != null) patch.healthScore = Number(args.healthScore) as 0|1|2|3|4|5;
  if (typeof args.description === "string") patch.description = args.description;
  if (Array.isArray(args.units)) {
    patch.units = (args.units as Record<string, unknown>[]).map((u) => ({
      name: String(u.name ?? ""),
      grams: Number(u.grams ?? 0),
    }));
  }
  if (args.minerals && typeof args.minerals === "object") {
    patch.minerals = Object.fromEntries(
      Object.entries(args.minerals as Record<string, unknown>)
        .filter(([, v]) => v != null && typeof v === "number")
        .map(([k, v]) => [k, Number(v)]),
    );
  }
  if (args.vitamins && typeof args.vitamins === "object") {
    patch.vitamins = Object.fromEntries(
      Object.entries(args.vitamins as Record<string, unknown>)
        .filter(([, v]) => v != null && typeof v === "number")
        .map(([k, v]) => [k, Number(v)]),
    );
  }
  if (Array.isArray(args.customNutrients)) {
    patch.customNutrients = (args.customNutrients as Record<string, unknown>[])
      .map((n) => ({
        name: String(n.name ?? ""),
        value: Number(n.value ?? 0),
        unit: String(n.unit ?? "mg"),
      }))
      .filter((n) => n.name);
  }
  store.updateFoodItem(id, patch);
  const updated = store.findFood(id)!;
  return {
    toolCallId: "",
    name: "food_db_update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("food_db_update", `已更新「${updated.name}」`),
    card: "food-db",
    cardData: { items: [updated] },
  };
}

function executeFoodDbDelete(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const id = String(args.id ?? "");
  const item = store.findFood(id);
  if (!item) throw new Error("食品不存在");
  const title = item.name;
  store.deleteFoodItem(id);
  return {
    toolCallId: "",
    name: "food_db_delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("food_db_delete", `已删除「${title}」`),
    card: "raw",
    cardData: { deleted: true, id, title },
  };
}

// ===== 体征记录工具 =====

function executeBodyMetricsRecord(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const rec = store.addBodyMetrics({
    heightCm: typeof args.heightCm === "number" ? Number(args.heightCm) : undefined,
    weightKg: typeof args.weightKg === "number" ? Number(args.weightKg) : undefined,
    bodyFatPercent: typeof args.bodyFatPercent === "number" ? Number(args.bodyFatPercent) : undefined,
  });
  return {
    toolCallId: "",
    name: "body_metrics_record",
    ok: true,
    content: JSON.stringify(rec),
    summary: okSummary(
      "body_metrics_record",
      `已记录 BMI ${rec.bmi?.toFixed(1) ?? "--"}${rec.bodyFatPercent ? ` · 体脂 ${rec.bodyFatPercent}%` : ""}`,
    ),
    card: "body-metrics",
    cardData: { record: rec },
  };
}

// ===== 历史/目标查询工具 =====

function executeWorkoutRecordsList(args: AnyParams): ToolResult {
  const store = useWorkoutStatsStore();
  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
  const records = [...store.records]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      courseName: r.courseName,
      courseCategory: r.courseCategory,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationSec: r.durationSec,
      caloriesBurned: r.caloriesBurned,
      completedSets: r.completedSets,
      totalSets: r.totalSets,
      finished: r.finished,
    }));
  return {
    toolCallId: "",
    name: "workout_records_list",
    ok: true,
    content: JSON.stringify(records),
    summary: okSummary("workout_records_list", `最近 ${records.length} 次运动记录`),
    card: "workout-history",
    cardData: { records },
  };
}

function executeWorkoutRecordDetail(args: AnyParams): ToolResult {
  const store = useWorkoutStatsStore();
  const id = String(args.id ?? "");
  const record = store.getRecord(id);
  if (!record) {
    return {
      toolCallId: "",
      name: "workout_record_detail",
      ok: false,
      content: JSON.stringify({ error: `记录 ${id} 不存在` }),
      summary: okSummary("workout_record_detail", `记录 ${id} 不存在`),
      card: "raw",
      cardData: { error: `记录 ${id} 不存在` },
    };
  }
  return {
    toolCallId: "",
    name: "workout_record_detail",
    ok: true,
    content: JSON.stringify(record),
    summary: okSummary(
      "workout_record_detail",
      `${record.courseName} · ${Math.round(record.durationSec / 60)}分钟 · ${record.caloriesBurned}千卡`,
    ),
    card: "workout-history",
    cardData: { record },
  };
}

function executeNutritionTargetGet(): ToolResult {
  const userStore = useUserStore();
  const target = userStore.nutritionTarget;
  const waterGoalMl = userStore.waterGoalMl;
  const dietGoal = userStore.profile.dietGoal;
  const activityLevel = userStore.profile.activityLevel;
  return {
    toolCallId: "",
    name: "nutrition_target_get",
    ok: true,
    content: JSON.stringify({ target, waterGoalMl, dietGoal, activityLevel }),
    summary: okSummary("nutrition_target_get", `每日营养目标`),
    card: "nutrition",
    cardData: { target, waterGoalMl, dietGoal, activityLevel },
  };
}

function executeNutritionTargetSet(args: AnyParams): ToolResult {
  const userStore = useUserStore();
  const validDietGoals: DietGoal[] = ["lose", "maintain", "gain"];
  const validActivityLevels: ActivityLevel[] = ["sedentary", "light", "moderate", "active", "very_active"];
  const dietGoalRaw = typeof args.dietGoal === "string" ? args.dietGoal : undefined;
  const activityRaw = typeof args.activityLevel === "string" ? args.activityLevel : undefined;

  if (dietGoalRaw && !validDietGoals.includes(dietGoalRaw as DietGoal)) {
    return {
      toolCallId: "",
      name: "nutrition_target_set",
      ok: false,
      content: JSON.stringify({ error: `无效的 dietGoal: ${dietGoalRaw}，可选: lose/maintain/gain` }),
      summary: okSummary("nutrition_target_set", `无效的 dietGoal`),
      card: "raw",
      cardData: { error: `无效的 dietGoal: ${dietGoalRaw}` },
    };
  }
  if (activityRaw && !validActivityLevels.includes(activityRaw as ActivityLevel)) {
    return {
      toolCallId: "",
      name: "nutrition_target_set",
      ok: false,
      content: JSON.stringify({ error: `无效的 activityLevel: ${activityRaw}，可选: sedentary/light/moderate/active/very_active` }),
      summary: okSummary("nutrition_target_set", `无效的 activityLevel`),
      card: "raw",
      cardData: { error: `无效的 activityLevel: ${activityRaw}` },
    };
  }
  if (!dietGoalRaw && !activityRaw) {
    return {
      toolCallId: "",
      name: "nutrition_target_set",
      ok: false,
      content: JSON.stringify({ error: "至少需要提供 dietGoal 或 activityLevel 中的一个" }),
      summary: okSummary("nutrition_target_set", `未提供任何参数`),
      card: "raw",
      cardData: { error: "至少需要提供 dietGoal 或 activityLevel 中的一个" },
    };
  }

  const patch: Partial<{ dietGoal: DietGoal; activityLevel: ActivityLevel }> = {};
  if (dietGoalRaw) patch.dietGoal = dietGoalRaw as DietGoal;
  if (activityRaw) patch.activityLevel = activityRaw as ActivityLevel;
  userStore.setProfile(patch);

  const target = userStore.nutritionTarget;
  const waterGoalMl = userStore.waterGoalMl;
  const dietGoal = userStore.profile.dietGoal;
  const activityLevel = userStore.profile.activityLevel;
  return {
    toolCallId: "",
    name: "nutrition_target_set",
    ok: true,
    content: JSON.stringify({ target, waterGoalMl, dietGoal, activityLevel }),
    summary: okSummary("nutrition_target_set", `已更新营养目标`),
    card: "nutrition",
    cardData: { target, waterGoalMl, dietGoal, activityLevel },
  };
}

function executeBodyMetricsHistory(args: AnyParams): ToolResult {
  const store = useHealthDataStore();
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
  const records = [...store.bodyMetrics]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      weightKg: r.weightKg,
      bodyFatPercent: r.bodyFatPercent,
      bmi: r.bmi,
      timestamp: r.timestamp,
    }));
  return {
    toolCallId: "",
    name: "body_metrics_history",
    ok: true,
    content: JSON.stringify(records),
    summary: okSummary("body_metrics_history", `最近身体指标`),
    card: "body-metrics",
    cardData: { records },
  };
}

// ===== 爬虫工具（Bing 搜索 + URL 抓取） =====

const BING_SEARCH_URL = "https://cn.bing.com/search?q=";

interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 从 Bing 搜索结果 HTML 解析条目。使用 DOMParser，仅取自然结果（b_algo）。 */
function parseBingResults(html: string): WebSearchItem[] {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items: WebSearchItem[] = [];
    const nodes = doc.querySelectorAll("li.b_algo");
    nodes.forEach((li) => {
      const a = li.querySelector("h2 a");
      const href = a?.getAttribute("href") ?? "";
      const title = a?.textContent?.trim() ?? "";
      // 摘要：b_caption > p 或 b_lineclamp*
      const cap = li.querySelector(".b_caption p") || li.querySelector(".b_lineclamp1, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4");
      const snippet = cap?.textContent?.trim() ?? "";
      if (title && href) {
        items.push({ title, url: href, snippet });
      }
    });
    return items;
  } catch {
    return [];
  }
}

/** 估算 HTML 正文文本（去标签、压缩空白），用于 web_fetch 返回摘要。 */
function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // 移除脚本/样式/nav/footer
    doc.querySelectorAll("script,style,nav,footer,header,aside,form,noscript").forEach((n) => n.remove());
    const text = doc.body?.textContent ?? "";
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

async function executeWebSearch(args: AnyParams): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query 不能为空");
  const count = Math.min(Math.max(Number(args.count ?? 8), 1), 20);
  const url = `${BING_SEARCH_URL}${encodeURIComponent(query)}`;
  let html: string;
  try {
    html = await invoke<string>("http_fetch", { url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Bing 搜索请求失败：${msg}（需在 Tauri 桌面环境运行）`);
  }
  const items = parseBingResults(html).slice(0, count);
  if (!items.length) {
    return {
      toolCallId: "",
      name: "web_search",
      ok: true,
      content: JSON.stringify({ query, count: 0, items: [] }),
      summary: okSummary("web_search", `「${query}」未抓取到结果`),
      card: "raw",
      cardData: { query, count: 0, items: [] },
    };
  }
  return {
    toolCallId: "",
    name: "web_search",
    ok: true,
    content: JSON.stringify({ query, count: items.length, items }),
    summary: okSummary("web_search", `「${query}」共 ${items.length} 条结果`),
    card: "raw",
    cardData: { query, count: items.length, items },
  };
}

async function executeWebFetch(args: AnyParams): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url 不能为空");
  if (!/^https?:\/\//.test(url)) throw new Error("仅支持 http/https");
  const maxChars = Math.min(Math.max(Number(args.maxChars ?? 6000), 500), 20000);
  let html: string;
  try {
    html = await invoke<string>("http_fetch", { url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`抓取失败：${msg}`);
  }
  const text = htmlToText(html).slice(0, maxChars);
  return {
    toolCallId: "",
    name: "web_fetch",
    ok: true,
    content: JSON.stringify({ url, length: text.length, text }),
    summary: okSummary("web_fetch", `抓取 ${text.length} 字符`),
    card: "raw",
    cardData: { url, length: text.length, text },
  };
}

async function dispatch(name: string, args: AnyParams): Promise<ToolResult> {
  switch (name) {
    case "course_list": return executeCourseList(args);
    case "course_get": return executeCourseGet(args);
    case "course_create": return executeCourseCreate(args);
    case "course_update": return executeCourseUpdate(args);
    case "course_delete": return executeCourseDelete(args);
    case "exercise_list": return executeExerciseList(args);
    case "exercise_create": return executeExerciseCreate(args);
    case "exercise_update": return executeExerciseUpdate(args);
    case "exercise_delete": return executeExerciseDelete(args);
    case "stats_get": return executeStatsGet();
    case "workout_current_get": return executeWorkoutCurrentGet();
    case "workout_step_skip": return executeWorkoutStepSkip();
    case "workout_step_adjust_temp": return executeWorkoutStepAdjustTemp(args);
    case "workout_course_adjust_permanent": return executeWorkoutCourseAdjustPermanent(args);
    case "app_config_get": return executeAppConfigGet();
    case "app_config_update": return executeAppConfigUpdate(args);
    case "todo_list": return executeTodoList(args);
    case "todo_create": return executeTodoCreate(args);
    case "todo_update": return executeTodoUpdate(args);
    case "todo_delete": return executeTodoDelete(args);
    case "todo_toggle_done": return executeTodoToggleDone(args);
    case "todo_subtask_add": return executeTodoSubtaskAdd(args);
    case "todo_subtask_toggle": return executeTodoSubtaskToggle(args);
    case "todo_subtask_remove": return executeTodoSubtaskRemove(args);
    case "todo_category_list": return executeTodoCategoryList();
    case "todo_category_create": return executeTodoCategoryCreate(args);
    case "todo_category_update": return executeTodoCategoryUpdate(args);
    case "todo_category_delete": return executeTodoCategoryDelete(args);
    case "todo_move_category": return executeTodoMoveCategory(args);
    case "water_add": return executeWaterAdd(args);
    case "water_today": return executeWaterToday();
    case "food_record_add": return executeFoodRecordAdd(args);
    case "food_today": return executeFoodToday();
    case "food_db_list": return executeFoodDbList(args);
    case "food_db_create": return executeFoodDbCreate(args);
    case "food_db_update": return executeFoodDbUpdate(args);
    case "food_db_delete": return executeFoodDbDelete(args);
    case "body_metrics_record": return executeBodyMetricsRecord(args);
    case "workout_records_list": return executeWorkoutRecordsList(args);
    case "workout_record_detail": return executeWorkoutRecordDetail(args);
    case "nutrition_target_get": return executeNutritionTargetGet();
    case "nutrition_target_set": return executeNutritionTargetSet(args);
    case "body_metrics_history": return executeBodyMetricsHistory(args);
    case "web_search": return await executeWebSearch(args);
    case "web_fetch": return await executeWebFetch(args);
    default: throw new Error(`未知工具: ${name}`);
  }
}

/**
 * 包装单个工具的 execute：
 * - 失败时不抛错（避免 pi 重建 toolResult 时丢失 details）；
 * - 错误信息通过 content 文本反馈给 LLM，details.ok=false 标记给 UI。
 */
function wrapExecuteRich(name: string): AgentTool["execute"] {
  return async (_toolCallId, params) => {
    let result: ToolResult;
    try {
      result = await dispatch(name, params as AnyParams);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        toolCallId: _toolCallId,
        name,
        ok: false,
        content: JSON.stringify({ error: msg }),
        summary: `${name} 失败: ${msg}`,
        card: "raw",
        cardData: { error: msg },
      };
    }
    return toToolResult(name, result);
  };
}

// ===== Tool definitions =====

/** 非运动模式工具集（课程/动作/统计/待办/饮水/饮食/食品库/体征/爬虫等） */
export const PI_TOOLS_CORE: AgentTool<any, PiToolDetails>[] = [
  {
    name: "course_list",
    label: "查询课程",
    description: "列出所有课程，可选按部位(category)或难度(difficulty)筛选。返回课程摘要列表。",
    parameters: Type.Object({
      category: Type.Optional(CourseCategoryEnum),
      difficulty: Type.Optional(CourseDifficultyEnum),
    }),
    execute: wrapExecuteRich("course_list"),
  },
  {
    name: "course_get",
    label: "课程详情",
    description: "按 id 获取单个课程详情（含训练组步骤）。",
    parameters: Type.Object({
      id: Type.String({ description: "课程 id" }),
    }),
    execute: wrapExecuteRich("course_get"),
  },
  {
    name: "course_create",
    label: "创建课程",
    description: "创建新课程。每个 step 必须仔细、详细填写 exerciseId/exerciseName/sets/reps/restSec/phase，以及 weight(配重) 和 cautions(注意事项)。会持久化到课程库。返回创建后的课程。",
    parameters: Type.Object({
      name: Type.String(),
      description: Type.Optional(Type.String()),
      difficulty: CourseDifficultyEnum,
      category: CourseCategoryEnum,
      estimatedMinutes: Type.Optional(Type.Number()),
      estimatedCalories: Type.Optional(Type.Number()),
      pinned: Type.Optional(Type.Boolean()),
      steps: Type.Array(StepSchema),
    }),
    execute: wrapExecuteRich("course_create"),
  },
  {
    name: "course_update",
    label: "更新课程",
    description: "更新已有课程。仅传需要修改的字段。涉及 step 时必须仔细、详细填写 exerciseId/exerciseName/sets/reps/restSec/phase，以及 weight(配重) 和 cautions(注意事项)。返回更新后的课程。",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      difficulty: Type.Optional(CourseDifficultyEnum),
      category: Type.Optional(CourseCategoryEnum),
      estimatedMinutes: Type.Optional(Type.Number()),
      estimatedCalories: Type.Optional(Type.Number()),
      pinned: Type.Optional(Type.Boolean()),
      steps: Type.Optional(Type.Array(StepSchema)),
    }),
    execute: wrapExecuteRich("course_update"),
  },
  {
    name: "course_delete",
    label: "删除课程",
    description: "按 id 删除课程。不可撤销。",
    parameters: Type.Object({
      id: Type.String(),
    }),
    execute: wrapExecuteRich("course_delete"),
  },
  {
    name: "exercise_list",
    label: "查询动作",
    description: "列出动作库，可选按部位(muscleGroup)或类别(category)筛选。",
    parameters: Type.Object({
      muscleGroup: Type.Optional(MuscleGroupEnum),
      category: Type.Optional(ExerciseCategoryEnum),
    }),
    execute: wrapExecuteRich("exercise_list"),
  },
  {
    name: "exercise_create",
    label: "新增动作",
    description: "新增自定义动作。必须仔细、详细填写：所需器械、目标肌群、动作描述及执行细节（起始姿势/动作路径/呼吸/节奏）、注意事项/常见错误。会持久化到动作库。",
    parameters: Type.Object({
      name: Type.String(),
      category: ExerciseCategoryEnum,
      muscleGroup: MuscleGroupEnum,
      difficulty: ExerciseDifficultyEnum,
      equipment: Type.Optional(Type.String({ description: "所需器械，如 一对哑铃/杠铃+卧推架，徒手填 '徒手'" })),
      description: Type.Optional(Type.String({ description: "一句话概述这个动作锻炼什么" })),
      executionDetails: Type.Optional(Type.String({ description: "动作要领/执行细节（起始姿势/动作路径/呼吸/节奏）" })),
      cautions: Type.Optional(Type.String({ description: "注意事项/常见错误/安全提示" })),
    }),
    execute: wrapExecuteRich("exercise_create"),
  },
  {
    name: "exercise_update",
    label: "更新动作",
    description: "更新已有动作。仅传需要修改的字段。必须仔细、详细填写：所需器械、目标肌群、动作描述及执行细节（起始姿势/动作路径/呼吸/节奏）、注意事项/常见错误。",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      category: Type.Optional(ExerciseCategoryEnum),
      muscleGroup: Type.Optional(MuscleGroupEnum),
      difficulty: Type.Optional(ExerciseDifficultyEnum),
      equipment: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      executionDetails: Type.Optional(Type.String()),
      cautions: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("exercise_update"),
  },
  {
    name: "exercise_delete",
    label: "删除动作",
    description: "按 id 删除自定义动作。预设动作不可删。",
    parameters: Type.Object({
      id: Type.String(),
    }),
    execute: wrapExecuteRich("exercise_delete"),
  },
  {
    name: "stats_get",
    label: "运动统计",
    description: "获取当前用户的运动统计（总训练次数、时长、热量、连续天数、近7/30天趋势、按部位/难度分布）。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("stats_get"),
  },
  {
    name: "app_config_get",
    label: "获取应用配置",
    description: "获取用户配置（昵称/性别/年龄/身高/体重/BMI）。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("app_config_get"),
  },
  {
    name: "app_config_update",
    label: "更新应用配置",
    description: "更新用户配置。可改 nickname/gender/birthday/height/weight/targetWeight。",
    parameters: Type.Object({
      nickname: Type.Optional(Type.String()),
      gender: Type.Optional(Type.Union([Type.Literal("male"), Type.Literal("female"), Type.Literal("other")])),
      birthday: Type.Optional(Type.String({ description: "YYYY-MM-DD 生日" })),
      height: Type.Optional(Type.Number({ description: "cm" })),
      weight: Type.Optional(Type.Number({ description: "kg" })),
      targetWeight: Type.Optional(Type.Number({ description: "kg 目标体重" })),
    }),
    execute: wrapExecuteRich("app_config_update"),
  },
  // ===== TodoList 工具 =====
  {
    name: "todo_list",
    label: "查询待办",
    description: "列出待办事项。默认今日（按循环规则展开），传 includeAll=true 列全部，传 date=YYYY-MM-DD 查指定日期。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD，默认今日" })),
      includeAll: Type.Optional(Type.Boolean({ description: "true 列全部待办" })),
    }),
    execute: wrapExecuteRich("todo_list"),
  },
  {
    name: "todo_create",
    label: "创建待办",
    description: "创建待办事项。kind: all-day/deadline/time-range。priority: low/normal/high。urgent 用于四象限视图。recurrence.type: daily/weekly/monthly/weekdays/custom。subtasks 为子任务数组。categoryId 可挂分类。",
    parameters: Type.Object({
      title: Type.String(),
      note: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([
        Type.Literal("all-day"),
        Type.Literal("deadline"),
        Type.Literal("time-range"),
      ])),
      dueDate: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD，所有kind都需要。deadline时为截止日期，all-day时为待办日期，time-range时为日期" })),
      dueTime: Type.Optional(Type.String({ description: "截止时间 HH:mm，仅 kind=deadline 时传" })),
      startTime: Type.Optional(Type.String({ description: "开始时间 HH:mm，仅 kind=time-range 时传" })),
      endTime: Type.Optional(Type.String({ description: "结束时间 HH:mm，仅 kind=time-range 时传" })),
      recurrence: Type.Optional(Type.Object({
        type: Type.Union([
          Type.Literal("daily"),
          Type.Literal("weekly"),
          Type.Literal("monthly"),
          Type.Literal("weekdays"),
          Type.Literal("custom"),
        ]),
        daysOfWeek: Type.Optional(Type.Array(Type.Number())),
        dayOfMonth: Type.Optional(Type.Number()),
        interval: Type.Optional(Type.Number()),
        until: Type.Optional(Type.String()),
      })),
      checkin: Type.Optional(Type.Boolean({ description: "true 为每日打卡式" })),
      subtasks: Type.Optional(Type.Array(Type.Object({
        title: Type.String(),
        countMin: Type.Optional(Type.Number()),
        countMax: Type.Optional(Type.Number()),
        unit: Type.Optional(Type.String()),
      }))),
      location: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("normal"),
        Type.Literal("high"),
      ])),
      urgent: Type.Optional(Type.Boolean()),
      categoryId: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("todo_create"),
  },
  {
    name: "todo_update",
    label: "更新待办",
    description: "更新已有待办。仅传需要修改的字段。done 设为 true/false 切换完成状态。",
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([
        Type.Literal("all-day"),
        Type.Literal("deadline"),
        Type.Literal("time-range"),
      ])),
      dueDate: Type.Optional(Type.String()),
      dueTime: Type.Optional(Type.String()),
      startTime: Type.Optional(Type.String()),
      endTime: Type.Optional(Type.String()),
      recurrence: Type.Optional(Type.Object({
        type: Type.Union([
          Type.Literal("daily"),
          Type.Literal("weekly"),
          Type.Literal("monthly"),
          Type.Literal("weekdays"),
          Type.Literal("custom"),
        ]),
        daysOfWeek: Type.Optional(Type.Array(Type.Number())),
        dayOfMonth: Type.Optional(Type.Number()),
        interval: Type.Optional(Type.Number()),
        until: Type.Optional(Type.String()),
      })),
      checkin: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("normal"),
        Type.Literal("high"),
      ])),
      urgent: Type.Optional(Type.Boolean()),
      categoryId: Type.Optional(Type.String()),
      done: Type.Optional(Type.Boolean()),
    }),
    execute: wrapExecuteRich("todo_update"),
  },
  {
    name: "todo_delete",
    label: "删除待办",
    description: "按 id 删除待办。",
    parameters: Type.Object({ id: Type.String() }),
    execute: wrapExecuteRich("todo_delete"),
  },
  {
    name: "todo_toggle_done",
    label: "切换待办完成",
    description: "切换待办完成/未完成状态。",
    parameters: Type.Object({ id: Type.String() }),
    execute: wrapExecuteRich("todo_toggle_done"),
  },
  {
    name: "todo_subtask_add",
    label: "添加子任务",
    description: "为指定待办添加一条子任务。countMin/countMax 用于数量范围（如做 10~15 页练习）。",
    parameters: Type.Object({
      todoId: Type.String(),
      title: Type.String(),
      countMin: Type.Optional(Type.Number()),
      countMax: Type.Optional(Type.Number()),
      unit: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("todo_subtask_add"),
  },
  {
    name: "todo_subtask_toggle",
    label: "切换子任务完成",
    description: "切换指定待办的指定子任务完成状态。",
    parameters: Type.Object({ todoId: Type.String(), subId: Type.String() }),
    execute: wrapExecuteRich("todo_subtask_toggle"),
  },
  {
    name: "todo_subtask_remove",
    label: "删除子任务",
    description: "删除指定待办下的指定子任务。",
    parameters: Type.Object({ todoId: Type.String(), subId: Type.String() }),
    execute: wrapExecuteRich("todo_subtask_remove"),
  },
  {
    name: "todo_category_list",
    label: "查询待办分类",
    description: "列出所有待办分类（含预置 + 自定义），返回每个分类下待办数。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("todo_category_list"),
  },
  {
    name: "todo_category_create",
    label: "创建待办分类",
    description: "创建一个自定义待办分类。icon 为 emoji，name 为中文短名。",
    parameters: Type.Object({
      name: Type.String(),
      icon: Type.Optional(Type.String({ description: "emoji，默认 🏷️" })),
      color: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("todo_category_create"),
  },
  {
    name: "todo_category_update",
    label: "更新待办分类",
    description: "更新自定义分类（预置分类不可改名）。仅传需要修改的字段。",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("todo_category_update"),
  },
  {
    name: "todo_category_delete",
    label: "删除待办分类",
    description: "删除自定义分类。该分类下待办自动迁移到默认分类。预置分类不可删。",
    parameters: Type.Object({ id: Type.String() }),
    execute: wrapExecuteRich("todo_category_delete"),
  },
  {
    name: "todo_move_category",
    label: "移动待办到分类",
    description: "把指定待办移到指定分类。",
    parameters: Type.Object({ todoId: Type.String(), categoryId: Type.String() }),
    execute: wrapExecuteRich("todo_move_category"),
  },
  // ===== 饮水工具 =====
  {
    name: "water_add",
    label: "记录饮水",
    description: "记录一次饮水量（毫升）。会叠加到今日总量。",
    parameters: Type.Object({
      amount: Type.Number({ description: "毫升" }),
    }),
    execute: wrapExecuteRich("water_add"),
  },
  {
    name: "water_today",
    label: "今日饮水",
    description: "获取今日饮水总量与目标。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("water_today"),
  },
  // ===== 饮食记录工具 =====
  {
    name: "food_record_add",
    label: "记录饮食",
    description: "记录一次饮食。优先用 foodId 引用食品库自动计算营养；也可手动传 foodName + grams + 各营养值。",
    parameters: Type.Object({
      foodId: Type.Optional(Type.String({ description: "食品库 id" })),
      foodName: Type.Optional(Type.String({ description: "无 foodId 时必填" })),
      grams: Type.Number({ description: "克数" }),
      calories: Type.Optional(Type.Number({ description: "无 foodId 时手动填千卡" })),
      carbs: Type.Optional(Type.Number()),
      protein: Type.Optional(Type.Number()),
      fat: Type.Optional(Type.Number()),
    }),
    execute: wrapExecuteRich("food_record_add"),
  },
  {
    name: "food_today",
    label: "今日饮食",
    description: "获取今日所有饮食记录与热量/碳水/蛋白质/脂肪汇总。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("food_today"),
  },
  // ===== 食品库 CRUD =====
  {
    name: "food_db_list",
    label: "查询食品库",
    description: "搜索食品库。query 按名称/分类模糊匹配。返回每 100g 营养信息与可用单位。",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("food_db_list"),
  },
  {
    name: "food_db_create",
    label: "新增食品",
    description: "新增自定义食品。营养以每 100g 为基准。healthScore 0(慎食)-5(极佳)。minerals 含钙铁镁磷钾钠锌，vitamins 含A/C/D/E/K/B1/B2/B3/B6/B12/叶酸，customNutrients 用于咖啡因等自定义项。units 为可用单位（如 个/杯/两 折算克数）。",
    parameters: Type.Object({
      name: Type.String(),
      category: Type.Optional(Type.String()),
      caloriesPer100g: Type.Number(),
      carbsPer100g: Type.Number(),
      proteinPer100g: Type.Number(),
      fatPer100g: Type.Number(),
      fiberPer100g: Type.Optional(Type.Number({ description: "膳食纤维 g/100g" })),
      sugarPer100g: Type.Optional(Type.Number({ description: "糖 g/100g" })),
      saturatedFatPer100g: Type.Optional(Type.Number({ description: "饱和脂肪 g/100g" })),
      cholesterolPer100g: Type.Optional(Type.Number({ description: "胆固醇 mg/100g" })),
      sodiumPer100g: Type.Optional(Type.Number({ description: "钠 mg/100g" })),
      minerals: Type.Optional(MineralsSchema),
      vitamins: Type.Optional(VitaminsSchema),
      customNutrients: Type.Optional(Type.Array(CustomNutrientSchema, { description: "自定义营养素，如咖啡因" })),
      healthScore: Type.Optional(Type.Union([
        Type.Literal(0), Type.Literal(1), Type.Literal(2),
        Type.Literal(3), Type.Literal(4), Type.Literal(5),
      ], { description: "健康评分 0慎食-5极佳，默认3" })),
      description: Type.Optional(Type.String({ description: "食品描述/备注" })),
      units: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        grams: Type.Number(),
      }))),
    }),
    execute: wrapExecuteRich("food_db_create"),
  },
  {
    name: "food_db_update",
    label: "更新食品",
    description: "更新自定义食品。预设食品也可改（运行时），仅传需修改字段。",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      caloriesPer100g: Type.Optional(Type.Number()),
      carbsPer100g: Type.Optional(Type.Number()),
      proteinPer100g: Type.Optional(Type.Number()),
      fatPer100g: Type.Optional(Type.Number()),
      fiberPer100g: Type.Optional(Type.Number()),
      sugarPer100g: Type.Optional(Type.Number()),
      saturatedFatPer100g: Type.Optional(Type.Number()),
      cholesterolPer100g: Type.Optional(Type.Number()),
      sodiumPer100g: Type.Optional(Type.Number()),
      minerals: Type.Optional(MineralsSchema),
      vitamins: Type.Optional(VitaminsSchema),
      customNutrients: Type.Optional(Type.Array(CustomNutrientSchema)),
      healthScore: Type.Optional(Type.Union([
        Type.Literal(0), Type.Literal(1), Type.Literal(2),
        Type.Literal(3), Type.Literal(4), Type.Literal(5),
      ])),
      description: Type.Optional(Type.String()),
      units: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        grams: Type.Number(),
      }))),
    }),
    execute: wrapExecuteRich("food_db_update"),
  },
  {
    name: "food_db_delete",
    label: "删除食品",
    description: "按 id 删除自定义食品。预设食品不可删。",
    parameters: Type.Object({ id: Type.String() }),
    execute: wrapExecuteRich("food_db_delete"),
  },
  // ===== 体征记录 =====
  {
    name: "body_metrics_record",
    label: "记录体征",
    description: "记录身高/体重/体脂率，自动计算 BMI。仅传需更新的字段，未传字段沿用上次记录。",
    parameters: Type.Object({
      heightCm: Type.Optional(Type.Number({ description: "cm" })),
      weightKg: Type.Optional(Type.Number({ description: "kg" })),
      bodyFatPercent: Type.Optional(Type.Number({ description: "体脂率 %" })),
    }),
    execute: wrapExecuteRich("body_metrics_record"),
  },
  // ===== 历史/目标查询 =====
  {
    name: "workout_records_list",
    label: "运动记录列表",
    description: "列出最近的运动记录（按开始时间倒序）。返回 id/课程名/分类/起止时间/时长/热量/组数/是否完成。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条目数，默认 10，最大 50" })),
    }),
    execute: wrapExecuteRich("workout_records_list"),
  },
  {
    name: "workout_record_detail",
    label: "运动记录详情",
    description: "按 id 获取单条运动记录详情（含每步执行明细 steps）。",
    parameters: Type.Object({
      id: Type.String({ description: "记录 id" }),
    }),
    execute: wrapExecuteRich("workout_record_detail"),
  },
  {
    name: "nutrition_target_get",
    label: "每日营养目标",
    description: "获取每日营养目标（热量/碳水/蛋白/脂肪）、饮水目标、饮食目标与活动水平。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("nutrition_target_get"),
  },
  {
    name: "nutrition_target_set",
    label: "设置营养目标",
    description: "修改每日营养目标。通过调整饮食目标(lose/maintain/gain)和活动水平(sedentary/light/moderate/active/very_active)来重新计算热量/碳水/蛋白质/脂肪目标。不传的参数保持不变。",
    parameters: Type.Object({
      dietGoal: Type.Optional(Type.String({ description: "饮食目标: lose(减脂)/maintain(维持)/gain(增肌)" })),
      activityLevel: Type.Optional(Type.String({ description: "活动水平: sedentary(久坐)/light(轻度)/moderate(中度)/active(活跃)/very_active(非常活跃)" })),
    }),
    execute: wrapExecuteRich("nutrition_target_set"),
  },
  {
    name: "body_metrics_history",
    label: "体征历史",
    description: "获取最近的体征记录（体重/体脂/BMI/时间戳，按时间倒序）。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条目数，默认 20，最大 100" })),
    }),
    execute: wrapExecuteRich("body_metrics_history"),
  },
  // ===== 爬虫工具 =====
  {
    name: "web_search",
    label: "网页搜索",
    description:
      "使用 Bing 搜索引擎（https://cn.bing.com/search?q=）检索互联网信息。返回标题/URL/摘要列表。当用户询问最新资讯、外部资料或你知识范围外的事实时使用。需在 Tauri 桌面环境运行。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      count: Type.Optional(Type.Number({ description: "返回条目数，默认 8，最大 20" })),
    }),
    execute: wrapExecuteRich("web_search"),
  },
  {
    name: "web_fetch",
    label: "抓取网页",
    description:
      "抓取指定 URL 的网页正文文本（去标签后的纯文本）。用于在 web_search 后深入阅读某条结果。仅支持 http/https。",
    parameters: Type.Object({
      url: Type.String({ description: "完整 URL（http/https）" }),
      maxChars: Type.Optional(Type.Number({ description: "返回文本最大字符数，默认 6000，最大 20000" })),
    }),
    execute: wrapExecuteRich("web_fetch"),
  },
];

/** 运动模式工具集（仅在运动模式 AI 聊天中可用） */
export const PI_TOOLS_WORKOUT: AgentTool<any, PiToolDetails>[] = [
  {
    name: "workout_current_get",
    label: "当前训练状态",
    description: "获取当前进行中的训练的完整状态：课程名/当前步骤/器械/肌群/配重/组数/剩余时间等。运动模式下询问动作细节时调用。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("workout_current_get"),
  },
  {
    name: "workout_step_skip",
    label: "跳过当前步",
    description: "跳过当前训练步骤（小休息/组间休息/当前组）。仅在用户明确要求时调用。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("workout_step_skip"),
  },
  {
    name: "workout_step_adjust_temp",
    label: "临时调整当前步",
    description: "临时调整当前训练步骤（仅本次训练有效，不写回课程库）。可改 sets/reps/durationSec/restSec。",
    parameters: Type.Object({
      sets: Type.Optional(Type.Number({ description: "新的组数" })),
      reps: Type.Optional(Type.Number({ description: "新的每组次数" })),
      durationSec: Type.Optional(Type.Number({ description: "新的每组时长（秒）" })),
      restSec: Type.Optional(Type.Number({ description: "新的组间休息秒数" })),
    }),
    execute: wrapExecuteRich("workout_step_adjust_temp"),
  },
  {
    name: "workout_course_adjust_permanent",
    label: "永久调整课程",
    description: "把对课程步骤的修改写回课程库（影响后续训练）。需指定 stepIndex（0-based）。可改 sets/reps/durationSec/restSec/weight/note/cautions。",
    parameters: Type.Object({
      stepIndex: Type.Optional(Type.Number({ description: "步骤索引（0-based，默认当前步）" })),
      sets: Type.Optional(Type.Number()),
      reps: Type.Optional(Type.Number()),
      durationSec: Type.Optional(Type.Number()),
      restSec: Type.Optional(Type.Number()),
      weight: Type.Optional(Type.String({ description: "配重描述，如 20kg / 自重" })),
      note: Type.Optional(Type.String()),
      cautions: Type.Optional(Type.String({ description: "步骤级注意事项，覆盖动作默认 cautions" })),
    }),
    execute: wrapExecuteRich("workout_course_adjust_permanent"),
  },
];

/** 完整工具集（向后兼容） */
export const PI_TOOLS: AgentTool<any, PiToolDetails>[] = [...PI_TOOLS_CORE, ...PI_TOOLS_WORKOUT];
