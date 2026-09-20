<script setup lang="ts">
import { watch } from 'vue'

/** iOS 操作面板：底部圆角卡片 + 选项列表 + 取消。用于确认类操作。 */
const props = defineProps<{
  open: boolean
  title?: string
  actions: { label: string; value: string; danger?: boolean }[]
}>()

const emit = defineEmits<{
  close: []
  select: [value: string]
}>()

/** 锁背景滚动；恢复打开前的值而非直接清空，避免盖在 SheetModal 上时提前解锁背景 */
let prevOverflow = ''
watch(
  () => props.open,
  (open) => {
    if (open) {
      prevOverflow = document.documentElement.style.overflow
      document.documentElement.style.overflow = 'hidden'
    } else {
      document.documentElement.style.overflow = prevOverflow
    }
  },
)

function pick(value: string): void {
  emit('select', value)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="as-mask">
      <div v-if="open" class="mask" @click="emit('close')" />
    </Transition>
    <Transition name="as-card">
      <div v-if="open" class="card-wrap" role="dialog" :aria-label="title ?? '操作'">
        <p v-if="title" class="title">{{ title }}</p>
        <button
          v-for="a in actions"
          :key="a.value"
          type="button"
          class="opt"
          :class="{ danger: a.danger }"
          @click="pick(a.value)"
        >
          {{ a.label }}
        </button>
        <button type="button" class="opt cancel" @click="emit('close')">取消</button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.card-wrap {
  position: fixed;
  bottom: calc(var(--dock-top) + 12px);
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 24px);
  max-width: calc(var(--frame-max) - 24px);
  z-index: 111;
  background: var(--surface);
  border-radius: var(--radius-l);
  padding: 8px;
  box-shadow: var(--shadow-float);
}

.title {
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
  padding: 10px 0 6px;
}

.opt {
  width: 100%;
  height: 50px;
  border-radius: var(--radius-m);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
}

.opt.danger {
  color: var(--danger);
}

.opt.cancel {
  margin-top: 6px;
  border-top: 0.5px solid var(--line);
  border-radius: var(--radius-m);
}

.as-mask-enter-active,
.as-mask-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.as-mask-enter-from,
.as-mask-leave-to {
  opacity: 0;
}

/* 进出同路径：自底弹起；退出更快（取消操作要干脆） */
.as-card-enter-active {
  transition:
    transform var(--dur-sheet) var(--ease-sheet),
    opacity var(--dur-sheet) var(--ease-sheet);
}

.as-card-leave-active {
  transition:
    transform 200ms var(--ease-standard),
    opacity 200ms var(--ease-standard);
}

.as-card-enter-from,
.as-card-leave-to {
  transform: translate(-50%, 24px);
  opacity: 0;
}
</style>
