<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 液态活动底（丰富档专用）：在等分容器里跟随索引平移的一颗 blob。
 *
 * 三件事叠出苹果那种「液态」：
 *   1. **融合**：按下时从触点再长出一颗小球，`feGaussianBlur` + `feColorMatrix`
 *      的 alpha 对比把两颗球之间的 alpha 斜坡推成一道实心的颈 —— 融合是**涌现的**，
 *      不需要手写颈部几何，也就不会有「两颗球靠近时脖子长歪」那类 bug。
 *   2. **形变**：位移用独立属性 `translate`（只走位移），形变用 `scale` 的 keyframe
 *      （加速时拉宽压扁、减速时收窄拉高）—— 两个属性互不覆写，位移途中形变不会被打断。
 *   3. **浓度**：浓度挂在容器上而不是 blob 上。goo 的 alpha 对比会把半透明输入推成
 *      实色（`19 × 0.62 − 8` 已经超出 1），所以 blob 画实色、浓度由容器的 opacity 给 ——
 *      否则「0.62 的活动底」到了丰富档会变成纯白，比默认档还亮一档。
 *
 * ⚠️ 两个必须守住的约束：
 *   · **不能包在玻璃外面**：本组件带 `filter`，而带 filter / mask / opacity<1 的元素
 *     会成为后代的 backdrop root —— 包在 `GlassSurface` 外面会让那层折射整段失效
 *     （ProgressiveBlur 的文件头记着这个坑）。所以它是玻璃 slot **里面**的一层，
 *     自己 `absolute + inset: 0 + z-index: -1`，与它要替换的 `::before` 同位。
 *   · **`pointer-events: none`**：命中区归容器里的按钮，它只负责画。
 *     触点位置因此是**监听父元素**（捕获阶段）拿到的，不靠自己的事件。
 *
 * 谁来挂它：等分容器（底部 Dock 的药丸、分段控件）。不等分的容器用不了 ——
 * 位移是按「自己的宽度 × 索引」算的，容器必须 n 等分。
 */
const props = defineProps<{
  /** 当前活动项的索引 */
  index: number
  /** 等分份数（与容器的 `--n` 一致） */
  count: number
}>()

const root = ref<HTMLElement | null>(null)
/** 每个实例独立的滤镜 id：同一页可以并存两个 thumb（Dock 与设置页的分段控件） */
const uid = Math.random().toString(36).slice(2, 8)
const filterId = `blob-goo-${uid}`

/**
 * goo 的模糊半径按**容器高度**推（58px 的底栏 → 8px，32px 的分段控件 → 4.5px）。
 * 写死一个数必然一头不对：小的那个糊成一团、大的那个看不出融合。
 */
const blur = ref(8)
/** 触点 blob 的横向位置（容器内 px）；null = 没有按下 */
const pressX = ref<number | null>(null)
/** 位移形变：只在索引变化后的一段时间里挂 keyframe */
const travelling = ref(false)

let host: HTMLElement | null = null
let resizeObserver: ResizeObserver | null = null
let travelTimer: ReturnType<typeof setTimeout> | null = null
let travelRaf = 0

const style = computed<Record<string, string>>(() => ({
  '--i': String(props.index),
  '--n': String(props.count),
  filter: `url(#${filterId})`,
}))

/** 形变与位移必须同长：读的就是同一个令牌，改 tokens.css 不会让两边漂 */
function travelMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim()
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return 480
  return raw.endsWith('ms') ? n : n * 1000
}

function measure(): void {
  const h = root.value?.getBoundingClientRect().height ?? 0
  if (h > 0) blur.value = Math.max(2, +(h * 0.14).toFixed(2))
}

/** 触点在容器内的横向位置。监听挂在**父元素**上（捕获阶段）：本层是 pointer-events: none，
 *  拿不到事件；捕获阶段也顺带绕开按钮自己 stopPropagation 的可能。 */
function onDown(e: PointerEvent): void {
  const rect = host?.getBoundingClientRect()
  if (!rect) return
  pressX.value = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
}

function clearPress(): void {
  pressX.value = null
}

onMounted(() => {
  host = root.value?.parentElement ?? null
  host?.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointerup', clearPress, true)
  window.addEventListener('pointercancel', clearPress, true)
  measure()
  if (root.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(root.value)
  }
})

onBeforeUnmount(() => {
  host?.removeEventListener('pointerdown', onDown, true)
  window.removeEventListener('pointerup', clearPress, true)
  window.removeEventListener('pointercancel', clearPress, true)
  resizeObserver?.disconnect()
  if (travelTimer) clearTimeout(travelTimer)
  if (travelRaf) cancelAnimationFrame(travelRaf)
})

