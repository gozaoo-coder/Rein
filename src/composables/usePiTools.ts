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
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from "@/types/course";
import {
  MUSCLE_GROUP_LABEL,
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
} from "@/types/exercise";
import { useCourseStore } from "@/stores/courseStore";
import { useExerciseStore } from "@/stores/exerciseStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";

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
    name: "course.list",
    ok: true,
    content: JSON.stringify(summary),
    summary: okSummary("course.list", `共 ${summary.length} 个课程`),
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
    name: "course.get",
    ok: true,
    content: JSON.stringify(c),
    summary: okSummary("course.get", c.name),
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
    name: "course.create",
    ok: true,
    content: JSON.stringify(created),
    summary: okSummary("course.create", `已创建「${created.name}」`),
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
    name: "course.update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("course.update", `已更新「${updated.name}」`),
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
    name: "course.delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("course.delete", `已删除「${title}」`),
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
    name: "exercise.list",
    ok: true,
    content: JSON.stringify(list),
    summary: okSummary("exercise.list", `共 ${list.length} 个动作`),
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
    custom: true,
  });
  return {
    toolCallId: "",
    name: "exercise.create",
    ok: true,
    content: JSON.stringify(ex),
    summary: okSummary("exercise.create", `已创建「${ex.name}」`),
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
  store.updateExercise(id, patch);
  const updated = store.getById(id)!;
  return {
    toolCallId: "",
    name: "exercise.update",
    ok: true,
    content: JSON.stringify(updated),
    summary: okSummary("exercise.update", `已更新「${updated.name}」`),
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
    name: "exercise.delete",
    ok: true,
    content: JSON.stringify({ deleted: true, id }),
    summary: okSummary("exercise.delete", `已删除「${title}」`),
    card: "raw",
    cardData: { deleted: true, id, title },
  };
}

function executeStatsGet(): ToolResult {
  const store = useWorkoutStatsStore();
  const s = store.stats;
  return {
    toolCallId: "",
    name: "stats.get",
    ok: true,
    content: JSON.stringify(s),
    summary: okSummary(
      "stats.get",
      `已训练 ${s.totalSessions} 次 / ${Math.round(s.totalDurationSec / 60)} 分钟 / ${Math.round(s.totalCalories)} 千卡`,
    ),
    card: "stats",
    cardData: s,
  };
}

function dispatch(name: string, args: AnyParams): ToolResult {
  switch (name) {
    case "course.list": return executeCourseList(args);
    case "course.get": return executeCourseGet(args);
    case "course.create": return executeCourseCreate(args);
    case "course.update": return executeCourseUpdate(args);
    case "course.delete": return executeCourseDelete(args);
    case "exercise.list": return executeExerciseList(args);
    case "exercise.create": return executeExerciseCreate(args);
    case "exercise.update": return executeExerciseUpdate(args);
    case "exercise.delete": return executeExerciseDelete(args);
    case "stats.get": return executeStatsGet();
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
      result = dispatch(name, params as AnyParams);
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

export const PI_TOOLS: AgentTool<any, PiToolDetails>[] = [
  {
    name: "course.list",
    label: "查询课程",
    description: "列出所有课程，可选按部位(category)或难度(difficulty)筛选。返回课程摘要列表。",
    parameters: Type.Object({
      category: Type.Optional(CourseCategoryEnum),
      difficulty: Type.Optional(CourseDifficultyEnum),
    }),
    execute: wrapExecuteRich("course.list"),
  },
  {
    name: "course.get",
    label: "课程详情",
    description: "按 id 获取单个课程详情（含训练组步骤）。",
    parameters: Type.Object({
      id: Type.String({ description: "课程 id" }),
    }),
    execute: wrapExecuteRich("course.get"),
  },
  {
    name: "course.create",
    label: "创建课程",
    description: "创建新课程。会持久化到课程库。返回创建后的课程。",
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
    execute: wrapExecuteRich("course.create"),
  },
  {
    name: "course.update",
    label: "更新课程",
    description: "更新已有课程。仅传需要修改的字段。返回更新后的课程。",
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
    execute: wrapExecuteRich("course.update"),
  },
  {
    name: "course.delete",
    label: "删除课程",
    description: "按 id 删除课程。不可撤销。",
    parameters: Type.Object({
      id: Type.String(),
    }),
    execute: wrapExecuteRich("course.delete"),
  },
  {
    name: "exercise.list",
    label: "查询动作",
    description: "列出动作库，可选按部位(muscleGroup)或类别(category)筛选。",
    parameters: Type.Object({
      muscleGroup: Type.Optional(MuscleGroupEnum),
      category: Type.Optional(ExerciseCategoryEnum),
    }),
    execute: wrapExecuteRich("exercise.list"),
  },
  {
    name: "exercise.create",
    label: "新增动作",
    description: "新增自定义动作。会持久化到动作库。",
    parameters: Type.Object({
      name: Type.String(),
      category: ExerciseCategoryEnum,
      muscleGroup: MuscleGroupEnum,
      difficulty: ExerciseDifficultyEnum,
      equipment: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("exercise.create"),
  },
  {
    name: "exercise.update",
    label: "更新动作",
    description: "更新已有动作。仅传需要修改的字段。",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      category: Type.Optional(ExerciseCategoryEnum),
      muscleGroup: Type.Optional(MuscleGroupEnum),
      difficulty: Type.Optional(ExerciseDifficultyEnum),
      equipment: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    execute: wrapExecuteRich("exercise.update"),
  },
  {
    name: "exercise.delete",
    label: "删除动作",
    description: "按 id 删除自定义动作。预设动作不可删。",
    parameters: Type.Object({
      id: Type.String(),
    }),
    execute: wrapExecuteRich("exercise.delete"),
  },
  {
    name: "stats.get",
    label: "运动统计",
    description: "获取当前用户的运动统计（总训练次数、时长、热量、连续天数、近7/30天趋势、按部位/难度分布）。",
    parameters: Type.Object({}),
    execute: wrapExecuteRich("stats.get"),
  },
];
