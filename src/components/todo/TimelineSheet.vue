<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { fmtDateCn } from '@/utils/date'
import type { Todo } from '@/types'
import VirtualTimeline from './VirtualTimeline.vue'

/** 完整时间线抽屉：虚拟化连续时间轴（含历史/未来），打开时自动定位到"现在"附近。 */
const props = defineProps<{
  open: boolean
  date: string
  todos: Todo[]
}>()

const emit = defineEmits<{ close: [] }>()

const timeline = ref<InstanceType<typeof VirtualTimeline> | null>(null)

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    // 抽屉重开时（v-if 每次挂载）内部已自动锚定；调用一次兜底
    timeline.value?.scrollToNow()
  },
)
</script>

<template>
  <SheetModal :open="open" initial-snap="large" :title="`${fmtDateCn(date)} 时间线`" @close="emit('close')">
    <VirtualTimeline ref="timeline" :todos :date />
  </SheetModal>
</template>
