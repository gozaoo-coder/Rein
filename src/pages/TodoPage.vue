<script setup lang="ts">
/**
 * TodoPage — 待办事项（升级版）
 *
 * 三视图：日历 / 四象限 / 分类
 * AI 快速创建入口、完整编辑器（kind/recurrence/subtasks/category/urgent/location）
 *
 * 设计：HarmonyOS 沉浸光感 — 暖橙渐变 + 玻璃白卡 + 5 级材质
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useTodoStore } from "@/stores/todoStore";
import BottomSheet from "@/components/ui/BottomSheet.vue";
import {
  HOLIDAY_PRESETS,
  PRIORITY_LABEL,
  QUADRANT_HINT,
  QUADRANT_LABEL,
  RECURRENCE_LABEL,
  TODO_KIND_LABEL,
  quadrantOf,
  type CalendarView,
  type DayMeta,
  type QuadrantKey,
  type TodoCategory,
  type TodoItem,
  type TodoKind,
  type TodoListView,
  type TodoPriority,
  type TodoRecurrence,
  type TodoSubtask,
} from "@/types/todo";

const router = useRouter();
const route = useRoute();
const store = useTodoStore();

// ====== 视图状态 ======
const viewMode = ref<TodoListView>("calendar");
const calMode = ref<CalendarView>("month");

// ====== 日历状态 ======
const today = new Date();
const viewYear = ref(today.getFullYear());
const viewMonth = ref(today.getMonth()); // 0-11
/** 周视图起始日（周日为头） */
const weekStartDate = ref<Date>(startOfWeek(today));
const selectedDate = ref<string>(dateKey(today));

const showMonthPicker = ref(false);
const showYearPicker = ref(false);
const showEditor = ref(false);
const editingItem = ref<TodoItem | null>(null);

// ====== AI 输入 ======
const aiInput = ref("");

// ====== 分类视图状态 ======
const selectedCategoryId = ref("default");
const showCategoryModal = ref(false);
const editingCategory = ref<TodoCategory | null>(null);
const categoryForm = ref({ name: "", icon: "🏷️", color: "" });

// ====== 编辑器表单 ======
interface EditorSubtask {
  id?: string;
  title: string;
  done: boolean;
  countMin: string;
  countMax: string;
  unit: string;
}

interface EditorForm {
  title: string;
  note: string;
  kind: TodoKind;
  dueDate: string;
  dueTime: string;
  startTime: string;
  endTime: string;
  recurrenceEnabled: boolean;
  recurrenceType: TodoRecurrence["type"];
  recurrenceDays: number[];
  recurrenceInterval: number;
  recurrenceUntil: string;
  checkin: boolean;
  location: string;
  priority: TodoPriority;
  urgent: boolean;
  categoryId: string;
  subtasks: EditorSubtask[];
}

const editorForm = ref<EditorForm>(makeEmptyForm());

const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
const kindOptions: TodoKind[] = ["all-day", "deadline", "time-range"];
const priorityOptions: TodoPriority[] = ["low", "normal", "high"];
const recurrenceTypeOptions: TodoRecurrence["type"][] = [
  "daily",
  "weekly",
  "monthly",
  "weekdays",
  "custom",
];
const quadrantKeys: QuadrantKey[] = ["q1", "q2", "q3", "q4"];

function makeEmptyForm(): EditorForm {
  return {
    title: "",
    note: "",
    kind: "all-day",
    dueDate: selectedDate.value || todayKey(),
    dueTime: "",
    startTime: "",
    endTime: "",
    recurrenceEnabled: false,
    recurrenceType: "daily",
    recurrenceDays: [],
    recurrenceInterval: 1,
    recurrenceUntil: "",
    checkin: false,
    location: "",
    priority: "normal",
    urgent: false,
    categoryId: "default",
    subtasks: [],
  };
}

function genId(prefix = "todo"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function nextWeekdayDate(targetDow: number): string {
  const d = new Date();
  const today = d.getDay();
  let diff = targetDow - today;
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() + diff);
  return dateKey(d);
}

function setDatePreset(preset: string) {
  switch (preset) {
    case "today":
      editorForm.value.dueDate = todayKey();
      break;
    case "tomorrow":
      editorForm.value.dueDate = offsetDate(1);
      break;
    case "day-after":
      editorForm.value.dueDate = offsetDate(2);
      break;
    case "next-week":
      editorForm.value.dueDate = offsetDate(7);
      break;
    case "mon":
      editorForm.value.dueDate = nextWeekdayDate(1);
      break;
    case "no-date":
      editorForm.value.dueDate = "";
      break;
  }
}

const datePresets = [
  { key: "today", label: "今天" },
  { key: "tomorrow", label: "明天" },
  { key: "day-after", label: "后天" },
  { key: "mon", label: "下周一" },
  { key: "next-week", label: "下周" },
  { key: "no-date", label: "无日期" },
];

function isDatePresetActive(key: string): boolean {
  const f = editorForm.value;
  switch (key) {
    case "today": return f.dueDate === todayKey();
    case "tomorrow": return f.dueDate === offsetDate(1);
    case "day-after": return f.dueDate === offsetDate(2);
    case "next-week": return f.dueDate === offsetDate(7);
    case "mon": return f.dueDate === nextWeekdayDate(1);
    case "no-date": return !f.dueDate;
  }
  return false;
}

// ====== 工具函数 ======
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayKey(): string {
  return dateKey(new Date());
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // 周日为头
  return x;
}
function parseDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function holidayOf(date: Date): { name: string; type: "public" | "rest" } | null {
  const mmdd = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const ymd = dateKey(date);
  for (const h of HOLIDAY_PRESETS) {
    if (h.date === mmdd || h.date === ymd) {
      return { name: h.name, type: h.type };
    }
  }
  return null;
}

// ====== 待办徽章 ======
function kindBadge(item: TodoItem): string {
  if (item.kind === "deadline") return `截止 ${item.dueTime ?? "--:--"}`;
  if (item.kind === "time-range")
    return `${item.startTime ?? "--:--"}-${item.endTime ?? "--:--"}`;
  return "整日";
}
function recurrenceBadge(item: TodoItem): string | null {
  if (!item.recurrence) return null;
  return RECURRENCE_LABEL[item.recurrence.type];
}
function subtaskBadge(item: TodoItem): string | null {
  if (!item.subtasks || item.subtasks.length === 0) return null;
  const done = item.subtasks.filter((s) => s.done).length;
  return `${done}/${item.subtasks.length} 子任务`;
}

// ====== 日历构建 ======
const monthDays = computed<DayMeta[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate();
  const cells: DayMeta[] = [];
  const todayK = todayKey();

  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(viewYear.value, viewMonth.value, -i);
    cells.push(buildDayMeta(d, false, todayK));
  }
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(viewYear.value, viewMonth.value, i);
    cells.push(buildDayMeta(d, true, todayK));
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    const d = parseDate(last.date);
    d.setDate(d.getDate() + 1);
    cells.push(buildDayMeta(d, false, todayK));
  }
  return cells;
});

const weekDays = computed<DayMeta[]>(() => {
  const cells: DayMeta[] = [];
  const todayK = todayKey();
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStartDate.value);
    d.setDate(d.getDate() + i);
    cells.push(buildDayMeta(d, true, todayK));
  }
  return cells;
});

