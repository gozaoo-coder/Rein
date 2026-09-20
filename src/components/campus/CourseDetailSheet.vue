<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarDays, Check, MapPin, Undo2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META } from '@/config/domain'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'

/**
 * 课表派生行的**只读**详情。
 *
 * 为什么不复用 `TodoEditorSheet`：课表派生行是 `campus_sessions` 的投影，
 * 标题/时间/地点都由 `campus_sync` 生成，而同步是**先删后建**——用户在编辑器里
 * 改完，下一次同步就把它抹掉重建，看起来像「App 把我的修改吃了」。
 * 所以这里只给「看」与「打卡」，改的入口一律指回课表配置页。
 *
 * 唯一保留的写操作是打勾（标记完成）：那是用户自己的考勤记录，
 * 而且 `materialize_todos` 对 `status='done'` 的行有「永不删除」的不变量，
 * 打了卡就不会被同步覆盖 —— 这条不变量正是这个按钮敢留着的原因。
 */
const props = defineProps<{
  open: boolean
  todo: Todo | null
}>()

const emit = defineEmits<{ close: []; toggle: [todo: Todo] }>()

const router = useRouter()

const cat = computed(() => CATEGORY_META[props.todo?.category ?? 'general'])

const day = computed(() => props.todo?.date ?? '')

/** 周几：只在同一年内用 `MM月DD日 周X`，避免多一年时读错 */
const dayLabel = computed(() => {
  if (!day.value) return ''
  const d = new Date(`${day.value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day.value
  const dow = '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 周${dow}`
})

const timeLabel = computed(() => {
  const t = props.todo
  if (!t || t.startMin == null) return ''
  const start = minToHHmm(t.startMin)
  const end = t.durationMin ? minToHHmm(t.startMin + t.durationMin) : ''
  return end ? `${start} – ${end}` : start
})

const done = computed(() => props.todo?.status === 'done')

function openSchedule(): void {
  emit('close')
  void router.push({ name: 'campus-schedule' })
}
</script>

<template>
  <SheetModal :open="open" title="课程" initial-snap="medium" @close="emit('close')">
    <div v-if="todo" class="course">
      <div class="head">
        <i class="dot" :style="{ background: `var(${cat.colorVar})` }" />
        <h3>{{ todo.title }}</h3>
        <span v-if="done" class="chip done">已打卡</span>
      </div>

      <dl class="facts">
        <div v-if="dayLabel">
          <dt><CalendarDays :size="14" /> 日期</dt>
          <dd>{{ dayLabel }}</dd>
        </div>
        <div v-if="timeLabel">
          <dt><CalendarDays :size="14" /> 时间</dt>
          <dd class="num">{{ timeLabel }}</dd>
        </div>
        <div v-if="todo.notes">
          <dt><MapPin :size="14" /> 安排</dt>
          <dd>{{ todo.notes }}</dd>
        </div>
      </dl>

      <p class="src">
        这门课来自课表同步：标题、时间与地点都由教务课表生成。要改请到
        <strong>课表配置页</strong>重新同步 —— 在这里改会被下次同步覆盖。
      </p>

      <div class="acts">
        <button class="primary" @click="todo && emit('toggle', todo)">
          <component :is="done ? Undo2 : Check" :size="15" />
          {{ done ? '撤销打卡' : '标记已完成' }}
        </button>
        <button class="ghost" @click="openSchedule">
          <CalendarDays :size="15" /> 在课表中查看
        </button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.course {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head h3 {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.3;
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 2px 9px;
  border-radius: var(--radius-full);
}

.chip.done {
  color: var(--ok);
  background: var(--ok-soft);
}

.facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.facts > div {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.facts dt {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  width: 62px;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.facts dd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: 1.45;
  word-break: break-all;
}

.facts .num {
  font-variant-numeric: tabular-nums;
}

.src {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.55;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.acts button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  border-radius: var(--radius-m);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.acts button:active {
  transform: scale(0.985);
}

.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.ghost {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
