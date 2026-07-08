/**
 * todoStore — 待办事项 Pinia store
 *
 * - CRUD + 完成切换
 * - 持久化到 Tauri storage（useStorage 桥）
 * - 按日期分组的 getter
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { TodoItem, TodoPriority } from "@/types/todo";
import { readJSON, writeJSON } from "@/composables/useStorage";

const TODO_KEY = "todo-items";

function genId(): string {
  return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const useTodoStore = defineStore("todo", () => {
  const items = ref<TodoItem[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<TodoItem[]>(TODO_KEY);
    items.value = stored ?? [];
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(TODO_KEY, items.value);
  }

  function createItem(input: {
    title: string;
    note?: string;
    dueDate?: string;
    priority?: TodoPriority;
  }): TodoItem {
    const now = Date.now();
    const item: TodoItem = {
      id: genId(),
      title: input.title.trim(),
      note: input.note?.trim() || undefined,
      dueDate: input.dueDate || todayKey(),
      priority: input.priority ?? "normal",
      done: false,
      completedAt: 0,
      createdAt: now,
      updatedAt: now,
    };
    items.value.push(item);
    void persist();
    return item;
  }

  function updateItem(id: string, patch: Partial<Omit<TodoItem, "id" | "createdAt">>): void {
    const idx = items.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    items.value[idx] = {
      ...items.value[idx],
      ...patch,
      updatedAt: Date.now(),
    };
    void persist();
  }

  function toggleDone(id: string): void {
    const item = items.value.find((t) => t.id === id);
    if (!item) return;
    item.done = !item.done;
    item.completedAt = item.done ? Date.now() : 0;
    item.updatedAt = Date.now();
    void persist();
  }

  function deleteItem(id: string): void {
    const idx = items.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    items.value.splice(idx, 1);
    void persist();
  }

  /** 按 YYYY-MM-DD 分组 */
  const byDate = computed<Record<string, TodoItem[]>>(() => {
    const m: Record<string, TodoItem[]> = {};
    for (const it of items.value) {
      const k = it.dueDate ?? "no-date";
      if (!m[k]) m[k] = [];
      m[k].push(it);
    }
    return m;
  });

  /** 指定日期的待办 */
  function itemsOfDate(date: string): TodoItem[] {
    return byDate.value[date] ?? [];
  }

  /** 今日待办 */
  const todayItems = computed<TodoItem[]>(() => itemsOfDate(todayKey()));

  /** 待办总数 */
  const pendingCount = computed(() => items.value.filter((t) => !t.done).length);

  return {
    items,
    loaded,
    todayItems,
    pendingCount,
    byDate,
    load,
    createItem,
    updateItem,
    toggleDone,
    deleteItem,
    itemsOfDate,
  };
});
