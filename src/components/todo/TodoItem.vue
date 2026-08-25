<script setup lang="ts">
import { ref } from 'vue'
import { Check, Pencil, Trash2 } from 'lucide-vue-next'

import { CATEGORY_META, priorityMeta } from '@/config/domain'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm } from '@/utils/date'
import type { Todo } from '@/types'
import TodoEditorSheet from './TodoEditorSheet.vue'

/** 单条待办行：点按勾选切换完成，点正文打开编辑（时间段/重要程度等完整字段），悬停显示编辑/删除。 */
defineProps<{ todo: Todo }>()

const store = useTodoStore()
const editorOpen = ref(false)
</script>

<template>
  <li class="item row" :class="{ done: todo.status === 'done' }">
    <button class="check" :aria-label="todo.status === 'done' ? '标记未完成' : '标记完成'" @click="store.toggle(todo)">
      <Check v-if="todo.status === 'done'" :size="13" :stroke-width="3.2" />
    </button>
    <div class="flex-1 body" @click="editorOpen = true">
      <p class="title">{{ todo.title }}</p>
      <p class="meta row">
        <template v-if="todo.startMin != null"><span class="num">{{ minToHHmm(todo.startMin) }}</span>·</template>
        <span class="cat row center">
          <i :style="{ background: `var(${CATEGORY_META[todo.category].colorVar})` }" />{{ CATEGORY_META[todo.category].label }}
        </span>
        <span
          v-if="todo.priority > 0"
          class="prio"
          :style="{ color: `var(${priorityMeta(todo.priority).colorVar})` }"
        >
          {{ priorityMeta(todo.priority).label }}
        </span>
      </p>
    </div>
    <div class="ops row">
      <button class="edit" aria-label="编辑待办" @click="editorOpen = true">
        <Pencil :size="16" />
      </button>
      <button class="del" aria-label="删除待办" @click="store.remove(todo)">
        <Trash2 :size="16" />
      </button>
    </div>

    <TodoEditorSheet :open="editorOpen" :todo @close="editorOpen = false" />
  </li>
</template>

<style scoped>
.item {
  gap: 12px;
  padding: 11px 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.check {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  transition: all var(--dur-fast) var(--ease-standard);
}

.done .check {
  background: var(--ok);
  border-color: var(--ok);
}

.body {
  min-width: 0;
}

.title {
  font-size: var(--fs-body);
  font-weight: 500;
}

.done .title {
  color: var(--text-3);
  text-decoration: line-through;
}

.meta {
  gap: 5px;
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.cat {
  gap: 4px;
}

.cat i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.prio {
  font-weight: 600;
}

.ops {
  gap: 8px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.edit,
.del {
  color: var(--text-3);
  padding: 2px;
}

.item:hover .ops {
  opacity: 1;
}

@media (hover: none) {
  .ops {
    opacity: 0.55;
  }
}
</style>
