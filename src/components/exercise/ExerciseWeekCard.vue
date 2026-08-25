<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ChevronRight, Flame } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import ExerciseBars from '@/components/exercise/ExerciseBars.vue'
import { useExerciseStore } from '@/stores/exercise'
import { WEEKDAY_LABELS } from '@/utils/date'

/** 本周运动概览：分钟柱状图 + 汇总，并说明与能量平衡的联动。
 *  linkTo 传入二级页路径时整卡可点，右侧显示「详情」角标（与 EnergySummary 同款）。 */
const props = defineProps<{ linkTo?: string }>()

const ex = useExerciseStore()
const router = useRouter()

onMounted(() => {
  if (ex.weekWorkouts.length === 0) void ex.loadWeek()
})

const bars = computed(() =>
  ex.minutesByDay.map((d) => ({
    label: WEEKDAY_LABELS[(new Date(d.date).getDay() + 6) % 7],
    value: d.minutes,
    highlight: d.isToday,
  })),
)

function goDetail(): void {
  if (props.linkTo) void router.push(props.linkTo)
}
</script>

<template>
  <section
    class="card"
    :class="{ pressable: !!linkTo }"
    :role="linkTo ? 'button' : undefined"
    :tabindex="linkTo ? 0 : undefined"
    @click="goDetail"
    @keydown.enter="goDetail"
  >
    <header class="row between head">
      <h2>本周运动</h2>
      <div class="row head-right">
        <span class="sum num"><b>{{ ex.weekMinutes }}</b> 分钟 · {{ ex.weekKcal }} 大卡</span>
        <button v-if="linkTo" class="more row center pressable" aria-label="查看全部运动记录" @click.stop="goDetail">
          详情<ChevronRight :size="14" />
        </button>
      </div>
    </header>

    <ExerciseBars class="chart" :bars="bars" />

    <footer class="row foot">
      <Flame :size="15" style="color: var(--c-exercise)" />
      今日消耗 <b class="num">{{ ex.todayKcal }}</b> 大卡，已计入「能量与营养」
    </footer>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head-right {
  gap: 8px;
}

.sum {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.sum b {
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
}

/* 「详情」角标：与 EnergySummary 的 more 胶囊同款 */
.more {
  gap: 1px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.chart {
  margin-top: 16px;
}

.foot {
  gap: 6px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.foot b {
  color: var(--text-1);
}

@media (prefers-reduced-motion: reduce) {
  /* 整卡按压缩放交由全局 .pressable 过渡，这里仅关闭图表高度动画 */
  .chart :deep(.track i) {
    transition: none;
  }
}
</style>
