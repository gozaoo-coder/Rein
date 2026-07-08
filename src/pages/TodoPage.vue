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
import { useRouter } from "vue-router";
import { useTodoStore } from "@/stores/todoStore";
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

    <!-- ============ 编辑器抽屉 ============ -->
    <div v-if="showEditor" class="modal-mask" @click.self="closeEditor">
      <div class="clean-card editor-sheet">
        <div class="editor-head">
          <h3 class="editor-title">{{ editingItem ? '编辑待办' : '新建待办' }}</h3>
          <span v-if="editingQuadrant" class="editor-q-tag" :style="{ color: quadrantAccentVar(editingQuadrant) }">
            {{ QUADRANT_LABEL[editingQuadrant] }}
          </span>
        </div>

        <label class="ed-field">
          <span class="ed-label">标题 *</span>
          <input v-model="editorForm.title" type="text" placeholder="如：完成训练计划" />
        </label>

        <label class="ed-field">
          <span class="ed-label">备注</span>
          <textarea v-model="editorForm.note" rows="2" placeholder="可选" />
        </label>

        <div class="ed-field">
          <span class="ed-label">类型</span>
          <div class="seg-buttons">
            <button
              v-for="k in kindOptions"
              :key="k"
              class="seg-btn"
              :class="{ active: editorForm.kind === k }"
              @click="editorForm.kind = k"
            >{{ TODO_KIND_LABEL[k] }}</button>
          </div>
        </div>

        <div class="ed-grid">
          <label class="ed-field">
            <span class="ed-label">{{ editorForm.kind === 'deadline' ? '截止日期' : '日期' }}</span>
            <input v-model="editorForm.dueDate" type="date" />
          </label>
          <label v-if="editorForm.kind === 'deadline'" class="ed-field">
            <span class="ed-label">截止时间</span>
            <input v-model="editorForm.dueTime" type="time" />
          </label>
        </div>

        <div v-if="editorForm.kind === 'time-range'" class="ed-grid">
          <label class="ed-field">
            <span class="ed-label">开始时间</span>
            <input v-model="editorForm.startTime" type="time" />
          </label>
          <label class="ed-field">
            <span class="ed-label">结束时间</span>
            <input v-model="editorForm.endTime" type="time" />
          </label>
        </div>

        <div class="ed-field">
          <span class="ed-label">重复</span>
          <div class="toggle-row">
            <button
              class="toggle-pill"
              :class="{ on: editorForm.recurrenceEnabled }"
              @click="editorForm.recurrenceEnabled = !editorForm.recurrenceEnabled"
            >{{ editorForm.recurrenceEnabled ? '已开启' : '关闭' }}</button>
          </div>
        </div>

        <template v-if="editorForm.recurrenceEnabled">
          <div class="ed-field">
            <span class="ed-label">重复方式</span>
            <div class="seg-buttons">
              <button
                v-for="t in recurrenceTypeOptions"
                :key="t"
                class="seg-btn"
                :class="{ active: editorForm.recurrenceType === t }"
                @click="editorForm.recurrenceType = t"
              >{{ RECURRENCE_LABEL[t] }}</button>
            </div>
          </div>

          <div v-if="editorForm.recurrenceType === 'custom'" class="ed-field">
            <span class="ed-label">每周几</span>
            <div class="weekday-toggles">
              <button
                v-for="(lbl, i) in weekdayLabels"
                :key="i"
                class="weekday-btn"
                :class="{ active: editorForm.recurrenceDays.includes(i) }"
                @click="toggleWeekday(i)"
              >{{ lbl }}</button>
            </div>
          </div>

          <div class="ed-grid">
            <label class="ed-field">
              <span class="ed-label">间隔（每 N 个单位）</span>
              <input
                v-model.number="editorForm.recurrenceInterval"
                type="number"
                min="1"
              />
            </label>
            <label class="ed-field">
              <span class="ed-label">结束日期（可选）</span>
              <input v-model="editorForm.recurrenceUntil" type="date" />
            </label>
          </div>

          <label class="ed-field ed-check-row">
            <input
              v-model="editorForm.checkin"
              type="checkbox"
              class="ed-checkbox"
            />
            <span>每日打卡</span>
          </label>
        </template>

        <label class="ed-field">
          <span class="ed-label">地点</span>
          <input
            v-model="editorForm.location"
            type="text"
            placeholder="如：公司 / 健身房"
          />
        </label>

        <div class="ed-field">
          <span class="ed-label">优先级</span>
          <div class="seg-buttons">
            <button
              v-for="p in priorityOptions"
              :key="p"
              class="seg-btn"
              :class="{ active: editorForm.priority === p }"
              @click="editorForm.priority = p"
            >{{ PRIORITY_LABEL[p] }}</button>
          </div>
        </div>

        <div class="ed-field">
          <span class="ed-label">紧急</span>
          <div class="toggle-row">
            <button
              class="toggle-pill"
              :class="{ on: editorForm.urgent }"
              @click="editorForm.urgent = !editorForm.urgent"
            >{{ editorForm.urgent ? '紧急' : '非紧急' }}</button>
          </div>
        </div>

        <label class="ed-field">
          <span class="ed-label">分类</span>
          <select v-model="editorForm.categoryId">
            <option
              v-for="cat in store.categories"
              :key="cat.id"
              :value="cat.id"
            >{{ cat.icon }} {{ cat.name }}</option>
          </select>
        </label>

        <div class="ed-field">
          <div class="ed-label-row">
            <span class="ed-label">子任务</span>
            <button class="mini-add-btn" @click="addSubtaskRow">+ 添加子任务</button>
          </div>
          <div v-if="!editorForm.subtasks.length" class="ed-hint">暂无子任务</div>
          <div
            v-for="(sub, idx) in editorForm.subtasks"
            :key="idx"
            class="subtask-row"
          >
            <button
              class="check-btn small"
              :class="{ checked: sub.done }"
              @click="sub.done = !sub.done"
              :aria-label="sub.done ? '取消完成' : '标记完成'"
            >
              <i v-if="sub.done" class="bi bi-check-lg" style="font-size:12px"></i>
            </button>
            <input
              v-model="sub.title"
              class="sub-input sub-title-input"
              type="text"
              placeholder="子任务标题"
            />
            <input
              v-model="sub.countMin"
              class="sub-input sub-count-input"
              type="number"
              min="0"
              placeholder="最小"
            />
            <input
              v-model="sub.countMax"
              class="sub-input sub-count-input"
              type="number"
              min="0"
              placeholder="最大"
            />
            <input
              v-model="sub.unit"
              class="sub-input sub-unit-input"
              type="text"
              placeholder="单位"
            />
            <button
              class="sub-remove"
              @click="removeSubtaskRow(idx)"
              aria-label="删除子任务"
            >✕</button>
          </div>
        </div>

        <div class="ed-actions">
          <button v-if="editingItem" class="danger-btn" @click="removeCurrent">删除</button>
          <button class="ghost-btn" @click="closeEditor">取消</button>
          <button
            class="primary-btn"
            :disabled="!editorForm.title.trim()"
            @click="saveEditor"
          >保存</button>
        </div>
      </div>
    </div>

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

