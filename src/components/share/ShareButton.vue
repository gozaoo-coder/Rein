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
    <i class="bi bi-share" style="font-size:20px"></i>
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
