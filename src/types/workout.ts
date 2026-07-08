export enum StepType {
  TRAINING = "training",
  RESTING = "resting",
}

export enum MediaType {
  VIDEO = "video",
  IMAGE = "image",
  MARKDOWN_TEXT = "markdownText",
}

export type TimerUnit = "seconds" | "reps";

export interface TimerConfig {
  enabled: boolean;
  unit: TimerUnit;
  value: number;
}

export interface Guide {
  type: MediaType;
  content?: string;
  url?: string;
}

export interface StepDetails {
  title: string;
  guide: Guide;
}

export interface WorkoutStep {
  type: StepType;
  phase: string;
  timer: TimerConfig;
  details: StepDetails;
  /** 训练步的组数（默认 1），resting 步忽略 */
  sets?: number;
  /** 同一步内组间休息秒数（默认 0 = 无休息） */
  restBetweenSets?: number;
}

export interface WorkoutPlan {
  name: string;
  level: string;
  steps: WorkoutStep[];
}

export type WorkoutState = "idle" | "running" | "paused" | "finished";
export type StepSubState = "exercising" | "resting";

export interface WorkoutRuntime {
  currentStepIndex: number;
  elapsedSeconds: number;
  stepSecondsRemaining: number;
  totalElapsedSeconds: number;
  caloriesBurned: number;
  heartRate: number | null;
  heartRateConnected: boolean;
  workoutState: WorkoutState;
  subState: StepSubState;
  setCount: number;
  totalSets: number;
}
