<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ActionSheet from '@/components/common/ActionSheet.vue'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { EXERCISE_CATEGORY_LABELS, EXERCISE_EQUIPMENT_LABELS, EXERCISE_KIND_LABELS } from '@/config/domain'
import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useToast } from '@/composables/useToast'
import { fmtDateCn, todayStr } from '@/utils/date'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'
import { computeTrainingAdvice, type ExerciseAdvice } from '@/utils/trainingAdvice'
import type { ExerciseRecord, PlanExercise } from '@/types'

/**
 * 动作库 · 动作详情。
 * 内容 = 名称与分类 + 激活肌群图 + 今日建议（按库内默认处方 + 历史算） +
 * 重量曲线（按动作库 id）+ 训练参数 + 动作要点 + 自建动作的编辑/删除。
 */
const props = defineProps<{
  open: boolean
  exercise: ExerciseRecord | null
}>()

const emit = defineEmits<{
  close: []
  changed: []
  edit: [exercise: ExerciseRecord]
}>()

const lib = useExerciseLibStore()
const { toast } = useToast()

const curveDays = ref<StrengthDay[]>([])
const advice = ref<ExerciseAdvice | null>(null)
const loading = ref(false)
const confirmDelete = ref(false)

/** 库内动作 → 建议引擎的输入形状（组数/次数/重量取库内默认处方） */
function asPlanExercise(e: ExerciseRecord): PlanExercise {
  return {
    id: 'preview',
    exerciseId: e.id,
    name: e.name,
    kind: e.kind,
    sets: e.defaultSets,
    reps: e.defaultReps,
    weightKg: e.defaultWeightKg,
    targetSec: e.defaultTargetSec,
    durationMin: e.defaultDurationMin,
    restSec: e.defaultRestSec,
    tips: e.tips,
    muscles: e.muscles,
  }
}

async function load(e: ExerciseRecord): Promise<void> {
  loading.value = true
  advice.value = null
  curveDays.value = []
  try {
    const [rows, recent] = await Promise.all([
      sessionService.strengthHistory(e.id),
      sessionService.strengthRecentSets(42),
    ])
    curveDays.value = aggregateStrengthDays(rows).slice(-10)
    const result = computeTrainingAdvice({
      sets: recent,
      library: lib.list,
      planExercises: [asPlanExercise(e)],
      today: todayStr(),
    })
    advice.value = result.perExercise[e.id] ?? null
  } catch {
    /* 建议与曲线都只是参考：失败静默，页面其余内容照常 */
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.exercise?.id] as const,
  ([open, id]) => {
    if (open && id && props.exercise) void load(props.exercise)
  },
  { immediate: true },
)

const metaLine = computed(() => {
  const e = props.exercise
  if (!e) return ''
  const bits = [EXERCISE_KIND_LABELS[e.kind], EXERCISE_CATEGORY_LABELS[e.category]]
  if (e.equipment) bits.push(EXERCISE_EQUIPMENT_LABELS[e.equipment])
  if (e.sessions > 0) bits.push(`练过 ${e.sessions} 次`)
  return bits.join(' · ')
})

const stats = computed<{ k: string; v: string }[]>(() => {
  const e = props.exercise
  if (!e) return []
  if (e.kind === 'strength') {
    return [
      { k: '默认组数', v: `${e.defaultSets} 组` },
      { k: '每组次数', v: e.defaultReps != null ? `${e.defaultReps} 次` : '—' },
      { k: '默认重量', v: e.defaultWeightKg != null ? `${fmtKg(e.defaultWeightKg)} kg` : '自重' },
      { k: '组间休息', v: `${e.defaultRestSec} 秒` },
    ]
  }
  if (e.kind === 'timed') {
    return [
      { k: '默认组数', v: `${e.defaultSets} 组` },
      { k: '每组时长', v: e.defaultTargetSec != null ? `${e.defaultTargetSec} 秒` : '—' },
      { k: '组间休息', v: `${e.defaultRestSec} 秒` },
    ]
  }
  return [{ k: '默认时长', v: e.defaultDurationMin != null ? `${e.defaultDurationMin} 分钟` : '—' }]
})

