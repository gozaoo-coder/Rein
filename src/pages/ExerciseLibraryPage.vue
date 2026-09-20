<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, Dumbbell, Plus, Search } from 'lucide-vue-next'

import ExerciseFormSheet from '@/components/exercise/ExerciseFormSheet.vue'
import ExerciseLibrarySheet from '@/components/exercise/ExerciseLibrarySheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_CATEGORY_META, EXERCISE_EQUIPMENT_LABELS } from '@/config/domain'
import { MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import type { ExerciseCategory, ExerciseRecord } from '@/types'

/**
 * 动作库（/sports/exercises）：全部运动动作的唯一真源。
 * 搜索 + 分类筛选 + 逐条进详情（肌群图 / 重量曲线 / 今日建议）；
 * 内置动作只读（可隐藏），自建动作可增删改。
 */
const lib = useExerciseLibStore()

const kw = ref('')
const category = ref<ExerciseCategory | ''>('')
const showHidden = ref(false)
const detail = ref<ExerciseRecord | null>(null)
const detailOpen = ref(false)
const formOpen = ref(false)
const editing = ref<ExerciseRecord | null>(null)

onMounted(() => void lib.load(true))

/** 隐藏的内置动作始终在内存里（管理用），只在 UI 上按开关过滤 */
const rows = computed(() =>
  lib.search(kw.value, { category: category.value || undefined, includeHidden: showHidden.value }),
)

const hiddenCount = computed(() => lib.list.filter((e) => e.hidden).length)

function muscleLine(e: ExerciseRecord): string {
  const mains = (Object.entries(e.muscles ?? {}) as [MuscleKey, number][])
    .filter(([, lv]) => lv === 3)
    .map(([m]) => MUSCLE_LABELS[m])
  if (mains.length) return mains.join(' · ')
  return EXERCISE_CATEGORY_LABELS[e.category]
}

function subtitleOf(e: ExerciseRecord): string {
  const bits: string[] = []
  if (e.equipment) bits.push(EXERCISE_EQUIPMENT_LABELS[e.equipment])
  if (e.sessions > 0) bits.push(`练过 ${e.sessions} 次`)
  else bits.push('还没练过')
  return bits.join(' · ')
}

function openDetail(e: ExerciseRecord): void {
  detail.value = e
  detailOpen.value = true
}

/** 详情里的动作被编辑/删除后：刷新列表并同步抽屉里的那份引用 */
function onChanged(): void {
  void lib.load(true)
}

function onEdit(e: ExerciseRecord): void {
  detailOpen.value = false
  editing.value = e
  formOpen.value = true
}

function startCreate(): void {
  editing.value = null
  formOpen.value = true
}

function onSaved(e: ExerciseRecord): void {
  void lib.load(showHidden.value)
  // 新建后直接打开详情，方便立刻看曲线与今日建议
  if (e) openDetail(e)
}
</script>

<template>
  <div class="page">
    <PageHeader
      back
      title="动作库"
      :subtitle="`${lib.list.length} 个动作 · 课程的唯一动作来源`"
    />

    <div class="searchrow row">
      <Search :size="15" />
      <input v-model="kw" class="search" type="search" placeholder="搜索动作名或别名" aria-label="搜索动作" />
    </div>

    <div class="chips row">
      <button class="chip" :class="{ on: category === '' }" @click="category = ''">全部</button>
      <button
        v-for="c in EXERCISE_CATEGORY_META"
        :key="c.key"
        class="chip"
        :class="{ on: category === c.key }"
        @click="category = c.key"
      >
        {{ c.label }}
      </button>
    </div>

    <ul class="list">
      <li v-for="e in rows" :key="e.id">
        <button type="button" class="exrow row" @click="openDetail(e)">
          <span class="col main">
            <span class="ename">
              {{ e.name }}
              <b v-if="e.isCustom" class="tag">自建</b>
              <b v-if="e.hidden" class="tag muted">已隐藏</b>
            </span>
            <span class="emeta t-3">{{ muscleLine(e) }} · {{ subtitleOf(e) }}</span>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
      </li>
    </ul>

    <EmptyState
      v-if="rows.length === 0"
      :icon="Dumbbell"
      title="没有匹配的动作"
      hint="换个关键词，或在下方新建一个自定义动作"
    />

    <button class="newrow row center" @click="startCreate">
      <Plus :size="17" /> 新建自定义动作
    </button>

    <label v-if="hiddenCount > 0 || showHidden" class="hiddenrow row">
      <span>显示已隐藏的动作（{{ hiddenCount }}）</span>
      <ToggleSwitch :model-value="showHidden" label="显示已隐藏的动作" @update:model-value="showHidden = $event" />
    </label>

    <ExerciseLibrarySheet
      :open="detailOpen"
      :exercise="detail"
      @close="detailOpen = false"
      @changed="onChanged"
      @edit="onEdit"
    />

    <ExerciseFormSheet
      :open="formOpen"
      :exercise="editing"
      @close="formOpen = false"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.searchrow {
  gap: 7px;
  height: 40px;
  padding: 0 13px;
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

.chips {
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.chip {
  padding: 7px 14px;
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
  margin-top: 14px;
}

.exrow {
  width: 100%;
  gap: 10px;
  padding: 12px 2px;
  text-align: left;
}

.list li + li {
  border-top: 0.5px solid var(--line);
}

.exrow .main {
  flex: 1;
  min-width: 0;
  gap: 3px;
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
  background: var(--c-exercise-soft);
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--c-exercise-deep);
}

.tag.muted {
  background: var(--surface-3);
  color: var(--text-3);
}

.emeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.newrow {
  width: 100%;
  margin-top: 16px;
  gap: 6px;
  padding: 14px 0;
  border-radius: var(--radius-l);
  border: 1.5px dashed var(--line-strong);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: 600;
}

.hiddenrow {
  margin-top: 16px;
  padding: 12px 2px 0;
  justify-content: space-between;
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
