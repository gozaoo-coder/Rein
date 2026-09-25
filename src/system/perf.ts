import { computed, ref, watch } from 'vue'

/**
 * 运行时画质档位 · UI 状态单例（system 层）。
 *
 * 四个固定档（data-perf 的取值与之一致）：
 *   low      流畅：玻璃顶成实底、关模糊与循环动画
 *   high     高画质：毛玻璃（四层材质）、渐进模糊与动效全开
 *   ultra    超高：高画质之上再开液态玻璃。折射走**塌缩管线**（3 个原语）——
 *            出厂通道偏移相等时它与完整链逐像素等价，因此它就是标准的超高档。
 *   extreme  极致：折射走**完整链**（三通道位移 + 色散能力），并把玻璃材质铺到
 *            更多层（卡片 / 抽屉 / 菜单 / 操作面板 / 快捷磁贴）——对齐苹果
 *            Liquid Glass 的分层：导航与控件层用玻璃，内容保持可读。
 *
 * 旧值迁移（0.3.x → 本版）：auto → high（它本来就只在 high / low 之间自动切），
 * 「超高＋」ultra-opt → ultra（塌缩管线成为标准超高）。
 *
 * 落地：档位写进 <html data-perf>，折射管线单独写 <html data-glass>；
 * base.css 据此切换整套 --glass-* 令牌，PageHeader 读降级态换遮罩。
 */

export type PerfMode = 'low' | 'high' | 'ultra' | 'extreme'

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
 */
export const PERF_MODES: { value: PerfMode; label: string; hint: string }[] = [
  { value: 'low', label: '流畅', hint: '玻璃顶成实底、关模糊与循环动画，合成成本最低' },
  { value: 'high', label: '高画质', hint: '毛玻璃（四层材质）、渐进模糊与动效全开' },
  {
    value: 'ultra',
    label: '超高',
    hint: '六层材质（内圈描边 / 上缘焦散 / 外缘层）+ 折射表面（塌缩管线）',
  },
  {
    value: 'extreme',
    label: '极致',
    hint: '完整折射管线（三通道色散）+ 玻璃铺到卡片 / 抽屉 / 菜单 / 操作面板 / 快捷磁贴',
  },
]

const STORE_KEY = 'rein.perf.v1'

/** 旧值迁移表：改的是内部取值，已有的本地档位不能因此掉回默认 */
const LEGACY_MODES: Record<string, PerfMode> = {
  auto: 'high',
  'ultra-opt': 'ultra',
}

/**
 * 读本地档位；损坏 / 不可用一律回落 **high**。
 *
 * 为什么默认不是 low：渐进模糊、玻璃、页面进场动效都是**产品的一部分**，
 * 默认关掉等于「装完就像坏了一样」—— 0.2.5 升到 0.2.7 后用户看到的正是
 * 「渐进式模糊消失了」。现在的语义是「先给高画质，卡就手动切流畅」：
 * 四个档都是手动钉死的固定档，不再有自动判定。
 */
function loadMode(): PerfMode {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === 'low' || raw === 'high' || raw === 'ultra' || raw === 'extreme') return raw
    const legacy = raw ? LEGACY_MODES[raw] : undefined
    if (legacy) {
      // 迁移后立刻落盘：下次启动不必再走一遍映射
      try {
        localStorage.setItem(STORE_KEY, legacy)
      } catch {
        /* 存不下就只留内存态 */
      }
      return legacy
    }
  } catch {
    /* 本地存储不可用时用默认档 */
  }
  return 'high'
}

/** 用户档位：四个固定档，手动切换 */
export const perfMode = ref<PerfMode>(loadMode())

/** 实际生效的降级态：页面头遮罩与动效开关都读它 */
export const perfDegraded = computed(() => perfMode.value === 'low')

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
 * 液态玻璃开关（超高 / 极致两档共用）：用户选了这两档、这台设备画得出来。
 * 判定放在 perf 层而不是组件里 —— 档位是应用级状态，「哪些表面用得起玻璃」
 * 应当由状态说了算，组件不该各自去猜。
 */
export const liquidGlass = computed(
  () => (perfMode.value === 'ultra' || perfMode.value === 'extreme') && supportsSvgBackdrop(),
)

/**
 * 实际生效的折射管线 —— GlassSurface 按它决定烘哪条滤镜链。
 *
 * 超高走**塌缩链**：现行完整链把背景位移三次（R/G/B 各一次）再 screen 复合，
 * 三次的 scale 是 `distortionScale + 各通道 offset`；三个 offset 相等时三次位移的
 * 结果完全相同，而三张「只剩单通道」的图 screen 起来正好还原成原色 —— 整段复合是
 * 恒等变换。出厂值三个 offset 都是 0，所以出厂观感与完整链逐像素一致
 * （台架实测 0/399900 像素差），而原语数从 10 降到 3。
 *
 * 极致走**完整链**：三通道各自位移（色散能力完整保留），并配合 base.css 里
 * [data-perf='extreme'] 的玻璃材质铺到更多组件。通道偏移被调开时，即便在超高档
 * GlassSurface 也会自己退回完整链（见 useCollapsed）—— 任何档位下都不会画错。
 */
export const glassPipeline = computed<GlassPipeline>(() => {
  if (!liquidGlass.value) return 'off'
  return perfMode.value === 'extreme' ? 'full' : 'collapsed'
})

export function setPerfMode(mode: PerfMode): void {
  perfMode.value = mode
  try {
    localStorage.setItem(STORE_KEY, mode)
  } catch {
    /* 存不下就只留内存态 */
  }
}

watch(
  [perfDegraded, perfMode, glassPipeline],
  ([degraded, mode, pipeline]) => {
    // 档位原样写进 DOM（low / high / ultra / extreme）：base.css 与各处断言都读它。
    // 四个档都是手动钉死的固定档，不会出现「选了高档又被悄悄降级」这种前后不一致的状态。
    // 折射实现单独写 data-glass，像素比对与性能台架读它。
    document.documentElement.dataset.perf = degraded ? 'low' : mode
    document.documentElement.dataset.glass = pipeline
  },
  { immediate: true },
)
