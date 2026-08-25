<script setup lang="ts">
import { Minus, Plus } from 'lucide-vue-next'

/** 紧凑数字步进器（目标设置等场景）。 */
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

function bump(d: number): void {
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + d))
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="stepper row between">
    <span v-if="label" class="label">{{ label }}</span>
    <div class="row ctrl">
      <button aria-label="减少" :disabled="modelValue <= min" @click="bump(-step)">
        <Minus :size="15" />
      </button>
      <span class="num val"><b>{{ modelValue }}</b><small v-if="unit">{{ unit }}</small></span>
      <button aria-label="增加" :disabled="modelValue >= max" @click="bump(step)">
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

.ctrl button {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
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
</style>
