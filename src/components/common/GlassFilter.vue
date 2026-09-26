<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { glassParams, type GlassParamKey } from '@/system/glassParams'

/**
 * 液态玻璃的**滤镜定义**（位移贴图 + 位移链）—— 整条折射管线只有这一份实现。
 *
 * 为什么单独拆出来：`backdrop-filter: url(#id)` 这件事由两部分组成 ——
 * 引用它的那个**表面**（`GlassSurface.vue` 的根、页头两颗圆钮、四条悬浮条），
 * 与**被引用的那段滤镜**（位移贴图 + feDisplacementMap）。两者可以分开：
 * 表面只要在自己的 CSS / 内联样式里写上 `url(#id)`，滤镜定义可以来自任何地方
 * （同一份定义还能被多个表面共用 —— 页头三颗 38px 圆钮就是共用一张贴图）。
 *
 * 拆的另一个理由是「两份定义必然漂」这条已经付过代价的教训：滤镜链一旦被抄成两份，
 * 改一处另一处就会悄悄落后，而表现只是「这块玻璃看着不太一样」。
 * 所以这里既服务 `GlassSurface`，也服务那些**不是** GlassSurface 的折射表面。
 *
 * ---------- 只有一条链（2026-09-26）----------
 * 从前这里有两份 `<filter>`：塌缩链（3 个原语）与完整链（10 个原语，三通道色散）。
 * 功能上完整链是塌缩链的超集，而**出厂参数下两者逐像素等价**（三通道偏移相等时
 * 三次位移结果相同、单通道图 screen 复合正好还原原色，整段是恒等变换）。
 * 也就是说：日常所有渲染里那 7 个多余原语从不改变一个像素，却每帧都在算 ——
 * 合成台架实测 12 块折射面上完整链比塌缩链多 0.8ms/帧。
 * 既然色散没有对应的产品设计，完整链整条删掉，`useCollapsed` 这个开关也随之消失。
 *
 * 量尺：默认量**自己的父元素**（把本组件放进那块玻璃里即可，尺寸/圆角自动跟着走，
 * 尺寸变了由 ResizeObserver 重烘）；给了 `w` / `h` 就按静态尺寸烘一次（页头那种固定规格）。
 *
 * 重烘这条路（与从前一样，四件事都不改观感）：
 *   · 尺寸与参数算成一个指纹，没变就整段跳过（ResizeObserver 每帧都会回调）；
 *   · 宽高取整：getBoundingClientRect 给的是小数，亚像素抖动会让指纹每次都变；
 *   · 贴图里**不掺实例 id** —— 它是自己一份独立文档，id 不会与页面串。尺寸参数相同的
 *     玻璃因此拿到同一个 data URI，浏览器按 URL 缓存解码结果，只烘一次；
 *   · 同一份指纹的 data URI 在模块级再缓存一层（见 MAP_CACHE）：指纹相同就连字符串
 *     都不再重新拼一遍 —— 贴图是「拼 SVG 源码 + encodeURIComponent 几千个字符」，
 *     一屏十来块玻璃、每块一次，拖参数滑杆时更是每帧一次。
 *   · 与 ResizeObserver 一起合并到一帧一次（拖滑杆时一个事件触发一遍，不合并就按事件数重烘）。
 * 写入一律先比旧值：实测写**相同**值与写变化值一样贵（都是「触发一次滤镜失效」），
 * 所以守卫写入是纯赚。
 */
const props = withDefaults(
  defineProps<{
    /** 滤镜 id：调用方在自己的 `backdrop-filter` 里用 `url(#id)` 引用 */
    id: string
    /** 量尺：不给就量自己的父元素 */
    source?: HTMLElement | null
    /** 静态尺寸（给了就不量元素）：固定规格的表面对这条更省一次强制样式结算 */
    w?: number
    h?: number
    /** 静态尺寸下的圆角：数字按 px，字符串原样解析（'50%' = 正圆） */
    radius?: number | string
    /** 位移贴图里那道通道渐变的混合方式（上游同名参数，默认 difference） */
    mixBlendMode?: string
    xChannel?: 'R' | 'G' | 'B'
    yChannel?: 'R' | 'G' | 'B'
    /** 材质参数覆盖：调用方显式给的按调用方的，缺省用 system/glassParams 的当前值 */
    params?: Partial<Record<GlassParamKey, number>>
    /** 折射分支是否活着（`v-show`）：不折射时整块定义不参与绘制布局 */
    enabled?: boolean
  }>(),
  { mixBlendMode: 'difference', xChannel: 'R', yChannel: 'G', enabled: true },
)

