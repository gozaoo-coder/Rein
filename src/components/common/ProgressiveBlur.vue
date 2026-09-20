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
  // 容器级全局渐隐：各层的阶梯衰减叠一条「整段淡出到零」的总包络，
  // 最弱层的收尾不再在遮罩底边形成可感知的硬边（高饱和大色块滚过时尤其明显）。
  // 方向翻转已由 to bottom/top 承担，两个方向共用同一条 stop 表达式。
  return {
    containerMask: `linear-gradient(to ${to}, #000 0%, #000 55%, transparent 100%)`,
    layers: Array.from({ length: props.layers }, (_, k) => {
      const i = k + 1
      const solid = ((props.layers - i) / props.layers) * 100
      const stop = solid + 100 / props.layers
      return {
        i,
        blur: `${(i * props.step).toFixed(1)}px`,
        mask: `linear-gradient(to ${to}, #000 0%, #000 ${solid}%, transparent ${stop}%)`,
      }
    }),
  }
})
</script>

<template>
  <div class="pblur" aria-hidden="true" :style="{ '--pm': blurLayers.containerMask }">
    <span v-for="l in blurLayers.layers" :key="l.i" :style="{ '--b': l.blur, '--m': l.mask }" />
  </div>
</template>

<style scoped>
.pblur {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* 总包络：整段从强端向弱端淡出到零，抹平各层阶梯收尾的硬边 */
  mask-image: var(--pm);
  -webkit-mask-image: var(--pm);
  /* 挂载淡入：路由进场 / v-if 切回高画质档时，遮罩从透明淡入而不是闪现 */
  animation: pblur-in var(--dur-base) var(--ease-out);
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
  backdrop-filter: blur(var(--b));
  -webkit-backdrop-filter: blur(var(--b));
  mask-image: var(--m);
  -webkit-mask-image: var(--m);
}
</style>
