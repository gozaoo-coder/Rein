<script setup lang="ts">
/**
 * SearchBar — Rounded pill-shaped glass search input.
 * HarmonyOS 沉浸光感 spec: Ultra_Thin/Medium tier translucent surface
 * with tinted background; used inside top floating area or page header.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    disabled?: boolean;
    variant?: "embedded" | "standalone";
  }>(),
  {
    modelValue: "",
    placeholder: "搜索",
    disabled: false,
    variant: "embedded",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  focus: [];
  blur: [];
  search: [value: string];
}>();

const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit("update:modelValue", v),
});

function onInput(e: Event) {
  const t = e.target as HTMLInputElement;
  value.value = t.value;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    emit("search", value.value);
  }
}
</script>

<template>
  <label class="search-bar" :class="[`search-bar--${variant}`, { 'is-disabled': disabled }]">
    <span class="search-icon" aria-hidden="true">
      <i class="bi bi-search" style="font-size:16px"></i>
    </span>
    <input
      class="search-input"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      enterkeyhint="search"
      @input="onInput"
      @focus="emit('focus')"
      @blur="emit('blur')"
      @keydown="onKeydown"
    />
    <button
      v-if="modelValue"
      type="button"
      class="search-clear"
      aria-label="清除"
      @mousedown.prevent
      @click="value = ''"
    >
      <i class="bi bi-x-lg" style="font-size:12px"></i>
    </button>
  </label>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--text-md);
  color: var(--search-text);
  transition: background var(--dur-fast) var(--ease-immersive),
              box-shadow var(--dur-fast) var(--ease-immersive);
  box-sizing: border-box;
}

/* Embedded: sits inside glass top bar, uses subtle gray fill */
.search-bar--embedded {
  background: var(--search-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border: none;
}

.search-bar--embedded:focus-within {
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 2px rgba(10, 89, 247, 0.18);
}

/* Standalone: Medium-tier glass, floats on page */
.search-bar--standalone {
  background: var(--material-medium-bg);
  -webkit-backdrop-filter: blur(var(--material-medium-blur)) saturate(180%);
  backdrop-filter: blur(var(--material-medium-blur)) saturate(180%);
  border: 1px solid var(--material-medium-border);
  box-shadow: var(--material-medium-shadow);
}

.search-bar--standalone:focus-within {
  box-shadow: 0 0 0 2px rgba(10, 89, 247, 0.22), var(--material-medium-shadow);
}

.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.search-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--search-placeholder);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: inherit;
  font-family: inherit;
  padding: 0;
  height: 100%;
}

.search-input::placeholder {
  color: var(--search-placeholder);
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.search-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--bg-400);
  color: #ffffff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--dur-fast), transform var(--dur-fast);
}

.search-clear:active {
  transform: scale(0.88);
  background: var(--bg-500);
}
</style>
