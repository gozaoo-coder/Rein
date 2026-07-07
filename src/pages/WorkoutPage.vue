<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useWorkoutStore } from "@/stores/workoutStore";
import { createSampleWorkout } from "@/data/workoutBuilder";
import WorkoutNav from "@/components/workout/WorkoutNav.vue";
import { StepType, MediaType } from "@/types/workout";

const router = useRouter();
const store = useWorkoutStore();

const showConfirmExit = ref(false);

onMounted(() => {
  if (!store.plan || store.workoutState === "idle") {
    const plan = createSampleWorkout();
    store.startWorkout(plan);
  }
});

onUnmounted(() => {
  if (store.workoutState !== "finished") {
    store.reset();
  }
});

const stepTitle = computed(() => store.currentStep?.details.title ?? "");
const guideContent = computed(() => store.currentStep?.details.guide.content ?? "");
const guideType = computed(() => store.currentStep?.details.guide.type);
const isVideo = computed(() => guideType.value === MediaType.VIDEO);
const isImage = computed(() => guideType.value === MediaType.IMAGE);
const isMarkdown = computed(() => guideType.value === MediaType.MARKDOWN_TEXT);
const isResting = computed(() => store.currentStep?.type === StepType.RESTING);

const hasTimer = computed(() => {
  return store.currentStep?.timer?.enabled && store.currentStep.timer.unit === "seconds";
});

const timerRingProgress = computed(() => {
  if (!hasTimer.value || !store.currentStep?.timer?.enabled) return 0;
  const total = store.currentStep.timer.value;
  if (total <= 0) return 0;
  return ((total - store.stepSecondsRemaining) / total) * 283;
});

const guideLines = computed(() => {
  return guideContent.value.split("\n").filter((l) => l.trim().length > 0);
});

function handleManualNext() {
  if (store.workoutState === "paused") return;
  store.nextStep();
}

function handleTerminate() {
  showConfirmExit.value = true;
}

function confirmExit() {
  store.terminateWorkout();
  router.push("/sports");
}

function cancelExit() {
  showConfirmExit.value = false;
  store.resume();
}

function goBackToSports() {
  store.reset();
  router.push("/sports");
}
</script>

