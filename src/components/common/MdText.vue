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
</style>
