<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronDown, ListTodo, Plus } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { useTodoStore } from '@/stores/todo'
import type { TodoCategory } from '@/types'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import TodoItem from './TodoItem.vue'
import VirtualTimeline from './VirtualTimeline.vue'
import TimelineSheet from './TimelineSheet.vue'

/**
 * 今日待办卡：快速添加 + 列表 / 日时间线两种视图切换。
 * filterCategory 用于运动页只显示运动类待办。
 * listOnly 隐藏视图切换（专注页由独立的「今日日程」卡承载时间线）；
 * inlineLimit 限制内联条数，超出部分收进「全部待办」抽屉。
 */
const props = defineProps<{
  date: string
  title?: string
  filterCategory?: TodoCategory
  /** 只保留列表视图：隐藏列表/时间线分段与时间线抽屉入口 */
  listOnly?: boolean
  /** 内联最多展示条数；超出收进「全部待办」抽屉 */
  inlineLimit?: number
}>()

const store = useTodoStore()
const view = ref<'list' | 'timeline'>('list')
const addOpen = ref(false)
const timelineOpen = ref(false)
const allOpen = ref(false)

const todos = computed(() =>
  props.filterCategory
    ? store.dayTodos.filter((t) => t.category === props.filterCategory)
    : store.dayTodos,
)

const overLimit = computed(() => props.inlineLimit != null && todos.value.length > props.inlineLimit)

const visibleTodos = computed(() =>
  props.inlineLimit != null ? todos.value.slice(0, props.inlineLimit) : todos.value,
)

onMounted(() => {
  void store.loadAll()
})
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>{{ title ?? '今日待办' }}</h2>
      <SegmentedControl
        v-if="!listOnly"
        v-model="view"
        class="seg"
        :options="[
          { value: 'list', label: '列表' },
          { value: 'timeline', label: '时间线' },
        ]"
      />
    </header>

    <!-- 添加入口：点按弹完整添加抽屉（AI 智能添加 / 手动表单） -->
    <button class="adder row center" @click="addOpen = true">
      <Plus :size="18" class="t-3" />
      <span>添加待办</span>
    </button>

    <!-- 列表 -->
    <ul v-if="(listOnly || view === 'list') && todos.length > 0" class="list">
      <TodoItem v-for="t in visibleTodos" :key="t.id" :todo="t" />
    </ul>

    <!-- 时间线（不展开预览，点按弹出完整抽屉） -->
    <VirtualTimeline v-else-if="!listOnly && view === 'timeline'" :todos="store.allTodos" :date preview @open="timelineOpen = true" />

    <EmptyState
      v-else
      :icon="ListTodo"
      title="还没有待办"
      hint="点上方「添加待办」开始，带时间的会出现在时间线里"
    />

    <!-- 超出内联额度的部分收进抽屉 -->
    <button v-if="overLimit && !allOpen" class="all row center" @click="allOpen = true">
      查看全部 {{ todos.length }} 个待办
      <ChevronDown :size="14" :stroke-width="2.5" />
    </button>
  </section>

  <SmartAddSheet :open="addOpen" :date="props.date" :category="props.filterCategory" @close="addOpen = false" />

  <SheetModal :open="allOpen" title="全部待办" @close="allOpen = false">
    <ul class="list">
      <TodoItem v-for="t in todos" :key="t.id" :todo="t" />
    </ul>
  </SheetModal>

  <TimelineSheet v-if="!listOnly" :open="timelineOpen" :todos="store.allTodos" :date @close="timelineOpen = false" />
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.seg {
  width: 148px;
}

/* 添加按钮 */
.adder {
  gap: 8px;
  margin-top: 12px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-standard);
}

.adder:active {
  background: var(--surface);
}

.list {
  margin-top: 8px;
}

.all {
  width: 100%;
  gap: 4px;
  margin-top: 6px;
  padding: 9px 0;
  border-radius: var(--radius-s);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
  transition: background var(--dur-fast) var(--ease-standard);
}

.all:active {
  background: var(--surface-2);
}
</style>
