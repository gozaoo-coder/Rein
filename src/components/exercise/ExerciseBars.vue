<script setup lang="ts">
import { computed } from 'vue'

/** 运动分钟柱状图：本周运动卡与全部运动记录页共用（周=7 柱，年=12 柱）。
 *  highlight 标记「今天 / 当前月」所在柱。 */
const props = defineProps<{
  bars: { label: string; value: number; highlight?: boolean }[]
}>()

const maxMin = computed(() => Math.max(60, ...props.bars.map((b) => b.value)))
</script>

<template>
  <ul class="bars row">
    <li v-for="b in bars" :key="b.label" class="col center barcol">
      <span class="track col">
        <i :style="{ '--p': `${(b.value / maxMin) * 100}%` }" :class="{ today: b.highlight }" />
      </span>
      <span class="num label" :class="{ today: b.highlight }">{{ b.label }}</span>
    </li>
  </ul>
</template>

<style scoped>
.bars {
  justify-content: space-between;
  gap: 4px;
}

.barcol {
  flex: 1;
  gap: 6px;
}

.track {
  width: 18px;
  height: 64px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  justify-content: flex-end;
  overflow: hidden;
}

/* 柱体自底部生长走 clip-path：不触发 layout，圆头随比例保持 */
.track i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--c-exercise);
  opacity: 0.45;
  clip-path: inset(calc(100% - var(--p, 0%)) 0 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
}

.track i.today {
  opacity: 1;
}

.label {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 600;
}

.label.today {
  color: var(--accent);
}
</style>
