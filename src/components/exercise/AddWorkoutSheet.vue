<script setup lang="ts">
import { computed, ref } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { estimateKcal, INTENSITY_LABELS, WORKOUT_META } from '@/config/domain'
import { useExerciseStore } from '@/stores/exercise'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { todayStr } from '@/utils/date'
import type { Intensity, WorkoutType } from '@/types'

/** 快速记录运动：类型 + 时长 + 强度 → MET 自动估算消耗。 */
defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: [] }>()

const exercise = useExerciseStore()
const nutrition = useNutritionStore()
const { toast } = useToast()

type Entry = WorkoutType
const types = Object.keys(WORKOUT_META) as Entry[]

const type = ref<WorkoutType>('run')
const durationMin = ref(30)
const intensity = ref<Intensity>('moderate')

const kcal = computed(() =>
  estimateKcal(type.value, intensity.value, durationMin.value, nutrition.profile?.weightKg ?? 70),
)

function bump(delta: number): void {
  durationMin.value = Math.min(240, Math.max(5, durationMin.value + delta))
}

async function save(): Promise<void> {
  const meta = WORKOUT_META[type.value]
  const name = `${meta.label} · ${durationMin.value}分钟`
  await exercise.add({
    name,
    type: type.value,
    date: todayStr(),
    startMin: null,
    durationMin: durationMin.value,
    intensity: intensity.value,
    kcal: kcal.value,
    note: null,
  })
  toast(`已记录 ${name}，消耗 ${kcal.value} 大卡`)
  emit('close')
}
</script>

<template>
  <SheetModal :open title="记运动" @close="emit('close')">
    <!-- 运动类型 -->
    <ul class="types">
      <li v-for="t in types" :key="t">
        <button class="chip" :class="{ on: t === type }" @click="type = t">
          {{ WORKOUT_META[t].label }}
        </button>
      </li>
    </ul>

    <!-- 时长 -->
    <div class="stepper row between">
      <button aria-label="减少5分钟" @click="bump(-5)"><Minus :size="18" /></button>
      <span class="num"><b>{{ durationMin }}</b> 分钟</span>
      <button aria-label="增加5分钟" @click="bump(5)"><Plus :size="18" /></button>
    </div>

    <SegmentedControl
      v-model="intensity"
      :options="(Object.keys(INTENSITY_LABELS) as Intensity[]).map((i) => ({ value: i, label: INTENSITY_LABELS[i] }))"
    />

    <div class="row preview between">
      <span>预计消耗 <b class="num">{{ kcal }}</b> 大卡</span>
      <button class="save" @click="save">保存</button>
    </div>

    <p class="hint t-3">按 MET × 体重估算；保存后自动计入「能量与营养」的运动消耗。</p>
  </SheetModal>
</template>

<style scoped>
.types {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.chip {
  width: 100%;
  padding: 11px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
  transition: all var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  color: #fff;
}

.stepper {
  margin-top: 14px;
  padding: 8px 6px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.stepper button {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1), 0 0 0 0.5px var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
}

.stepper b {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.5px;
  margin-right: 4px;
}

.preview span {
  font-size: var(--fs-body);
  color: var(--text-2);
}

.preview b {
  color: var(--c-exercise);
  font-weight: 800;
}

.save {
  padding: 12px 26px;
  border-radius: var(--radius-full);
  background: var(--ok);
  color: #fff;
  font-size: var(--fs-body);
  font-weight: 600;
}

.hint {
  font-size: var(--fs-caption);
}
</style>
