import { ref } from 'vue'

/**
 * 训练课沉浸层 · UI 状态单例（system 层，与训练状态机解耦）。
 *
 * 沉浸页不再走路由（/session 已从路由表移除）：App.vue 常驻挂载
 * SessionOverlay，由本模块驱动显隐与 container transform 动画。
 * 这样「收起 ⇄ 恢复」不触发整页卸载重建，悬浮条与沉浸层之间可以
 * 做连续形变（从浮窗当前 rect 生长到全屏，任意吸附位同理）。
 *
 * - open：沉浸层显示中（含开 / 关动画进行中）
 * - closing：收起动画进行中——浮窗此刻要提前恢复显示，动画收尾时
 *   与形变块同位置接续，视觉无缝
 * - seq：展开请求序号。收起动画途中再次展开时 open 不变化，
 *   overlay 以 seq 触发重播（打断收起、反向展开）
 *
 * 形变锚点（浮窗几何）分两个时机取，都不能在动画回调时现量：
 * - 展开起点：openImmersive() 同步快照——immersiveOpen 置位后浮窗
 *   即被 v-show 隐藏，动画回调（flush post）时 rect 已量不到；
 * - 收起终点：playCollapse 时实时量——closing 已让浮窗恢复显示，
 *   且吸附位/泊车位置以「此刻」为准（与快照无关）。
 * 悬浮运动条挂载后经 setImmersiveOriginProvider 注册定位元素；
 * 无浮窗场景（课程页直接开课）为 null，overlay 自行兜底。
 */

export const immersiveOpen = ref(false)
export const immersiveClosing = ref(false)
export const immersiveOpenSeq = ref(0)

/** 浮窗几何快照：rect + 圆角（形变起止的圆角补偿基准）。
 *  explicit = 锚点来自调用方显式指定（如开课按钮）——展开起点必须
 *  忠于它，不允许被「现量浮窗」覆盖（浮窗在会话开始后立即出现，
 *  现量会把块拉到底部，与用户点击处脱节）。 */
export interface ImmersiveOriginSnapshot {
  rect: DOMRect
  radius: number
  explicit: boolean
}

let originProvider: (() => HTMLElement | null) | null = null
let originSnapshot: ImmersiveOriginSnapshot | null = null

export function setImmersiveOriginProvider(fn: () => HTMLElement | null): void {
  originProvider = fn
}

function measure(el: HTMLElement | null, explicit: boolean): ImmersiveOriginSnapshot | null {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width <= 4 || rect.height <= 4) return null
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius)
  return { rect, radius: Number.isFinite(radius) ? radius : 16, explicit }
}

/** 打开沉浸层（from = 显式锚点元素，缺省取悬浮条注册的定位元素） */
export function openImmersive(from?: HTMLElement | null): void {
  originSnapshot = measure(from ?? originProvider?.() ?? null, from != null)
  immersiveClosing.value = false
  immersiveOpen.value = true
  immersiveOpenSeq.value++
}

/** 收起沉浸层（播形变动画，动画收尾由 SessionOverlay 调 settleClosed） */
export function closeImmersive(): void {
  if (!immersiveOpen.value || immersiveClosing.value) return
  immersiveClosing.value = true
}

/** 立即关闭（不播动画）：会话已结束 / 作废，浮窗随之消失时用 */
export function closeImmersiveNow(): void {
  originSnapshot = null
  immersiveClosing.value = false
  immersiveOpen.value = false
}

/** 收起动画收尾回调（仅 SessionOverlay 内部调用） */
export function settleClosed(): void {
  closeImmersiveNow()
}

/** 展开动画起点：openImmersive 时刻的浮窗快照，无浮窗时为 null */
export function immersiveOriginSnapshot(): ImmersiveOriginSnapshot | null {
  return originSnapshot
}

/** 收起动画终点：此刻实时量取浮窗（已恢复显示，吸附位实时正确；非显式锚） */
export function measureOriginNow(): ImmersiveOriginSnapshot | null {
  return measure(originProvider?.() ?? null, false)
}
