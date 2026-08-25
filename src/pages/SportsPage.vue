<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Dumbbell, Footprints, PenLine } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import ExerciseWeekCard from '@/components/exercise/ExerciseWeekCard.vue'
import PlanRecentCard from '@/components/exercise/PlanRecentCard.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import WorkoutDetailDrawer from '@/components/exercise/WorkoutDetailDrawer.vue'
import WorkoutRow from '@/components/exercise/WorkoutRow.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import TodoListCard from '@/components/todo/TodoListCard.vue'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { useTodoStore } from '@/stores/todo'
import type { Workout } from '@/types'
import { todayStr } from '@/utils/date'

/** 运动页（训练主页）：周概览 + 跑步/手动记快速入口 + 课程启动 + 运动待办 + 最近记录详情。 */
const router = useRouter()
const ex = useExerciseStore()
const todo = useTodoStore()
const nutrition = useNutritionStore()
const today = todayStr()

onMounted(() => {
  void ex.loadWeek(today)
  void todo.loadDay(today)
  void nutrition.loadSummary(today)
  void nutrition.loadProfile()
})

const manualOpen = ref(false)
const detailOpen = ref(false)
const detailWorkout = ref<Workout | null>(null)

function openDetail(w: Workout): void {
  detailWorkout.value = w
  detailOpen.value = true
}
</script>

<template>
  <div class="page">
    <PageHeader title="运动" :subtitle="`本周 ${ex.weekMinutes} 分钟 · ${ex.weekKcal} 大卡`" />

    <!-- 整卡可点 → 全部运动记录二级页 -->
    <ExerciseWeekCard link-to="/sports/records" />

    <!-- 异常中断恢复提示已由导航栏上方的悬浮运动条（ActiveWorkoutBar）接管 -->

    <!-- 训练启动：跑步（沉浸 GPS）＋ 手动记（快速补录，类型/时长/强度） -->
    <ul class="quick">
      <li>
        <QuickTile label="跑步" icon-bg="rgba(146, 232, 42, 0.18)" icon-color="#5ba800" @click="router.push('/session/run')">
          <Footprints :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="手动记" icon-bg="rgba(10, 132, 255, 0.12)" icon-color="#0a84ff" @click="manualOpen = true">
          <PenLine :size="20" />
        </QuickTile>
      </li>
    </ul>

    <!-- 训练启动：最近使用的三个课程（全部课程在二级页） -->
    <PlanRecentCard />

    <!-- 运动类待办（与待办域联动） -->
    <TodoListCard :date="today" title="运动计划" filter-category="workout" />

    <!-- 最近运动 -->
    <section class="card">
      <header class="head"><h2>最近运动</h2></header>
      <EmptyState v-if="ex.recent.length === 0" :icon="Dumbbell" title="本周还没有运动记录" hint="在上方「运动计划」中安排运动" />
      <ul v-else class="list">
        <WorkoutRow
          v-for="w in ex.recent"
          :key="w.id"
          :workout="w"
          @detail="openDetail(w)"
          @remove="ex.remove(w.id)"
        />
      </ul>
    </section>

    <!-- 运动详情抽屉（Teleport；保证页面单根） -->
    <WorkoutDetailDrawer :open="detailOpen" :workout="detailWorkout" @close="detailOpen = false" />

    <!-- 手动记运动 -->
    <AddWorkoutSheet :open="manualOpen" @close="manualOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* 快速入口：与主页同款四列磁贴网格 */
.quick {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin: 14px 0;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.list {
  margin-top: 6px;
}
</style>
