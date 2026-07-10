/**
 * ringDataResolver — 将 RingDataSource 解析为实际 value/goal
 *
 * 供 SemiRingProgress 使用，三环数据可配置
 */
import type { RingDataSource } from "@/types/card";
import type { RingConfig } from "@/components/charts/SemiRingProgress.vue";
import type { useHealthDataStore } from "@/stores/healthDataStore";
import type { useTodoStore } from "@/stores/todoStore";
import type { useWorkoutStatsStore } from "@/stores/workoutStatsStore";

interface Stores {
  health: ReturnType<typeof useHealthDataStore>;
  todo: ReturnType<typeof useTodoStore>;
  stats: ReturnType<typeof useWorkoutStatsStore>;
}

export const RING_COLORS: Record<RingDataSource, { color: string; track: string }> = {
  calories: { color: "var(--ring-outer)", track: "#ffddd0" },
  steps: { color: "var(--ring-middle)", track: "#fff0cc" },
  exercise: { color: "var(--ring-inner)", track: "#d0e8ff" },
  "todo-progress": { color: "#7c6cf7", track: "#e8e0ff" },
  water: { color: "#3da9ff", track: "#d0e8ff" },
  bmi: { color: "#64bb5c", track: "#d4f0d0" },
};

/** 默认目标值 */
const DEFAULT_GOALS: Record<RingDataSource, number> = {
  calories: 2000,
  steps: 9000,
  exercise: 30,
  "todo-progress": 1,
  water: 2000,
  bmi: 24,
};

/** 解析单个环数据源 */
export function resolveRingData(
  source: RingDataSource,
  stores: Stores,
): RingConfig {
  const { color, track } = RING_COLORS[source];
  const goal = ringGoal(source, stores);

  let value = 0;
  switch (source) {
    case "calories":
      value = stores.health.todayCalories;
      break;
    case "steps":
      // 步数暂无传感器，使用占位
      value = 4247;
      break;
    case "exercise":
      // 今日运动分钟（取今日训练记录）
      value = Math.round((stores.stats.stats.last7Days[6]?.durationSec ?? 0) / 60);
      break;
    case "todo-progress":
      value = stores.todo.todayItems.length > 0
        ? stores.todo.todayItems.filter((t) => t.done).length / stores.todo.todayItems.length
        : 0;
      break;
    case "water":
      value = stores.health.todayWaterAmount;
      break;
    case "bmi":
      // BMI 进度：以 24 为目标（正常上限），过低过高都偏离
      value = stores.health.currentBmi ?? 0;
      break;
  }

  return { value, goal, color, track };
}

/** 解析环目标值：calories/water 优先取 userStore 推导值，回退 DEFAULT_GOALS */
function ringGoal(source: RingDataSource, stores: Stores): number {
  if (source === "calories") {
    return stores.health.dailyCalorieGoal || DEFAULT_GOALS.calories;
  }
  if (source === "water") {
    return stores.health.waterGoalMl || DEFAULT_GOALS.water;
  }
  return DEFAULT_GOALS[source];
}

/** 批量解析三环 */
export function resolveRings(
  sources: RingDataSource[],
  stores: Stores,
): RingConfig[] {
  return sources.map((s) => resolveRingData(s, stores));
}

/** 获取环数据当前值与目标的可读文本 */
export function ringDisplayText(
  source: RingDataSource,
  stores: Stores,
): { value: string; goal: string } {
  switch (source) {
    case "calories":
      return { value: `${stores.health.todayCalories}`, goal: `${ringGoal("calories", stores)}千卡` };
    case "steps":
      return { value: `4247`, goal: `${DEFAULT_GOALS.steps}步` };
    case "exercise":
      return { value: `${Math.round((stores.stats.stats.last7Days[6]?.durationSec ?? 0) / 60)}`, goal: `${DEFAULT_GOALS.exercise}分钟` };
    case "todo-progress": {
      const total = stores.todo.todayItems.length;
      const done = stores.todo.todayItems.filter((t) => t.done).length;
      return { value: `${done}/${total}`, goal: "完成" };
    }
    case "water":
      return { value: `${stores.health.todayWaterAmount}`, goal: `${ringGoal("water", stores)}ml` };
    case "bmi": {
      const bmi = stores.health.currentBmi;
      return { value: bmi ? bmi.toFixed(1) : "--", goal: "BMI 24" };
    }
  }
}
