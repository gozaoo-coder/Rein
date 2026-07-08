/**
 * AI 工具桥接 (类 MCP 工具)
 * AI 通过 function calling 调用这些工具，对课程库/动作库做 CRUD 与查询。
 * 工具返回结构化结果，附带卡片渲染类型，供聊天界面展示精美反馈。
 */

import type { ChatCompletionTool } from "@/composables/useAiClient";
import type { ToolResult } from "@/types/ai";
import type { Course, CourseCategory, CourseDifficulty, CourseStep, StepPhase } from "@/types/course";
import type { Exercise, ExerciseCategory, ExerciseDifficulty, MuscleGroup } from "@/types/exercise";
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from "@/types/course";
import { MUSCLE_GROUP_LABEL, EXERCISE_CATEGORY_LABEL, EXERCISE_DIFFICULTY_LABEL } from "@/types/exercise";

import { useCourseStore } from "@/stores/courseStore";
import { useExerciseStore } from "@/stores/exerciseStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";

/** 工具定义（OpenAI function calling schema） */
export const AI_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "course.list",
      description: "列出所有课程，可选按部位(category)或难度(difficulty)筛选。返回课程摘要列表。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: Object.keys(CATEGORY_LABEL),
            description: "按部位筛选，留空则返回全部",
          },
          difficulty: {
            type: "string",
            enum: Object.keys(DIFFICULTY_LABEL),
            description: "按难度筛选，留空则返回全部",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "course.get",
      description: "按 id 获取单个课程详情（含训练组步骤）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "课程 id" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "course.create",
      description: "创建新课程。会持久化到课程库。返回创建后的课程。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "课程名" },
          description: { type: "string", description: "课程描述" },
          difficulty: { type: "string", enum: Object.keys(DIFFICULTY_LABEL) },
          category: { type: "string", enum: Object.keys(CATEGORY_LABEL) },
          estimatedMinutes: { type: "number", description: "预计时长（分钟）" },
          estimatedCalories: { type: "number", description: "预计热量（千卡）" },
          pinned: { type: "boolean", description: "是否置顶" },
          steps: {
            type: "array",
            description: "训练组列表",
            items: {
              type: "object",
              properties: {
                exerciseId: { type: "string" },
                exerciseName: { type: "string" },
                sets: { type: "number" },
                reps: { type: "number" },
                durationSec: { type: "number" },
                restSec: { type: "number" },
                phase: { type: "string", enum: ["warmup", "main", "stretch", "rest"] },
                note: { type: "string" },
              },
              required: ["exerciseId", "exerciseName", "sets", "restSec", "phase"],
            },
          },
        },
        required: ["name", "difficulty", "category", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "course.update",
      description: "更新已有课程。仅传需要修改的字段。返回更新后的课程。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "课程 id" },
          name: { type: "string" },
          description: { type: "string" },
          difficulty: { type: "string", enum: Object.keys(DIFFICULTY_LABEL) },
          category: { type: "string", enum: Object.keys(CATEGORY_LABEL) },
          estimatedMinutes: { type: "number" },
          estimatedCalories: { type: "number" },
          pinned: { type: "boolean" },
          steps: {
            type: "array",
            description: "如提供则整体替换训练组列表",
            items: {
              type: "object",
              properties: {
                exerciseId: { type: "string" },
                exerciseName: { type: "string" },
                sets: { type: "number" },
                reps: { type: "number" },
                durationSec: { type: "number" },
                restSec: { type: "number" },
                phase: { type: "string", enum: ["warmup", "main", "stretch", "rest"] },
                note: { type: "string" },
              },
            },
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "course.delete",
      description: "按 id 删除课程。不可撤销。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exercise.list",
      description: "列出动作库，可选按部位(muscleGroup)或类别(category)筛选。",
      parameters: {
        type: "object",
        properties: {
          muscleGroup: { type: "string", enum: Object.keys(MUSCLE_GROUP_LABEL) },
          category: { type: "string", enum: Object.keys(EXERCISE_CATEGORY_LABEL) },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exercise.create",
      description: "新增自定义动作。会持久化到动作库。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: Object.keys(EXERCISE_CATEGORY_LABEL) },
          muscleGroup: { type: "string", enum: Object.keys(MUSCLE_GROUP_LABEL) },
          difficulty: { type: "string", enum: Object.keys(EXERCISE_DIFFICULTY_LABEL) },
          equipment: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "category", "muscleGroup", "difficulty"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exercise.update",
      description: "更新已有动作。仅传需要修改的字段。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          category: { type: "string", enum: Object.keys(EXERCISE_CATEGORY_LABEL) },
          muscleGroup: { type: "string", enum: Object.keys(MUSCLE_GROUP_LABEL) },
          difficulty: { type: "string", enum: Object.keys(EXERCISE_DIFFICULTY_LABEL) },
          equipment: { type: "string" },
          description: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exercise.delete",
      description: "按 id 删除自定义动作。预设动作不可删。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stats.get",
      description: "获取当前用户的运动统计（总训练次数、时长、热量、连续天数、近7/30天趋势、按部位/难度分布）。",
      parameters: { type: "object", properties: {} },
    },
  },
];

function genId(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeStep(s: Record<string, unknown>): CourseStep {
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

/** 执行工具调用，返回 ToolResult */
export function executeToolCall(name: string, argsRaw: string): ToolResult {
  const args = parseArgs(argsRaw);
  const courseStore = useCourseStore();
  const exerciseStore = useExerciseStore();
  const statsStore = useWorkoutStatsStore();

  try {
    switch (name) {
      // ===== 课程 =====
      case "course.list": {
        const cat = args.category as CourseCategory | undefined;
        const diff = args.difficulty as CourseDifficulty | undefined;
        let list = courseStore.courses;
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
          name,
          ok: true,
          content: JSON.stringify(summary),
          summary: okSummary(name, `共 ${summary.length} 个课程`),
          card: "course-list",
          cardData: list,
        };
      }
      case "course.get": {
        const c = courseStore.getById(String(args.id ?? ""));
        if (!c) throw new Error("课程不存在");
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify(c),
          summary: okSummary(name, c.name),
          card: "course",
          cardData: c,
        };
      }
      case "course.create": {
        const steps = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]).map(normalizeStep) : [];
        const created = courseStore.createCourse({
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
          name,
          ok: true,
          content: JSON.stringify(created),
          summary: okSummary(name, `已创建「${created.name}」`),
          card: "course",
          cardData: created,
        };
      }
      case "course.update": {
        const id = String(args.id ?? "");
        const c = courseStore.getById(id);
        if (!c) throw new Error("课程不存在");
        const patch: Partial<Course> = {};
        if (typeof args.name === "string") patch.name = args.name;
        if (typeof args.description === "string") patch.description = args.description;
        if (args.difficulty) patch.difficulty = args.difficulty as CourseDifficulty;
        if (args.category) patch.category = args.category as CourseCategory;
        if (args.estimatedMinutes != null) patch.estimatedMinutes = Number(args.estimatedMinutes);
        if (args.estimatedCalories != null) patch.estimatedCalories = Number(args.estimatedCalories);
        if (typeof args.pinned === "boolean") patch.pinned = args.pinned;
        if (Array.isArray(args.steps)) patch.steps = (args.steps as Record<string, unknown>[]).map(normalizeStep);
        courseStore.updateCourse(id, patch);
        const updated = courseStore.getById(id)!;
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify(updated),
          summary: okSummary(name, `已更新「${updated.name}」`),
          card: "course",
          cardData: updated,
        };
      }
      case "course.delete": {
        const id = String(args.id ?? "");
        const c = courseStore.getById(id);
        if (!c) throw new Error("课程不存在");
        const title = c.name;
        courseStore.deleteCourse(id);
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify({ deleted: true, id }),
          summary: okSummary(name, `已删除「${title}」`),
          card: "raw",
          cardData: { deleted: true, id, title },
        };
      }

      // ===== 动作 =====
      case "exercise.list": {
        const mg = args.muscleGroup as MuscleGroup | undefined;
        const cat = args.category as ExerciseCategory | undefined;
        let list = exerciseStore.exercises;
        if (mg) list = list.filter((e) => e.muscleGroup === mg);
        if (cat) list = list.filter((e) => e.category === cat);
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify(list),
          summary: okSummary(name, `共 ${list.length} 个动作`),
          card: "exercise-list",
          cardData: list,
        };
      }
      case "exercise.create": {
        const ex = exerciseStore.createExercise({
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
          name,
          ok: true,
          content: JSON.stringify(ex),
          summary: okSummary(name, `已创建「${ex.name}」`),
          card: "exercise",
          cardData: ex,
        };
      }
      case "exercise.update": {
        const id = String(args.id ?? "");
        const ex = exerciseStore.getById(id);
        if (!ex) throw new Error("动作不存在");
        const patch: Partial<Exercise> = {};
        if (typeof args.name === "string") patch.name = args.name;
        if (args.category) patch.category = args.category as ExerciseCategory;
        if (args.muscleGroup) patch.muscleGroup = args.muscleGroup as MuscleGroup;
        if (args.difficulty) patch.difficulty = args.difficulty as ExerciseDifficulty;
        if (typeof args.equipment === "string") patch.equipment = args.equipment;
        if (typeof args.description === "string") patch.description = args.description;
        exerciseStore.updateExercise(id, patch);
        const updated = exerciseStore.getById(id)!;
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify(updated),
          summary: okSummary(name, `已更新「${updated.name}」`),
          card: "exercise",
          cardData: updated,
        };
      }
      case "exercise.delete": {
        const id = String(args.id ?? "");
        const ex = exerciseStore.getById(id);
        if (!ex) throw new Error("动作不存在");
        if (!ex.custom) throw new Error("预设动作不可删除");
        const title = ex.name;
        exerciseStore.deleteExercise(id);
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify({ deleted: true, id }),
          summary: okSummary(name, `已删除「${title}」`),
          card: "raw",
          cardData: { deleted: true, id, title },
        };
      }

      // ===== 统计 =====
      case "stats.get": {
        const s = statsStore.stats;
        return {
          toolCallId: "",
          name,
          ok: true,
          content: JSON.stringify(s),
          summary: okSummary(name, `已训练 ${s.totalSessions} 次 / ${Math.round(s.totalDurationSec / 60)} 分钟 / ${Math.round(s.totalCalories)} 千卡`),
          card: "stats",
          cardData: s,
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      toolCallId: "",
      name,
      ok: false,
      content: JSON.stringify({ error: msg }),
      summary: `${name} 失败: ${msg}`,
      card: "raw",
      cardData: { error: msg },
    };
  }
}
