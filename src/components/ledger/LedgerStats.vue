<script setup lang="ts">
import { computed } from 'vue'

import { categoryOf, fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { monthKey, todayStr } from '@/utils/date'

/** 月度统计：收支汇总 + 预算进度 + 分类占比环 + 近 6 月趋势柱。 */
const emit = defineEmits<{ 'edit-budget': [] }>()

const store = useLedgerStore()

const spend = computed(() => store.monthExpenseCents)
const income = computed(() => store.monthIncomeCents)
const month = computed(() => store.month)

const budget = computed(() => store.settings?.monthlyBudgetCents ?? 0)
const budgetSet = computed(() => budget.value > 0)
const progress = computed(() => (budgetSet.value ? Math.min(spend.value / budget.value, 1) : 0))
const budgetState = computed<'ok' | 'warn' | 'over'>(() => {
  if (!budgetSet.value) return 'ok'
  if (spend.value > budget.value) return 'over'
  if (spend.value / budget.value >= 0.8) return 'warn'
  return 'ok'
})

const isCurrentMonth = computed(() => month.value === monthKey(todayStr()))

/** 剩余天数（含今天）；非当前月不展示日均 */
const daysLeft = computed(() => {
  if (!isCurrentMonth.value) return 0
  const now = new Date()
  const d = now.getDate()
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  return last - d + 1
})

const dailyRemaining = computed(() => {
  if (!budgetSet.value || !isCurrentMonth.value || daysLeft.value <= 0) return 0
  return Math.max(0, Math.floor((budget.value - spend.value) / daysLeft.value))
})

/* ---- 分类占比环 ---- */

const R = 48
const SW = 13
const C = 2 * Math.PI * R

const segments = computed(() =>
  store.expenseByCategory.map(([key, cents]) => {
    const pct = cents / Math.max(spend.value, 1)
    return { key, amountCents: cents, pct, colorVar: categoryOf(key)?.colorVar ?? 'var(--led-other)' }
  }),
)

/* ---- 近 6 月趋势 ---- */

const maxTrend = computed(() =>
  Math.max(1, ...store.trend.flatMap((t) => [t.expenseCents, t.incomeCents])),
)

function barH(cents: number): string {
  return `${Math.max(4, Math.round((cents / maxTrend.value) * 64))}px`
}
</script>

<template>
  <section class="card stats">
    <div class="nums">
      <div class="num-cell">
        <em>本月支出</em>
        <b class="num" style="color: var(--led-expense)">¥{{ fmtCents(spend) }}</b>
      </div>
      <div class="num-cell">
        <em>本月收入</em>
        <b class="num" style="color: var(--led-income)">¥{{ fmtCents(income) }}</b>
      </div>
      <div class="num-cell">
        <em>结余</em>
        <b class="num">¥{{ fmtCents(income - spend) }}</b>
      </div>
    </div>

    <!-- 月度总预算 -->
    <div class="budget">
      <header class="row between">
        <h3>月度预算</h3>
        <button class="link" @click="emit('edit-budget')">
          {{ budgetSet ? (budgetState === 'over' ? `超支 ¥${fmtCents(spend - budget)}` : '调整') : '设置预算' }}
        </button>
      </header>
      <template v-if="budgetSet">
        <div class="track" :class="budgetState">
          <i :style="{ width: `${Math.min(progress * 100, 100)}%` }" />
        </div>
        <p class="bmeta t-2">
          已用 <b class="num">¥{{ fmtCents(spend) }}</b> / 预算
          <b class="num">¥{{ fmtCents(budget) }}</b>
          <span v-if="isCurrentMonth && spend <= budget" class="daily num">
            · 剩余每天还可 ¥{{ fmtCents(dailyRemaining) }}
          </span>
          <span v-else-if="isCurrentMonth && spend > budget" class="daily num">
            · 本月已超支
          </span>
        </p>
      </template>
      <p v-else class="bempty t-3">设一个月度总预算，进度条会帮你盯着每一分钱。</p>
    </div>

    <!-- 分类占比 -->
    <div class="share">
      <h3>分类占比</h3>
      <div v-if="spend > 0" class="share-body">
        <div class="donut">
          <svg viewBox="0 0 120 120" role="img" aria-label="本月支出分类占比图">
            <circle cx="60" cy="60" :r="R" fill="none" stroke="var(--surface-2)" :stroke-width="SW" />
            <circle
              v-for="(s, i) in segments"
              :key="s.key"
              cx="60"
              cy="60"
              :r="R"
              fill="none"
              :stroke="s.colorVar"
              :stroke-width="SW"
              :stroke-dasharray="`${Math.max(s.pct * C - 2.5, 0.01)} ${C}`"
              :stroke-dashoffset="-25"
              :stroke-linecap="segments.length === 1 ? 'square' : 'butt'"
              :style="{ transform: `rotate(${(i === 0 ? 0 : segments.slice(0, i).reduce((a, x) => a + x.pct, 0)) * 360}deg)`, transformOrigin: '60px 60px' }"
              class="seg-ring"
            />
          </svg>
          <div class="donut-center">
            <em>支出</em>
            <b class="num">¥{{ fmtCents(spend) }}</b>
          </div>
        </div>
        <ul class="legend">
          <li v-for="s in segments" :key="s.key">
            <i class="dot" :style="{ background: s.colorVar }" />
            <span class="lbl">{{ categoryOf(s.key)?.label ?? s.key }}</span>
            <em class="num pct">{{ Math.round(s.pct * 100) }}%</em>
            <b class="num">¥{{ fmtCents(s.amountCents) }}</b>
          </li>
        </ul>
      </div>
      <p v-else class="bempty t-3">本月还没有支出，记一笔就有了。</p>
    </div>

    <!-- 近 6 月趋势 -->
    <div class="trend">
      <h3>近 6 个月</h3>
      <div class="trend-body">
        <div class="trend-col" v-for="t in store.trend" :key="t.key">
          <button
            class="bars"
            :class="{ now: t.key === month }"
            :aria-label="`查看 ${t.key} 统计`"
            @click="void store.loadMonth(t.key)"
          >
            <i class="ex" :style="{ height: barH(t.expenseCents) }" />
            <i class="in" :style="{ height: barH(t.incomeCents) }" />
          </button>
          <span class="m-lbl num" :class="{ now: t.key === month }">{{ t.label }}</span>
        </div>
      </div>
      <p class="bmeta t-3"><i class="dot" style="background: var(--led-expense)" />支出 <i class="dot dot-in" style="background: var(--led-income)" />收入</p>
    </div>
  </section>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.nums {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.num-cell em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.num-cell b {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

h3 {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 8px;
}

.link {
  padding: 4px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--danger);
}

.budget .link {
  color: var(--accent);
}

.track {
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.track i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transition: width var(--dur-sheet) var(--ease-sheet);
}

.track.warn i {
  background: var(--warn);
}

.track.over i {
  background: var(--danger);
}

.bmeta {
  margin-top: 7px;
  font-size: var(--fs-footnote);
  font-weight: 500;
}

.bmeta b {
  font-weight: 700;
  color: var(--text-1);
}

.daily {
  color: var(--text-2);
}

.bempty {
  font-size: var(--fs-footnote);
}

/* 占比环 */
.share-body {
  display: flex;
  align-items: center;
  gap: 14px;
}

.donut {
  position: relative;
  flex: none;
  width: 112px;
  height: 112px;
}

.seg-ring {
  transition: stroke-dasharray var(--dur-sheet) var(--ease-sheet);
}

.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.donut-center em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.donut-center b {
  margin-top: 1px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.legend {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-footnote);
}

.legend .lbl {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-1);
}

.pct {
  color: var(--text-3);
}

.legend b {
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
}

.dot-in {
  margin-left: 10px;
}

/* 趋势柱 */
.trend-body {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  align-items: end;
}

.trend-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 2.5px;
  height: 72px;
}

.bars i {
  width: 7px;
  border-radius: 4px 4px 2px 2px;
  transition: height var(--dur-sheet) var(--ease-sheet);
}

.bars .ex {
  background: var(--led-expense);
  opacity: 0.9;
}

.bars .in {
  background: var(--led-income);
  opacity: 0.9;
}

.bars.now .ex,
.bars.now .in {
  opacity: 1;
  box-shadow: 0 0 0 1px var(--surface);
}

.m-lbl {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.m-lbl.now {
  color: var(--text-1);
  font-weight: 700;
}
</style>
