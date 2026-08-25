<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, Plus } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import { useTodoStore } from '@/stores/todo'
import { cmpUrgency } from '@/utils/todo'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import TodoItem from './TodoItem.vue'

/** 主页「待办」卡：按紧急程度排序仅展示前 3 条；「查看全部」进 /todos 二级页。 */
const props = defineProps<{ date: string }>()

const router = useRouter()
const store = useTodoStore()
const addOpen = ref(false)

const urgent = computed(() => [...store.allTodos].sort(cmpUrgency).slice(0, 3))
const openCount = computed(() => store.allTodos.filter((t) => t.status !== 'done').length)

onMounted(() => {
  void store.loadAll()
})
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>待办</h2>
      <div class="row center">
        <button class="add row center" aria-label="添加待办" @click="addOpen = true">
          <Plus :size="17" :stroke-width="2.4" />
        </button>
        <button class="all-link row center" @click="router.push('/todos')">
          <span class="num">全部 {{ store.allTodos.length }}</span>
          <ChevronRight :size="15" />
        </button>
      </div>
    </header>

    <ul v-if="urgent.length" class="list">
      <TodoItem v-for="t in urgent" :key="t.id" :todo="t" />
    </ul>
    <p v-else class="empty t-3">还没有待办，点右上角「+」添加一条吧</p>

    <template v-if="store.allTodos.length > 3">
      <p class="foot t-3">
        按紧急程度排序 · 另有 {{ store.allTodos.length - 3 }} 条未展示
        <router-link class="more" to="/todos">查看全部</router-link>
      </p>
    </template>
    <p v-else-if="urgent.length" class="foot t-3">
      <span class="num">{{ openCount }}</span> 条未完成
    </p>

    <SmartAddSheet :open="addOpen" :date="props.date" @close="addOpen = false" />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.add {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
}

.all-link {
  gap: 1px;
  padding: 5px 2px 5px 10px;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.all-link:active {
  opacity: 0.6;
}

.list {
  margin-top: 6px;
}

.empty {
  padding: 22px 0 14px;
  text-align: center;
}

.foot {
  padding-bottom: 4px;
}

.more {
  margin-left: 6px;
  font-weight: 700;
  color: var(--accent);
}

.more::after {
  content: ' ›';
}
</style>
