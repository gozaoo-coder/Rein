<script setup lang="ts">
import { ChevronRight, SlidersHorizontal } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

/** 全应用统一的「管理模型」入口：胶囊按钮 + 箭头，AI 页与各智能添加弹层共用同一样式。 */
const router = useRouter()

const emit = defineEmits<{ manage: [] }>()

function go(): void {
  emit('manage')
  void router.push('/ai/models')
}
</script>

<template>
  <button class="manage row center" aria-label="管理模型" @click="go">
    <SlidersHorizontal :size="15" />
    管理模型
    <i class="chev row center"><ChevronRight :size="13" :stroke-width="2.5" /></i>
  </button>
</template>

<style scoped>
.manage {
  gap: 5px;
  padding: 8px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: 700;
  flex: none;
}

.chev {
  margin: 0 -3px 0 -1px;
  color: var(--text-3);
}
</style>