function buildDayMeta(d: Date, inMonth: boolean, todayK: string): DayMeta {
  const k = dateKey(d);
  const list = store.itemsOfDate(k);
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  const h = holidayOf(d);
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  return {
    date: k,
    day: d.getDate(),
    inMonth,
    isToday: k === todayK,
    todoCount: total,
    doneCount: done,
    progress: total > 0 ? done / total : 0,
    isWeekend,
    isHoliday: !!h,
    holidayName: h?.name,
  };
}

const calendarDays = computed(() =>
  calMode.value === "month" ? monthDays.value : weekDays.value,
);

const monthLabel = computed(() => `${viewYear.value} 年 ${viewMonth.value + 1} 月`);

const weekLabel = computed(() => {
  const start = weekStartDate.value;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
});

// ====== 选中日期待办 ======
const selectedItems = computed<TodoItem[]>(() =>
  store.itemsOfDate(selectedDate.value),
);
const selectedProgress = computed(() => {
  if (selectedItems.value.length === 0) return 0;
  const done = selectedItems.value.filter((t) => t.done).length;
  return done / selectedItems.value.length;
});
const selectedMeta = computed<DayMeta | null>(() => {
  const d = parseDate(selectedDate.value);
  const todayK = todayKey();
  return buildDayMeta(d, true, todayK);
});

// ====== 四象限视图 ======
function quadrantCount(q: QuadrantKey): number {
  return store.byQuadrant[q].length;
}
function quadrantItems(q: QuadrantKey): TodoItem[] {
  return store.byQuadrant[q].slice(0, 8);
}

// ====== 分类视图 ======
const categoryItems = computed<TodoItem[]>(
  () => store.byCategory[selectedCategoryId.value] ?? [],
);
const categoryPending = computed(() =>
  categoryItems.value.filter((t) => !t.done),
);
const categoryDone = computed(() => categoryItems.value.filter((t) => t.done));
const currentCategoryName = computed(() => {
  const c = store.categories.find((x) => x.id === selectedCategoryId.value);
  return c ? `${c.icon} ${c.name}` : "未分类";
});

// ====== 导航 ======
function prevMonth() {
  if (viewMonth.value === 0) {
    viewMonth.value = 11;
    viewYear.value -= 1;
  } else {
    viewMonth.value -= 1;
  }
}
function nextMonth() {
  if (viewMonth.value === 11) {
    viewMonth.value = 0;
    viewYear.value += 1;
  } else {
    viewMonth.value += 1;
  }
}
function prevWeek() {
  const d = new Date(weekStartDate.value);
  d.setDate(d.getDate() - 7);
  weekStartDate.value = d;
}
function nextWeek() {
  const d = new Date(weekStartDate.value);
  d.setDate(d.getDate() + 7);
  weekStartDate.value = d;
}
function goPrev() {
  if (calMode.value === "month") prevMonth();
  else prevWeek();
}
function goNext() {
  if (calMode.value === "month") nextMonth();
  else nextWeek();
}
function jumpToday() {
  const t = new Date();
  viewYear.value = t.getFullYear();
  viewMonth.value = t.getMonth();
  weekStartDate.value = startOfWeek(t);
  selectedDate.value = dateKey(t);
}

function selectDay(meta: DayMeta) {
  selectedDate.value = meta.date;
  if (calMode.value === "month" && !meta.inMonth) {
    const d = parseDate(meta.date);
    viewYear.value = d.getFullYear();
    viewMonth.value = d.getMonth();
  }
}

// ====== 年/月选择器 ======
const yearOptions = computed(() => {
  const arr: number[] = [];
  const base = today.getFullYear();
  for (let y = base - 5; y <= base + 5; y++) arr.push(y);
  return arr;
});
const monthOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function pickYear(y: number) {
  viewYear.value = y;
  showYearPicker.value = false;
}
function pickMonth(m: number) {
  viewMonth.value = m - 1;
  showMonthPicker.value = false;
}

// ====== AI 快速创建 ======
function submitAi() {
  const text = aiInput.value.trim();
  if (!text) return;
  router.push(`/ai?prefill=${encodeURIComponent(text)}`);
  aiInput.value = "";
}

function openAiHelp() {
  const f = editorForm.value;
  const parts: string[] = [];
  if (f.title.trim()) parts.push(`待办标题：${f.title.trim()}`);
  if (f.note.trim()) parts.push(`备注：${f.note.trim()}`);
  if (f.kind !== "all-day") {
    if (f.kind === "deadline" && f.dueTime) parts.push(`截止时间：${f.dueDate} ${f.dueTime}`);
    if (f.kind === "time-range" && f.startTime) parts.push(`时间段：${f.dueDate} ${f.startTime}-${f.endTime}`);
  } else if (f.dueDate) {
    parts.push(`日期：${f.dueDate}`);
  }
  const prompt = parts.length
    ? `请帮我优化这个待办，让它更清晰可执行：\n${parts.join("\n")}`
    : "请帮我创建一个待办，我会告诉你要做什么";
  router.push(`/ai?prefill=${encodeURIComponent(prompt)}`);
  closeEditor();
}

// ====== 编辑器 ======
function openCreate() {
  editingItem.value = null;
  editorForm.value = makeEmptyForm();
  showEditor.value = true;
}
function openEdit(item: TodoItem) {
  editingItem.value = item;
  editorForm.value = {
    title: item.title,
    note: item.note ?? "",
    kind: item.kind,
    dueDate: item.dueDate ?? todayKey(),
    dueTime: item.dueTime ?? "",
    startTime: item.startTime ?? "",
    endTime: item.endTime ?? "",
    recurrenceEnabled: !!item.recurrence,
    recurrenceType: item.recurrence?.type ?? "daily",
    recurrenceDays: item.recurrence?.daysOfWeek
      ? [...item.recurrence.daysOfWeek]
      : [],
    recurrenceInterval: item.recurrence?.interval ?? 1,
    recurrenceUntil: item.recurrence?.until ?? "",
    checkin: !!item.checkin,
    location: item.location ?? "",
    priority: item.priority,
    urgent: !!item.urgent,
    categoryId: item.categoryId ?? "default",
    subtasks: (item.subtasks ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      countMin: s.countMin != null ? String(s.countMin) : "",
      countMax: s.countMax != null ? String(s.countMax) : "",
      unit: s.unit ?? "",
    })),
  };
  showEditor.value = true;
}
function closeEditor() {
  showEditor.value = false;
  editingItem.value = null;
}

function toggleWeekday(d: number) {
  const arr = editorForm.value.recurrenceDays;
  const idx = arr.indexOf(d);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(d);
}
function addSubtaskRow() {
  editorForm.value.subtasks.push({
    title: "",
    done: false,
    countMin: "",
    countMax: "",
    unit: "",
  });
}
function removeSubtaskRow(idx: number) {
  editorForm.value.subtasks.splice(idx, 1);
}

const editingQuadrant = computed<QuadrantKey | null>(() =>
  editingItem.value ? quadrantOf(editingItem.value) : null,
);

function buildSubtasksForUpdate(): TodoSubtask[] {
  return editorForm.value.subtasks
    .filter((s) => s.title.trim())
    .map((s) => ({
      id: s.id ?? genId("st"),
      title: s.title.trim(),
      done: s.done,
      countMin: s.countMin ? Number(s.countMin) : undefined,
      countMax: s.countMax ? Number(s.countMax) : undefined,
      unit: s.unit.trim() || undefined,
    }));
}
function buildSubtasksForCreate(): Omit<TodoSubtask, "id">[] {
  return editorForm.value.subtasks
    .filter((s) => s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      done: s.done,
      countMin: s.countMin ? Number(s.countMin) : undefined,
      countMax: s.countMax ? Number(s.countMax) : undefined,
      unit: s.unit.trim() || undefined,
    }));
}

