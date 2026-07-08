<script setup lang="ts">
/**
 * WorkoutPage — 运动模式主页面
 *
 * 渲染层：header + 步骤标题 + 中心计时圆环 + 详细动作信息 + 底部 WorkoutNav
 * 运行时生命周期由 useWorkoutRuntime composable 管理（含异常打断恢复）
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useWorkoutRuntime } from "@/composables/useWorkoutRuntime";
import WorkoutNav from "@/components/workout/WorkoutNav.vue";
import WorkoutProgressSheet from "@/components/workout/WorkoutProgressSheet.vue";
import WorkoutQuickRestSheet from "@/components/workout/WorkoutQuickRestSheet.vue";
import WorkoutAiPanel from "@/components/workout/WorkoutAiPanel.vue";
import ShareSheet from "@/components/share/ShareSheet.vue";
import { formatWorkoutEnd } from "@/data/shareFormatters";
import type { ShareContent } from "@/types/share";
import { StepType, MediaType } from "@/types/workout";
import { DIFFICULTY_LABEL, type CourseDifficulty } from "@/types/course";

const router = useRouter();
const { store, hasInterrupted, resumeInterrupted, discardInterrupted } = useWorkoutRuntime();

const showConfirmExit = ref(false);
const showProgress = ref(false);
const showQuickRest = ref(false);
const showAiPanel = ref(false);
const showShare = ref(false);

const shareContent = computed<ShareContent | null>(() => {
  if (store.workoutState !== "finished" || !store.activeCourse) return null;
  return formatWorkoutEnd({
    courseName: store.activeCourse.name,
    durationSec: store.totalElapsedSeconds,
    completedSets: store.completedSets,
    totalSets: store.totalSets,
    finished: true,
  });
});

const stepTitle = computed(() => store.currentStep?.details.title ?? "");
const levelLabel = computed(() => {
  const lv = store.plan?.level as CourseDifficulty | undefined;
  return lv ? (DIFFICULTY_LABEL[lv] ?? lv) : "";
});
const guideContent = computed(() => store.currentStep?.details.guide.content ?? "");
const guideType = computed(() => store.currentStep?.details.guide.type);
const stepDetails = computed(() => store.currentStep?.details);
const isVideo = computed(() => guideType.value === MediaType.VIDEO);
const isImage = computed(() => guideType.value === MediaType.IMAGE);
const isMarkdown = computed(() => guideType.value === MediaType.MARKDOWN_TEXT);
const isResting = computed(() =>
  store.currentStep?.type === StepType.RESTING || store.inSetRest || store.inQuickRest
);

const hasTimer = computed(() => {
  if (store.inSetRest || store.inQuickRest) return true;
  return store.currentStep?.timer?.enabled && store.currentStep.timer.unit === "seconds";
});

const timerRingProgress = computed(() => {
  if (store.inQuickRest) {
    return store.quickRestProgress * 283;
  }
  if (store.inSetRest) {
    const total = store.currentStep?.restBetweenSets ?? 30;
    if (total <= 0) return 0;
    return ((total - store.stepSecondsRemaining) / total) * 283;
  }
  if (!hasTimer.value || !store.currentStep?.timer?.enabled) return 0;
  const total = store.currentStep.timer.value;
  if (total <= 0) return 0;
  return ((total - store.stepSecondsRemaining) / total) * 283;
});

const guideParagraphs = computed(() => {
  return guideContent.value
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
});

const timerLabel = computed(() => {
  if (store.inQuickRest) return "小休息";
  if (store.inSetRest) return "组间休息";
  if (isResting.value) return "休息中";
  return "秒";
});

const timerValue = computed(() => {
  if (store.inQuickRest) return store.formattedQuickRest;
  return store.formattedStepTime;
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

function handleQuickRest(seconds: number) {
  store.enterQuickRest(seconds);
  showQuickRest.value = false;
}

function handleJumpStep(idx: number) {
  if (idx === store.currentStepIndex) {
    showProgress.value = false;
    return;
  }
  // 简化：仅允许向前跳到未完成步骤
  if (idx > store.currentStepIndex) {
    for (let i = store.currentStepIndex; i < idx; i++) {
      store.nextStep();
    }
  }
  showProgress.value = false;
}
</script>

<template>
  <div class="workout-page" :class="{ 'is-resting': isResting, 'is-finished': store.workoutState === 'finished' }">
    <!-- Ambient color halos -->
    <div class="ambient-halo ambient-halo--warm" />
    <div v-if="isResting" class="ambient-halo ambient-halo--cool" />

    <!-- 异常打断恢复提示 -->
    <div v-if="hasInterrupted" class="interrupt-mask">
      <div class="interrupt-card glass-thick">
        <div class="interrupt-icon">
          <i class="bi bi-arrow-clockwise"></i>
        </div>
        <h3 class="interrupt-title">检测到未完成的训练</h3>
        <p class="interrupt-desc">
          {{ store.plan?.name }} · 已进行 {{ store.formattedTime }}
        </p>
        <div class="interrupt-actions">
          <button class="interrupt-btn interrupt-btn--ghost" @click="discardInterrupted">放弃</button>
          <button class="interrupt-btn interrupt-btn--primary" @click="resumeInterrupted">继续训练</button>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div v-if="store.workoutState !== 'finished'" class="workout-content">
      <!-- Header section: name + set info + actions -->
      <div class="workout-header">
        <button class="back-btn" @click="handleTerminate" aria-label="退出">
          <i class="bi bi-chevron-left"></i>
        </button>
        <div class="header-text">
          <h1 class="workout-name">{{ store.plan?.name }}</h1>
          <div class="set-info-row">
            <span class="set-badge" v-if="!isResting && store.currentStep?.type === 'training'">
              第 {{ store.currentSetInStep }}/{{ store.currentStepSets }} 组
            </span>
            <span class="set-badge set-badge--rest" v-else-if="store.inSetRest">
              <i class="bi bi-clock"></i>
              组间休息
            </span>
            <span class="set-badge set-badge--rest" v-else-if="store.inQuickRest">
              <i class="bi bi-clock"></i>
              小休息
            </span>
            <span class="set-badge set-badge--rest" v-else>
              <i class="bi bi-clock"></i>
              休息时间
            </span>
            <span class="level-tag">{{ levelLabel }}</span>
          </div>
        </div>
        <!-- 右上角 list 按钮 -->
        <button class="list-btn" @click="showProgress = true" aria-label="训练进度">
          <i class="bi bi-list"></i>
        </button>
      </div>

      <!-- Step title (exercise name) -->
      <div class="step-title-section">
        <h2 class="step-title">{{ stepTitle }}</h2>
        <div v-if="isResting" class="rest-hint">深呼吸，调整状态</div>
      </div>

      <!-- Center area: timer ring OR guide content -->
      <div class="center-area">
        <!-- Timer with ring (thick) -->
        <div v-if="hasTimer" class="timer-ring-wrap">
          <svg class="timer-ring" width="260" height="260" viewBox="0 0 100 100">
            <circle class="ring-track" cx="50" cy="50" r="45" fill="none" stroke-width="8" />
            <circle
              class="ring-progress"
              cx="50" cy="50" r="45" fill="none" stroke-width="8"
              stroke-linecap="round"
              :stroke-dasharray="283"
              :stroke-dashoffset="283 - timerRingProgress"
              :style="{ transform: 'rotate(-90deg)', transformOrigin: '50px 50px' }"
            />
          </svg>
          <div class="timer-center">
            <div class="timer-number">{{ timerValue }}</div>
            <div class="timer-label">{{ timerLabel }}</div>
          </div>
        </div>

        <!-- Reps counter (manual mode) -->
        <div v-else-if="store.currentStep?.timer?.unit === 'reps' && !store.inSetRest && !store.inQuickRest" class="reps-display">
          <div class="set-progress-dots" v-if="store.currentStepSets > 1">
            <span
              v-for="n in store.currentStepSets"
              :key="n"
              class="set-dot"
              :class="{ 'is-done': n < store.currentSetInStep, 'is-current': n === store.currentSetInStep }"
            />
          </div>
          <div class="reps-number">{{ store.currentStep.timer.value }}</div>
          <div class="reps-label">次 · 第 {{ store.currentSetInStep }}/{{ store.currentStepSets }} 组</div>
          <button class="manual-next-btn" @click="handleManualNext">
            <i class="bi bi-chevron-right"></i>
            <span>完成本组</span>
          </button>
        </div>
      </div>

      <!-- 详细动作信息：器械 / 肌群 / 配重 / 注意事项 + 文字指引 -->
      <div v-if="stepDetails && !isResting" class="detail-section">
        <!-- 元数据 chips -->
        <div class="detail-chips">
          <span v-if="stepDetails.equipment" class="detail-chip detail-chip--equip">
            <i class="bi bi-tools"></i>
            {{ stepDetails.equipment }}
          </span>
          <span v-if="stepDetails.muscleGroup" class="detail-chip detail-chip--muscle">
            <i class="bi bi-bullseye"></i>
            {{ stepDetails.muscleGroup }}
          </span>
          <span v-if="stepDetails.weight" class="detail-chip detail-chip--weight">
            <i class="bi bi-lightning-charge"></i>
            {{ stepDetails.weight }}
          </span>
        </div>

        <!-- 注意事项 -->
        <div v-if="stepDetails.cautions" class="cautions-card">
          <div class="cautions-icon">
            <i class="bi bi-exclamation-triangle-fill"></i>
          </div>
          <span class="cautions-text">{{ stepDetails.cautions }}</span>
        </div>
      </div>

      <!-- Guide content (markdown text) -->
      <div v-if="isMarkdown && guideParagraphs.length > 0 && !isResting" class="guide-section">
        <div class="guide-card clean-card">
          <div class="guide-paragraphs">
            <p v-for="(p, idx) in guideParagraphs" :key="idx" class="guide-p">{{ p }}</p>
          </div>
        </div>
      </div>

      <!-- Video placeholder -->
      <div v-if="isVideo" class="video-placeholder">
        <i class="bi bi-play-circle" style="font-size:48px"></i>
        <span>指导视频</span>
      </div>
    </div>

    <!-- Finished state -->
    <div v-else class="finished-view">
      <div class="finished-icon">
        <i class="bi bi-check-circle-fill" style="font-size:48px"></i>
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
      </div>
      <button class="finish-btn" @click="goBackToSports">返回运动</button>
      <button class="share-btn" @click="showShare = true">
        <i class="bi bi-share"></i>
        <span>分享战绩</span>
      </button>
    </div>

    <!-- Workout bottom nav -->
    <WorkoutNav
      v-if="store.workoutState !== 'finished'"
      @terminate="handleTerminate"
      @quick-rest="showQuickRest = true"
      @ai-chat="showAiPanel = true"
    />

    <!-- Confirm exit overlay -->
    <div v-if="showConfirmExit" class="confirm-overlay">
      <div class="confirm-card glass-thick">
        <h3 class="confirm-title">确认退出训练？</h3>
        <p class="confirm-desc">退出后下次进入可恢复本次进度</p>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-btn--cancel" @click="cancelExit">继续训练</button>
          <button class="confirm-btn confirm-btn--danger" @click="confirmExit">确认退出</button>
        </div>
      </div>
    </div>

    <!-- Progress sheet -->
    <WorkoutProgressSheet
      v-if="showProgress"
      @close="showProgress = false"
      @jump="handleJumpStep"
    />

    <!-- Quick rest sheet -->
    <WorkoutQuickRestSheet
      v-if="showQuickRest"
      @select="handleQuickRest"
      @close="showQuickRest = false"
    />

    <!-- AI panel -->
    <WorkoutAiPanel
      v-if="showAiPanel"
      @close="showAiPanel = false"
    />

    <!-- 分享面板 -->
    <ShareSheet
      v-if="showShare && shareContent"
      :content="shareContent"
      @close="showShare = false"
    />
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
.is-resting .ambient-halo--warm { background: rgba(61, 169, 255, 0.08); }
.is-resting .ambient-halo--cool { background: rgba(100, 187, 92, 0.1); }

/* Interrupt mask */
.interrupt-mask {
  position: fixed;
  inset: 0;
  z-index: 350;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  animation: overlay-fade 0.25s ease;
}
.interrupt-card {
  background: rgba(255, 255, 255, 0.95);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  width: 100%;
  max-width: 320px;
  text-align: center;
  animation: card-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.interrupt-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: rgba(255, 102, 51, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto var(--space-3);
  color: var(--color-warm);
  font-size: 28px;
}
.interrupt-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0 0 var(--space-1);
}
.interrupt-desc {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-5);
}
.interrupt-actions {
  display: flex;
  gap: var(--space-2);
}
.interrupt-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.interrupt-btn--ghost {
  background: var(--bg-200);
  color: var(--color-text);
}
.interrupt-btn--primary {
  background: var(--color-warm);
  color: white;
  box-shadow: 0 4px 16px rgba(255, 102, 51, 0.3);
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
.back-btn, .list-btn {
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
  font-size: 18px;
}
.back-btn:active, .list-btn:active { transform: scale(0.9); }

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
.set-badge i { font-size: 13px; }
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

/* Timer ring (thick) */
.timer-ring-wrap {
  position: relative;
  width: 260px;
  height: 260px;
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
.is-resting .ring-progress { stroke: #3da9ff; }
.timer-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.timer-number {
  font-size: 60px;
  font-weight: var(--fw-bold);
  color: var(--color-text);
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.is-resting .timer-number { color: #3da9ff; }
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
  white-space: nowrap;
}
.set-progress-dots {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.set-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-300);
  transition: all 0.3s ease;
}
.set-dot.is-done { background: var(--color-warm); }
.set-dot.is-current {
  background: var(--color-warm);
  transform: scale(1.4);
  box-shadow: 0 0 8px rgba(255, 102, 51, 0.4);
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
.manual-next-btn i { font-size: 24px; }
.manual-next-btn:active {
  transform: scale(0.95);
  box-shadow: 0 4px 12px rgba(255, 102, 51, 0.25);
}

/* Detail section (chips + cautions) */
.detail-section {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.detail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
}
.detail-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
}
.detail-chip i { font-size: 12px; }
.detail-chip--equip {
  background: rgba(10, 89, 247, 0.08);
  color: #0a59f7;
  border-color: rgba(10, 89, 247, 0.15);
}
.detail-chip--muscle {
  background: rgba(172, 73, 245, 0.08);
  color: #8a3bc4;
  border-color: rgba(172, 73, 245, 0.15);
}
.detail-chip--weight {
  background: rgba(255, 102, 51, 0.08);
  color: var(--color-warm);
  border-color: rgba(255, 102, 51, 0.18);
}

.cautions-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: rgba(255, 200, 0, 0.08);
  border: 1px solid rgba(255, 200, 0, 0.2);
  border-radius: var(--radius-md);
}
.cautions-icon {
  color: #d4a000;
  flex-shrink: 0;
  margin-top: 1px;
  font-size: 14px;
}
.cautions-text {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
  flex: 1;
}

/* Guide section */
.guide-section {
  margin-top: var(--space-3);
}
.guide-card {
  padding: var(--space-4) var(--space-5);
}
.guide-paragraphs {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.guide-p {
  font-size: var(--text-md);
  color: var(--color-text-secondary);
  line-height: 1.6;
  margin: 0;
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
  color: var(--color-success, #64bb5c);
  font-size: 48px;
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
.finish-btn:active { transform: scale(0.95); }

.share-btn {
  margin-top: var(--space-3);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  background: var(--bg-50);
  color: var(--color-text);
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-pill);
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}
.share-btn:active {
  transform: scale(0.95);
  background: var(--bg-100);
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
.confirm-btn:active { transform: scale(0.95); }
.confirm-btn--cancel {
  background: var(--bg-200);
  color: var(--color-text);
}
.confirm-btn--danger {
  background: var(--color-danger);
  color: white;
}
</style>
