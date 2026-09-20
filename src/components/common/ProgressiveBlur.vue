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

const blurLayers = computed(() => {
  const to = props.direction === 'down' ? 'bottom' : 'top'
  return Array.from({ length: props.layers }, (_, k) => {
    const i = k + 1
    const solid = ((props.layers - i) / props.layers) * 100
    const stop = solid + 100 / props.layers
    return {
      i,
      blur: `${(i * props.step).toFixed(1)}px`,
      mask: `linear-gradient(to ${to}, #000 0%, #000 ${solid}%, transparent ${stop}%)`,
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
}

.pblur span {
  position: absolute;
  inset: 0;
  backdrop-filter: blur(var(--b));
  -webkit-backdrop-filter: blur(var(--b));
  mask-image: var(--m);
  -webkit-mask-image: var(--m);
}
</style>