<template>
  <div class="workout-page" :class="{ 'is-resting': isResting, 'is-finished': store.workoutState === 'finished' }">
    <!-- Ambient color halos -->
    <div class="ambient-halo ambient-halo--warm" />
    <div v-if="isResting" class="ambient-halo ambient-halo--cool" />

    <!-- Main content -->
    <div v-if="store.workoutState !== 'finished'" class="workout-content">
      <!-- Header section: name + set info -->
      <div class="workout-header">
        <button class="back-btn" @click="handleTerminate" aria-label="退出">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div class="header-text">
          <h1 class="workout-name">{{ store.plan?.name }}</h1>
          <div class="set-info-row">
            <span class="set-badge" v-if="!isResting">
              第 {{ store.currentTrainingSetNumber }} 组 / 共 {{ store.totalSets }} 组
            </span>
            <span class="set-badge set-badge--rest" v-else>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              休息时间
            </span>
            <span class="level-tag">{{ store.plan?.level }}</span>
          </div>
        </div>
        <div class="header-timer">
          <span class="total-time">{{ store.formattedTime }}</span>
        </div>
      </div>

      <!-- Step title (exercise name) -->
      <div class="step-title-section">
        <h2 class="step-title">{{ stepTitle }}</h2>
        <div v-if="isResting" class="rest-hint">深呼吸，调整状态</div>
      </div>

      <!-- Center area: timer ring OR guide content -->
      <div class="center-area">
        <!-- Timer with ring (when timer is enabled) -->
        <div v-if="hasTimer" class="timer-ring-wrap">
          <svg class="timer-ring" width="240" height="240" viewBox="0 0 100 100">
            <circle class="ring-track" cx="50" cy="50" r="45" fill="none" stroke-width="4" />
            <circle
              class="ring-progress"
              cx="50" cy="50" r="45" fill="none" stroke-width="4"
              stroke-linecap="round"
              :stroke-dasharray="283"
              :stroke-dashoffset="283 - timerRingProgress"
              :style="{ transform: 'rotate(-90deg)', transformOrigin: '50px 50px' }"
            />
          </svg>
          <div class="timer-center">
            <div class="timer-number">{{ store.formattedStepTime }}</div>
            <div class="timer-label">{{ isResting ? '秒后继续' : '秒' }}</div>
            <div v-if="store.heartRateConnected && store.heartRate" class="timer-hr">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#ff5a5a">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              {{ store.heartRate }} BPM
            </div>
          </div>
        </div>

        <!-- Reps counter (manual mode) -->
        <div v-else-if="store.currentStep?.timer?.unit === 'reps'" class="reps-display">
          <div class="reps-number">{{ store.currentStep.timer.value }}</div>
          <div class="reps-label">次</div>
          <button class="manual-next-btn" @click="handleManualNext">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>完成本组</span>
          </button>
        </div>
      </div>

      <!-- Guide content (markdown text, fills remaining space below timer) -->
      <div v-if="isMarkdown && guideLines.length > 0" class="guide-section">
        <div class="guide-card clean-card">
          <div class="guide-steps">
            <div v-for="(line, idx) in guideLines" :key="idx" class="guide-step">
              <span class="step-num">{{ idx + 1 }}</span>
              <span class="step-text">{{ line.replace(/^\d+\.\s*/, "") }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Video placeholder -->
      <div v-if="isVideo" class="video-placeholder">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="3" />
          <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" />
        </svg>
        <span>指导视频</span>
      </div>
    </div>

    <!-- Finished state -->
    <div v-else class="finished-view">
      <div class="finished-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <h2 class="finished-title">训练完成！</h2>
      <p class="finished-sub">干得漂亮，继续坚持</p>
      <div class="finished-stats clean-card">
        <div class="fin-stat">
          <div class="fin-val">{{ store.formattedTime }}</div>
          <div class="fin-lbl">总时长</div>
        </div>
        <div class="fin-divider" />
        <div class="fin-stat">
          <div class="fin-val">{{ store.totalSets }}</div>
          <div class="fin-lbl">完成组数</div>
        </div>
        <div class="fin-divider" />
        <div class="fin-stat">
          <div class="fin-val">{{ Math.round(store.caloriesBurned) }}</div>
          <div class="fin-lbl">消耗kcal</div>
        </div>
        <div v-if="store.heartRate" class="fin-stat">
          <div class="fin-divider" />
          <div class="fin-val">{{ store.heartRate }}</div>
          <div class="fin-lbl">平均心率</div>
        </div>
      </div>
      <button class="finish-btn" @click="goBackToSports">返回运动</button>
    </div>

    <!-- Workout bottom nav (only during workout, not on finished screen) -->
    <WorkoutNav v-if="store.workoutState !== 'finished'" @terminate="handleTerminate" />

    <!-- Confirm exit overlay -->
    <div v-if="showConfirmExit" class="confirm-overlay">
      <div class="confirm-card glass-thick">
        <h3 class="confirm-title">确认退出训练？</h3>
        <p class="confirm-desc">退出后当前训练进度将不会保存</p>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-btn--cancel" @click="cancelExit">继续训练</button>
          <button class="confirm-btn confirm-btn--danger" @click="confirmExit">确认退出</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workout-page {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Ambient color halos */
.ambient-halo {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
  z-index: 0;
}

.ambient-halo--warm {
  width: 400px;
  height: 400px;
  background: rgba(255, 102, 51, 0.12);
  top: -100px;
  right: -100px;
}

.ambient-halo--cool {
  width: 350px;
  height: 350px;
  background: rgba(61, 169, 255, 0.1);
  bottom: 100px;
  left: -80px;
}

.is-resting .ambient-halo--warm {
  background: rgba(61, 169, 255, 0.08);
}

.is-resting .ambient-halo--cool {
  background: rgba(100, 187, 92, 0.1);
}

/* Content */
.workout-content {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-5);
  padding-top: calc(env(safe-area-inset-top, 0px) + var(--space-3));
  padding-bottom: calc(140px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* Header */
.workout-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.7);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  color: var(--color-text-secondary);
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.5);
  transition: transform 0.15s ease;
}

.back-btn:active {
  transform: scale(0.9);
}

.header-text {
  flex: 1;
  min-width: 0;
}

.workout-name {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1.2;
  letter-spacing: -0.01em;
}

.set-info-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  flex-wrap: wrap;
}

.set-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  color: var(--color-warm);
  background: rgba(255, 102, 51, 0.1);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
}

.set-badge--rest {
  color: #3da9ff;
  background: rgba(61, 169, 255, 0.1);
}

.level-tag {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  background: var(--bg-200);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
}

