<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import GlassFilter from '@/components/common/GlassFilter.vue'
import { glassParams, type GlassParamKey } from '@/system/glassParams'
import { liquidGlass } from '@/system/perf'

/**
 * 液态玻璃表面（liquid glass）——「厚边折射、透心清晰」的那层玻璃。
 *
 * 折射是**用 SVG 位移滤镜画出来的**，四步：
 *   1. 按元素实际尺寸生成一张边缘梯度图（data URI）：底黑，叠一层「左→右 红渐隐」，
 *      再叠一层「上→下 蓝渐隐」，最后内缩一块圆角亮块（它的模糊半径就是玻璃的「厚度」）；
 *   2. feDisplacementMap 拿这张图当位移贴图，对**背景**做位移
 *      （xChannelSelector=R / yChannelSelector=G）；
 *   3. 边缘因此被拉扯出折射，中心因为梯度为零保持原样，看起来就是一整块有厚度的玻璃；
 *   4. 通过 `backdrop-filter: url(#filterId) saturate(...)` 作用在元素自身：
 *      它折射的是**元素背后的真实内容**（照片、列表、任意 DOM），不是一张贴图。
 *
 * 来源：vue-bits 的 GlassSurface（https://vue-bits.dev/r/GlassSurface）。
 * 本地化时改了四处，其余（滤镜管线、通道偏移、退化策略）原样保留：
 *   1. 上游用 Tailwind 类名，本项目是纯 CSS + 设计令牌 —— 全部改写成 scoped CSS；
 *   2. width / height 默认 '100%'（跟着容器走）、borderRadius 除了数字也接受 '50%' / '999px'
 *      —— 按钮这类「尺寸由内容决定」的场景不必再去量一遍像素；
 *   3. 低画质档（system/perf 的 low）直接走退化分支：省掉一次全屏合成，
 *      与「流动性优先」这一档的承诺一致；
 *   4. 材质参数（边缘厚度 / 亮度 / 位移量…）的默认值外置到 system/glassParams：
 *      画质预览页的调节面板就地改、存本地，这里只负责「调用方没给就用当前生效值」。
 *
 * ---------- 组件拆成两半（2026-09-25）----------
 * 上游是一个组件一肩挑：表面 + 滤镜定义。本仓拆开了 —— **滤镜定义在
 * `common/GlassFilter.vue`**，这里只管「表面」（尺寸 / 圆角 / 底 / 退化分支 / 引用那段滤镜）。
 * 拆的理由是折射的名单扩到了不是本组件的表面（页头两颗圆钮、四条悬浮条 —— 它们是
 * 既有的 `.glass-surface`，只是要额外拿到折射），而滤镜链抄成两份必然漂：
 * 「两份定义必然漂」是这个仓已经付过代价的教训。拆完两边都只有一份实现。
 *
 * 两条滤镜链（塌缩 / 完整）与它们的等价条件写在 GlassFilter.vue —— 链的实现在那边，
 * 这里的 `saturate()` 只是把引用拼进 `backdrop-filter`。
 *
 * 退化（不是兜底补丁，是常态路径之一）：
 *   - 内核不认 `backdrop-filter: url()`（Safari / Firefox）→ 普通毛玻璃（模糊 + 玻璃令牌）；
 *   - 不支持 backdrop-filter → 半透明实底 + 内描边；
 *   - 低画质档 → 同上，且 base.css 会全局关掉模糊。
 *
 * 材质档位：`.glass` 与 `.glass-surface` 共用同一份 `--glass-*` 令牌，所以
 * **增加档位是改令牌、不是改组件** —— 超高 / 极致档在 base.css 里把整套令牌换掉
 * （底更薄 + 内圈描边 + 上缘焦散 + 外缘层；极致再深一档并把材质铺到更多组件），
 * 这里与导航轨一起升级；弱档则被顶成实底。（折射仍只有这边的 `url()` 滤镜，
 * 名单见 docs/ARCHITECTURE.md。）
 */
