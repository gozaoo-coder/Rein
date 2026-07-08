<script setup lang="ts">
/**
 * WorkoutProgressSheet — 当前训练进度面板
 * 展示：当前步 / 完成组数 / 总组数 / 心率 / 卡路里 / 步骤列表
 */
import { computed } from "vue";
import { useWorkoutStore } from "@/stores/workoutStore";
import { StepType } from "@/types/workout";

defineEmits<{
  (e: "close"): void;
  (e: "jump", stepIndex: number): void;
}>();

const store = useWorkoutStore();

const steps = computed(() => store.plan?.steps ?? []);

const overallProgress = computed(() => {
  if (store.totalSets === 0) return 0;
  return Math.min(1, store.completedSets / store.totalSets);
});

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function stepStatus(idx: number): "done" | "current" | "pending" {
  if (idx < store.currentStepIndex) return "done";
  if (idx === store.currentStepIndex) return "current";
  return "pending";
}
</script>

<template>
  <div class="ps-mask" @click.self="$emit('close')">
    <div class="ps-sheet clean-card">
      <div class="ps-handle" />
      <header class="ps-header">
        <h3 class="ps-title">训练进度</h3>
        <button class="ps-close" @click="$emit('close')" aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <!-- 总览 -->
      <section class="ps-overview">
        <div class="ov-ring">
          <svg width="76" height="76" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="16" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="3" />
            <circle
              cx="18" cy="18" r="16" fill="none"
              stroke="var(--color-warm)"
              stroke-width="3"
              stroke-linecap="round"
              :stroke-dasharray="100.5"
              :stroke-dashoffset="100.5 - overallProgress * 100.5"
              :style="{ transform: 'rotate(-90deg)', transformOrigin: '18px 18px', transition: 'stroke-dashoffset 0.5s ease' }"
            />
          </svg>
          <div class="ov-ring-center">
            <div class="ov-ring-num">{{ Math.round(overallProgress * 100) }}<span class="ov-pct">%</span></div>
            <div class="ov-ring-lbl">完成度</div>
          </div>
        </div>

        <div class="ov-stats">
          <div class="ov-stat">
            <div class="ov-stat-val">{{ store.formattedTime }}</div>
            <div class="ov-stat-lbl">总时长</div>
          </div>
          <div class="ov-stat">
            <div class="ov-stat-val">{{ store.completedSets }}/{{ store.totalSets }}</div>
            <div class="ov-stat-lbl">组数</div>
          </div>
          <div class="ov-stat">
            <div class="ov-stat-val">{{ Math.round(store.caloriesBurned) }}</div>
            <div class="ov-stat-lbl">kcal</div>
          </div>
          <div class="ov-stat" v-if="store.heartRate">
            <div class="ov-stat-val hr-val">{{ store.heartRate }}</div>
            <div class="ov-stat-lbl">BPM</div>
          </div>
        </div>
      </section>

      <!-- 步骤列表 -->
      <section class="ps-steps">
        <div class="ps-steps-title">步骤列表</div>
        <div class="ps-steps-list">
          <button
            v-for="(step, idx) in steps"
            :key="idx"
            class="ps-step"
            :class="`ps-step--${stepStatus(idx)}`"
            @click="$emit('jump', idx)"
          >
            <div class="ps-step-num">
              <svg v-if="stepStatus(idx) === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span v-else>{{ idx + 1 }}</span>
            </div>
            <div class="ps-step-main">
              <div class="ps-step-title">{{ step.details.title }}</div>
              <div class="ps-step-meta">
                <span>{{ step.phase }}</span>
                <span v-if="step.type === StepType.TRAINING && step.sets">· {{ step.sets }} 组</span>
                <span v-if="step.timer?.enabled && step.timer.unit === 'seconds'">· {{ fmtSec(step.timer.value) }}/组</span>
                <span v-else-if="step.timer?.unit === 'reps'">· {{ step.timer.value }} 次</span>
              </div>
            </div>
            <div v-if="stepStatus(idx) === 'current'" class="ps-step-now">进行中</div>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ps-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  animation: ps-fade 0.2s ease;
}
@keyframes ps-fade { from { opacity: 0 } to { opacity: 1 } }

.ps-sheet {
  width: 100%;
  max-width: 520px;
  max-height: 86vh;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-3) var(--space-5) calc(env(safe-area-inset-bottom, 0px) + var(--space-5));
  background: rgba(255, 255, 255, 0.97);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  display: flex;
  flex-direction: column;
  animation: ps-slide 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
  overflow: hidden;
}
@keyframes ps-slide {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.ps-handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--color-divider);
  margin: 0 auto var(--space-3);
  flex-shrink: 0;
}

.ps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
  flex-shrink: 0;
}
.ps-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.ps-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-200);
  border: none;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.ps-close:active { transform: scale(0.9); }

/* Overview */
.ps-overview {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--color-divider);
  flex-shrink: 0;
}
.ov-ring {
  position: relative;
  width: 76px;
  height: 76px;
  flex-shrink: 0;
}
.ov-ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.ov-ring-num {
  font-size: 18px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
}
.ov-pct { font-size: 11px; color: var(--color-text-tertiary); }
.ov-ring-lbl {
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.ov-stats {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.ov-stat {
  text-align: center;
}
.ov-stat-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.hr-val { color: #e84026; }
.ov-stat-lbl {
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

/* Steps */
.ps-steps {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: var(--space-3);
}
.ps-steps-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-2);
}
.ps-steps-list {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ps-step {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
  width: 100%;
}
.ps-step:active { background: var(--bg-200); }
.ps-step--current {
  background: rgba(255, 102, 51, 0.08);
  border-color: rgba(255, 102, 51, 0.25);
}
.ps-step--done {
  opacity: 0.6;
}

.ps-step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--bg-300);
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  flex-shrink: 0;
}
.ps-step--current .ps-step-num {
  background: var(--color-warm);
  color: white;
}
.ps-step--done .ps-step-num {
  background: var(--color-success, #4a9c43);
  color: white;
}

.ps-step-main {
  flex: 1;
  min-width: 0;
}
.ps-step-title {
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-step-meta {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
  display: flex;
  gap: 4px;
}
.ps-step-now {
  font-size: 10px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  background: rgba(255, 102, 51, 0.15);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
}
</style>
