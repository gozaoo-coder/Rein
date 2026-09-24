<script setup lang="ts">
/**
 * ToolDetailDrawer 工具调用详情抽屉
 *
 * 过程区里的工具行只回答「AI 做了什么」；完整入参、返回结果与结果图都在这里看：
 * 底部弹出、可拖动调高（SheetModal），长 JSON 换行 + 纵向滚动，绝无横向溢出。
 */
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import type { ProcessToolCall } from '@/types'

const props = defineProps<{
  /** 当前查看的工具调用；null 表示抽屉关闭 */
  call: ProcessToolCall | null
}>()

const emit = defineEmits<{ close: [] }>()

/** 离场动画期间仍需渲染内容：记住最后一次打开的记录 */
const shown = ref<ProcessToolCall | null>(null)
watch(
  () => props.call,
  (c) => {
    if (c) shown.value = c
  },
  { immediate: true },
)

const state = computed(() => {
  const c = shown.value
  if (!c || c.pending) return 'pending'
  return c.isError ? 'error' : 'ok'
})

const stateText = computed(() => {
  if (state.value === 'pending') return '执行中…'
  return state.value === 'error' ? '执行失败' : '执行完成'
})

/** 美化 JSON 用于详情显示 */
function prettyJson(s: string): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

const argsText = computed(() => (shown.value ? prettyJson(shown.value.arguments) || '无' : ''))
</script>

<template>
  <SheetModal
    :open="!!call"
    :title="shown?.toolName ?? '工具调用'"
    initial-snap="large"
    @close="emit('close')"
  >
    <template v-if="shown">
      <div class="head">
        <span class="state" :class="state">{{ stateText }}</span>
        <span v-if="shown.rawName" class="rawname">{{ shown.rawName }}</span>
      </div>

      <p class="sec">输入参数</p>
      <pre class="pre" data-rubber-self>{{ argsText }}</pre>

      <p class="sec">
        返回结果
        <span v-if="shown.result" class="size">{{ shown.result.length }} 字</span>
      </p>
      <pre
        v-if="shown.result"
        class="pre"
        data-rubber-self
        :class="{ 'is-error': shown.isError }"
      >{{ shown.result }}</pre>
      <p v-else class="empty">{{ shown.pending ? '等待结果返回…' : '无返回结果' }}</p>

      <img
        v-if="shown.resultImage"
        class="img"
        :src="`data:${shown.resultImage.mime};base64,${shown.resultImage.base64}`"
        alt="工具返回图片"
      >
    </template>
  </SheetModal>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.state {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 3px 9px;
  border-radius: var(--radius-full);
}

.state.pending {
  color: var(--text-2);
  background: var(--surface-2);
}

.state.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.state.error {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.rawname {
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-micro);
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.sec {
  margin: 18px 0 10px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--text-3);
}

.size {
  margin-left: 8px;
  font-weight: 500;
  letter-spacing: 0;
}

.pre {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-1);
  /* 换行 + 长串任意断行：详情永远不横向溢出 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pre.is-error {
  color: var(--danger-strong);
}

.empty {
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.img {
  display: block;
  margin-top: 12px;
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--radius-s);
  border: 0.5px solid var(--line);
}
</style>