/**
 * 位移贴图的模块级缓存：指纹 → data URI。
 *
 * 贴图本身已经按「尺寸 + 参数」去重（不掺实例 id，所以同规格的玻璃拿到同一个
 * 字符串，浏览器按 URL 缓存解码结果），但**拼这个字符串**的工作仍是每块玻璃各做一遍：
 * 往模板里插十来个值，再对几千个字符跑一次 encodeURIComponent。一屏十来块玻璃
 * 就是十来次，而拖参数滑杆时每一次 input 都要全部重来。
 *
 * 缓存键必须与 `updateMap` 的指纹一致（否则会拿错贴图），所以两处共用 `mapKeyOf`。
 * 内容不变时返回的是**同一个字符串实例** —— 这对浏览器也更友好：字符串常量
 * 在 URL 缓存里命中的路径比内容相等的两份新字符串更短。
 *
 * 不设上限：一个会话里纹理规格的组合数就是「界面上出现过的玻璃尺寸 × 参数组数」，
 * 用户不动参数时它基本不增长，而每组值只有几 KB。
 */
const MAP_CACHE = new Map<string, string>()

/** 当前生效的材质参数 → 参与烘图的那些拼成一个指纹（`updateMap` 与缓存共用） */
function mapKeyOf(w: number, h: number, rx: number): string {
  return [
    w,
    h,
    rx,
    props.mixBlendMode,
    mat('borderWidth'),
    mat('brightness'),
    mat('opacity'),
    mat('blur'),
    mat('mapScale'),
  ].join('|')
}

const el = ref<SVGSVGElement | null>(null)
let resizeObserver: ResizeObserver | null = null
let rafId = 0
/** 上一次烘贴图用的指纹（尺寸 + 参与烘图的参数），以及当时那张贴图挂在哪个元素上。
 *  **必须连元素一起记**：换滤镜链时 Vue 会把整棵 <filter> 换掉，新元素没有 href ——
 *  只看指纹的话会以为「还是上次那张」而把它晾着，空贴图 = 位移量恒为 ±scale/2，
 *  整块玻璃会平着挪出去（这个 bug 被 e2e-perf-glass 第 8 节的逐像素比对抓到过）。 */
let mapEl: Element | null = null
let mapKey = ''

/** 材质参数取值：调用方显式给了就用调用方的，没给用**当前生效值**（system/glassParams） */
function mat(key: GlassParamKey): number {
  const own = props.params?.[key]
  return typeof own === 'number' ? own : glassParams.value[key]
}

/** 量尺：显式给的优先，否则量父元素（本组件总是被放进那块玻璃里） */
function host(): HTMLElement | null {
  return props.source ?? (el.value?.parentElement as HTMLElement | null) ?? null
}

/** 写入前先比旧值：SVG 属性写入不比较新旧，写一次就是一次滤镜失效 —— 实测写相同值
 *  与写变化值一样贵，所以「没变就不写」是纯赚，不是微优化。 */
function writeAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

/**
 * 贴图里的圆角必须是长度：优先取**计算值** —— 调用方给 var(--radius-full) / 50% / calc()
 * 这些「组件解析不了」的形式，浏览器都已经算成像素了；取不到（还没有量尺）再按 prop 的写法解析。
 * 两种来路最后都夹到短边的一半（胶囊 / 正圆都落在这里）。
 * 只在指纹变了的时候才调用：getComputedStyle 是一次强制样式结算。
 */
function radiusPx(w: number, h: number): number {
  const max = Math.min(w, h) / 2
  const node = host()
  const computed = node ? getComputedStyle(node).borderRadius : ''
  const raw =
    computed.trim().split(/\s+/)[0] ||
    (typeof props.radius === 'number' ? `${props.radius}px` : String(props.radius ?? '0'))
  const px = raw.endsWith('%') ? (max * 2 * parseFloat(raw)) / 100 : parseFloat(raw) || 0
  return Math.max(0, Math.min(px, max))
}

/**
 * 位移贴图。viewBox 始终是元素的实际像素尺寸，只有**光栅分辨率**受 mapScale 影响：
 * 根 svg 的 width/height 给成 w/scale，feImage 再用 preserveAspectRatio="none" 拉回原尺寸。
 * 贴图是一条平滑渐变（边缘那道斜坡由 blur 撑开），降分辨率只是把斜坡采样得粗一点，
 * 位移量是连续量，采样误差落回亚像素 —— 所以这是「省一点、观感几乎不动」的那个旋钮。
 *
 * 拼字符串 + 编码这几千个字符的结果走 MAP_CACHE：缓存键与重烘指纹同源（`mapKeyOf`），
 * 所以「要不要重烘」与「贴图是哪一张」永远是同一个判断，不会各判各的。
 */
