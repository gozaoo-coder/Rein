<script setup lang="ts">
/**
 * HealthOverviewPage — 健康数据概览二级页
 *
 * - 玻璃 hero 摘要卡：3 环进度（饮水 / 饮食 / 运动）+ 径向光晕
 * - 快捷指标行：BMI / 体重 / 体脂率（含趋势箭头）
 * - 入口网格：饮水 / 饮食 / 运动 / 身体数据（含运动，此前缺失）
 * - 本周运动时长迷你柱图
 * - 摘要自定义：选择指标 + 布局（左中右 / 上下左右）
 *
 * 环数学修正：使用真实周长 2π·r + stroke-dasharray，弃用 0.97 fudge。
 * 图标配色统一使用 --icon-* tokens。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useUserStore } from "@/stores/userStore";
import { BMI_CATEGORY_LABEL, classifyBmi } from "@/types/health";
import type { BodyMetricsRecord } from "@/types/health";
import { usePersistentRef } from "@/composables/useStorage";
import { BottomSheet, GlassCard } from "@/components/ui";
import BarChartThick, { type ThickBar } from "@/components/charts/BarChartThick.vue";

type LayoutMode = "row" | "split";
type ItemId = "water" | "food" | "workout" | "bmi";

interface SummaryItemDef {
  id: ItemId;
  label: string;
  icon: string;
  /** ring 类型用 pct，stat 类型用纯数值 */
  kind: "ring" | "stat";
  pct: number;
  value: string;
  unit?: string;
  color: string;
  path: string;
}

const router = useRouter();
const health = useHealthDataStore();
const stats = useWorkoutStatsStore();
const userStore = useUserStore();

onMounted(() => {
  void health.load();
  void stats.load();
  void userStore.load();
});

// ===== 体征 =====
const bmi = computed(() => health.currentBmi ?? (userStore.bmi > 0 ? userStore.bmi : undefined));
const bmiCategory = computed(() => (bmi.value ? classifyBmi(bmi.value) : null));
const weight = computed(() => health.currentWeight);
const bodyFat = computed(() => health.currentBodyFat);

// ===== 饮水 =====
const todayWater = computed(() => health.todayWaterAmount);
const waterGoal = computed(() => health.waterGoalMl);
const waterPct = computed(() =>
  waterGoal.value > 0 ? Math.min(100, Math.round((todayWater.value / waterGoal.value) * 100)) : 0,
);

// ===== 饮食 =====
const todayCals = computed(() => health.todayCalories);
const calGoal = computed(() => health.dailyCalorieGoal);
const calPct = computed(() =>
  calGoal.value > 0 ? Math.min(100, Math.round((todayCals.value / calGoal.value) * 100)) : 0,
);

// ===== 运动（本周） — 修复：原 stats.weekDurationSec 不存在导致 NaN =====
const WORKOUT_WEEKLY_GOAL_MIN = 150;
const weekWorkoutMin = computed(() => {
  const days = stats.stats.last7Days ?? [];
  return Math.round(days.reduce((s, d) => s + d.durationSec, 0) / 60);
});
const workoutPct = computed(() =>
  Math.min(100, Math.round((weekWorkoutMin.value / WORKOUT_WEEKLY_GOAL_MIN) * 100)),
);

// ===== 环数学：真实周长 2π·r =====
const RING_R = 16;
const RING_CIRC = 2 * Math.PI * RING_R;
function ringDash(pct: number): string {
  const p = Math.min(Math.max(pct, 0), 100) / 100;
  return `${(p * RING_CIRC).toFixed(2)} ${RING_CIRC.toFixed(2)}`;
}

// ===== 趋势（体征历史对比） =====
const latestMetrics = computed<BodyMetricsRecord | undefined>(() => health.latestBodyMetrics);
const prevMetrics = computed<BodyMetricsRecord | undefined>(() => {
  const arr = health.bodyMetrics;
  return arr.length >= 2 ? arr[arr.length - 2] : undefined;
});

