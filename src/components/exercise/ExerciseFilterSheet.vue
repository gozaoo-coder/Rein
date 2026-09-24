<script setup lang="ts">
import { computed } from 'vue'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { EXERCISE_EQUIPMENT_LABELS, EXERCISE_KIND_LABELS } from '@/config/domain'
import { MUSCLE_GROUPS, MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { EMPTY_EXERCISE_FILTER, filterBadgeCount } from '@/types'
import type { ExerciseEquipment, ExerciseFilterState, ExerciseKind, ExerciseSort } from '@/types'

/**
 * 动作库筛选面板（动作库页与动作选择器共用）：
 * 排序 / 器材 / 类型 / 肌群（可多选，按部位分组）/ 只看收藏。
 * 分类（推拉腿…）留在页面主浏览轴上，不进这个面板。
 */
const props = defineProps<{
  open: boolean
  modelValue: ExerciseFilterState
  /** 结果条数（面板底部实时反馈，避免「筛完是空的」） */
  resultCount?: number
}>()

const emit = defineEmits<{
  close: []
  'update:modelValue': [filter: ExerciseFilterState]
}>()

const SORT_OPTIONS: { value: ExerciseSort; label: string }[] = [
  { value: 'recent', label: '最近使用' },
  { value: 'name', label: '名称' },
  { value: 'sessions', label: '练得最多' },
]

const EQUIPMENT_KEYS: ExerciseEquipment[] = [
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'band',
  'cardio',
  'other',
]

const KIND_KEYS: ExerciseKind[] = ['strength', 'timed', 'cardio']

const activeCount = computed(() => filterBadgeCount(props.modelValue))

function patch(part: Partial<ExerciseFilterState>): void {
  emit('update:modelValue', { ...props.modelValue, ...part })
}

function toggleMuscle(m: MuscleKey): void {
  const cur = props.modelValue.muscles
  patch({ muscles: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] })
}

function reset(): void {
  emit('update:modelValue', { ...EMPTY_EXERCISE_FILTER })
}

const chipsOf = (keys: string[], labels: Record<string, string>) =>
  keys.map((k) => ({ key: k, label: labels[k] }))
</script>

<template>
  <SheetModal :open="open" title="筛选与排序" initial-snap="large" @close="emit('close')">
    <div class="field">
      <span class="flabel">排序</span>
      <SegmentedControl
        :options="SORT_OPTIONS"
        :model-value="modelValue.sort"
        @update:model-value="patch({ sort: $event as ExerciseSort })"
      />
    </div>

    <div class="field">
      <span class="flabel">只看收藏</span>
      <label class="rowline row">
        <span class="hint">收藏的动作永远排在列表最前</span>
        <ToggleSwitch
          :model-value="modelValue.onlyFavorite"
          label="只看收藏"
          @update:model-value="patch({ onlyFavorite: $event })"
        />
      </label>
    </div>

    <div class="field">
      <span class="flabel">类型</span>
      <div class="chips row">
        <button class="chip" :class="{ on: modelValue.kind === '' }" @click="patch({ kind: '' })">
          全部
        </button>
        <button
          v-for="k in chipsOf(KIND_KEYS, EXERCISE_KIND_LABELS)"
          :key="k.key"
          class="chip"
          :class="{ on: modelValue.kind === k.key }"
          @click="patch({ kind: k.key as ExerciseKind })"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">器材</span>
      <div class="chips row">
        <button class="chip" :class="{ on: modelValue.equipment === '' }" @click="patch({ equipment: '' })">
          全部
        </button>
        <button
          v-for="k in chipsOf(EQUIPMENT_KEYS, EXERCISE_EQUIPMENT_LABELS)"
          :key="k.key"
          class="chip"
          :class="{ on: modelValue.equipment === k.key }"
          @click="patch({ equipment: k.key as ExerciseEquipment })"
        >
          {{ k.label }}
        </button>
      </div>
    </div>

    <div class="field">
      <span class="flabel">
        肌群
        <span class="fsub">可多选，命中任一块即出现</span>
        <button v-if="modelValue.muscles.length" class="clear" @click="patch({ muscles: [] })">
          清除（{{ modelValue.muscles.length }}）
        </button>
      </span>
      <div v-for="g in MUSCLE_GROUPS" :key="g.label" class="mgroup">
        <span class="ghead">{{ g.label }}</span>
        <div class="chips row">
          <button
            v-for="m in g.keys"
            :key="m"
            class="chip"
            :class="{ on: modelValue.muscles.includes(m) }"
            @click="toggleMuscle(m)"
          >
            {{ MUSCLE_LABELS[m] }}
          </button>
        </div>
      </div>
    </div>

    <div class="footer row">
      <button class="reset" :disabled="activeCount === 0" @click="reset">重置</button>
      <button class="done" @click="emit('close')">
        完成<span v-if="resultCount != null"> · {{ resultCount }} 个动作</span>
      </button>
    </div>
  </SheetModal>
</template>

<style scoped>
.field {
  display: block;
  padding: 10px 0;
}

.field + .field {
  border-top: 0.5px solid var(--line);
}

.flabel {
  display: block;
  margin-bottom: 7px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.fsub {
  margin-left: 8px;
  font-weight: 500;
  color: var(--text-3);
}

.clear {
  margin-left: 8px;
  font-size: var(--fs-micro);
  color: var(--c-exercise-deep);
}

.rowline {
  justify-content: space-between;
  gap: 10px;
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  padding: 6px 12px;
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

.mgroup + .mgroup {
  margin-top: 8px;
}

.ghead {
  display: block;
  margin-bottom: 5px;
  font-size: var(--fs-micro);
  letter-spacing: 1px;
  color: var(--text-3);
}

.footer {
  gap: 10px;
  margin-top: 14px;
}

.reset {
  padding: 13px 18px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-2);
}

.reset:disabled {
  opacity: 0.5;
}

.done {
  flex: 1;
  padding: 13px 0;
  border-radius: var(--radius-l);
  background: var(--c-exercise);
  font-size: var(--fs-callout);
  font-weight: 700;
  color: #fff;
}
</style>
