<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ListTodo, Plus } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import TodoItem from '@/components/todo/TodoItem.vue'
import { useTodoStore } from '@/stores/todo'
import { diffDays, fmtDateCn, todayStr } from '@/utils/date'
import { cmpUrgency } from '@/utils/todo'
import type { Todo } from '@/types'

/** 全部待办二级页：按紧急程度排序、按日期分组（收件箱 / 今天 / 明天 / 历史）。 */
const store = useTodoStore()
const addOpen = ref(false)
const today = todayStr()

onMounted(() => {
  void store.loadAll()
})

const openCount = computed(() => store.allTodos.filter((t) => t.status !== 'done').length)

function groupLabel(d: string | null): string {
  if (!d) return '收件箱'
  const diff = diffDays(today, d)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return fmtDateCn(d)
}

interface Group {
  label: string
  date: string | null
  items: Todo[]
}

/**
 * 分组顺序：今天 → 明天 → 未来 → 历史（近到远）→ 收件箱。
 * 组内按紧急程度排序（cmpUrgency），保证同日期相邻聚合。
 */
function groupKey(d: string | null): number {
  if (!d) return 1e9
  const diff = diffDays(today, d)
  return diff >= 0 ? diff : 1000 - diff
}

const groups = computed<Group[]>(() => {
  const byDate = new Map<string | null, Todo[]>()
  for (const t of store.allTodos) {
    const arr = byDate.get(t.date) ?? []
    arr.push(t)
    byDate.set(t.date, arr)
  }
  return [...byDate.entries()]
    .sort((a, b) => groupKey(a[0]) - groupKey(b[0]))
    .map(([date, items]) => ({
      date,
      label: groupLabel(date),
      items: [...items].sort(cmpUrgency),
    }))
})
</script>

<template>
  <div class="page">
    <PageHeader title="全部待办" subtitle="按紧急程度排序" back>
      <template #action>
        <button class="hdr-btn" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="20" />
        </button>
      </template>
    </PageHeader>

    <template v-if="groups.length">
      <section v-for="g in groups" :key="g.date ?? 'inbox'" class="card group">
        <header class="row between ghead">
          <h2 class="glabel">{{ g.label }}</h2>
          <span class="num gcount">{{ g.items.length }}</span>
        </header>
        <ul class="list">
          <TodoItem v-for="t in g.items" :key="t.id" :todo="t" />
        </ul>
      </section>
      <p class="foot t-3 num">
        共 {{ store.allTodos.length }} 条 · {{ openCount }} 条未完成
      </p>
    </template>

    <EmptyState
      v-else
      :icon="ListTodo"
      title="还没有待办"
      hint="点右上角「+」，粘贴一句话让 AI 帮你拆成待办"
    />

    <SmartAddSheet :open="addOpen" :date="today" @close="addOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.group {
  margin-bottom: 12px;
  padding-bottom: 4px;
}

.ghead {
  padding-bottom: 4px;
}

.glabel {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-2);
}

.gcount {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.foot {
  text-align: center;
  padding: 14px 0 4px;
}
</style>
