<script setup lang="ts">
import { computed } from 'vue'

/**
 * 渐进模糊遮罩：内容从模糊里淡出，而不是被一条硬边切掉。
 *
 * 做法（同 vue-bits GradualBlur）：多层 backdrop-filter 叠起来——后一层把前一层的
 * 结果再模糊一次——各自用 mask 梯度限制在一段纵向区间里，越靠「强端」被模糊的次数
 * 越多，强度自上（下）而下（上）递减。层数越多过渡越顺滑，但每层都是一次独立合成，
 * 代价同步上涨。
 *
 * ⚠️ 遮罩只能挂在**层自己**身上，绝不能挪到容器：带 mask（或 filter、opacity<1）的元素
 * 会成为 backdrop-filter 的 backdrop root，子层于是在容器**内部**采样——而容器里除了
 * 这几层半透明的东西空无一物，整块渐进模糊就渲染成「什么都没有」，页面看着像没做模糊。
 * 真实表现：DOM 里 5 层俱在、计算样式全对，屏幕上一片干净（e2e 只看计算样式时抓不到）。
 * 同一个坑还有两个变体，实测都不行：给容器加 mask、给层加多重 mask 求交
 * （mask-composite: intersect 会直接让该层失去 backdrop-filter）。
 * 所以「总包络」折进最弱那一层的梯度里（见下），全程只有一层一个 mask。
 *
 * direction：'down' = 顶部最强（页头，内容往下淡出）；'up' = 底部最强（底栏，内容往上淡出）。
 * 定位交给使用方：组件自身 absolute + inset 0，父容器负责覆盖范围与 z-index（-1 沉到内容背后）。
 */
const props = withDefaults(
  defineProps<{
    direction?: 'down' | 'up'
    /** 层数：5 层在手机上是「够顺滑且几乎看不出分层」的甜点 */
    layers?: number
    /** 每层递增量（px）：总模糊 ≈ layers × step */
    step?: number
  }>(),
  { direction: 'down', layers: 5, step: 1.6 },
)

/** 总包络起点（%）：最后收尾的那层从这里淡到远端，整叠透明度在尾段平滑归零 */
const ENVELOPE_FROM = 55

const blurLayers = computed(() => {
  const to = props.direction === 'down' ? 'bottom' : 'top'
  const n = props.layers
  const band = 100 / n
  return Array.from({ length: n }, (_, k) => {
    // i = 1 是最弱的一层（只叠一次），i = n 最强——最强的只铺最靠强端的一段，
    // 越弱铺得越深，于是「越靠强端被模糊的次数越多」。
    const i = k + 1
    const solid = ((n - i) / n) * 100
    // 总包络：整段渐隐原本靠容器上的第二条 mask 实现，但那会打断 backdrop-filter
    // （见文件头）。最弱那层本来就铺满整段，让它独自承担这条包络——收尾从 55% 一路
    // 淡到远端，其余层各在自己的 band 内收尾。数学上与原「层梯度 × 容器包络」的
    // 差别不超过 0.1 的 alpha，肉眼无差。
    const last = i === 1
    const fadeFrom = last ? Math.min(ENVELOPE_FROM, solid) : solid
    const fadeTo = last ? 100 : solid + band
    return {
      i,
      blur: `${(i * props.step).toFixed(1)}px`,
      mask: `linear-gradient(to ${to}, #000 0%, #000 ${fadeFrom}%, transparent ${fadeTo}%)`,
    }
  })
})
</script>

<template>
  <div class="pblur" aria-hidden="true">
    <span v-for="l in blurLayers" :key="l.i" :style="{ '--b': l.blur, '--m': l.mask }" />
  </div>
</template>

<style scoped>
.pblur {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* 容器上不许有 mask / filter，也不许做透明度动画——任何一项都会让它成为 backdrop root，
     子层的模糊随即整段失效（见文件头）。所以容器只负责定位，显隐与淡入全交给「层」。 */
}

@keyframes pblur-in {
  from {
    opacity: 0;
  }
}

.pblur span {
  position: absolute;
  inset: 0;
  /* 独立合成层：页面进场的 opacity 过渡期间，带 mask 的 backdrop-filter 可能被
     合成器整层丢掉遮罩——糊出一块硬边矩形（顶部异常分割）。translateZ(0) 让每层
     保有自己的图层与遮罩，祖先做透明度动画时也稳定。 */
  transform: translateZ(0);
  /* 挂载淡入：路由进场 / v-if 切回高画质档时从透明淡入。只能挂在这里——
     挂在容器上的写法实测是**空转**：过渡期间容器 opacity<1，模糊压根不渲染，
     0.2 秒后过渡结束才「啪」地弹出来，看着像闪现而不是淡入。 */
  animation: pblur-in var(--dur-base) var(--ease-out);
  backdrop-filter: blur(var(--b));
  -webkit-backdrop-filter: blur(var(--b));
  mask-image: var(--m);
  -webkit-mask-image: var(--m);
}
</style>
