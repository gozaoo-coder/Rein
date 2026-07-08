/**
 * useWorkoutRuntime — 运动模式运行时生命周期管理。
 *
 * 把运动模式下的"计时/过程/当前课程"从 WorkoutPage.vue 抽离成独立模块。
 * 负责：
 *   - 启动时尝试从快照恢复（异常打断后重新进入）
 *   - 卸载时按状态决定持久化快照 vs 清理
 *   - 暴露 resume-interrupted / discard-interrupted 决策给 UI
 *
 * 单一职责：不关心 UI 渲染，只管理 store 生命周期。
 */
import { ref, onMounted, onUnmounted } from "vue";
import { useWorkoutStore } from "@/stores/workoutStore";
import { createSampleWorkout } from "@/data/workoutBuilder";

export function useWorkoutRuntime() {
  const store = useWorkoutStore();

  /** 是否检测到可恢复的快照（进入页面时检测一次） */
  const hasInterrupted = ref(false);
  /** 是否已完成初始化（避免首次进入闪烁） */
  const initialized = ref(false);

  onMounted(async () => {
    // 1. 若 store 已有进行中的训练，直接复用
    if (store.plan && store.workoutState !== "idle" && store.workoutState !== "finished") {
      if (store.workoutState === "interrupted") {
        hasInterrupted.value = true;
      }
      initialized.value = true;
      return;
    }

    // 2. 尝试从快照恢复
    const restored = await store.restoreFromSnapshot();
    if (restored) {
      hasInterrupted.value = true;
      initialized.value = true;
      return;
    }

    // 3. 没有可恢复的训练 — 启动 sample（开发兜底）
    // 生产环境调用方应通过 startCourse() 启动；这里保持向后兼容
    const plan = createSampleWorkout();
    store.startWorkout(plan);
    initialized.value = true;
  });

  onUnmounted(() => {
    // 训练未完成时：保留快照供恢复；已完成则清理
    if (store.workoutState === "finished") {
      store.reset();
    }
    // 其余状态（running/paused/interrupted）保留快照，不 reset
  });

  /** 用户确认从打断状态恢复 */
  function resumeInterrupted(): void {
    store.resumeFromInterrupted();
    hasInterrupted.value = false;
  }

  /** 用户放弃恢复 */
  function discardInterrupted(): void {
    store.discardInterrupted();
    hasInterrupted.value = false;
  }

  return {
    store,
    hasInterrupted,
    initialized,
    resumeInterrupted,
    discardInterrupted,
  };
}
