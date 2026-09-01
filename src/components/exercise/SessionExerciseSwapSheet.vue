<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { usePlanStore } from '@/stores/plan'
import { exerciseSub } from '@/utils/plan'
import type { PlanExercise, PlanExerciseKind } from '@/types'

/**
 * 沉浸模式 · 临时换动作选择面板（嵌套抽屉）。
 * 候选池 = 课程库里全部课程出现过的动作，按「课程 × 动作」不去重地列出
 * （同名动作可能来自不同课程，副标题标明出处，用户按上下文自行选择）。
 * 只允许换成与被替换动作同类型（力量↔力量、计时↔计时）的动作：
 * 编排（组数/次数/休息/热身）沿用本课程原动作，换类型会让参数对不上。
 */
const props = defineProps<{
  open: boolean
  /** 只列出该类型的动作 */
  kind: PlanExerciseKind
  /** 被替换动作的名称（同名候选无意义，直接排除） */
  currentName: string
}>()

const emit = defineEmits<{
  close: []
  pick: [exercise: PlanExercise]
}>()

const planStore = usePlanStore()
const kw = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    kw.value = ''
    void planStore.ensureLoaded()
  },
)

interface Candidate {
  key: string
  ex: PlanExercise
  planName: string
}

const candidates = computed<Candidate[]>(() => {
  const out: Candidate[] = []
  for (const p of planStore.plans) {
    for (const ex of p.exercises) {
      if (ex.kind !== props.kind) continue
      if (ex.name === props.currentName) continue
      out.push({ key: `${p.id}__${ex.id}`, ex, planName: p.name })
    }
  }
  return out
})

const filtered = computed<Candidate[]>(() => {
  const q = kw.value.trim().toLowerCase()
  if (!q) return candidates.value
  return candidates.value.filter(
    (c) => c.ex.name.toLowerCase().includes(q) || c.planName.toLowerCase().includes(q),
  )
})

const KIND_LABEL: Record<PlanExerciseKind, string> = {
  strength: '力量动作',
  timed: '计时动作',
  cardio: '有氧动作',
}
</script>

<template>
  <SheetModal :open="open" :title="`换成哪个${KIND_LABEL[kind]}？`" initial-snap="large" @close="emit('close')">
    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作或课程" aria-label="搜索动作" />
    </div>

    <p class="hint">只替换动作本体，组数 / 次数 / 组间休息沿用本课程当前动作。</p>

    <ul class="list">
      <li v-for="c in filtered" :key="c.key">
        <button type="button" class="cand col" @click="emit('pick', c.ex)">
          <span class="cname">{{ c.ex.name }}</span>
          <span class="cmeta t-3">{{ c.planName }} · {{ exerciseSub(c.ex) }}</span>
        </button>
      </li>
    </ul>

    <p v-if="filtered.length === 0" class="empty">
      {{ candidates.length === 0 ? '课程库里还没有同类动作' : '没有匹配的动作' }}
    </p>
  </SheetModal>
</template>

<style scoped>
.searchrow {
  gap: 7px;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-3);
}

.search {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.hint {
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}

.list {
  margin-top: 10px;
}

.cand {
  width: 100%;
  gap: 2px;
  padding: 10px 2px;
  text-align: left;
  border-radius: var(--radius-s);
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.cname {
  font-size: var(--fs-callout);
  font-weight: 600;
}

.cmeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  padding: 34px 0;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
</style>
