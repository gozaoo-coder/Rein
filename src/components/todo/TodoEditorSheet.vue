<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META, PRIORITY_META } from '@/config/domain'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, todayStr } from '@/utils/date'
import type { Todo, TodoCategory, TodoInput } from '@/types'

/**
 * 待办编辑抽屉：完整字段（标题 / 日期 / 时间段 / 时长 / 分类 / 重要程度 / 备注）。
 * 复用场景：TodoItem 行内编辑新建、AI 草稿调整细节、手动添加。
 */
const props = defineProps<{
  open: boolean
  /** 编辑已有待办；为 null 时是新建 */
  todo?: Todo | null
  /** 新建时的预填（AI 草稿 / 手动入口） */
  initial?: Partial<TodoInput> | null
  /** 新建默认日期 */
  date?: string
}>()

const emit = defineEmits<{ close: []; saved: [todo: Todo] }>()

const store = useTodoStore()

const form = reactive({
  title: '',
  date: '',
  startMin: null as number | null,
  durationMin: null as number | null,
  category: 'general' as TodoCategory,
  priority: 0,
  notes: '',
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const t = props.todo
    form.title = t?.title ?? props.initial?.title ?? ''
    form.date = t?.date ?? props.initial?.date ?? props.date ?? todayStr()
    form.startMin = t?.startMin ?? props.initial?.startMin ?? null
    form.durationMin = t?.durationMin ?? props.initial?.durationMin ?? null
    form.category = t?.category ?? props.initial?.category ?? 'general'
    form.priority = t?.priority ?? props.initial?.priority ?? 0
    form.notes = t?.notes ?? props.initial?.notes ?? ''
  },
)

/** <input type="time"> 的 HH:mm 与 startMin 互转；空值 = 无时间段 */
const timeValue = computed({
  get: () => (form.startMin != null ? minToHHmm(form.startMin) : ''),
  set: (v: string) => {
    if (!v) {
      form.startMin = null
      return
    }
    const [h, m] = v.split(':').map(Number)
    form.startMin = (h! * 60 + m!) % 1440
  },
})

const durationOptions = [30, 45, 60, 90, 120, 180]

const canSave = computed(() => form.title.trim().length > 0)

async function save(): Promise<void> {
  if (!canSave.value) return
  const input: TodoInput = {
    title: form.title.trim(),
    notes: form.notes.trim() || null,
    date: form.date || null,
    startMin: form.startMin,
    durationMin: form.durationMin,
    category: form.category,
    priority: form.priority,
  }
  if (props.todo) {
    const next: Todo = { ...props.todo, ...input }
    await store.update(next)
    emit('saved', next)
  } else {
    const created = await store.create(input)
    emit('saved', created)
  }
  emit('close')
}

async function remove(): Promise<void> {
  if (!props.todo) return
  await store.remove(props.todo)
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" :title="todo ? '编辑待办' : '添加待办'" @close="emit('close')">
    <div class="form">
      <input v-model="form.title" class="title" type="text" placeholder="要做什么？" maxlength="80">

      <!-- 日期 -->
      <label class="row between field">
        <span>日期</span>
        <input v-model="form.date" class="date" type="date" aria-label="日期">
      </label>

      <!-- 时间段 -->
      <div class="field col">
        <label class="row between">
          <span>时间段</span>
          <input v-model="timeValue" class="date" type="time" aria-label="开始时间">
        </label>
        <div class="chips">
          <button
            v-for="d in durationOptions"
            :key="d"
            class="chip num"
            :class="{ on: form.durationMin === d }"
            @click="form.durationMin = form.durationMin === d ? null : d"
          >
            {{ d >= 60 ? `${Math.floor(d / 60)} 小时${d % 60 ? ` ${d % 60}分` : ''}` : `${d} 分钟` }}
          </button>
          <button v-if="form.durationMin != null && !durationOptions.includes(form.durationMin)" class="chip num on" @click="form.durationMin = null">
            {{ form.durationMin }} 分钟
          </button>
        </div>
      </div>

      <!-- 分类 -->
      <div class="field col">
        <span class="fb">分类</span>
        <div class="chips">
          <button
            v-for="(m, key) in CATEGORY_META"
            :key="key"
            class="chip"
            :class="{ on: form.category === key }"
            @click="form.category = key"
          >
            {{ m.label }}
          </button>
        </div>
      </div>

      <!-- 重要程度 -->
      <div class="field col">
        <span class="fb">重要程度</span>
        <div class="chips">
          <button
            v-for="p in PRIORITY_META"
            :key="p.value"
            class="chip"
            :class="{ on: form.priority === p.value }"
            :style="form.priority === p.value ? { color: `var(${p.colorVar})` } : undefined"
            @click="form.priority = p.value"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <!-- 备注 -->
      <div class="field col">
        <label class="fb" for="todo-notes">备注</label>
        <textarea id="todo-notes" v-model="form.notes" class="notes" rows="3" placeholder="补充说明（可选）" />
      </div>
    </div>

    <div class="actions row between">
      <button v-if="todo" class="danger" aria-label="删除待办" @click="remove">
        <Trash2 :size="16" />
      </button>
      <span v-else />
      <button class="save" :disabled="!canSave" @click="save">保存</button>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  gap: 8px;
}

.field > span,
.fb {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
}

.title {
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-headline);
  font-weight: 600;
}

.date {
  padding: 8px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 500;
  color: var(--text-1);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
  transition: all var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.notes {
  padding: 10px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  resize: none;
}

.actions {
  margin-top: 16px;
}

.danger {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.save {
  padding: 11px 34px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: #fff;
  font-size: var(--fs-subhead);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: 0.4;
}
</style>
