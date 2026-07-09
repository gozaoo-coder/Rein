<script setup lang="ts">
/**
 * HealthOverviewPage — 健康数据概览二级页
 *
 * - 汇总今日健康数据（饮水/饮食/BMI/运动）
 * - 摘要卡片支持自定义：选择要标注的指标 + 布局（左中右 / 上 下左右）
 * - 快捷入口到各健康子页
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useUserStore } from "@/stores/userStore";
import { BMI_CATEGORY_LABEL, classifyBmi } from "@/types/health";
import { usePersistentRef } from "@/composables/useStorage";
import { BottomSheet } from "@/components/ui";

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

const bmi = computed(() => health.currentBmi ?? (userStore.bmi > 0 ? userStore.bmi : undefined));
const bmiCategory = computed(() => (bmi.value ? classifyBmi(bmi.value) : null));

const todayWater = computed(() => health.todayWaterAmount);
const waterGoal = computed(() => health.waterGoalMl);
const waterPct = computed(() => Math.min(100, Math.round((todayWater.value / waterGoal.value) * 100)));

const todayCals = computed(() => health.todayCalories);
const calGoal = computed(() => health.dailyCalorieGoal);
const calPct = computed(() => Math.min(100, Math.round((todayCals.value / calGoal.value) * 100)));

const weekWorkoutMin = computed(() => Math.round(stats.weekDurationSec / 60));

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
    color: "var(--success-500)",
    path: "/health/food",
  },
  workout: {
    id: "workout",
    label: "本周运动",
    icon: "bi-flame",
    kind: "stat",
    pct: 0,
    value: `${weekWorkoutMin.value}`,
    unit: "min",
    color: "var(--color-warm)",
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
    color: "var(--color-warm)",
    path: "/health/bmi",
  },
}));

/** 按配置顺序解析出当前要展示的项 */
const summaryItems = computed<SummaryItemDef[]>(() => {
  const list = cfg.value.items
    .map((id) => allItemsMap.value[id])
    .filter((x): x is SummaryItemDef => !!x);
  return list;
});

/** split 布局：第一项在上方，其余在下方左右排列 */
const splitTop = computed(() => (cfg.value.layout === "split" ? summaryItems.value[0] : null));
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

// ===== 下方入口列表 =====
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
    accent: "var(--success-500)",
  },
  {
    id: "bmi",
    icon: "bi-activity",
    iconClass: "icon-circle--warm",
    name: "身体数据",
    value: bmi.value ? bmi.value.toFixed(1) : "--",
    sub: bmiCategory.value ? BMI_CATEGORY_LABEL[bmiCategory.value] : "点击记录身高体重",
    path: "/health/bmi",
    accent: "var(--color-warm)",
  },
]);
</script>

<template>
  <div class="health-overview-page">
    <!-- 今日健康摘要（可自定义） -->
    <section class="clean-card summary-card">
      <div class="summary-head">
        <h2 class="summary-title">今日健康</h2>
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
          <div v-if="it.kind === 'ring'" class="summary-ring">
            <svg viewBox="0 0 36 36" class="ring-svg">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--bg-200)" stroke-width="3" />
              <circle
                cx="18" cy="18" r="15.5" fill="none"
                :stroke="it.color" stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="`${it.pct * 0.97} 100`"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="ring-pct">{{ it.pct }}%</span>
          </div>
          <div v-else class="summary-stat">
            <span class="stat-val" :style="{ color: it.color }">{{ it.value }}</span>
            <span v-if="it.unit" class="stat-unit">{{ it.unit }}</span>
          </div>
          <div class="summary-label">{{ it.label }}</div>
        </button>
      </div>

      <!-- 上/下（左右）布局 -->
      <div v-else class="summary-grid summary-grid--split">
        <button v-if="splitTop" class="split-top" @click="go(splitTop.path)">
          <div v-if="splitTop.kind === 'ring'" class="summary-ring summary-ring--lg">
            <svg viewBox="0 0 36 36" class="ring-svg">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--bg-200)" stroke-width="3" />
              <circle
                cx="18" cy="18" r="15.5" fill="none"
                :stroke="splitTop.color" stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="`${splitTop.pct * 0.97} 100`"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="ring-pct">{{ splitTop.pct }}%</span>
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
            <div v-if="it.kind === 'ring'" class="summary-ring">
              <svg viewBox="0 0 36 36" class="ring-svg">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--bg-200)" stroke-width="3" />
                <circle
                  cx="18" cy="18" r="15.5" fill="none"
                  :stroke="it.color" stroke-width="3"
                  stroke-linecap="round"
                  :stroke-dasharray="`${it.pct * 0.97} 100`"
                  transform="rotate(-90 18 18)"
                />
              </svg>
              <span class="ring-pct">{{ it.pct }}%</span>
            </div>
            <div v-else class="summary-stat">
              <span class="stat-val" :style="{ color: it.color }">{{ it.value }}</span>
              <span v-if="it.unit" class="stat-unit">{{ it.unit }}</span>
            </div>
            <div class="summary-label">{{ it.label }}</div>
          </button>
        </div>
      </div>
    </section>

    <!-- 健康数据入口列表 -->
    <section class="entry-list">
      <button
        v-for="e in entries"
        :key="e.id"
        class="entry-row clean-card clean-card--interactive"
        @click="go(e.path)"
      >
        <div :class="['entry-icon', 'icon-circle', e.iconClass]">
          <i :class="['bi', e.icon]" :style="{ fontSize: e.id === 'bmi' ? '20px' : '22px' }"></i>
        </div>
        <div class="entry-main">
          <div class="entry-name">{{ e.name }}</div>
          <div class="entry-sub">{{ e.sub }}</div>
        </div>
        <div class="entry-right">
          <span class="entry-val" :style="{ color: e.accent }">{{ e.value }}</span>
          <i class="bi bi-chevron-right chevron" style="font-size:18px"></i>
        </div>
      </button>
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

.summary-card {
  padding: var(--space-5);
}
.summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}
.summary-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.edit-btn:active { transform: scale(0.95); }

/* ===== 左中右布局 ===== */
.summary-grid--row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
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
  padding: var(--space-1);
  border-radius: var(--radius-md);
  transition: background var(--dur-fast);
}
.summary-item:active { background: var(--bg-100); }

.summary-ring {
  position: relative;
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.summary-ring--lg {
  width: 88px;
  height: 88px;
}
.ring-svg {
  width: 100%;
  height: 100%;
}
.ring-pct {
  position: absolute;
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.summary-stat {
  height: 64px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
}
.summary-stat--lg {
  height: 88px;
}
.stat-val {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
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
  gap: var(--space-4);
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
.split-top:active { background: var(--bg-100); }
.split-bottom {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: var(--space-3);
}

/* ===== 入口列表 ===== */
.entry-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.entry-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: none;
  text-align: left;
  width: 100%;
}
.entry-main { flex: 1; min-width: 0; }
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
  gap: var(--space-2);
}
.entry-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  font-variant-numeric: tabular-nums;
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
  background: rgba(255, 138, 0, 0.08);
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
  background: rgba(255, 138, 0, 0.06);
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
