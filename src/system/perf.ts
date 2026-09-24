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
 *
 * 五个档位（data-perf 的取值与之一致）：
 *   auto      按掉帧判定自动在 high / low 之间切
 *   high      始终高画质（毛玻璃 + 渐进模糊 + 动效）
 *   ultra     超高：在 high 之上再开**液态玻璃**（GlassSurface 的折射表面）——
 *             只有它认 `backdrop-filter: url(#svg-filter)` 的内核画得出来，
 *             所以能力不足时这一档退化回 high 的观感（见 liquidGlass）。
 *   ultra-opt 超高（优化）：与 ultra **同一套观感**，换一条更省的滤镜管线。
 *             现行管线用三个 feDisplacementMap 按 R/G/B 分通道位移再 screen 复合回来，
 *             但当三个通道偏移相等（出厂值 0/0/0）时那套复合在数学上是**恒等变换** ——
 *             实测 0/399900 像素差。这一档因此只留一次位移（10 个原语 → 3 个），
 *             并顺带去掉无效重烘（见 glassPipeline 与 GlassSurface 的头注释）。
 *             data-perf 仍写 ultra（观感档位没变），实际管线走 data-glass。
 *   low       流畅优先（玻璃顶成实底、关模糊与循环动画）
 */

export type PerfMode = 'auto' | 'high' | 'ultra' | 'ultra-opt' | 'low'

/**
 * 折射表面的滤镜管线：
 *   full      feImage + 3×feDisplacementMap + 3×feColorMatrix + 2×feBlend + feGaussianBlur
 *   collapsed feImage + 1×feDisplacementMap + feGaussianBlur（三通道偏移相等时与 full 逐像素等价）
 *   off       不画折射
 */
export type GlassPipeline = 'full' | 'collapsed' | 'off'

/**
 * 档位清单：设置页与画质预览页共用这一份（标签、说明都不在页面里另抄一遍）。
 * hint 说的是这一档**做了什么**，与页面上「此刻生效的是哪一档」是两件事。
 *
 * short 是分段控件里的写法：5 档 × 4 个汉字在 320px 宽的分段控件里放不下，
 * 完整名字在下面的清单与副标里给足。
 */
export const PERF_MODES: { value: PerfMode; label: string; short?: string; hint: string }[] = [
  { value: 'auto', label: '自动', hint: '按掉帧判定在 高画质 / 流畅优先 之间自动切' },
  { value: 'high', label: '高画质', hint: '毛玻璃（四层材质）、渐进模糊与动效全开' },
  {
    value: 'ultra',
    label: '超高',
    hint: '高画质之上再加液态玻璃：六层材质（内圈描边 / 上缘焦散 / 外缘层）+ 离散控件的折射表面',
  },
  {
    value: 'ultra-opt',
    label: '超高（优化）',
    short: '超高＋',
    hint: '与「超高」同一套观感，换成塌缩管线（三通道合成在出厂参数下是恒等变换）',
  },
  { value: 'low', label: '流畅优先', hint: '玻璃顶成实底、关模糊与循环动画' },
]

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

/**
 * 读本地档位；损坏 / 不可用一律回落 **auto**。
 *
 * 为什么默认不是 low：渐进模糊、玻璃、页面进场动效都是**产品的一部分**，
 * 默认关掉等于「装完就像坏了一样」—— 0.2.5 升到 0.2.7 后用户看到的正是
 * 「渐进式模糊消失了」（全新安装没有本地档位 → 默认 low → 遮罩 v-if 掉）。
 * 默认 auto 的语义是「先给最好的，实测扛不住再退」：判定见下面的帧采样，
 * 连续两窗 30% 掉帧才降级、连续四窗干净再升回来。
 */
function loadMode(): PerfMode {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === 'auto' || raw === 'high' || raw === 'ultra' || raw === 'ultra-opt' || raw === 'low') return raw
  } catch {
    /* 本地存储不可用时用默认档 */
  }
  return 'auto'
}

