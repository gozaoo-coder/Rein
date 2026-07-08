<script setup lang="ts">
/**
 * FoodPage — 饮食热量记录页
 *
 * - 今日热量 + 三大营养素
 * - 添加饮食表单（食品库选择 / 快速记录 + 克数）
 * - 周/月视图（热量/碳水/蛋白质/脂肪）
 */
import { computed, onMounted, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useRouter } from "vue-router";
import BarChartThin from "@/components/charts/BarChartThin.vue";

const store = useHealthDataStore();
const router = useRouter();

type Macro = "calories" | "carbs" | "protein" | "fat";
const view = ref<"week" | "month">("week");
const macro = ref<Macro>("calories");
const weekStart = ref<Date>(startOfWeek(new Date()));
const viewMonth = ref<Date>(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

onMounted(() => {
  void store.load();
});

// ===== 工具 =====
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const GOALS: Record<Macro, number> = {
  calories: 2000,
  carbs: 250,
  protein: 60,
  fat: 70,
};

const MACRO_LABEL: Record<Macro, string> = {
  calories: "热量",
  carbs: "碳水",
  protein: "蛋白质",
  fat: "脂肪",
};

const MACRO_UNIT: Record<Macro, string> = {
  calories: "千卡",
  carbs: "g",
  protein: "g",
  fat: "g",
};

const MACRO_COLOR: Record<Macro, string> = {
  calories: "var(--color-warm)",
  carbs: "#f5a623",
  protein: "#64bb5c",
  fat: "#9b59b6",
};

// ===== 今日 =====
const todayValues = computed(() => ({
  calories: store.todayCalories,
  carbs: store.todayCarbs,
  protein: store.todayProtein,
  fat: store.todayFat,
}));

// ===== 周/月聚合 =====
function dailyMacro(d: Date): number {
  const k = dateKey(d);
  const recs = store.foodRecordsByDate(k);
  switch (macro.value) {
    case "calories": return recs.reduce((s, r) => s + r.calories, 0);
    case "carbs": return Math.round(recs.reduce((s, r) => s + r.carbs, 0) * 10) / 10;
    case "protein": return Math.round(recs.reduce((s, r) => s + r.protein, 0) * 10) / 10;
    case "fat": return Math.round(recs.reduce((s, r) => s + r.fat, 0) * 10) / 10;
  }
}

const weekData = computed(() => {
  const out: { date: string; label: string; value: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart.value, i);
    out.push({ date: dateKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, value: dailyMacro(d) });
  }
  return out;
});

const monthData = computed(() => {
  const days = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 0).getDate();
  const out: { date: string; label: string; value: number }[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth(), i);
    out.push({ date: dateKey(d), label: String(i), value: dailyMacro(d) });
  }
  return out;
});

const chartData = computed(() =>
  view.value === "week" ? weekData.value.map((d) => d.value) : monthData.value.map((d) => d.value),
);
const chartLabels = computed(() =>
  view.value === "week" ? weekData.value.map((d) => d.label) : monthData.value.map((d) => d.label),
);

const avgValue = computed(() => {
  const arr = view.value === "week" ? weekData.value : monthData.value;
  const sum = arr.reduce((s, d) => s + d.value, 0);
  return arr.length > 0 ? Math.round(sum / arr.length * 10) / 10 : 0;
});

