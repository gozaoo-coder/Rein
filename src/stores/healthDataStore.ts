/**
 * healthDataStore — 饮水 / 饮食 / 体征 数据 store
 *
 * - 持久化到 Tauri storage
 * - 提供"今日"聚合 getter
 * - 食品库 CRUD（预设 + 自定义）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import type {
  BodyMetricsRecord,
  FoodItem,
  FoodRecord,
  WaterRecord,
  HealthScore,
} from "@/types/health";
import { calcBmi } from "@/types/health";
import { PRESET_FOODS } from "@/data/foodDatabase";
import { useUserStore } from "@/stores/userStore";
import { pushChange, pushDelete, registerSyncEntity } from "@/composables/useSyncBridge";

const WATER_KEY = "health-water";
const FOOD_RECORD_KEY = "health-food-records";
const FOOD_DB_KEY = "health-food-db";
const BODY_KEY = "health-body-metrics";

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateKeyFromTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function migrateFoodItem(f: FoodItem & { microNutrients?: string }): FoodItem {
  if (f.healthScore != null) return f;
  let score: HealthScore = 3;
  if (f.category === "蔬菜") score = 5;
  else if (f.category === "蛋白质" && f.fatPer100g < 5) score = 5;
  else if (f.category === "水果") score = f.sugarPer100g && f.sugarPer100g > 12 ? 3 : 4;
  else if (f.category === "主食") score = f.fiberPer100g && f.fiberPer100g > 5 ? 4 : 2;
  else if (f.category === "坚果") score = 3;
  else if (f.category === "乳制品") score = 4;
  else if (f.category === "饮品") score = f.caloriesPer100g < 10 ? 4 : 2;
  return { ...f, healthScore: score };
}

export const useHealthDataStore = defineStore("healthData", () => {
  // ===== 状态 =====
  const waterRecords = ref<WaterRecord[]>([]);
  const foodRecords = ref<FoodRecord[]>([]);
  const foodDb = ref<FoodItem[]>([...PRESET_FOODS]);
  const bodyMetrics = ref<BodyMetricsRecord[]>([]);
  const loaded = ref(false);

  // ===== 加载 / 持久化 =====
  async function load(): Promise<void> {
    if (loaded.value) return;
    const [w, fr, db, bm] = await Promise.all([
      readJSON<WaterRecord[]>(WATER_KEY),
      readJSON<FoodRecord[]>(FOOD_RECORD_KEY),
      readJSON<FoodItem[]>(FOOD_DB_KEY),
      readJSON<BodyMetricsRecord[]>(BODY_KEY),
    ]);
    waterRecords.value = w ?? [];
    foodRecords.value = fr ?? [];
    // 合并预设与存储：存储覆盖同名预设
    if (db && db.length > 0) {
      const presetIds = new Set(PRESET_FOODS.map((f) => f.id));
      const migrated = db
        .filter((f) => !presetIds.has(f.id))
        .map((f) => migrateFoodItem(f));
      foodDb.value = [...PRESET_FOODS, ...migrated];
    } else {
      foodDb.value = [...PRESET_FOODS];
    }
    bodyMetrics.value = bm ?? [];
    loaded.value = true;
  }

  async function persistWater(): Promise<void> {
    await writeJSON(WATER_KEY, waterRecords.value);
  }
  async function persistFoodRecords(): Promise<void> {
    await writeJSON(FOOD_RECORD_KEY, foodRecords.value);
  }
  async function persistFoodDb(): Promise<void> {
    // 只持久化自定义食品（预设从代码生成）
    const customs = foodDb.value.filter((f) => f.custom);
    await writeJSON(FOOD_DB_KEY, customs);
  }
  async function persistBody(): Promise<void> {
    await writeJSON(BODY_KEY, bodyMetrics.value);
  }

  // ===== 饮水 =====
  function addWater(amount: number): WaterRecord {
    const rec: WaterRecord = {
      id: genId("w"),
      amount,
      timestamp: Date.now(),
    };
    waterRecords.value.push(rec);
    void persistWater();
    void pushChange(WATER_KEY, rec.id, rec);
    return rec;
  }
  function removeWater(id: string): void {
    waterRecords.value = waterRecords.value.filter((r) => r.id !== id);
    void persistWater();
    void pushDelete(WATER_KEY, id);
  }
  function clearTodayWater(): void {
    const today = todayKey();
    const removed = waterRecords.value.filter((r) => dateKeyFromTs(r.timestamp) === today);
    waterRecords.value = waterRecords.value.filter((r) => dateKeyFromTs(r.timestamp) !== today);
    void persistWater();
    for (const r of removed) void pushDelete(WATER_KEY, r.id);
  }

  // ===== 饮食记录 =====
  function addFoodRecord(input: {
    foodId?: string;
    foodName: string;
    grams: number;
    calories?: number;
    carbs?: number;
    protein?: number;
    fat?: number;
  }): FoodRecord {
    // 若提供 foodId，自动计算营养
    let cal = input.calories ?? 0;
    let carbs = input.carbs ?? 0;
    let protein = input.protein ?? 0;
    let fat = input.fat ?? 0;
    if (input.foodId) {
      const food = foodDb.value.find((f) => f.id === input.foodId);
      if (food) {
        const ratio = input.grams / 100;
        cal = Math.round(food.caloriesPer100g * ratio);
        carbs = Math.round(food.carbsPer100g * ratio * 10) / 10;
        protein = Math.round(food.proteinPer100g * ratio * 10) / 10;
        fat = Math.round(food.fatPer100g * ratio * 10) / 10;
      }
    }
    const rec: FoodRecord = {
      id: genId("fr"),
      foodId: input.foodId,
      foodName: input.foodName,
      grams: input.grams,
      calories: cal,
      carbs,
      protein,
      fat,
      timestamp: Date.now(),
    };
    foodRecords.value.push(rec);
    void persistFoodRecords();
    void pushChange(FOOD_RECORD_KEY, rec.id, rec);
    return rec;
  }
  function removeFoodRecord(id: string): void {
    foodRecords.value = foodRecords.value.filter((r) => r.id !== id);
    void persistFoodRecords();
    void pushDelete(FOOD_RECORD_KEY, id);
  }

  // ===== 食品库 CRUD =====
  function addFoodItem(input: Omit<FoodItem, "id" | "custom" | "createdAt" | "updatedAt">): FoodItem {
    const now = Date.now();
    const item: FoodItem = {
      ...input,
      id: genId("food"),
      custom: true,
      createdAt: now,
      updatedAt: now,
    };
    foodDb.value.push(item);
    void persistFoodDb();
    void pushChange(FOOD_DB_KEY, item.id, item);
    return item;
  }
  function updateFoodItem(id: string, patch: Partial<Omit<FoodItem, "id" | "createdAt">>): void {
    const idx = foodDb.value.findIndex((f) => f.id === id);
    if (idx < 0) return;
    foodDb.value[idx] = { ...foodDb.value[idx], ...patch, updatedAt: Date.now() };
    void persistFoodDb();
    void pushChange(FOOD_DB_KEY, id, foodDb.value[idx]);
  }
  function deleteFoodItem(id: string): void {
    const item = foodDb.value.find((f) => f.id === id);
    if (!item || !item.custom) return; // 预设不可删
    foodDb.value = foodDb.value.filter((f) => f.id !== id);
    void persistFoodDb();
    void pushDelete(FOOD_DB_KEY, id);
  }
  function findFood(id: string): FoodItem | undefined {
    return foodDb.value.find((f) => f.id === id);
  }
  function searchFoods(query: string): FoodItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return foodDb.value.slice(0, 50);
    return foodDb.value.filter((f) => f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q));
  }

  // ===== 体征 =====
  function addBodyMetrics(input: { heightCm?: number; weightKg?: number; bodyFatPercent?: number }): BodyMetricsRecord {
    const prev = bodyMetrics.value[bodyMetrics.value.length - 1];
    const heightCm = input.heightCm ?? prev?.heightCm;
    const weightKg = input.weightKg ?? prev?.weightKg;
    const bodyFatPercent = input.bodyFatPercent ?? prev?.bodyFatPercent;
    const bmi = heightCm && weightKg ? calcBmi(heightCm, weightKg) : undefined;
    const rec: BodyMetricsRecord = {
      id: genId("bm"),
      heightCm,
      weightKg,
      bodyFatPercent,
      bmi,
      timestamp: Date.now(),
    };
    bodyMetrics.value.push(rec);
    void persistBody();
    void pushChange(BODY_KEY, rec.id, rec);
    if (input.weightKg != null) {
      try {
        useUserStore().setProfile({ weight: input.weightKg });
      } catch {
        /* noop */
      }
    }
    return rec;
  }

  // ===== 今日聚合 =====
  const todayWaterAmount = computed(() => {
    const today = todayKey();
    return waterRecords.value
      .filter((r) => dateKeyFromTs(r.timestamp) === today)
      .reduce((sum, r) => sum + r.amount, 0);
  });

  const todayFoodRecords = computed(() => {
    const today = todayKey();
    return foodRecords.value.filter((r) => dateKeyFromTs(r.timestamp) === today);
  });

  const todayCalories = computed(() =>
    todayFoodRecords.value.reduce((sum, r) => sum + r.calories, 0),
  );
  const todayCarbs = computed(() =>
    Math.round(todayFoodRecords.value.reduce((sum, r) => sum + r.carbs, 0) * 10) / 10,
  );
  const todayProtein = computed(() =>
    Math.round(todayFoodRecords.value.reduce((sum, r) => sum + r.protein, 0) * 10) / 10,
  );
  const todayFat = computed(() =>
    Math.round(todayFoodRecords.value.reduce((sum, r) => sum + r.fat, 0) * 10) / 10,
  );

  const latestBodyMetrics = computed<BodyMetricsRecord | undefined>(() => {
    if (bodyMetrics.value.length === 0) return undefined;
    return bodyMetrics.value[bodyMetrics.value.length - 1];
  });

  const currentBmi = computed<number | undefined>(() => latestBodyMetrics.value?.bmi);

  const currentWeight = computed<number>(
    () => latestBodyMetrics.value?.weightKg ?? useUserStore().profile.weight ?? 0,
  );

  /** 按日期分组获取饮食记录 */
  function foodRecordsByDate(date: string): FoodRecord[] {
    return foodRecords.value.filter((r) => dateKeyFromTs(r.timestamp) === date);
  }

  /** 按日期分组获取饮水 */
  function waterByDate(date: string): number {
    return waterRecords.value
      .filter((r) => dateKeyFromTs(r.timestamp) === date)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  return {
    waterRecords,
    foodRecords,
    foodDb,
    bodyMetrics,
    loaded,
    todayWaterAmount,
    todayFoodRecords,
    todayCalories,
    todayCarbs,
    todayProtein,
    todayFat,
    latestBodyMetrics,
    currentBmi,
    currentWeight,
    load,
    addWater,
    removeWater,
    clearTodayWater,
    addFoodRecord,
    removeFoodRecord,
    addFoodItem,
    updateFoodItem,
    deleteFoodItem,
    findFood,
    searchFoods,
    addBodyMetrics,
    foodRecordsByDate,
    waterByDate,
    applyRemoteWater,
    applyRemoteFoodRecord,
    applyRemoteFoodDb,
    applyRemoteBody,
  };
});

