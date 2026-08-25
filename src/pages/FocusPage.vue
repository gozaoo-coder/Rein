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

    <!-- 番茄钟 -->
    <PomodoroCard />

    <!-- 待办（列表内联，超出 4 条收进「全部待办」抽屉） -->
    <TodoListCard :date="today" list-only :inline-limit="4" />

    <!-- 今日日程（时间线预览，完整时间线在抽屉里滑动查看） -->
    <ScheduleCard :date="today" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}
</style>
