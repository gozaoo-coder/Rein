<script setup lang="ts">
import { computed } from 'vue'

/** iOS 分段控件：滑块随选中项平移。 */
const props = defineProps<{
  options: { value: string; label: string }[]
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const index = computed(() => Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)))

/**
 * 键盘：单选组的常规操作 —— 左右方向键换选项，跳过的项不落焦点（roving tabindex）。
 * 这些按钮表达的是「选一个」，不是「切一个页签」，所以用 radio 而不是 tab
 * （tab 会给读屏一个错误的心智模型：它以为下面会有一块跟着换的内容）。
 */
function pick(v: string): void {
  emit('update:modelValue', v)
}

function onKey(e: KeyboardEvent, i: number): void {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const next = props.options[(i + d + props.options.length) % props.options.length]
  if (next) pick(next.value)
}
</script>

<template>
  <div class="seg" role="radiogroup" :style="{ '--n': options.length }">
    <div class="thumb" :style="{ transform: `translateX(${index * 100}%)` }" />
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      role="radio"
      class="seg-item"
      :class="{ on: o.value === modelValue }"
      :aria-checked="o.value === modelValue"
      :tabindex="o.value === modelValue ? 0 : -1"
      @click="pick(o.value)"
      @keydown="onKey($event, i)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  position: relative;
  display: flex;
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: 2px;
}

.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc((100% - 4px) / var(--n));
  height: calc(100% - 4px);
  background: var(--surface);
  border-radius: 8px;
  box-shadow: var(--shadow-thumb);
  transition: transform var(--dur-base) var(--ease-standard);
}

.seg-item {
  position: relative;
  z-index: 1;
  flex: 1;
  padding: 6px 0;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-standard);
}

.seg-item.on {
  color: var(--text-1);
}
</style>