const periodLabel = computed(() => {
  if (view.value === "week") {
    const end = addDays(weekStart.value, 6);
    return `${weekStart.value.getMonth() + 1}/${weekStart.value.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
  }
  return `${viewMonth.value.getFullYear()}年${viewMonth.value.getMonth() + 1}月`;
});

function prevPeriod() {
  if (view.value === "week") weekStart.value = addDays(weekStart.value, -7);
  else viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
}
function nextPeriod() {
  if (view.value === "week") weekStart.value = addDays(weekStart.value, 7);
  else viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
}

// ===== 添加饮食 =====
const showAddForm = ref(false);
const searchQuery = ref("");
const selectedFood = ref<string>("");
const grams = ref<number>(100);
const customName = ref<string>("");
const customCalories = ref<number>(0);
const isCustom = ref(false);

const searchResults = computed(() => store.searchFoods(searchQuery.value).slice(0, 20));

function selectFood(foodId: string) {
  selectedFood.value = foodId;
  const food = store.findFood(foodId);
  if (food) grams.value = food.units[0]?.grams ?? 100;
}

function submitFood() {
  if (isCustom.value) {
    if (!customName.value.trim()) return;
    store.addFoodRecord({
      foodName: customName.value.trim(),
      grams: grams.value,
      calories: customCalories.value,
    });
  } else {
    const food = store.findFood(selectedFood.value);
    if (!food) return;
    store.addFoodRecord({
      foodId: food.id,
      foodName: food.name,
      grams: grams.value,
    });
  }
  // reset
  showAddForm.value = false;
  selectedFood.value = "";
  grams.value = 100;
  customName.value = "";
  customCalories.value = 0;
  isCustom.value = false;
  searchQuery.value = "";
}

function toggleCustom() {
  isCustom.value = !isCustom.value;
  selectedFood.value = "";
  customName.value = "";
}

function goFoodDb() {
  void router.push("/health/food-db");
}
</script>

<template>
  <div class="food-page">
    <h2 class="page-title">饮食热量</h2>

    <!-- 今日概览 -->
    <div class="today-card clean-card">
      <div class="macro-row">
        <div class="macro-block macro-block--main">
          <span class="macro-label">{{ MACRO_LABEL.calories }}</span>
          <div class="macro-value-row">
            <span class="macro-num">{{ todayValues.calories }}</span>
            <span class="macro-goal">/{{ GOALS.calories }}{{ MACRO_UNIT.calories }}</span>
          </div>
          <div class="macro-bar">
            <div class="macro-bar-fill" :style="{ width: Math.min(todayValues.calories / GOALS.calories, 1) * 100 + '%', background: MACRO_COLOR.calories }" />
          </div>
        </div>
      </div>
      <div class="macro-row macro-row--3">
        <div v-for="m in (['carbs', 'protein', 'fat'] as Macro[])" :key="m" class="macro-block">
          <span class="macro-label">{{ MACRO_LABEL[m] }}</span>
          <div class="macro-value-row">
            <span class="macro-num">{{ todayValues[m] }}</span>
            <span class="macro-goal">/{{ GOALS[m] }}{{ MACRO_UNIT[m] }}</span>
          </div>
          <div class="macro-bar">
            <div class="macro-bar-fill" :style="{ width: Math.min(todayValues[m] / GOALS[m], 1) * 100 + '%', background: MACRO_COLOR[m] }" />
          </div>
        </div>
      </div>
    </div>

    <!-- 添加饮食 -->
    <button v-if="!showAddForm" class="add-btn" @click="showAddForm = true">
      <i class="bi bi-plus-lg" style="font-size:18px"></i>
      <span>记录饮食</span>
    </button>

    <div v-else class="add-form clean-card">
      <div class="form-header">
        <h3 class="form-title">记录饮食</h3>
        <button class="close-btn" @click="showAddForm = false" aria-label="关闭">×</button>
      </div>

      <div class="toggle-row">
        <button class="toggle-btn" :class="{ 'toggle-btn--active': !isCustom }" @click="isCustom = false">食品库</button>
        <button class="toggle-btn" :class="{ 'toggle-btn--active': isCustom }" @click="toggleCustom">快速记录</button>
      </div>

      <div v-if="!isCustom" class="food-picker">
        <input v-model="searchQuery" type="text" placeholder="搜索食品..." class="search-input" />
        <div class="search-results">
          <button
            v-for="food in searchResults"
            :key="food.id"
            class="food-result"
            :class="{ 'food-result--active': selectedFood === food.id }"
            @click="selectFood(food.id)"
          >
            <div class="food-info">
              <span class="food-name">{{ food.name }}</span>
              <span class="food-cat">{{ food.category }} · {{ food.caloriesPer100g }}千卡/100g</span>
            </div>
          </button>
        </div>
      </div>

      <div v-else class="custom-inputs">
        <input v-model="customName" type="text" placeholder="食品名" class="text-input" />
        <input v-model.number="customCalories" type="number" placeholder="热量(千卡)" class="text-input" />
      </div>

      <div class="grams-row">
        <label class="grams-label">克数</label>
        <input v-model.number="grams" type="number" min="1" class="grams-input" />
        <span class="grams-unit">g</span>
      </div>

      <button class="submit-btn" @click="submitFood" :disabled="!isCustom && !selectedFood">
        添加
      </button>
    </div>

    <!-- 视图切换 -->
    <div class="view-tabs">
      <button class="tab-btn" :class="{ 'tab-btn--active': view === 'week' }" @click="view = 'week'">周</button>
      <button class="tab-btn" :class="{ 'tab-btn--active': view === 'month' }" @click="view = 'month'">月</button>
    </div>

    <!-- 营养素切换 -->
    <div class="macro-tabs">
      <button
        v-for="m in (['calories', 'carbs', 'protein', 'fat'] as Macro[])"
        :key="m"
        class="macro-tab"
        :class="{ 'macro-tab--active': macro === m }"
        :style="macro === m ? { background: MACRO_COLOR[m], color: '#fff' } : {}"
        @click="macro = m"
      >
        {{ MACRO_LABEL[m] }}
      </button>
    </div>

    <!-- 周期导航 -->
    <div class="period-nav">
      <button class="nav-btn" @click="prevPeriod"><i class="bi bi-chevron-left" style="font-size:16px"></i></button>
      <span class="period-label">{{ periodLabel }}</span>
      <button class="nav-btn" @click="nextPeriod"><i class="bi bi-chevron-right" style="font-size:16px"></i></button>
    </div>

    <!-- 图表 -->
    <div class="chart-card clean-card">
      <div class="chart-header">
        <span class="chart-title">{{ MACRO_LABEL[macro] }} · {{ view === "week" ? "本周" : "本月" }}</span>
        <span class="chart-avg">日均 {{ avgValue }}{{ MACRO_UNIT[macro] }}</span>
      </div>
      <BarChartThin
        :data="chartData"
        :labels="chartLabels"
        :height="120"
        :color="MACRO_COLOR[macro]"
        :show-y-axis="true"
        :y-unit="MACRO_UNIT[macro]"
      />
    </div>

    <!-- 今日记录列表 -->
    <div class="history-card clean-card">
      <div class="history-header">
        <h3 class="block-title">今日饮食</h3>
        <button class="link-btn" @click="goFoodDb">食品库 →</button>
      </div>
      <div v-if="store.todayFoodRecords.length === 0" class="empty">暂无饮食记录</div>
      <div class="history-list">
        <div
          v-for="rec in store.todayFoodRecords.slice().reverse()"
          :key="rec.id"
          class="history-item"
        >
          <div class="h-info">
            <span class="h-name">{{ rec.foodName }}</span>
            <span class="h-meta">{{ rec.grams }}g · {{ rec.calories }}千卡 · 碳{{ rec.carbs }}g 蛋白{{ rec.protein }}g 脂{{ rec.fat }}g</span>
          </div>
          <button class="h-del" @click="store.removeFoodRecord(rec.id)" aria-label="删除">
            <i class="bi bi-trash3" style="font-size:14px"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.food-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.today-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.macro-row {
  display: flex;
  gap: var(--space-3);
}

.macro-row--3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}

.macro-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.macro-block--main {
  flex: 1;
}

.macro-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.macro-value-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.macro-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}

.macro-block--main .macro-num {
  font-size: var(--text-3xl);
}

.macro-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.macro-bar {
  height: 4px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.macro-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1.5px dashed var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.add-btn:active { transform: scale(0.98); }

.add-form {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.close-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 22px;
  cursor: pointer;
}

.toggle-row {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.toggle-btn {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.toggle-btn--active {
  background: var(--bg-50);
  color: var(--color-text);
}

.food-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.search-input,
.text-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}

.search-input:focus,
.text-input:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.food-result {
  text-align: left;
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--bg-100);
  cursor: pointer;
}

.food-result--active {
  border-color: var(--color-warm);
  background: var(--warm-50);
}

.food-info {
  display: flex;
  flex-direction: column;
}

.food-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.food-cat {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.custom-inputs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.grams-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.grams-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.grams-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
}

.grams-unit {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.submit-btn {
  padding: 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.submit-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}

.view-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-100);
  border-radius: var(--radius-full);
  align-self: center;
}

.tab-btn {
  padding: 6px 24px;
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.tab-btn--active {
  background: var(--bg-50);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

.macro-tabs {
  display: flex;
  gap: 4px;
  align-self: center;
}

.macro-tab {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.period-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}

.nav-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-100);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.period-label {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  min-width: 140px;
  text-align: center;
}

.chart-card {
  padding: var(--space-4);
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.chart-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.chart-avg {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
}

.history-card {
  padding: var(--space-4);
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}

.link-btn {
  background: transparent;
  border: none;
  color: var(--color-warm);
  font-size: var(--text-sm);
  cursor: pointer;
}

.empty {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.h-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.h-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.h-meta {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.h-del {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.h-del:active { color: var(--danger-500); }
</style>
