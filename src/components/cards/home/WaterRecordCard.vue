<script setup lang="ts">
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const store = useHealthDataStore();

const GOAL = 2000;
const amount = computed(() => store.todayWaterAmount);
const progress = computed(() => Math.min(amount.value / GOAL, 1));

const C = computed(() => 2 * Math.PI * 14);
const dashOffset = computed(() => C.value - progress.value * C.value);
const isCompact = computed(() => props.size === "1x1" || props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card water-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div v-if="size !== '1x1'" class="card-head">
      <span class="title-icon title-icon--blue">
        <i class="bi bi-droplet-fill" style="font-size:12px"></i>
      </span>
      <span class="card-title">饮水</span>
      <span class="card-pct">{{ Math.round(progress * 100) }}%</span>
    </div>

    <div v-if="size === '1x1'" class="mini">
      <div class="mini-label">饮水</div>
      <div class="mini-num">{{ amount }}</div>
      <div class="mini-label">ml</div>
    </div>

    <div v-else-if="size === '2x1'" class="body-2x1">
      <div class="amount-row">
        <span class="amount-num">{{ amount }}</span>
        <span class="amount-goal">/ {{ GOAL }}ml</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" :style="{ width: progress * 100 + '%' }" />
      </div>
    </div>

    <div v-else class="body-2x2">
      <div class="amount-row">
        <div class="amount-text">
          <span class="amount-num">{{ amount }}</span>
          <span class="amount-goal">/ {{ GOAL }}ml</span>
        </div>
        <span class="pct">{{ Math.round(progress * 100) }}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" :style="{ width: progress * 100 + '%' }" />
      </div>
      <button class="add-btn" @click.stop="emit('click')">
        <i class="bi bi-plus-lg" style="font-size:16px"></i>
        记水
      </button>
    </div>
  </div>
</template>

<style scoped>
.water-card {
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
.water-card:active { transform: scale(0.98); }
.water-card:hover { box-shadow: var(--shadow-card-hover); }

.water-card.is-compact {
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
  background: var(--icon-blue);
}

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.card-pct {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--icon-blue);
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
  color: var(--icon-blue);
  line-height: 1;
}
.mini-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.body-2x1 {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-1);
  min-height: 0;
}

.amount-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.amount-text {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.amount-num {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--icon-blue);
  line-height: 1;
}
.amount-goal {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.pct {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--icon-blue);
  font-weight: var(--fw-semibold);
}

.bar-track {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--icon-blue), #6fc7ff);
  transition: width 0.4s var(--ease-immersive);
}

.body-2x2 {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
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
  background: linear-gradient(135deg, var(--icon-blue), #6fc7ff);
  color: #fff;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.add-btn:active { transform: scale(0.97); }
</style>