type TrendField = "weightKg" | "bmi" | "bodyFatPercent";
interface Trend {
  dir: "up" | "down" | "flat";
  delta: number;
}
function trendOf(field: TrendField): Trend | null {
  const l = latestMetrics.value;
  const p = prevMetrics.value;
  if (!l || !p) return null;
  const lv = l[field];
  const pv = p[field];
  if (lv == null || pv == null) return null;
  const d = Math.round((lv - pv) * 10) / 10;
  if (Math.abs(d) < 0.05) return { dir: "flat", delta: 0 };
  return { dir: d > 0 ? "up" : "down", delta: d };
}

function go(path: string) {
  router.push(path);
}

// ===== 摘要自定义配置 =====
interface SummaryConfig {
  layout: LayoutMode;
  items: ItemId[];
}
const DEFAULT_CONFIG: SummaryConfig = {
  layout: "row",
  items: ["water", "food", "workout"],
};
const cfg = usePersistentRef<SummaryConfig>("health-summary-config", { ...DEFAULT_CONFIG });
const showEdit = ref(false);

const ALL_ITEMS: { id: ItemId; label: string }[] = [
  { id: "water", label: "饮水" },
  { id: "food", label: "饮食" },
  { id: "workout", label: "本周运动" },
  { id: "bmi", label: "BMI" },
];

const allItemsMap = computed<Record<ItemId, SummaryItemDef>>(() => ({
  water: {
    id: "water",
    label: "饮水",
    icon: "bi-droplet-fill",
    kind: "ring",
    pct: waterPct.value,
    value: `${todayWater.value}`,
    unit: "ml",
    color: "var(--icon-blue)",
    path: "/health/water",
  },
  food: {
    id: "food",
    label: "饮食",
    icon: "bi-apple",
    kind: "ring",
    pct: calPct.value,
    value: `${Math.round(todayCals.value)}`,
    unit: "kcal",
    color: "var(--icon-green)",
    path: "/health/food",
  },
  workout: {
    id: "workout",
    label: "本周运动",
    icon: "bi-flame",
    kind: "ring",
    pct: workoutPct.value,
    value: `${weekWorkoutMin.value}`,
    unit: "min",
    color: "var(--icon-warm)",
    path: "/sports",
  },
  bmi: {
    id: "bmi",
    label: "BMI",
    icon: "bi-activity",
    kind: "stat",
    pct: 0,
    value: bmi.value ? bmi.value.toFixed(1) : "--",
    unit: bmiCategory.value ? BMI_CATEGORY_LABEL[bmiCategory.value] : "未设置",
    color: "var(--icon-purple)",
    path: "/health/bmi",
  },
}));

/** 按配置顺序解析出当前要展示的项 */
const summaryItems = computed<SummaryItemDef[]>(() =>
  cfg.value.items
    .map((id) => allItemsMap.value[id])
    .filter((x): x is SummaryItemDef => !!x),
);

/** split 布局：第一项在上方，其余在下方左右排列 */
const splitTop = computed(() => (cfg.value.layout === "split" ? summaryItems.value[0] ?? null : null));
const splitBottom = computed(() =>
  cfg.value.layout === "split" ? summaryItems.value.slice(1) : [],
);

function toggleItem(id: ItemId) {
  const items = [...cfg.value.items];
  const idx = items.indexOf(id);
  if (idx >= 0) {
    if (items.length <= 1) return; // 至少保留 1 项
    items.splice(idx, 1);
  } else {
    items.push(id);
  }
  cfg.value = { ...cfg.value, items };
  void cfg.save();
}

function setLayout(layout: LayoutMode) {
  cfg.value = { ...cfg.value, layout };
  void cfg.save();
}

/** 上移 / 下移项以调整顺序 */
function moveItem(id: ItemId, dir: -1 | 1) {
  const items = [...cfg.value.items];
  const idx = items.indexOf(id);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= items.length) return;
  [items[idx], items[target]] = [items[target], items[idx]];
  cfg.value = { ...cfg.value, items };
  void cfg.save();
}

function itemIndex(id: ItemId): number {
  return cfg.value.items.indexOf(id);
}

