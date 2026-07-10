<script setup lang="ts">
/**
 * FoodPage — 饮食热量记录页（半模态改版）
 *
 * - 今日热量/三大营养素概览
 * - 周/月水平切换 + 水平日期选择
 * - 记录饮食使用 BottomSheet：AI快速记 / 搜索食品库 / 手动输入
 */
import { computed, onMounted, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useUserStore } from "@/stores/userStore";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { useRouter } from "vue-router";
import MultiLineChart from "@/components/charts/MultiLineChart.vue";
import { BottomSheet } from "@/components/ui";
import { useToast } from "@/composables/useToast";
import { textComplete, visionChat } from "@/composables/useVisionChat";
import { FOOD_TEXT_PARSE_PROMPT } from "@/data/aiPrompt";
import type { DietGoal, ActivityLevel } from "@/types/health";
import { ACTIVITY_LEVEL_LABEL } from "@/types/health";

const store = useHealthDataStore();
const userStore = useUserStore();
const aiCfg = useAiConfigStore();
const router = useRouter();
const toast = useToast();

const DIET_GOAL_LABEL: Record<DietGoal, string> = {
  lose: "减脂",
  maintain: "维持",
  gain: "增肌",
};
const DIET_GOAL_ORDER: DietGoal[] = ["lose", "maintain", "gain"];
const ACTIVITY_ORDER: ActivityLevel[] = ["sedentary", "light", "moderate", "active", "very_active"];

type Macro = "calories" | "carbs" | "protein" | "fat";
type AddTab = "ai" | "search" | "manual";
type ViewMode = "week" | "month";

const view = ref<ViewMode>("week");
const macro = ref<Macro>("calories");
const selectedDate = ref<Date>(new Date());
const weekStart = ref<Date>(startOfWeek(new Date()));
const viewMonth = ref<Date>(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

const showAddSheet = ref(false);
const addTab = ref<AddTab>("ai");

const searchQuery = ref("");
const selectedFoodId = ref<string>("");
const grams = ref<number>(100);
const customName = ref<string>("");
const customCalories = ref<number>(0);
const customCarbs = ref<number>(0);
const customProtein = ref<number>(0);
const customFat = ref<number>(0);

const aiInput = ref("");
const aiProcessing = ref(false);
const aiPendingImages = ref<string[]>([]);
const aiVisionAvailable = computed(() => aiCfg.isConfigured && aiCfg.config.vision);

onMounted(() => {
  void store.load();
  void aiCfg.load();
});

function onPickFoodImage(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  for (const f of Array.from(input.files)) {
    if (!f.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        aiPendingImages.value.push(reader.result);
      }
    };
    reader.readAsDataURL(f);
  }
  input.value = "";
}

function removePendingImage(idx: number) {
  aiPendingImages.value.splice(idx, 1);
}

/** 解析视觉模型返回的食物 JSON 列表 */
function parseVisionFoods(text: string): { name: string; grams: number; calories?: number; carbs?: number; protein?: number; fat?: number }[] {
  // 容错：提取首个 JSON 数组
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as Array<Record<string, unknown>>;
    return arr
      .map((it) => ({
        name: String(it.name ?? it.foodName ?? "").trim(),
        grams: Number(it.grams ?? it.weight ?? 100) || 100,
        calories: it.calories != null ? Number(it.calories) : undefined,
        carbs: it.carbs != null ? Number(it.carbs) : undefined,
        protein: it.protein != null ? Number(it.protein) : undefined,
        fat: it.fat != null ? Number(it.fat) : undefined,
      }))
      .filter((x) => x.name);
  } catch {
    return [];
  }
}

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
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const GOALS = computed<Record<Macro, number>>(() => ({
  calories: store.macroTargets.calories,
  carbs: store.macroTargets.carbs,
  protein: store.macroTargets.protein,
  fat: store.macroTargets.fat,
}));

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
  carbs: "var(--color-warning)",
  protein: "var(--color-success)",
  fat: "var(--icon-purple)",
};

const isToday = computed(() => isSameDay(selectedDate.value, new Date()));
const selKey = computed(() => dateKey(selectedDate.value));

const dayValues = computed(() => {
  const recs = store.foodRecordsByDate(selKey.value);
  return {
    calories: recs.reduce((s, r) => s + r.calories, 0),
    carbs: Math.round(recs.reduce((s, r) => s + r.carbs, 0) * 10) / 10,
    protein: Math.round(recs.reduce((s, r) => s + r.protein, 0) * 10) / 10,
    fat: Math.round(recs.reduce((s, r) => s + r.fat, 0) * 10) / 10,
  };
});

