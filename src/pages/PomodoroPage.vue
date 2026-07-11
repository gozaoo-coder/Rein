<script setup lang="ts">
/**
 * PomodoroPage — 番茄钟计时页
 *
 * 同时服务两种入口：
 *   - 移动端：经路由进入，由 AppShell + AppTopBar 包裹
 *   - 桌面端：在独立 Tauri 窗口打开，由 AppShell + WindowTitleBar 包裹
 * 本页只渲染自身内容（AppShell/TopBar 由布局系统提供）。
 *
 * 布局：
 *   - 窄屏（phone 或窗口宽高比 < 1.2）：纵向堆叠，整体可滚动
 *   - 宽屏（desktop 且宽高比 >= 1.2）：左右双栏，左侧计时器/控制/配置，右侧待办/AI
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { usePomodoroStore } from "@/stores/pomodoroStore";
import { useTodoStore } from "@/stores/todoStore";
import { useBreakpoint } from "@/composables/useBreakpoint";
import { useTopBar } from "@/composables/useTopBar";
import PomodoroAiPanel from "@/components/pomodoro/PomodoroAiPanel.vue";
import type { TodoItem } from "@/types/todo";

const store = usePomodoroStore();
const todoStore = useTodoStore();
const { mode } = useBreakpoint();
const { setActions, clearActions } = useTopBar();

// ===== 计时器 =====
let intervalId: number | null = null;

// ===== 响应式尺寸（用于判断宽屏布局） =====
const winW = ref(window.innerWidth);
const winH = ref(window.innerHeight);

function onResize() {
  winW.value = window.innerWidth;
  winH.value = window.innerHeight;
}

/** 宽屏：非 phone 且窗口宽高比 >= 1.2 */
const isWide = computed(() => mode.value !== "phone" && winW.value / winH.value >= 1.2);

// ===== 右侧 / 底部 Tab =====
const activeTab = ref<"todos" | "ai">("todos");

// ===== 阶段颜色 / 文案 =====
const phaseColor = computed(() => {
  switch (store.phase) {
    case "focus": return "var(--color-warm)";
    case "rest": return "var(--color-success)";
    default: return "var(--color-text-tertiary)";
  }
});

const phaseLabel = computed(() => {
  switch (store.phase) {
    case "idle": return "准备开始";
    case "focus": return "专注中";
    case "rest": return "休息中";
    case "done": return "已完成";
    default: return "";
  }
});

/** MM:SS 格式剩余时间 */
const timerText = computed(() => {
  const m = Math.floor(store.remainingSec / 60);
  const s = store.remainingSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
});

// ===== 进度环参数 =====
const RADIUS = 80;
const CIRC = 2 * Math.PI * RADIUS;
const dashOffset = computed(() => CIRC * (1 - store.progress));

// ===== 控制 =====
const primaryLabel = computed(() => {
  if (store.running) return "暂停";
  if (store.phase === "done") return "重新开始";
  return "开始";
});

function onPrimary() {
  if (store.running) store.pause();
  else store.start();
}

// ===== 配置编辑 =====
const focusMin = ref(store.config.focusMin);
const restMin = ref(store.config.restMin);
const targetCount = ref(store.config.targetCount);

const focusOptions = [23, 25, 30, 35, 40, 45];
const restOptions = [5, 10, 15, 20];
const countOptions = [1, 2, 3, 4, 5, 6, 8];

function saveConfig() {
  store.setConfig({
    focusMin: focusMin.value,
    restMin: restMin.value,
    targetCount: targetCount.value,
  });
}

// AI 工具可能外部修改配置，同步回本地 ref
watch(() => store.config, (c) => {
  focusMin.value = c.focusMin;
  restMin.value = c.restMin;
  targetCount.value = c.targetCount;
}, { deep: true });

// ===== 待办交互 =====
const PRIORITY_BADGE: Record<string, { label: string; color: string }> = {
  high: { label: "高", color: "var(--color-danger)" },
  normal: { label: "中", color: "var(--color-text-tertiary)" },
  low: { label: "低", color: "var(--color-primary)" },
};

function togglePin(todo: TodoItem) {
  store.setFocusTodo(store.focusTodoId === todo.id ? null : todo.id);
}

function onToggleDone(id: string) {
  todoStore.toggleDone(id);
}

/** 截止时间展示文本 */
function deadlineText(todo: TodoItem): string {
  if (!todo.dueDate) return "";
  const d = new Date();
  const tk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (todo.dueDate === tk) return todo.dueTime ? `今日 ${todo.dueTime}` : "今日";
  return todo.dueDate;
}

onMounted(() => {
  intervalId = window.setInterval(() => store.tick(), 1000);
  void store.load();
  // 确保待办数据已加载（idempotent）
  void todoStore.load();
  window.addEventListener("resize", onResize, { passive: true });
  // 注册顶栏操作（桌面主窗口场景）
  setActions([
    { id: "reset", icon: "arrow-clockwise", label: "重置", onClick: () => store.reset() },
  ]);
});