// ===== 快捷指标行 =====
interface QuickStat {
  id: string;
  label: string;
  value: string;
  unit: string;
  icon: string;
  color: string;
  path: string;
  trend: Trend | null;
}
const quickStats = computed<QuickStat[]>(() => {
  const arr: QuickStat[] = [
    {
      id: "bmi",
      label: "BMI",
      value: bmi.value ? bmi.value.toFixed(1) : "--",
      unit: bmiCategory.value ? BMI_CATEGORY_LABEL[bmiCategory.value] : "未设置",
      icon: "bi-activity",
      color: "var(--icon-purple)",
      path: "/health/bmi",
      trend: trendOf("bmi"),
    },
    {
      id: "weight",
      label: "体重",
      value: weight.value > 0 ? weight.value.toFixed(1) : "--",
      unit: "kg",
      icon: "bi-speedometer2",
      color: "var(--icon-blue)",
      path: "/health/weight",
      trend: trendOf("weightKg"),
    },
  ];
  if (bodyFat.value != null) {
    arr.push({
      id: "fat",
      label: "体脂率",
      value: bodyFat.value.toFixed(1),
      unit: "%",
      icon: "bi-percent",
      color: "var(--icon-warm)",
      path: "/health/bmi",
      trend: trendOf("bodyFatPercent"),
    });
  }
  return arr;
});

function trendIcon(t: Trend | null): string {
  if (!t) return "bi-dash";
  if (t.dir === "up") return "bi-caret-up-fill";
  if (t.dir === "down") return "bi-caret-down-fill";
  return "bi-dash";
}
function trendSign(t: Trend | null): string {
  if (!t || t.dir === "flat") return "";
  return t.delta > 0 ? `+${t.delta}` : `${t.delta}`;
}

// ===== 入口网格（含运动） =====
interface HealthEntry {
  id: string;
  icon: string;
  iconClass: string;
  name: string;
  value: string;
  sub: string;
  path: string;
  accent: string;
}
const entries = computed<HealthEntry[]>(() => [
  {
    id: "water",
    icon: "bi-droplet-fill",
    iconClass: "icon-circle--blue",
    name: "饮水",
    value: `${todayWater.value}ml`,
    sub: `目标 ${waterGoal.value}ml · ${waterPct.value}%`,
    path: "/health/water",
    accent: "var(--icon-blue)",
  },
  {
    id: "food",
    icon: "bi-apple",
    iconClass: "icon-circle--green",
    name: "饮食",
    value: `${Math.round(todayCals.value)}kcal`,
    sub: `目标 ${calGoal.value}kcal · ${calPct.value}%`,
    path: "/health/food",
    accent: "var(--icon-green)",
  },
  {
    id: "workout",
    icon: "bi-flame",
    iconClass: "icon-circle--warm",
    name: "运动",
    value: `${weekWorkoutMin.value}min`,
    sub: `本周 · 目标 ${WORKOUT_WEEKLY_GOAL_MIN}min`,
    path: "/sports",
    accent: "var(--icon-warm)",
  },
  {
    id: "bmi",
    icon: "bi-activity",
    iconClass: "icon-circle--purple",
    name: "身体数据",
    value: bmi.value ? bmi.value.toFixed(1) : "--",
    sub: bmiCategory.value ? BMI_CATEGORY_LABEL[bmiCategory.value] : "点击记录身高体重",
    path: "/health/bmi",
    accent: "var(--icon-purple)",
  },
]);

// ===== 本周运动柱图 =====
function weekdayShort(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const idx = (d.getDay() + 6) % 7; // 0=周一
  return ["一", "二", "三", "四", "五", "六", "日"][idx];
}
const weekBars = computed<ThickBar[]>(() => {
  const days = stats.stats.last7Days ?? [];
  const n = days.length;
  return days.map((d, i) => ({
    value: Math.round(d.durationSec / 60),
    label: weekdayShort(d.date),
    color: i === n - 1 ? "var(--color-warm)" : "var(--warm-200)",
  }));
});
</script>

