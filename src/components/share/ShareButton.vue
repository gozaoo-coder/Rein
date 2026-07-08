<script setup lang="ts">
/**
 * ShareButton — 通用分享触发按钮
 *
 * 可放置于 sub-header / action-row / 完成页等位置。
 * 不直接触发分享，仅 emit 事件，由父组件打开 ShareSheet（统一管理状态）。
 */
defineEmits<{ click: [] }>();
defineProps<{ title?: string }>();
</script>

<template>
  <button class="share-btn" :title="title ?? '分享'" @click="$emit('click')" aria-label="分享">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  </button>
</template>

<style scoped>
.share-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.share-btn:active {
  background: var(--bg-300);
  color: var(--color-warm);
}
</style>
