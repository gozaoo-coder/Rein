<script setup lang="ts">
import { computed } from "vue";
import { useWorkoutStore } from "@/stores/workoutStore";

const props = defineProps<{
  expanded?: boolean;
}>();

const store = useWorkoutStore();

const phaseText = computed(() => store.currentStep?.phase ?? "");
const setLabel = computed(() => {
  if (store.inSetRest) return "组间休息";
  if (store.currentStep?.type === "resting") return "休息中";
  return `第 ${store.currentSetInStep}/${store.currentStepSets} 组`;
});

const heartBeatClass = computed(() => ({
  "hr-beating": store.heartRateConnected && store.workoutState === "running",
}));
</script>

<template>
  <div class="workout-minibar" :class="{ 'is-expanded': props.expanded }">
    <!-- Glow aura behind the pill -->
    <div class="minibar-glow" />

    <!-- Compact mode (running): phase text + HR + calories -->
    <div v-if="!props.expanded" class="minibar-compact">
      <span class="phase-pill" :style="{ background: store.phaseColor.bg, color: store.phaseColor.text }">
        {{ phaseText }}
      </span>
      <div v-if="store.heartRateConnected && store.heartRate" class="hr-badge">
        <svg class="hr-icon" :class="heartBeatClass" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        <span class="hr-value">{{ store.heartRate }}</span>
      </div>
      <div v-if="store.caloriesBurned > 0" class="cal-badge">
        <span class="cal-value">{{ Math.round(store.caloriesBurned) }}</span>
        <span class="cal-unit">kcal</span>
      </div>
    </div>

    <!-- Expanded mode (paused): full details -->
    <div v-else class="minibar-expanded">
      <div class="expanded-row">
        <div class="expanded-phase">
          <span class="phase-pill phase-pill--lg" :style="{ background: store.phaseColor.bg, color: store.phaseColor.text }">
            {{ phaseText }}
          </span>
        </div>
        <div class="expanded-stats">
          <div v-if="store.heartRateConnected && store.heartRate" class="expanded-hr">
            <svg class="hr-icon" :class="heartBeatClass" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            <span class="expanded-hr-val">{{ store.heartRate }}</span>
            <span class="expanded-unit">BPM</span>
          </div>
          <div class="expanded-cal">
            <span class="expanded-cal-val">{{ Math.round(store.caloriesBurned) }}</span>
            <span class="expanded-unit">kcal</span>
          </div>
        </div>
      </div>
      <div class="expanded-detail-row">
        <span class="detail-item">
          <span class="detail-label">{{ setLabel }}</span>
          <span class="detail-value">/ 共 {{ store.totalSets }} 组</span>
        </span>
        <span class="detail-sep" />
        <span class="detail-item">
          <span class="detail-value">{{ store.formattedTime }}</span>
          <span class="detail-label">总时长</span>
        </span>
        <template v-if="store.currentStep?.timer?.enabled && store.currentStep.timer.unit === 'seconds'">
          <span class="detail-sep" />
          <span class="detail-item">
            <span class="detail-value timer-val">{{ store.formattedStepTime }}</span>
            <span class="detail-label">{{ store.subState === 'resting' ? '休息剩余' : '本组剩余' }}</span>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workout-minibar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.78);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: var(--radius-pill);
  box-shadow: 0 8px 32px rgba(255, 102, 51, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  isolation: isolate;
}

.minibar-glow {
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  background: radial-gradient(ellipse at 30% 50%, rgba(255, 102, 51, 0.2), transparent 60%),
              radial-gradient(ellipse at 70% 50%, rgba(61, 169, 255, 0.15), transparent 60%);
  z-index: -1;
  animation: glow-shift 4s ease-in-out infinite alternate;
  pointer-events: none;
}

@keyframes glow-shift {
  0% { opacity: 0.6; transform: translateX(-2px); }
  100% { opacity: 1; transform: translateX(2px); }
}

/* Compact mode */
.minibar-compact {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  height: 48px;
  min-width: 0;
}

.phase-pill {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  letter-spacing: 0.02em;
  animation: phase-fade 0.5s ease;
}

.phase-pill--lg {
  font-size: var(--text-lg);
  padding: 6px 16px;
}

@keyframes phase-fade {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.hr-badge, .cal-badge {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  color: var(--color-text-secondary);
  background: rgba(0, 0, 0, 0.04);
  padding: 3px 8px;
  border-radius: var(--radius-pill);
}

.hr-icon {
  color: #ff5a5a;
  flex-shrink: 0;
}

.hr-beating {
  animation: heart-beat 1s ease-in-out infinite;
}

@keyframes heart-beat {
  0%, 100% { transform: scale(1); }
  15% { transform: scale(1.25); }
  30% { transform: scale(1); }
  45% { transform: scale(1.15); }
  60% { transform: scale(1); }
}

.hr-value { color: #e84026; }
.cal-value { color: var(--color-warm); }
.cal-unit { font-size: 10px; color: var(--color-text-tertiary); }

/* Expanded mode */
.minibar-expanded {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  width: 100%;
}

.expanded-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.expanded-phase {
  display: flex;
  align-items: center;
}

.expanded-stats {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.expanded-hr, .expanded-cal {
  display: flex;
  align-items: center;
  gap: 4px;
}

.expanded-hr-val {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: #e84026;
}

.expanded-cal-val {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-warm);
}

.expanded-unit {
  font-size: 10px;
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
}

.expanded-detail-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.detail-item {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.detail-label {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
}

.detail-value {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}

.timer-val {
  color: var(--color-warm);
  font-variant-numeric: tabular-nums;
}

.detail-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--color-divider);
  flex-shrink: 0;
}

/* Size transition between compact/expanded */
.workout-minibar.is-expanded {
  border-radius: var(--radius-xl);
}
</style>
