<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Timer } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import MonthView from '@/components/todo/MonthView.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import WeekView from '@/components/todo/WeekView.vue'
import { ACTIVITY_LEVEL_LABELS, GOAL_LABELS } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { todayStr } from '@/utils/date'

/** 我：个人资料 · 每日目标（摘要） · 记账摘要 · 待办周/月统计 · 番茄钟设置。 */
const router = useRouter()
const n = useNutritionStore()
const pomo = usePomodoroStore()
const ledger = useLedgerStore()

onMounted(() => {
  void n.loadProfile()
  void n.loadSummary(todayStr())
  void pomo.loadToday()
  void ledger.loadMonth()
  void ledger.loadBudget()
})

/* ---- 待办统计 ---- */
const view = ref<'week' | 'month'>('week')
const selectedDate = ref(todayStr())

const avatarChar = (): string => (n.profile?.nickname ?? 'R').slice(0, 1)

/* ---- 每日目标摘要 ---- */
const targetSummary = computed(() => {
  const t = n.profile?.targets
  if (!t) return []
  return [
    { label: '能量', value: Math.round(t.kcal), unit: '大卡' },
    { label: '蛋白质', value: Math.round(t.protein), unit: 'g' },
    { label: '碳水', value: Math.round(t.carb), unit: 'g' },
    { label: '脂肪', value: Math.round(t.fat), unit: 'g' },
  ]
})
</script>

<template>
  <div class="page">
    <PageHeader title="我" />

    <!-- 资料 -->
    <section class="card profile row">
      <div class="avatar col center">{{ avatarChar() }}</div>
      <div class="flex-1">
        <p class="nick">{{ n.profile?.nickname ?? '…' }}</p>
        <p class="meta num">
          {{ n.profile?.heightCm ?? '--' }}cm · {{ n.profile?.weightKg ?? '--' }}kg · 目标
          {{ n.profile?.targetWeightKg ?? '--' }}kg
        </p>
        <p class="tags">
          <span>{{ n.profile ? ACTIVITY_LEVEL_LABELS[n.profile.activityLevel] : '' }}</span>
          <span>{{ n.profile ? GOAL_LABELS[n.profile.goal] : '' }}</span>
        </p>
      </div>
    </section>

    <!-- 每日目标摘要 → 饮食调整 -->
    <section class="card">
      <header class="row between head">
        <h2>每日目标</h2>
        <button class="link row center" @click="router.push('/nutrition/adjust')">
          去调整<ChevronRight :size="14" />
        </button>
      </header>
      <ul class="tsum">
        <li v-for="t in targetSummary" :key="t.label" class="titem">
          <em>{{ t.label }}</em>
          <b class="num">{{ t.value }}<i>{{ t.unit }}</i></b>
        </li>
      </ul>
      <p class="tmore t-3">支持方案计算、AI 建议与手动微调，在「饮食调整」中完成。</p>
    </section>

    <!-- 记账摘要 → 记账 -->
    <section class="card">
      <header class="row between head">
        <h2>记账</h2>
        <button class="link row center" @click="router.push('/ledger')">
          去记账<ChevronRight :size="14" />
        </button>
      </header>
      <ul class="tsum">
        <li class="titem">
          <em>本月支出</em>
          <b class="num" style="color: var(--led-expense)">¥{{ fmtCents(ledger.monthExpenseCents) }}</b>
        </li>
        <li class="titem">
          <em>本月收入</em>
          <b class="num" style="color: var(--led-income)">¥{{ fmtCents(ledger.monthIncomeCents) }}</b>
        </li>
        <li class="titem">
          <em>结余</em>
          <b class="num">¥{{ fmtCents(ledger.monthIncomeCents - ledger.monthExpenseCents) }}</b>
        </li>
        <li class="titem">
          <em>月度预算</em>
          <b class="num">{{
            ledger.settings && ledger.settings.monthlyBudgetCents > 0
              ? `¥${fmtCents(ledger.settings.monthlyBudgetCents)}`
              : '未设置'
          }}</b>
        </li>
      </ul>
      <p class="tmore t-3">支持快速记一笔、分类占比与月度预算跟踪，在「记账」中完成。</p>
    </section>

    <!-- 待办统计（周视图 / 月视图） -->
    <section class="card">
      <header class="row between head">
        <h2>待办完成度</h2>
        <SegmentedControl
          v-model="view"
          class="seg"
          :options="[
            { value: 'week', label: '周' },
            { value: 'month', label: '月' },
          ]"
        />
      </header>
      <WeekView v-if="view === 'week'" :selected="selectedDate" @select="selectedDate = $event" />
      <MonthView v-else :selected="selectedDate" @select="selectedDate = $event" />
    </section>

    <!-- 番茄钟 -->
    <section class="card">
      <header class="row between head">
        <h2 class="row center"><Timer :size="17" style="margin-right:6px" />番茄钟</h2>
        <span class="num t-3">今日专注 {{ pomo.todayFocusMin }} 分钟</span>
      </header>
      <div class="grid">
        <NumberStepper v-model="pomo.settings.focusMin" label="专注时长" unit="分钟" :step="5" :min="5" :max="120" />
        <NumberStepper v-model="pomo.settings.breakMin" label="短休息" unit="分钟" :step="1" :min="1" :max="30" />
        <NumberStepper v-model="pomo.settings.longBreakMin" label="长休息" unit="分钟" :step="5" :min="5" :max="60" />
        <NumberStepper v-model="pomo.settings.roundsBeforeLongBreak" label="长休间隔" unit="轮" :step="1" :min="2" :max="8" />
      </div>
    </section>

    <!-- 关于 -->
    <section class="card about t-3">
      Rein v0.2.0 · Tauri + Vue + Rust<br>
      架构与编码规范见 docs/ARCHITECTURE.md 与 docs/STANDARDS.md
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

/* 资料 */
.profile {
  gap: 14px;
}

.avatar {
  width: 58px;
  height: 58px;
  flex: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--c-intake), #ff6482);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
}

.nick {
  font-size: var(--fs-title3);
  font-weight: 700;
}

.meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.tags {
  margin-top: 5px;
  display: flex;
  gap: 6px;
}

.tags span {
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

/* 目标摘要 */
.link {
  gap: 2px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

.tsum {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.titem em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.titem b {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.titem i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}

.tmore {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 0.5px solid var(--line);
  font-size: var(--fs-footnote);
}

/* 设置行网格 */
.grid {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr;
}

.grid > * + * {
  border-top: 0.5px solid var(--line);
}

.seg {
  width: 110px;
}

.about {
  font-size: var(--fs-caption);
  line-height: 1.7;
}
</style>
