<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import WeightCurve from '@/components/exercise/WeightCurve.vue'
import { sessionService } from '@/services/sessionService'
import { fmtDateCn } from '@/utils/date'
import { aggregateStrengthDays, fmtKg, type StrengthDay } from '@/utils/strength'

/**
 * 力量进步卡（运动页）：按动作查看重量变化曲线。
 * 动作 chips 来自逐组记录的最近训练排序；无力量记录时整卡隐藏。
 */
const refs = ref<{ name: string; lastDate: string; sessions: number }[]>([])
const loaded = ref(false)
const selected = ref('')
const curveDays = ref<StrengthDay[]>([])
const loadingCurve = ref(false)

/** 已加载过的动作历史缓存（切回不重复请求） */
const cache = new Map<string, StrengthDay[]>()

onMounted(async () => {
  try {
    refs.value = await sessionService.strengthExercises()
  } catch {
    refs.value = []
  } finally {
    loaded.value = true
  }
  if (refs.value.length) void select(refs.value[0]!.name)
})

watch(selected, (name) => {
  if (name) void select(name)
})

async function select(name: string): Promise<void> {
  selected.value = name
  const hit = cache.get(name)
  if (hit) {
    curveDays.value = hit
    return
  }
  loadingCurve.value = true
  try {
    const rows = await sessionService.strengthHistory(name)
    const days = aggregateStrengthDays(rows).slice(-10)
    cache.set(name, days)
    curveDays.value = days
  } catch {
    curveDays.value = []
  } finally {
    loadingCurve.value = false
  }
}

/** 展示窗口（近 10 次）里最近一次的做组摘要 */
const lastDay = computed(() => curveDays.value[curveDays.value.length - 1] ?? null)

const lastSummary = computed(() => {
  const d = lastDay.value
  if (!d) return ''
  const working = d.sets.map((s) => `${fmtKg(s.weightKg ?? 0)}×${s.reps ?? '?'}`).join(' · ')
  return `${working}（${fmtDateCn(d.date)}）`
})
</script>

<template>
  <section v-if="!loaded || refs.length > 0" class="card">
    <header class="head">
      <h2>重量曲线</h2>
      <span class="sub">力量训练的渐进超负荷</span>
    </header>

    <div v-if="refs.length > 1" class="chips row" role="tablist" aria-label="选择动作">
      <button
        v-for="r in refs.slice(0, 6)"
        :key="r.name"
        class="chip"
        :class="{ on: r.name === selected }"
        role="tab"
        :aria-selected="r.name === selected"
        @click="selected = r.name"
      >
        {{ r.name }}
      </button>
    </div>

    <div v-if="curveDays.length" class="curvewrap">
      <WeightCurve :days="curveDays" />
      <p v-if="lastSummary" class="lastsets num">{{ lastSummary }}</p>
    </div>
    <p v-else class="hint">{{ loadingCurve ? '加载中…' : '该动作还没有重量记录' }}</p>
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
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.curvewrap {
  margin-top: 12px;
}

.lastsets {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.hint {
  margin-top: 12px;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}
</style>
