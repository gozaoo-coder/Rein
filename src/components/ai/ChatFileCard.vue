<script setup lang="ts">
/**
 * 聊天里的文件卡片（AI 用 present_file 挂出的工作区产出）。
 *
 * 与文件管理器共用同一套图标（`FileIcon`）与同一份视图模型（`toFileItem`），
 * 所以「同一条文件在聊天里与在文件页里」长得一样，不会各画一套。
 * 只做展示 + emit：跳转是页面的事（组件不 import router，可测、可复用）。
 */
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

import FileIcon from '@/components/files/FileIcon.vue'
import { toFileItem } from '@/files/provider'
import type { KbEntry } from '@/types'
import { humanBytes } from '@/utils/format'

const props = defineProps<{
  /** 工具返回的条目元数据（KbEntry 的子集，缺项已由 chatFiles 兜底） */
  file: KbEntry
}>()

const emit = defineEmits<{ open: [file: KbEntry] }>()

/** 视图模型：只用来喂 FileIcon（图标 / 只读标记），不参与跳转 */
const item = computed(() => toFileItem(props.file, false))

/** 一行副标题：在哪 + 多大（目录给子项数 —— 体积对目录没有意义） */
const meta = computed(() => {
  const f = props.file
  const where = f.path.includes('/') ? f.path : `工作区根目录 / ${f.path}`
  const size = f.kind === 'folder' ? `${f.childCount} 项` : humanBytes(f.size)
  return `${where} · ${size}`
})
</script>

<template>
  <button
    type="button"
    class="file-card"
    :aria-label="file.kind === 'folder' ? `打开目录 ${file.name}` : `打开 ${file.name}`"
    @click="emit('open', file)"
  >
    <FileIcon :item="item" :size="20" />
    <span class="fc-col">
      <span class="fc-name">{{ file.name }}</span>
      <span class="fc-meta">{{ meta }}</span>
    </span>
    <ChevronRight :size="15" class="fc-go" />
  </button>
</template>

<style scoped>
/* 卡片语言与用户发来的文档卡（AIPage 的 .doc-card）一致：实底 + 卡片阴影 + 圆角。
   按压反馈交给全局 button:active（base.css），这里不自己再写一套。
   宽度按内容自适应，但不超过气泡那一列 —— 长路径由两行各自的省略号收住。 */
.file-card {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 100%;
  padding: 9px 12px;
  border: none;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.fc-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fc-name {
  font-size: var(--fs-footnote);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fc-meta {
  font-size: var(--fs-micro);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 箭头只在悬停时亮起来：卡片本身是「一句话」，指路的那一撇不用一直抢注意力 */
.fc-go {
  flex: none;
  color: var(--text-3);
  opacity: 0.5;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

@media (hover: hover) {
  .file-card:hover .fc-go {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fc-go {
    transition: none;
  }
}
</style>
