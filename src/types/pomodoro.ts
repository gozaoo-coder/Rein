/** 番茄钟阶段 */
export type PomodoroPhase = "idle" | "focus" | "rest" | "done";

/** 番茄钟配置 */
export interface PomodoroConfig {
  /** 专注时长（分钟），最小 23 */
  focusMin: number;
  /** 休息时长（分钟），最小 5 */
  restMin: number;
  /** 目标番茄数 */
  targetCount: number;
}

/** 番茄钟快照（供 AI 工具读取） */
export interface PomodoroSnapshot {
  phase: PomodoroPhase;
  remainingSec: number;
  totalSec: number;
  running: boolean;
  completedCount: number;
  targetCount: number;
  focusTodoId: string | null;
  config: PomodoroConfig;
}
