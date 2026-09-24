<script setup lang="ts">
import { ref } from 'vue'
import { ChevronLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import ProgressiveBlur from '@/components/common/ProgressiveBlur.vue'
import { usePressGlow } from '@/composables/usePressGlow'
import { useScrolled, useScrollCollapsed } from '@/composables/useScrolled'
import { perfDegraded } from '@/system/perf'

/** iOS 大标题页头；back = 二级页返回键（有来路则返回，直链进入回首页）。
 *  compact = 导航条模式（对话/工具页）：单行小标题、按钮居中，把纵向空间留给内容。
 *
 *  页头固定：sticky 顶住滚动容器（移动端滚文档、桌面滚 .desk-main，同一份 CSS 两边
 *  都成立；若用 fixed，桌面壳里会跑到导航轨与信息栏底下）。页面一滚起来就在背后压
 *  一层渐进模糊遮罩（ProgressiveBlur）——内容从模糊里淡出，而不是被一条硬边切掉。
 *  掉帧降级（system/perf）时同位置换成底色遮罩，不做 backdrop-filter。
 *
 *  两个安全区变量，默认值就是「整页滚动」这一最常见形态；页头被放进独立滚动容器
 *  （如 AI 页的消息区）时由使用方覆写：
 *  - `--ph-stick`：粘住的纵向偏移。默认 `--safe-top`——状态栏区域不属于任何滚动容器，
 *    页头粘在视口顶（0）会直接压进手机顶部消息栏，必须让开这段；
 *  - `--ph-up`：遮罩向上铺出的量。默认与 `--ph-stick` 相同：粘在 safe-top 时遮罩正好
 *    铺满状态栏那条，滚上去的内容在那一段里也是糊的。 */
defineProps<{
  title: string
  subtitle?: string
  back?: boolean
  compact?: boolean
}>()

const router = useRouter()
const root = ref<HTMLElement | null>(null)
const scrolled = useScrolled(root)
/** 丰富档的滚动边缘：向下滚收起、向上滚还原（判定与理由见 composables/useScrolled） */
const collapsed = useScrollCollapsed(root)

/** 按压定向光晕（丰富档）：页头这两处圆钮是控制层里按得最多的。
 *  `.hdr-btn` 在各页的插槽里（挂类不写样式，见 docs/ARCHITECTURE.md 的页头按钮规范），
 *  所以这里按 selector 就近匹配，而不是靠它们自己挂一个标记类。 */
usePressGlow(root, '.back, .hdr-btn')

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
  <header ref="root" class="page-header" :class="{ compact, scrolled, collapsed, lite: perfDegraded }">
    <!-- 遮罩：只在页面滚起来后显形（顶部没有内容经过时不该出现任何底色） -->
    <div class="ph-mask" aria-hidden="true">
      <!-- 超高 + 已滚起时的底色垫层（苹果的「硬边缘」变体）：模糊之下再压一层画布色的
           渐变，标题的落点更明确。垫在模糊**之下**（DOM 在前 = 先画），所以它是
           "内容褪成底色、再被糊开"，而不是"在模糊上又糊一层色"。纯渐变，零合成成本。 -->
      <span class="ph-scrim" />
      <ProgressiveBlur v-if="!perfDegraded" direction="down" />
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
  --ph-stick: var(--safe-top);
  --ph-up: var(--safe-top);
  position: sticky;
  top: var(--ph-stick);
  z-index: 30;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 8px 2px 14px;
  /* 遮罩在页头下缘之外多铺一段，模糊才有化开的空间 */
  --ph-tail: 14px;
}

/* 渐进模糊遮罩（模糊本身见 ProgressiveBlur 组件）：
   - 向上多铺 --ph-up：页头粘在 safe-top 时正好盖住状态栏那条（桌面为 0，等于没铺）；
     页头被放进独立滚动容器时（AI 页）由使用方覆写成容器内的可裁切余量
   - 向下多铺 --ph-tail：模糊在页头下缘之外收尾，不留硬边
   - 左右铺回页面横向内边距（--ph-bleed 可被页面覆写）：把整帧宽一起盖住，
     否则两侧会露出未模糊的窄条 */
.ph-mask {
  position: absolute;
  top: calc(-1 * var(--ph-up));
  left: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  right: calc(-1 * var(--ph-bleed, var(--page-pad-x)));
  bottom: calc(-1 * var(--ph-tail));
  z-index: -1;
  pointer-events: none;
}

/* 模糊层的显隐只能挂在「层自己」身上：容器一旦 opacity<1 就成为 backdrop-filter 的
   backdrop root，过渡那 0.2 秒里模糊根本不渲染，结束后才「啪」地弹出来（看着像闪现）。
   详见 ProgressiveBlur 的文件头。 */
.ph-mask :deep(.pblur span) {
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
}

.page-header.scrolled .ph-mask :deep(.pblur span) {
  opacity: 1;
}

/* 降级档（system/perf 判定掉帧）：不做毛玻璃，改用「画布底色 → 透明」的渐变遮罩。
   底色是 --bg 而非 --surface：遮罩压的是页面画布，不是卡片。
   这条是纯渐变背景、不涉及 backdrop-filter，照旧用容器自身的透明度淡入。 */
.page-header.lite .ph-mask {
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
  background: linear-gradient(to bottom, var(--bg) 0%, var(--bg) 55%, transparent 100%);
}

.page-header.lite.scrolled .ph-mask {
  opacity: 1;
}

