<script setup lang="ts">
/**
 * MarkdownRenderer — 基于 @incremark/vue 的统一 markdown 渲染器
 *
 * - 静态内容：一次性 render
 * - 流式内容：append 增量 diff，结束时 finalize
 * - 启用打字机效果（流式时）
 *
 * 使用：
 *   <MarkdownRenderer :content="text" />
 *   <MarkdownRenderer :content="streamingText" streaming />
 */
import { onBeforeUnmount, ref, watch } from "vue";
import { Incremark, useIncremark } from "@incremark/vue";
import "@incremark/theme/styles.css";

const props = withDefaults(
  defineProps<{
    content: string;
    /** 是否流式（流式时按增量 append，结束时 finalize） */
    streaming?: boolean;
    /** 启用打字机效果（仅流式有意义） */
    typewriter?: boolean;
  }>(),
  {
    streaming: false,
    typewriter: true,
  },
);

const { blocks, append, finalize, reset, render, isDisplayComplete } = useIncremark(
  () => ({
    typewriter: props.streaming && props.typewriter
      ? {
          enabled: true,
          charsPerTick: [2, 4],
          tickInterval: 24,
          effect: "typing" as const,
          cursor: "▋",
        }
      : undefined,
  }),
);

const lastLen = ref(0);
const lastContent = ref("");

function applyContent(content: string): void {
  if (props.streaming) {
    // 增量：新内容是旧内容前缀 → append diff；否则 reset + append 全量
    if (lastContent.value && content.startsWith(lastContent.value)) {
      const diff = content.slice(lastLen.value);
      if (diff) append(diff);
    } else {
      reset();
      if (content) append(content);
    }
    lastLen.value = content.length;
    lastContent.value = content;
  } else {
    // 静态：一次性 render（reset + append + finalize）
    if (content) {
      render(content);
    } else {
      reset();
    }
    lastLen.value = 0;
    lastContent.value = "";
  }
}

watch(
  () => props.content,
  (c) => applyContent(c ?? ""),
  { immediate: true },
);

watch(
  () => props.streaming,
  (s, prev) => {
    // streaming 由 true → false：finalize
    if (prev && !s) {
      finalize();
      lastLen.value = 0;
      lastContent.value = "";
    }
    // streaming 由 false → true：重置增量基线
    if (!prev && s) {
      lastLen.value = 0;
      lastContent.value = "";
    }
  },
);

onBeforeUnmount(() => {
  try {
    finalize();
  } catch {
    /* noop */
  }
});

// 暴露给父组件判断是否还在播放
defineExpose({ isDisplayComplete });
</script>

<template>
  <div class="md-renderer">
    <Incremark
      :blocks="blocks"
      :is-display-complete="isDisplayComplete"
      :incremark="undefined"
    />
  </div>
</template>

<style scoped>
.md-renderer {
  font-size: var(--text-sm);
  line-height: 1.65;
  color: var(--color-text);
  word-break: break-word;
}
.md-renderer :deep(p) {
  margin: 0.4em 0;
}
.md-renderer :deep(h1),
.md-renderer :deep(h2),
.md-renderer :deep(h3),
.md-renderer :deep(h4) {
  font-weight: var(--fw-bold);
  margin: 0.8em 0 0.4em;
  line-height: 1.3;
}
.md-renderer :deep(h1) { font-size: 1.4em; }
.md-renderer :deep(h2) { font-size: 1.25em; }
.md-renderer :deep(h3) { font-size: 1.1em; }
.md-renderer :deep(h4) { font-size: 1em; }
.md-renderer :deep(ul),
.md-renderer :deep(ol) {
  padding-left: 1.4em;
  margin: 0.4em 0;
}
.md-renderer :deep(li) {
  margin: 0.15em 0;
}
.md-renderer :deep(blockquote) {
  border-left: 3px solid var(--color-divider);
  padding-left: 0.8em;
  color: var(--color-text-secondary);
  margin: 0.5em 0;
}
.md-renderer :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-200);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.md-renderer :deep(pre) {
  background: var(--bg-100);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  overflow-x: auto;
  margin: 0.5em 0;
  font-size: 0.85em;
}
.md-renderer :deep(pre code) {
  background: transparent;
  padding: 0;
}
.md-renderer :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.9em;
}
.md-renderer :deep(th),
.md-renderer :deep(td) {
  border: 1px solid var(--color-divider);
  padding: 0.35em 0.6em;
  text-align: left;
}
.md-renderer :deep(th) {
  background: var(--bg-100);
  font-weight: var(--fw-semibold);
}
.md-renderer :deep(a) {
  color: var(--color-warm);
  text-decoration: none;
}
.md-renderer :deep(a:hover) {
  text-decoration: underline;
}
.md-renderer :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-divider);
  margin: 0.8em 0;
}
.md-renderer :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-md);
}
</style>
