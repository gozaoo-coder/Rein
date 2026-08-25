<script setup lang="ts">
import RingProgress from './RingProgress.vue'

export interface RingItem {
  key: string
  /** 0~1+ */
  value: number
  colorVar: string
}

/** Apple Fitness 式三环（同心、外大内小）。 */
withDefaults(
  defineProps<{
    rings: RingItem[]
    size?: number
  }>(),
  { size: 100 },
)
</script>

<template>
  <div class="rings" :style="{ width: `${size}px`, height: `${size}px` }">
    <RingProgress
      v-for="(r, i) in rings"
      :key="r.key"
      class="layer"
      :value="r.value"
      :color-var="r.colorVar"
      :size="size - i * (size * 0.24)"
      :stroke="[10, 12, 15][i] ?? 10"
    />
  </div>
</template>

<style scoped>
.rings {
  position: relative;
  flex: none;
}

.layer {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>
