import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { WorkoutPlan, WorkoutState, StepSubState, WorkoutStep } from "@/types/workout";
import { StepType } from "@/types/workout";
import { getTrainingSetCount } from "@/data/workoutBuilder";
import { courseToWorkoutPlan } from "@/data/courseToWorkout";
import type { Course } from "@/types/course";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useCourseStore } from "@/stores/courseStore";

export const useWorkoutStore = defineStore("workout", () => {
  const plan = ref<WorkoutPlan | null>(null);
  const currentStepIndex = ref(0);
  const workoutState = ref<WorkoutState>("idle");
  const subState = ref<StepSubState>("exercising");
  const stepSecondsRemaining = ref(0);
  const totalElapsedSeconds = ref(0);
  const caloriesBurned = ref(0);
  const heartRate = ref<number | null>(null);
  const heartRateConnected = ref(false);
  const phaseCarouselIndex = ref(0);
  const completedSets = ref(0);
  /** 当前步内第几组（1-indexed） */
  const currentSetInStep = ref(1);
  /** 是否处于组间休息（同一步内） */
  const inSetRest = ref(false);

  /** 当前训练对应的课程（用于记录写入与统计） */
  const activeCourse = ref<Course | null>(null);
  const startedAt = ref<number>(0);
  /** 心率采样（用于统计 avg/max） */
  const heartRateSamples = ref<number[]>([]);

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let carouselInterval: ReturnType<typeof setInterval> | null = null;
  let hrSimulateInterval: ReturnType<typeof setInterval> | null = null;

  const totalSets = computed(() => {
    if (!plan.value) return 0;
    return plan.value.steps
      .filter((s) => s.type === StepType.TRAINING)
      .reduce((sum, s) => sum + (s.sets ?? 1), 0);
  });

  /** 当前训练步的总组数 */
  const currentStepSets = computed(() => currentStep.value?.sets ?? 1);

  const currentStep = computed<WorkoutStep | null>(() => {
    if (!plan.value) return null;
    return plan.value.steps[currentStepIndex.value] ?? null;
  });

  const currentTrainingSetNumber = computed(() => {
    if (!plan.value) return 0;
    let count = 0;
    for (let i = 0; i < currentStepIndex.value; i++) {
      const s = plan.value.steps[i];
      if (s.type === StepType.TRAINING) count += s.sets ?? 1;
    }
    if (currentStep.value?.type === StepType.TRAINING) {
      count += currentSetInStep.value;
    }
    return count;
  });

  const isLastStep = computed(() => {
    if (!plan.value) return false;
    return currentStepIndex.value >= plan.value.steps.length - 1;
  });

  const formattedTime = computed(() => formatTime(totalElapsedSeconds.value));
  const formattedStepTime = computed(() => formatTime(stepSecondsRemaining.value));
  const stepProgress = computed(() => {
    if (!currentStep.value?.timer?.enabled) return 0;
    const total = currentStep.value.timer.value;
    if (total <= 0) return 0;
    return 1 - stepSecondsRemaining.value / total;
  });

  const phaseColor = computed(() => {
    const p = currentStep.value?.phase ?? "";
    if (p.includes("热身")) return { bg: "rgba(100,187,92,0.15)", text: "#4a9c43" };
    if (p.includes("充血")) return { bg: "rgba(255,140,58,0.15)", text: "#e8502c" };
    if (p.includes("极限")) return { bg: "rgba(232,64,38,0.15)", text: "#e84026" };
    if (p.includes("力量")) return { bg: "rgba(172,73,245,0.15)", text: "#8a3bc4" };
    if (p.includes("休息")) return { bg: "rgba(61,169,255,0.15)", text: "#3da9ff" };
    if (p.includes("拉伸")) return { bg: "rgba(124,108,247,0.15)", text: "#7c6cf7" };
    return { bg: "rgba(10,89,247,0.1)", text: "var(--color-primary)" };
  });

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  function startWorkout(workoutPlan: WorkoutPlan) {
    reset();
    plan.value = workoutPlan;
    currentStepIndex.value = 0;
    workoutState.value = "running";
    subState.value = currentStep.value?.type === StepType.RESTING ? "resting" : "exercising";
    startedAt.value = Date.now();
    initStep();
    startTimer();
    startCarousel();
    startHeartRateSimulation();
  }

  /** 从 Course 启动训练 */
  function startCourse(course: Course) {
    activeCourse.value = course;
    const plan = courseToWorkoutPlan(course);
    startWorkout(plan);
  }

  function initStep() {
    const step = currentStep.value;
    if (!step) return;
    currentSetInStep.value = 1;
    inSetRest.value = false;
    if (step.timer.enabled && step.timer.unit === "seconds") {
      stepSecondsRemaining.value = step.timer.value;
    } else {
      stepSecondsRemaining.value = 0;
    }
    subState.value = step.type === StepType.RESTING ? "resting" : "exercising";
  }

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(() => {
      if (workoutState.value !== "running") return;
      totalElapsedSeconds.value++;

      // 组间休息倒计时（同一步内）
      if (inSetRest.value) {
        stepSecondsRemaining.value--;
        if (heartRate.value) {
          caloriesBurned.value += calculateCalorieIncrement(heartRate.value);
        }
        if (stepSecondsRemaining.value <= 0) {
          exitSetRest();
        }
        return;
      }

      const step = currentStep.value;
      if (step?.timer.enabled && step.timer.unit === "seconds") {
        stepSecondsRemaining.value--;
        if (heartRate.value) {
          caloriesBurned.value += calculateCalorieIncrement(heartRate.value);
        }
        if (stepSecondsRemaining.value <= 0) {
          advanceStep();
        }
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function startCarousel() {
    stopCarousel();
    carouselInterval = setInterval(() => {
      phaseCarouselIndex.value++;
    }, 3000);
  }

  function stopCarousel() {
    if (carouselInterval) {
      clearInterval(carouselInterval);
      carouselInterval = null;
    }
  }

  function startHeartRateSimulation() {
    stopHeartRateSimulation();
    heartRateConnected.value = true;
    heartRate.value = 72;
    heartRateSamples.value = [72];
    hrSimulateInterval = setInterval(() => {
      if (workoutState.value !== "running") return;
      const base = subState.value === "resting" ? 80 : 130;
      const variance = Math.floor(Math.random() * 20) - 10;
      const next = Math.max(60, Math.min(190, base + variance + Math.floor(totalElapsedSeconds.value / 60)));
      heartRate.value = next;
      heartRateSamples.value.push(next);
    }, 2000);
  }

  function stopHeartRateSimulation() {
    if (hrSimulateInterval) {
      clearInterval(hrSimulateInterval);
      hrSimulateInterval = null;
    }
  }

  function calculateCalorieIncrement(hr: number): number {
    const factor = hr > 150 ? 0.15 : hr > 120 ? 0.1 : 0.06;
    return Math.round(factor * 100) / 100;
  }

  function pause() {
    if (workoutState.value !== "running") return;
    workoutState.value = "paused";
  }

  function resume() {
    if (workoutState.value !== "paused") return;
    workoutState.value = "running";
  }

  function advanceStep() {
    if (!plan.value) return;

    // 组间休息中：跳过休息，直接进入下一组
    if (inSetRest.value) {
      exitSetRest();
      return;
    }

    const step = currentStep.value;
    if (!step) return;

    if (step.type === StepType.TRAINING) {
      completedSets.value++;
      // 多组逻辑：当前步还有剩余组数
      const totalSetsInStep = step.sets ?? 1;
      if (currentSetInStep.value < totalSetsInStep) {
        // 组间休息
        if (step.restBetweenSets && step.restBetweenSets > 0) {
          enterSetRest();
        } else {
          currentSetInStep.value++;
          initStepForNextSet();
        }
        return;
      }
    }

    // 所有组数完成，进入下一步
    if (isLastStep.value) {
      finishWorkout();
      return;
    }
    currentStepIndex.value++;
    initStep();
  }

  /** 进入组间休息 */
  function enterSetRest() {
    inSetRest.value = true;
    subState.value = "resting";
    const step = currentStep.value;
    stepSecondsRemaining.value = step?.restBetweenSets ?? 30;
  }

  /** 退出组间休息，进入下一组 */
  function exitSetRest() {
    inSetRest.value = false;
    currentSetInStep.value++;
    initStepForNextSet();
  }

  /** 重置当前步计时但保留组号 */
  function initStepForNextSet() {
    const step = currentStep.value;
    if (!step) return;
    if (step.timer.enabled && step.timer.unit === "seconds") {
      stepSecondsRemaining.value = step.timer.value;
    } else {
      stepSecondsRemaining.value = 0;
    }
    subState.value = "exercising";
  }

  function previousStep() {
    // 先尝试在同一步内回退
    if (currentSetInStep.value > 1 || inSetRest.value) {
      if (inSetRest.value) {
        exitSetRestBack();
      } else {
        currentSetInStep.value--;
        if (completedSets.value > 0) completedSets.value--;
        initStepForNextSet();
      }
      return;
    }
    if (currentStepIndex.value > 0) {
      currentStepIndex.value--;
      const prevStep = currentStep.value;
      if (prevStep?.type === StepType.TRAINING) {
        const prevSets = prevStep.sets ?? 1;
        currentSetInStep.value = prevSets;
        completedSets.value = Math.max(0, completedSets.value - 1);
      }
      initStepForNextSet();
    }
  }

  /** 从组间休息回退到上一组 */
  function exitSetRestBack() {
    inSetRest.value = false;
    subState.value = "exercising";
    const step = currentStep.value;
    if (step?.timer.enabled && step.timer.unit === "seconds") {
      stepSecondsRemaining.value = step.timer.value;
    } else {
      stepSecondsRemaining.value = 0;
    }
  }

  function nextStep() {
    advanceStep();
  }

  function finishWorkout() {
    workoutState.value = "finished";
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    writeRecord(true);
  }

  function terminateWorkout() {
    workoutState.value = "finished";
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    writeRecord(false);
  }

  /** 写入运动记录到统计 store */
  function writeRecord(finished: boolean) {
    if (!activeCourse.value) return;
    const statsStore = useWorkoutStatsStore();
    const courseStore = useCourseStore();
    const samples = heartRateSamples.value;
    const avg = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : undefined;
    const max = samples.length ? Math.max(...samples) : undefined;
    statsStore.recordSession(activeCourse.value, {
      durationSec: totalElapsedSeconds.value,
      caloriesBurned: caloriesBurned.value,
      completedSets: completedSets.value,
      totalSets: totalSets.value,
      avgHeartRate: avg,
      maxHeartRate: max,
      finished,
      startedAt: startedAt.value || Date.now(),
      endedAt: Date.now(),
    });
    courseStore.markPracticed(activeCourse.value.id);
  }

  function reset() {
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    plan.value = null;
    activeCourse.value = null;
    startedAt.value = 0;
    heartRateSamples.value = [];
    currentStepIndex.value = 0;
    workoutState.value = "idle";
    subState.value = "exercising";
    stepSecondsRemaining.value = 0;
    totalElapsedSeconds.value = 0;
    caloriesBurned.value = 0;
    heartRate.value = null;
    heartRateConnected.value = false;
    phaseCarouselIndex.value = 0;
    completedSets.value = 0;
    currentSetInStep.value = 1;
    inSetRest.value = false;
  }

  return {
    plan,
    activeCourse,
    startedAt,
    currentStepIndex,
    workoutState,
    subState,
    stepSecondsRemaining,
    totalElapsedSeconds,
    caloriesBurned,
    heartRate,
    heartRateConnected,
    phaseCarouselIndex,
    completedSets,
    currentSetInStep,
    inSetRest,
    totalSets,
    currentStepSets,
    currentStep,
    currentTrainingSetNumber,
    isLastStep,
    formattedTime,
    formattedStepTime,
    stepProgress,
    phaseColor,
    startWorkout,
    startCourse,
    pause,
    resume,
    previousStep,
    nextStep,
    terminateWorkout,
    reset,
  };
});
