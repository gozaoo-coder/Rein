<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, Dumbbell, Sparkles, Timer, Utensils, Wallet } from 'lucide-vue-next'

import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import DietHistorySheet from '@/components/diet/DietHistorySheet.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import HomeTodoCard from '@/components/todo/HomeTodoCard.vue'
import PomodoroCard from '@/components/pomodoro/PomodoroCard.vue'
import { MEAL_LABELS, MEAL_META, MEAL_ORDER, mealKcal } from '@/config/domain'
import { categoryOf, fmtCents } from '@/config/ledger'
import { useDietStore } from '@/stores/diet'
import { useExerciseStore } from '@/stores/exercise'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { todayStr } from '@/utils/date'

/** 桌面主页 · 便当总览：能量三环磁贴 + 待办 + 番茄/AI + 快捷入口 + 饮食/记账/运动概览。 */
const today = todayStr()
const router = useRouter()

const exercise = useExerciseStore()
const ledger = useLedgerStore()
const diet = useDietStore()
const nutrition = useNutritionStore()
const features = useFeaturesStore()

/** 记运动入口与「本周运动」概览都属运动插件：模块关掉时两块一起消失，布局改由 CSS 收口 */
const sportsOn = computed(() => features.isEnabled('sports'))

const quickOpen = ref(false)
const workoutOpen = ref(false)
const historyOpen = ref(false)

onMounted(() => {
  void exercise.loadWeek(today)
  // 饮食/营养不再依赖 HomePage 挂载链，桌面端直接进入总览时也需自备数据
  void diet.load(today)
  void nutrition.loadSummary(today)
})

const topCats = computed(() => ledger.expenseByCategory.slice(0, 2))
const todayWorkoutCount = computed(() => exercise.weekWorkouts.filter((w) => w.date === today).length)
const budgetPct = computed(() => {
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  return budget <= 0 ? 0 : Math.min(100, Math.round((ledger.monthExpenseCents / budget) * 100))
})

/** 今日饮食宽条：总摄入 / 目标 + 四餐打卡点 */
const todayIntake = computed(() => diet.meals.reduce((s, m) => s + (mealKcal(m) ?? 0), 0))
const kcalTarget = computed(() => Math.round(nutrition.summary?.targets.kcal ?? 0))
const mealChips = computed(() =>
  MEAL_ORDER.map((type) => {
    const items = diet.meals.filter((m) => m.mealType === type)
    return {
      type,
      label: MEAL_LABELS[type],
      on: items.length > 0,
      kcal: items.reduce((s, m) => s + (mealKcal(m) ?? 0), 0),
    }
  }),
)
</script>

