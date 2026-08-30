<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { CATEGORY_META, PRIORITY_META } from '@/config/domain'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, todayStr } from '@/utils/date'
import type { RecRule, Todo, TodoCategory, TodoInput, TodoSubtask } from '@/types'

/**
 * 待办编辑抽屉：完整字段（标题 / 日期 / 时间段 / 时长 / 分类 / 重要程度 / 备注 / 子任务 / 重复）。
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

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const REC_FREQS: { value: 'none' | RecRule['freq']; label: string }[] = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'interval', label: '间隔 N 天' },
]

const form = reactive({
  title: '',
  date: '',
  startMin: null as number | null,
  durationMin: null as number | null,
  category: 'general' as TodoCategory,
  priority: 0,
  notes: '',
  subtasks: [] as TodoSubtask[],
  newSub: '',
  recFreq: 'none' as 'none' | RecRule['freq'],
  recWeekdays: [] as number[],
  recInterval: 2,
  recEnd: '' as string,
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
    form.subtasks = (t?.subtasks ?? []).map((s) => ({ ...s }))
    form.newSub = ''
    form.recFreq = t?.recRule?.freq ?? 'none'
    form.recWeekdays = t?.recRule?.weekdays ? [...t.recRule.weekdays] : []
    form.recInterval = t?.recRule?.intervalDays || 2
    form.recEnd = t?.recRule?.endDate ?? ''
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

function rulePayload(): RecRule | null {
  if (form.recFreq === 'none') return null
  const weekdays = form.recFreq === 'weekly' ? [...form.recWeekdays].sort((a, b) => a - b) : []
  if (form.recFreq === 'weekly' && !weekdays.length) return null
  return {
    freq: form.recFreq,
    weekdays,
    intervalDays: form.recFreq === 'interval' ? form.recInterval : 0,
    endDate: form.recEnd || null,
  }
}

function addSub(): void {
  const title = form.newSub.trim()
  if (!title || form.subtasks.length >= 10) return
  form.subtasks.push({ title, done: false })
  form.newSub = ''
}

function toggleWeekday(d: number): void {
  const i = form.recWeekdays.indexOf(d)
  if (i === -1) form.recWeekdays.push(d)
  else form.recWeekdays.splice(i, 1)
}

async function save(): Promise<void> {
  if (!canSave.value) return
  const rule = rulePayload()
  const subs = form.subtasks.length ? form.subtasks : null
  const input: TodoInput = {
    title: form.title.trim(),
    notes: form.notes.trim() || null,
    date: form.date || null,
    startMin: form.startMin,
    durationMin: form.durationMin,
    category: form.category,
    priority: form.priority,
    recRule: rule,
    subtasks: subs,
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
      <input v-model="form.title" class="title" type="text" placeholder="要做什么？" aria-label="待办标题" maxlength="80">

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

      <!-- 子任务 -->
      <div class="field col">
        <span class="fb">子任务<span v-if="form.subtasks.length" class="num cnt"> {{ form.subtasks.filter((s) => s.done).length }}/{{ form.subtasks.length }}</span></span>
        <ul v-if="form.subtasks.length" class="subs">
          <li v-for="(s, i) in form.subtasks" :key="i" class="row sub">
            <label class="row submain">
              <input v-model="s.done" type="checkbox">
              <span :class="{ off: s.done }">{{ s.title }}</span>
            </label>
            <button class="subdel" aria-label="删除子任务" @click="form.subtasks.splice(i, 1)">
              <Trash2 :size="14" />
            </button>
          </li>
        </ul>
        <div class="row subadd">
          <input
            v-model="form.newSub"
            class="subinput"
            type="text"
            placeholder="添加子任务（回车）"
            maxlength="60"
            @keydown.enter.prevent="addSub"
          >
          <button class="subbtn" aria-label="添加子任务" :disabled="!form.newSub.trim()" @click="addSub">
            <Plus :size="15" />
          </button>
        </div>
      </div>

      <!-- 重复 -->
      <div class="field col">
        <span class="fb">重复</span>
        <div class="chips">
          <button v-for="f in REC_FREQS" :key="f.value" class="chip" :class="{ on: form.recFreq === f.value }" @click="form.recFreq = f.value">
            {{ f.label }}
          </button>
        </div>
        <div v-if="form.recFreq === 'weekly'" class="chips wd">
          <button
            v-for="(w, i) in WEEKDAYS"
            :key="w"
            class="chip"
            :class="{ on: form.recWeekdays.includes(i) }"
            @click="toggleWeekday(i)"
          >
            {{ w }}
          </button>
        </div>
        <div v-if="form.recFreq === 'interval'" class="row itv">
          <span>间隔</span>
          <NumberStepper v-model="form.recInterval" :min="2" :max="30" unit="天" />
        </div>
        <div v-if="form.recFreq !== 'none'" class="row itv">
          <span>结束</span>
          <button class="chip" :class="{ on: !form.recEnd }" @click="form.recEnd = ''">永不</button>
          <input v-model="form.recEnd" class="date" type="date" aria-label="结束日期">
        </div>
        <p v-if="form.recFreq !== 'none'" class="recnote">以后的日子会自动生成这条待办；改规则后未完成的未来实例会重建。</p>
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
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
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
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: 0.4;
}

.cnt {
  color: var(--accent);
  margin-left: 4px;
}

.subs {
  display: flex;
  flex-direction: column;
}

.sub {
  justify-content: space-between;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 0.5px solid var(--line);
}

.submain {
  gap: 9px;
  font-size: var(--fs-body);
  min-width: 0;
}

.submain input {
  width: 17px;
  height: 17px;
  accent-color: var(--ok);
  flex: none;
}

.submain span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.submain span.off {
  color: var(--text-3);
  text-decoration: line-through;
}

.subdel {
  color: var(--text-3);
  padding: 2px;
}

.subadd {
  gap: 8px;
  margin-top: 6px;
}

.subinput {
  flex: 1;
  padding: 9px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
}

.subbtn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.subbtn:disabled {
  opacity: 0.4;
}

.wd {
  margin-top: 8px;
}

.itv {
  gap: 10px;
  margin-top: 10px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  align-items: center;
}

.itv .date {
  margin-left: auto;
}

.recnote {
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}
</style>
