<script setup lang="ts">
import { computed } from "vue";
import { useWorkoutStore } from "@/stores/workoutStore";
import WorkoutMiniBar from "./WorkoutMiniBar.vue";

const emit = defineEmits<{
  (e: "terminate"): void;
  (e: "quick-rest"): void;
  (e: "ai-chat"): void;
}>();

const store = useWorkoutStore();

const isPaused = computed(() => store.workoutState === "paused");
const isRunning = computed(() => store.workoutState === "running");
const canGoPrev = computed(() => store.currentStepIndex > 0);
const canGoNext = computed(() => !store.isLastStep);

function togglePause() {
  if (isRunning.value) {
    store.pause();
  } else if (isPaused.value) {
    store.resume();
  }
}

function handleStop() {
  emit("terminate");
}

function handlePrev() {
  store.previousStep();
  store.resume();
}

function handleNext() {
  store.nextStep();
  if (store.workoutState !== "finished") {
    store.resume();
  }
}
</script>

<template>
  <div class="workout-nav-wrap safe-area-bottom">
    <div class="workout-nav" :class="{ 'is-paused': isPaused }">
      <!-- Layout A: Running (left-right) -->
      <template v-if="!isPaused">
        <button class="pause-btn" @click="togglePause" aria-label="暂停">
          <span class="pause-glow" />
          <i class="bi bi-pause-fill" style="font-size:22px"></i>
        </button>
        <WorkoutMiniBar :expanded="false" class="nav-minibar" />
        <button class="icon-action-btn" @click="$emit('quick-rest')" aria-label="小休息">
          <i class="bi bi-sun" style="font-size:18px"></i>
        </button>
        <button class="icon-action-btn icon-action-btn--ai" @click="$emit('ai-chat')" aria-label="和 AI 聊聊">
          <i class="bi bi-chat-dots" style="font-size:18px"></i>
        </button>
      </template>

      <!-- Layout B: Paused (top-bottom) -->
      <template v-else>
        <WorkoutMiniBar :expanded="true" class="nav-minibar nav-minibar--expanded" />
        <div class="control-tabs">
          <button class="ctrl-btn ctrl-btn--danger" @click="handleStop" aria-label="终止运动">
            <i class="bi bi-stop-fill" style="font-size:22px"></i>
            <span class="ctrl-label">终止</span>
          </button>
          <button class="ctrl-btn" :disabled="!canGoPrev" @click="handlePrev" aria-label="上一组">
            <i class="bi bi-chevron-left" style="font-size:22px"></i>
            <span class="ctrl-label">上一组</span>
          </button>
          <button class="ctrl-btn ctrl-btn--primary" @click="togglePause" aria-label="继续运动">
            <i class="bi bi-play-fill" style="font-size:22px"></i>
            <span class="ctrl-label">继续</span>
          </button>
          <button class="ctrl-btn" :disabled="!canGoNext" @click="handleNext" aria-label="下一组">
            <i class="bi bi-chevron-right" style="font-size:22px"></i>
            <span class="ctrl-label">下一组</span>
          </button>
          <button class="ctrl-btn" @click="$emit('ai-chat')" aria-label="和 AI 聊聊">
            <i class="bi bi-chat-dots" style="font-size:20px"></i>
            <span class="ctrl-label">AI 助手</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.workout-nav-wrap {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding: 0 var(--space-3) calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
  pointer-events: none;
}

.workout-nav {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  transition: all 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Running: horizontal row */
.workout-nav:not(.is-paused) {
  flex-direction: row;
  width: 100%;
  max-width: 420px;
}

/* Paused: vertical stack */
.workout-nav.is-paused {
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  max-width: 440px;
}

/* Pause button (running state) */
.pause-btn {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.78);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.55);
  color: var(--color-warm);
  box-shadow: 0 8px 32px rgba(255, 102, 51, 0.2), 0 2px 8px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  isolation: isolate;
  overflow: hidden;
}

.pause-btn:active {
  transform: scale(0.92);
}

.pause-glow {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 40%, rgba(255, 102, 51, 0.25), transparent 60%);
  animation: pause-breath 2s ease-in-out infinite;
  z-index: -1;
}

@keyframes pause-breath {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.05); }
}

/* Minibar sizing */
.nav-minibar {
  flex: 1;
  min-width: 0;
}

.nav-minibar--expanded {
  width: 100%;
}

/* Icon action buttons (quick rest / AI) — running state */
.icon-action-btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.78);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.55);
  color: var(--color-text-secondary);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  flex-shrink: 0;
  transition: transform 0.2s ease, color 0.2s ease;
}
.icon-action-btn:active { transform: scale(0.9); }
.icon-action-btn--ai {
  color: white;
  background: linear-gradient(135deg, var(--color-warm), #ff8a5a);
  border-color: rgba(255, 138, 90, 0.4);
  box-shadow: 0 8px 32px rgba(255, 102, 51, 0.28), 0 2px 8px rgba(255, 102, 51, 0.16);
}

/* Control tabs row (paused state) */
.control-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  width: 100%;
  padding: 6px;
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-pill);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
  animation: tabs-slide-up 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes tabs-slide-up {
  from { opacity: 0; transform: translateY(12px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.ctrl-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  height: 56px;
  border: none;
  border-radius: calc(var(--radius-pill) - 8px);
  background: transparent;
  color: var(--bg-600);
  cursor: pointer;
  transition: all 0.2s ease;
  -webkit-tap-highlight-color: transparent;
}

.ctrl-btn:active {
  transform: scale(0.9);
}

.ctrl-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.ctrl-label {
  font-size: 10px;
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

.ctrl-btn--danger {
  color: var(--color-danger);
}

.ctrl-btn--primary {
  color: white;
  background: var(--color-warm);
  box-shadow: 0 4px 16px rgba(255, 102, 51, 0.35);
}

.ctrl-btn--primary .ctrl-label {
  color: white;
}

.ctrl-btn--primary:active {
  box-shadow: 0 2px 8px rgba(255, 102, 51, 0.25);
}

/* When paused, animate the nav items morphing */
.workout-nav.is-paused .nav-minibar {
  animation: bar-expand 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes bar-expand {
  from { transform: scaleX(0.9); opacity: 0.8; }
  to { transform: scaleX(1); opacity: 1; }
}

@media (min-width: 768px) {
  .workout-nav:not(.is-paused) { max-width: 380px; }
  .workout-nav.is-paused { max-width: 400px; }
}
</style>
