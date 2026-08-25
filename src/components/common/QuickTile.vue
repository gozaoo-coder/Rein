<script setup lang="ts">
/** 快捷入口磁贴：圆形图标 + 文字标签。图标底色/颜色由父级以内联样式传入。 */
defineProps<{
  label: string
  iconBg?: string
  iconColor?: string
}>()
</script>

<template>
  <button class="qa col center">
    <i class="ic center" :style="{ background: iconBg, color: iconColor }">
      <slot />
    </i>
    {{ label }}
  </button>
</template>

<style scoped>
.qa {
  gap: 7px;
  width: 100%;
  padding: 12px 0 10px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
}

.ic {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