// ===== 远端同步 applyRemote =====

async function applyRemoteWater(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useHealthDataStore();
  const idx = store.waterRecords.findIndex((r) => r.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.waterRecords.splice(idx, 1);
      await writeJSON(WATER_KEY, store.waterRecords);
    }
    return;
  }
  const rec = payload as WaterRecord;
  if (!rec || typeof rec.id !== "string") return;
  if (idx >= 0) {
    if (rec.timestamp > store.waterRecords[idx].timestamp) {
      store.waterRecords[idx] = rec;
      await writeJSON(WATER_KEY, store.waterRecords);
    }
  } else {
    store.waterRecords.push(rec);
    await writeJSON(WATER_KEY, store.waterRecords);
  }
}

async function applyRemoteFoodRecord(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useHealthDataStore();
  const idx = store.foodRecords.findIndex((r) => r.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.foodRecords.splice(idx, 1);
      await writeJSON(FOOD_RECORD_KEY, store.foodRecords);
    }
    return;
  }
  const rec = payload as FoodRecord;
  if (!rec || typeof rec.id !== "string") return;
  if (idx >= 0) {
    if (rec.timestamp > store.foodRecords[idx].timestamp) {
      store.foodRecords[idx] = rec;
      await writeJSON(FOOD_RECORD_KEY, store.foodRecords);
    }
  } else {
    store.foodRecords.push(rec);
    await writeJSON(FOOD_RECORD_KEY, store.foodRecords);
  }
}