function dailyMacroValue(d: Date, m: Macro): number {
  const k = dateKey(d);
  const recs = store.foodRecordsByDate(k);
  switch (m) {
    case "calories": return recs.reduce((s, r) => s + r.calories, 0);
    case "carbs": return Math.round(recs.reduce((s, r) => s + r.carbs, 0) * 10) / 10;
    case "protein": return Math.round(recs.reduce((s, r) => s + r.protein, 0) * 10) / 10;
    case "fat": return Math.round(recs.reduce((s, r) => s + r.fat, 0) * 10) / 10;
  }
}

function dailyMacro(d: Date): number {
  return dailyMacroValue(d, macro.value);
}

const weekDays = computed(() => {
  const out: { date: Date; key: string; label: string; weekday: string; value: number; selected: boolean }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart.value, i);
    out.push({
      date: d,
      key: dateKey(d),
      label: String(d.getDate()),
      weekday: ["日", "一", "二", "三", "四", "五", "六"][d.getDay()],
      value: dailyMacro(d),
      selected: isSameDay(d, selectedDate.value),
    });
  }
  return out;
});

const monthDays = computed(() => {
  const year = viewMonth.value.getFullYear();
  const month = viewMonth.value.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const out: { date: Date | null; key: string; label: string; value: number; selected: boolean; isToday: boolean }[] = [];
  for (let i = 0; i < firstDay; i++) {
    out.push({ date: null, key: `e${i}`, label: "", value: 0, selected: false, isToday: false });
  }
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(year, month, i);
    out.push({
      date: d,
      key: dateKey(d),
      label: String(i),
      value: dailyMacro(d),
      selected: isSameDay(d, selectedDate.value),
      isToday: isSameDay(d, today),
    });
  }
  return out;
});

const chartLabels = computed(() =>
  view.value === "week"
    ? weekDays.value.map((d) => d.label)
    : monthDays.value.filter((d) => d.date).map((d) => d.label),
);

/** Active day list (dates only) for the current view, used by the 4-macro overlay. */
const chartDays = computed(() =>
  view.value === "week"
    ? weekDays.value.map((d) => d.date)
    : monthDays.value.filter((d) => d.date).map((d) => d.date!),
);

/**
 * 4-macro overlay series. Each series is normalized to % of its own daily goal
 * so all four lines share one comparable scale (calories ~2000, carbs ~250 etc.
 * would otherwise dwarf each other). Reference line at 100 = goal reached.
 */
const chartSeries = computed(() => {
  const goals = GOALS.value;
  return (["calories", "carbs", "protein", "fat"] as Macro[]).map((m) => ({
    data: chartDays.value.map((d) => {
      const g = goals[m];
      const v = dailyMacroValue(d, m);
      return g > 0 ? Math.round((v / g) * 1000) / 10 : 0;
    }),
    color: MACRO_COLOR[m],
    label: MACRO_LABEL[m],
  }));
});

const chartReference = computed(() => ({
  value: 100,
  color: "var(--color-text-tertiary)",
  label: "目标 100%",
  dashed: true,
}));

const avgValue = computed(() => {
  const arr = view.value === "week" ? weekDays.value : monthDays.value.filter((d) => d.date);
  const sum = arr.reduce((s, d) => s + d.value, 0);
  return arr.length > 0 ? Math.round(sum / arr.length * 10) / 10 : 0;
});

const periodLabel = computed(() => {
  if (view.value === "week") {
    const end = addDays(weekStart.value, 6);
    return `${weekStart.value.getMonth() + 1}/${weekStart.value.getDate()}-${end.getMonth() + 1}/${end.getDate()}`;
  }
  return `${viewMonth.value.getFullYear()}年${viewMonth.value.getMonth() + 1}月`;
});

function prevPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, -7);
    selectedDate.value = weekStart.value;
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() - 1, 1);
  }
}
function nextPeriod() {
  if (view.value === "week") {
    weekStart.value = addDays(weekStart.value, 7);
    selectedDate.value = weekStart.value;
  } else {
    viewMonth.value = new Date(viewMonth.value.getFullYear(), viewMonth.value.getMonth() + 1, 1);
  }
}
function switchView(v: ViewMode) {
  view.value = v;
  if (v === "week") weekStart.value = startOfWeek(selectedDate.value);
  else viewMonth.value = new Date(selectedDate.value.getFullYear(), selectedDate.value.getMonth(), 1);
}
function selectDay(d: Date) {
  selectedDate.value = d;
}

const searchResults = computed(() => store.searchFoods(searchQuery.value).slice(0, 30));

const selectedFood = computed(() => (selectedFoodId.value ? store.findFood(selectedFoodId.value) : undefined));

function openAddSheet() {
  addTab.value = "ai";
  aiInput.value = "";
  aiPendingImages.value = [];
  searchQuery.value = "";
  selectedFoodId.value = "";
  grams.value = 100;
  customName.value = "";
  customCalories.value = 0;
  customCarbs.value = 0;
  customProtein.value = 0;
  customFat.value = 0;
  showAddSheet.value = true;
}

