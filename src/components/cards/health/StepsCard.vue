<script setup lang="ts">
import { computed, ref, onMounted } from "vue"
import { useAnime } from "@/composables/useAnime"

const props = withDefaults(defineProps<{
  steps?: number
  goal?: number
}>(), {
  steps: 0,
  goal: 10000,
})

const progress = computed(() => Math.min((props.steps / props.goal) * 100, 100))
const circumference = 2 * Math.PI * 36
const strokeDashoffset = computed(() => circumference - (progress.value / 100) * circumference)

const { animate, reduced } = useAnime()
const display = ref(0)

onMounted(() => {
  if (reduced.value) { display.value = props.steps; return }
  const obj = { val: 0 }
  animate(obj, {
    val: props.steps,
    duration: 800,
    ease: "outExpo",
    onUpdate: () => { display.value = Math.round(obj.val) },
  })
})
</script>

<template>
  <div class="steps-card">
    <div class="card-header">
      <span class="card-label">步数</span>
    </div>
    <div class="card-body">
      <svg class="progress-ring" viewBox="0 0 80 80" width="56" height="56">
        <circle class="ring-bg" cx="40" cy="40" r="36" />
        <circle
          class="ring-progress"
          cx="40" cy="40" r="36"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="strokeDashoffset"
        />
      </svg>
      <div class="card-stats">
        <span class="stat-value">{{ display.toLocaleString() }}</span>
        <span class="stat-unit">步</span>
      </div>
    </div>
    <div class="card-footer">
      <span class="goal-text">目标 {{ goal.toLocaleString() }}</span>
      <span class="goal-pct">{{ Math.round(progress) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.steps-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  height: 100%;
  box-sizing: border-box;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.card-body {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
}

.progress-ring {
  flex-shrink: 0;
  transform: rotate(-90deg);
}

.ring-bg {
  fill: none;
  stroke: var(--bg-200);
  stroke-width: 6;
}

.ring-progress {
  fill: none;
  stroke: var(--brand-500);
  stroke-width: 6;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.6s ease;
}

.card-stats {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1;
}

.stat-unit {
  font-size: 13px;
  color: var(--color-text-tertiary);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.goal-text {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.goal-pct {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-500);
}
</style>