const lastSetLine = computed(() => {
  const d = curveDays.value[curveDays.value.length - 1]
  if (!d) return ''
  const chips = d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}×${s.reps ?? '?'}`).join(' · ')
  return `${chips}（${fmtDateCn(d.date)}）`
})

const adviceLine = computed(() => {
  const a = advice.value
  if (!a) return ''
  if (a.suggestedWeight == null) return a.hasHistory ? '自重动作：按目标次数推进' : '暂无历史记录'
  return `建议 ${fmtKg(a.suggestedWeight)}kg × ${a.suggestedReps ?? '—'} × ${a.suggestedSets} 组 · 今日状态 ×${a.readiness.toFixed(2)}`
})

async function hideFromLibrary(): Promise<void> {
  const e = props.exercise
  if (!e) return
  try {
    await lib.remove(e.id)
    toast('已从动作库隐藏（历史记录保留）')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败')
  }
}

async function restoreToLibrary(): Promise<void> {
  const e = props.exercise
  if (!e) return
  try {
    await lib.restore(e.id)
    toast('已恢复显示')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败')
  }
}

async function removeCustom(): Promise<void> {
  const e = props.exercise
  if (!e) return
  confirmDelete.value = false
  try {
    await lib.remove(e.id)
    toast('动作已删除（历史记录保留）')
    emit('changed')
    emit('close')
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败')
  }
}
</script>

<template>
  <SheetModal :open="open" title="动作详情" initial-snap="large" @close="emit('close')">
    <template v-if="exercise">
      <div class="titlerow row">
        <h3 class="name">{{ exercise.name }}</h3>
        <span v-if="exercise.isCustom" class="badge">自建</span>
        <span v-else-if="exercise.hidden" class="badge muted">已隐藏</span>
      </div>
      <p class="sub">{{ metaLine }}</p>

      <template v-if="Object.keys(exercise.muscles ?? {}).length">
        <p class="sec">激活肌群</p>
        <div class="mapcard">
          <MuscleMap :activation="exercise.muscles" />
        </div>
      </template>

      <p class="sec">今日建议<span class="secsub">按库内默认处方与你的历史推算</span></p>
      <div class="advicecard">
        <p class="adviceline num">{{ loading ? '计算中…' : adviceLine }}</p>
        <p v-if="advice?.rationale.length" class="advicewhy">{{ advice.rationale[0] }}</p>
      </div>

      <template v-if="curveDays.length">
        <p class="sec">重量曲线<span class="secsub">每次训练的最大重量组</span></p>
        <div class="curvebox">
          <WeightCurve :days="curveDays" :height="130" />
          <p class="lastline num">{{ lastSetLine }}</p>
        </div>
      </template>

      <p class="sec">训练参数</p>
      <div class="stats">
        <div v-for="s in stats" :key="s.k" class="cell">
          <div class="v num">{{ s.v }}</div>
          <div class="k">{{ s.k }}</div>
        </div>
      </div>

      <template v-if="exercise.tips">
        <p class="sec">动作要点</p>
        <p class="tips">{{ exercise.tips }}</p>
      </template>

      <div class="ops col">
        <template v-if="exercise.isCustom">
          <button class="op" @click="emit('edit', exercise)">编辑动作</button>
          <button class="op danger" @click="confirmDelete = true">删除动作</button>
        </template>
        <button v-else-if="exercise.hidden" class="op" @click="void restoreToLibrary()">恢复显示</button>
        <button v-else class="op" @click="void hideFromLibrary()">从库中隐藏</button>
      </div>
    </template>
  </SheetModal>

  <ActionSheet
    :open="confirmDelete"
    title="删除这个自建动作？"
    :actions="[
      { label: '删除动作', value: 'del', danger: true },
      { label: '取消', value: 'cancel' },
    ]"
    @select="(v: string) => (v === 'del' ? void removeCustom() : (confirmDelete = false))"
    @close="confirmDelete = false"
  />
</template>

<style scoped>
.titlerow {
  gap: 10px;
  align-items: center;
}

.name {
  font-size: var(--fs-title2);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.badge.muted {
  background: var(--surface-3);
  color: var(--text-3);
}

.sub {
  margin-top: 4px;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.sec {
  margin: 18px 0 10px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--text-3);
}

.secsub {
  margin-left: 8px;
  font-weight: 500;
  letter-spacing: 0;
}

.mapcard,
.advicecard,
.curvebox {
  border-radius: var(--radius-l);
  background: var(--surface-2);
  padding: 14px 12px 10px;
}

.advicecard {
  padding: 13px 14px;
}

.adviceline {
  font-size: var(--fs-callout);
  font-weight: 700;
}

.advicewhy {
  margin-top: 5px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.6;
}

.lastline {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.cell {
  background: var(--surface-2);
  border-radius: 14px;
  padding: 12px 14px;
}

.cell .v {
  font-size: var(--fs-title2);
  font-weight: 300;
  letter-spacing: -0.5px;
}

.cell .k {
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-top: 2px;
}

.tips {
  font-size: var(--fs-callout);
  color: var(--text-1);
  line-height: 1.7;
  white-space: pre-line;
}

.ops {
  margin-top: 18px;
  gap: 10px;
}

.op {
  width: 100%;
  padding: 13px 0;
  border-radius: var(--radius-l);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
}

.op.danger {
  color: var(--danger);
}
</style>