<template>
  <div class="health-overview-page">
    <!-- Hero 摘要卡（玻璃 + 径向光晕） -->
    <GlassCard tier="medium" glow="warning" radius="card" :padding="5" class="hero-card">
      <div class="summary-head">
        <div class="summary-head-left">
          <h2 class="summary-title">今日健康</h2>
          <span class="summary-date">{{ weekWorkoutMin }} min 本周</span>
        </div>
        <button class="edit-btn" @click="showEdit = true" aria-label="自定义摘要">
          <i class="bi bi-sliders" style="font-size:14px"></i>
          <span>自定义</span>
        </button>
      </div>

      <!-- 左中右布局 -->
      <div v-if="cfg.layout === 'row'" class="summary-grid summary-grid--row">
        <button
          v-for="it in summaryItems"
          :key="it.id"
          class="summary-item"
          @click="go(it.path)"
        >
          <div v-if="it.kind === 'ring'" class="summary-ring" :style="{ '--ring-color': it.color }">
            <svg viewBox="0 0 40 40" class="ring-svg">
              <circle cx="20" cy="20" :r="RING_R" fill="none" stroke="var(--ring-track)" stroke-width="3.5" />
              <circle
                cx="20" cy="20" :r="RING_R" fill="none"
                :stroke="it.color" stroke-width="3.5"
                stroke-linecap="round"
                :stroke-dasharray="ringDash(it.pct)"
                transform="rotate(-90 20 20)"
              />
            </svg>
            <div class="ring-center">
              <span class="ring-pct">{{ it.pct }}%</span>
              <i :class="['bi', it.icon]" class="ring-icon" :style="{ color: it.color }"></i>
            </div>
          </div>
          <div v-else class="summary-stat" :style="{ '--ring-color': it.color }">
            <span class="stat-val" :style="{ color: it.color }">{{ it.value }}</span>
            <span v-if="it.unit" class="stat-unit">{{ it.unit }}</span>
          </div>
          <div class="summary-label">{{ it.label }}</div>
        </button>
      </div>

      <!-- 上/下（左右）布局 -->
      <div v-else class="summary-grid summary-grid--split">
        <button v-if="splitTop" class="split-top" @click="go(splitTop.path)" :style="{ '--ring-color': splitTop.color }">
          <div v-if="splitTop.kind === 'ring'" class="summary-ring summary-ring--lg">
            <svg viewBox="0 0 40 40" class="ring-svg">
              <circle cx="20" cy="20" :r="RING_R" fill="none" stroke="var(--ring-track)" stroke-width="3.5" />
              <circle
                cx="20" cy="20" :r="RING_R" fill="none"
                :stroke="splitTop.color" stroke-width="3.5"
                stroke-linecap="round"
                :stroke-dasharray="ringDash(splitTop.pct)"
                transform="rotate(-90 20 20)"
              />
            </svg>
            <div class="ring-center">
              <span class="ring-pct">{{ splitTop.pct }}%</span>
              <i :class="['bi', splitTop.icon]" class="ring-icon" :style="{ color: splitTop.color }"></i>
            </div>
          </div>
          <div v-else class="summary-stat summary-stat--lg">
            <span class="stat-val" :style="{ color: splitTop.color }">{{ splitTop.value }}</span>
            <span v-if="splitTop.unit" class="stat-unit">{{ splitTop.unit }}</span>
          </div>
          <div class="summary-label">{{ splitTop.label }}</div>
        </button>

        <div class="split-bottom">
          <button
            v-for="it in splitBottom"
            :key="it.id"
            class="summary-item"
            @click="go(it.path)"
          >
            <div v-if="it.kind === 'ring'" class="summary-ring" :style="{ '--ring-color': it.color }">
              <svg viewBox="0 0 40 40" class="ring-svg">
                <circle cx="20" cy="20" :r="RING_R" fill="none" stroke="var(--ring-track)" stroke-width="3.5" />
                <circle
                  cx="20" cy="20" :r="RING_R" fill="none"
                  :stroke="it.color" stroke-width="3.5"
                  stroke-linecap="round"
                  :stroke-dasharray="ringDash(it.pct)"
                  transform="rotate(-90 20 20)"
                />
              </svg>
              <div class="ring-center">
                <span class="ring-pct">{{ it.pct }}%</span>
                <i :class="['bi', it.icon]" class="ring-icon" :style="{ color: it.color }"></i>
              </div>
            </div>
            <div v-else class="summary-stat">
              <span class="stat-val" :style="{ color: it.color }">{{ it.value }}</span>
              <span v-if="it.unit" class="stat-unit">{{ it.unit }}</span>
            </div>
            <div class="summary-label">{{ it.label }}</div>
          </button>
        </div>
      </div>
    </GlassCard>

    <!-- 快捷指标行 -->
    <section class="quick-stats">
      <button
        v-for="s in quickStats"
        :key="s.id"
        class="clean-card clean-card--interactive quick-stat"
        @click="go(s.path)"
      >
        <div class="quick-stat-top">
          <div :class="['quick-icon', 'icon-circle', s.id === 'bmi' ? 'icon-circle--purple' : s.id === 'weight' ? 'icon-circle--blue' : 'icon-circle--warm']">
            <i :class="['bi', s.icon]" style="font-size:16px"></i>
          </div>
          <span
            class="trend"
            :class="s.trend ? `trend--${s.trend.dir}` : 'trend--none'"
          >
            <i :class="['bi', trendIcon(s.trend)]" style="font-size:11px"></i>
            <span v-if="s.trend && s.trend.dir !== 'flat'">{{ trendSign(s.trend) }}</span>
          </span>
        </div>
        <div class="quick-stat-value" :style="{ color: s.color }">{{ s.value }}</div>
        <div class="quick-stat-label">{{ s.label }}<span class="quick-stat-unit">{{ s.unit }}</span></div>
      </button>
    </section>

    <!-- 入口网格（含运动） -->
    <section class="entry-grid">
      <button
        v-for="e in entries"
        :key="e.id"
        class="clean-card clean-card--interactive entry-card"
        @click="go(e.path)"
      >
        <div :class="['entry-icon', 'icon-circle', e.iconClass]">
          <i :class="['bi', e.icon]" style="font-size:22px"></i>
        </div>
        <div class="entry-main">
          <div class="entry-name">{{ e.name }}</div>
          <div class="entry-sub">{{ e.sub }}</div>
        </div>
        <div class="entry-right">
          <span class="entry-val" :style="{ color: e.accent }">{{ e.value }}</span>
          <i class="bi bi-chevron-right chevron" style="font-size:16px"></i>
        </div>
      </button>
    </section>

    <!-- 本周运动柱图 -->
    <section class="clean-card chart-card">
      <div class="chart-head">
        <div class="chart-title">
          <i class="bi bi-bar-chart-fill" style="font-size:14px"></i>
          <span>本周运动时长</span>
        </div>
        <span class="chart-total">{{ weekWorkoutMin }} min</span>
      </div>
      <BarChartThick
        :data="weekBars"
        :height="72"
        :bar-radius="5"
        gap-ratio="0.45"
        y-unit="min"
      />
      <div class="chart-hint">目标 {{ WORKOUT_WEEKLY_GOAL_MIN }} min / 周</div>
    </section>

    <!-- 自定义摘要 BottomSheet -->
    <BottomSheet
      v-model:visible="showEdit"
      title="自定义摘要"
      :detents="['medium', 'large']"
      default-detent="medium"
    >
      <div class="edit-body">
        <!-- 布局选择 -->
        <div class="edit-section">
          <div class="edit-section-title">布局</div>
          <div class="layout-switch">
            <button
              class="layout-btn"
              :class="{ active: cfg.layout === 'row' }"
              @click="setLayout('row')"
            >
              <i class="bi bi-layout-three-columns" style="font-size:18px"></i>
              <span>左中右</span>
            </button>
            <button
              class="layout-btn"
              :class="{ active: cfg.layout === 'split' }"
              @click="setLayout('split')"
            >
              <i class="bi bi-layout-text-window-reverse" style="font-size:18px"></i>
              <span>上 / 下（左右）</span>
            </button>
          </div>
        </div>

        <!-- 指标选择 + 排序 -->
        <div class="edit-section">
          <div class="edit-section-title">显示指标（点击添加/移除，箭头调整顺序）</div>
          <div class="item-list">
            <div
              v-for="it in ALL_ITEMS"
              :key="it.id"
              class="item-row"
              :class="{ active: itemIndex(it.id) >= 0 }"
            >
              <button class="item-toggle" @click="toggleItem(it.id)">
                <i :class="['bi', itemIndex(it.id) >= 0 ? 'bi-check-circle-fill' : 'bi-circle']" style="font-size:16px"></i>
                <span>{{ it.label }}</span>
              </button>
              <div v-if="itemIndex(it.id) >= 0" class="item-order">
                <button
                  class="order-btn"
                  :disabled="itemIndex(it.id) === 0"
                  @click="moveItem(it.id, -1)"
                  aria-label="上移"
                >
                  <i class="bi bi-chevron-up" style="font-size:12px"></i>
                </button>
                <button
                  class="order-btn"
                  :disabled="itemIndex(it.id) === cfg.items.length - 1"
                  @click="moveItem(it.id, 1)"
                  aria-label="下移"
                >
                  <i class="bi bi-chevron-down" style="font-size:12px"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="edit-hint">
          <i class="bi bi-info-circle" style="font-size:12px"></i>
          <span>至少保留 1 项指标。split 布局下第一项显示在上方。</span>
        </div>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.health-overview-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
}