function selectFood(foodId: string) {
  selectedFoodId.value = foodId;
  const food = store.findFood(foodId);
  if (food) grams.value = food.units?.[0]?.grams ?? 100;
}

function submitFromSearch() {
  const food = selectedFood.value;
  if (!food) return;
  store.addFoodRecord({
    foodId: food.id,
    foodName: food.name,
    grams: grams.value,
  });
  toast.success(`已添加 ${food.name} ${grams.value}g`);
  showAddSheet.value = false;
}

function submitManual() {
  if (!customName.value.trim()) {
    toast.info("请输入食品名");
    return;
  }
  store.addFoodRecord({
    foodName: customName.value.trim(),
    grams: grams.value,
    calories: customCalories.value,
    carbs: customCarbs.value,
    protein: customProtein.value,
    fat: customFat.value,
  });
  toast.success(`已添加 ${customName.value.trim()}`);
  showAddSheet.value = false;
}

async function submitAi() {
  // 有图片时走视觉识别
  if (aiPendingImages.value.length) {
    if (!aiCfg.isConfigured) {
      toast.info("请先在 AI 配置页填写 baseURL/apiKey/model");
      return;
    }
    if (!aiCfg.config.vision) {
      toast.info("当前模型不支持图片，请在 AI 配置页选择视觉模型");
      return;
    }
    aiProcessing.value = true;
    try {
      const promptText =
        "请识别图中所有食物，返回 JSON 数组（仅返回数组，无多余文字）。每项字段：name(食物名), grams(估算克数), calories(千卡), carbs(碳水g), protein(蛋白质g), fat(脂肪g)。无法识别的字段可省略。"
        + (aiInput.value.trim() ? `\n用户补充说明：${aiInput.value.trim()}` : "");
      const text = await visionChat(aiPendingImages.value, promptText, {
        temperature: 0.2,
        maxTokens: 1200,
        timeoutMs: 90_000,
      });
      const items = parseVisionFoods(text);
      if (!items.length) {
        toast.info("未识别到食物，试试手动输入");
        return;
      }
      let added = 0;
      for (const it of items) {
        const food = store.foodDb.find((f) => f.name === it.name);
        if (food) {
          store.addFoodRecord({ foodId: food.id, foodName: food.name, grams: it.grams });
        } else {
          store.addFoodRecord({
            foodName: it.name,
            grams: it.grams,
            calories: it.calories,
            carbs: it.carbs,
            protein: it.protein,
            fat: it.fat,
          });
        }
        added++;
      }
      toast.success(`AI 识别并记录 ${added} 项食物`);
      showAddSheet.value = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`识别失败：${msg}`);
    } finally {
      aiProcessing.value = false;
    }
    return;
  }

  // 纯文本走 AI 解析
  if (!aiInput.value.trim()) return;
  if (!aiCfg.isConfigured) {
    toast.info("请先在 AI 配置页填写 baseURL/apiKey/model");
    return;
  }
  aiProcessing.value = true;
  try {
    const text = await textComplete(FOOD_TEXT_PARSE_PROMPT(aiInput.value.trim()), {
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 60_000,
    });
    const items = parseVisionFoods(text);
    if (!items.length) {
      toast.info("未识别到食物，试试手动输入或搜索");
      addTab.value = "search";
      searchQuery.value = aiInput.value;
      return;
    }
    let added = 0;
    for (const it of items) {
      const food = store.foodDb.find((f) => f.name === it.name);
      if (food) {
        store.addFoodRecord({ foodId: food.id, foodName: food.name, grams: it.grams });
      } else {
        store.addFoodRecord({
          foodName: it.name,
          grams: it.grams,
          calories: it.calories,
          carbs: it.carbs,
          protein: it.protein,
          fat: it.fat,
        });
      }
      added++;
    }
    toast.success(`AI 记食 ${added} 项`);
    showAddSheet.value = false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`识别失败：${msg}`);
  } finally {
    aiProcessing.value = false;
  }
}

const dayRecords = computed(() => store.foodRecordsByDate(selKey.value).slice().reverse());

function goFoodDb() {
  void router.push("/health/food-db");
}

function goFoodComposition() {
  void router.push("/health/food/composition");
}

// ===== Nutrition target adjustment =====
const showTargetSheet = ref(false);
const draftDietGoal = ref<DietGoal>("maintain");
const draftActivity = ref<ActivityLevel>("moderate");

function openTargetSheet() {
  draftDietGoal.value = userStore.profile.dietGoal;
  draftActivity.value = userStore.profile.activityLevel;
  showTargetSheet.value = true;
}

function saveTarget() {
  userStore.setProfile({
    dietGoal: draftDietGoal.value,
    activityLevel: draftActivity.value,
  });
  toast.success("营养目标已更新");
  showTargetSheet.value = false;
}
</script>

