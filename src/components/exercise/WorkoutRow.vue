<script setup lang="ts">
import { computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import { WORKOUT_META } from '@/config/domain'
import { fmtDateCn, minToHHmm } from '@/utils/date'
import type { Workout, WorkoutType } from '@/types'

/** 运动记录行：运动页「最近运动」与全部运动记录页共用。
 *  点击行 → detail 事件（父级开详情抽屉）；悬浮/长显删除按钮 → remove 事件。 */
const props = withDefaults(
  defineProps<{
    workout: Workout
    /** 分组列表（按日/按月）下组头已含日期，置 false 避免重复 */
    showDate?: boolean
  }>(),
  { showDate: true },
)

defineEmits<{ detail: []; remove: [] }>()

const typeLabel = computed(() => WORKOUT_META[props.workout.type as WorkoutType].label)

const metaLine = computed(() => {
  const parts: string[] = []
  if (props.showDate) parts.push(fmtDateCn(props.workout.date))
  if (props.workout.startMin != null) parts.push(minToHHmm(props.workout.startMin))
  parts.push(typeLabel.value)
  return parts.join(' · ')
})
</script>

<template>
  <li
    class="row item"
    role="button"
    tabindex="0"
    @click="$emit('detail')"
    @keydown.enter="$emit('detail')"
  >
    <i class="ic col center">{{ typeLabel.slice(0, 1) }}</i>
    <div class="flex-1">
      <p class="name">{{ workout.name }}</p>
      <p class="meta num">{{ metaLine }}</p>
    </div>
    <div class="col right">
      <b class="num kcal">-{{ workout.kcal }}</b>
      <span class="unit num">{{ workout.durationMin }} 分钟</span>
    </div>
    <button class="del" aria-label="删除记录" @click.stop="$emit('remove')">
      <Trash2 :size="16" />
    </button>
  </li>
</template>

<style scoped>
.item {
  gap: 12px;
  padding: 12px 0;
  cursor: pointer;
}

/* 分隔线用 :not(:first-child)：跨组件实例的同级 li 依然成立 */
.item:not(:first-child) {
  border-top: 0.5px solid var(--line);
}

.ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: var(--radius-m);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-weight: 800;
  font-size: var(--fs-callout);
}

.name {
  font-size: var(--fs-body);
  font-weight: 600;
}

.meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.right {
  align-items: flex-end;
  flex: none;
}

.kcal {
  color: var(--c-exercise-deep);
  font-weight: 800;
  font-size: var(--fs-callout);
}

.unit {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.del {
  color: var(--text-3);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.item:hover .del {
  opacity: 1;
}

@media (hover: none) {
  .del {
    opacity: 0.55;
  }
}
</style>