<template>
  <div class="bento" :class="{ 'no-sports': !sportsOn }">
    <!-- 能量与营养 -->
    <section class="t-hero"><EnergySummary link-to="/nutrition" /></section>

    <!-- 待办 -->
    <section class="t-todo"><HomeTodoCard :date="today" /></section>

    <!-- 右侧堆叠：番茄钟 + AI 入口 -->
    <section class="t-side">
      <PomodoroCard />
      <section class="card t-ai">
        <div class="row" style="gap: 10px; color: var(--cat-study)">
          <i class="qic" style="background: color-mix(in srgb, var(--cat-study) 14%, transparent); color: var(--cat-study)"><Sparkles :size="19" /></i>
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
      <QuickTile label="记饮食" icon-bg="color-mix(in srgb, var(--c-intake) 12%, transparent)" icon-color="var(--c-intake)" @click="quickOpen = true">
        <Camera :size="20" />
      </QuickTile>
      <QuickTile v-if="sportsOn" label="记运动" icon-bg="var(--c-exercise-soft)" icon-color="var(--c-exercise-deep)" @click="workoutOpen = true">
        <Dumbbell :size="20" />
      </QuickTile>
      <QuickTile label="专注" icon-bg="color-mix(in srgb, var(--cat-work) 12%, transparent)" icon-color="var(--cat-work)" @click="router.push({ name: 'focus' })">
        <Timer :size="20" />
      </QuickTile>
      <QuickTile label="AI 助手" icon-bg="color-mix(in srgb, var(--cat-study) 14%, transparent)" icon-color="var(--cat-study)" @click="router.push({ name: 'ai' })">
        <Sparkles :size="20" />
      </QuickTile>
    </section>

    <!-- 记账概览 -->
    <section class="t-led">
      <div
        class="pressable inner"
        role="button"
        tabindex="0"
        aria-label="打开记账"
        @click="router.push({ name: 'ledger' })"
        @keydown.enter.prevent="router.push({ name: 'ledger' })"
        @keydown.space.prevent="router.push({ name: 'ledger' })"
      >
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
    <section v-if="sportsOn" class="t-wk">
      <div
        class="pressable inner"
        role="button"
        tabindex="0"
        aria-label="打开运动"
        @click="router.push({ name: 'sports' })"
        @keydown.enter.prevent="router.push({ name: 'sports' })"
        @keydown.space.prevent="router.push({ name: 'sports' })"
      >
        <i class="qic" style="background: var(--c-exercise-soft); color: var(--c-exercise-deep)"><Dumbbell :size="21" /></i>
        <div class="col" style="gap: 2px; min-width: 0">
          <b class="nowrap">本周运动</b>
          <span class="t-2 nowrap">已练 {{ todayWorkoutCount }} 次 · {{ exercise.weekMinutes }} 分钟</span>
        </div>
        <button class="go pressable" style="margin-left: auto; flex: none" @click.stop="workoutOpen = true">记运动</button>
      </div>
    </section>

    <!-- 今日饮食：点条开历史，右侧快捷记一笔 -->
    <section class="t-diet">
      <div
        class="pressable inner"
        role="button"
        tabindex="0"
        aria-label="查看饮食历史"
        @click="historyOpen = true"
        @keydown.enter.prevent="historyOpen = true"
        @keydown.space.prevent="historyOpen = true"
      >
        <i class="qic"><Utensils :size="21" /></i>
        <div class="col" style="gap: 6px; min-width: 0">
          <b>今日饮食</b>
          <span class="num t-2">
            已记 {{ diet.meals.length }} 笔 · {{ todayIntake }}{{ kcalTarget ? ` / ${kcalTarget}` : '' }} kcal
          </span>
          <div class="chips">
            <span v-for="c in mealChips" :key="c.type" class="chip" :class="{ on: c.on }">
              <i class="cdot" :style="{ background: c.on ? MEAL_META[c.type].colorVar : 'var(--line-strong)' }" />
              {{ c.label }}<template v-if="c.on"> {{ c.kcal }}</template>
            </span>
          </div>
        </div>
        <div class="acts">
          <button class="ghost pressable" @click.stop="historyOpen = true">历史</button>
          <button class="go pressable" @click.stop="quickOpen = true">记一笔</button>
        </div>
      </div>
    </section>

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
    <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
    <DietHistorySheet :open="historyOpen" @close="historyOpen = false" />
  </div>
</template>

<style scoped>
.bento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-areas:
    'hero hero hero hero todo todo todo todo side side side side'
    'hero hero hero hero todo todo todo todo side side side side'
    'qa qa qa qa led led led led wk wk wk wk'
    'diet diet diet diet diet diet diet diet diet diet diet diet';
  gap: 14px;
  align-items: stretch;
}

.t-hero { grid-area: hero; }
.t-todo { grid-area: todo; min-width: 0; }
.t-side { grid-area: side; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.t-qa { grid-area: qa; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

/* 运动模块关闭：抽掉 wk 区、空出的列并入记账卡，快捷入口 4 列收成 3 列（不留空洞）。
   行数必须与原布局一致（四行，含末行 diet）——少写一行会让未声明区域变成隐式轨道。 */
.bento.no-sports {
  grid-template-areas:
    'hero hero hero hero todo todo todo todo side side side side'
    'hero hero hero hero todo todo todo todo side side side side'
    'qa qa qa qa led led led led led led led led'
    'diet diet diet diet diet diet diet diet diet diet diet diet';
}

.bento.no-sports .t-qa {
  grid-template-columns: repeat(3, 1fr);
}
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
.t-diet {
  grid-area: diet;
  display: flex;
  align-items: center;
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
}

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
}

.chip.on {
  color: var(--text-1);
}

.cdot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}

.acts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: none;
}

.ghost {
  padding: 8px 15px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-subhead);
  font-weight: 650;
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