/* ===== Hero 摘要卡 ===== */
.hero-card {
  position: relative;
  overflow: hidden;
}
.summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-5);
}
.summary-head-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.summary-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.summary-date {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}
.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.edit-btn:active { transform: scale(0.95); }

/* ===== 左中右布局 ===== */
.summary-grid--row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: var(--space-3);
}
.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-md);
  transition: background var(--dur-fast);
}
.summary-item:active { background: rgba(255, 255, 255, 0.4); }

.summary-ring {
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  isolation: isolate;
}
.summary-ring::before {
  content: "";
  position: absolute;
  inset: -10px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--ring-color, var(--color-warm)) 24%, transparent) 0%,
    transparent 68%
  );
  z-index: -1;
  pointer-events: none;
}
.summary-ring--lg {
  width: 104px;
  height: 104px;
}
.ring-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.ring-pct {
  font-size: var(--text-sm);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.ring-icon {
  font-size: 10px;
  opacity: 0.7;
}
.summary-stat {
  height: 76px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.summary-stat--lg {
  height: 104px;
}
.stat-val {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--icon-warm);
  line-height: 1;
  letter-spacing: -0.01em;
}
.stat-unit {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.summary-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}

/* ===== 上/下（左右）布局 ===== */
.summary-grid--split {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.split-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: var(--space-2);
  border-radius: var(--radius-md);
}
.split-top:active { background: rgba(255, 255, 255, 0.4); }
.split-bottom {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: var(--space-3);
}

/* ===== 快捷指标行 ===== */
.quick-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: var(--space-3);
}
.quick-stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: left;
}
.quick-stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.quick-icon {
  width: 32px;
  height: 32px;
  font-size: 16px;
}
.trend {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}
.trend--up { color: var(--color-warm); }
.trend--down { color: var(--color-primary); }
.trend--flat,
.trend--none { color: var(--color-text-tertiary); }
.quick-stat-value {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.quick-stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}
.quick-stat-unit {
  margin-left: 4px;
  color: var(--color-text-tertiary);
  font-weight: var(--fw-regular);
}