function saveEditor() {
  const f = editorForm.value;
  if (!f.title.trim()) return;

  let recurrence: TodoRecurrence | undefined;
  if (f.recurrenceEnabled) {
    recurrence = {
      type: f.recurrenceType,
      interval: f.recurrenceInterval > 0 ? f.recurrenceInterval : 1,
    };
    if (f.recurrenceType === "custom") {
      recurrence.daysOfWeek = [...f.recurrenceDays].sort();
    }
    if (f.recurrenceUntil) {
      recurrence.until = f.recurrenceUntil;
    }
  }

  if (editingItem.value) {
    store.updateItem(editingItem.value.id, {
      title: f.title.trim(),
      note: f.note.trim() || undefined,
      kind: f.kind,
      dueDate: f.dueDate,
      dueTime: f.kind === "deadline" ? f.dueTime || undefined : undefined,
      startTime:
        f.kind === "time-range" ? f.startTime || undefined : undefined,
      endTime: f.kind === "time-range" ? f.endTime || undefined : undefined,
      recurrence,
      checkin: f.recurrenceEnabled ? f.checkin : undefined,
      subtasks: buildSubtasksForUpdate(),
      location: f.location.trim() || undefined,
      priority: f.priority,
      urgent: f.urgent || undefined,
      categoryId: f.categoryId,
    });
  } else {
    store.createItem({
      title: f.title.trim(),
      note: f.note.trim() || undefined,
      kind: f.kind,
      dueDate: f.dueDate,
      dueTime: f.kind === "deadline" ? f.dueTime || undefined : undefined,
      startTime:
        f.kind === "time-range" ? f.startTime || undefined : undefined,
      endTime: f.kind === "time-range" ? f.endTime || undefined : undefined,
      recurrence,
      checkin: f.recurrenceEnabled ? f.checkin : undefined,
      subtasks: buildSubtasksForCreate(),
      location: f.location.trim() || undefined,
      priority: f.priority,
      urgent: f.urgent || undefined,
      categoryId: f.categoryId,
    });
  }
  closeEditor();
}
function removeCurrent() {
  if (!editingItem.value) return;
  store.deleteItem(editingItem.value.id);
  closeEditor();
}

// ====== 分类管理 ======
function openCreateCategory() {
  editingCategory.value = null;
  categoryForm.value = { name: "", icon: "🏷️", color: "" };
  showCategoryModal.value = true;
}
function openEditCategory(cat: TodoCategory) {
  editingCategory.value = cat;
  categoryForm.value = {
    name: cat.name,
    icon: cat.icon,
    color: cat.color ?? "",
  };
  showCategoryModal.value = true;
}
function closeCategoryModal() {
  showCategoryModal.value = false;
  editingCategory.value = null;
}
function saveCategory() {
  const f = categoryForm.value;
  if (editingCategory.value) {
    const cat = editingCategory.value;
    if (cat.preset) {
      store.updateCategory(cat.id, {
        icon: f.icon,
        color: f.color || undefined,
      });
    } else {
      if (!f.name.trim()) return;
      store.updateCategory(cat.id, {
        name: f.name.trim(),
        icon: f.icon,
        color: f.color || undefined,
      });
    }
  } else {
    if (!f.name.trim()) return;
    store.createCategory({
      name: f.name.trim(),
      icon: f.icon,
      color: f.color || undefined,
    });
  }
  closeCategoryModal();
}
function deleteCurrentCategory() {
  if (!editingCategory.value || editingCategory.value.preset) return;
  const id = editingCategory.value.id;
  store.deleteCategory(id);
  if (selectedCategoryId.value === id) selectedCategoryId.value = "default";
  closeCategoryModal();
}

function goBack() {
  router.back();
}

// ====== 优先级颜色 ======
function priorityColor(p: TodoPriority): string {
  if (p === "high") return "var(--color-danger)";
  if (p === "normal") return "var(--color-warning)";
  return "var(--color-text-tertiary)";
}

function quadrantAccentVar(q: QuadrantKey): string {
  if (q === "q1") return "var(--danger-500)";
  if (q === "q2") return "var(--warning-500)";
  if (q === "q3") return "var(--color-warm)";
  return "var(--color-text-tertiary)";
}

onMounted(() => {
  store.load();
  // 来自「快速新建待办」卡片的跳转：自动打开新建编辑器
  if (route.query.new === "1") {
    openCreate();
    // 清除 query，避免刷新或返回时重复打开
    router.replace({ path: route.path, query: {} });
  }
});

// 切换日历子视图时同步周起始日为选中日期所在周
watch(calMode, (m) => {
  if (m === "week") {
    weekStartDate.value = startOfWeek(parseDate(selectedDate.value));
  }
});
</script>

