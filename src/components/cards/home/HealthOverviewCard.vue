<script setup lang="ts">
import { computed } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { BMI_CATEGORY_LABEL, classifyBmi } from "@/types/health";
import type { CardSize } from "@/types/card";

const props = defineProps<{ size: CardSize }>();
const emit = defineEmits<{ click: [] }>();

const health = useHealthDataStore();

const bmi = computed(() => health.currentBmi);
const bmiCategory = computed(() => (bmi.value ? classifyBmi(bmi.value) : null));
const isLarge = computed(() => props.size === "2x2");
const isCompact = computed(() => props.size === "2x1");
</script>

<template>
  <div
    class="home-card clean-card health-card"
    :class="[`home-card--${size}`, { 'is-compact': isCompact }]"
    @click="emit('click')"
  >
    <div class="card-head">
      <span class="title-icon title-icon--warm">
        <i class="bi bi-heart-fill" style="font-size:12px"></i>
      </span>
      <span class="card-title">健康概览</span>
    </div>

    <div v-if="bmi" class="bmi-main">
      <div class="bmi-num">{{ bmi.toFixed(1) }}</div>
      <span v-if="bmiCategory" class="bmi-badge" :class="`bmi-badge--${bmiCategory}`">
        {{ BMI_CATEGORY_LABEL[bmiCategory] }}
      </span>
    </div>
    <div v-else class="bmi-empty">
      <span class="empty-label">点击记录</span>
      <span class="empty-hint">身高体重</span>
    </div>

    <div v-if="isLarge" class="quick-row">
      <div class="qr-item">
        <span class="qr-val">{{ health.todayWaterAmount }}ml</span>
        <span class="qr-label">饮水</span>
      </div>
      <div class="qr-sep" />
      <div class="qr-item">
        <span class="qr-val">{{ health.todayCalories }}</span>
        <span class="qr-label">千卡</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.health-card {
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
.health-card:active { transform: scale(0.98); }
.health-card:hover { box-shadow: var(--shadow-card-hover); }

.health-card.is-compact {
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
}
.title-icon--warm { background: var(--color-warm); }

.card-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  line-height: 1.2;
}

.bmi-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
}
.bmi-num {
  font-size: var(--text-2xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.bmi-badge {
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-size: 10px;
  font-weight: var(--fw-semibold);
}
.bmi-badge--normal { background: var(--success-50); color: var(--success-600); }
.bmi-badge--underweight { background: var(--warning-50); color: var(--warning-600); }
.bmi-badge--overweight { background: var(--warning-50); color: var(--warning-600); }
.bmi-badge--obese { background: var(--danger-50); color: var(--danger-600); }

.bmi-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
}
.empty-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.empty-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.quick-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding-top: var(--space-1);
  border-top: 1px solid var(--color-divider);
}
.qr-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.qr-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.qr-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.qr-sep {
  width: 1px;
  height: 16px;
  background: var(--color-divider);
}
</style>
