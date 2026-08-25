/** 番茄钟域 IPC 封装 · 对应 modules/pomodoro/commands.rs */

import type { PomodoroSession, PomodoroSessionInput } from '@/types'
import { invoke } from './transport'

export const pomodoroService = {
  saveSession: (session: PomodoroSessionInput) =>
    invoke<PomodoroSession>('save_pomodoro_session', { session }),

  listSessions: (startDate: string, endDate: string) =>
    invoke<PomodoroSession[]>('list_pomodoro_sessions', { startDate, endDate }),
}
