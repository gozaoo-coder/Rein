<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'

/**
 * 紧凑数字步进器（目标设置等场景）。
 *
 * 值可以**点一下直接输入**。只有 +/- 是不够的：参数区间一旦拉开（比如最小间隔
 * 从 10ms 到 10s），靠固定步长要么点几十下才走到低档、要么在低档完全迈不开步。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    step?: number
    min?: number
    max?: number
    unit?: string
    label?: string
  }>(),
  { step: 1, min: 0, max: 99999, unit: '', label: '' },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const editing = ref(false)
const draft = ref('')
const box = ref<HTMLInputElement | null>(null)

function bump(d: number): void {
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + d))
  emit('update:modelValue', next)
}

function startEdit(): void {
  draft.value = String(props.modelValue)
  editing.value = true
  void nextTick(() => box.value?.select())
}

/** 失焦与回车共用：越界的值夹回区间，NaN 直接丢弃（保持原值） */
function commit(): void {
  const n = Number(draft.value)
  if (Number.isFinite(n) && draft.value.trim() !== '') {
    emit('update:modelValue', Math.min(props.max, Math.max(props.min, Math.round(n))))
  }
  editing.value = false
}
</script>

<template>
  <div class="stepper row between">
    <span v-if="label" class="label">{{ label }}</span>
    <div class="row ctrl">
      <button
        :aria-label="label ? `减少 ${label}` : '减少'"
        :disabled="modelValue <= min"
        @click="bump(-step)"
      >
        <Minus :size="15" />
      </button>
      <input
        v-if="editing"
        ref="box"
        v-model="draft"
        class="val edit num"
        type="number"
        :min="min"
        :max="max"
        :aria-label="label ? `修改 ${label}` : '修改数值'"
        @blur="commit"
        @keyup.enter="commit"
        @keyup.esc="editing = false"
      />
      <button v-else class="val val-btn" :aria-label="`修改${label || '数值'}`" @click="startEdit">
        <b>{{ modelValue }}</b><small v-if="unit">{{ unit }}</small>
      </button>
      <button
        :aria-label="label ? `增加 ${label}` : '增加'"
        :disabled="modelValue >= max"
        @click="bump(step)"
      >
        <Plus :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.stepper {
  padding: 7px 0;
}

.label {
  font-size: var(--fs-subhead);
  font-weight: 500;
}

.ctrl {
  gap: 2px;
}

/* + / − 的**命中区是 44×44**，视觉那个 30px 的圆画在 ::before 上。
   这两颗钮在一屏里成对出现七次，是该按 44px 标准来的地方 —— 但把圆放大到 44
   会挤掉数值的位置，所以撑命中区而不是撑视觉。 */
.ctrl button {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
}

.ctrl button::before {
  content: '';
  position: absolute;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ctrl button:active::before {
  transform: scale(0.92);
}

.ctrl button svg {
  position: relative;
}

.ctrl button:disabled {
  opacity: 0.3;
}

.val {
  min-width: 74px;
  text-align: center;
  font-size: var(--fs-subhead);
}

.val b {
  font-weight: 700;
}

.val small {
  color: var(--text-3);
  margin-left: 2px;
}

.val-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 0;
  border-radius: var(--radius-s, 6px);
  color: inherit;
}

.val-btn:active {
  background: var(--surface-2);
}

/* 直接输入态：宽度与 .val 对齐，避免切进来时整行跳动 */
.edit {
  width: 74px;
  padding: 2px 0;
  border-bottom: 1px solid var(--accent);
  color: var(--text-1);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  background: none;
  -moz-appearance: textfield;
}

.edit::-webkit-outer-spin-button,
.edit::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
