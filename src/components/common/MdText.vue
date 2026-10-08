<script setup lang="ts">
/**
 * Markdown 文本渲染（聊天气泡 / 纪要总结共用）。
 * streaming=true 时按块增量：已完成块缓存静态 HTML，仅末尾未完块重渲（见 utils/markdown）。
 */
import { computed } from 'vue'
import { renderBlock, splitBlocks } from '@/utils/markdown'

const props = defineProps<{ text: string; streaming?: boolean }>()

// 块级缓存（组件实例内）：签名 = 已完成块的原文
let cacheSig = ''
let cacheHtml: string[] = []

const html = computed(() => {
  const blocks = splitBlocks(props.text)
  const streaming = props.streaming === true
  const done = streaming ? blocks.slice(0, -1) : blocks
  const sig = done.join('\u0000')
  if (sig !== cacheSig) {
    cacheSig = sig
    cacheHtml = done.map(renderBlock)
  }
  const tail = streaming && blocks.length > 0 ? renderBlock(blocks[blocks.length - 1] ?? '') : ''
  return cacheHtml.join('') + tail
})
</script>

<template>
  <div class="md" v-html="html" />
</template>

<style scoped>
.md :deep(p) {
  margin: 0;
  line-height: inherit;
}

.md :deep(p + p) {
  margin-top: 6px;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.md :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 5px;
}

.md :deep(.md-pre) {
  margin: 6px 0 2px;
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.06);
  overflow-x: auto;
}

.md :deep(.md-pre code) {
  background: none;
  padding: 0;
  white-space: pre;
}

.md :deep(.md-h) {
  margin-top: 6px;
}

.md :deep(.md-quote) {
  padding-left: 9px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-2);
}

/* 表格：与全应用的表（.wtable / .matrix）同一套语言 —— 只有行分隔线，没有网格。
   外层 wrap 管横向滚动：手机气泡窄，宽表在表内滚，不把气泡撑破。
   对齐由 renderTable 写进单元格的 inline style（对齐是数据，不是主题）。 */
.md :deep(.md-table-wrap) {
  margin: 6px 0 2px;
  overflow-x: auto;
}

.md :deep(.md-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.md :deep(.md-table th),
.md :deep(.md-table td) {
  padding: 5px 8px;
  border-bottom: 0.5px solid var(--line);
  color: var(--text-2);
  vertical-align: top;
  overflow-wrap: anywhere;
}

.md :deep(.md-table th) {
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}

/* 表尾不画线：最后一条横线会让表看起来「没结束」 */
.md :deep(.md-table tbody tr:last-child td) {
  border-bottom: none;
}

/* 首列是行标签（「周一 / 胸 / 1月」这类）：加重一档，正文列才是数据 */
.md :deep(.md-table tbody td:first-child) {
  color: var(--text-1);
}
</style>
