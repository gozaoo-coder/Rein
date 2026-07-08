<script setup lang="ts">
/**
 * TodoPage — 待办事项 + 日历视图
 *
 * 功能：
 * - 月视图 / 周视图切换
 * - 年份月份跳转（左右箭头 + 月份选择器）
 * - 日期单元格：进度条 + 待办角标 + 节假日/休息日标注
 * - 选中日期查看/编辑待办
 * - 新增/完成/删除待办
 *
 * 设计：HarmonyOS 沉浸光感 — 暖橙渐变 + 玻璃白卡 + 5 级材质
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useTodoStore } from "@/stores/todoStore";
import {
  HOLIDAY_PRESETS,
  PRIORITY_LABEL,
  type CalendarView,
  type DayMeta,
  type TodoItem,
  type TodoPriority,
} from "@/types/todo";

const router = useRouter();
const store = useTodoStore();

// ====== 日历状态 ======
const today = new Date();
const viewYear = ref(today.getFullYear());
const viewMonth = ref(today.getMonth()); // 0-11
const viewMode = ref<CalendarView>("month");
/** 周视图起始日（周日为头） */
const weekStartDate = ref<Date>(startOfWeek(today));
const selectedDate = ref<string>(dateKey(today));

const showMonthPicker = ref(false);
const showYearPicker = ref(false);
const showEditor = ref(false);
const editingItem = ref<TodoItem | null>(null);

const editorForm = ref({
  title: "",
  note: "",
  dueDate: todayKey(),
  priority: "normal" as TodoPriority,
});

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

// ====== 日历构建 ======
const monthDays = computed<DayMeta[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(viewYear.value, viewMonth.value + 1, 0).getDate();
  const cells: DayMeta[] = [];
  const todayK = todayKey();

  // 上月尾部填充
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(viewYear.value, viewMonth.value, -i);
    cells.push(buildDayMeta(d, false, todayK));
  }
  // 当月
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(viewYear.value, viewMonth.value, i);
    cells.push(buildDayMeta(d, true, todayK));
  }
  // 下月头部填充至 6 行（42 格）
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
  viewMode.value === "month" ? monthDays.value : weekDays.value,
);

const monthLabel = computed(() => `${viewYear.value} 年 ${viewMonth.value + 1} 月`);

const weekLabel = computed(() => {
  const start = weekStartDate.value;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
});