watch(
  () => props.index,
  () => {
    // 先摘掉再在下一帧挂上：同一个元素上 false→true 不会重跑 keyframe
    travelling.value = false
    if (travelRaf) cancelAnimationFrame(travelRaf)
    travelRaf = requestAnimationFrame(() => {
      travelling.value = true
      if (travelTimer) clearTimeout(travelTimer)
      travelTimer = setTimeout(() => {
        travelling.value = false
      }, travelMs())
    })
  },
)
</script>

<template>
  <div ref="root" class="gthumb" :class="{ travelling }" :style="style" aria-hidden="true">
    <!-- 滤镜定义不参与绘制：0×0 + 溢出裁掉。**不能 display:none** —— 那样有些内核
         解析不到这个 id，引用它的 filter 会整条失效 -->
    <svg class="gdefs" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter :id="filterId" color-interpolation-filters="sRGB" x="-30%" y="-30%" width="160%" height="160%">
          <!-- 先糊开，再把 alpha 拉成硬边：alpha 0.447 是分界（19a − 8 = 0.5），
               两颗球的 alpha 斜坡在分界处连成一片 —— 那就是「液态桥」。
               这两个数是标准 goo 配方（比 24/−12 软一档，融合看起来是"黏"而不是"焊") -->
          <feGaussianBlur in="SourceGraphic" :stdDeviation="blur" result="b" />
          <feColorMatrix
            in="b"
            type="matrix"
            values="1 0 0 0 0
                    0 1 0 0 0
                    0 0 1 0 0
                    0 0 0 19 -8"
          />
        </filter>
      </defs>
    </svg>

    <!-- 活动 blob：位移走 translate（可过渡），形变走 scale（keyframe），互不覆写。
         padding + background-clip: content-box = 视觉内缩，而几何仍是满格 ——
         位移按「自己宽度 × 索引」算，容器等分才成立，所以缩进不能进几何。 -->
    <span class="blob" />
    <!-- 触点 blob：从按下的那一点长出来，与活动 blob 融合；抬手消失、形状分裂 -->
    <span v-if="pressX !== null" class="blob press" :style="{ left: `${pressX}px` }" />
  </div>
</template>

<style scoped>
.gthumb {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  /* 浓度在这里，不在 blob 上：goo 会把半透明输入推成实色（见文件头第 3 条） */
  opacity: var(--glass-blob-a, 0.62);
}

/* 0×0 的定义宿主：不参与布局，也不参与绘制 */
.gdefs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

.blob {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: calc(100% / var(--n));
  /* 视觉内缩：几何仍是满格（位移按「自己宽度 × 索引」算，容器等分才成立）。
     内缩量由调用处给 —— 58px 的底栏药丸要 4/5px，32px 的分段控件只要 2px，
     写死一头必然不对。 */
  padding: var(--thumb-inset-y, 4px) var(--thumb-inset-x, 5px);
  background: var(--glass-blob, #fff);
  background-clip: content-box;
  border-radius: var(--radius-full);
  translate: calc(var(--i) * 100%) 0;
  transition: translate var(--dur-slow) var(--ease-liquid);
}

/* 位移途中的形变：加速段拉宽压扁、减速段收窄拉高（苹果那条"由力而非速度决定的形变"）。
   用独立属性 scale，所以与上面那条 translate 过渡并行生效，不会互相打断。 */
.gthumb.travelling .blob:not(.press) {
  animation: blob-travel var(--dur-slow) var(--ease-liquid);
}

@keyframes blob-travel {
  0% {
    scale: 1 1;
  }
  28% {
    scale: 1.16 0.92;
  }
  62% {
    scale: 0.95 1.05;
  }
  100% {
    scale: 1 1;
  }
}

/* 触点 blob：正圆，居中在触点上。只动 scale —— 动 opacity 会让融合体一半深一半浅 */
.blob.press {
  top: calc(var(--thumb-inset-y, 4px) + 2px);
  bottom: calc(var(--thumb-inset-y, 4px) + 2px);
  width: auto;
  aspect-ratio: 1;
  padding: 0;
  translate: none;
  transform: translateX(-50%);
  animation: blob-press var(--dur-base) var(--ease-liquid);
}

@keyframes blob-press {
  from {
    scale: 0.15;
  }
  to {
    scale: 1;
  }
}
</style>
