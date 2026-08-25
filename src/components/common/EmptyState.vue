<script setup lang="ts">
import type { FunctionalComponent } from 'vue'

/** 空状态：图标 + 标题 + 提示。 */
defineProps<{
  icon: FunctionalComponent
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="empty col center">
    <component :is="icon" :size="34" :stroke-width="1.6" />
    <p class="title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.empty {
  gap: 6px;
  padding: 26px 12px;
  text-align: center;
  color: var(--text-3);
}

.title {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.hint {
  font-size: var(--fs-caption);
}
</style>
