<script setup lang="ts">
/**
 * FoodCompositionPage — 今日饮食构成（三级页面）
 *
 * - 今日总热量 + 三大营养素供能占比（饼图样式）
 * - 按组分类的营养素列表：三大 / 膳食纤维 / 矿物质 / 维生素 / 其他
 */
import { computed, onMounted } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { sumTodayNutrients, macroEnergyRatio, type NutrientEntry } from "@/utils/foodNutrients";

const store = useHealthDataStore();

onMounted(() => {
  void store.load();
});

const todayRecords = computed(() => store.todayFoodRecords);
const allNutrients = computed(() => sumTodayNutrients(todayRecords.value, store.foodDb));

const GROUP_LABEL: Record<NutrientEntry["group"], string> = {
  macro: "三大营养素",
  fiber: "膳食纤维",
  mineral: "矿物质",
  vitamin: "维生素",
  other: "其他",
};
const GROUP_ORDER: NutrientEntry["group"][] = ["macro", "fiber", "mineral", "vitamin", "other"];

const grouped = computed(() => {
  const map = new Map<NutrientEntry["group"], NutrientEntry[]>();
  for (const n of allNutrients.value) {
    const arr = map.get(n.group) ?? [];
    arr.push(n);
    map.set(n.group, arr);
  }
  return GROUP_ORDER
    .filter((g) => map.has(g))
    .map((g) => ({ group: g, label: GROUP_LABEL[g], items: map.get(g)! }));
});

const cal = computed(() => allNutrients.value.find((n) => n.name === "热量")?.value ?? 0);
const carbs = computed(() => allNutrients.value.find((n) => n.name === "碳水化合物")?.value ?? 0);
const protein = computed(() => allNutrients.value.find((n) => n.name === "蛋白质")?.value ?? 0);
const fat = computed(() => allNutrients.value.find((n) => n.name === "脂肪")?.value ?? 0);

const ratio = computed(() => macroEnergyRatio(cal.value, carbs.value, protein.value, fat.value));

const RING = 56;
const CIRC = 2 * Math.PI * RING;
const segments = computed(() => {
  const total = ratio.value.carbs + ratio.value.protein + ratio.value.fat;
  if (total <= 0) return [];
  let acc = 0;
  const segs = [
    { name: "碳水", pct: ratio.value.carbs, color: "#f5a623" },
    { name: "蛋白质", pct: ratio.value.protein, color: "#64bb5c" },
    { name: "脂肪", pct: ratio.value.fat, color: "#9b59b6" },
  ];
  return segs.map((s) => {
    const dash = (s.pct / 100) * CIRC;
    const offset = -acc / 100 * CIRC;
    acc += s.pct;
    return { ...s, dash, offset };
  });
});

const hasData = computed(() => todayRecords.value.length > 0);
</script>

<template>
  <div class="food-comp-page page-scroll">
    <h2 class="page-title">今日饮食构成</h2>

    <div v-if="!hasData" class="empty-card clean-card">
      <i class="bi bi-egg-fried" style="font-size:36px;color:var(--color-text-tertiary)"></i>
      <p>今日暂无饮食记录</p>
      <p class="empty-sub">去饮食页记录今日摄入即可查看构成</p>
    </div>

    <template v-else>
      <div class="overview-card clean-card">
        <div class="ring-wrap">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" :r="RING" fill="none" stroke="var(--bg-200)" stroke-width="14" />
            <circle
              v-for="(s, i) in segments"
              :key="i"
              cx="70" cy="70" :r="RING" fill="none"
              :stroke="s.color" stroke-width="14"
              :stroke-dasharray="`${s.dash} ${CIRC}`"
              :stroke-dashoffset="s.offset"
              transform="rotate(-90 70 70)"
              style="transition: stroke-dasharray 0.5s var(--ease-immersive), stroke-dashoffset 0.5s var(--ease-immersive)"
            />
            <text x="70" y="64" text-anchor="middle" font-size="22" font-weight="700" fill="var(--color-text)">{{ cal }}</text>
            <text x="70" y="82" text-anchor="middle" font-size="11" fill="var(--color-text-tertiary)">千卡</text>
          </svg>
        </div>
        <div class="legend">
          <div class="legend-item">
            <span class="dot" style="background:#f5a623"></span>
            <span class="lbl">碳水</span>
            <span class="val">{{ carbs }}g</span>
            <span class="pct">{{ ratio.carbs }}%</span>
          </div>
          <div class="legend-item">
            <span class="dot" style="background:#64bb5c"></span>
            <span class="lbl">蛋白质</span>
            <span class="val">{{ protein }}g</span>
            <span class="pct">{{ ratio.protein }}%</span>
          </div>
          <div class="legend-item">
            <span class="dot" style="background:#9b59b6"></span>
            <span class="lbl">脂肪</span>
            <span class="val">{{ fat }}g</span>
            <span class="pct">{{ ratio.fat }}%</span>
          </div>
        </div>
      </div>

      <div v-for="g in grouped" :key="g.group" class="group-card clean-card">
        <h3 class="group-title">{{ g.label }}</h3>
        <div class="nutrient-grid">
          <div v-for="n in g.items" :key="n.name" class="nutrient-cell">
            <div class="n-top">
              <span class="n-name">{{ n.name }}</span>
              <span class="n-val">{{ n.value }}<span class="n-unit">{{ n.unit }}</span></span>
            </div>
            <div v-if="n.group === 'macro' && n.name !== '热量'" class="n-bar">
              <div class="n-bar-fill" :style="{
                width: Math.min(n.value / (n.name === '碳水化合物' ? 250 : n.name === '蛋白质' ? 60 : 70) * 100, 100) + '%',
                background: n.name === '碳水化合物' ? '#f5a623' : n.name === '蛋白质' ? '#64bb5c' : '#9b59b6',
              }" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.food-comp-page {
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

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-text-tertiary);
}
.empty-card p { margin: 0; font-size: var(--text-sm); }
.empty-sub { font-size: var(--text-xs) !important; color: var(--color-text-tertiary); }

.overview-card {
  padding: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.ring-wrap {
  flex-shrink: 0;
}

.legend {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.legend-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.lbl {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  min-width: 48px;
}
.val {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin-left: auto;
}
.pct {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  min-width: 36px;
  text-align: right;
}

.group-card {
  padding: var(--space-4);
}
.group-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}
.nutrient-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.nutrient-cell {
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.n-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}
.n-name {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.n-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.n-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  margin-left: 2px;
}
.n-bar {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.n-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}

@media (min-width: 480px) {
  .nutrient-grid {
    grid-template-columns: 1fr 1fr 1fr;
  }
}
</style>
