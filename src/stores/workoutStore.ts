import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { WorkoutPlan, WorkoutState, StepSubState, WorkoutStep, WorkoutSnapshot } from "@/types/workout";
import { StepType, QUICK_REST_PRESETS } from "@/types/workout";
import type { WorkoutRecordStep } from "@/types/workout-stats";
import { getTrainingSetCount } from "@/data/workoutBuilder";
import { courseToWorkoutPlan } from "@/data/courseToWorkout";
import type { Course } from "@/types/course";
import { useWorkoutStatsStore } from "@/stores/workoutStatsStore";
import { useCourseStore } from "@/stores/courseStore";
import { readJSON, writeJSON, deleteJSON } from "@/composables/useStorage";

const SNAPSHOT_KEY = "workout-snapshot";

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
  /** 是否处于小休息（quick rest，独立于组间休息） */
  const inQuickRest = ref(false);
  /** 小休息剩余秒数 */
  const quickRestRemaining = ref(0);
  /** 小休息总秒数（用于环形进度计算） */
  const quickRestTotal = ref(0);

  /** 当前训练对应的课程（用于记录写入与统计） */
  const activeCourse = ref<Course | null>(null);
  const startedAt = ref<number>(0);
  /** 心率采样（用于统计 avg/max） */
  const heartRateSamples = ref<number[]>([]);

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let carouselInterval: ReturnType<typeof setInterval> | null = null;
  let hrSimulateInterval: ReturnType<typeof setInterval> | null = null;
  /** 自动持久化快照的 watcher 卸载函数 */
  let snapshotWatchStop: (() => void) | null = null;
  /** 上次持久化快照时间戳 — 用于节流（10s 一次，重要状态变更强制写入） */
  let lastPersistAt = 0;

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
  const formattedQuickRest = computed(() => formatTime(quickRestRemaining.value));
  const stepProgress = computed(() => {
    if (!currentStep.value?.timer?.enabled) return 0;
    const total = currentStep.value.timer.value;
    if (total <= 0) return 0;
    return 1 - stepSecondsRemaining.value / total;
  });

  /** 小休息环形进度（0..1） */
  const quickRestProgress = computed(() => {
    if (!inQuickRest.value || quickRestTotal.value <= 0) return 0;
    return 1 - quickRestRemaining.value / quickRestTotal.value;
  });

  const phaseColor = computed(() => {
    if (inQuickRest.value) return { bg: "rgba(124,108,247,0.15)", text: "#7c6cf7" };
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

  /**
   * 构造 AI 上下文摘要 — 供 workout-mode AI 聊天作为系统提示注入。
   */
  const aiContextSummary = computed(() => {
    if (!plan.value) return null;
    const step = currentStep.value;
    const lines: string[] = [];
    lines.push(`课程：${plan.value.name}（难度 ${plan.value.level}）`);
    lines.push(`总组数：${totalSets.value}，已完成：${completedSets.value}`);
    lines.push(`总时长：${formattedTime.value}，消耗：${Math.round(caloriesBurned.value)} kcal`);
    if (step) {
      lines.push(`当前步骤 ${currentStepIndex.value + 1}/${plan.value.steps.length}：${step.details.title}`);
      lines.push(`阶段：${step.phase}`);
      if (step.details.equipment) lines.push(`器械：${step.details.equipment}`);
      if (step.details.muscleGroup) lines.push(`目标肌群：${step.details.muscleGroup}`);
      if (step.details.weight) lines.push(`配重：${step.details.weight}`);
      if (inSetRest.value) lines.push(`状态：组间休息中`);
      else if (inQuickRest.value) lines.push(`状态：小休息中（剩余 ${quickRestRemaining.value}s）`);
      else lines.push(`状态：第 ${currentSetInStep.value}/${step.sets ?? 1} 组`);
    }
    if (heartRate.value) lines.push(`心率：${heartRate.value} BPM`);
    return lines.join("\n");
  });

  function startWorkout(workoutPlan: WorkoutPlan) {
    reset();
    plan.value = workoutPlan;
    currentStepIndex.value = 0;
    workoutState.value = "running";
    subState.value = currentStep.value?.type === StepType.RESTING ? "resting" : "exercising";
    startedAt.value = Date.now();
    // 心率模拟初值（仅在首次启动时设置，resume 不重置以免覆盖已采集样本）
    heartRateConnected.value = true;
    heartRate.value = 72;
    heartRateSamples.value = [72];
    initStep();
    startTimer();
    startCarousel();
    startHeartRateSimulation();
    void persistSnapshot(true);
  }

  /** 从 Course 启动训练 */
  function startCourse(course: Course) {
    activeCourse.value = course;
    const wp = courseToWorkoutPlan(course);
    startWorkout(wp);
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

      // 小休息倒计时（优先级最高，独立于组间休息）
      if (inQuickRest.value) {
        quickRestRemaining.value--;
        if (heartRate.value) {
          caloriesBurned.value += calculateCalorieIncrement(heartRate.value);
        }
        if (quickRestRemaining.value <= 0) {
          exitQuickRest();
        }
        void persistSnapshot();
        return;
      }

      // 组间休息倒计时（同一步内）
      if (inSetRest.value) {
        stepSecondsRemaining.value--;
        if (heartRate.value) {
          caloriesBurned.value += calculateCalorieIncrement(heartRate.value);
        }
        if (stepSecondsRemaining.value <= 0) {
          exitSetRest();
        }
        void persistSnapshot();
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
      void persistSnapshot();
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
      if (workoutState.value !== "running") return;
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
    hrSimulateInterval = setInterval(() => {
      // 暂停或页面隐藏时不采样，减少后台开销/发热
      if (workoutState.value !== "running") return;
      if (typeof document !== "undefined" && document.hidden) return;
      const base = subState.value === "resting" ? 80 : 130;
      const variance = Math.floor(Math.random() * 20) - 10;
      const next = Math.max(60, Math.min(190, base + variance + Math.floor(totalElapsedSeconds.value / 60)));
      heartRate.value = next;
      heartRateSamples.value.push(next);
      // 限制采样数组长度，避免快照无限增长
      if (heartRateSamples.value.length > 60) {
        heartRateSamples.value = heartRateSamples.value.slice(-60);
      }
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
    // 暂停时停掉所有定时器，避免后台空转/发热/重渲染
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    void persistSnapshot(true);
  }

  function resume() {
    if (workoutState.value !== "paused" && workoutState.value !== "interrupted") return;
    workoutState.value = "running";
    // 恢复时重启定时器（心率不重置，沿用已采集值）
    startTimer();
    startCarousel();
    startHeartRateSimulation();
    void persistSnapshot(true);
  }

  function advanceStep() {
    if (!plan.value) return;

    // 组间休息中：跳过休息，直接进入下一组
    if (inSetRest.value) {
      exitSetRest();
      return;
    }
    // 小休息中：直接结束小休息
    if (inQuickRest.value) {
      exitQuickRest();
      return;
    }

    const step = currentStep.value;
    if (!step) return;

    if (step.type === StepType.TRAINING) {
      completedSets.value++;
      const totalSetsInStep = step.sets ?? 1;
      if (currentSetInStep.value < totalSetsInStep) {
        if (step.restBetweenSets && step.restBetweenSets > 0) {
          enterSetRest();
        } else {
          currentSetInStep.value++;
          initStepForNextSet();
        }
        void persistSnapshot(true);
        return;
      }
    }

    if (isLastStep.value) {
      finishWorkout();
      return;
    }
    currentStepIndex.value++;
    initStep();
    void persistSnapshot(true);
  }

  /** 进入组间休息 */
  function enterSetRest() {
    inSetRest.value = true;
    subState.value = "resting";
    const step = currentStep.value;
    stepSecondsRemaining.value = step?.restBetweenSets ?? 30;
    void persistSnapshot(true);
  }

  /** 退出组间休息，进入下一组 */
  function exitSetRest() {
    inSetRest.value = false;
    currentSetInStep.value++;
    initStepForNextSet();
    void persistSnapshot(true);
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

  /**
   * 进入小休息（quick rest） — 用户主动触发，预设 30s ~ 2.5min。
   * 与组间休息互斥，进入时若处于组间休息会先结束组间休息。
   */
  function enterQuickRest(seconds: number) {
    if (!QUICK_REST_PRESETS.includes(seconds)) return;
    if (workoutState.value !== "running" && workoutState.value !== "paused") return;
    if (inSetRest.value) {
      // 小休息优先于组间休息
      inSetRest.value = false;
      currentSetInStep.value++;
      initStepForNextSet();
    }
    inQuickRest.value = true;
    quickRestTotal.value = seconds;
    quickRestRemaining.value = seconds;
    subState.value = "resting";
    workoutState.value = "running"; // 确保计时器走动
    void persistSnapshot(true);
  }

  /** 提前结束小休息 */
  function exitQuickRest() {
    inQuickRest.value = false;
    quickRestRemaining.value = 0;
    quickRestTotal.value = 0;
    subState.value = currentStep.value?.type === StepType.RESTING ? "resting" : "exercising";
    void persistSnapshot(true);
  }

  function previousStep() {
    if (currentSetInStep.value > 1 || inSetRest.value) {
      if (inSetRest.value) {
        exitSetRestBack();
      } else {
        currentSetInStep.value--;
        if (completedSets.value > 0) completedSets.value--;
        initStepForNextSet();
      }
      void persistSnapshot(true);
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
    void persistSnapshot(true);
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

  /** 跳过当前步（AI 调用 / 用户操作） */
  function skipCurrentStep() {
    if (inQuickRest.value) {
      exitQuickRest();
      return;
    }
    if (inSetRest.value) {
      exitSetRest();
      return;
    }
    advanceStep();
  }

  /**
   * 临时调整当前步（仅本次训练有效，不写回 courseStore）。
   * @param patch 可改 sets / reps / durationSec / restSec
   */
  function adjustCurrentStepTemp(patch: {
    sets?: number;
    reps?: number;
    durationSec?: number;
    restSec?: number;
  }): void {
    const step = currentStep.value;
    if (!step) return;
    if (patch.sets != null && patch.sets > 0) step.sets = patch.sets;
    if (patch.reps != null && patch.reps > 0) step.timer.value = patch.reps;
    if (patch.durationSec != null && patch.durationSec > 0) {
      step.timer = { enabled: true, unit: "seconds", value: patch.durationSec };
      if (workoutState.value === "running" && !inSetRest.value && !inQuickRest.value) {
        stepSecondsRemaining.value = patch.durationSec;
      }
    }
    if (patch.restSec != null && patch.restSec >= 0) step.restBetweenSets = patch.restSec;
    void persistSnapshot(true);
  }

  /**
   * 永久调整：把当前步的修改写回 courseStore（影响后续训练）。
   */
  function adjustCoursePermanent(stepIndex: number, patch: {
    sets?: number;
    reps?: number;
    durationSec?: number;
    restSec?: number;
    weight?: string;
    note?: string;
    cautions?: string;
  }): boolean {
    if (!activeCourse.value) return false;
    const courseStore = useCourseStore();
    const course = courseStore.getById(activeCourse.value.id);
    if (!course) return false;
    const cs = course.steps[stepIndex];
    if (!cs) return false;
    const stepPatch: Partial<typeof cs> = {};
    if (patch.sets != null && patch.sets > 0) stepPatch.sets = patch.sets;
    if (patch.reps != null && patch.reps > 0) stepPatch.reps = patch.reps;
    if (patch.durationSec != null && patch.durationSec > 0) stepPatch.durationSec = patch.durationSec;
    if (patch.restSec != null && patch.restSec >= 0) stepPatch.restSec = patch.restSec;
    if (typeof patch.weight === "string") stepPatch.weight = patch.weight;
    if (typeof patch.note === "string") stepPatch.note = patch.note;
    if (typeof patch.cautions === "string") stepPatch.cautions = patch.cautions;
    Object.assign(cs, stepPatch);
    courseStore.updateCourse(course.id, { steps: [...course.steps] });
    // 同步刷新 activeCourse + plan
    activeCourse.value = course;
    plan.value = courseToWorkoutPlan(course);
    void persistSnapshot(true);
    return true;
  }

  function finishWorkout() {
    workoutState.value = "finished";
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    writeRecord(true);
    void clearSnapshot();
  }

  function terminateWorkout() {
    workoutState.value = "finished";
    stopTimer();
    stopCarousel();
    stopHeartRateSimulation();
    writeRecord(false);
    void clearSnapshot();
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
      steps: buildRecordSteps(finished),
    });
    courseStore.markPracticed(activeCourse.value.id);
  }

  /**
   * 构造本次训练实际执行的步骤快照（仅 TRAINING 步）。
   * per-step 完成组数估算：
   *   - 已跳过的步（index < currentStepIndex）：全完成
   *   - 当前步：finished 全完成；组间休息中 = currentSetInStep（刚完成该组）；
   *     否则 = currentSetInStep - 1（当前组进行中未计入）
   *   - 未开始的步：0
   */
  function buildRecordSteps(finished: boolean): WorkoutRecordStep[] {
    if (!plan.value) return [];
    const curIdx = currentStepIndex.value;
    const steps: WorkoutRecordStep[] = [];
    for (let i = 0; i < plan.value.steps.length; i++) {
      const s = plan.value.steps[i];
      if (s.type !== StepType.TRAINING) continue;
      const sets = s.sets ?? 1;
      let completed: number;
      if (i < curIdx) {
        completed = sets;
      } else if (i === curIdx) {
        if (finished) {
          completed = sets;
        } else if (inSetRest.value) {
          completed = Math.min(currentSetInStep.value, sets);
        } else {
          completed = Math.max(0, currentSetInStep.value - 1);
        }
      } else {
        completed = 0;
      }
      steps.push({
        exerciseId: undefined,
        exerciseName: s.details.title,
        sets,
        reps: s.timer.unit === "reps" ? s.timer.value : undefined,
        durationSec: s.timer.unit === "seconds" ? s.timer.value : undefined,
        weight: s.details.weight,
        restBetweenSets: s.restBetweenSets,
        completedSets: completed,
      });
    }
    return steps;
  }

  // ===== Snapshot / Resume =====

  /** 构造当前运行时快照 */
  function snapshot(): WorkoutSnapshot | null {
    if (!plan.value) return null;
    return {
      savedAt: Date.now(),
      startedAt: startedAt.value,
      courseId: activeCourse.value?.id ?? "",
      planName: plan.value.name,
      planLevel: plan.value.level,
      plan: plan.value,
      currentStepIndex: currentStepIndex.value,
      workoutState: workoutState.value,
      subState: subState.value,
      stepSecondsRemaining: stepSecondsRemaining.value,
      totalElapsedSeconds: totalElapsedSeconds.value,
      caloriesBurned: caloriesBurned.value,
      heartRate: heartRate.value,
      heartRateConnected: heartRateConnected.value,
      phaseCarouselIndex: phaseCarouselIndex.value,
      completedSets: completedSets.value,
      currentSetInStep: currentSetInStep.value,
      inSetRest: inSetRest.value,
      inQuickRest: inQuickRest.value,
      quickRestRemaining: quickRestRemaining.value,
      // 快照中限制心率采样为最近 60 条，避免无限增长
      heartRateSamples: heartRateSamples.value.slice(-60),
    };
  }

  /**
   * 持久化快照。
   * @param force 重要状态变更（暂停/恢复/完成/步进/调整）强制写入；默认节流 10s 一次。
   */
  async function persistSnapshot(force = false): Promise<void> {
    if (!force && Date.now() - lastPersistAt < 10000) return;
    const snap = snapshot();
    if (!snap) return;
    await writeJSON(SNAPSHOT_KEY, snap);
    lastPersistAt = Date.now();
  }

  async function clearSnapshot(): Promise<void> {
    await deleteJSON(SNAPSHOT_KEY);
  }

  /**
   * 从快照恢复运行时状态。
   * 仅恢复 plan/state，不立即启动计时器 — 调用方在 UI 确认后再 startTimers()。
   */
  async function restoreFromSnapshot(): Promise<boolean> {
    const snap = await readJSON<WorkoutSnapshot>(SNAPSHOT_KEY);
    if (!snap) return false;
    // 太久的快照视为过期（>24h）
    if (Date.now() - snap.savedAt > 24 * 3600_000) {
      await clearSnapshot();
      return false;
    }
    // 尝试拉回 Course 对象
    let course: Course | null = null;
    if (snap.courseId) {
      const courseStore = useCourseStore();
      course = courseStore.getById(snap.courseId) ?? null;
    }
    activeCourse.value = course;
    plan.value = snap.plan;
    startedAt.value = snap.startedAt;
    currentStepIndex.value = snap.currentStepIndex;
    workoutState.value = "interrupted";
    subState.value = snap.subState;
    stepSecondsRemaining.value = snap.stepSecondsRemaining;
    totalElapsedSeconds.value = snap.totalElapsedSeconds;
    caloriesBurned.value = snap.caloriesBurned;
    heartRate.value = snap.heartRate;
    heartRateConnected.value = snap.heartRateConnected;
    phaseCarouselIndex.value = snap.phaseCarouselIndex;
    completedSets.value = snap.completedSets;
    currentSetInStep.value = snap.currentSetInStep;
    inSetRest.value = snap.inSetRest;
    inQuickRest.value = false; // 重启后不恢复小休息
    quickRestRemaining.value = 0;
    heartRateSamples.value = snap.heartRateSamples ?? [];
    return true;
  }

  /** 用户确认从打断状态恢复 — 启动计时器并置 running */
  function resumeFromInterrupted(): void {
    if (workoutState.value !== "interrupted") return;
    workoutState.value = "running";
    startTimer();
    startCarousel();
    startHeartRateSimulation();
    void persistSnapshot(true);
  }

  /** 用户放弃恢复 — 直接退出 */
  function discardInterrupted(): void {
    void clearSnapshot();
    reset();
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
    inQuickRest.value = false;
    quickRestRemaining.value = 0;
    quickRestTotal.value = 0;
  }

  return {
    // state
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
    inQuickRest,
    quickRestRemaining,
    quickRestTotal,
    heartRateSamples,
    // computed
    totalSets,
    currentStepSets,
    currentStep,
    currentTrainingSetNumber,
    isLastStep,
    formattedTime,
    formattedStepTime,
    formattedQuickRest,
    stepProgress,
    quickRestProgress,
    phaseColor,
    aiContextSummary,
    // actions
    startWorkout,
    startCourse,
    pause,
    resume,
    previousStep,
    nextStep,
    advanceStep,
    skipCurrentStep,
    enterQuickRest,
    exitQuickRest,
    adjustCurrentStepTemp,
    adjustCoursePermanent,
    finishWorkout,
    terminateWorkout,
    reset,
    // snapshot
    snapshot,
    persistSnapshot,
    clearSnapshot,
    restoreFromSnapshot,
    resumeFromInterrupted,
    discardInterrupted,
  };
});
