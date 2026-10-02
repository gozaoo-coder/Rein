<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'

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
      <div class="row center hright">
        <span class="num t-3 meta">{{ scheduled.length }} 个安排 · {{ pool.length }} 条未安排</span>
        <!-- 「详情 ›」胶囊：取代卡片底部原来那行「打开完整画布 N 条未完成 ›」。
             它本来就是同一件事（进 /todos 看全部），但那一行占了整条卡片宽度、
             还要一条分隔线把它与正文切开，而它承载的只有一个去处的入口 ——
             挪到卡头右侧、收成一枚胶囊，卡片底部就干净了。
             放卡头而不是别处：页头右侧是全应用「进下一层」的位置（各详情卡都在这儿）。 -->
        <button class="detail row center" @click="router.push('/todos')">
          详情 <ChevronRight :size="13" :stroke-width="2.6" />
        </button>
      </div>
    </header>

    <!-- 未安排池：点卡片快排（编辑抽屉里落时间） -->
    <div v-if="pool.length" class="pool" data-rubber-self>
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
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head .meta {
  font-size: var(--fs-caption);
}

/* 未安排池：横向 chips，点卡片进编辑抽屉快排。
   右缘 18px 渐隐宣告「还有更多、可以横滑」——否则最后一颗 chip 被滚动边缘硬裁，
   读起来像布局坏了（低频横滚区没有滚动条可暗示）。 */
.pool {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 10px 0 2px;
  mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent);
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

/* 紧凑画布：固定视窗，高度从这里给（.ctl / .scroll 都是 height:100% 链）。
   ⚠️ 这里**刻意不写 mask-image**：上下缘那 12px 渐隐由子节点 CanvasTimeline 的
   `.scroll` 自己做（`data-testid="canvas-scroll"`，它才是真正的滚动容器）。
   父子各写一份**完全相同的** gradient 会相乘 —— 渐隐叠成两倍深、两端比设计值更早变透明；
   而且父层一旦有 mask 就成为后代的 backdrop root（见 docs/ARCHITECTURE.md 那条），
   以后往里放任何玻璃面都会退化成"只采到这一层自己的内容"。
   渐隐的实现只有一份，在滚动容器身上。（2026-10-02 按用户意见移除重复遮罩） */
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

/* 卡头右侧：计数 + 「详情 ›」胶囊。
   两者不要再挤：计数是灰的次要信息（tabular 数字），胶囊是可点的去处 ——
   形态差异本身就说明了「哪个能点」，不靠颜色大小去抢。 */
.hright {
  gap: 8px;
  flex: none;
}

.detail {
  gap: 1px;
  padding: 5px 10px 5px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  /* `--accent-strong` 而不是 `--accent`：后者压在 `--surface-2` 上实测只有
     4.27:1（亮）/ 3.82:1（暗），够不着 4.5 的门槛 —— 这两个数字是量出来的，不是估的。
     `--accent-strong` 这个令牌存在的理由就是「浅底上的文字蓝」（见 tokens.css 注释）。 */
  color: var(--accent-strong);
  font-size: var(--fs-caption);
  font-weight: 700;
  flex: none;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.detail:active {
  opacity: 0.6;
}
</style>
