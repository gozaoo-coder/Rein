<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

/** iOS 大标题页头；back = 二级页返回键（有来路则返回，直链进入回首页）。
 *  compact = 导航条模式（对话/工具页）：单行小标题、按钮居中，把纵向空间留给内容。 */
defineProps<{
  title: string
  subtitle?: string
  back?: boolean
  compact?: boolean
}>()

const router = useRouter()

function goBack(): void {
  const state: unknown = window.history.state
  if (state !== null && typeof state === 'object' && 'back' in state && state.back != null) {
    router.back()
  } else {
    void router.replace('/')
  }
}
</script>

<template>
  <header class="page-header" :class="{ compact }">
    <slot name="lead" />
    <button v-if="back" class="back" aria-label="返回" @click="goBack">
      <ChevronLeft :size="21" :stroke-width="2.4" />
    </button>
    <div class="flex-1">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <slot name="action" />
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 8px 2px 14px;
}

.back {
  width: 38px;
  height: 38px;
  flex: none;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 页头图标按钮统一规范（lead / action 插槽内使用 class="hdr-btn"）：
   与返回键同尺寸同材质；accent 变体留给正向 CTA（如“添加”）。 */
.page-header :slotted(.hdr-btn) {
  width: 38px;
  height: 38px;
  flex: none;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.page-header :slotted(.hdr-btn:active) {
  transform: scale(0.92);
}

.page-header :slotted(.hdr-btn.accent) {
  background: var(--accent);
  color: #fff;
}

h1 {
  font-size: var(--fs-large-title);
  font-weight: 700;
  letter-spacing: -0.6px;
  line-height: 1.15;
}

p {
  margin-top: 2px;
  font-size: var(--fs-footnote);
  color: var(--text-2);
  font-weight: 500;
}

/* 紧凑导航条：17px 单行标题（iOS 导航条规格），图标按钮改为垂直居中 */
.page-header.compact {
  align-items: center;
  padding: 4px 2px 10px;
}

.page-header.compact h1 {
  font-size: var(--fs-headline);
  letter-spacing: -0.3px;
  line-height: 1.2;
}

.page-header.compact .back,
.page-header.compact :slotted(.hdr-btn) {
  margin-bottom: 0;
}
</style>
