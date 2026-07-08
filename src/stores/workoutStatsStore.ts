import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { WorkoutRecord, WorkoutStats, DailyStat } from "@/types/workout-stats";
import { emptyStats } from "@/types/workout-stats";
import type { Course } from "@/types/course";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { pushChange, pushDelete, registerSyncEntity } from "@/composables/useSyncBridge";

const RECORDS_KEY = "workout-records";
const STATS_KEY = "workout-stats";

function genId(prefix = "wr"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 由记录数组聚合统计 */
export function computeStats(records: WorkoutRecord[]): WorkoutStats {
  const stats = emptyStats();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();

  // 最近 30 天桶
  const daily30 = new Map<string, DailyStat>();
  for (let i = 0; i < 30; i++) {
    const d = new Date(todayTs - i * 86400000);
    daily30.set(dateKey(d.getTime()), {
      date: dateKey(d.getTime()),
      sessions: 0,
      durationSec: 0,
      calories: 0,
    });
  }

  for (const r of records) {
    stats.totalSessions += 1;
    stats.totalDurationSec += r.durationSec;
    stats.totalCalories += r.caloriesBurned;
    stats.totalSets += r.totalSets;
    stats.totalCompletedSets += r.completedSets;

    stats.perCategoryCount[r.courseCategory] =
      (stats.perCategoryCount[r.courseCategory] ?? 0) + 1;

    const k = dateKey(r.startedAt);
    if (daily30.has(k)) {
      const d = daily30.get(k)!;
      d.sessions += 1;
      d.durationSec += r.durationSec;
      d.calories += r.caloriesBurned;
    }
  }

  // 连续打卡天数（从今天往前数）
  const activeDates = new Set(
    records.map((r) => dateKey(r.startedAt)),
  );
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(todayTs - i * 86400000);
    if (activeDates.has(dateKey(d.getTime()))) {
      streak += 1;
    } else if (i > 0) {
      break;
    }
  }
  stats.streakDays = streak;

  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  if (sorted.length > 0) {
    stats.lastActiveAt = sorted[sorted.length - 1].startedAt;
  }

  stats.last30Days = Array.from(daily30.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  stats.last7Days = stats.last30Days.slice(-7);

  return stats;
}

export const useWorkoutStatsStore = defineStore("workoutStats", () => {
  const records = ref<WorkoutRecord[]>([]);
  const stats = ref<WorkoutStats>(emptyStats());
  const loaded = ref(false);

  const totalSessions = computed(() => stats.value.totalSessions);
  const totalDurationSec = computed(() => stats.value.totalDurationSec);
  const totalCalories = computed(() => stats.value.totalCalories);
  const streakDays = computed(() => stats.value.streakDays);

  /** 按 id 取单条历史记录 */
  function getRecord(id: string): WorkoutRecord | undefined {
    return records.value.find((r) => r.id === id);
  }

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<WorkoutRecord[]>(RECORDS_KEY);
    records.value = stored ?? [];
    const storedStats = await readJSON<WorkoutStats>(STATS_KEY);
    stats.value = storedStats ?? computeStats(records.value);
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await Promise.all([
      writeJSON(RECORDS_KEY, records.value),
      writeJSON(STATS_KEY, stats.value),
    ]);
  }

  function addRecord(input: Omit<WorkoutRecord, "id">): WorkoutRecord {
    const rec: WorkoutRecord = { id: genId(), ...input };
    records.value.push(rec);
    stats.value = computeStats(records.value);
    void persist();
    void pushChange(RECORDS_KEY, rec.id, rec);
    void pushChange(STATS_KEY, "stats", stats.value);
    return rec;
  }

  /** 课程结束后调用：写入记录 + 通知 courseStore */
  function recordSession(course: Course, runtime: {
    durationSec: number;
    caloriesBurned: number;
    completedSets: number;
    totalSets: number;
    avgHeartRate?: number;
    maxHeartRate?: number;
    finished: boolean;
    startedAt: number;
    endedAt: number;
  }): WorkoutRecord {
    return addRecord({
      courseId: course.id,
      courseName: course.name,
      courseCategory: course.category,
      ...runtime,
    });
  }

  function deleteRecord(id: string): void {
    const idx = records.value.findIndex((r) => r.id === id);
    if (idx < 0) return;
    records.value.splice(idx, 1);
    stats.value = computeStats(records.value);
    void persist();
    void pushDelete(RECORDS_KEY, id);
    void pushChange(STATS_KEY, "stats", stats.value);
  }

  function clearAll(): void {
    records.value = [];
    stats.value = emptyStats();
    void persist();
    void pushChange(STATS_KEY, "stats", stats.value);
  }

  return {
    records,
    stats,
    totalSessions,
    totalDurationSec,
    totalCalories,
    streakDays,
    getRecord,
    load,
    addRecord,
    recordSession,
    deleteRecord,
    clearAll,
    applyRemoteRecord,
    applyRemoteStats,
  };
});

/** 远端同步应用：单条 workout-record */
async function applyRemoteRecord(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useWorkoutStatsStore();
  const idx = store.records.findIndex((r) => r.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.records.splice(idx, 1);
      store.stats = computeStats(store.records);
      await writeJSON(RECORDS_KEY, store.records);
      await writeJSON(STATS_KEY, store.stats);
    }
    return;
  }
  const rec = payload as WorkoutRecord;
  if (!rec || typeof rec.id !== "string") return;
  if (idx >= 0) {
    if (rec.startedAt > store.records[idx].startedAt) {
      store.records[idx] = rec;
      store.stats = computeStats(store.records);
      await writeJSON(RECORDS_KEY, store.records);
      await writeJSON(STATS_KEY, store.stats);
    }
  } else {
    store.records.push(rec);
    store.stats = computeStats(store.records);
    await writeJSON(RECORDS_KEY, store.records);
    await writeJSON(STATS_KEY, store.stats);
  }
}

/** 远端同步应用：workout-stats 单条（id="stats"） */
async function applyRemoteStats(_id: string, payload: unknown, deleted: boolean): Promise<void> {
  if (deleted) return;
  const store = useWorkoutStatsStore();
  const incoming = payload as WorkoutStats;
  if (!incoming) return;
  // LWW：以 lastActiveAt 比较（stats 没有 updatedAt）
  if (incoming.lastActiveAt > store.stats.lastActiveAt) {
    store.stats = incoming;
    await writeJSON(STATS_KEY, store.stats);
  }
}

registerSyncEntity<WorkoutRecord>({ kind: RECORDS_KEY, applyRemote: applyRemoteRecord });
registerSyncEntity<WorkoutStats>({ kind: STATS_KEY, applyRemote: applyRemoteStats });