/** 用户档位：auto 按判定自动切换，high / ultra / ultra-opt / low 手动钉死 */
export const perfMode = ref<PerfMode>(loadMode())

/** auto 档下的判定结果（手动档不参与） */
const perfAutoLow = ref(false)

/** 实际生效的降级态：页面头遮罩与动效开关都读它 */
export const perfDegraded = computed(
  () => perfMode.value === 'low' || (perfMode.value === 'auto' && perfAutoLow.value),
)

/**
 * `backdrop-filter: url(#f)` 只有 Chromium 系认（滤镜当背景滤镜用是它独有的一步）；
 * Safari / Firefox 会**静默忽略**整条声明 —— 不探测的话表现就是「一片没玻璃的空白」。
 * 探测一次后缓存：能力在一台设备上是常量。
 */
let svgBackdropCache: boolean | null = null

export function supportsSvgBackdrop(): boolean {
  if (svgBackdropCache !== null) return svgBackdropCache
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return (svgBackdropCache = false)
  const ua = navigator.userAgent
  if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) return (svgBackdropCache = false)
  try {
    const probe = document.createElement('div')
    probe.style.setProperty('backdrop-filter', 'url(#pv-probe)')
    svgBackdropCache = probe.style.getPropertyValue('backdrop-filter') !== ''
  } catch {
    svgBackdropCache = false
  }
  return svgBackdropCache
}

/**
 * 液态玻璃开关（两个超高档共用）：用户选了超高（任一版）、没被降级、且这台设备画得出来。
 * 判定放在 perf 层而不是组件里 —— 档位是应用级状态，「哪些表面用得起玻璃」
 * 应当由状态说了算，组件不该各自去猜。
 */
export const liquidGlass = computed(
  () => (perfMode.value === 'ultra' || perfMode.value === 'ultra-opt') && !perfDegraded.value && supportsSvgBackdrop(),
)

/**
 * 实际生效的折射管线 —— GlassSurface 按它决定烘哪条滤镜链。
 *
 * 为什么「优化」能是**同一套观感**：现行链把背景位移三次（R/G/B 各一次）再 screen 复合。
 * 三次的 scale 是 `distortionScale + 各通道 offset`；三个 offset 相等时三次位移的结果
 * 完全相同，而三张「只剩单通道」的图 screen 起来正好还原成原色（screen 在通道互斥时
 * 就是相加）—— 整段复合是恒等变换。出厂值三个 offset 都是 0，所以出厂观感走塌缩链
 * 逐像素一致（台架实测 0/399900 像素差），而原语数从 10 降到 3。
 *
 * 通道偏移一旦被调开（调参面板能把它们拉开成色散），恒等就不成立了 ——
 * 那时这一档也**老实退回 full 链**：GlassSurface 会自己判断（见 useCollapsed）。
 */
export const glassPipeline = computed<GlassPipeline>(() => {
  if (!liquidGlass.value) return 'off'
  return perfMode.value === 'ultra-opt' ? 'collapsed' : 'full'
})

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
  [perfDegraded, perfMode, glassPipeline],
  ([degraded, mode, pipeline]) => {
    // 档位原样写进 DOM：base.css 与各处断言都读它。
    // 与 high 一样，两个超高都是手动钉死的档，不参与掉帧判定 ——
    // 所以不会出现「选了超高又被悄悄降级」这种前后不一致的状态。
    // ultra-opt 写 ultra：**观感档位**没变（同一套折射），换的是实现。
    // 实现单独写 data-glass，像素比对与性能台架读它。
    document.documentElement.dataset.perf = degraded
      ? 'low'
      : mode === 'ultra' || mode === 'ultra-opt'
        ? 'ultra'
        : 'high'
    document.documentElement.dataset.glass = pipeline
  },
  { immediate: true },
)
