<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { sessionService } from '@/services/sessionService'
import { fmtDateCn } from '@/utils/date'
import { fmtKg } from '@/utils/strength'
import { buildExerciseHistory, type ExerciseHistory } from '@/utils/strengthStats'

/**
 * 动作历史 / PR 面板：近 10 次训练逐场聚合 + 三项个人纪录
 * （最大重量、最佳估算 1RM、最佳单次容量）。
 * 自己拉数据（strength_history），父组件只给动作库 id。
 */
const props = defineProps<{ exerciseId: string | null }>()

const history = ref<ExerciseHistory | null>(null)
const loading = ref(false)
const showAll = ref(false)

const RECENT = 10

const rows = computed(() => {
  const all = history.value?.sessions ?? []
  const list = [...all].reverse() // 新的在上
  return showAll.value ? list : list.slice(0, RECENT)
})

const hasMore = computed(() => (history.value?.sessions.length ?? 0) > RECENT)

watch(
  () => props.exerciseId,
  async (id) => {
    history.value = null
    if (!id) return
    loading.value = true
    try {
      const sets = await sessionService.strengthHistory(id)
      history.value = buildExerciseHistory(sets)
    } catch {
      history.value = null
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="loading" class="state t-3">加载中…</div>
  <div v-else-if="!history || !history.sessions.length" class="state t-3">还没有这个动作的做组记录</div>
  <template v-else>
    <div class="prs row">
      <div class="pr">
        <span class="pv num">{{ history.prs.weight ? fmtKg(history.prs.weight.value) : '—' }}</span>
        <span class="pk">最大重量 kg</span>
        <span class="pd t-3">{{ history.prs.weight ? fmtDateCn(history.prs.weight.date) : '' }}</span>
      </div>
      <div class="pr">
        <span class="pv num">{{ history.prs.e1rm ? fmtKg(history.prs.e1rm.value) : '—' }}</span>
        <span class="pk">最佳估算 1RM</span>
        <span class="pd t-3">{{ history.prs.e1rm ? fmtDateCn(history.prs.e1rm.date) : '' }}</span>
      </div>
      <div class="pr">
        <span class="pv num">{{ history.prs.volume ? history.prs.volume.value : '—' }}</span>
        <span class="pk">最佳单次容量 kg</span>
        <span class="pd t-3">{{ history.prs.volume ? fmtDateCn(history.prs.volume.date) : '' }}</span>
      </div>
    </div>

    <ul class="hist">
      <li v-for="s in rows" :key="s.workoutId" class="hrow row">
        <span class="hdate t-2">{{ fmtDateCn(s.date) }}</span>
        <span class="hmain num">{{ s.sets }} 组 · 最重 {{ fmtKg(s.topWeightKg) }}kg<span v-if="s.topReps">×{{ s.topReps }}</span></span>
        <span class="hvol num t-3">{{ s.volumeKg }} kg</span>
      </li>
    </ul>

    <button v-if="hasMore && !showAll" class="more" @click="showAll = true">
      显示全部 {{ history.sessions.length }} 次
    </button>
  </template>
</template>

<style scoped>
.state {
  font-size: var(--fs-footnote);
}

.prs {
  gap: 8px;
  align-items: stretch;
}

.pr {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 11px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.pv {
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
}

.pk {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.pd {
  font-size: var(--fs-micro);
}

.hist {
  margin-top: 10px;
}

.hrow {
  gap: 8px;
  padding: 9px 2px;
  font-size: var(--fs-footnote);
}

.hist li + li {
  border-top: 0.5px solid var(--line);
}

.hdate {
  flex: none;
  width: 76px;
}

.hmain {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
}

.hvol {
  flex: none;
}

.more {
  margin-top: 8px;
  padding: 8px 0;
  width: 100%;
  font-size: var(--fs-caption);
  color: var(--c-exercise-deep);
}
</style>
