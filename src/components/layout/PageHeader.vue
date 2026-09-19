<script setup lang="ts">
import { ref } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import { useScrolled } from '@/composables/useScrolled'
import { perfDegraded } from '@/system/perf'

/** iOS 大标题页头；back = 二级页返回键（有来路则返回，直链进入回首页）。
 *  compact = 导航条模式（对话/工具页）：单行小标题、按钮居中，把纵向空间留给内容。
 *
 *  页头固定：sticky 顶住滚动容器（移动端滚文档、桌面滚 .desk-main，同一份 CSS 两边
 *  都成立；若用 fixed，桌面壳里会跑到导航轨与信息栏底下）。页面一滚起来就在背后压
 *  一层渐进模糊遮罩——内容从模糊里淡出，而不是被一条硬边切掉。
 *  掉帧降级（system/perf）时同位置换成底色遮罩，不做 backdrop-filter。 */
defineProps<{
  title: string
  subtitle?: string
  back?: boolean
  compact?: boolean
}>()

/** 渐进模糊层数 / 每层递增量：多层 backdrop-filter 叠起来（后一层把前一层的结果
 *  再模糊一次），各自用 mask 梯度限制在一段纵向区间里，越靠上被模糊的次数越多，
 *  于是强度自上而下递减——即 vue-bits GradualBlur 的做法。层数越多过渡越顺滑，
 *  但每层都是一次独立合成，代价同步上涨。 */
const BLUR_LAYERS = 5
const BLUR_STEP = 1.6

const blurLayers = Array.from({ length: BLUR_LAYERS }, (_, k) => {
  const i = k + 1
  const solid = ((BLUR_LAYERS - i) / BLUR_LAYERS) * 100
  return {
    i,
    blur: `${(i * BLUR_STEP).toFixed(1)}px`,
    mask: `linear-gradient(to bottom, #000 0%, #000 ${solid}%, transparent ${solid + 100 / BLUR_LAYERS}%)`,
  }
})

const router = useRouter()
const root = ref<HTMLElement | null>(null)
const scrolled = useScrolled(root)

function goBack(): void {
  const state: unknown = window.history.state
  if (state !== null && typeof state === 'object' && 'back' in state && state.back != null) {
    router.back()
  } else {
    void router.replace('/')
  }
}
</script>

<template>
  <header ref="root" class="page-header" :class="{ compact, scrolled, lite: perfDegraded }">
    <!-- 遮罩：只在页面滚起来后显形（顶部没有内容经过时不该出现任何底色） -->
    <div class="ph-mask" aria-hidden="true">
      <template v-if="!perfDegraded">
        <span v-for="l in blurLayers" :key="l.i" :style="{ '--b': l.blur, '--m': l.mask }" />
      </template>
    </div>

    <slot name="lead" />
    <button v-if="back" class="back" aria-label="返回" @click="goBack">
      <ChevronLeft :size="21" :stroke-width="2.4" />
    </button>
    <div class="flex-1">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <slot name="action" />
  </header>
</template>

<style scoped>
.page-header {
  /* sticky 而非 fixed：贴住最近滚动容器的顶。滚动容器在两种壳下不同
     （移动端是文档、桌面是 .desk-main），sticky 两个都对，fixed 会跑偏。
     z-index 除了抬层级，还负责建立层叠上下文——遮罩用 -1 沉到页头内容背后，
     有上下文它才不会被甩到页面内容下面去。 */
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 8px 2px 14px;
  /* 遮罩在页头下缘之外多铺一段，模糊才有化开的空间 */
  --ph-tail: 14px;
}

/* 渐进模糊遮罩（结构见 script：多层 backdrop-filter + mask 梯度）：
   - 向上多铺 --safe-top：滚动时把状态栏区域一并盖住（桌面为 0，等于没铺）
   - 向下多铺 --ph-tail：模糊在页头下缘之外收尾，不留硬边
   - 左右铺回页面横向内边距（--ph-bleed 可被页面覆写）：把整帧宽一起盖住，
     否则两侧会露出未模糊的窄条。移动端窗口滚动时若真用 fixed 才需要
     额外的状态栏处理，sticky 下这段偏移就是全部。 */
.ph-mask {
  position: absolute;
  top: calc(-1 * var(--safe-top));
  left: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  right: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  bottom: calc(-1 * var(--ph-tail));
  z-index: -1;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
}

.page-header.scrolled .ph-mask {
  opacity: 1;
}

/* 单层：把背景模糊一次，再用 mask 梯度把自己限制在 [0, solid+1/N] 这段区间里 */
.ph-mask span {
  position: absolute;
  inset: 0;
  backdrop-filter: blur(var(--b));
  -webkit-backdrop-filter: blur(var(--b));
  mask-image: var(--m);
  -webkit-mask-image: var(--m);
}

/* 降级档（system/perf 判定掉帧）：不做毛玻璃，改用「画布底色 → 透明」的渐变遮罩。
   底色是 --bg 而非 --surface：遮罩压的是页面画布，不是卡片。 */
.page-header.lite .ph-mask {
  background: linear-gradient(to bottom, var(--bg) 0%, var(--bg) 55%, transparent 100%);
}

.back {
  width: 38px;
  height: 38px;
  flex: none;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 页头图标按钮统一规范（lead / action 插槽内使用 class="hdr-btn"）：
   与返回键同尺寸同材质；accent 变体留给正向 CTA（如“添加”）。 */
.page-header :slotted(.hdr-btn) {
  width: 38px;
  height: 38px;
  flex: none;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.page-header :slotted(.hdr-btn:active) {
  transform: scale(0.92);
}

.page-header :slotted(.hdr-btn.accent) {
  background: var(--accent);
  color: var(--on-accent);
}

h1 {
  font-size: var(--fs-large-title);
  font-weight: 700;
  letter-spacing: -0.6px;
  line-height: 1.15;
}

p {
  margin-top: 2px;
  font-size: var(--fs-footnote);
  color: var(--text-2);
  font-weight: 500;
}

/* 紧凑导航条：17px 单行标题（iOS 导航条规格），图标按钮改为垂直居中 */
.page-header.compact {
  align-items: center;
  padding: 4px 2px 10px;
}

.page-header.compact h1 {
  font-size: var(--fs-headline);
  letter-spacing: -0.3px;
  line-height: 1.2;
}

.page-header.compact .back,
.page-header.compact :slotted(.hdr-btn) {
  margin-bottom: 0;
}
</style>
