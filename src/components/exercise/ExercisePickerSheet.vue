<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus, Search, SlidersHorizontal } from 'lucide-vue-next'

import ExerciseFilterSheet from '@/components/exercise/ExerciseFilterSheet.vue'
import ExerciseFormSheet from '@/components/exercise/ExerciseFormSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_CATEGORY_META } from '@/config/domain'
import { MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { EMPTY_EXERCISE_FILTER, filterBadgeCount } from '@/types'
import type { ExerciseCategory, ExerciseFilterState, ExerciseKind, ExerciseRecord } from '@/types'

/**
 * 动作库选择器（课程编辑用）：搜索 + 分类 + 筛选（类型/器材/肌群/收藏/排序）+ 点选。
 * 库内没有合适动作时可当场「新建动作」——建完直接把新动作返回给调用方。
 */
const props = defineProps<{
  open: boolean
  /** 优先展示该类型（不强制过滤，切类型会把课程条目的字段清空） */
  kind?: ExerciseKind
  /** 当前已选动作 id（高亮） */
  currentId?: string
}>()

const emit = defineEmits<{
  close: []
  pick: [exercise: ExerciseRecord]
}>()

const lib = useExerciseLibStore()
const kw = ref('')
const filter = ref<ExerciseFilterState>({ ...EMPTY_EXERCISE_FILTER })
const filterOpen = ref(false)
const formOpen = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    kw.value = ''
    filter.value = { ...EMPTY_EXERCISE_FILTER }
    void lib.ensureLoaded()
  },
)

const category = computed<ExerciseCategory | ''>(() => filter.value.category)
const badge = computed(() => filterBadgeCount(filter.value))

function setCategory(c: ExerciseCategory | ''): void {
  filter.value = { ...filter.value, category: c }
}

/** 同类型优先排序（换类型会清空该条目的参数，放在后面以减少误触）；收藏仍置顶 */
const list = computed(() => {
  const rows = lib.search(kw.value, {
    category: filter.value.category || undefined,
    kind: filter.value.kind || undefined,
    equipment: filter.value.equipment || undefined,
    muscles: filter.value.muscles,
    onlyFavorite: filter.value.onlyFavorite,
    sort: filter.value.sort,
  })
  return [...rows].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    const ak = a.kind === props.kind ? 0 : 1
    const bk = b.kind === props.kind ? 0 : 1
    if (ak !== bk) return ak - bk
    return (b.sessions > 0 ? 1 : 0) - (a.sessions > 0 ? 1 : 0)
  })
})

function muscleLine(e: ExerciseRecord): string {
  const map = libraryMuscles(e)
  const mains = (Object.entries(map) as [MuscleKey, number][])
    .filter(([, lv]) => lv === 3)
    .map(([m]) => MUSCLE_LABELS[m])
  return mains.length ? mains.join(' · ') : EXERCISE_CATEGORY_LABELS[e.category]
}

function onCreated(e: ExerciseRecord): void {
  emit('pick', e)
  emit('close')
}
</script>

<template>
  <SheetModal :open="open" title="从动作库选择" initial-snap="large" @close="emit('close')">
    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作名或别名" aria-label="搜索动作" />
      <button class="filterbtn row" type="button" @click="filterOpen = true">
        <SlidersHorizontal :size="14" />
        <b v-if="badge" class="fcount">{{ badge }}</b>
      </button>
    </div>

    <div class="chips row">
      <button class="chip" :class="{ on: category === '' }" @click="setCategory('')">全部</button>
      <button
        v-for="c in EXERCISE_CATEGORY_META"
        :key="c.key"
        class="chip"
        :class="{ on: category === c.key }"
        @click="setCategory(c.key)"
      >
        {{ c.label }}
      </button>
    </div>

    <ul class="list" data-rubber-self>
      <li v-for="e in list" :key="e.id">
        <button
          type="button"
          class="rowitem col"
          :class="{ on: e.id === currentId }"
          @click="emit('pick', e)"
        >
          <span class="ename">{{ e.name }}<b v-if="e.isCustom" class="tag">自建</b></span>
          <span class="emeta t-3">{{ muscleLine(e) }}<template v-if="e.sessions > 0"> · 练过 {{ e.sessions }} 次</template></span>
        </button>
      </li>
    </ul>

    <p v-if="list.length === 0" class="empty">动作库里没有匹配的动作，可在下方新建</p>

    <button class="newrow row center" @click="formOpen = true">
      <Plus :size="16" /> 新建自定义动作
    </button>

    <ExerciseFormSheet :open="formOpen" :exercise="null" @close="formOpen = false" @saved="onCreated" />

    <ExerciseFilterSheet
      v-model="filter"
      :open="filterOpen"
      :result-count="list.length"
      @close="filterOpen = false"
    />
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

.filterbtn {
  gap: 4px;
  padding: 4px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-3);
  color: var(--text-2);
  flex: none;
}

.fcount {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--c-exercise);
  color: #fff;
  font-size: var(--fs-micro);
  line-height: 15px;
  text-align: center;
}

.chips {
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.chip {
  padding: 6px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.list {
  margin-top: 10px;
  max-height: 46vh;
  overflow: auto;
}

.rowitem {
  width: 100%;
  gap: 2px;
  padding: 10px 2px;
  text-align: left;
  border-radius: var(--radius-s);
}

.rowitem.on {
  background: var(--c-exercise-soft);
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.ename {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-callout);
  font-weight: 600;
}

.tag {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--surface-3);
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-3);
}

.emeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  padding: 20px 0 6px;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.newrow {
  width: 100%;
  margin-top: 12px;
  gap: 6px;
  padding: 13px 0;
  border-radius: var(--radius-l);
  border: 1.5px dashed var(--line-strong);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: 600;
}
</style>
