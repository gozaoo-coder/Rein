<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { glassParams, type GlassParamKey } from '@/system/glassParams'
import { liquidGlass } from '@/system/perf'

/**
 * 液态玻璃表面（liquid glass）——「厚边折射、透心清晰」的那层玻璃。
 *
 * 折射是**用 SVG 位移滤镜画出来的**，四步：
 *   1. 按元素实际尺寸生成一张边缘梯度图（data URI）：底黑，叠一层「左→右 红渐隐」，
 *      再叠一层「上→下 蓝渐隐」，最后内缩一块圆角亮块（它的模糊半径就是玻璃的「厚度」）；
 *   2. 三个 feDisplacementMap 拿这张图当位移贴图，对**背景**分别按 R / G / B 通道位移
 *      （xChannelSelector=R / yChannelSelector=G），三个通道的位移量用 scale 微调；
 *   3. 三通道用 screen 叠回去，再轻微高斯模糊 —— 边缘因此被拉扯出彩色色散，
 *      中心因为梯度为零保持原样，看起来就是一整块有厚度的玻璃；
 *   4. 通过 `backdrop-filter: url(#filterId) saturate(...)` 作用在元素自身：
 *      它折射的是**元素背后的真实内容**（照片、列表、任意 DOM），不是一张贴图。
 *
 * 来源：vue-bits 的 GlassSurface（https://vue-bits.dev/r/GlassSurface）。
 * 本地化时改了三处，其余（滤镜管线、通道偏移、退化策略）原样保留：
 *   1. 上游用 Tailwind 类名，本项目是纯 CSS + 设计令牌 —— 全部改写成 scoped CSS；
 *   2. width / height 默认 '100%'（跟着容器走）、borderRadius 除了数字也接受 '50%' / '999px'
 *      —— 按钮这类「尺寸由内容决定」的场景不必再去量一遍像素；
 *   3. 低画质档（system/perf 的 low）直接走退化分支：省掉一次全屏合成，
 *      与「流动性优先」这一档的承诺一致；
 *   4. 材质参数（边缘厚度 / 亮度 / 位移量…）的默认值外置到 system/glassParams：
 *      画质预览页的调节面板就地改、存本地，这里只负责「调用方没给就用当前生效值」。
 *
 * 退化（不是兜底补丁，是常态路径之一）：
 *   - 内核不认 `backdrop-filter: url()`（Safari / Firefox）→ 普通毛玻璃（模糊 + 玻璃令牌）；
 *   - 不支持 backdrop-filter → 半透明实底 + 内描边；
 *   - 低画质档 → 同上，且 base.css 会全局关掉模糊。
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
const root = ref<HTMLElement | null>(null)
const feImageRef = ref<SVGElement | null>(null)
const redRef = ref<SVGElement | null>(null)
const greenRef = ref<SVGElement | null>(null)
const blueRef = ref<SVGElement | null>(null)
const blurRef = ref<SVGElement | null>(null)
let resizeObserver: ResizeObserver | null = null

/** 每个实例独立的 id：同一个页面可以并存多块玻璃，滤镜定义不能串 */
const uid = Math.random().toString(36).slice(2, 12)
const filterId = `glass-filter-${uid}`
const redGradId = `red-grad-${uid}`
const blueGradId = `blue-grad-${uid}`

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

/** 位移贴图里的 rx 必须是长度：优先取**计算值** —— 调用方给 var(--radius-full) / 50% / calc()
 *  这些「组件解析不了」的形式，浏览器都已经算成像素了；取不到（还没挂载）再按 prop 的写法解析。
 *  两种来路最后都夹到短边的一半（胶囊 / 正圆都落在这里）。 */
function radiusPx(w: number, h: number): number {
  const max = Math.min(w, h) / 2
  const computed = root.value ? getComputedStyle(root.value).borderRadius : ''
  const raw =
    computed.trim().split(/\s+/)[0] ||
    (typeof props.borderRadius === 'number' ? `${props.borderRadius}px` : String(props.borderRadius))
  const px = raw.endsWith('%') ? (max * 2 * parseFloat(raw)) / 100 : parseFloat(raw) || 0
  return Math.max(0, Math.min(px, max))
}

/**
 * 位移量是**绝对像素**（feDisplacementMap 的 scale）：小表面给小值。
 * 参照：边缘带宽度 = 短边 × borderWidth / 2，位移量最好与它同量级
 * （54px 的按钮：borderWidth 0.4 → 边缘带约 11px，位移量 -18 左右正合适）。
 * 位移量远大于边缘带时，边缘会被撕成彩色条纹 —— 那是"糊"，不是"玻璃"。
 */

