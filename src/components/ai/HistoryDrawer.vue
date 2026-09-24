<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquarePlus, X } from 'lucide-vue-next'

import { useAiStore } from '@/stores/ai'

/** 历史记录抽屉：会话列表（最新置顶）+ 新对话；点击切换会话。 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const ai = useAiStore()

/** 更新时间展示：今天 HH:mm，否则 MM-DD HH:mm */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

const list = computed(() => ai.chats)

async function onPick(id: string): Promise<void> {
  emit('close')
  await ai.selectChat(id)
}

async function onNew(): Promise<void> {
  emit('close')
  await ai.newChat()
}

function onMask(): void {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dk-mask">
      <div v-if="open" class="dk-mask" @click="onMask" />
    </Transition>
    <Transition name="dk-panel">
      <aside v-if="open" class="dk-panel" role="dialog" aria-label="历史记录">
        <header class="dk-head row between center">
          <h2>历史记录</h2>
          <div class="row center">
            <button class="dk-new row center" aria-label="新对话" @click="onNew">
              <MessageSquarePlus :size="15" />
              新对话
            </button>
            <button class="dk-close" aria-label="关闭" @click="emit('close')">
              <X :size="18" />
            </button>
          </div>
        </header>

        <ul class="dk-list" data-rubber-self>
          <li v-for="c in list" :key="c.id">
            <button
              class="dk-item"
              :class="{ on: c.id === ai.chatId }"
              @click="onPick(c.id)"
            >
              <p class="dk-title">{{ c.title }}</p>
              <p class="dk-time t-3">{{ fmtTime(c.updatedAt) }}</p>
            </button>
          </li>
        </ul>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dk-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.dk-panel {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 111;
  width: min(320px, 86vw);
  background: var(--surface);
  box-shadow: var(--shadow-float);
  border-radius: 0 var(--radius-l) var(--radius-l) 0;
  display: flex;
  flex-direction: column;
  padding: var(--safe-top, 0px) 0 0;
}

.dk-head {
  padding: 16px 14px 10px;
  gap: 8px;
}

.dk-head h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
  flex: 1;
  min-width: 0;
}

.dk-new {
  gap: 5px;
  padding: 7px 12px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  flex: none;
}

.dk-close {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dk-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px calc(var(--safe-bottom, 0px) + 14px);
  scrollbar-width: none;
}

.dk-item {
  width: 100%;
  text-align: left;
  padding: 12px 12px;
  margin-bottom: 6px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dk-item.on {
  background: color-mix(in srgb, var(--accent) 13%, var(--surface-2));
}

.dk-item.on .dk-title {
  color: var(--accent);
}

.dk-title {
  font-size: var(--fs-subhead);
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dk-time {
  font-size: var(--fs-caption);
}

/* 抽屉动效 */
.dk-mask-enter-active,
.dk-mask-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.dk-mask-enter-from,
.dk-mask-leave-to {
  opacity: 0;
}

.dk-panel-enter-active {
  transition: transform var(--dur-sheet) var(--ease-sheet);
}

/* 退出更快：收起不恋战 */
.dk-panel-leave-active {
  transition: transform var(--dur-base) var(--ease-standard);
}

.dk-panel-enter-from,
.dk-panel-leave-to {
  transform: translateX(-100%);
}
</style>
