<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useTodoStore } from '@/stores/todo'
import { WEEKDAY_LABELS, todayStr, weekDates } from '@/utils/date'

/** 周回顾：本周完成率环 + 按天分布 + 一句话洞察（与周视图同数据源）。 */
const store = useTodoStore()
const today = todayStr()
const dates = weekDates(today)

onMounted(() => {
  void store.loadStats(dates[0]!, dates[6]!)
})

const stats = computed(() => {
  let total = 0
  let done = 0
  const perDay = dates.map((d) => {
    const s = store.statsByDate[d] ?? { total: 0, done: 0 }
    total += s.total
    done += s.done
    return s
  })
  return { total, done, perDay, ratio: total ? done / total : 0 }
})

const R = 51
const CIRC = 2 * Math.PI * R

/** 洞察：找完成率最低且有事的日子（排除今天），给一句可执行的提醒 */
const insight = computed(() => {
  let worst = -1
  let worstRatio = 2
  dates.forEach((d, i) => {
    const s = stats.value.perDay[i]!
    if (d >= today || s.total === 0) return
    const r = s.done / s.total
    if (r < worstRatio) {
      worstRatio = r
      worst = i
    }
  })
  if (worst === -1 || worstRatio >= 0.5) {
    return stats.value.total
      ? '本周节奏平稳，保持住。'
      : '本周还没有记录，安排几件小事试试。'
  }
  return `周${WEEKDAY_LABELS[worst]}完成率只有 ${Math.round(worstRatio * 100)}% — 下周这天少排一点，或把难事挪到上午。`
})
</script>

<template>
  <section class="card ws">
    <div class="row between head">
      <h2>本周回顾</h2>
      <span class="num range">{{ dates[0]!.slice(5).replace('-', '/') }} – {{ dates[6]!.slice(5).replace('-', '/') }}</span>
    </div>
    <div class="body">
      <div class="ring">
        <svg width="96" height="96" viewBox="0 0 120 120">
          <circle cx="60" cy="60" :r="R" fill="none" stroke="var(--surface-2)" stroke-width="11" />
          <circle
            cx="60"
            cy="60"
            :r="R"
            fill="none"
            :stroke="stats.ratio >= 0.8 ? 'var(--ok)' : 'var(--accent)'"
            stroke-width="11"
            stroke-linecap="round"
            :stroke-dasharray="CIRC"
            :stroke-dashoffset="CIRC * (1 - stats.ratio)"
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div class="lab">
          <b class="num">{{ Math.round(stats.ratio * 100) }}%</b>
          <span class="num">{{ stats.done }}/{{ stats.total }} 完成</span>
        </div>
      </div>
      <div class="right">
        <p class="cap">按天完成率</p>
        <div class="bars">
          <i
            v-for="(s, i) in stats.perDay"
            :key="i"
            :style="{ height: `${Math.max(6, (s.total ? s.done / s.total : 0) * 100)}%` }"
            :class="{ hi: dates[i] === today }"
          />
        </div>
        <div class="days num">
          <span v-for="(d, i) in dates" :key="d">{{ WEEKDAY_LABELS[i] }}</span>
        </div>
        <p class="insight">{{ insight }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ws {
  padding: 16px 18px;
}

.head h2 {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.range {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.body {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 12px;
}

.ring {
  position: relative;
  flex: none;
}

.lab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}

.lab b {
  font-size: 20px;
  font-weight: 800;
}

.lab span {
  font-size: 10px;
  color: var(--text-3);
}

.right {
  flex: 1;
  min-width: 0;
}

.cap {
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 7px;
  height: 52px;
  margin: 8px 0 4px;
}

.bars i {
  flex: 1;
  border-radius: 4px 4px 2px 2px;
  background: var(--accent-soft);
  transition: height var(--dur-base) var(--ease-standard);
}

.bars i.hi {
  background: var(--accent);
}

.days {
  display: flex;
  gap: 7px;
  font-size: 10px;
  color: var(--text-3);
}

.days span {
  flex: 1;
  text-align: center;
}

.insight {
  margin-top: 10px;
  font-size: var(--fs-footnote);
  line-height: 1.55;
  color: var(--text-1);
  background: var(--surface-2);
  border-radius: var(--radius-s);
  padding: 8px 11px;
}
</style>
