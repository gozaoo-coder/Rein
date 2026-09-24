<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { glassParams, type GlassParamKey } from '@/system/glassParams'
import { glassPipeline, liquidGlass } from '@/system/perf'

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
 * ---------- 两条滤镜链 ----------
 * 上游那条链是**三通道**的：三次 feDisplacementMap（R/G/B 各一次）+ 三张单通道
 * feColorMatrix + 两次 screen 复合，目的是让三个通道的位移量能各自偏一点，边缘就散出彩色。
 *
 * 但三次位移的 scale 是 `distortionScale + 各通道 offset` —— **三个 offset 相等时**
 * （出厂值 0/0/0 正是如此），三次位移的结果逐像素相同，而三张单通道图 screen 复合起来
 * 正好还原成原色（screen 在通道互斥时就是相加）。整段复合因此是**恒等变换**：
 * 塌缩成一次 feDisplacementMap 与完整链逐像素等价（隔离台架实测 0 / 399900 像素差，
 * 大面板下每帧成本 13.09ms → 1.69ms）。
 *
 * 所以：
 *   · 档位「超高（优化）」走**塌缩链**（10 个原语 → 3 个），观感与「超高」一致；
 *   · 通道偏移一旦被调开（调参面板能把它们拉成色散），恒等就不成立 ——
 *     useCollapsed 会自己判定并退回完整链，**任何档位下都不会画错**。
 *
 * ---------- 重烘这条路 ----------
 * 贴图是按元素的像素尺寸烘出来的一张图，换一次 href 浏览器就要重新解码 + 光栅化一次
 * （实测约 0.2ms/实例）。所以这条路上做了四件事，都不改观感：
 *   · 尺寸与参数算成一个指纹，没变就整段跳过（ResizeObserver 每帧都会回调）；
 *   · 宽高取整：getBoundingClientRect 给的是小数，亚像素抖动会让指纹每次都变；
 *   · 贴图里**不掺实例 id** —— 它是自己一份独立文档，id 不会与页面串。尺寸参数相同的
 *     玻璃因此拿到同一个 data URI，浏览器按 URL 缓存解码结果，只烘一次；
 *   · 与 ResizeObserver 一起合并到一帧一次（拖滑杆时一个事件触发一遍，不合并就按事件数重烘）。
 * 写入一律先比旧值：实测写**相同**值与写变化值一样贵（都是「触发一次滤镜失效」），
 * 所以守卫写入是纯赚。
 *
 * 退化（不是兜底补丁，是常态路径之一）：
 *   - 内核不认 `backdrop-filter: url()`（Safari / Firefox）→ 普通毛玻璃（模糊 + 玻璃令牌）；
 *   - 不支持 backdrop-filter → 半透明实底 + 内描边；
 *   - 低画质档 → 同上，且 base.css 会全局关掉模糊。
 *
 * 材质档位：`.glass` 与 `.glass-surface` 共用同一份 `--glass-*` 令牌，所以
 * **增加档位是改令牌、不是改组件** —— 超高档在 base.css 里把整套令牌换掉
 * （底更薄 + 内圈描边 + 上缘焦散 + 外缘层），这里与导航轨一起升级；
 * 弱档则被顶成实底。（折射仍只有这边的 `url()` 滤镜，名单见 docs/ARCHITECTURE.md。）
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
const root = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null
let rafId = 0
/** 上一次烘贴图用的指纹（尺寸 + 参与烘图的参数），以及当时那张贴图挂在哪个元素上。
 *  **必须连元素一起记**：换滤镜链时 Vue 会把整棵 <filter> 换掉，新元素没有 href ——
 *  只看指纹的话会以为「还是上次那张」而把它晾着，空贴图 = 位移量恒为 ±scale/2，
 *  整块玻璃会平着挪出去（这个 bug 被 e2e-perf-glass 第 8 节的逐像素比对抓到过）。 */
let mapEl: Element | null = null
let mapKey = ''

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

