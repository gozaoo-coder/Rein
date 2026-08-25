/** 番茄钟域类型 · 与 Rust `modules/pomodoro` 对应 */

export interface PomodoroSettings {
  focusMin: number
  breakMin: number
  longBreakMin: number
  roundsBeforeLongBreak: number
}

export interface PomodoroSession {
  id: number
  todoId: number | null
  startedAt: string
  endedAt: string
  focusMin: number
  breakMin: number
  completed: boolean
}

export interface PomodoroSessionInput {
  todoId: number | null
  startedAt: string
  endedAt: string
  focusMin: number
  breakMin: number
  completed: boolean
}