/* ====== 编辑器 / 弹窗 ====== */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.editor-sheet {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  animation: sheet-up 0.3s var(--ease-out);
}
.category-sheet {
  width: 100%;
  max-width: 420px;
  border-radius: var(--radius-2xl);
  padding: var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  margin: auto;
  align-self: center;
  animation: sheet-up 0.3s var(--ease-out);
}
@keyframes sheet-up {
  from { transform: translateY(100%); opacity: 0.4; }
  to { transform: translateY(0); opacity: 1; }
}
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.editor-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.editor-q-tag {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  background: var(--bg-200);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}
.ed-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-3);
}
.ed-label { font-weight: var(--fw-medium); }
.ed-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ed-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  padding: var(--space-1) 0;
}
.ed-field input,
.ed-field select,
.ed-field textarea {
  padding: 8px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--text-md);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  resize: vertical;
}
.ed-field input:focus,
.ed-field select:focus,
.ed-field textarea:focus {
  border-color: var(--color-warm);
}
.ed-field input:disabled {
  background: var(--bg-100);
  color: var(--color-text-tertiary);
}
.ed-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.ed-check-row {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}
.ed-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--color-warm);
}

/* 分段按钮组 */
.seg-buttons {
  display: flex;
  background: var(--bg-200);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 2px;
}
.seg-btn {
  flex: 1;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.seg-btn.active {
  background: var(--bg-50);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-sm);
}

/* 切换 pill */
.toggle-row {
  display: flex;
}
.toggle-pill {
  padding: 6px 16px;
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.toggle-pill.on {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

/* 周几选择 */
.weekday-toggles {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.weekday-btn {
  padding: 8px 0;
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}
.weekday-btn.active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

/* 子任务行 */
.mini-add-btn {
  border: none;
  background: transparent;
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  padding: 0;
}
.subtask-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-divider);
}
.subtask-row:last-child {
  border-bottom: none;
}
.sub-input {
  padding: 4px 8px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-xs);
  font-size: var(--text-sm);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
}
.sub-input:focus {
  border-color: var(--color-warm);
}
.sub-title-input {
  flex: 1;
  min-width: 0;
}
.sub-count-input {
  width: 56px;
  flex-shrink: 0;
}
.sub-unit-input {
  width: 60px;
  flex-shrink: 0;
}
.sub-remove {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 14px;
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 50%;
}
.sub-remove:active {
  background: var(--bg-200);
  color: var(--color-danger);
}

.ed-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