<template>
  <div class="todo-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">待办事项</h2>
      <button class="today-btn" @click="jumpToday">今天</button>
    </header>

    <!-- 顶层视图切换：日历 / 四象限 / 分类 -->
    <section class="clean-card view-tabs-bar">
      <div class="view-tabs">
        <button
          class="view-tab"
          :class="{ active: viewMode === 'calendar' }"
          @click="viewMode = 'calendar'"
        >日历</button>
        <button
          class="view-tab"
          :class="{ active: viewMode === 'quadrant' }"
          @click="viewMode = 'quadrant'"
        >四象限</button>
        <button
          class="view-tab"
          :class="{ active: viewMode === 'category' }"
          @click="viewMode = 'category'"
        >分类</button>
      </div>
    </section>

    <!-- AI 快速创建入口 -->
    <section class="ai-input-wrap">
      <input
        v-model="aiInput"
        class="ai-input"
        type="text"
        placeholder="告诉 AI 帮你创建待办…"
        @keyup.enter="submitAi"
      />
      <button class="ai-send" @click="submitAi" aria-label="发送给 AI">
        <i class="bi bi-send" style="font-size:18px"></i>
      </button>
    </section>

    <!-- ============ 日历视图 ============ -->
    <template v-if="viewMode === 'calendar'">
      <!-- 月/周子切换 + 月份导航 -->
      <section class="clean-card cal-toolbar">
        <div class="view-tabs">
          <button
            class="view-tab"
            :class="{ active: calMode === 'month' }"
            @click="calMode = 'month'"
          >月</button>
          <button
            class="view-tab"
            :class="{ active: calMode === 'week' }"
            @click="calMode = 'week'"
          >周</button>
        </div>
        <div class="nav-row">
          <button class="nav-arrow" @click="goPrev" aria-label="上一个">
            <i class="bi bi-chevron-left" style="font-size:18px"></i>
          </button>
          <button class="period-label" @click="showMonthPicker = !showMonthPicker">
            <span v-if="calMode === 'month'">{{ monthLabel }}</span>
            <span v-else>{{ weekLabel }}</span>
            <i class="bi bi-chevron-down" style="font-size:14px"></i>
          </button>
          <button class="nav-arrow" @click="goNext" aria-label="下一个">
            <i class="bi bi-chevron-right" style="font-size:18px"></i>
          </button>
        </div>
      </section>

      <!-- 年/月选择器 -->
      <section v-if="showMonthPicker" class="clean-card picker-card">
        <div class="picker-section">
          <div class="picker-title">年份</div>
          <div class="picker-grid year-grid">
            <button
              v-for="y in yearOptions"
              :key="y"
              class="picker-cell"
              :class="{ active: y === viewYear }"
              @click="pickYear(y)"
            >{{ y }}</button>
          </div>
        </div>
        <div class="picker-section">
          <div class="picker-title">月份</div>
          <div class="picker-grid month-grid">
            <button
              v-for="m in monthOptions"
              :key="m"
              class="picker-cell"
              :class="{ active: m - 1 === viewMonth }"
              @click="pickMonth(m)"
            >{{ m }}月</button>
          </div>
        </div>
      </section>

      <!-- 日历 -->
      <section class="clean-card calendar-card">
        <div class="dow-row">
          <div class="dow dow-rest">日</div>
          <div class="dow">一</div>
          <div class="dow">二</div>
          <div class="dow">三</div>
          <div class="dow">四</div>
          <div class="dow">五</div>
          <div class="dow dow-rest">六</div>
        </div>
        <div class="day-grid" :class="{ 'week-grid': calMode === 'week' }">
          <button
            v-for="meta in calendarDays"
            :key="meta.date"
            class="day-cell"
            :class="{
              'out-month': calMode === 'month' && !meta.inMonth,
              'is-today': meta.isToday,
              'is-selected': meta.date === selectedDate,
              'is-weekend': meta.isWeekend,
              'is-holiday': meta.isHoliday,
            }"
            @click="selectDay(meta)"
          >
            <div class="day-num">{{ meta.day }}</div>
            <div v-if="meta.holidayName" class="day-holiday">{{ meta.holidayName }}</div>
            <div v-else-if="meta.isWeekend && meta.inMonth" class="day-rest">休</div>
            <div v-if="meta.todoCount > 0" class="day-bottom">
              <svg class="day-progress" width="20" height="20" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" fill="none" stroke="var(--bg-300)" stroke-width="3"/>
                <circle
                  cx="12" cy="12" r="10" fill="none"
                  stroke="var(--color-warm)" stroke-width="3"
                  stroke-linecap="round"
                  :stroke-dasharray="62.83"
                  :stroke-dashoffset="62.83 * (1 - meta.progress)"
                  transform="rotate(-90 12 12)"
                />
              </svg>
              <span class="day-badge">{{ meta.todoCount }}</span>
            </div>
          </button>
        </div>
      </section>

      <!-- 选中日详情 -->
      <section class="clean-card day-detail">
        <div class="detail-head">
          <div>
            <div class="detail-date">{{ selectedDate }}</div>
            <div class="detail-meta">
              <span v-if="selectedMeta?.holidayName" class="meta-tag meta-holiday">{{ selectedMeta.holidayName }}</span>
              <span v-else-if="selectedMeta?.isWeekend" class="meta-tag meta-rest">休息日</span>
              <span v-if="selectedItems.length" class="meta-tag">
                {{ selectedItems.filter(t => t.done).length }}/{{ selectedItems.length }} 已完成
              </span>
            </div>
          </div>
          <button class="add-btn" @click="openCreate">
            <i class="bi bi-plus-lg" style="font-size:16px"></i>
            <span>新建</span>
          </button>
        </div>

        <div v-if="selectedItems.length" class="progress-bar">
          <div class="progress-fill" :style="{ width: `${selectedProgress * 100}%` }" />
        </div>

        <div v-if="selectedItems.length" class="todo-list">
          <div
            v-for="item in selectedItems"
            :key="item.id"
            class="todo-row"
            :class="{ done: item.done }"
            @click="openEdit(item)"
          >
            <button
              class="check-btn"
              :class="{ checked: item.done }"
              @click.stop="store.toggleDone(item.id)"
              :aria-label="item.done ? '取消完成' : '标记完成'"
            >
              <i v-if="item.done" class="bi bi-check-lg" style="font-size:14px"></i>
            </button>
            <div class="todo-main">
              <div class="todo-title">
                {{ item.title }}
                <span v-if="item.urgent" class="urgent-badge">急</span>
              </div>
              <div class="todo-sub">
                <span class="prio-dot" :style="{ background: priorityColor(item.priority) }" />
                <span>{{ PRIORITY_LABEL[item.priority] }}</span>
                <span v-if="item.kind !== 'all-day'" class="mini-badge">{{ kindBadge(item) }}</span>
                <span v-if="recurrenceBadge(item)" class="mini-badge">🔁 {{ recurrenceBadge(item) }}</span>
                <span v-if="item.checkin" class="mini-badge">✅ 打卡</span>
                <span v-if="item.location" class="mini-badge">📍 {{ item.location }}</span>
                <span v-if="subtaskBadge(item)" class="mini-badge">{{ subtaskBadge(item) }}</span>
                <span v-if="item.note" class="todo-note">· {{ item.note }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-day">
          <p>该日暂无待办</p>
          <button class="ghost-btn" @click="openCreate">添加待办</button>
        </div>
      </section>
    </template>

    <!-- ============ 四象限视图 ============ -->
    <template v-else-if="viewMode === 'quadrant'">
      <section class="quadrant-grid">
        <div
          v-for="q in quadrantKeys"
          :key="q"
          class="clean-card quadrant-card"
          :data-q="q"
        >
          <div class="q-head">
            <div class="q-label" :style="{ color: quadrantAccentVar(q) }">
              {{ QUADRANT_LABEL[q] }}
            </div>
            <div class="q-hint">{{ QUADRANT_HINT[q] }}</div>
            <div class="q-count">{{ quadrantCount(q) }} 项</div>
          </div>
          <div class="q-list">
            <div
              v-for="item in quadrantItems(q)"
              :key="item.id"
              class="q-item"
              :class="{ done: item.done }"
              @click="openEdit(item)"
            >
              <div class="q-item-title">{{ item.title }}</div>
              <div class="q-item-badges">
                <span v-if="item.location" class="mini-badge">📍 {{ item.location }}</span>
                <span v-if="item.kind !== 'all-day'" class="mini-badge">{{ kindBadge(item) }}</span>
                <span v-if="recurrenceBadge(item)" class="mini-badge">🔁 {{ recurrenceBadge(item) }}</span>
                <span v-if="subtaskBadge(item)" class="mini-badge">{{ subtaskBadge(item) }}</span>
              </div>
            </div>
            <div v-if="quadrantCount(q) === 0" class="q-empty">暂无</div>
          </div>
          <div v-if="quadrantCount(q) > 8" class="q-footer">
            共 {{ quadrantCount(q) }} 项
          </div>
        </div>
      </section>
      <button class="fab" @click="openCreate" aria-label="新建待办">
        <i class="bi bi-plus-lg" style="font-size:22px"></i>
      </button>
    </template>

    <!-- ============ 分类视图 ============ -->
    <template v-else-if="viewMode === 'category'">
      <section class="category-layout">
        <div class="category-chips">
          <button
            v-for="cat in store.categories"
            :key="cat.id"
            class="category-chip"
            :class="{ active: cat.id === selectedCategoryId }"
            @click="selectedCategoryId = cat.id"
          >
            <span class="chip-icon">{{ cat.icon }}</span>
            <span class="chip-name">{{ cat.name }}</span>
            <span class="chip-count">{{ store.byCategory[cat.id]?.length ?? 0 }}</span>
            <button
              class="chip-edit"
              @click.stop="openEditCategory(cat)"
              aria-label="编辑分类"
            >✏️</button>
          </button>
          <button class="add-category-btn" @click="openCreateCategory">+ 新分类</button>
        </div>

        <div class="category-list clean-card">
          <h3 class="cat-section-title">{{ currentCategoryName }}</h3>

          <div v-if="categoryPending.length" class="cat-group">
            <div class="cat-group-title">待办 ({{ categoryPending.length }})</div>
            <div class="todo-list">
              <div
                v-for="item in categoryPending"
                :key="item.id"
                class="todo-row"
                @click="openEdit(item)"
              >
                <button
                  class="check-btn"
                  @click.stop="store.toggleDone(item.id)"
                  aria-label="标记完成"
                >
                  <i v-if="item.done" class="bi bi-check-lg" style="font-size:14px"></i>
                </button>
                <div class="todo-main">
                  <div class="todo-title">
                    {{ item.title }}
                    <span v-if="item.urgent" class="urgent-badge">急</span>
                  </div>
                  <div class="todo-sub">
                    <span class="prio-dot" :style="{ background: priorityColor(item.priority) }" />
                    <span>{{ PRIORITY_LABEL[item.priority] }}</span>
                    <span v-if="item.kind !== 'all-day'" class="mini-badge">{{ kindBadge(item) }}</span>
                    <span v-if="recurrenceBadge(item)" class="mini-badge">🔁 {{ recurrenceBadge(item) }}</span>
                    <span v-if="item.location" class="mini-badge">📍 {{ item.location }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="categoryDone.length" class="cat-group">
            <div class="cat-group-title">已完成 ({{ categoryDone.length }})</div>
            <div class="todo-list">
              <div
                v-for="item in categoryDone"
                :key="item.id"
                class="todo-row done"
                @click="openEdit(item)"
              >
                <button
                  class="check-btn checked"
                  @click.stop="store.toggleDone(item.id)"
                  aria-label="取消完成"
                >
                  <i class="bi bi-check-lg" style="font-size:14px"></i>
                </button>
                <div class="todo-main">
                  <div class="todo-title">{{ item.title }}</div>
                  <div class="todo-sub">
                    <span class="prio-dot" :style="{ background: priorityColor(item.priority) }" />
                    <span>{{ PRIORITY_LABEL[item.priority] }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!categoryItems.length" class="empty-day">
            <p>该分类暂无待办</p>
            <button class="ghost-btn" @click="openCreate">添加待办</button>
          </div>
        </div>
      </section>
      <button class="fab" @click="openCreate" aria-label="新建待办">
        <i class="bi bi-plus-lg" style="font-size:22px"></i>
      </button>
    </template>

    <!-- ============ 编辑器 BottomSheet ============ -->
    <BottomSheet
      :visible="showEditor"
      :title="editingItem ? '编辑待办' : '新建待办'"
      :detents="['large']"
      default-detent="large"
      @update:visible="(v) => { if (!v) closeEditor() }"
      @close="closeEditor"
    >
      <div class="ed-scroll">
        <div v-if="editingQuadrant" class="ed-q-banner" :style="{ '--q-accent': quadrantAccentVar(editingQuadrant) }">
          <span class="ed-q-dot" />
          <span>将归入「{{ QUADRANT_LABEL[editingQuadrant] }}」象限</span>
          <span class="ed-q-hint">{{ QUADRANT_HINT[editingQuadrant] }}</span>
        </div>

        <!-- 标题 + 备注 -->
        <div class="ed-section ed-section--title">
          <input
            v-model="editorForm.title"
            class="ed-title-input"
            type="text"
            placeholder="要做什么？"
            autofocus
          />
          <textarea
            v-model="editorForm.note"
            class="ed-note-input"
            rows="2"
            placeholder="添加备注（可选）"
          />
        </div>

        <!-- AI 帮你优化代办 -->
        <button class="ed-ai-help" @click="openAiHelp">
          <i class="bi bi-stars" style="font-size:16px"></i>
          <span>AI 帮你优化</span>
          <i class="bi bi-chevron-right" style="font-size:12px;opacity:0.6"></i>
        </button>

        <!-- 时间类型卡片 -->
        <div class="ed-section">
          <div class="ed-section-title">时间安排</div>
          <div class="kind-cards">
            <button
              v-for="k in kindOptions"
              :key="k"
              class="kind-card"
              :class="{ active: editorForm.kind === k }"
              @click="editorForm.kind = k"
            >
              <div class="kind-card-icon">
                <i v-if="k === 'all-day'" class="bi bi-calendar3" style="font-size:20px"></i>
                <i v-else-if="k === 'deadline'" class="bi bi-clock" style="font-size:20px"></i>
                <i v-else class="bi bi-clock-history" style="font-size:20px"></i>
              </div>
              <div class="kind-card-info">
                <div class="kind-card-name">{{ TODO_KIND_LABEL[k] }}</div>
                <div class="kind-card-desc">
                  {{ k === 'all-day' ? '全天安排，无需具体时刻' : k === 'deadline' ? '需在某时刻前完成' : '有明确起止时段' }}
                </div>
              </div>
              <div class="kind-card-check" v-if="editorForm.kind === k">
                <i class="bi bi-check-lg" style="font-size:16px"></i>
              </div>
            </button>
          </div>
        </div>

        <!-- 日期快捷选择 -->
        <div class="ed-section">
          <div class="ed-section-title">日期</div>
          <div class="date-chips">
            <button
              v-for="p in datePresets"
              :key="p.key"
              class="date-chip"
              :class="{ active: isDatePresetActive(p.key) }"
              @click="setDatePreset(p.key)"
            >{{ p.label }}</button>
          </div>
          <div class="date-input-row">
            <input
              v-model="editorForm.dueDate"
              class="ed-input"
              type="date"
            />
          </div>
        </div>

        <!-- 时间（根据 kind 显示） -->
        <div v-if="editorForm.kind === 'deadline'" class="ed-section">
          <div class="ed-section-title">截止时刻</div>
          <div class="time-quick-chips">
            <button
              v-for="t in ['09:00','12:00','18:00','21:00','23:59']"
              :key="t"
              class="date-chip"
              :class="{ active: editorForm.dueTime === t }"
              @click="editorForm.dueTime = t"
            >{{ t }}</button>
          </div>
          <div class="date-input-row">
            <input
              v-model="editorForm.dueTime"
              class="ed-input"
              type="time"
            />
          </div>
        </div>

        <div v-if="editorForm.kind === 'time-range'" class="ed-section">
          <div class="ed-section-title">时间段</div>
          <div class="time-range-row">
            <div class="time-cell">
              <span class="time-cell-label">开始</span>
              <input v-model="editorForm.startTime" class="ed-input" type="time" />
            </div>
            <div class="time-arrow">→</div>
            <div class="time-cell">
              <span class="time-cell-label">结束</span>
              <input v-model="editorForm.endTime" class="ed-input" type="time" />
            </div>
          </div>
        </div>

        <!-- 重复 -->
        <div class="ed-section">
          <div class="ed-toggle-row">
            <div class="ed-toggle-info">
              <div class="ed-toggle-title">
                <i class="bi bi-arrow-repeat" style="font-size:18px;margin-right:6px"></i>
                重复
              </div>
              <div class="ed-toggle-desc">{{ editorForm.recurrenceEnabled ? RECURRENCE_LABEL[editorForm.recurrenceType] + (editorForm.recurrenceInterval > 1 ? ' · 每' + editorForm.recurrenceInterval : '') : '不重复' }}</div>
            </div>
            <button
              class="ios-toggle"
              :class="{ on: editorForm.recurrenceEnabled }"
              @click="editorForm.recurrenceEnabled = !editorForm.recurrenceEnabled"
              :aria-label="editorForm.recurrenceEnabled ? '关闭重复' : '开启重复'"
            >
              <span class="ios-toggle-knob" />
            </button>
          </div>

          <template v-if="editorForm.recurrenceEnabled">
            <div class="seg-buttons ed-seg">
              <button
                v-for="t in recurrenceTypeOptions"
                :key="t"
                class="seg-btn"
                :class="{ active: editorForm.recurrenceType === t }"
                @click="editorForm.recurrenceType = t"
              >{{ RECURRENCE_LABEL[t] }}</button>
            </div>

            <div v-if="editorForm.recurrenceType === 'custom'" class="weekday-toggles">
              <button
                v-for="(lbl, i) in weekdayLabels"
                :key="i"
                class="weekday-btn"
                :class="{ active: editorForm.recurrenceDays.includes(i) }"
                @click="toggleWeekday(i)"
              >{{ lbl }}</button>
            </div>

            <div class="recurrence-extra">
              <label class="rec-field">
                <span class="rec-field-label">间隔</span>
                <input
                  v-model.number="editorForm.recurrenceInterval"
                  type="number"
                  min="1"
                  class="ed-input ed-input--small"
                />
                <span class="rec-field-unit">
                  {{ editorForm.recurrenceType === 'daily' ? '天' : editorForm.recurrenceType === 'weekly' ? '周' : editorForm.recurrenceType === 'monthly' ? '月' : '天' }}
                </span>
              </label>
              <label class="rec-field">
                <span class="rec-field-label">截止</span>
                <input
                  v-model="editorForm.recurrenceUntil"
                  type="date"
                  class="ed-input"
                />
              </label>
            </div>

            <label class="ed-check-inline">
              <input v-model="editorForm.checkin" type="checkbox" class="ed-checkbox" />
              <span class="ed-check-label">每日打卡（完成后自动延续到次日）</span>
            </label>
          </template>
        </div>

        <!-- 优先级 + 紧急 -->
        <div class="ed-section">
          <div class="ed-section-title">优先级</div>
          <div class="prio-chips">
            <button
              v-for="p in priorityOptions"
              :key="p"
              class="prio-chip"
              :class="[`prio--${p}`, { active: editorForm.priority === p }]"
              @click="editorForm.priority = p"
            >
              <span class="prio-dot-chip" />
              {{ PRIORITY_LABEL[p] }}
            </button>
          </div>
          <label class="ed-check-inline ed-urgent-row">
            <input v-model="editorForm.urgent" type="checkbox" class="ed-checkbox" />
            <span class="ed-check-label">标记为紧急（会显示「急」标签并归入第一象限）</span>
          </label>
        </div>

        <!-- 地点 + 分类 -->
        <div class="ed-section">
          <div class="ed-section-title">附加信息</div>
          <div class="ed-field-group">
            <div class="ed-input-with-icon">
              <i class="bi bi-geo-alt" style="font-size:16px"></i>
              <input
                v-model="editorForm.location"
                type="text"
                class="ed-input ed-input--icon"
                placeholder="地点（可选，如 健身房）"
              />
            </div>
            <div class="ed-input-with-icon">
              <i class="bi bi-tag" style="font-size:16px"></i>
              <select v-model="editorForm.categoryId" class="ed-input ed-input--icon ed-select">
                <option
                  v-for="cat in store.categories"
                  :key="cat.id"
                  :value="cat.id"
                >{{ cat.icon }} {{ cat.name }}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 子任务 -->
        <div class="ed-section">
          <div class="ed-section-head">
            <div class="ed-section-title">子任务 / 清单</div>
            <button class="ed-mini-add" @click="addSubtaskRow">
              <i class="bi bi-plus-lg" style="font-size:14px"></i>
              添加
            </button>
          </div>
          <div v-if="!editorForm.subtasks.length" class="ed-empty-hint">
            将复杂任务拆分成小步骤，完成一个勾一个
          </div>
          <div class="subtask-list">
            <div
              v-for="(sub, idx) in editorForm.subtasks"
              :key="idx"
              class="subtask-row-new"
            >
              <button
                class="sub-check"
                :class="{ checked: sub.done }"
                @click="sub.done = !sub.done"
                :aria-label="sub.done ? '取消完成' : '标记完成'"
              >
                <i v-if="sub.done" class="bi bi-check-lg" style="font-size:12px"></i>
              </button>
              <input
                v-model="sub.title"
                class="sub-title-new"
                type="text"
                placeholder="子任务内容"
              />
              <div class="sub-count-wrap">
                <input v-model="sub.countMin" type="number" min="0" class="sub-count-new" placeholder="×" />
                <input v-model="sub.countMax" type="number" min="0" class="sub-count-new" placeholder="×" />
                <input v-model="sub.unit" type="text" class="sub-unit-new" placeholder="单位" />
              </div>
              <button class="sub-del" @click="removeSubtaskRow(idx)" aria-label="删除">
                <i class="bi bi-x-lg" style="font-size:12px"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- 底部留白 -->
        <div class="ed-bottom-space" />
      </div>

      <!-- 固定保存栏 -->
      <div class="ed-footer">
        <button v-if="editingItem" class="ed-footer-del" @click="removeCurrent" aria-label="删除">
          <i class="bi bi-trash3" style="font-size:18px"></i>
        </button>
        <button
          class="ed-footer-save"
          :class="{ disabled: !editorForm.title.trim() }"
          :disabled="!editorForm.title.trim()"
          @click="saveEditor"
        >
          {{ editingItem ? '保存修改' : '创建待办' }}
        </button>
      </div>
    </BottomSheet>

    <!-- ============ 分类管理弹窗 ============ -->
    <div v-if="showCategoryModal" class="modal-mask" @click.self="closeCategoryModal">
      <div class="clean-card category-sheet">
        <h3 class="editor-title">
          {{ editingCategory ? '编辑分类' : '新建分类' }}
        </h3>
        <label class="ed-field">
          <span class="ed-label">图标（emoji）</span>
          <input
            v-model="categoryForm.icon"
            type="text"
            maxlength="2"
            placeholder="🏷️"
          />
        </label>
        <label v-if="!editingCategory || !editingCategory.preset" class="ed-field">
          <span class="ed-label">名称</span>
          <input
            v-model="categoryForm.name"
            type="text"
            placeholder="如：读书"
          />
        </label>
        <label v-else class="ed-field">
          <span class="ed-label">名称（预置分类不可改）</span>
          <input :value="categoryForm.name" type="text" disabled />
        </label>
        <label class="ed-field">
          <span class="ed-label">颜色（可选，CSS 变量或色值）</span>
          <input
            v-model="categoryForm.color"
            type="text"
            placeholder="如 var(--color-warm) 或 #ff6633"
          />
        </label>
        <div class="ed-actions">
          <button
            v-if="editingCategory && !editingCategory.preset"
            class="danger-btn"
            @click="deleteCurrentCategory"
          >删除</button>
          <button class="ghost-btn" @click="closeCategoryModal">取消</button>
          <button class="primary-btn" @click="saveCategory">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-page {
  padding: var(--space-2) 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  position: relative;
}

.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sub-title {
  flex: 1;
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.today-btn {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: none;
  background: var(--warm-100);
  color: var(--color-warm);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.today-btn:active { opacity: 0.7; }

/* 顶层视图切换条 */
.view-tabs-bar {
  padding: var(--space-2) var(--space-4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.view-tabs {
  display: flex;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  padding: 3px;
}
.view-tab {
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all 0.2s var(--ease-immersive);
}
.view-tab.active {
  background: var(--bg-50);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-sm);
}

/* AI 快速创建输入 */
.ai-input-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--warm-50);
  border-radius: var(--radius-full);
}
.ai-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--text-md);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  padding: 6px 4px;
}
.ai-input::placeholder {
  color: var(--color-text-tertiary);
}
.ai-send {
  width: 36px;
  height: 36px;
  border: none;
  background: var(--color-warm);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.ai-send:active { opacity: 0.8; }

/* 工具栏 */
.cal-toolbar {
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.nav-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.nav-arrow {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.nav-arrow:active { background: var(--bg-300); }
.period-label {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.period-label:active { background: var(--bg-100); }

/* 选择器 */
.picker-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.picker-section { display: flex; flex-direction: column; gap: var(--space-2); }
.picker-title {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}
.picker-grid {
  display: grid;
  gap: 6px;
}
.year-grid { grid-template-columns: repeat(4, 1fr); }
.month-grid { grid-template-columns: repeat(6, 1fr); }
.picker-cell {
  padding: var(--space-2);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.picker-cell.active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}
.picker-cell:active { opacity: 0.8; }

/* 日历 */
.calendar-card {
  padding: var(--space-3) var(--space-2);
}
.dow-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: var(--space-2);
}
.dow {
  text-align: center;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-tertiary);
  padding: var(--space-1) 0;
}
.dow-rest { color: var(--color-warm); }

.day-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.day-cell {
  position: relative;
  aspect-ratio: 1 / 1;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 2px 2px;
  cursor: pointer;
  transition: background 0.15s var(--ease-immersive);
}
.week-grid :deep(.day-cell) {
  aspect-ratio: auto;
  min-height: 100px;
  align-items: center;
}
.day-cell:active { background: var(--bg-200); }
.day-cell.out-month { opacity: 0.35; }
.day-cell.is-today {
  background: var(--warm-50);
}
.day-cell.is-today .day-num {
  color: var(--color-warm);
  font-weight: var(--fw-bold);
}
.day-cell.is-selected {
  background: var(--color-warm);
}
.day-cell.is-selected .day-num,
.day-cell.is-selected .day-holiday,
.day-cell.is-selected .day-rest {
  color: #fff;
}
.day-cell.is-selected .day-progress circle:first-child {
  stroke: rgba(255, 255, 255, 0.4);
}
.day-cell.is-selected .day-progress circle:last-child {
  stroke: #fff;
}
.day-cell.is-selected .day-badge {
  background: #fff;
  color: var(--color-warm);
}

.day-num {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  line-height: 1.2;
}
.day-holiday {
  font-size: 9px;
  color: var(--color-danger);
  font-weight: var(--fw-medium);
  margin-top: 2px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.day-rest {
  font-size: 9px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.day-bottom {
  position: absolute;
  bottom: 3px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.day-progress {
  display: block;
}
.day-badge {
  font-size: 9px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  background: var(--warm-50);
  border-radius: var(--radius-full);
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* 选中日详情 */
.day-detail {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.detail-date {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.meta-tag {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background: var(--bg-200);
  padding: 2px 8px;
  border-radius: var(--radius-full);
}
.meta-holiday {
  background: var(--danger-50);
  color: var(--color-danger);
  font-weight: var(--fw-medium);
}
.meta-rest {
  background: var(--bg-300);
  color: var(--color-text-secondary);
}
.add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  border-radius: var(--radius-full);
  cursor: pointer;
  flex-shrink: 0;
}
.add-btn:active { opacity: 0.85; }

.progress-bar {
  height: 6px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--warm-400), var(--color-warm));
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-out);
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.todo-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-50);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: opacity 0.2s var(--ease-immersive);
}
.todo-row:active { background: var(--bg-100); }
.todo-row.done { opacity: 0.55; }
.todo-row.done .todo-title {
  text-decoration: line-through;
  color: var(--color-text-tertiary);
}
.check-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--bg-400);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: all 0.15s var(--ease-immersive);
}
.check-btn.small {
  width: 18px;
  height: 18px;
  border-width: 1.5px;
}
.check-btn.checked {
  background: var(--color-success);
  border-color: var(--color-success);
  color: #fff;
}
.todo-main { flex: 1; min-width: 0; }
.todo-title {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.todo-sub {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 3px;
  flex-wrap: wrap;
}
.prio-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.todo-note {
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

/* 小徽章 */
.mini-badge {
  font-size: 10px;
  color: var(--color-text-secondary);
  background: var(--bg-200);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  white-space: nowrap;
}
.urgent-badge {
  font-size: 10px;
  font-weight: var(--fw-bold);
  color: #fff;
  background: var(--danger-500);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  line-height: 1.4;
}

.empty-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

/* ====== 四象限视图 ====== */
.quadrant-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}
@media (min-width: 768px) {
  .quadrant-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.quadrant-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border-top: 3px solid var(--bg-200);
}
.quadrant-card[data-q="q1"] { border-top-color: var(--danger-500); }
.quadrant-card[data-q="q2"] { border-top-color: var(--warning-500); }
.quadrant-card[data-q="q3"] { border-top-color: var(--color-warm); }
.quadrant-card[data-q="q4"] { border-top-color: var(--color-text-tertiary); }

.q-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.q-label {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
}
.q-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.q-count {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.q-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 40px;
}
.q-item {
  padding: var(--space-2) var(--space-3);
  background: var(--bg-50);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s var(--ease-immersive);
}
.q-item:active { background: var(--bg-100); }
.q-item.done .q-item-title {
  text-decoration: line-through;
  color: var(--color-text-tertiary);
}
.q-item-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  line-height: 1.3;
}
.q-item-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.q-empty {
  padding: var(--space-3);
  text-align: center;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.q-footer {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  padding-top: var(--space-2);
}

/* ====== 分类视图 ====== */
.category-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
@media (min-width: 768px) {
  .category-layout {
    flex-direction: row;
    align-items: flex-start;
  }
  .category-chips {
    width: 200px;
    flex-shrink: 0;
  }
  .category-list {
    flex: 1;
    min-width: 0;
  }
}
.category-chips {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}
.category-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-50);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
  text-align: left;
  width: 100%;
}
.category-chip.active {
  background: var(--warm-50);
  border-color: var(--color-warm);
}
.category-chip:active { opacity: 0.85; }
.chip-icon {
  font-size: var(--text-md);
  flex-shrink: 0;
}
.chip-name {
  flex: 1;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  background: var(--bg-200);
  padding: 1px 8px;
  border-radius: var(--radius-full);
}
.chip-edit {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  padding: 2px;
  flex-shrink: 0;
}
.add-category-btn {
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-divider);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.add-category-btn:active { background: var(--bg-100); }

.category-list {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.cat-section-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.cat-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.cat-group-title {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-semibold);
}

/* ====== 浮动新建按钮 ====== */
.fab {
  position: fixed;
  right: 20px;
  bottom: 80px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  background: var(--color-warm);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  z-index: 50;
}
.fab:active { transform: scale(0.95); }

.ghost-btn {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.primary-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.primary-btn:disabled { opacity: 0.4; }
.danger-btn {
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-danger);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}

/* ====== 分类弹窗（保留旧 modal-mask） ====== */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.category-sheet {
  width: 100%;
  max-width: 420px;
  border-radius: var(--radius-2xl);
  padding: var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  margin: auto;
  animation: cat-pop 0.25s var(--ease-out);
}
@keyframes cat-pop {
  from { transform: scale(0.92); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
/* ====== 新编辑器（BottomSheet 内部） ====== */
.ed-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
}
.ed-bottom-space {
  height: 12px;
}

/* 象限提示横幅 */
.ed-q-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--q-accent) 10%, transparent);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--q-accent);
  font-weight: var(--fw-medium);
}
.ed-q-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--q-accent);
  flex-shrink: 0;
}
.ed-q-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-weight: var(--fw-normal);
}