/** 写入前先比旧值：SVG 属性写入不比较新旧，写一次就是一次滤镜失效 —— 实测写相同值
 *  与写变化值一样贵，所以「没变就不写」是纯赚，不是微优化。 */
function writeAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

/** 位移贴图里的 rx 必须是长度：优先取**计算值** —— 调用方给 var(--radius-full) / 50% / calc()
 *  这些「组件解析不了」的形式，浏览器都已经算成像素了；取不到（还没挂载）再按 prop 的写法解析。
 *  两种来路最后都夹到短边的一半（胶囊 / 正圆都落在这里）。
 *  只在指纹变了的时候才调用：getComputedStyle 是一次强制样式结算。 */
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

/**
 * 位移贴图。viewBox 始终是元素的实际像素尺寸，只有**光栅分辨率**受 mapScale 影响：
 * 根 svg 的 width/height 给成 w/scale，feImage 再用 preserveAspectRatio="none" 拉回原尺寸。
 * 贴图是一条平滑渐变（边缘那道斜坡由 blur 撑开），降分辨率只是把斜坡采样得粗一点，
 * 位移量是连续量，采样误差落回亚像素 —— 所以这是「省一点、观感几乎不动」的那个旋钮。
 */
function mapDataUri(w: number, h: number, rx: number): string {
  const edge = Math.min(w, h) * (mat('borderWidth') * 0.5)
  const scale = Math.max(1, Math.round(mat('mapScale')))
  // id 是写死的：贴图是自己一份独立文档，不会与页面里的 id 串。写死之后
  // 「尺寸 + 参数」相同的玻璃拿到的是**同一个字符串**，浏览器按 URL 缓存解码结果 ——
  // 掺实例 id 的话每块玻璃都要各烘一张，白花一次解码 + 光栅化。
  const svg = `
      <svg viewBox="0 0 ${w} ${h}" width="${w / scale}" height="${h / scale}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="red-grad" x1="100%" y1="0%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="red"/>
          </linearGradient>
          <linearGradient id="blue-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#0000"/>
            <stop offset="100%" stop-color="blue"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${w}" height="${h}" fill="black"></rect>
        <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="url(#red-grad)" />
        <rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" fill="url(#blue-grad)" style="mix-blend-mode: ${props.mixBlendMode}" />
        <rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${h - edge * 2}" rx="${rx}" fill="hsl(0 0% ${mat('brightness')}% / ${mat('opacity')})" style="filter:blur(${mat('blur')}px)" />
      </svg>
    `
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function updateMap(): void {
  const node = root.value
  // 只在滤镜定义里找：slot 里可能有调用方自己的图标 SVG
  const img = node?.querySelector('.gdefs feImage')
  if (!node || !img) return
  // 元素还没布局（宽高为 0）时别生成贴图：0 宽的 viewBox 会让位移量算出 NaN，
  // 整块玻璃会变成一片空白
  const rect = node.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  const key = [
    w,
    h,
    props.borderRadius,
    props.mixBlendMode,
    mat('borderWidth'),
    mat('brightness'),
    mat('opacity'),
    mat('blur'),
    mat('mapScale'),
  ].join('|')
  // 尺寸与参数都没动、贴图也还挂在同一个元素上，就别重烘：
  // ResizeObserver 每帧都回调，拖窗口时按帧重烘是白花
  if (img === mapEl && key === mapKey) return
  mapEl = img
  mapKey = key
  writeAttr(img, 'href', mapDataUri(w, h, radiusPx(w, h)))
}

function updateFilter(): void {
  const defs = root.value?.querySelector('.gdefs')
  if (!defs) return
  // 塌缩链只有一次位移，取的是红通道那次的 scale —— 走塌缩的前提就是三个 offset 相等
  const offsets = [mat('redOffset'), mat('greenOffset'), mat('blueOffset')]
  defs.querySelectorAll('feDisplacementMap').forEach((el, i) => {
    // 通道选择器是常量（prop），守卫写入让它在第一次之后就完全免费
    writeAttr(el, 'xChannelSelector', props.xChannel)
    writeAttr(el, 'yChannelSelector', props.yChannel)
    writeAttr(el, 'scale', String(mat('distortionScale') + (offsets[i] ?? offsets[0])))
  })
  const blur = defs.querySelector('feGaussianBlur')
  if (blur) writeAttr(blur, 'stdDeviation', String(mat('displace')))
}

/** 贴图重烘与滤镜重写合并到一帧一次：拖参数滑杆时每个 input 事件触发一遍，
 *  ResizeObserver 更是每帧都回调 —— 不合并就按事件数重烘。 */
function schedule(): void {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    updateMap()
    updateFilter()
  })
}

