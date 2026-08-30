<script setup lang="ts">
import { computed } from 'vue'

/** iOS 分段控件：滑块随选中项平移。 */
const props = defineProps<{
  options: { value: string; label: string }[]
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const index = computed(() => Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)))
</script>

<template>
  <div class="seg" role="tablist" :style="{ '--n': options.length }">
    <div class="thumb" :style="{ transform: `translateX(${index * 100}%)` }" />
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="tab"
      class="seg-item"
      :class="{ on: o.value === modelValue }"
      :aria-selected="o.value === modelValue"
      @click="emit('update:modelValue', o.value)"
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
