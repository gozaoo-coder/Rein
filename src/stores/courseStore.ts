import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Course, CourseCategory, CourseDifficulty } from "@/types/course";
import { CATEGORY_LABEL, DIFFICULTY_LABEL } from "@/types/course";
import { presetCourses } from "@/data/presetCourses";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { pushChange, pushDelete, registerSyncEntity } from "@/composables/useSyncBridge";

const STORAGE_KEY = "courses";

function genId(prefix = "course"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useCourseStore = defineStore("course", () => {
  const courses = ref<Course[]>([]);
  const loaded = ref(false);

  /** 主页置顶课程 */
  const pinnedCourses = computed(() =>
    courses.value.filter((c) => c.pinned),
  );

  /** 最近在练（按 lastPracticedAt 倒序，最多 6 个） */
  const recentCourses = computed(() =>
    courses.value
      .filter((c) => c.lastPracticedAt != null)
      .sort((a, b) => (b.lastPracticedAt ?? 0) - (a.lastPracticedAt ?? 0))
      .slice(0, 6),
  );

  /** 按难度分组（最多展示 6 个/组） */
  const coursesByDifficulty = computed(() => {
    const groups: { key: CourseDifficulty; label: string; courses: Course[] }[] = [];
    (["beginner", "intermediate", "advanced"] as CourseDifficulty[]).forEach((d) => {
      const list = courses.value
        .filter((c) => c.difficulty === d)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6);
      groups.push({ key: d, label: DIFFICULTY_LABEL[d], courses: list });
    });
    return groups;
  });

  /** 按部位/类别分组（用于二级页面"全部课程"） */
  const coursesByCategory = computed(() => {
    const map = new Map<CourseCategory, Course[]>();
    for (const c of courses.value) {
      if (!map.has(c.category)) map.set(c.category, []);
      map.get(c.category)!.push(c);
    }
    return Array.from(map.entries())
      .map(([key, list]) => ({
        key,
        label: CATEGORY_LABEL[key],
        courses: list.sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  });

  function getById(id: string): Course | undefined {
    return courses.value.find((c) => c.id === id);
  }

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<Course[]>(STORAGE_KEY);
    if (stored && stored.length > 0) {
      courses.value = stored;
    } else {
      // 首次启动：写入预设课程
      courses.value = presetCourses.map((c) => ({ ...c }));
      await persist();
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(STORAGE_KEY, courses.value);
  }

  function createCourse(input: Omit<Course, "id" | "createdAt" | "updatedAt" | "practiceCount" | "custom" | "pinned"> & { custom?: boolean; pinned?: boolean }): Course {
    const now = Date.now();
    const course: Course = {
      id: genId(),
      createdAt: now,
      updatedAt: now,
      practiceCount: 0,
      custom: input.custom ?? true,
      pinned: input.pinned ?? false,
      ...input,
    };
    courses.value.push(course);
    void persist();
    void pushChange(STORAGE_KEY, course.id, course);
    return course;
  }

  function updateCourse(id: string, patch: Partial<Course>): void {
    const idx = courses.value.findIndex((c) => c.id === id);
    if (idx < 0) return;
    courses.value[idx] = {
      ...courses.value[idx],
      ...patch,
      id,
      updatedAt: Date.now(),
    };
    void persist();
    void pushChange(STORAGE_KEY, id, courses.value[idx]);
  }

  function deleteCourse(id: string): void {
    const idx = courses.value.findIndex((c) => c.id === id);
    if (idx < 0) return;
    courses.value.splice(idx, 1);
    void persist();
    void pushDelete(STORAGE_KEY, id);
  }

  function togglePin(id: string): void {
    const c = getById(id);
    if (!c) return;
    c.pinned = !c.pinned;
    c.updatedAt = Date.now();
    void persist();
    void pushChange(STORAGE_KEY, id, c);
  }

  /** 课程被练习一次：计数 +1 + 更新时间 */
  function markPracticed(id: string): void {
    const c = getById(id);
    if (!c) return;
    c.practiceCount += 1;
    c.lastPracticedAt = Date.now();
    c.updatedAt = Date.now();
    void persist();
    void pushChange(STORAGE_KEY, id, c);
  }

  /** 课程步骤重排序 */
  function reorderSteps(courseId: string, fromIdx: number, toIdx: number): void {
    const c = getById(courseId);
    if (!c) return;
    const steps = c.steps;
    if (fromIdx < 0 || fromIdx >= steps.length) return;
    if (toIdx < 0 || toIdx >= steps.length) return;
    const [moved] = steps.splice(fromIdx, 1);
    steps.splice(toIdx, 0, moved);
    c.updatedAt = Date.now();
    void persist();
    void pushChange(STORAGE_KEY, courseId, c);
  }

  return {
    courses,
    pinnedCourses,
    recentCourses,
    coursesByDifficulty,
    coursesByCategory,
    getById,
    load,
    createCourse,
    updateCourse,
    deleteCourse,
    togglePin,
    markPracticed,
    reorderSteps,
    applyRemote,
  };
});

/** 远端同步应用：upsert / 软删除单条 course（不回推） */
async function applyRemote(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useCourseStore();
  const idx = store.courses.findIndex((c) => c.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.courses.splice(idx, 1);
      await writeJSON(STORAGE_KEY, store.courses);
    }
    return;
  }
  const course = payload as Course;
  if (!course || typeof course.id !== "string") return;
  if (idx >= 0) {
    // LWW：按 updatedAt 比较
    if (course.updatedAt > store.courses[idx].updatedAt) {
      store.courses[idx] = course;
      await writeJSON(STORAGE_KEY, store.courses);
    }
  } else {
    store.courses.push(course);
    await writeJSON(STORAGE_KEY, store.courses);
  }
}

registerSyncEntity<Course>({ kind: STORAGE_KEY, applyRemote });