onUnmounted(() => {
  if (intervalId) clearInterval(intervalId);
  window.removeEventListener("resize", onResize);
  clearActions();
});
</script>

<template>
  <div class="pomo-page" :class="isWide ? 'pomo-wide' : 'pomo-scroll'">
    <!-- 左/上：计时器 + 控制 + 配置 -->
    <section class="pomo-left">
      <!-- 进度环 + 计时文字 -->
      <div class="timer-section">
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 200 200" aria-hidden="true">
            <!-- 轨道（SVG 属性无法用 CSS 变量，使用字面量 rgba） -->
            <circle
              cx="100" cy="100" r="80"
              fill="none"
              stroke="rgba(0,0,0,0.06)"
              stroke-width="12"
            />
            <!-- 进度弧（stroke 由内联 style 注入 CSS 变量；从顶部开始顺时针） -->
            <circle
              class="ring-progress"
              cx="100" cy="100" r="80"
              fill="none"
              stroke-width="12"
              stroke-linecap="round"
              transform="rotate(-90 100 100)"
              :stroke-dasharray="CIRC"
              :stroke-dashoffset="dashOffset"
              :style="{ stroke: phaseColor }"
            />
          </svg>
          <!-- 中心叠层：计时文字 + 阶段标签 -->
          <div class="ring-center">
            <div class="timer-text" :style="{ color: phaseColor }">{{ timerText }}</div>
            <div class="phase-label" :style="{ color: phaseColor }">{{ phaseLabel }}</div>
          </div>
        </div>
        <!-- 今日完成统计 -->
        <div class="stat-row">
          <span class="stat-chip">今日 {{ store.todayCompleted }}</span>
          <span class="stat-chip">{{ store.completedCount }}/{{ store.config.targetCount }}</span>
        </div>
      </div>

      <!-- 控制按钮 -->
      <div class="controls">
        <button
          class="ctrl-btn ctrl-primary"
          :style="{ background: phaseColor }"
          @click="onPrimary"
        >{{ primaryLabel }}</button>
        <button
          class="ctrl-btn ctrl-glass"
          :disabled="store.phase === 'idle'"
          @click="store.skip()"
        >跳过</button>
        <button class="ctrl-btn ctrl-glass" @click="store.reset()">重置</button>
      </div>

      <!-- 配置 -->
      <div class="config-section clean-card">
        <div class="config-row">
          <span class="config-label">专注时长</span>
          <select v-model="focusMin" class="pomo-select" @change="saveConfig">
            <option v-for="o in focusOptions" :key="o" :value="o">{{ o }} 分钟</option>
          </select>
        </div>
        <div class="config-row">
          <span class="config-label">休息时长</span>
          <select v-model="restMin" class="pomo-select" @change="saveConfig">
            <option v-for="o in restOptions" :key="o" :value="o">{{ o }} 分钟</option>
          </select>
        </div>
        <div class="config-row">
          <span class="config-label">目标番茄数</span>
          <select v-model="targetCount" class="pomo-select" @change="saveConfig">
            <option v-for="o in countOptions" :key="o" :value="o">{{ o }} 个</option>
          </select>
        </div>
      </div>
    </section>

    <!-- 右/下：Tab 切换 + 待办/AI -->
    <section class="pomo-right">
      <div class="tab-switch">
        <button
          class="tab-btn"
          :class="{ 'tab-active': activeTab === 'todos' }"
          @click="activeTab = 'todos'"
        >待办</button>
        <button
          class="tab-btn"
          :class="{ 'tab-active': activeTab === 'ai' }"
          @click="activeTab = 'ai'"
        >AI</button>
      </div>

      <div class="tab-content">
        <!-- 待办列表 -->
        <div v-if="activeTab === 'todos'" class="todo-section clean-card">
          <div v-if="store.sortedTodos.length === 0" class="todo-empty">
            <i class="bi bi-check2-circle" style="font-size:32px"></i>
            <p class="todo-empty-text">今日没有未完成待办</p>
          </div>
          <ul v-else class="todo-list">
            <li
              v-for="todo in store.sortedTodos"
              :key="todo.id"
              class="todo-item"
              :class="{ 'todo-focused': store.focusTodoId === todo.id }"
            >
              <button
                class="pin-btn"
                :title="store.focusTodoId === todo.id ? '取消专注' : '设为专注'"
                @click.stop="togglePin(todo)"
              >
                <i
                  :class="store.focusTodoId === todo.id ? 'bi bi-pin-angle-fill' : 'bi bi-pin-angle'"
                  style="font-size:18px"
                ></i>
              </button>

              <div class="todo-main" @click="togglePin(todo)">
                <div class="todo-title-row">
                  <span class="todo-title">{{ todo.title }}</span>
                  <span
                    class="priority-badge"
                    :style="{ color: PRIORITY_BADGE[todo.priority]?.color }"
                  >{{ PRIORITY_BADGE[todo.priority]?.label }}</span>
                </div>
                <div v-if="deadlineText(todo)" class="todo-deadline">
                  <i class="bi bi-clock" style="font-size:11px"></i>
                  <span>{{ deadlineText(todo) }}</span>
                </div>
              </div>

              <label class="done-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="todo.done"
                  @change="onToggleDone(todo.id)"
                />
                <i class="bi bi-check-lg"></i>
              </label>
            </li>
          </ul>
        </div>

        <!-- AI 面板（懒挂载，避免提前加载 pi-ai bundle） -->
        <PomodoroAiPanel v-if="activeTab === 'ai'" />
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ===== 页面容器 ===== */
.pomo-page {
  height: 100%;
  width: 100%;
  display: flex;
}
/* 窄屏：纵向堆叠 + 可滚动 */
.pomo-scroll {
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}
/* 宽屏：左右双栏 */
.pomo-wide {
  flex-direction: row;
}