<template>
  <div class="food-page">
    <div class="page-head">
      <h2 class="page-title">饮食热量</h2>
      <button class="comp-entry-btn" @click="goFoodComposition">
        <i class="bi bi-pie-chart-fill" style="font-size:14px"></i>
        <span>饮食构成</span>
      </button>
    </div>

    <div class="target-card clean-card">
      <div class="target-header">
        <span class="target-title">营养目标</span>
        <button class="target-edit-btn" @click="openTargetSheet">
          <i class="bi bi-sliders" style="font-size:12px"></i>
          <span>调整目标</span>
        </button>
      </div>
      <div class="target-grid">
        <div class="target-cell target-cell--main">
          <span class="target-label">每日热量</span>
          <span class="target-val">{{ store.dailyCalorieGoal }}<span class="target-unit">千卡</span></span>
        </div>
        <div class="target-cell">
          <span class="target-label">碳水</span>
          <span class="target-val">{{ store.macroTargets.carbs }}<span class="target-unit">g</span></span>
        </div>
        <div class="target-cell">
          <span class="target-label">蛋白质</span>
          <span class="target-val">{{ store.macroTargets.protein }}<span class="target-unit">g</span></span>
        </div>
        <div class="target-cell">
          <span class="target-label">脂肪</span>
          <span class="target-val">{{ store.macroTargets.fat }}<span class="target-unit">g</span></span>
        </div>
        <div class="target-cell">
          <span class="target-label">饮水</span>
          <span class="target-val">{{ store.waterGoalMl }}<span class="target-unit">ml</span></span>
        </div>
        <div class="target-cell">
          <span class="target-label">目标</span>
          <span class="target-val-text">{{ DIET_GOAL_LABEL[userStore.profile.dietGoal] }}</span>
        </div>
        <div class="target-cell">
          <span class="target-label">活动</span>
          <span class="target-val-text">{{ ACTIVITY_LEVEL_LABEL[userStore.profile.activityLevel] }}</span>
        </div>
      </div>
    </div>

    <div class="today-card clean-card">
      <div class="macro-main">
        <div class="macro-main-left">
          <span class="macro-label">{{ MACRO_LABEL.calories }}</span>
          <div class="macro-value-row">
            <span class="macro-num">{{ dayValues.calories }}</span>
            <span class="macro-goal">/{{ GOALS.calories }}{{ MACRO_UNIT.calories }}</span>
          </div>
          <div class="macro-bar">
            <div
              class="macro-bar-fill"
              :style="{
                width: Math.min(dayValues.calories / GOALS.calories, 1) * 100 + '%',
                background: MACRO_COLOR.calories,
              }"
            />
          </div>
        </div>
        <button v-if="isToday" class="add-food-fab" @click="openAddSheet" aria-label="记录饮食">
          <i class="bi bi-plus-lg" style="font-size:20px"></i>
        </button>
      </div>
      <div class="macro-row-3">
        <div v-for="m in (['carbs', 'protein', 'fat'] as Macro[])" :key="m" class="macro-block">
          <span class="macro-label">{{ MACRO_LABEL[m] }}</span>
          <div class="macro-value-row">
            <span class="macro-num-sm">{{ dayValues[m] }}</span>
            <span class="macro-goal-sm">/{{ GOALS[m] }}{{ MACRO_UNIT[m] }}</span>
          </div>
          <div class="macro-bar-sm">
            <div
              class="macro-bar-fill"
              :style="{
                width: Math.min(dayValues[m] / GOALS[m], 1) * 100 + '%',
                background: MACRO_COLOR[m],
              }"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="period-bar clean-card">
      <div class="period-bar-top">
        <div class="view-switch">
          <button class="vs-btn" :class="{ active: view === 'week' }" @click="switchView('week')">周</button>
          <button class="vs-btn" :class="{ active: view === 'month' }" @click="switchView('month')">月</button>
        </div>
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
        <div class="period-nav">
          <button class="nav-btn" @click="prevPeriod" aria-label="上一周期">
            <i class="bi bi-chevron-left" style="font-size:14px"></i>
          </button>
          <span class="nav-label">{{ periodLabel }}</span>
          <button class="nav-btn" @click="nextPeriod" aria-label="下一周期">
            <i class="bi bi-chevron-right" style="font-size:14px"></i>
          </button>
        </div>
      </div>

      <div v-if="view === 'week'" class="week-strip">
        <button
          v-for="d in weekDays"
          :key="d.key"
          class="day-chip"
          :class="{ 'is-selected': d.selected, 'is-today': isSameDay(d.date, new Date()) }"
          @click="selectDay(d.date)"
        >
          <span class="dw">{{ d.weekday }}</span>
          <span class="dd">{{ d.label }}</span>
          <span
            class="d-bar"
            :style="{
              height: Math.min(d.value / GOALS[macro] * 28, 28) + 'px',
              background: d.value >= GOALS[macro] ? 'var(--color-success)' : MACRO_COLOR[macro],
            }"
          />
        </button>
      </div>

      <div v-else class="month-grid">
        <div class="mg-head">
          <span v-for="w in ['日','一','二','三','四','五','六']" :key="w" class="mgh">{{ w }}</span>
        </div>
        <div class="mg-body">
          <button
            v-for="d in monthDays"
            :key="d.key"
            class="mg-cell"
            :class="{ 'is-empty': !d.date, 'is-selected': d.selected, 'is-today': d.isToday }"
            :disabled="!d.date"
            @click="d.date && selectDay(d.date)"
          >
            <template v-if="d.date">
              <span class="mg-num">{{ d.label }}</span>
              <span v-if="d.value > 0" class="mg-dot" :style="{ background: MACRO_COLOR[macro], opacity: 0.3 + Math.min(d.value / GOALS[macro], 1) * 0.7 }" />
            </template>
          </button>
        </div>
      </div>
    </div>

    <div class="chart-card clean-card">
      <div class="chart-header">
        <div class="chart-header-left">
          <span class="chart-title">营养摄入 · {{ view === "week" ? "本周" : "本月" }}</span>
          <span class="chart-avg">{{ MACRO_LABEL[macro] }} 日均 {{ avgValue }}{{ MACRO_UNIT[macro] }} · 目标 {{ GOALS[macro] }}{{ MACRO_UNIT[macro] }}</span>
        </div>
        <div class="chart-legend">
          <span
            v-for="m in (['calories', 'carbs', 'protein', 'fat'] as Macro[])"
            :key="m"
            class="chart-legend-chip"
            :class="{ 'chart-legend-chip--active': macro === m }"
            @click="macro = m"
          >
            <span class="chart-legend-dot" :style="{ background: MACRO_COLOR[m] }" />
            <span class="chart-legend-text">{{ MACRO_LABEL[m] }}</span>
          </span>
        </div>
      </div>
      <MultiLineChart
        :series="chartSeries"
        :labels="chartLabels"
        :height="120"
        :reference-line="chartReference"
        :show-grid="true"
      />
    </div>

    <div class="history-card clean-card">
      <div class="history-header">
        <h3 class="block-title">{{ isToday ? "今日" : `${selectedDate.getMonth() + 1}/${selectedDate.getDate()}` }}饮食</h3>
        <button class="link-btn" @click="goFoodDb">食品库 →</button>
      </div>
      <div v-if="dayRecords.length === 0" class="empty">暂无饮食记录</div>
      <div class="history-list">
        <div v-for="rec in dayRecords" :key="rec.id" class="history-item">
          <div class="h-info">
            <div class="h-name-row">
              <span class="h-name">{{ rec.foodName }}</span>
              <span class="h-cal">{{ rec.calories }}千卡</span>
            </div>
            <span class="h-meta">{{ rec.grams }}g · 碳{{ rec.carbs }}g 蛋{{ rec.protein }}g 脂{{ rec.fat }}g</span>
          </div>
          <button class="h-del" @click="store.removeFoodRecord(rec.id)" aria-label="删除">
            <i class="bi bi-trash3" style="font-size:14px"></i>
          </button>
        </div>
      </div>
    </div>

    <BottomSheet
      v-model:visible="showAddSheet"
      title="记录饮食"
      :detents="['medium', 'large']"
      default-detent="medium"
    >
      <div class="add-food-body">
        <div class="add-tabs">
          <button
            v-for="t in ([
              { id: 'ai', label: 'AI 快速记', icon: 'stars' },
              { id: 'search', label: '搜索', icon: 'search' },
              { id: 'manual', label: '手动', icon: 'pencil-square' },
            ] as { id: AddTab; label: string; icon: string }[])"
            :key="t.id"
            class="add-tab"
            :class="{ active: addTab === t.id }"
            @click="addTab = t.id"
          >
            <i :class="['bi', `bi-${t.icon}`]" style="font-size:16px"></i>
            <span>{{ t.label }}</span>
          </button>
        </div>

        <!-- AI Quick Add -->
        <div v-if="addTab === 'ai'" class="ai-add">
          <div class="ai-hint">说一句"早餐吃了一个苹果"或"300g鸡胸肉"即可快速记录</div>

          <!-- 待识别图片预览 -->
          <div v-if="aiPendingImages.length" class="ai-pending-images">
            <div
              v-for="(url, i) in aiPendingImages"
              :key="i"
              class="ai-pending-img-wrap"
            >
              <img :src="url" class="ai-pending-img" alt="food" />
              <button class="ai-pending-img-x" @click="removePendingImage(i)" aria-label="移除">×</button>
            </div>
          </div>

          <div class="ai-input-wrap">
            <textarea
              v-model="aiInput"
              rows="3"
              :placeholder="aiPendingImages.length ? '可选：补充说明（如份量、做法）' : '例如：中午一碗米饭、一块鸡胸肉、一杯牛奶'"
              class="ai-textarea"
            />
            <label v-if="aiVisionAvailable" class="ai-camera-btn" title="拍照识别">
              <i class="bi bi-camera" style="font-size:18px"></i>
              <input
                type="file"
                accept="image/*"
                multiple
                class="file-hidden"
                @change="onPickFoodImage"
              />
            </label>
          </div>
          <div v-if="!aiVisionAvailable" class="ai-vision-hint">
            <i class="bi bi-info-circle" style="font-size:11px"></i>
            <span>配置视觉模型后可拍照识别食物</span>
          </div>
          <div class="ai-examples">
            <button
              v-for="ex in ['一个苹果', '一碗米饭', '200g鸡胸肉', '一杯牛奶', '一根香蕉', '一个鸡蛋']"
              :key="ex"
              class="ex-chip"
              @click="aiInput = ex"
            >
              {{ ex }}
            </button>
          </div>
          <button class="submit-btn" :disabled="(!aiInput.trim() && !aiPendingImages.length) || aiProcessing" @click="submitAi">
            <span v-if="aiProcessing">识别中...</span>
            <span v-else>AI 识别并记录</span>
          </button>
        </div>

        <!-- Search -->
        <div v-else-if="addTab === 'search'" class="search-add">
          <div class="search-wrap">
            <i class="bi bi-search search-ic" style="font-size:16px"></i>
            <input v-model="searchQuery" type="text" placeholder="搜索食品..." class="search-input" />
          </div>
          <div class="food-list scrollbar-hide">
            <button
              v-for="food in searchResults"
              :key="food.id"
              class="food-item"
              :class="{ active: selectedFoodId === food.id }"
              @click="selectFood(food.id)"
            >
              <div class="food-info">
                <span class="food-name">{{ food.name }}</span>
                <span class="food-meta">{{ food.category }} · {{ food.caloriesPer100g }}千卡/100g</span>
              </div>
              <i v-if="selectedFoodId === food.id" class="bi bi-check-lg" style="font-size:18px;color:var(--color-warm)"></i>
            </button>
            <div v-if="searchResults.length === 0" class="empty-sm">没有找到匹配食品</div>
          </div>
          <template v-if="selectedFood">
            <div class="grams-row">
              <label class="grams-label">分量</label>
              <input v-model.number="grams" type="number" min="1" class="grams-input" />
              <span class="grams-unit">g</span>
            </div>
            <div class="quick-grams">
              <button v-for="g in [50, 100, 150, 200, 300]" :key="g" class="qg" :class="{ active: grams === g }" @click="grams = g">{{ g }}g</button>
            </div>
            <div class="nutrition-preview">
              <span>热量 {{ Math.round(selectedFood.caloriesPer100g * grams / 100) }}千卡</span>
              <span>·</span>
              <span>碳 {{ (selectedFood.carbsPer100g * grams / 100).toFixed(1) }}g</span>
              <span>·</span>
              <span>蛋 {{ (selectedFood.proteinPer100g * grams / 100).toFixed(1) }}g</span>
              <span>·</span>
              <span>脂 {{ (selectedFood.fatPer100g * grams / 100).toFixed(1) }}g</span>
            </div>
          </template>
          <button class="submit-btn" :disabled="!selectedFood" @click="submitFromSearch">
            添加{{ selectedFood ? ` ${selectedFood.name} ${grams}g` : '' }}
          </button>
        </div>

        <!-- Manual -->
        <div v-else class="manual-add">
          <input v-model="customName" type="text" placeholder="食品名 (如: 自制三明治)" class="text-input" />
          <div class="manual-row">
            <div class="manual-field">
              <label>热量(千卡)</label>
              <input v-model.number="customCalories" type="number" min="0" class="text-input" />
            </div>
            <div class="manual-field">
              <label>分量(g)</label>
              <input v-model.number="grams" type="number" min="1" class="text-input" />
            </div>
          </div>
          <div class="manual-row">
            <div class="manual-field">
              <label>碳水(g)</label>
              <input v-model.number="customCarbs" type="number" min="0" step="0.1" class="text-input" />
            </div>
            <div class="manual-field">
              <label>蛋白质(g)</label>
              <input v-model.number="customProtein" type="number" min="0" step="0.1" class="text-input" />
            </div>
            <div class="manual-field">
              <label>脂肪(g)</label>
              <input v-model.number="customFat" type="number" min="0" step="0.1" class="text-input" />
            </div>
          </div>
          <button class="submit-btn" :disabled="!customName.trim()" @click="submitManual">添加记录</button>
        </div>
      </div>
    </BottomSheet>

    <BottomSheet
      v-model:visible="showTargetSheet"
      title="调整营养目标"
      :detents="['medium']"
      default-detent="medium"
    >
      <div class="target-sheet-body">
        <div class="sheet-section">
          <label class="sheet-section-label">饮食目标</label>
          <div class="chip-row">
            <button
              v-for="g in DIET_GOAL_ORDER"
              :key="g"
              class="goal-chip"
              :class="{ active: draftDietGoal === g }"
              @click="draftDietGoal = g"
            >
              {{ DIET_GOAL_LABEL[g] }}
            </button>
          </div>
        </div>
        <div class="sheet-section">
          <label class="sheet-section-label">活动水平</label>
          <div class="chip-row chip-row--wrap">
            <button
              v-for="a in ACTIVITY_ORDER"
              :key="a"
              class="goal-chip"
              :class="{ active: draftActivity === a }"
              @click="draftActivity = a"
            >
              {{ ACTIVITY_LEVEL_LABEL[a] }}
            </button>
          </div>
        </div>
        <div class="sheet-hint">
          <i class="bi bi-info-circle" style="font-size:11px"></i>
          <span>目标根据身高、体重、年龄、目标与活动水平自动计算</span>
        </div>
        <button class="submit-btn" @click="saveTarget">保存</button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.food-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.comp-entry-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all var(--dur-fast);
}