function mapDataUri(w: number, h: number, rx: number): string {
  const key = mapKeyOf(w, h, rx)
  const hit = MAP_CACHE.get(key)
  if (hit !== undefined) return hit

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
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`
  // 拖窗口时尺寸会连续变，每次都是一个新键 —— 给个上限，别让缓存在一次拖拽里长成几百条。
  // 简单粗暴地整份清掉就够了：清完立刻又会被当前这批尺寸填上，不搞 LRU 那套。
  if (MAP_CACHE.size > 64) MAP_CACHE.clear()
  MAP_CACHE.set(key, uri)
  return uri
}

function updateMap(): void {
  // 不折射时整块定义既不画也不烘：贴图是按尺寸烘一次的解码 + 光栅化，
  // 高画质 / 流畅档没人引用它，白烘一张
  if (!props.enabled) return
  // 只在滤镜定义里找：父元素里可能有别的图标 SVG
  const img = el.value?.querySelector('feImage')
  if (!img) return
  const node = host()
  const rect = node?.getBoundingClientRect()
  // 元素还没布局（宽高为 0）时别生成贴图：0 宽的 viewBox 会让位移量算出 NaN，
  // 整块玻璃会变成一片空白。静态尺寸（页头）不走这条路
  const w = Math.max(1, Math.round(props.w ?? rect?.width ?? 0))
  const h = Math.max(1, Math.round(props.h ?? rect?.height ?? 0))
  // 指纹里放的是 prop 上的圆角写法而不是解析后的像素：解析要 getComputedStyle，
  // 那是一次强制样式结算，只在真的要重烘时才付（所以它在下面那一行之后才调用）。
  const key = [w, h, props.radius, props.mixBlendMode, mat('borderWidth'), mat('brightness'), mat('opacity'), mat('blur'), mat('mapScale')].join('|')
  // 尺寸与参数都没动、贴图也还挂在同一个元素上，就别重烘：
  // ResizeObserver 每帧都回调，拖窗口时按帧重烘是白花
  if (img === mapEl && key === mapKey) return
  mapEl = img
  mapKey = key
  const rx = radiusPx(w, h)
  writeAttr(img, 'href', mapDataUri(w, h, rx))
}

function updateFilter(): void {
  if (!props.enabled) return
  const root = el.value
  if (!root) return
  // 只有一次位移（塌缩链），位移量就是 distortionScale —— 从前那三个通道偏移
  // 是「加在 distortionScale 上的偏置」，只在三通道各自位移时才有意义，已随完整链删掉
  const dm = root.querySelector('feDisplacementMap')
  if (dm) {
    // 通道选择器是常量（prop），守卫写入让它在第一次之后就完全免费
    writeAttr(dm, 'xChannelSelector', props.xChannel)
    writeAttr(dm, 'yChannelSelector', props.yChannel)
    writeAttr(dm, 'scale', String(mat('distortionScale')))
  }
  const blur = root.querySelector('feGaussianBlur')
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

function observeHost(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!props.enabled) return
  const node = host()
  if (!node || typeof ResizeObserver === 'undefined') return
  // 尺寸一变就要重画贴图：贴图是按当时的像素尺寸烘出来的。
  // 回调只排一次队（schedule 会合并），真正的重烘在下一帧 ——
  // 拖窗口时这里每帧都会响，直接烘就是每帧一次解码 + 光栅化
  resizeObserver = new ResizeObserver(() => schedule())
  resizeObserver.observe(node)
}

watch(
  () => [props.enabled, props.source, props.w, props.h, props.radius, props.params, glassParams.value],
  () => {
    observeHost()
    schedule()
  },
  { flush: 'post' },
)

onMounted(() => {
  void nextTick(() => {
    observeHost()
    updateMap()
    updateFilter()
  })
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <!-- 滤镜定义本身不参与绘制：opacity 0 + 绝对定位；真正生效的是别处
       `backdrop-filter: url(#id)` 对它的引用。整份定义只有这一条链 -->
  <svg v-show="enabled" ref="el" class="gdefs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <!-- 唯一的一条：贴图 → 一次位移 → 收尾柔化，3 个原语。
           feImage 是位移贴图（按元素像素尺寸烘的 data URI，见 mapDataUri），
           feDisplacementMap 拿它把**背景**按红/绿通道的差位移开，
           feGaussianBlur 把位移出来的硬边化开（stdDeviation 走「边缘柔化」参数）。 -->
      <filter
        :id="props.id"
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
    </defs>
  </svg>
</template>

<style scoped>
.gdefs {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
}
</style>
