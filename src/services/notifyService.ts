import { isTauri } from '@/services/transport'

/**
 * 系统通知出口 —— 抢课链路缺的最后一块。
 *
 * 为什么需要它：引擎的整个前提是「用户不在场」（睡觉、上课、把 App 扔一边），
 * 而结果此前只存在于 App 内部：一条 12 秒就消失的浮条、一个要主动点进去的面板。
 * 手机在兜里的时候，那等于没有结果。
 *
 * 两条路，**都真的会响**：
 *   · Tauri（桌面 / 手机）→ 系统通知，锁屏也看得见；
 *   · 浏览器（mock / e2e）或没拿到权限 → 返回 false，由调用方走页面内那条**常驻**提示。
 *
 * 第二条不是「降级成什么都没有」：调用方拿到 false 就必须把结果留在页面上，
 * 否则「通知发不出去」会静默成「结果丢了」—— 那正是这块功能要消灭的东西。
 */

/** 问过一次就不再问：权限弹窗反复出现，比没有通知更烦人 */
let asked = false

/**
 * 确保有通知权限。
 *
 * 只在**用户表达了「替我抢这门课」之后**才调用（见 `stores/courseSelect.enqueue`）——
 * 启动时就弹权限，用户还不知道这个 App 要通知他什么，只会被当成骚扰。
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (!isTauri) return false
  try {
    const n = await import('@tauri-apps/plugin-notification')
    if (await n.isPermissionGranted()) return true
    if (asked) return false
    asked = true
    return (await n.requestPermission()) === 'granted'
  } catch {
    // 插件缺失 / 平台不支持：如实当作「发不出去」，调用方会走页面内那条路
    return false
  }
}

/**
 * 发一条抢课结果。
 *
 * @returns true = 系统通知已发出；false = 当前环境发不出去
 *          —— **调用方必须据此决定要不要把结果留在页面上**。
 */
export async function notifyGrabResult(title: string, body: string): Promise<boolean> {
  if (!isTauri) return false
  try {
    const n = await import('@tauri-apps/plugin-notification')
    if (!(await ensureNotifyPermission())) return false
    n.sendNotification({ title, body })
    return true
  } catch {
    return false
  }
}