const props = withDefaults(
  defineProps<{
    width?: string | number
    height?: string | number
    /** 圆角：数字按 px，字符串原样用（'50%' = 正圆，'999px' = 胶囊） */
    borderRadius?: number | string
    /** 边缘厚度比例（占短边的一半的比例）：越大「玻璃越厚」，折射带越宽。
     *  小尺寸表面上要给大值 —— 位移量是按整块尺寸算的，54px 的按钮如果你用大面板的
     *  0.07，边缘带只有 1.9px 宽、位移量却有几十像素，整块会糊成一团彩色。 */
    borderWidth?: number
    brightness?: number
    opacity?: number
    blur?: number
    displace?: number
    backgroundOpacity?: number
    saturation?: number
    /** 位移贴图的分辨率除数（1 = 按元素像素尺寸烘，2 = 半分辨率再由 feImage 拉回）。
     *  只影响成本、几乎不影响观感 —— 贴图是一条平滑渐变，降分辨率只是把它采样得粗一点 */
    mapScale?: number
    distortionScale?: number
    redOffset?: number
    greenOffset?: number
    blueOffset?: number
    xChannel?: 'R' | 'G' | 'B'
    yChannel?: 'R' | 'G' | 'B'
    mixBlendMode?: string
    /** 玻璃底色方向：auto 跟随亮暗色（上游行为），dark / light 强制 ——
     *  压在彩色照片或墙纸上的玻璃无论什么主题都该压暗，否则白字读不出来 */
    tint?: 'auto' | 'light' | 'dark'
    /** 折射分支的底用什么颜色（CSS 颜色，可带 var()）：缺省按亮暗色取半透明黑 / 白。
     *  Dock 传 --glass-fill 与其余玻璃**同色** —— 暗色下纯黑底会把页签文字的
     *  真图对比度压低一档（2.52 vs 2.72，见 scripts/e2e-perf-glass.mjs 第 6 节）。 */
    fill?: string
    /** 额外的内联样式（上游同名 prop）：与内部计算出的尺寸/背景合并，同名时以调用方为准 */
    style?: Record<string, string>
  }>(),
  {
    width: '100%',
    height: '100%',
    borderRadius: 50,
    // 材质参数（边缘厚度 / 亮度 / 位移量 / 底色浓度…）的默认值**不写在这里**：它们是
    // 可调参数，由 system/glassParams 统一持有（画质预览页的「液态玻璃参数调节」面板
    // 改的就是那一份），调用方不传时用当前生效值 —— 调用处因此仍然只给尺寸与圆角。
    // 出厂那套数是按「UI 尺寸的表面」（54~60px 的按钮、底部栏）标定的：
    // 亮度 50 = 位移贴图中心中灰 = 中心不位移（只有边缘在折射），这是整块看着"是玻璃"
    // 而不是"糊成一团"的关键；边缘带在小表面上留足比例，位移量按绝对像素收小。
    xChannel: 'R',
    yChannel: 'G',
    mixBlendMode: 'difference',
    tint: 'auto',
    style: () => ({}),
  },
)

const isDarkMode = ref(false)

/** 每个实例独立的 id：同一个页面可以并存多块玻璃，滤镜定义不能串 */
const uid = Math.random().toString(36).slice(2, 12)
const filterId = `glass-filter-${uid}`

/**
 * 折射能不能画：**由系统档位说了算**（超高档 + 未被降级 + 内核认 url() 滤镜，
 * 判定见 system/perf 的 liquidGlass）。不是超高档时这里就老老实实当一块普通毛玻璃 ——
 * 「超高」这一档因此有可验证的实际差异，而不是一个只改标签的空选项。
 */
const canRefract = computed(() => liquidGlass.value)

/**
 * 材质参数取值：调用方显式给了就用调用方的，没给用**当前生效值**
 * （system/glassParams —— 画质预览页的调节面板改的就是那一份）。
 */
function mat(key: GlassParamKey): number {
  const own = props[key]
  return typeof own === 'number' ? own : glassParams.value[key]
}