.header-timer {
  flex-shrink: 0;
}

.total-time {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* Step title */
.step-title-section {
  text-align: center;
  margin-bottom: var(--space-2);
  padding: var(--space-2) 0;
}

.step-title {
  font-size: var(--text-3xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.rest-hint {
  font-size: var(--text-md);
  color: #3da9ff;
  margin-top: var(--space-1);
  font-weight: var(--fw-medium);
}

/* Center area (timer / reps) */
.center-area {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 280px;
  padding: var(--space-4) 0;
}

/* Timer ring */
.timer-ring-wrap {
  position: relative;
  width: 240px;
  height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.timer-ring {
  position: absolute;
  inset: 0;
}

.ring-track {
  stroke: rgba(0, 0, 0, 0.05);
}

.ring-progress {
  stroke: var(--color-warm);
  transition: stroke-dashoffset 1s linear;
  stroke-linecap: round;
}

.is-resting .ring-progress {
  stroke: #3da9ff;
}

.timer-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.timer-number {
  font-size: 56px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}

.is-resting .timer-number {
  color: #3da9ff;
}

.timer-label {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
}

.timer-hr {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: #e84026;
  font-weight: var(--fw-semibold);
  margin-top: var(--space-2);
}

/* Reps display */
.reps-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
}

.reps-number {
  font-size: 96px;
  font-weight: var(--fw-bold);
  color: var(--color-warm);
  line-height: 1;
  letter-spacing: -0.04em;
}

.reps-label {
  font-size: var(--text-xl);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
  margin-top: -8px;
}

.manual-next-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-6);
  padding: var(--space-4) var(--space-8);
  background: var(--color-warm);
  color: white;
  border-radius: var(--radius-pill);
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  box-shadow: 0 8px 24px rgba(255, 102, 51, 0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.manual-next-btn:active {
  transform: scale(0.95);
  box-shadow: 0 4px 12px rgba(255, 102, 51, 0.25);
}

/* Guide section */
.guide-section {
  margin-top: var(--space-3);
}

.guide-card {
  padding: var(--space-4) var(--space-5);
}

.guide-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.guide-step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-warm);
  color: white;
  font-size: var(--text-xs);
  font-weight: var(--fw-bold);
  flex-shrink: 0;
  margin-top: 1px;
}

.is-resting .step-num {
  background: #3da9ff;
}

.step-text {
  font-size: var(--text-md);
  color: var(--color-text-secondary);
  line-height: 1.5;
  flex: 1;
}

/* Video placeholder */
.video-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  color: var(--color-text-tertiary);
  background: var(--bg-200);
  border-radius: var(--radius-lg);
  margin-top: var(--space-3);
}

/* Finished view */
.finished-view {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
  gap: var(--space-3);
}

.finished-icon {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: rgba(100, 187, 92, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-2);
}

.finished-title {
  font-size: var(--text-3xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}

.finished-sub {
  font-size: var(--text-md);
  color: var(--color-text-tertiary);
  margin-bottom: var(--space-6);
}

.finished-stats {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6);
  margin-bottom: var(--space-8);
}

.fin-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 60px;
}

.fin-val {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.fin-lbl {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.fin-divider {
  width: 1px;
  height: 32px;
  background: var(--color-divider);
  flex-shrink: 0;
}

.finish-btn {
  padding: var(--space-4) var(--space-10);
  background: var(--color-warm);
  color: white;
  border-radius: var(--radius-pill);
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  box-shadow: 0 8px 24px rgba(255, 102, 51, 0.3);
  transition: transform 0.15s ease;
}

.finish-btn:active {
  transform: scale(0.95);
}

/* Confirm overlay */
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  animation: overlay-fade 0.2s ease;
}

@keyframes overlay-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.confirm-card {
  background: rgba(255, 255, 255, 0.92);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  width: 100%;
  max-width: 320px;
  text-align: center;
  animation: card-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes card-pop {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

.confirm-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin-bottom: var(--space-2);
}

.confirm-desc {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-5);
}

.confirm-actions {
  display: flex;
  gap: var(--space-3);
}

.confirm-btn {
  flex: 1;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  transition: transform 0.15s ease;
}

.confirm-btn:active {
  transform: scale(0.95);
}

.confirm-btn--cancel {
  background: var(--bg-200);
  color: var(--color-text);
}

.confirm-btn--danger {
  background: var(--color-danger);
  color: white;
}
</style>