async function applyRemoteFoodDb(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useHealthDataStore();
  const idx = store.foodDb.findIndex((f) => f.id === id);
  if (deleted) {
    if (idx >= 0 && store.foodDb[idx].custom) {
      store.foodDb.splice(idx, 1);
      const customs = store.foodDb.filter((f) => f.custom);
      await writeJSON(FOOD_DB_KEY, customs);
    }
    return;
  }
  const item = payload as FoodItem;
  if (!item || typeof item.id !== "string") return;
  // 预设不可被远端覆盖
  if (idx >= 0 && !store.foodDb[idx].custom) return;
  if (idx >= 0) {
    if ((item.updatedAt ?? 0) > (store.foodDb[idx].updatedAt ?? 0)) {
      store.foodDb[idx] = item;
      const customs = store.foodDb.filter((f) => f.custom);
      await writeJSON(FOOD_DB_KEY, customs);
    }
  } else {
    store.foodDb.push(item);
    const customs = store.foodDb.filter((f) => f.custom);
    await writeJSON(FOOD_DB_KEY, customs);
  }
}

async function applyRemoteBody(id: string, payload: unknown, deleted: boolean): Promise<void> {
  const store = useHealthDataStore();
  const idx = store.bodyMetrics.findIndex((r) => r.id === id);
  if (deleted) {
    if (idx >= 0) {
      store.bodyMetrics.splice(idx, 1);
      await writeJSON(BODY_KEY, store.bodyMetrics);
    }
    return;
  }
  const rec = payload as BodyMetricsRecord;
  if (!rec || typeof rec.id !== "string") return;
  if (idx >= 0) {
    if (rec.timestamp > store.bodyMetrics[idx].timestamp) {
      store.bodyMetrics[idx] = rec;
      await writeJSON(BODY_KEY, store.bodyMetrics);
    }
  } else {
    store.bodyMetrics.push(rec);
    await writeJSON(BODY_KEY, store.bodyMetrics);
  }
}

registerSyncEntity<WaterRecord>({ kind: WATER_KEY, applyRemote: applyRemoteWater });
registerSyncEntity<FoodRecord>({ kind: FOOD_RECORD_KEY, applyRemote: applyRemoteFoodRecord });
registerSyncEntity<FoodItem>({ kind: FOOD_DB_KEY, applyRemote: applyRemoteFoodDb });
registerSyncEntity<BodyMetricsRecord>({ kind: BODY_KEY, applyRemote: applyRemoteBody });
