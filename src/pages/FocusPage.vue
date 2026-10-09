<script setup lang="ts">
import { onMounted } from 'vue'

import PageHeader from '@/components/layout/PageHeader.vue'
import PomodoroCard from '@/components/pomodoro/PomodoroCard.vue'
import TodoListCard from '@/components/todo/TodoListCard.vue'
import ScheduleCard from '@/components/todo/ScheduleCard.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/** 专注 · 二级页：番茄钟 + 待办 + 日程时间线；完整时间线与超量待办收进抽屉。 */
const today = todayStr()

const pomo = usePomodoroStore()
const todo = useTodoStore()

onMounted(() => {
  void pomo.loadToday()
  void todo.loadDay(today)
})
</script>

<template>
  <div class="page">
    <PageHeader title="专注" subtitle="番茄钟 · 待办 · 日程" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 番茄钟 -->
    <PomodoroCard />

    <!-- 待办（列表内联，超出 4 条收进「全部待办」抽屉） -->
    <TodoListCard :date="today" list-only :inline-limit="4" />

    <!-- 今日日程（时间线预览，完整时间线在抽屉里滑动查看）
         桌面通栏：时间线是横向铺开的刻度轴，590px 的半栏会把「现在」前后压成一团。
         **必须包一层 div**：ScheduleCard 的根是「section + TimelineSheet」两段（多根），
         Vue 不会把外部传进来的 class 落到任何一个根上（控制台会 warn
         "Extraneous non-props attributes"）—— 写在组件标签上的 d-full 是**静默失效**的。
         包一层的代价是这一个 div，换来的是「通栏」真的生效。 -->
    <div class="d-full">
      <ScheduleCard :date="today" />
    </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}
</style>