// ====== 选中日期待办 ======
const selectedItems = computed<TodoItem[]>(() => store.itemsOfDate(selectedDate.value));
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
  if (viewMode.value === "month") prevMonth();
  else prevWeek();
}
function goNext() {
  if (viewMode.value === "month") nextMonth();
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
  // 月视图点击非当月日期：跳转
  if (viewMode.value === "month" && !meta.inMonth) {
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

// ====== 编辑器 ======
function openCreate() {
  editingItem.value = null;
  editorForm.value = {
    title: "",
    note: "",
    dueDate: selectedDate.value,
    priority: "normal",
  };
  showEditor.value = true;
}
function openEdit(item: TodoItem) {
  editingItem.value = item;
  editorForm.value = {
    title: item.title,
    note: item.note ?? "",
    dueDate: item.dueDate ?? todayKey(),
    priority: item.priority,
  };
  showEditor.value = true;
}
function closeEditor() {
  showEditor.value = false;
  editingItem.value = null;
}
function saveEditor() {
  const f = editorForm.value;
  if (!f.title.trim()) return;
  if (editingItem.value) {
    store.updateItem(editingItem.value.id, {
      title: f.title.trim(),
      note: f.note.trim() || undefined,
      dueDate: f.dueDate,
      priority: f.priority,
    });
  } else {
    store.createItem({
      title: f.title,
      note: f.note,
      dueDate: f.dueDate,
      priority: f.priority,
    });
  }
  closeEditor();
}
function removeCurrent() {
  if (!editingItem.value) return;
  store.deleteItem(editingItem.value.id);
  closeEditor();
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

onMounted(() => {
  store.load();
});

// 切换视图时同步周起始日为选中日期所在周
watch(viewMode, (m) => {
  if (m === "week") {
    weekStartDate.value = startOfWeek(parseDate(selectedDate.value));
  }
});
</script>

<template>
  <div class="todo-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h2 class="sub-title">待办事项</h2>
      <button class="today-btn" @click="jumpToday">今天</button>
    </header>

    <!-- 视图切换 + 月份导航 -->
    <section class="clean-card cal-toolbar">
      <div class="view-tabs">
        <button class="view-tab" :class="{ active: viewMode === 'month' }" @click="viewMode = 'month'">月</button>
        <button class="view-tab" :class="{ active: viewMode === 'week' }" @click="viewMode = 'week'">周</button>
      </div>
      <div class="nav-row">
        <button class="nav-arrow" @click="goPrev" aria-label="上一个">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <button class="period-label" @click="showMonthPicker = !showMonthPicker">
          <span v-if="viewMode === 'month'">{{ monthLabel }}</span>
          <span v-else>{{ weekLabel }}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="nav-arrow" @click="goNext" aria-label="下一个">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
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
      <!-- 星期表头 -->
      <div class="dow-row">
        <div class="dow dow-rest">日</div>
        <div class="dow">一</div>
        <div class="dow">二</div>
        <div class="dow">三</div>
        <div class="dow">四</div>
        <div class="dow">五</div>
        <div class="dow dow-rest">六</div>
      </div>
      <!-- 日期格 -->
      <div class="day-grid" :class="{ 'week-grid': viewMode === 'week' }">
        <button
          v-for="meta in calendarDays"
          :key="meta.date"
          class="day-cell"
          :class="{
            'out-month': viewMode === 'month' && !meta.inMonth,
            'is-today': meta.isToday,
            'is-selected': meta.date === selectedDate,
            'is-weekend': meta.isWeekend,
            'is-holiday': meta.isHoliday,
          }"
          @click="selectDay(meta)"
        >
          <div class="day-num">{{ meta.day }}</div>
          <!-- 节假日标注 -->
          <div v-if="meta.holidayName" class="day-holiday">{{ meta.holidayName }}</div>
          <div v-else-if="meta.isWeekend && meta.inMonth" class="day-rest">休</div>
          <!-- 进度环 + 角标 -->
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          <span>新建</span>
        </button>
      </div>

      <!-- 进度条 -->
      <div v-if="selectedItems.length" class="progress-bar">
        <div class="progress-fill" :style="{ width: `${selectedProgress * 100}%` }" />
      </div>

      <!-- 待办列表 -->
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
            <svg v-if="item.done" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <div class="todo-main">
            <div class="todo-title">{{ item.title }}</div>
            <div class="todo-sub">
              <span class="prio-dot" :style="{ background: priorityColor(item.priority) }" />
              <span>{{ PRIORITY_LABEL[item.priority] }}</span>
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

    <!-- 编辑器抽屉 -->
    <div v-if="showEditor" class="modal-mask" @click.self="closeEditor">
      <div class="clean-card editor-sheet">
        <h3 class="editor-title">{{ editingItem ? '编辑待办' : '新建待办' }}</h3>
        <label class="ed-field">
          <span class="ed-label">标题 *</span>
          <input v-model="editorForm.title" type="text" placeholder="如：完成训练计划" />
        </label>
        <label class="ed-field">
          <span class="ed-label">备注</span>
          <textarea v-model="editorForm.note" rows="2" placeholder="可选" />
        </label>
        <div class="ed-grid">
          <label class="ed-field">
            <span class="ed-label">日期</span>
            <input v-model="editorForm.dueDate" type="date" />
          </label>
          <label class="ed-field">
            <span class="ed-label">优先级</span>
            <select v-model="editorForm.priority">
              <option value="low">低</option>
              <option value="normal">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
        <div class="ed-actions">
          <button v-if="editingItem" class="danger-btn" @click="removeCurrent">删除</button>
          <button class="ghost-btn" @click="closeEditor">取消</button>
          <button class="primary-btn" :disabled="!editorForm.title.trim()" @click="saveEditor">保存</button>
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
  padding: 0 var(--space-1);
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

/* 工具栏 */
.cal-toolbar {
  padding: var(--space-3) var(--space-4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
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
  transition: all 0.2s;
}
.view-tab.active {
  background: var(--bg-50);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
  box-shadow: var(--shadow-sm);
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
  transition: all 0.15s;
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
.week-grid :deep(.day-cell) {
  min-height: 100px;
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
  transition: background 0.15s;
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
  transition: opacity 0.2s;
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
  transition: all 0.15s;
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

.empty-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

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

/* 编辑器 */
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
  max-width: 520px;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  animation: sheet-up 0.3s var(--ease-out);
}
@keyframes sheet-up {
  from { transform: translateY(100%); opacity: 0.4; }
  to { transform: translateY(0); opacity: 1; }
}
.editor-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
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
.ed-field input, .ed-field select, .ed-field textarea {
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
.ed-field input:focus, .ed-field select:focus, .ed-field textarea:focus {
  border-color: var(--color-warm);
}
.ed-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.ed-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
