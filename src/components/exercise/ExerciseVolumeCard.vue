<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

import { sessionService } from '@/services/sessionService'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useExerciseStore } from '@/stores/exercise'
import { useProgramStore } from '@/stores/program'
import { todayStr } from '@/utils/date'
import { parseBlob } from '@/utils/programEngine'
import { computeTrainingAdvice, type MuscleLoadRow } from '@/utils/trainingAdvice'

/**
 * 本周容量卡（运动页）：各肌群近 7 天加权组数 vs 科学建议区间。
 * 依据 = 每肌群每周组数地标（MEV/MAV/MRV，Israetel）+ 肌群激活档位折算
 * （主攻 1 组 / 辅助 0.5 / 稳定 0.25，见 utils/trainingAdvice）。
 * 无力量记录（或全部肌群无负荷）时整卡隐藏，不占位置。
 */
const exStore = useExerciseStore()
const lib = useExerciseLibStore()
const program = useProgramStore()

const rows = ref<MuscleLoadRow[]>([])
const loaded = ref(false)

const STATUS_LABEL: Record<MuscleLoadRow['status'], string> = {
  low: '偏低',
  ok: '达标',
  high: '充足',
  over: '超量',
}

/** 展示规则：本周有负荷的肌群优先，其次近 4 周练过但本周仍低于 MEV 的（提醒补量） */
const visible = computed(() => {
  const withLoad = rows.value.filter((r) => r.sets > 0)
  const behind = rows.value.filter((r) => r.sets < r.mev && r.lastDate && r.sets === 0)
  return [...withLoad, ...behind].slice(0, 7)
})

async function load(): Promise<void> {
  try {
    await lib.ensureLoaded()
    const sets = await sessionService.strengthRecentSets(42)
    // 有生效方案时用它的每周训练天数缩放目标区间（3 练取下沿、5 练取上沿）
    const trainingDays = program.active ? parseBlob(program.active).params.trainingDays : null
    const advice = computeTrainingAdvice({
      sets,
      library: lib.list,
      today: todayStr(),
      trainingDaysPerWeek: trainingDays,
    })
    rows.value = advice.muscleLoad
  } catch (e) {
    console.warn('[volume] 容量统计失败', e)
    rows.value = []
  } finally {
    loaded.value = true
  }
}

onMounted(() => void load())

/** 逐组记录落库（结束保存 / 删除训练）后刷新 */
watch(
  () => exStore.strengthRev,
  () => void load(),
)

function pct(r: MuscleLoadRow): number {
  if (r.mrv <= 0) return 0
  return Math.min(100, Math.round((r.sets / r.mrv) * 100))
}
</script>

<template>
  <section v-if="!loaded || visible.length" class="card">
    <header class="head">
      <h2>本周容量</h2>
      <span class="sub">各肌群做组数 vs 建议区间</span>
    </header>

    <ul class="rows">
      <li v-for="r in visible" :key="r.muscle" class="vrow">
        <span class="mname">{{ r.label }}</span>
        <span class="barwrap">
          <i class="bar" :class="r.status" :style="{ width: `${pct(r)}%` }" />
        </span>
        <span class="mnum num">{{ r.sets }}<small>/{{ r.mav }}</small></span>
        <span class="mstate" :class="r.status">{{ STATUS_LABEL[r.status] }}</span>
      </li>
    </ul>

    <p class="foot">
      建议区间 {{ visible[0] ? `${visible[0].mev}–${visible[0].mav}` : '' }} 组/周按肌群与训练天数缩放；
      间接刺激按激活档位折算（辅助 0.5 / 稳定 0.25 组）。
    </p>

    <RouterLink class="more row center" to="/sports/exercises">
      动作库<ChevronRight :size="14" />
    </RouterLink>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.sub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.rows {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.vrow {
  display: grid;
  grid-template-columns: 52px 1fr 56px 34px;
  align-items: center;
  gap: 9px;
}

.mname {
  font-size: var(--fs-footnote);
  font-weight: 600;
}

.barwrap {
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.bar {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--c-exercise);
  transition: width var(--dur-slow) var(--ease-standard);
}

.bar.low {
  background: var(--text-3);
}

.bar.high {
  background: var(--c-balance);
}

.bar.over {
  background: var(--danger);
}

.mnum {
  text-align: right;
  font-size: var(--fs-caption);
  font-weight: 700;
}

.mnum small {
  font-weight: 500;
  color: var(--text-3);
}

.mstate {
  font-size: var(--fs-micro);
  font-weight: 700;
  text-align: right;
  color: var(--text-3);
}

.mstate.ok {
  color: var(--c-exercise-deep);
}

.mstate.over {
  color: var(--danger);
}

.foot {
  margin-top: 12px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.6;
}

.more {
  margin-top: 10px;
  justify-content: flex-end;
  gap: 2px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--c-exercise-deep);
}
</style>