.comp-entry-btn:active {
  transform: scale(0.96);
  background: var(--bg-200);
}

/* ===== Nutrition target card ===== */
.target-card {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.target-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.target-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}

.target-edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-warm);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all var(--dur-fast);
}

.target-edit-btn:active {
  transform: scale(0.95);
  background: var(--warm-50);
}

.target-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}

.target-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.target-cell--main {
  grid-column: span 2;
  background: var(--warm-50);
}

.target-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.target-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.2;
}

.target-cell--main .target-val {
  font-size: var(--text-xl);
  color: var(--color-warm);
}

.target-val-text {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.target-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  margin-left: 2px;
}

.today-card {
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.macro-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.macro-main-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  font-size: var(--text-3xl);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1.1;
}

.macro-num-sm {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.1;
}

.macro-goal, .macro-goal-sm {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.macro-bar {
  height: 8px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.macro-bar-sm {
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

.add-food-fab {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: var(--color-warm);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-md);
  flex-shrink: 0;
}

.add-food-fab:active { transform: scale(0.93); }

.macro-row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

.macro-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.period-bar {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.period-bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.view-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
}

.vs-btn {
  padding: 5px 14px;
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.vs-btn.active {
  background: var(--bg-50);
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
}

.macro-tabs {
  display: flex;
  gap: 4px;
}

.macro-tab {
  padding: 5px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: var(--fw-semibold);
  cursor: pointer;
}

.macro-tab--active {
  border-color: transparent;
}

.period-nav {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.nav-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--bg-100);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.nav-label {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  min-width: 90px;
  text-align: center;
}

.week-strip {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.day-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.day-chip.is-selected {
  background: rgba(255, 107, 53, 0.1);
}

.day-chip.is-selected .dd { color: var(--color-warm); font-weight: var(--fw-bold); }
.day-chip.is-today .dd { color: var(--color-warm); }

.dw { font-size: 10px; color: var(--color-text-tertiary); }
.dd { font-size: var(--text-sm); font-weight: var(--fw-medium); color: var(--color-text); }

.d-bar {
  width: 6px;
  border-radius: 3px;
  min-height: 2px;
  transition: height 0.3s;
}

.month-grid { display: flex; flex-direction: column; gap: 4px; }
.mg-head { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.mgh { text-align: center; font-size: 10px; color: var(--color-text-tertiary); padding: 2px 0; }
.mg-body { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }

.mg-cell {
  aspect-ratio: 1;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  padding: 0;
}
.mg-cell.is-empty { visibility: hidden; }
.mg-cell.is-selected { background: rgba(255, 107, 53, 0.12); }
.mg-cell.is-selected .mg-num { color: var(--color-warm); font-weight: var(--fw-bold); }
.mg-cell.is-today .mg-num { color: var(--color-warm); font-weight: var(--fw-bold); }
.mg-num { font-size: var(--text-sm); color: var(--color-text); }
.mg-dot { width: 4px; height: 4px; border-radius: 50%; }

.chart-card { padding: var(--space-4); }
.chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}
.chart-header-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chart-title { font-size: var(--text-md); font-weight: var(--fw-semibold); color: var(--color-text); }
.chart-avg { font-size: var(--text-sm); color: var(--color-text-tertiary); }
.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chart-legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  background: var(--bg-100);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.chart-legend-chip--active {
  border-color: var(--color-divider);
  background: var(--bg-200);
}
.chart-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chart-legend-text {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}
.chart-legend-chip--active .chart-legend-text {
  color: var(--color-text);
}

/* ===== Target adjustment sheet ===== */
.target-sheet-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-2);
}
.sheet-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sheet-section-label {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.chip-row {
  display: flex;
  gap: var(--space-2);
}
.chip-row--wrap {
  flex-wrap: wrap;
}
.goal-chip {
  flex: 1;
  padding: 10px 8px;
  border-radius: var(--radius-md);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.chip-row--wrap .goal-chip {
  flex: 0 1 auto;
}
.goal-chip.active {
  border-color: var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
}
.sheet-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  padding: 0 var(--space-1);
}

.history-card { padding: var(--space-4); }
.history-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-3); }
.block-title { font-size: var(--text-md); font-weight: var(--fw-semibold); color: var(--color-text); margin: 0; }

.link-btn {
  background: transparent;
  border: none;
  color: var(--color-warm);
  font-size: var(--text-sm);
  cursor: pointer;
}

.empty, .empty-sm {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}
.empty-sm { padding: var(--space-6) 0; }

.history-list { display: flex; flex-direction: column; gap: var(--space-2); }

.history-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.h-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.h-name-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.h-name { font-size: var(--text-sm); font-weight: var(--fw-semibold); color: var(--color-text); }
.h-cal { font-size: var(--text-sm); font-weight: var(--fw-semibold); color: var(--color-warm); flex-shrink: 0; }
.h-meta { font-size: var(--text-xs); color: var(--color-text-tertiary); }

.h-del {
  width: 28px; height: 28px; border-radius: 50%;
  border: none; background: transparent;
  color: var(--color-text-tertiary);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.h-del:active { color: var(--danger-500); }

/* Add food sheet */
.add-food-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
}

.add-tabs {
  display: flex;
  gap: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-lg);
  padding: 4px;
}

