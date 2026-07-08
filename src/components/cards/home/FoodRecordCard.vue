<script setup lang="ts">
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();

const calories = computed(() => store.todayCalories);
const carbs = computed(() => store.todayCarbs);
const protein = computed(() => store.todayProtein);
const fat = computed(() => store.todayFat);

const CAL_GOAL = 2000;
const CARB_GOAL = 250;
const PROTEIN_GOAL = 60;
const FAT_GOAL = 70;

const macros = computed(() => [
  { label: "碳", value: carbs.value, goal: CARB_GOAL, color: "var(--icon-orange)" },
  { label: "蛋", value: protein.value, goal: PROTEIN_GOAL, color: "var(--icon-blue)" },
  { label: "脂", value: fat.value, goal: FAT_GOAL, color: "var(--warning-500)" },
]);

const isCompact = computed(() => props.size === "1x1" || props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card food-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--success">
        <i class="bi bi-apple" style="font-size:12px"></i>
      </span>
      <span class="card-title">饮食</span>
      <span class="card-kcal">{{ calories }}kcal</span>
    </div>

    <div v-if="size === '1x1'" class="mini">
      <div class="mini-num">{{ calories }}</div>
      <div class="mini-label">kcal</div>
    </div>

    <div v-else-if="size === '2x1'" class="body-2x1">
      <div class="macro-row-compact">
        <div v-for="m in macros" :key="m.label" class="macro-c">
          <div class="macro-c-track">
            <div class="macro-c-fill" :style="{ width: Math.min(m.value / m.goal, 1) * 100 + '%', background: m.color }" />
          </div>
          <span class="macro-c-label">{{ m.label }} {{ m.value }}g</span>
        </div>
      </div>
    </div>

    <div v-else class="body-2x2">
      <div class="cal-big-row">
        <div class="cal-big-text">
          <span class="cal-big-num">{{ calories }}</span>
          <span class="cal-big-unit">kcal</span>
        </div>
        <span class="cal-big-goal">/ {{ CAL_GOAL }}</span>
      </div>
      <div class="macro-rows">
        <div v-for="m in macros" :key="m.label" class="macro-row">
          <span class="macro-dot" :style="{ background: m.color }" />
          <span class="macro-label">{{ m.label === '碳' ? '碳水' : m.label === '蛋' ? '蛋白' : '脂肪' }}</span>
          <div class="macro-track">
            <div class="macro-fill" :style="{ width: Math.min(m.value / m.goal, 1) * 100 + '%', background: m.color }" />
          </div>
          <span class="macro-val">{{ m.value }}g</span>
        </div>
      </div>
      <button class="add-btn" @click.stop="emit('click')">
        <i class="bi bi-plus-lg" style="font-size:16px"></i>
        记饮食
      </button>
    </div>
  </div>
</template>

<style scoped>
.food-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  text-align: left;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    transform var(--dur-fast) var(--ease-immersive),
    box-shadow var(--dur-fast) var(--ease-immersive);
}
.food-card:active { transform: scale(0.98); }
.food-card:hover { box-shadow: var(--shadow-card-hover); }

.food-card.is-compact {
  padding: var(--space-2) var(--space-3);
  gap: var(--space-1);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  color: #fff;
  background: var(--success-500);
}

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.card-kcal {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--success-600);
  font-weight: var(--fw-semibold);
}

.mini {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
}
.mini-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--success-500);
  line-height: 1;
}
.mini-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
}

.body-2x1 {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
}

.macro-row-compact {
  display: flex;
  gap: var(--space-2);
}
.macro-c {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.macro-c-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.macro-c-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}
.macro-c-label {
  font-size: 10px;
  color: var(--color-text-tertiary);
  text-align: center;
}

.body-2x2 {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.cal-big-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.cal-big-text {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.cal-big-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--success-500);
  line-height: 1;
}
.cal-big-unit {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.cal-big-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.macro-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.macro-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.macro-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.macro-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  width: 28px;
  flex-shrink: 0;
}
.macro-track {
  flex: 1;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.macro-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}
.macro-val {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
  width: 36px;
  text-align: right;
  flex-shrink: 0;
}

.add-btn {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius-full);
  border: none;
  background: linear-gradient(135deg, var(--success-500), #5dd39e);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.add-btn:active { transform: scale(0.97); }
</style>
