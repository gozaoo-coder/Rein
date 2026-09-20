<script setup lang="ts">
/** iOS 风格开关（受控组件）：开 = 系统绿，滑块走 spring 曲线（令牌里就是为它留的）。 */
defineProps<{
  modelValue: boolean
  /** 无障碍名（开关本体是按钮，必须自带可读名） */
  label: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    class="sw"
    :class="{ on: modelValue }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <i class="knob" />
  </button>
</template>

<style scoped>
.sw {
  position: relative;
  width: 51px;
  height: 31px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  transition: background-color var(--dur-base) var(--ease-standard);
}

.sw.on {
  background: var(--ok);
}

.sw:disabled {
  opacity: 0.4;
  cursor: default;
}

.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: var(--switch-knob);
  box-shadow: var(--shadow-thumb);
  transition: transform var(--dur-base) var(--ease-spring);
}

.sw.on .knob {
  transform: translateX(20px);
}

@media (prefers-reduced-motion: reduce) {
  .sw,
  .knob {
    transition: none;
  }
}
</style>