/* 超高档的底色垫层（苹果的「硬边缘」变体）：只有超高才有 —— 它属于材质档位，
   不是动效（动效是下面那两条 scale）。不加 --bg 垫层时，页头压的是"内容被糊开"，
   标题与内容的分离靠模糊本身；加一层同色渐变后，标题的落点更明确。
   显隐只能挂在这层自己身上，与 .pblur 同一条理由（祖先一旦 opacity<1 就成了
   backdrop root，子层的模糊整段失效）。 */
.ph-scrim {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-out);
  background: linear-gradient(to bottom, var(--bg) 0%, transparent 72%);
}

html[data-perf='ultra'] .page-header.scrolled .ph-scrim {
  opacity: 0.6;
}

/* ---------- 丰富档：滚动边缘（苹果）----------
   向下滚时页头缩一档、把注意力让给内容；向上滚立刻还原 —— 判断的是**方向**不是位置，
   理由见 composables/useScrolled 的 useScrollCollapsed。

   两处刻意的选择：
   · 只动 scale，不动字号/内边距 —— 改布局属性会让整页在滚动中重排，那是掉帧的直接来源；
     用独立属性 `scale`（不是 transform）是为了与按压反馈**并存**：圆钮的
     `:active { transform: scale(0.92) }` 走 transform，两个属性互不覆写，
     缩着的状态下按下去照样有挤压反馈。
   · transform-origin 落在左下：标题与圆钮都是自左往右长出来的，从左边缩才不会
     "整体往左挪一格"。 */
html[data-motion='rich'] .page-header h1,
html[data-motion='rich'] .page-header p,
html[data-motion='rich'] .page-header .back,
html[data-motion='rich'] .page-header :slotted(.hdr-btn) {
  transform-origin: left bottom;
  transition: scale var(--dur-base) var(--ease-out);
}

html[data-motion='rich'] .page-header.collapsed h1,
html[data-motion='rich'] .page-header.collapsed p,
html[data-motion='rich'] .page-header.collapsed .back,
html[data-motion='rich'] .page-header.collapsed :slotted(.hdr-btn) {
  scale: 0.94;
}

.back {
  position: relative;
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

/* 返回键与页头图标钮：视觉尺寸不动，命中区撑到 44×44。
   38 是这些圆钮的视觉规格，不该为了触控改掉；但 44 是拇指的下限，
   而返回是每个二级页**唯一**的退路（图标钮则常常是这一页唯一的设置入口）。
   横向外扩 3px：同一排按钮间隔 12px，不会互相压住。 */
.back::after,
.page-header :slotted(.hdr-btn)::after {
  content: '';
  position: absolute;
  inset: -3px;
}

/* 页头图标按钮统一规范（lead / action 插槽内使用 class="hdr-btn"）：
   与返回键同尺寸同材质；accent 变体留给正向 CTA（如“添加”）。 */
.page-header :slotted(.hdr-btn) {
  position: relative;
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

/* 丰富档：按压定向光晕（位置来自 composables/usePressGlow，显隐交给 :active）。
   这两处圆钮走 background-image 那一层，不用 ::after —— 它们的 ::after 已经被
   44×44 的命中区占掉了（见上面的 .back::after）。accent 变体也一并点亮：
   它压的是主色实底，一层白光晕正是"按下去发光"该有的样子。 */
html[data-motion='rich'] .page-header .back:active,
html[data-motion='rich'] .page-header :slotted(.hdr-btn):active {
  background-image: radial-gradient(
    circle 70px at var(--gx, 50%) var(--gy, 50%),
    var(--glass-specular),
    transparent 70%
  );
}

/* ---------- 超高档：页头的圆钮也变成玻璃盘 ----------
   一份 :slotted 改动覆盖全部页面的图标钮（各页只挂 hdr-btn 类，不各自写样式 ——
   见 docs/ARCHITECTURE.md 的页头按钮规范），这是"超高铺到全部组件"里性价比最高的一处。

   为什么页头这两颗**不用 SVG 折射**：它们压在页头那层渐进模糊（ProgressiveBlur，
   5 层 backdrop-filter）之上，再叠一次 `url()` 折射既糊又贵，而 38px 的圆上
   折射带只有一两像素、根本看不出来。这里要的是"玻璃盘"的手感：薄底 + 上缘受光
   + 内圈细描边 + 背景模糊 —— 普通 blur 在 38px 上比 url() 便宜一个量级。

   底薄了会不会读不清：圆钮坐落在页头正上方，背后是已经糊过一遍的内容；亮色主题下
   页面本身是浅的，0.42 的白 + 20px 模糊合成出来仍接近白。全屏暗场页面（跑步）不走
   PageHeader，所以不存在"白底压暗图"的组合。 */
html[data-perf='ultra'] .page-header .back,
html[data-perf='ultra'] .page-header :slotted(.hdr-btn:not(.accent)) {
  background: var(--glass-fill);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  box-shadow:
    var(--glass-shadow),
    inset 0 1px 0 var(--glass-rim-hi),
    inset 0 -1px 0 var(--glass-rim-lo),
    inset 0 0 0 1px var(--glass-rim-2);
}

/* 系统要求「减弱透明度」时退回实底 —— 与 .glass-surface 的退化同一条语义 */
@media (prefers-reduced-transparency: reduce) {
  html[data-perf='ultra'] .page-header .back,
  html[data-perf='ultra'] .page-header :slotted(.hdr-btn:not(.accent)) {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow: var(--shadow-card);
  }
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
