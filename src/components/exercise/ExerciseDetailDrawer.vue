<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { fmtDateCn } from '@/utils/date'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'
import type { PlanExercise } from '@/types'
import { exerciseBadge, exerciseSub } from '@/utils/plan'

/** 动作详情抽屉：课程详情页点击动作唤起。
 *  内容 = 动作名与参数摘要 + 激活肌群图 + 训练参数格 + 重量变化曲线（有记录才显示）+ 动作要点。
 *  名称/肌群取动作库（改名跟随），曲线按动作库 id 查询。 */
const props = defineProps<{
  open: boolean
  exercise: PlanExercise | null
}>()

defineEmits<{ close: [] }>()

const lib = useExerciseLibStore()

/** 展示名：库内名优先（内置动作随种子更新），缺失回落课程条目快照 */
const displayName = computed(() => (props.exercise ? lib.resolveName(props.exercise) : ''))

/** 激活肌群：库内显式数据优先，其次课程条目，最后按名关键词识别 */
const activation = computed(() => (props.exercise ? lib.musclesOf(props.exercise) : null))

/* ---------- 重量曲线：打开且动作有力量记录时加载 ---------- */

const curveDays = ref<StrengthDay[]>([])
const curveLoadedFor = ref('')

watch(
  () => [props.open, props.exercise?.exerciseId, props.exercise?.name] as const,
  ([open, exerciseId, name]) => {
    const key = exerciseId || name || ''
    if (!open || !key || curveLoadedFor.value === key) return
    curveLoadedFor.value = key
    curveDays.value = []
    void sessionService
      .strengthHistory(key)
      .then((rows) => {
        curveDays.value = aggregateStrengthDays(rows).slice(-10)
      })
      .catch(() => {
        curveDays.value = []
      })
  },
  { immediate: true },
)

/** 最近一次的做组摘要行 */
const lastSetLine = computed(() => {
  const d = curveDays.value[curveDays.value.length - 1]
  if (!d) return ''
  const chips = d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}×${s.reps ?? '?'}`).join(' · ')
  return `${chips}（${fmtDateCn(d.date)}）`
})

const stats = computed<{ k: string; v: string }[]>(() => {
  const e = props.exercise
  if (!e) return []
  if (e.kind === 'strength') {
    const rows = [
      { k: '组数', v: `${e.sets} 组` },
      { k: '每组次数', v: e.reps != null ? `${e.reps} 次` : '—' },
      { k: '建议重量', v: e.weightKg != null ? `${e.weightKg} kg` : '自重' },
      { k: '组间休息', v: `${e.restSec} 秒` },
    ]
    if (e.warmups?.length) {
      rows.push({
        k: '激活热身',
        v: e.warmups.map((w) => `${fmtKg(w.weightKg)}kg×${w.reps}`).join(' / '),
      })
    }
    return rows
  }
  if (e.kind === 'timed') {
    return [
      { k: '组数', v: `${e.sets} 组` },
      { k: '每组时长', v: e.targetSec != null ? `${e.targetSec} 秒` : '—' },
      { k: '组间休息', v: `${e.restSec} 秒` },
    ]
  }
  return [{ k: '时长', v: e.durationMin != null ? `${e.durationMin} 分钟` : '—' }]
})
</script>

<template>
  <SheetModal :open="open" title="动作详情" @close="$emit('close')">
    <template v-if="exercise">
      <div class="titlerow row">
        <h3 class="name">{{ displayName }}</h3>
        <span v-if="exerciseBadge(exercise)" class="badge">{{ exerciseBadge(exercise) }}</span>
      </div>
      <p class="sub">{{ exerciseSub(exercise) }}</p>

      <template v-if="activation">
        <p class="sec">激活肌群</p>
        <div class="mapcard">
          <MuscleMap :activation="activation" />
        </div>
      </template>
      <p v-else class="unknown">暂无「{{ displayName }}」的肌群数据</p>

      <p class="sec">训练参数</p>
      <div class="stats">
        <div v-for="s in stats" :key="s.k" class="cell">
          <div class="v num">{{ s.v }}</div>
          <div class="k">{{ s.k }}</div>
        </div>
      </div>

      <template v-if="curveDays.length">
        <p class="sec">重量曲线<span class="secsub">每次训练的最大重量组</span></p>
        <div class="curvebox">
          <WeightCurve :days="curveDays" :height="130" />
          <p class="lastline num">{{ lastSetLine }}</p>
        </div>
      </template>

      <template v-if="exercise.tips">
        <p class="sec">动作要点</p>
        <p class="tips">{{ exercise.tips }}</p>
      </template>
    </template>
  </SheetModal>
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
  background: rgba(30, 234, 239, 0.14);
  color: #00858a;
}

@media (prefers-color-scheme: dark) {
  .badge {
    color: #1eeaef;
  }
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

.curvebox {
  border-radius: var(--radius-l);
  background: var(--surface-2);
  padding: 14px 12px 10px;
}

.lastline {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.mapcard {
  border-radius: var(--radius-l);
  background: var(--surface-2);
  padding: 14px 10px 10px;
}

.unknown {
  margin: 14px 0 0;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  color: var(--text-3);
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
</style>
