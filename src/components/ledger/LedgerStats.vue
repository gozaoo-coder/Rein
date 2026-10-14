<script setup lang="ts">
import { computed } from 'vue'

import StatusChip from '@/components/common/StatusChip.vue'
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

/** 环心读数：本月占比最高的分类。总额只在顶部「本月支出」出现一次，环心再说一遍是重印。 */
const topCategory = computed(() => {
  const best = segments.value.reduce<{ key: string; pct: number } | null>(
    (acc, s) => (!acc || s.pct > acc.pct ? { key: s.key, pct: s.pct } : acc),
    null,
  )
  return best ? { label: categoryOf(best.key)?.label ?? best.key, pct: Math.round(best.pct * 100) } : null
})

/* ---- 近 6 月趋势 ---- */

const maxTrend = computed(() =>
  Math.max(1, ...store.trend.flatMap((t) => [t.expenseCents, t.incomeCents])),
)

function barH(cents: number): string {
  return `${Math.max(4, Math.round((cents / maxTrend.value) * 64))}px`
}

/** 六个月全是 0（新账本 / 长期空账）：不画柱 —— 一排 4px 的小色块浮在 72px 的空箱里，
 *  读起来像渲染故障，而且它连着坐标标签与图例一起吃掉约 130px。
 *  与「分类占比」同一条口径：没数据就把话说清楚，不摆空图表。 */
const trendEmpty = computed(() =>
  store.trend.every((t) => t.expenseCents === 0 && t.incomeCents === 0),
)
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

    <!-- 月度总预算：超支是状态、按钮是动作，两者分开承载（按钮不再兼「状态 + 动作」两职） -->
    <div class="budget">
      <header class="row between">
        <h3>月度预算</h3>
        <StatusChip v-if="budgetSet && budgetState === 'over'" tone="danger" size="sm">已超支</StatusChip>
        <button class="link" @click="emit('edit-budget')">
          {{ budgetSet ? '调整' : '设置预算' }}
        </button>
      </header>
      <template v-if="budgetSet">
        <div class="track" :class="budgetState">
          <i :style="{ '--p': `${Math.min(progress * 100, 100)}%` }" />
        </div>
        <p class="bmeta t-2">
          已用 <b class="num">¥{{ fmtCents(spend) }}</b> / 预算
          <b class="num">¥{{ fmtCents(budget) }}</b>
          <span v-if="isCurrentMonth && spend <= budget" class="daily num">
            · 剩余每天还可 ¥{{ fmtCents(dailyRemaining) }}
          </span>
        </p>
      </template>
      <p v-else class="bempty t-2">还没设月度预算。</p>
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
          <!-- 环心只报占比最高的分类：总额的出处是顶部「本月支出」一格 -->
          <div class="donut-center">
            <template v-if="topCategory">
              <em>{{ topCategory.label }}</em>
              <b class="num">{{ topCategory.pct }}%</b>
            </template>
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
      <p v-else class="bempty t-2">本月还没有支出。</p>
    </div>

    <!-- 近 6 月趋势 -->
    <div class="trend">
      <h3>近 6 个月</h3>
      <div v-if="!trendEmpty" class="trend-body">
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
      <p v-if="!trendEmpty" class="bmeta t-3"><i class="dot" style="background: var(--led-expense)" />支出 <i class="dot dot-in" style="background: var(--led-income)" />收入</p>
      <p v-else class="bempty t-2">近半年还没有记录。</p>
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
  /* 「本月支出」是三个格子的字段名，不吃 11px */
  font-size: var(--fs-caption);
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
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
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
  transition: stroke-dasharray var(--dur-base) var(--ease-standard);
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
  /* 环心小帽（占比最高的分类名）是字段名，不吃 11px */
  font-size: var(--fs-caption);
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

/* 桌面壳：按钮盒原本贴着柱体走（两根 7px 柱 + 2.5 间隙 = 实测 16.5px 宽），
   而一列有 52px —— 六根柱子一屏，只有中间一条 16.5px 的点按缝，指针精度下点不准。
   整列交给它：宽度吃满、柱体用 justify-content 居中，**视觉一格不动**
   （实测盒中心 = 列中心），可点面从 16.5×72 变成 52×72。
   只限桌面壳：22 是指针精度的下限，手机上是触屏那套（命中区、排布都另算），不动。 */
.desk-main .bars {
  width: 100%;
  justify-content: center;
}

/* 趋势柱：切月频率极低，柱高直接落位不参与过渡（height 动画触发 layout） */
.bars i {
  width: 7px;
  border-radius: 4px 4px 2px 2px;
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
  /* 六个月柱下的月份刻度 */
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.m-lbl.now {
  color: var(--text-1);
  font-weight: 700;
}
</style>