/* ===== 左/上栏 ===== */
.pomo-left {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  flex-shrink: 0;
}
.pomo-wide .pomo-left {
  flex: 0 0 360px;
  overflow-y: auto;
  border-right: 1px solid var(--color-divider);
}
.pomo-scroll .pomo-left {
  padding-bottom: var(--space-4);
}

/* ===== 计时器区 ===== */
.timer-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
}
.ring-wrap {
  position: relative;
  width: 100%;
  max-width: 240px;
  aspect-ratio: 1 / 1;
}
.pomo-wide .ring-wrap {
  max-width: 280px;
}
.ring-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.ring-progress {
  transition: stroke-dashoffset 0.3s var(--ease-immersive);
}
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  pointer-events: none;
}
.timer-text {
  font-size: var(--text-hero);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.phase-label {
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
}

/* 今日完成统计 */
.stat-row {
  display: flex;
  gap: var(--space-2);
}
.stat-chip {
  font-size: var(--text-xs);
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}

/* ===== 控制按钮 ===== */
.controls {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
}
.ctrl-btn {
  height: 44px;
  padding: 0 var(--space-5);
  border-radius: var(--radius-pill);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-immersive);
  font-family: var(--font-sans);
}
.ctrl-btn:active { transform: scale(0.96); }
.ctrl-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctrl-primary {
  color: #fff;
  box-shadow: var(--shadow-md);
  flex: 1;
}
.ctrl-glass {
  background: var(--material-thin-bg);
  -webkit-backdrop-filter: blur(var(--material-thin-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-thin-blur)) saturate(180%);
  color: var(--color-text);
  border: 1px solid var(--material-thin-border);
}

/* ===== 配置区 ===== */
.config-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.config-label {
  font-size: var(--text-base);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}
.pomo-select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--bg-200);
  color: var(--color-text);
  border: none;
  border-radius: var(--radius-md);
  padding: 8px 32px 8px 12px;
  font-size: var(--text-base);
  font-family: var(--font-sans);
  font-weight: var(--fw-medium);
  cursor: pointer;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16'><path fill='%238e8e93' d='M8 11L3 6h10z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.pomo-select:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

/* ===== 右/下栏 ===== */
.pomo-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.pomo-scroll .pomo-right {
  padding: 0 var(--space-5) var(--space-6);
}
.pomo-wide .pomo-right {
  padding: var(--space-5);
  min-height: 0;
}

/* Tab 切换 */
.tab-switch {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--bg-200);
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  margin-bottom: var(--space-3);
  align-self: flex-start;
}
.tab-btn {
  padding: 6px 18px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-immersive);
  font-family: var(--font-sans);
}
.tab-active {
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
}

/* Tab 内容 */
.tab-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 窄屏下 AI 面板需要固定可视高度以内部滚动 */
.pomo-scroll .tab-content {
  min-height: 60vh;
}

/* ===== 待办列表 ===== */
.todo-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.pomo-wide .todo-section {
  overflow-y: auto;
}
.todo-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  padding: var(--space-8);
}
.todo-empty-text {
  font-size: var(--text-sm);
  margin: 0;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.todo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  transition: background var(--dur-fast) var(--ease-immersive);
}
.todo-item:active { background: var(--bg-200); }
.todo-focused {
  background: var(--warm-50);
}
.pin-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 50%;
}
.todo-focused .pin-btn {
  color: var(--color-warm);
}
.todo-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}
.todo-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.todo-title {
  font-size: var(--text-base);
  color: var(--color-text);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.priority-badge {
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  flex-shrink: 0;
}
.todo-deadline {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.done-check {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--bg-400);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: all var(--dur-fast) var(--ease-immersive);
}
.done-check input {
  position: absolute;
  opacity: 0;
  inset: 0;
  cursor: pointer;
  margin: 0;
}
.done-check .bi-check-lg {
  font-size: 14px;
  color: #fff;
  opacity: 0;
}
.done-check:has(input:checked) {
  background: var(--color-success);
  border-color: var(--color-success);
}
.done-check:has(input:checked) .bi-check-lg {
  opacity: 1;
}
</style>