function length(value: string | number): string {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * 交给 GlassFilter 的参数覆盖：滤镜链用得着的那十个（贴图边缘/亮度/不透明度/模糊/
 * 分辨率 + 位移强度/三通道偏移/边缘柔化）。剩下的背景饱和度与底色浓度写在下面的
 * 表面样式上，不进滤镜。
 */
const FILTER_PARAM_KEYS: GlassParamKey[] = [
  'borderWidth',
  'brightness',
  'opacity',
  'blur',
  'mapScale',
  'distortionScale',
  'redOffset',
  'greenOffset',
  'blueOffset',
  'displace',
]

const paramOverrides = computed<Partial<Record<GlassParamKey, number>>>(() => {
  const out: Partial<Record<GlassParamKey, number>> = {}
  for (const key of FILTER_PARAM_KEYS) {
    const own = props[key]
    if (typeof own === 'number') out[key] = own
  }
  return out
})

/** 玻璃压暗还是提亮：auto 跟主题，dark / light 由调用方指定 */
const darkTint = computed(() => (props.tint === 'auto' ? isDarkMode.value : props.tint === 'dark'))

const rootStyle = computed<Record<string, string>>(() => {
  const base: Record<string, string> = {
    width: length(props.width),
    height: length(props.height),
    borderRadius: length(props.borderRadius),
  }
  if (!canRefract.value) return base
  const fill =
    props.fill ||
    (darkTint.value
      ? `hsl(0 0% 0% / ${mat('backgroundOpacity')})`
      : `hsl(0 0% 100% / ${mat('backgroundOpacity')})`)
  return {
    ...base,
    background: fill,
    backdropFilter: `url(#${filterId}) saturate(${mat('saturation')})`,
    WebkitBackdropFilter: `url(#${filterId}) saturate(${mat('saturation')})`,
  }
})

onMounted(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  isDarkMode.value = mq.matches
  const onChange = (e: MediaQueryListEvent): void => {
    isDarkMode.value = e.matches
  }
  mq.addEventListener('change', onChange)

  onUnmounted(() => {
    mq.removeEventListener('change', onChange)
  })
})
</script>

<template>
  <!-- style 同样是上游同名 prop：与内部算出的尺寸 / 背景**合并**，同名以调用方为准。
       它是「定位 / 层叠 / 命中区」这类几何的出口 —— 组件自己只管材质，不知道调用方
       是把它当按钮还是当一整层垫底（底部 Dock 就是这么用的）。 -->
  <div ref="root" class="glass" :style="[rootStyle, props.style]">
    <!-- 滤镜定义（不参与绘制）：位移贴图 + 位移链的唯一实现在 common/GlassFilter.vue，
         这里只声明「我这一块引用它」。量尺默认是父元素 —— 对本组件就是这块玻璃自己，
         尺寸一变由它自己重烘贴图 -->
    <GlassFilter
      :id="filterId"
      :enabled="canRefract"
      :mix-blend-mode="props.mixBlendMode"
      :x-channel="props.xChannel"
      :y-channel="props.yChannel"
      :params="paramOverrides"
    />

    <div class="gbody">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* 表面本体：折射或退化都发生在这个盒子上，圆角与尺寸由调用方给 */
.glass {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 退化分支的外观（普通毛玻璃）：走玻璃令牌，与 Dock / 悬浮条同一套材质。
     模糊刻意**比 .glass-surface 小**（20 与 28）：这一支服务的都是 54~58px 的 UI 尺寸，
     同样的半径在小表面上背后剩下的内容就没几像素了 —— 玻璃会读成一块糊。
     折射分支沿用同一份影子：上缘受光亮、下缘背光暗，玻璃的"厚度"才立得住 ——
     少了这条，哪怕折射算得再对，看着也只是一块平色。
     box-shadow 里那三层光学细节（rim-2 / caustic / halo）是**超高专属**：其余档位
     这几个令牌透明，所以层数一致、观感不同 —— 与 .glass-surface 用的是同一份令牌，
     超高档下 Dock 与导航轨因此是同一套材质，不会一块厚一块薄。 */
  background: var(--glass-fill);
  border: 1px solid var(--line);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow:
    var(--shadow-float),
    var(--glass-halo),
    inset 0 1px 0 0 var(--glass-rim-hi),
    inset 0 -1px 0 0 var(--glass-rim-lo),
    inset 0 14px 22px -16px var(--glass-sheen),
    inset 0 0 0 1px var(--glass-rim-2),
    inset 0 1px 10px -2px var(--glass-caustic);
  transition: opacity var(--dur-base) var(--ease-out);
}

/* 系统要求「减弱透明度」时退回实底 —— 折射与毛玻璃都关掉，与 .glass-surface 同一条语义。
   带 !important：折射那一支的 `backdrop-filter` 是**内联样式**（见 rootStyle），
   媒体查询里的普通声明压不过它（减弱透明度时那一支会整条失效，表现为"什么都不糊"）。 */
@media (prefers-reduced-transparency: reduce) {
  .glass {
    background: var(--surface);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border-color: var(--line-strong);
  }
}

.gbody {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
