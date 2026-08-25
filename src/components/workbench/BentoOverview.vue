<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, Dumbbell, Sparkles, Timer, Wallet } from 'lucide-vue-next'

import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import HomeTodoCard from '@/components/todo/HomeTodoCard.vue'
import PomodoroCard from '@/components/pomodoro/PomodoroCard.vue'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useExerciseStore } from '@/stores/exercise'
import { useLedgerStore } from '@/stores/ledger'
import { todayStr } from '@/utils/date'

/** 桌面主页 · 便当总览：能量三环磁贴 + 待办 + 番茄/AI + 快捷入口 + 记账/运动概览。 */
const today = todayStr()
const router = useRouter()

const exercise = useExerciseStore()
const ledger = useLedgerStore()

const quickOpen = ref(false)
const workoutOpen = ref(false)

onMounted(() => {
  void exercise.loadWeek(today)
})

const topCats = computed(() => ledger.expenseByCategory.slice(0, 2))
const todayWorkoutCount = computed(() => exercise.weekWorkouts.filter((w) => w.date === today).length)
const budgetPct = computed(() => {
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  return budget <= 0 ? 0 : Math.min(100, Math.round((ledger.monthExpenseCents / budget) * 100))
})
</script>

<template>
  <div class="bento">
    <!-- 能量与营养 -->
    <section class="t-hero"><EnergySummary link-to="/nutrition" /></section>

    <!-- 待办 -->
    <section class="t-todo"><HomeTodoCard :date="today" /></section>

    <!-- 右侧堆叠：番茄钟 + AI 入口 -->
    <section class="t-side">
      <PomodoroCard />
      <section class="card t-ai">
        <div class="row" style="gap: 10px; color: var(--cat-study)">
          <i class="qic" style="background: rgba(88, 86, 214, 0.14); color: var(--cat-study)"><Sparkles :size="19" /></i>
          <div class="col">
            <b style="font-size: var(--fs-headline)">AI 助手</b>
            <span class="t-3" style="font-size: var(--fs-caption); font-weight: 600">提问 · 拍照记饮食 · 生成周计划</span>
          </div>
        </div>
        <button class="ask pressable" @click="router.push({ name: 'ai' })">
          问点什么…<span class="kbd" style="margin-left: auto; flex: none">A</span>
        </button>
      </section>
    </section>

    <!-- 快捷入口 -->
    <section class="t-qa">
      <QuickTile label="记饮食" icon-bg="var(--accent-soft)" icon-color="var(--accent)" @click="quickOpen = true">
        <Camera :size="20" />
      </QuickTile>
      <QuickTile label="记运动" icon-bg="var(--c-exercise-soft)" icon-color="#5ba800" @click="workoutOpen = true">
        <Dumbbell :size="20" />
      </QuickTile>
      <QuickTile label="专注" icon-bg="rgba(250, 17, 79, 0.12)" icon-color="var(--c-intake)" @click="router.push({ name: 'focus' })">
        <Timer :size="20" />
      </QuickTile>
      <QuickTile label="AI 助手" icon-bg="rgba(88, 86, 214, 0.14)" icon-color="var(--cat-study)" @click="router.push({ name: 'ai' })">
        <Sparkles :size="20" />
      </QuickTile>
    </section>

    <!-- 记账概览 -->
    <section class="t-led">
      <div class="pressable inner" @click="router.push({ name: 'ledger' })">
        <i class="qic"><Wallet :size="21" /></i>
        <div class="col" style="gap: 2px; min-width: 0">
          <b>记账</b>
          <span class="num t-2">本月支出 ¥{{ fmtCents(ledger.monthExpenseCents) }} · 预算已用 {{ budgetPct }}%</span>
          <div class="mtrack" style="margin-top: 8px; max-width: 300px">
            <i :style="{ width: budgetPct + '%', background: 'var(--accent)' }" />
          </div>
        </div>
        <div class="col" style="margin-left: auto; align-items: flex-end; gap: 4px; flex: none">
          <span
            v-for="c in topCats"
            :key="c[0]"
            class="num"
            style="font-size: var(--fs-caption); color: var(--text-3)"
          >
            <i class="cat-dot" :style="{ background: 'var(' + (categoryOf(c[0])?.colorVar ?? '--cat-general') + ')' }" />
            {{ categoryOf(c[0])?.label ?? c[0] }} ¥{{ fmtCents(c[1]) }}
          </span>
        </div>
      </div>
    </section>

    <!-- 运动概览 -->
    <section class="t-wk">
      <div class="pressable inner" @click="router.push({ name: 'sports' })">
        <i class="qic" style="background: var(--c-exercise-soft); color: #5ba800"><Dumbbell :size="21" /></i>
        <div class="col" style="gap: 2px; min-width: 0">
          <b class="nowrap">本周运动</b>
          <span class="t-2 nowrap">已练 {{ todayWorkoutCount }} 次 · {{ exercise.weekMinutes }} 分钟</span>
        </div>
        <button class="go pressable" style="margin-left: auto; flex: none" @click.stop="workoutOpen = true">记运动</button>
      </div>
    </section>

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
    <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
  </div>
</template>

<style scoped>
.bento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-areas:
    'hero hero hero hero todo todo todo todo side side side side'
    'hero hero hero hero todo todo todo todo side side side side'
    'qa qa qa qa led led led led wk wk wk wk';
  gap: 14px;
  align-items: stretch;
}

.t-hero { grid-area: hero; }
.t-todo { grid-area: todo; min-width: 0; }
.t-side { grid-area: side; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.t-qa { grid-area: qa; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.t-led {
  grid-area: led;
  display: flex;
  align-items: center;
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
}
.t-wk {
  grid-area: wk;
  display: flex;
  align-items: center;
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  padding: 0;
}

.inner {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 18px;
}

.qic {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.t-ai {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: linear-gradient(135deg, var(--accent-soft), transparent 60%), var(--surface);
}

.ask {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-caption);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
}

.cat-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
}

.mtrack {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.mtrack i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
}

.nowrap {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.go {
  padding: 8px 15px;
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-subhead);
  font-weight: 650;
}
</style>