.add-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.add-tab.active {
  background: var(--bg-50);
  color: var(--color-warm);
  box-shadow: var(--shadow-sm);
}

.ai-add {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ai-hint {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  text-align: center;
  padding: var(--space-2) var(--space-2) 0;
  line-height: 1.5;
}

.ai-input-wrap {
  padding: 0 var(--space-1);
  position: relative;
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
}

.ai-camera-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur-fast);
}

.ai-camera-btn:active {
  background: var(--bg-200);
  transform: scale(0.94);
}

.ai-vision-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  padding: 0 var(--space-1);
}

.ai-pending-images {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 var(--space-1);
}

.ai-pending-img-wrap {
  position: relative;
  width: 72px;
  height: 72px;
}

.ai-pending-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}

.ai-pending-img-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-text);
  color: #fff;
  border: 2px solid var(--color-bg);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.file-hidden {
  display: none;
}

.ai-textarea {
  width: 100%;
  flex: 1;
  padding: 12px;
  border: 1.5px solid var(--color-divider);
  border-radius: var(--radius-lg);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  resize: none;
  font-family: inherit;
  box-sizing: border-box;
}

.ai-textarea:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.ai-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 var(--space-1);
}

.ex-chip {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.ex-chip:active { background: var(--bg-200); }

.submit-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
  margin-top: var(--space-1);
}

