import { ref } from 'vue'

/**
 * 专注沉浸层 · UI 状态单例（system 层，与计时状态机解耦）。
 *
 * 与训练课沉浸层（system/sessionImmersive）同一思路：全屏层不走路由，由本模块驱动
 * 显隐与层级；<html data-focus-immersive> 一置位，壳层（TabBar / 导航轨 / 各悬浮条，
 * 见 base.css）就整体让位，专注浮条也随之收起，不再与全屏层抢视线。
 *
 * 三层模型（对应参考设计的三档）：
 *   · level 0 —— 普通（专注页里的卡片形态）；
 *   · level 1 —— 沉浸：整屏暗场，进度环 + 大读数 + 贴边工具簇，可有 🔒 与退出；
 *   · level 2 —— 完全沉浸：只剩超大读秒数字，底部挂当前关联待办（没有就不挂）。
 *
 * 🔒 强制模式（forced）独立于层级：开启后，专注进行中若窗口退到后台 / 失焦，
 * 强制结束这一段（见 FocusImmersive.vue 的监听），与参考设计「改变窗口状态或退出
 * 前台后强制结束番茄钟」一致；暂停或休息相位不强制，可随意切换。
 */

export type FocusImmersiveLevel = 0 | 1 | 2

/** 当前沉浸层级：0 普通 / 1 沉浸 / 2 完全沉浸 */
export const focusImmersiveLevel = ref<FocusImmersiveLevel>(0)

/** 🔒 强制模式是否开启 */
export const focusForced = ref(false)

/** 「启动强制模式」的说明条是否已被用户关闭（"不再提醒" 记在 localStorage） */
const HINT_KEY = 'rein.focus.forceHint.v1'

function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

export const focusForceHintDismissed = ref(readHintDismissed())

/** 用户点「不再提醒」：永久收起强制模式说明条 */
export function dismissForceHint(): void {
  focusForceHintDismissed.value = true
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    /* localStorage 不可用时只在本次会话内收起 */
  }
}

/** 把层级写到 <html>，让壳层与游离子孙（teleport 到 body 的悬浮件）也能读到 */
function syncShell(): void {
  document.documentElement.dataset.focusImmersive = focusImmersiveLevel.value > 0 ? 'on' : 'off'
}

/** 设置沉浸层级（0 退出 / 1 沉浸 / 2 完全沉浸） */
export function setFocusImmersiveLevel(level: FocusImmersiveLevel): void {
  focusImmersiveLevel.value = level
  if (level === 0) focusForced.value = false // 退出沉浸即解除强制模式，避免留下看不见的锁
  syncShell()
}

/** 双击在「沉浸 ⇄ 完全沉浸」之间切换；普通态进入沉浸 */
export function toggleDeeper(): void {
  const next: FocusImmersiveLevel = focusImmersiveLevel.value === 2 ? 1 : 2
  setFocusImmersiveLevel(next)
}

/** 进入沉浸（普通 → 1；已在沉浸层则不降级） */
export function enterFocusImmersive(): void {
  if (focusImmersiveLevel.value === 0) setFocusImmersiveLevel(1)
}

/** 退出沉浸层 */
export function exitFocusImmersive(): void {
  setFocusImmersiveLevel(0)
}

/** 开关 🔒 强制模式 */
export function setFocusForced(on: boolean): void {
  focusForced.value = on
}
