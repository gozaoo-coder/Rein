<script setup lang="ts">
import { computed } from 'vue'
import { TriangleAlert, X } from 'lucide-vue-next'

import type { FileOp } from '@/files/types'

/**
 * 操作进度条。
 *
 * 只在有活干或刚干完（含失败）时出现：正在跑给进度与取消，
 * 结束后留一条可关闭的回执（失败原因逐条列出，部分成功也说得清）。
 * 这是「操作不阻塞 UI」的可见面 —— 队列本身在 opQueue.ts。
 */
const props = defineProps<{
  ops: FileOp[]
  onCancel: () => void
  onResume: (id: number) => void
  onDismiss: (id: number) => void
}>()

const shown = computed(() => props.ops.slice(0, 3))

function pct(op: FileOp): number {
  if (!op.total) return 0
  return Math.min(100, Math.round((op.done / op.total) * 100))
}

function statusText(op: FileOp): string {
  switch (op.status) {
    case 'running':
      return op.total > 1 ? `${op.done}/${op.total}` : '进行中…'
    case 'done':
      return op.total > 1 ? `完成 ${op.total} 项` : '完成'
    case 'cancelled':
      return op.resumable ? `已取消（完成 ${op.done}/${op.total}，可继续）` : `已取消（完成 ${op.done} 项）`
    case 'failed':
      return op.failures.length === op.total
        ? `失败 ${op.failures.length} 项`
        : `部分失败（成功 ${op.done}，失败 ${op.failures.length}）`
  }
}
</script>

<template>
  <div v-if="shown.length" class="ops">
    <div v-for="op in shown" :key="op.id" class="op" :class="op.status">
      <div class="head">
        <span class="label">{{ op.label }}</span>
        <span class="stat">{{ statusText(op) }}</span>
        <!-- 断点续传：取消后剩下的条目还在，接着跑就行（已经做完的不重做） -->
        <button v-if="op.resumable" class="mini resume" @click="onResume(op.id)">继续未完成</button>
        <button v-else-if="op.status === 'running' && op.total > 1" class="mini" @click="onCancel">
          取消
        </button>
        <button v-else class="mini icon" aria-label="收起" @click="onDismiss(op.id)">
          <X :size="12" />
        </button>
      </div>
      <div v-if="op.status === 'running' && op.total > 1" class="track">
        <i :style="{ transform: `scaleX(${pct(op) / 100})` }" />
      </div>
      <p v-for="(f, i) in op.failures.slice(0, 2)" :key="i" class="fail">
        <TriangleAlert :size="11" /> {{ f }}
      </p>
      <p v-if="op.failures.length > 2" class="fail more">
        另有 {{ op.failures.length - 2 }} 条失败未列出
      </p>
    </div>
  </div>
</template>

<style scoped>
.ops {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.op {
  padding: 8px 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.op.failed {
  background: var(--danger-soft);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-footnote);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.mini {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--accent);
  font-size: var(--fs-micro);
}

.mini.resume {
  background: var(--accent);
  color: #fff;
}

.mini.icon {
  padding: 3px;
  color: var(--text-3);
}

.track {
  display: block;
  height: 3px;
  margin-top: 6px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transform-origin: left center;
  transition: transform 0.2s var(--ease-standard);
}

.fail {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  font-size: var(--fs-micro);
  color: var(--danger-strong);
}

.fail.more {
  color: var(--text-3);
}
</style>
