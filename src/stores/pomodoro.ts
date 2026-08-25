/**
 * 番茄钟域：计时状态机 + 今日专注统计。
 * 计时基于时间戳（endAt），避免 setInterval 漂移；设置持久化在 localStorage。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { pomodoroService } from '@/services/pomodoroService'
import { todayStr } from '@/utils/date'
import type { PomodoroSession, PomodoroSettings } from '@/types'

const SETTINGS_KEY = 'rein.pomodoro.settings.v1'

function loadSettings(): PomodoroSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { focusMin: 25, breakMin: 5, longBreakMin: 15, roundsBeforeLongBreak: 4, ...JSON.parse(raw) }
  } catch {
    /* 忽略损坏的本地设置 */
  }
  return { focusMin: 25, breakMin: 5, longBreakMin: 15, roundsBeforeLongBreak: 4 }
}

type Phase = 'focus' | 'break'

export const usePomodoroStore = defineStore('pomodoro', () => {
  const settings = ref<PomodoroSettings>(loadSettings())
  watch(settings, (s) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)), { deep: true })

  const phase = ref<Phase>('focus')
  const running = ref(false)
  /** 本阶段剩余秒数 */
  const remainingSec = ref(settings.value.focusMin * 60)
  let endAt = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const linkedTodoId = ref<number | null>(null)
  const todaySessions = ref<PomodoroSession[]>([])
  const completedRounds = ref(0)

  async function loadToday(): Promise<void> {
    const t = todayStr()
    todaySessions.value = await pomodoroService.listSessions(t, t)
  }

  function tick(): void {
    remainingSec.value = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    if (remainingSec.value === 0) void finishPhase()
  }

  function start(): void {
    if (running.value || remainingSec.value === 0) return
    endAt = Date.now() + remainingSec.value * 1000
    running.value = true
    timer ??= setInterval(tick, 250)
  }

  function pause(): void {
    if (!running.value) return
    remainingSec.value = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    stopTimer()
  }

  function reset(): void {
    stopTimer()
    phase.value = 'focus'
    remainingSec.value = settings.value.focusMin * 60
  }

  function stopTimer(): void {
    running.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function finishPhase(): Promise<void> {
    stopTimer()
    if (phase.value === 'focus') {
      const now = new Date().toISOString()
      const startedAt = new Date(Date.now() - settings.value.focusMin * 60_000).toISOString()
      await pomodoroService.saveSession({
        todoId: linkedTodoId.value,
        startedAt,
        endedAt: now,
        focusMin: settings.value.focusMin,
        breakMin: 0,
        completed: true,
      })
      completedRounds.value++
      phase.value = 'break'
      const isLong = completedRounds.value % settings.value.roundsBeforeLongBreak === 0
      remainingSec.value = (isLong ? settings.value.longBreakMin : settings.value.breakMin) * 60
      await loadToday()
      start()
    } else {
      phase.value = 'focus'
      remainingSec.value = settings.value.focusMin * 60
    }
  }

  const displayTime = computed(() => {
    const m = Math.floor(remainingSec.value / 60)
    const s = remainingSec.value % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })

  const progress = computed(() => {
    const total =
      (phase.value === 'focus' ? settings.value.focusMin : settings.value.breakMin) * 60
    return total <= 0 ? 0 : 1 - remainingSec.value / total
  })

  const todayFocusMin = computed(() =>
    todaySessions.value.reduce((s, x) => s + x.focusMin, 0),
  )

  return {
    settings,
    phase,
    running,
    remainingSec,
    linkedTodoId,
    todaySessions,
    loadToday,
    start,
    pause,
    reset,
    displayTime,
    progress,
    todayFocusMin,
  }
})
