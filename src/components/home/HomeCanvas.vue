<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import CanvasTimeline from '@/components/todo/CanvasTimeline.vue'
import CourseDetailSheet from '@/components/campus/CourseDetailSheet.vue'
import TodoEditorSheet from '@/components/todo/TodoEditorSheet.vue'
import { MEAL_LABELS, MEAL_META, mealKcal } from '@/config/domain'
import { useScheduleUndo } from '@/composables/useScheduleUndo'
import { useDietStore } from '@/stores/diet'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 主页画布：把「今日画布」带上主页——未安排池 + 紧凑时间轴（现在线 / 打勾 / 拖拽改位），
 * 主页从「看今天」升级为「排今天」。餐次记录以摘要行的形式保持在卡片底部，
 * 与状态条（热量）互补。完整编辑（周视图 / AI 排程 / 快排）仍在 /todos 画布。
 */
const props = defineProps<{ date: string }>()

const router = useRouter()
const diet = useDietStore()
const todo = useTodoStore()
const { applyMove } = useScheduleUndo()

onMounted(() => {
  void diet.load(props.date)
  void todo.loadAll()
})

const scheduled = computed(() => todo.allTodos.filter((t) => t.date === props.date && t.startMin != null))
const pool = computed(() => todo.allTodos.filter((t) => t.date === props.date && t.startMin == null && t.status !== 'done'))
const openCount = computed(() => todo.allTodos.filter((t) => t.status !== 'done').length)

/* 餐次摘要（只读）：保持「吃」在主页时间轴上的存在感 */
const meals = computed(() =>
  diet.grouped.map((g) => {
    const kcal = g.logs.reduce((sum, l) => sum + (mealKcal(l) ?? 0), 0)
    const at = Math.min(...g.logs.map((l) => {
      const d = new Date(l.createdAt)
      return d.getHours() * 60 + d.getMinutes()
    }))
    return { mealType: g.mealType, label: MEAL_LABELS[g.mealType], colorVar: MEAL_META[g.mealType].colorVar, timeMin: at, kcal }
  }),
)

/* 编辑抽屉（点块 / 点池 chip） */
const editorOpen = ref(false)
const editorTarget = ref<Todo | null>(null)
/* 课表派生行走只读详情，不进编辑器。按 id 派生：存对象快照则打卡后面板读到旧对象 */
const courseOpen = ref(false)
const courseId = ref<number | null>(null)
const courseTarget = computed<Todo | null>(
  () => todo.allTodos.find((t) => t.id === (courseId.value ?? -1)) ?? null,
)

function onSelect(t: Todo): void {
  // 课表派生行是只读投影，点开只给看与打卡（见 CourseDetailSheet）
  if (t.courseSessionId != null) {
    courseId.value = t.id
    courseOpen.value = true
    return
  }
  editorTarget.value = t
  editorOpen.value = true
}

function onToggle(t: Todo): void {
  void todo.toggle(t)
}

function onMove(t: Todo, startMin: number): void {
  void applyMove(t, { date: props.date, startMin })
}
</script>

<template>
  <section class="card hcanvas" data-testid="home-canvas">
    <header class="row between head">
      <h2>今日画布</h2>
      <span class="num t-3 meta">{{ scheduled.length }} 个安排 · {{ pool.length }} 条未安排</span>
    </header>

    <!-- 未安排池：点卡片快排（编辑抽屉里落时间） -->
    <div v-if="pool.length" class="pool">
      <button
        v-for="t in pool"
        :key="t.id"
        class="pchip"
        :data-title="t.title"
        @click="onSelect(t)"
      >
        <i class="pdot" />{{ t.title }}
        <em v-if="t.durationMin" class="num">{{ t.durationMin }} 分钟</em>
      </button>
    </div>

    <!-- 紧凑画布：现在线 / 打勾 / 拖拽改位，与 /todos 画布同一组件同一数据。
         卡片右下角编辑钮与点块同一入口（课程派生行转只读详情抽屉）。 -->
    <div class="cwrap">
      <CanvasTimeline
        :date="date"
        :todos="scheduled"
        compact
        @select="onSelect"
        @edit="onSelect"
        @toggle="onToggle"
        @move="onMove"
      />
    </div>

    <!-- 餐次摘要行 -->
    <div v-if="meals.length" class="meals">
      <span
        v-for="m in meals"
        :key="m.mealType"
        class="mchip num"
      >
        <i class="mdot" :style="{ background: m.colorVar }" />{{ m.label }} {{ minToHHmm(m.timeMin) }} · {{ Math.round(m.kcal) }} 大卡
      </span>
    </div>
    <p v-else class="mempty t-3">今天还没记饮食 · 下方「记饮食」一键补上</p>

    <button class="foot pressable" @click="router.push('/todos')">
      打开完整画布 <span class="num">{{ openCount }}</span> 条未完成 ›
    </button>

    <TodoEditorSheet :open="editorOpen" :todo="editorTarget" :date="date" @close="editorOpen = false" />
    <CourseDetailSheet
      :open="courseOpen"
      :todo="courseTarget"
      @close="courseOpen = false"
      @toggle="onToggle"
    />
  </section>
</template>

<style scoped>
.hcanvas {
  margin-top: 2px;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head .meta {
  font-size: var(--fs-caption);
}

/* 未安排池：横向 chips，点卡片进编辑抽屉快排 */
.pool {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 10px 0 2px;
}

.pool::-webkit-scrollbar {
  width: 0;
}

.pchip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 72%;
  padding: 7px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
}

.pchip em {
  font-style: normal;
  font-weight: 500;
  color: var(--text-3);
}

.pdot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}

/* 紧凑画布：固定视窗，内部滚动锚定「现在」 */
.cwrap {
  height: 216px;
  margin-top: 10px;
}

/* CanvasTimeline 的 .ctl/.scroll 都是 height:100% 链，视窗高度从这里给 */
.cwrap :deep(.ctl) {
  height: 100%;
}

/* 餐次摘要 */
.meals {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.mchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
}

.mdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.mempty {
  margin-top: 10px;
  font-size: var(--fs-caption);
}

.foot {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--line);
  width: 100%;
  text-align: left;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.foot .num {
  color: var(--accent);
  font-weight: 700;
}
</style>
