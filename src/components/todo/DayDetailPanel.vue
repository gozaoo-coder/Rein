<script setup lang="ts">
import { computed } from 'vue'
import { Check, Paperclip, Pencil, Repeat2, Sparkles, Trash2 } from 'lucide-vue-next'

import { CATEGORY_META, priorityMeta } from '@/config/domain'
import { minToHHmm } from '@/utils/date'
import { describeRule } from '@/utils/recurrence'
import type { Todo, TodoSubtask } from '@/types'

/** 画布详情面板（桌面右栏）：选中块的字段、子任务勾选与快捷操作。 */
const props = defineProps<{ todo: Todo | null }>()

const emit = defineEmits<{
  toggle: []
  edit: []
  remove: []
  place: []
  subtasks: [next: TodoSubtask[]]
}>()

const timeLine = computed(() => {
  const t = props.todo
  if (!t || t.startMin == null) return null
  const end = t.startMin + (t.durationMin ?? 30)
  return `${minToHHmm(t.startMin)} – ${minToHHmm(end)}${t.durationMin ? ` · ${t.durationMin} 分钟` : ''}`
})

const subProg = computed(() => {
  const s = props.todo?.subtasks
  if (!s?.length) return null
  return `${s.filter((x) => x.done).length}/${s.length}`
})

function flipSub(i: number): void {
  const t = props.todo
  if (!t?.subtasks) return
  emit('subtasks', t.subtasks.map((s, j) => (j === i ? { ...s, done: !s.done } : s)))
}
</script>

<template>
  <aside class="panel" data-testid="detail-panel">
    <template v-if="todo">
      <div class="kick row">
        <i class="dot" :style="{ background: `var(${CATEGORY_META[todo.category].colorVar})` }" />
        <span>{{ CATEGORY_META[todo.category].label }}</span>
        <span v-if="todo.priority > 0" class="prio" :style="{ color: `var(${priorityMeta(todo.priority).colorVar})` }">
          {{ priorityMeta(todo.priority).label }}
        </span>
      </div>
      <h3 class="tt" :class="{ done: todo.status === 'done' }">{{ todo.title }}</h3>
      <p v-if="timeLine" class="num meta">{{ timeLine }}</p>
      <p v-else class="meta">未安排时间</p>

      <p v-if="todo.recRule" class="chip-row">
        <span class="chip"><Repeat2 :size="13" /> {{ describeRule(todo.recRule) }}</span>
      </p>
      <p v-if="todo.attachments?.length" class="chip-row">
        <button class="chip atch" aria-label="在编辑器中查看附件" @click="emit('edit')">
          <Paperclip :size="13" /> {{ todo.attachments.length }} 个附件与标记
        </button>
      </p>
      <p v-if="todo.programId" class="chip-row">
        <span class="chip src">来自健康方案</span>
      </p>
      <p v-if="todo.notes" class="notes">{{ todo.notes }}</p>

      <template v-if="todo.subtasks?.length">
        <p class="sec">子任务 <span v-if="subProg" class="num prog">{{ subProg }}</span></p>
        <label v-for="(s, i) in todo.subtasks" :key="i" class="sub">
          <input type="checkbox" :checked="s.done" @change="flipSub(i)">
          <span>{{ s.title }}</span>
        </label>
      </template>

      <div class="acts row">
        <button class="primary" @click="emit('toggle')">
          <Check :size="15" /> {{ todo.status === 'done' ? '标为未完成' : '标记完成' }}
        </button>
        <button class="ghost" aria-label="编辑" @click="emit('edit')"><Pencil :size="15" /></button>
        <button class="ghost danger" aria-label="删除" @click="emit('remove')"><Trash2 :size="15" /></button>
      </div>

      <p v-if="todo.startMin == null" class="tip">
        <Sparkles :size="13" /> 把它拖进时间轴，或
        <button class="place" @click="emit('place')">排入下一个空档</button>
      </p>
    </template>

    <div v-else class="empty">
      <p class="e1">选中一块看详情</p>
      <p class="e2">点时间轴上的块，或点未安排池里的卡片。</p>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-height: 200px;
}

.kick {
  gap: 7px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.prio {
  font-weight: 650;
}

.tt {
  font-size: var(--fs-title3);
  font-weight: 750;
  letter-spacing: -0.01em;
  line-height: 1.3;
}

.tt.done {
  color: var(--text-3);
  text-decoration: line-through;
}

.meta {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.chip-row {
  display: flex;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3.5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.chip.src {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}

.chip.atch {
  cursor: pointer;
}

.notes {
  font-size: var(--fs-footnote);
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: 8px 11px;
  line-height: 1.55;
}

.sec {
  margin-top: 4px;
  font-size: var(--fs-caption);
  font-weight: 650;
  color: var(--text-3);
}

.prog {
  color: var(--accent);
}

.sub {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: var(--fs-body);
  cursor: pointer;
}

.sub input {
  width: 17px;
  height: 17px;
  accent-color: var(--ok);
}

.sub input:checked + span {
  color: var(--text-3);
  text-decoration: line-through;
}

.acts {
  gap: 8px;
  margin-top: 8px;
}

.primary {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 0;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.ghost {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: var(--radius-m);
  border: 0.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.ghost.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
}

.tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-s);
  padding: 8px 11px;
}

.place {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.empty {
  margin: auto;
  text-align: center;
}

.e1 {
  font-weight: 650;
  color: var(--text-2);
}

.e2 {
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