function mapDataUri(w: number, h: number): string {
  const edge = Math.min(w, h) * (mat('borderWidth') * 0.5)
  const rx = radiusPx(w, h)
  const svg = `
      <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${redGradId}" x1="100%" y1="0%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="red"/>
          </linearGradient>
          <linearGradient id="${blueGradId}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${w}" height="${h}" fill="black"></rect>
        <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="url(#${redGradId})" />
        <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="url(#${blueGradId})" style="mix-blend-mode: ${props.mixBlendMode}" />
        <rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${h - edge * 2}" rx="${rx}" fill="hsl(0 0% ${mat('brightness')}% / ${mat('opacity')})" style="filter:blur(${mat('blur')}px)" />
      </svg>
    `
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function updateMap(): void {
  const rect = root.value?.getBoundingClientRect()
  if (!feImageRef.value) return
  // 元素还没布局（宽高为 0）时别生成贴图：0 宽的 viewBox 会让位移量算出 NaN，
  // 整块玻璃会变成一片空白
  feImageRef.value.setAttribute('href', mapDataUri(Math.max(1, rect?.width || 0), Math.max(1, rect?.height || 0)))
}

function updateFilter(): void {
  const pairs: [SVGElement | null, number][] = [
    [redRef.value, mat('redOffset')],
    [greenRef.value, mat('greenOffset')],
    [blueRef.value, mat('blueOffset')],
  ]
  for (const [el, offset] of pairs) {
    if (!el) continue
    el.setAttribute('scale', String(mat('distortionScale') + offset))
    el.setAttribute('xChannelSelector', props.xChannel)
    el.setAttribute('yChannelSelector', props.yChannel)
  }
  blurRef.value?.setAttribute('stdDeviation', String(mat('displace')))
}

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

watch(
  () => [
    props.width,
    props.height,
    props.borderRadius,
    props.borderWidth,
    props.brightness,
    props.opacity,
    props.blur,
    props.displace,
    props.distortionScale,
    props.redOffset,
    props.greenOffset,
    props.blueOffset,
    props.xChannel,
    props.yChannel,
    props.mixBlendMode,
    // 全局可调参数（面板拖动时换的是这个对象的引用）：改一次就重烘贴图与滤镜
    glassParams.value,
  ],
  () => {
    updateMap()
    updateFilter()
  },
  { flush: 'post' },
)

onMounted(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  isDarkMode.value = mq.matches
  const onChange = (e: MediaQueryListEvent): void => {
    isDarkMode.value = e.matches
  }
  mq.addEventListener('change', onChange)

  void nextTick(() => {
    updateMap()
    updateFilter()
    if (root.value && typeof ResizeObserver !== 'undefined') {
      // 尺寸一变就要重画贴图：贴图是按当时的像素尺寸烘出来的
      resizeObserver = new ResizeObserver(() => setTimeout(updateMap, 0))
      resizeObserver.observe(root.value)
    }
  })

  onUnmounted(() => {
    mq.removeEventListener('change', onChange)
    resizeObserver?.disconnect()
  })
})
</script>

<template>
  <!-- style 同样是上游同名 prop：与内部算出的尺寸 / 背景**合并**，同名以调用方为准。
       它是「定位 / 层叠 / 命中区」这类几何的出口 —— 组件自己只管材质，不知道调用方
       是把它当按钮还是当一整层垫底（底部 Dock 就是这么用的）。 -->
  <div ref="root" class="glass" :style="[rootStyle, props.style]">
    <!-- 滤镜定义（不参与绘制：opacity 0 + 绝对定位；真正生效的是 backdrop-filter 引用它） -->
    <svg v-show="canRefract" class="gdefs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <filter :id="filterId" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">
          <feImage ref="feImageRef" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
          <feDisplacementMap ref="redRef" in="SourceGraphic" in2="map" result="dispRed" />
          <feColorMatrix
            in="dispRed"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="red"
          />
          <feDisplacementMap ref="greenRef" in="SourceGraphic" in2="map" result="dispGreen" />
          <feColorMatrix
            in="dispGreen"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="green"
          />
          <feDisplacementMap ref="blueRef" in="SourceGraphic" in2="map" result="dispBlue" />
          <feColorMatrix
            in="dispBlue"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0"
            result="blue"
          />
          <feBlend in="red" in2="green" mode="screen" result="rg" />
          <feBlend in="rg" in2="blue" mode="screen" result="output" />
          <feGaussianBlur ref="blurRef" in="output" stdDeviation="0.7" />
        </filter>
      </defs>
    </svg>

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
     折射分支沿用同一份影子：上缘受光亮、下缘背光暗，玻璃的"厚度"才立得住 ——
     少了这条，哪怕折射算得再对，看着也只是一块平色。 */
  background: var(--glass-fill);
  border: 1px solid var(--line);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow:
    var(--shadow-float),
    inset 0 1px 0 0 var(--glass-rim-hi),
    inset 0 -1px 0 0 var(--glass-rim-lo),
    inset 0 14px 22px -16px var(--glass-sheen);
  transition: opacity var(--dur-base) var(--ease-out);
}

@media (prefers-reduced-transparency: reduce) {
  .glass {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-color: var(--line-strong);
  }
}

.gdefs {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
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
