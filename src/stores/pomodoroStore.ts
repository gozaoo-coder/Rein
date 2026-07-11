/**
 * pomodoroStore — 番茄钟 Pinia store
 *
 * 支持：
 * - 专注 / 休息 / 完成阶段流转（idle → focus → rest → … → done）
 * - 可配置专注时长（最小 23 分钟）、休息时长（最小 5 分钟）、目标番茄数
 * - 今日完成数统计（跨天自动重置）
 * - 专注待办绑定 + 自定义排序
 * - 持久化配置与今日统计到本地存储（不注册同步实体，计时状态为设备本地临时数据）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { useTodoStore } from "@/stores/todoStore";
import { quadrantOf, type TodoItem } from "@/types/todo";
import type { PomodoroConfig, PomodoroPhase, PomodoroSnapshot } from "@/types/pomodoro";

const KEY = "pomodoro-state";

/** 今日日期键 YYYY-MM-DD */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const usePomodoroStore = defineStore("pomodoro", () => {
  // ===== State =====
  const phase = ref<PomodoroPhase>("idle");
  const remainingSec = ref(25 * 60);
  const running = ref(false);
  const completedCount = ref(0);
  const todayCompleted = ref(0);
  const lastResetDate = ref(todayKey());
  const config = ref<PomodoroConfig>({ focusMin: 25, restMin: 5, targetCount: 4 });
  const focusTodoId = ref<string | null>(null);
  const customOrder = ref<string[] | null>(null);

  // ===== Computed =====

  /** 当前阶段总秒数 */
  const totalSec = computed(() => {
    if (phase.value === "focus") return config.value.focusMin * 60;
    if (phase.value === "rest") return config.value.restMin * 60;
    return config.value.focusMin * 60;
  });

  /** 进度 0..1 */
  const progress = computed(() => {
    const total = totalSec.value;
    if (total <= 0) return 0;
    const p = (total - remainingSec.value) / total;
    return Math.max(0, Math.min(1, p));
  });

  /** 排序后的今日未完成待办（供番茄钟页面展示） */
  const sortedTodos = computed<TodoItem[]>(() => {
    const todoStore = useTodoStore();
    const items = todoStore.todayItems.filter((t) => !t.done);

    // 如果设置了自定义顺序，完全覆盖排序
    if (customOrder.value) {
      const orderMap = new Map(customOrder.value.map((id, i) => [id, i]));
      return [...items].sort((a, b) => {
        const ai = orderMap.get(a.id) ?? Infinity;
        const bi = orderMap.get(b.id) ?? Infinity;
        return ai - bi;
      });
    }

    const quadrantRank: Record<string, number> = { q1: 0, q2: 1, q3: 2, q4: 3 };

    return [...items].sort((a, b) => {
      // 1. 专注待办置顶
      if (focusTodoId.value) {
        if (a.id === focusTodoId.value && b.id !== focusTodoId.value) return -1;
        if (b.id === focusTodoId.value && a.id !== focusTodoId.value) return 1;
      }
      // 2. 四象限 rank：q1=0, q2=1, q3=2, q4=3
      const qa = quadrantRank[quadrantOf(a)] ?? 3;
      const qb = quadrantRank[quadrantOf(b)] ?? 3;
      if (qa !== qb) return qa - qb;
      // 3. 截止时间临近度：越近越优先
      const da = deadlineDiff(a);
      const db = deadlineDiff(b);
      return da - db;
    });
  });

  /** 计算待办截止时间与当前的差值（毫秒），无截止日期返回 Infinity */
  function deadlineDiff(t: TodoItem): number {
    if (!t.dueDate) return Infinity;
    const time = t.dueTime || "23:59";
    const due = new Date(`${t.dueDate}T${time}`);
    return due.getTime() - Date.now();
  }

  // ===== Methods =====

  /** 计时器 tick：每秒调用，递减 remainingSec 并在归零时流转阶段 */
  function tick(): void {
    if (!running.value) return;
    remainingSec.value--;
    if (remainingSec.value <= 0) {
      if (phase.value === "focus") {
        completedCount.value++;
        todayCompleted.value++;
        if (completedCount.value >= config.value.targetCount) {
          phase.value = "done";
          running.value = false;
        } else {
          phase.value = "rest";
          remainingSec.value = config.value.restMin * 60;
        }
      } else if (phase.value === "rest") {
        phase.value = "focus";
        remainingSec.value = config.value.focusMin * 60;
      }
      void persist();
    }
  }

  /** 启动番茄钟：idle/done 时重置计数并进入专注阶段 */
  function start(): void {
    if (phase.value === "idle" || phase.value === "done") {
      completedCount.value = 0;
      phase.value = "focus";
      remainingSec.value = config.value.focusMin * 60;
    }
    running.value = true;
  }

  /** 暂停计时 */
  function pause(): void {
    running.value = false;
  }

  /** 恢复计时（仅专注/休息阶段可恢复） */
  function resume(): void {
    if (phase.value === "focus" || phase.value === "rest") {
      running.value = true;
    }
  }

  /** 跳过当前阶段：专注→休息（或完成），休息→专注。保持运行状态 */
  function skip(): void {
    if (phase.value === "focus") {
      if (completedCount.value >= config.value.targetCount) {
        phase.value = "done";
        running.value = false;
      } else {
        phase.value = "rest";
        remainingSec.value = config.value.restMin * 60;
      }
    } else if (phase.value === "rest") {
      phase.value = "focus";
      remainingSec.value = config.value.focusMin * 60;
    }
    void persist();
  }

  /** 重置番茄钟到 idle 状态 */
  function reset(): void {
    phase.value = "idle";
    running.value = false;
    remainingSec.value = config.value.focusMin * 60;
    completedCount.value = 0;
  }

  /** 修改配置，强制约束最小值。idle 状态下同步更新 remainingSec */
  function setConfig(patch: Partial<PomodoroConfig>): void {
    const next: PomodoroConfig = { ...config.value, ...patch };
    if (next.focusMin < 23) next.focusMin = 23;
    if (next.restMin < 5) next.restMin = 5;
    if (next.targetCount < 1) next.targetCount = 1;
    config.value = next;
    if (phase.value === "idle") {
      remainingSec.value = next.focusMin * 60;
    }
    void persist();
  }

  /** 设置当前专注的待办 id */
  function setFocusTodo(id: string | null): void {
    focusTodoId.value = id;
  }

  /** 设置自定义待办排序 */
  function reorderTodos(ids: string[]): void {
    customOrder.value = ids;
  }

  /** 返回当前状态快照（供 AI 工具读取） */
  function snapshot(): PomodoroSnapshot {
    return {
      phase: phase.value,
      remainingSec: remainingSec.value,
      totalSec: totalSec.value,
      running: running.value,
      completedCount: completedCount.value,
      targetCount: config.value.targetCount,
      focusTodoId: focusTodoId.value,
      config: config.value,
    };
  }

  /** 从本地存储加载配置与今日统计（不注册同步实体，计时状态为设备本地） */
  async function load(): Promise<void> {
    const stored = await readJSON<{
      config?: PomodoroConfig;
      todayCompleted?: number;
      lastResetDate?: string;
    }>(KEY);
    if (stored) {
      if (stored.config) config.value = stored.config;
      if (typeof stored.todayCompleted === "number") todayCompleted.value = stored.todayCompleted;
      if (typeof stored.lastResetDate === "string") lastResetDate.value = stored.lastResetDate;
    }
    // 跨天重置今日完成数
    const today = todayKey();
    if (lastResetDate.value !== today) {
      todayCompleted.value = 0;
      lastResetDate.value = today;
    }
    // idle 状态下对齐 remainingSec 到当前配置
    if (phase.value === "idle") {
      remainingSec.value = config.value.focusMin * 60;
    }
    await persist();
  }

  /** 持久化配置与今日统计到本地存储 */
  async function persist(): Promise<void> {
    await writeJSON(KEY, {
      config: config.value,
      todayCompleted: todayCompleted.value,
      lastResetDate: lastResetDate.value,
    });
  }

  return {
    phase,
    remainingSec,
    running,
    completedCount,
    todayCompleted,
    config,
    focusTodoId,
    customOrder,
    totalSec,
    progress,
    sortedTodos,
    tick,
    start,
    pause,
    resume,
    skip,
    reset,
    setConfig,
    setFocusTodo,
    reorderTodos,
    snapshot,
    load,
    persist,
  };
});
