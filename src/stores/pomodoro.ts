/**
 * 番茄钟域：计时状态机 + 今日专注统计。
 * 计时基于时间戳（endAt），避免 setInterval 漂移；设置持久化在 localStorage。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { pomodoroService } from '@/services/pomodoroService'
import { gatewayService } from '@/services/gatewayService'
import { todayStr } from '@/utils/date'
import type { FocusRuntime, PomodoroSession, PomodoroSettings } from '@/types'

const SETTINGS_KEY = 'rein.pomodoro.settings.v1'

/** 运行态上报周期（毫秒）：1 秒一次，值没变就不重复写（contract §14.1）。 */
const PUBLISH_INTERVAL_MS = 1000

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

  /* ---------- 运行态上报（contract §14.1） ---------- */

  let publishTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次上报的状态键（不含 `reportedAt`）：与它相同就不重复写。 */
  let publishedKey = ''
  /** 是否已经报过一份还没清的状态（决定要不要发 `focus_unpublish`）。 */
  let published = false

  /** 本轮的休息时长（分钟）：长休息按完成轮次判定，与 `finishPhase` 进入休息时的算法一致。 */
  function breakPlannedMin(): number {
    const isLong =
      completedRounds.value > 0 && completedRounds.value % settings.value.roundsBeforeLongBreak === 0
    return isLong ? settings.value.longBreakMin : settings.value.breakMin
  }

  /** 拼一份对外快照。相位锚点由 endAt 反推：`phaseStartedAt + remainingSec` = 预计结束时刻，
   *  后端的 `recover_focus` 就按这条等式判「关闭期间是否已走完」（contract §14.1）。 */
  function runtimeSnapshot(): FocusRuntime {
    const phaseSec = (phase.value === 'focus' ? settings.value.focusMin : breakPlannedMin()) * 60
    const anchorMs = endAt > 0 ? endAt - remainingSec.value * 1000 : Date.now() - (phaseSec - remainingSec.value) * 1000
    return {
      phase: phase.value,
      running: running.value,
      remainingSec: remainingSec.value,
      plannedFocusMin: settings.value.focusMin,
      plannedBreakMin: breakPlannedMin(),
      phaseStartedAt: new Date(anchorMs).toISOString(),
      linkedTodoId: linkedTodoId.value,
      completedRounds: completedRounds.value,
      reportedAt: new Date().toISOString(),
    }
  }

  /** 上报一份运行态（仅计时中）；状态没变则跳过。失败静默：上报不是用户的动作。 */
  function publishRuntime(): void {
    if (!running.value) return
    const snap = runtimeSnapshot()
    const key = JSON.stringify({ ...snap, reportedAt: '' })
    if (published && key === publishedKey) return
    publishedKey = key
    published = true
    void gatewayService.focusPublish(snap).catch(() => {})
  }

  /** 清掉运行态（暂停 / 复位 / 相位结束）：没报过就不发，避免无谓 IPC。 */
  function clearRuntime(): void {
    if (!published) return
    published = false
    publishedKey = ''
    void gatewayService.focusUnpublish().catch(() => {})
  }

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
    // 起跑立即报一份（不等 1s 周期），外部轮询 status 不必等下一秒才看见
    publishRuntime()
    publishTimer ??= setInterval(publishRuntime, PUBLISH_INTERVAL_MS)
  }

  function pause(): void {
    if (!running.value) return
    remainingSec.value = Math.max(0, Math.round((endAt - Date.now()) / 1000))
    stopTimer()
    clearRuntime() // 暂停：对外不再有「进行中的计时」（contract §14.4）
  }

  function reset(): void {
    stopTimer()
    clearRuntime()
    phase.value = 'focus'
    remainingSec.value = settings.value.focusMin * 60
  }

  function stopTimer(): void {
    running.value = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (publishTimer) {
      clearInterval(publishTimer)
      publishTimer = null
    }
    endAt = 0
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
      // 转入休息：接着 `start()` 会立刻报一份休息态，所以这里不先清（免得白跑一趟 unpublish）
      start()
    } else {
      clearRuntime() // 休息结束：这一轮专注结束，对外回到「没有进行中的计时」
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