/** 玻璃压暗还是提亮：auto 跟主题，dark / light 由调用方指定 */
const darkTint = computed(() => (props.tint === 'auto' ? isDarkMode.value : props.tint === 'dark'))

/**
 * 走哪条滤镜链。塌缩链只有在**恒等条件**成立时才等价于完整链：
 * 三次位移的 scale 是 distortionScale + 各通道 offset，三个 offset 相等时三次结果
 * 逐像素相同，而三张单通道图 screen 复合正好还原原色 —— 整段复合是恒等变换。
 * 通道偏移一旦被调开（色散），恒等就不成立 —— 这里自己判定并退回完整链，
 * 所以「超高（优化）」这一档在任何参数下都不会画错。
 */
const useCollapsed = computed(
  () =>
    glassPipeline.value === 'collapsed' &&
    mat('redOffset') === mat('greenOffset') &&
    mat('greenOffset') === mat('blueOffset'),
)

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
    props.mapScale,
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
    // 换链 / 开折射：滤镜定义整棵被换掉，新的那些元素要重新写一遍属性
    useCollapsed.value,
    canRefract.value,
  ],
  () => schedule(),
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
      // 尺寸一变就要重画贴图：贴图是按当时的像素尺寸烘出来的。
      // 回调只排一次队（schedule 会合并），真正的重烘在下一帧 ——
      // 拖窗口时这里每帧都会响，直接烘就是每帧一次解码 + 光栅化
      resizeObserver = new ResizeObserver(() => schedule())
      resizeObserver.observe(root.value)
    }
  })

  onUnmounted(() => {
    mq.removeEventListener('change', onChange)
    resizeObserver?.disconnect()
    if (rafId) cancelAnimationFrame(rafId)
  })
})
</script>

<template>
  <!-- style 同样是上游同名 prop：与内部算出的尺寸 / 背景**合并**，同名以调用方为准。
       它是「定位 / 层叠 / 命中区」这类几何的出口 —— 组件自己只管材质，不知道调用方
       是把它当按钮还是当一整层垫底（底部 Dock 就是这么用的）。 -->
  <div ref="root" class="glass" :style="[rootStyle, props.style]">
    <!-- 滤镜定义（不参与绘制：opacity 0 + 绝对定位；真正生效的是 backdrop-filter 引用它）。
         两条链同 id：同一时刻只有一条在 DOM 里 -->
    <svg v-show="canRefract" class="gdefs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <!-- 塌缩链：三个通道偏移相等时，三通道位移 + screen 复合是恒等变换，只留一次位移。
             10 个原语 → 3 个，逐像素等价（隔离台架实测 0/399900 像素差） -->
        <filter
          v-if="useCollapsed"
          :id="filterId"
          color-interpolation-filters="sRGB"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
        >
          <feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" result="output" />
          <feGaussianBlur in="output" stdDeviation="0.7" />
        </filter>

        <!-- 完整链：通道偏移拉开成色散时才需要（上游原样） -->
        <filter
          v-else
          :id="filterId"
          color-interpolation-filters="sRGB"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
        >
          <feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" result="dispRed" />
          <feColorMatrix
            in="dispRed"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="red"
          />
          <feDisplacementMap in="SourceGraphic" in2="map" result="dispGreen" />
          <feColorMatrix
            in="dispGreen"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="green"
          />
          <feDisplacementMap in="SourceGraphic" in2="map" result="dispBlue" />
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
          <feGaussianBlur in="output" stdDeviation="0.7" />
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
