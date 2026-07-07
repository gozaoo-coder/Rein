import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Exercise, ExerciseCategory, MuscleGroup } from "@/types/exercise";
import { MUSCLE_GROUP_LABEL, EXERCISE_DIFFICULTY_LABEL, EXERCISE_CATEGORY_LABEL } from "@/types/exercise";
import { presetExercises } from "@/data/presetExercises";
import { readJSON, writeJSON } from "@/composables/useStorage";

const STORAGE_KEY = "exercises";

function genId(prefix = "ex"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useExerciseStore = defineStore("exercise", () => {
  const exercises = ref<Exercise[]>([]);
  const loaded = ref(false);

  const customExercises = computed(() => exercises.value.filter((e) => e.custom));
  const presetExercisesList = computed(() => exercises.value.filter((e) => !e.custom));

  /** 按部位分组 */
  const byMuscleGroup = computed(() => {
    const map = new Map<MuscleGroup, Exercise[]>();
    for (const e of exercises.value) {
      if (!map.has(e.muscleGroup)) map.set(e.muscleGroup, []);
      map.get(e.muscleGroup)!.push(e);
    }
    return Array.from(map.entries())
      .map(([key, list]) => ({
        key,
        label: MUSCLE_GROUP_LABEL[key],
        exercises: list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  });

  /** 按类别分组（徒手/器械） */
  const byCategory = computed(() => {
    const map = new Map<ExerciseCategory, Exercise[]>();
    for (const e of exercises.value) {
      if (!map.has(e.category)) map.set(e.category, []);
      map.get(e.category)!.push(e);
    }
    return Array.from(map.entries()).map(([key, list]) => ({
      key,
      label: EXERCISE_CATEGORY_LABEL[key],
      exercises: list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    }));
  });

  function getById(id: string): Exercise | undefined {
    return exercises.value.find((e) => e.id === id);
  }

  function difficultyLabel(d: Exercise["difficulty"]): string {
    return EXERCISE_DIFFICULTY_LABEL[d];
  }

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<Exercise[]>(STORAGE_KEY);
    if (stored && stored.length > 0) {
      // 合并预设（按 id 去重，存储优先）
      const storedIds = new Set(stored.map((e) => e.id));
      const merged = [...stored];
      for (const p of presetExercises) {
        if (!storedIds.has(p.id)) merged.push({ ...p });
      }
      exercises.value = merged;
    } else {
      exercises.value = presetExercises.map((e) => ({ ...e }));
      await persist();
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(STORAGE_KEY, exercises.value);
  }

  function createExercise(input: Omit<Exercise, "id" | "createdAt" | "updatedAt" | "custom"> & { custom?: boolean }): Exercise {
    const now = Date.now();
    const ex: Exercise = {
      id: genId(),
      createdAt: now,
      updatedAt: now,
      custom: input.custom ?? true,
      ...input,
    };
    exercises.value.push(ex);
    void persist();
    return ex;
  }

  function updateExercise(id: string, patch: Partial<Exercise>): void {
    const idx = exercises.value.findIndex((e) => e.id === id);
    if (idx < 0) return;
    exercises.value[idx] = {
      ...exercises.value[idx],
      ...patch,
      id,
      updatedAt: Date.now(),
    };
    void persist();
  }

  function deleteExercise(id: string): void {
    const idx = exercises.value.findIndex((e) => e.id === id);
    if (idx < 0) return;
    // 预设动作不允许删除
    if (!exercises.value[idx].custom) return;
    exercises.value.splice(idx, 1);
    void persist();
  }

  return {
    exercises,
    customExercises,
    presetExercisesList,
    byMuscleGroup,
    byCategory,
    getById,
    difficultyLabel,
    load,
    createExercise,
    updateExercise,
    deleteExercise,
  };
});