/* 标题区 */
.ed-section--title {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: var(--space-2) 0;
  border-top: none;
}
.ed-title-input {
  width: 100%;
  border: none;
  background: transparent;
  font-size: 22px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  padding: 4px 0;
  line-height: 1.3;
}
.ed-title-input::placeholder {
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
}
.ed-note-input {
  width: 100%;
  border: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  outline: none;
  font-family: inherit;
  padding: 2px 0 4px;
  resize: none;
  line-height: 1.4;
}
.ed-note-input::placeholder { color: var(--color-text-tertiary); }

.ed-ai-help {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-immersive);
}
.ed-ai-help:active {
  transform: scale(0.98);
  background: var(--bg-100);
}
.ed-ai-help i:first-child {
  color: var(--color-warm);
}
.ed-ai-help span {
  flex: 1;
  text-align: left;
}

/* 通用 section */
.ed-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-divider);
}
.ed-section-title {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 2px;
}
.ed-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ed-mini-add {
  display: flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.ed-mini-add:active { background: var(--warm-50); }

/* 类型卡片 */
.kind-cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.kind-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 2px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: var(--bg-50);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s var(--ease-immersive);
  position: relative;
}
.kind-card.active {
  border-color: var(--color-warm);
  background: var(--warm-50);
}
.kind-card-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
}
.kind-card.active .kind-card-icon {
  background: var(--color-warm);
  color: #fff;
}
.kind-card-info { flex: 1; min-width: 0; }
.kind-card-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.kind-card-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.kind-card-check {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-warm);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 日期 chips */
.date-chips,
.time-quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.date-chip {
  padding: 6px 14px;
  border: 1.5px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.date-chip.active {
  border-color: var(--color-warm);
  background: var(--color-warm);
  color: #fff;
}
.date-chip:active { transform: scale(0.96); }

.date-input-row {
  display: flex;
}
.ed-input {
  width: 100%;
  padding: 10px 14px;
  border: 1.5px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.ed-input:focus { border-color: var(--color-warm); }
.ed-input--small { width: 80px; text-align: center; }
.ed-input--icon { padding-left: 38px; }
.ed-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 32px;
}

/* 时间范围行 */
.time-range-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}
.time-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.time-cell-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  padding: 0 2px;
}
.time-arrow {
  font-size: var(--text-lg);
  color: var(--color-text-tertiary);
  padding-bottom: 10px;
}

