<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Trash2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import { categoriesOf, fmtCents } from '@/config/ledger'
import { useToast } from '@/composables/useToast'
import { useLedgerStore } from '@/stores/ledger'
import { addDays, fmtDateCn, todayStr } from '@/utils/date'
import type { LedgerEntry, LedgerKind } from '@/types'

/** 记一笔 / 编辑账目：分类宫格 + 数字键盘 + 日期 + 备注（编辑态附加删除）。 */
const props = defineProps<{
  open: boolean
  /** 传入 = 编辑；null = 新增 */
  entry: LedgerEntry | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useLedgerStore()
const toast = useToast()

const kind = ref<LedgerKind>('expense')
const category = ref('food')
const amountStr = ref('')
const note = ref('')
const date = ref(todayStr())

const editing = computed(() => props.entry)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.entry) {
      kind.value = props.entry.kind
      category.value = props.entry.category
      amountStr.value = fmtCents(props.entry.amountCents)
      note.value = props.entry.note ?? ''
      date.value = props.entry.date
    } else {
      kind.value = 'expense'
      category.value = categoriesOf('expense')[0]!.key
      amountStr.value = ''
      note.value = ''
      date.value = todayStr()
    }
  },
)

const grid = computed(() => categoriesOf(kind.value))

function switchKind(k: string): void {
  kind.value = k as LedgerKind
  category.value = categoriesOf(kind.value)[0]!.key
}

const displayAmount = computed(() => (amountStr.value === '' ? '0' : amountStr.value))

function onKey(d: string): void {
  if (d === 'back') {
    amountStr.value = amountStr.value.slice(0, -1)
    return
  }
  if (d === '.') {
    if (amountStr.value.includes('.')) return
    amountStr.value = amountStr.value === '' ? '0.' : `${amountStr.value}.`
    return
  }
  // 整数位最多 7 位、小数最多 2 位
  if (amountStr.value.length >= 10 && !amountStr.value.includes('.')) return
  if (amountStr.value.includes('.') && amountStr.value.split('.')[1]!.length >= 2) return
  if (amountStr.value === '0') amountStr.value = d
  else amountStr.value += d
}

const amountCents = computed(() => Math.round(Number.parseFloat(amountStr.value || '0') * 100))
const canSave = computed(() => amountCents.value > 0 && category.value !== '' && !saving.value)
const saving = ref(false)
const title = computed(() => (editing.value ? '编辑账目' : '记一笔'))

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const input = {
      kind: kind.value,
      category: category.value,
      amountCents: amountCents.value,
      note: note.value.trim() === '' ? null : note.value.trim(),
      date: date.value,
    }
    if (editing.value) {
      await store.update({ ...editing.value, ...input })
      toast.toast('已更新')
    } else {
      await store.create(input)
      toast.toast('已记一笔')
    }
    emit('saved')
    emit('close')
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!editing.value) return
  await store.remove(editing.value.id)
  toast.toast('已删除')
  emit('saved')
  emit('close')
}

/* 删除是破坏性操作：先经 ActionSheet 确认 */
const confirmDel = ref(false)

async function onConfirmDelete(value: string): Promise<void> {
  if (value !== 'delete') return
  await remove()
}
</script>

<template>
  <SheetModal :open="open" :title="title" @close="emit('close')">
    <div class="form">
      <SegmentedControl
        :model-value="kind"
        class="seg"
        :options="[
          { value: 'expense', label: '支出' },
          { value: 'income', label: '收入' },
        ]"
        @update:model-value="switchKind"
      />

      <!-- 分类宫格 -->
      <div class="cats">
        <button
          v-for="c in grid"
          :key="c.key"
          type="button"
          class="cat"
          :class="{ on: category === c.key }"
          @click="category = c.key"
        >
          <i :style="{ background: c.colorVar }">
            <component :is="c.icon" :size="20" :stroke-width="2" />
          </i>
          <span>{{ c.label }}</span>
        </button>
      </div>

      <div class="row between">
        <div class="amount">
          <em>¥</em>
          <b class="num">{{ displayAmount }}</b>
        </div>
        <div class="date">
          <button class="chip" :class="{ on: date === todayStr() }" @click="date = todayStr()">今天</button>
          <button class="chip" :class="{ on: date === addDays(todayStr(), -1) }" @click="date = addDays(todayStr(), -1)">
            昨天
          </button>
          <label class="chip date-chip" :class="{ on: date !== todayStr() && date !== addDays(todayStr(), -1) }">
            {{ date !== todayStr() && date !== addDays(todayStr(), -1) ? fmtDateCn(date) : '自定义' }}
            <input v-model="date" type="date" class="date-input" />
          </label>
        </div>
      </div>

      <!-- 数字键盘 -->
      <div class="keypad">
        <button v-for="k in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back']" :key="k" type="button" class="key" :class="{ fn: k === 'back' }" :aria-label="k === 'back' ? '退格' : `数字 ${k}`" @click="onKey(k)">
          <span v-if="k === 'back'">⌫</span>
          <span v-else>{{ k }}</span>
        </button>
      </div>

      <input v-model="note" class="note" type="text" placeholder="备注（可选，如 午餐、房租）" />

      <div class="row between actions">
        <button v-if="editing" type="button" class="danger" aria-label="删除该账目" @click="confirmDel = true">
          <Trash2 :size="17" /> 删除
        </button>
        <span v-else class="empty" />
        <button type="button" class="save" :disabled="!canSave" @click="save">保存</button>
      </div>
    </div>

    <ActionSheet
      :open="confirmDel"
      title="删除这笔账目？"
      :actions="[{ label: '删除', value: 'delete', danger: true }]"
      @select="onConfirmDelete"
      @close="confirmDel = false"
    />
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.seg {
  width: 100%;
}

.cats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px 6px;
}

.cat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 2px 0 4px;
  border-radius: var(--radius-m);
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
}

.cat:active {
  background: var(--surface-2);
}

.cat i {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cat.on i {
  transform: scale(1.08);
  box-shadow: 0 0 0 3px var(--surface), 0 0 0 6px var(--line-strong);
}

.cat.on span {
  color: var(--text-1);
}

.amount {
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding: 6px 0;
}

.amount em {
  font-style: normal;
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-2);
}

.amount b {
  font-size: var(--fs-large-title);
  font-weight: 700;
  letter-spacing: -0.5px;
}

.date {
  display: flex;
  gap: 6px;
  align-items: center;
}

.chip {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.date-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.date-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}

.keypad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.key {
  height: 44px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-title3);
  font-weight: 600;
  color: var(--text-1);
}

.key:active {
  background: var(--line-strong);
}

.key.fn {
  font-size: var(--fs-headline);
  color: var(--text-2);
}

.note {
  padding: 10px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.note::placeholder {
  color: var(--text-3);
}

.actions {
  margin-top: 2px;
}

.empty {
  flex: 1;
}

.danger {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 10px 18px;
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.save {
  padding: 10px 34px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: 0.35;
}
</style>