/* ===== 入口网格 ===== */
.entry-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
}
.entry-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  text-align: left;
}
.entry-icon {
  width: 40px;
  height: 40px;
  font-size: 22px;
}
.entry-main { width: 100%; min-width: 0; }
.entry-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.entry-sub {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.entry-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  align-self: stretch;
  justify-content: space-between;
  width: 100%;
}
.entry-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
}

/* ===== 本周柱图卡 ===== */
.chart-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.chart-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.chart-title i { color: var(--color-warm); }
.chart-total {
  font-size: var(--text-sm);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  font-variant-numeric: tabular-nums;
}
.chart-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: right;
}

/* ===== 编辑 BottomSheet ===== */
.edit-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-2);
}
.edit-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.edit-section-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.layout-switch {
  display: flex;
  gap: var(--space-2);
}
.layout-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1.5px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.layout-btn.active {
  border-color: var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
}

.item-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-100);
}
.item-row.active {
  background: var(--warm-50);
}
.item-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  flex: 1;
}
.item-row.active .item-toggle { color: var(--color-warm); }
.item-order {
  display: flex;
  gap: 4px;
}
.order-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
  background: var(--bg-50);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.order-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.order-btn:not(:disabled):active { background: var(--bg-200); }

.edit-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  line-height: 1.5;
}
</style>
