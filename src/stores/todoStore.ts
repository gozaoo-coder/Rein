/**
 * todoStore — 待办事项 Pinia store
 *
 * 支持：
 * - CRUD + 完成切换
 * - 复杂待办类型（整日/截止/时间段/循环/打卡/子任务/分类/地点/紧急度）
 * - 分类管理（CRUD + 移动）
 * - 子任务管理
 * - 按日期（考虑循环）、按分类、按四象限的查询
 * - 持久化到 Tauri storage（useStorage 桥）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  QuadrantKey,
  TodoCategory,
  TodoItem,
  TodoPriority,
  TodoSubtask,
} from "@/types/todo";
import {
  DEFAULT_CATEGORIES,
  quadrantOf,
  todoActiveOnDate,
} from "@/types/todo";
import { readJSON, writeJSON } from "@/composables/useStorage";

const TODO_KEY = "todo-items";
const CATEGORY_KEY = "todo-categories";

function genId(prefix = "todo"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 兼容旧数据：补充缺失字段 */
function migrateItem(raw: Partial<TodoItem>): TodoItem {
  const now = Date.now();
  return {
    id: raw.id ?? genId(),
    title: raw.title ?? "",
    note: raw.note,
    kind: raw.kind ?? "all-day",
    dueDate: raw.dueDate,
    dueTime: raw.dueTime,
    startTime: raw.startTime,
    endTime: raw.endTime,
    recurrence: raw.recurrence,
    checkin: raw.checkin,
    subtasks: raw.subtasks,
    location: raw.location,
    priority: raw.priority ?? "normal",
    urgent: raw.urgent,
    categoryId: raw.categoryId,
    done: raw.done ?? false,
    completedAt: raw.completedAt ?? 0,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}

export const useTodoStore = defineStore("todo", () => {
  const items = ref<TodoItem[]>([]);
  const categories = ref<TodoCategory[]>([...DEFAULT_CATEGORIES]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (loaded.value) return;
    const [stored, cats] = await Promise.all([
      readJSON<Partial<TodoItem>[]>(TODO_KEY),
      readJSON<TodoCategory[]>(CATEGORY_KEY),
    ]);
    items.value = (stored ?? []).map(migrateItem);
    if (cats && cats.length) {
      // 合并 preset 与用户分类：preset 始终保留
      const presetIds = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
      const userCats = cats.filter((c) => !presetIds.has(c.id));
      categories.value = [...DEFAULT_CATEGORIES, ...userCats];
    }
    loaded.value = true;
  }

  async function persistItems(): Promise<void> {
    await writeJSON(TODO_KEY, items.value);
  }
  async function persistCategories(): Promise<void> {
    await writeJSON(CATEGORY_KEY, categories.value);
  }

  // ===== 待办 CRUD =====

  function createItem(input: {
    title: string;
    note?: string;
    kind?: TodoItem["kind"];
    dueDate?: string;
    dueTime?: string;
    startTime?: string;
    endTime?: string;
    recurrence?: TodoItem["recurrence"];
    checkin?: boolean;
    subtasks?: Omit<TodoSubtask, "id">[];
    location?: string;
    priority?: TodoPriority;
    urgent?: boolean;
    categoryId?: string;
  }): TodoItem {
    const now = Date.now();
    const item: TodoItem = {
      id: genId(),
      title: input.title.trim(),
      note: input.note?.trim() || undefined,
      kind: input.kind ?? "all-day",
      dueDate: input.dueDate || todayKey(),
      dueTime: input.dueTime,
      startTime: input.startTime,
      endTime: input.endTime,
      recurrence: input.recurrence,
      checkin: input.checkin,
      subtasks: input.subtasks?.map((s) => ({ ...s, id: genId("st") })),
      location: input.location?.trim() || undefined,
      priority: input.priority ?? "normal",
      urgent: input.urgent,
      categoryId: input.categoryId,
      done: false,
      completedAt: 0,
      createdAt: now,
      updatedAt: now,
    };
    items.value.push(item);
    void persistItems();
    return item;
  }

  function updateItem(
    id: string,
    patch: Partial<Omit<TodoItem, "id" | "createdAt">>,
  ): void {
    const idx = items.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    items.value[idx] = {
      ...items.value[idx],
      ...patch,
      updatedAt: Date.now(),
    };
    void persistItems();
  }

  function toggleDone(id: string): void {
    const item = items.value.find((t) => t.id === id);
    if (!item) return;
    item.done = !item.done;
    item.completedAt = item.done ? Date.now() : 0;
    item.updatedAt = Date.now();
    void persistItems();
  }

  function deleteItem(id: string): void {
    const idx = items.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    items.value.splice(idx, 1);
    void persistItems();
  }

  // ===== 子任务 =====

  function addSubtask(todoId: string, sub: Omit<TodoSubtask, "id">): void {
    const item = items.value.find((t) => t.id === todoId);
    if (!item) return;
    if (!item.subtasks) item.subtasks = [];
    item.subtasks.push({ ...sub, id: genId("st") });
    item.updatedAt = Date.now();
    void persistItems();
  }

  function updateSubtask(
    todoId: string,
    subId: string,
    patch: Partial<Omit<TodoSubtask, "id">>,
  ): void {
    const item = items.value.find((t) => t.id === todoId);
    if (!item?.subtasks) return;
    const idx = item.subtasks.findIndex((s) => s.id === subId);
    if (idx < 0) return;
    item.subtasks[idx] = { ...item.subtasks[idx], ...patch };
    item.updatedAt = Date.now();
    void persistItems();
  }

  function removeSubtask(todoId: string, subId: string): void {
    const item = items.value.find((t) => t.id === todoId);
    if (!item?.subtasks) return;
    item.subtasks = item.subtasks.filter((s) => s.id !== subId);
    item.updatedAt = Date.now();
    void persistItems();
  }

  function toggleSubtask(todoId: string, subId: string): void {
    const item = items.value.find((t) => t.id === todoId);
    if (!item?.subtasks) return;
    const sub = item.subtasks.find((s) => s.id === subId);
    if (!sub) return;
    sub.done = !sub.done;
    item.updatedAt = Date.now();
    void persistItems();
  }

  // ===== 分类 =====

  function createCategory(input: {
    name: string;
    icon?: string;
    color?: string;
  }): TodoCategory {
    const cat: TodoCategory = {
      id: genId("cat"),
      name: input.name.trim(),
      icon: input.icon ?? "🏷️",
      color: input.color,
      createdAt: Date.now(),
    };
    categories.value.push(cat);
    void persistCategories();
    return cat;
  }

  function updateCategory(
    id: string,
    patch: Partial<Omit<TodoCategory, "id" | "createdAt" | "preset">>,
  ): void {
    const idx = categories.value.findIndex((c) => c.id === id);
    if (idx < 0) return;
    if (categories.value[idx].preset && patch.name !== undefined) return;
    categories.value[idx] = { ...categories.value[idx], ...patch };
    void persistCategories();
  }

  function deleteCategory(id: string): void {
    const cat = categories.value.find((c) => c.id === id);
    if (!cat || cat.preset) return;
    categories.value = categories.value.filter((c) => c.id !== id);
    // 该分类下待办迁移到 default
    for (const it of items.value) {
      if (it.categoryId === id) {
        it.categoryId = "default";
        it.updatedAt = Date.now();
      }
    }
    void persistCategories();
    void persistItems();
  }

  /** 把待办移到指定分类 */
  function moveToCategory(todoId: string, categoryId: string): void {
    const item = items.value.find((t) => t.id === todoId);
    if (!item) return;
    item.categoryId = categoryId;
    item.updatedAt = Date.now();
    void persistItems();
  }

  function categoryById(id?: string): TodoCategory | undefined {
    if (!id) return undefined;
    return categories.value.find((c) => c.id === id);
  }

  // ===== 查询 =====

  /** 指定日期生效的待办（考虑循环展开） */
  function itemsOfDate(date: string): TodoItem[] {
    return items.value.filter((t) => todoActiveOnDate(t, date));
  }

  /** 今日待办 */
  const todayItems = computed<TodoItem[]>(() => itemsOfDate(todayKey()));

  /** 待办总数（未完成） */
  const pendingCount = computed(
    () => items.value.filter((t) => !t.done).length,
  );

  /** 按日期分组（仅非循环） */
  const byDate = computed<Record<string, TodoItem[]>>(() => {
    const m: Record<string, TodoItem[]> = {};
    for (const it of items.value) {
      if (it.recurrence) continue;
      const k = it.dueDate ?? "no-date";
      if (!m[k]) m[k] = [];
      m[k].push(it);
    }
    return m;
  });

  /** 按分类分组 */
  const byCategory = computed<Record<string, TodoItem[]>>(() => {
    const m: Record<string, TodoItem[]> = {};
    for (const it of items.value) {
      const k = it.categoryId ?? "default";
      if (!m[k]) m[k] = [];
      m[k].push(it);
    }
    return m;
  });

  /** 按四象限分组（仅未完成） */
  const byQuadrant = computed<Record<QuadrantKey, TodoItem[]>>(() => {
    const m: Record<QuadrantKey, TodoItem[]> = {
      q1: [],
      q2: [],
      q3: [],
      q4: [],
    };
    for (const it of items.value) {
      if (it.done) continue;
      m[quadrantOf(it)].push(it);
    }
    return m;
  });

  /** 重要待办（priority=high，未完成） */
  const importantItems = computed(() =>
    items.value.filter((t) => t.priority === "high" && !t.done),
  );

  /** 紧急待办（urgent=true，未完成） */
  const urgentItems = computed(() =>
    items.value.filter((t) => t.urgent && !t.done),
  );

  return {
    items,
    categories,
    loaded,
    todayItems,
    pendingCount,
    byDate,
    byCategory,
    byQuadrant,
    importantItems,
    urgentItems,
    load,
    createItem,
    updateItem,
    toggleDone,
    deleteItem,
    addSubtask,
    updateSubtask,
    removeSubtask,
    toggleSubtask,
    createCategory,
    updateCategory,
    deleteCategory,
    moveToCategory,
    categoryById,
    itemsOfDate,
  };
});