/* iOS 风格 toggle */
.ed-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.ed-toggle-info { flex: 1; min-width: 0; }
.ed-toggle-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  color: var(--color-text);
}
.ed-toggle-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.ios-toggle {
  width: 48px;
  height: 28px;
  border-radius: 14px;
  border: none;
  background: var(--bg-300);
  cursor: pointer;
  position: relative;
  transition: background 0.2s var(--ease-immersive);
  flex-shrink: 0;
  padding: 0;
}
.ios-toggle.on { background: var(--color-warm); }
.ios-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  transition: transform 0.2s var(--ease-immersive);
}
.ios-toggle.on .ios-toggle-knob { transform: translateX(20px); }

/* 分段按钮（重复类型） */
.seg-buttons.ed-seg {
  background: var(--bg-200);
  border-radius: var(--radius-md);
  padding: 3px;
  gap: 2px;
}
.seg-buttons .seg-btn {
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: var(--text-sm);
}

/* 周几选择 */
.weekday-toggles {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}
.weekday-btn {
  padding: 10px 0;
  border: 1.5px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.weekday-btn.active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

/* 重复额外选项 */
.recurrence-extra {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.rec-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.rec-field-label { font-weight: var(--fw-medium); white-space: nowrap; }
.rec-field-unit { color: var(--color-text-tertiary); white-space: nowrap; }

/* 行内 checkbox */
.ed-check-inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 4px 0;
}
.ed-checkbox {
  width: 18px;
  height: 18px;
  accent-color: var(--color-warm);
  flex-shrink: 0;
}
.ed-check-label { line-height: 1.3; }
.ed-urgent-row {
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger-500) 6%, transparent);
  border-radius: var(--radius-md);
  margin-top: 4px;
}