.submit-btn:active { transform: scale(0.98); }
.submit-btn:disabled { background: var(--bg-300); cursor: not-allowed; }

.search-add { display: flex; flex-direction: column; gap: var(--space-3); }

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-ic {
  position: absolute;
  left: 12px;
  color: var(--color-text-tertiary);
}

.search-input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  border: 1.5px solid var(--color-divider);
  border-radius: var(--radius-lg);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}
.search-input:focus { border-color: var(--color-warm); background: var(--bg-50); }

.food-list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.food-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1.5px solid transparent;
  border-radius: var(--radius-md);
  background: var(--bg-100);
  cursor: pointer;
  text-align: left;
}

.food-item.active {
  border-color: var(--color-warm);
  background: var(--warm-50);
}

.food-info { display: flex; flex-direction: column; gap: 2px; }
.food-name { font-size: var(--text-sm); font-weight: var(--fw-semibold); color: var(--color-text); }
.food-meta { font-size: var(--text-xs); color: var(--color-text-tertiary); }

.grams-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.grams-label { font-size: var(--text-sm); color: var(--color-text-secondary); min-width: 40px; }

.grams-input {
  flex: 1;
  padding: 10px 12px;
  border: 1.5px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
}

.grams-unit { font-size: var(--text-sm); color: var(--color-text-tertiary); }

.quick-grams { display: flex; gap: 6px; flex-wrap: wrap; }
.qg {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}
.qg.active { border-color: var(--color-warm); background: var(--warm-50); color: var(--color-warm); }

.nutrition-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  padding: 8px 12px;
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.manual-add { display: flex; flex-direction: column; gap: var(--space-3); }

.text-input {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}
.text-input:focus { border-color: var(--color-warm); background: var(--bg-50); }

.manual-row { display: flex; gap: var(--space-2); }
.manual-field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.manual-field label { font-size: var(--text-xs); color: var(--color-text-tertiary); padding-left: 2px; }

.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { scrollbar-width: none; }
</style>
