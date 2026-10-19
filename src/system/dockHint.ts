import { ref } from 'vue'

import { todayStr } from '@/utils/date'

/**
 * 底栏左键「长按可自定义」引导气泡的可见性单例（界面级偏好，走 localStorage）。
 *
 * 两个跨会话状态：
 *   · dismissed —— 用户点过「不再提醒」，永久不再出现；
 *   · lastShown —— 最近一次弹出的日期（YYYY-MM-DD），用于「每天只提示一次」。
 *
 * 触发与频率的判据放在调用处（见 TabBar）：每天首次点按左钮即弹出并记账，
 * 20s 自动收起不改记账 —— 弹出即算「今天已提示」，当天不再打扰。
 * 与功能开关同属界面级偏好，走 localStorage，不进 SQLite。
 */
const KEY = 'rein.dockHint.v1'

interface State {
  dismissed: boolean
  lastShown: string
}

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<State> | null
      return {
        dismissed: p?.dismissed === true,
        lastShown: typeof p?.lastShown === 'string' ? p.lastShown : '',
      }
    }
  } catch {
    /* 本地存储不可用 → 当作从未提示 */
  }
  return { dismissed: false, lastShown: '' }
}

const initial = load()

/** 用户是否已点过「不再提醒」（永久关闭） */
export const dockHintDismissed = ref(initial.dismissed)

let lastShown = initial.lastShown

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ dismissed: dockHintDismissed.value, lastShown }))
  } catch {
    /* 存不下就只留内存态 */
  }
}

/** 今天是否已提示过（「每天一次」的门槛） */
export function dockHintShownToday(): boolean {
  return lastShown === todayStr()
}

/** 记一次「今天已提示」 */
export function markDockHintShown(): void {
  lastShown = todayStr()
  persist()
}

/** 用户点「不再提醒」：永久关闭 */
export function dismissDockHint(): void {
  dockHintDismissed.value = true
  persist()
}
