<script setup lang="ts">
import { ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { fmtCents } from '@/config/ledger'
import { useToast } from '@/composables/useToast'
import { useLedgerStore } from '@/stores/ledger'

/** 月度总预算设置：快捷金额 + 自定义输入 + 清除预算。 */
defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useLedgerStore()
const toast = useToast()

const PRESETS = [2000, 3000, 5000, 8000]

const val = ref('')

watch(
  () => store.settings,
  (s) => {
    val.value = s && s.monthlyBudgetCents > 0 ? fmtCents(s.monthlyBudgetCents) : ''
  },
  { immediate: true },
)

const cents = (): number => {
  const n = Number.parseFloat(val.value || '0')
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

async function save(): Promise<void> {
  const c = cents()
  if (c <= 0) return
  await store.setBudget(c)
  toast.toast('预算已更新')
  emit('saved')
  emit('close')
}

async function clear(): Promise<void> {
  await store.setBudget(0)
  toast.toast('已清除预算')
  emit('saved')
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" title="月度预算" @close="emit('close')">
    <div class="form">
      <label class="input-wrap">
        <span class="cur">¥</span>
        <input
          v-model="val"
          class="num"
          type="text"
          inputmode="decimal"
          placeholder="如 3000"
          aria-label="输入月度预算"
        />
        <!-- 货币只在一处说清：左边「¥」+ 右边「/ 月」，placeholder 让位给示例 -->
        <span class="unit">/ 月</span>
      </label>

      <div class="presets">
        <button
          v-for="p in PRESETS"
          :key="p"
          type="button"
          class="chip num"
          :class="{ on: String(p) === val }"
          @click="val = String(p)"
        >
          ¥{{ p }}
        </button>
      </div>

      <div class="row between actions">
        <StatusChip
          v-if="store.settings && store.settings.monthlyBudgetCents > 0"
          as="button"
          tone="danger"
          size="md"
          class="clear"
          @click="clear"
        >
          清除预算
        </StatusChip>
        <span v-else />
        <button type="button" class="save" :disabled="cents() <= 0" @click="save">保存</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.input-wrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 16px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.cur {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-2);
}

.input-wrap input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-title1);
  font-weight: 700;
  color: var(--text-1);
  background: transparent;
}

.input-wrap input::placeholder {
  color: var(--text-3);
  font-weight: 500;
}

.unit {
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.chip {
  padding: 9px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.actions {
  margin-top: 4px;
}

/* 清除预算是破坏性操作：语义色走 StatusChip（danger-soft 底 + danger-strong 字），
   不再拿 --text-3 让要清预算的人在最低对比档里找按钮 */
.clear {
  border: 0;
  cursor: pointer;
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
  opacity: var(--disabled-opacity);
}
</style>