/* 优先级 chips */
.prio-chips {
  display: flex;
  gap: var(--space-2);
}
.prio-chip {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px var(--space-3);
  border: 2px solid var(--color-divider);
  border-radius: var(--radius-md);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.prio-chip:active { transform: scale(0.97); }
.prio-dot-chip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-400);
}
.prio--low.prio-chip.active {
  border-color: var(--color-text-tertiary);
  background: var(--bg-200);
  color: var(--color-text);
}
.prio--low.prio-chip.active .prio-dot-chip { background: var(--color-text-tertiary); }
.prio--normal.prio-chip.active {
  border-color: var(--color-warning);
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  color: var(--color-warning);
}
.prio--normal.prio-chip.active .prio-dot-chip { background: var(--color-warning); }
.prio--high.prio-chip.active {
  border-color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  color: var(--color-danger);
}
.prio--high.prio-chip.active .prio-dot-chip { background: var(--color-danger); }

/* 附加信息输入组 */
.ed-field-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ed-input-with-icon {
  position: relative;
  display: flex;
  align-items: center;
}
.ed-input-with-icon > svg {
  position: absolute;
  left: 12px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

/* 空提示 */
.ed-empty-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
  border: 1px dashed var(--color-divider);
}

/* 子任务列表 */
.subtask-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.subtask-row-new {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.sub-check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--bg-400);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: all 0.15s;
  padding: 0;
}
.sub-check.checked {
  background: var(--color-success);
  border-color: var(--color-success);
  color: #fff;
}
.sub-title-new {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  padding: 4px 0;
}
.sub-count-wrap {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.sub-count-new {
  width: 40px;
  padding: 4px 6px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  text-align: center;
}
.sub-count-new:focus { border-color: var(--color-warm); }
.sub-unit-new {
  width: 44px;
  padding: 4px 6px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
}
.sub-unit-new:focus { border-color: var(--color-warm); }
.sub-del {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.sub-del:active {
  background: color-mix(in srgb, var(--color-danger) 15%, transparent);
  color: var(--color-danger);
}

/* 固定底部栏 */
.ed-footer {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--color-divider);
  background: var(--bg-50);
  margin: 0 calc(-1 * var(--space-4)) calc(-1 * var(--space-5));
}
.ed-footer-del {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  color: var(--color-danger);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.ed-footer-del:active { background: color-mix(in srgb, var(--color-danger) 20%, transparent); }
.ed-footer-save {
  flex: 1;
  height: 48px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  font-family: inherit;
  transition: opacity 0.15s;
}
.ed-footer-save.disabled { opacity: 0.4; pointer-events: none; }
.ed-footer-save:active { opacity: 0.85; }
</style>
