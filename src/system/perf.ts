import { computed, ref, watch } from 'vue'

/**
 * 运行时性能守门 · UI 状态单例（system 层）。
 *
 * 采样：requestAnimationFrame 只读时间戳（不触发布局），按 90 帧一个窗口统计
 * 「掉帧帧」——间隔超过 32ms 即低于 30fps。窗口之间歇 6 秒：rAF 持续触发本身
 * 就是一项常驻耗电，空闲时不该一直挂着回调。路由切换、流式输出这类已知重负载
 * 时机用 kickPerfWatch() 插队补采一轮。
 * 判定：连续 2 个窗口掉帧占比 > 30% → 降级；连续 4 个窗口占比 < 8% → 恢复。
 * 恢复门槛刻意比降级高——在临界点上来回抖动比一直降级更难受。
 * 落地：结论写进 <html data-perf="low">，base.css 据此关掉毛玻璃与循环动画、
 * 把半透明表面换成实底；PageHeader 读降级态把渐进模糊换成底色遮罩。
 * 后台挂起（窗口最小化 / 系统休眠）造成的长间隔不是掉帧，直接丢弃。
 */

export type PerfMode = 'auto' | 'high' | 'low'

const STORE_KEY = 'rein.perf.v1'

/** 一个采样窗口的帧数（60fps 下约 1.5 秒） */
const FRAME_WINDOW = 90
/** 超过这个帧间隔算掉帧（< 30fps） */
const BAD_FRAME_MS = 32
/** 超过这个间隔视为挂起而非卡顿，丢弃该帧 */
const SUSPEND_MS = 1000
const REST_MS = 6000
const DEGRADE_RATIO = 0.3
const DEGRADE_WINDOWS = 2
const RECOVER_RATIO = 0.08
const RECOVER_WINDOWS = 4

/** 读本地档位；损坏 / 不可用一律回落 auto（选错档不能拖垮启动） */
function loadMode(): PerfMode {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === 'auto' || raw === 'high' || raw === 'low') return raw
  } catch {
    /* 本地存储不可用时用默认档 */
  }
  return 'auto'
}

/** 用户档位：auto 按判定自动切换，high / low 手动钉死 */
export const perfMode = ref<PerfMode>(loadMode())

/** auto 档下的判定结果（手动档不参与） */
const perfAutoLow = ref(false)

/** 实际生效的降级态：页面头遮罩与动效开关都读它 */
export const perfDegraded = computed(
  () => perfMode.value === 'low' || (perfMode.value === 'auto' && perfAutoLow.value),
)

export function setPerfMode(mode: PerfMode): void {
  perfMode.value = mode
  try {
    localStorage.setItem(STORE_KEY, mode)
  } catch {
    /* 存不下就只留内存态 */
  }
}

let frames: number[] = []
let last = 0
let rafId = 0
let restTimer: ReturnType<typeof setTimeout> | null = null
let started = false
let badStreak = 0
let goodStreak = 0

function stopFrames(): void {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  last = 0
}

function startFrames(): void {
  if (!started || document.hidden || rafId) return
  frames = []
  last = 0
  rafId = requestAnimationFrame(onFrame)
}

function restThenSample(): void {
  if (restTimer) clearTimeout(restTimer)
  restTimer = setTimeout(() => {
    restTimer = null
    startFrames()
  }, REST_MS)
}

/** 一个窗口采满：结算降级 / 恢复判定，然后歇 REST_MS 再采下一轮 */
function settle(): void {
  const total = frames.length
  const bad = frames.filter((d) => d > BAD_FRAME_MS).length / total
  stopFrames()
  if (bad > DEGRADE_RATIO) {
    badStreak++
    goodStreak = 0
    if (badStreak >= DEGRADE_WINDOWS) perfAutoLow.value = true
  } else if (bad < RECOVER_RATIO) {
    goodStreak++
    badStreak = 0
    if (goodStreak >= RECOVER_WINDOWS) perfAutoLow.value = false
  } else {
    badStreak = 0
    goodStreak = 0
  }
  restThenSample()
}

function onFrame(now: number): void {
  rafId = requestAnimationFrame(onFrame)
  if (last > 0) {
    const dt = now - last
    if (dt < SUSPEND_MS) frames.push(dt)
  }
  last = now
  if (frames.length >= FRAME_WINDOW) settle()
}

function onVisibility(): void {
  if (document.hidden) {
    stopFrames()
    if (restTimer) {
      clearTimeout(restTimer)
      restTimer = null
    }
  } else {
    startFrames()
  }
}

/** 启动采样（幂等）。App.vue 挂载时调用一次 */
export function startPerfWatch(): void {
  if (started) return
  started = true
  document.addEventListener('visibilitychange', onVisibility)
  startFrames()
}

/** 已知重负载时机插队采一轮（路由切换 / 流式输出开始），不等休息窗口到期 */
export function kickPerfWatch(): void {
  if (!started) return
  if (restTimer) {
    clearTimeout(restTimer)
    restTimer = null
  }
  if (!rafId) startFrames()
}

watch(
  perfDegraded,
  (low) => {
    document.documentElement.dataset.perf = low ? 'low' : 'high'
  },
  { immediate: true },
)
