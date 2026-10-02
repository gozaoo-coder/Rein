<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Search, X } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { fmtDateCn } from '@/utils/date'
import type { StrengthExerciseRef } from '@/types'

/**
 * 力量动作选择器：在**全部练过的动作**里选一个看重量曲线。
 *
 * 为什么不是一排 chips：chips 只在动作少时成立，而力量动作是有积累的
 * （真实使用里几十个很常见），一排 chips 既放不下也没法找。抽屉 + 搜索
 * 才是「我要找某个动作」这个意图的正确形状。
 *
 * 排序 = 最近练的在前（与后端 strengthExercises 的口径一致，这里只做兜底排序）：
 * 「上次练了什么」是最常见的入口，而不常用的动作靠搜索够得到。
 */
const props = defineProps<{
  open: boolean
  items: StrengthExerciseRef[]
  selected: string
}>()

const emit = defineEmits<{
  close: []
  pick: [key: string]
}>()

const query = ref('')

// 每次打开清空搜索：上次的关键词留在框里会让人以为列表被过滤过
watch(
  () => props.open,
  (o) => {
    if (o) query.value = ''
  },
)

function keyOf(r: StrengthExerciseRef): string {
  return r.exerciseId || r.name
}

const filtered = computed(() => {
  const kw = query.value.trim().toLowerCase()
  const list = [...props.items].sort((a, b) => b.lastDate.localeCompare(a.lastDate))
  if (!kw) return list
  return list.filter((r) => r.name.toLowerCase().includes(kw))
})

function pick(r: StrengthExerciseRef): void {
  emit('pick', keyOf(r))
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" title="选择动作" initial-snap="large" @close="emit('close')">
    <div class="finder row">
      <Search :size="16" class="t-3" />
      <input v-model="query" type="text" placeholder="按名称搜索，如「卧推」">
      <button v-if="query" class="clear" aria-label="清空搜索" @click="query = ''">
        <X :size="14" />
      </button>
    </div>

    <p class="count t-3">
      共 {{ filtered.length }} 个动作<template v-if="query">（已过滤）</template> · 按最近训练排序
    </p>

    <ul class="plist">
      <li v-for="r in filtered" :key="keyOf(r)">
        <button class="prow row" type="button" @click="pick(r)">
          <span class="pname flex-1">{{ r.name }}</span>
          <span class="pmeta num t-3">{{ r.sessions }} 次 · {{ fmtDateCn(r.lastDate) }}</span>
          <i v-if="keyOf(r) === selected" class="pcheck"><Check :size="14" :stroke-width="3" /></i>
        </button>
      </li>
    </ul>
    <p v-if="!filtered.length" class="empty t-3">
      {{ query ? '没有匹配的动作' : '还没有力量训练记录' }}
    </p>
  </SheetModal>
</template>

<style scoped>
.finder {
  gap: 8px;
  padding: 10px 13px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.finder input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.clear {
  flex: none;
  padding: 3px;
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-3);
}

.count {
  margin-top: 10px;
  font-size: var(--fs-caption);
}

.plist {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
}

.prow {
  width: 100%;
  gap: 10px;
  padding: 13px 2px;
  text-align: left;
}

li + li .prow {
  border-top: 0.5px solid var(--line);
}

.pname {
  font-size: var(--fs-body);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pmeta {
  flex: none;
  font-size: var(--fs-caption);
}

.pcheck {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.empty {
  padding: 20px 0;
  text-align: center;
  font-size: var(--fs-footnote);
}

@media (hover: hover) {
  .prow:hover {
    background: var(--surface-2);
    border-radius: var(--radius-m);
  }
}
</style>
