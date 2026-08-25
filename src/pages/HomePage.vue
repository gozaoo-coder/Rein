<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Apple, Camera, ChevronRight, Dumbbell, Sparkles, Timer, Wallet } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import HomeTodoCard from '@/components/todo/HomeTodoCard.vue'
import ScheduleCard from '@/components/todo/ScheduleCard.vue'
import BentoOverview from '@/components/workbench/BentoOverview.vue'
import DaySpine from '@/components/workbench/DaySpine.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useDietStore } from '@/stores/diet'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { fmtDateCn, todayStr } from '@/utils/date'

/** 主页：能量与营养总览（详情进营养全览）+ 快捷入口；番茄钟/待办/日程收敛在专注页。
 *  桌面端（≥ DESKTOP_MIN）切换为工作台双视图：便当总览 / 一日脊柱（选择持久化）。 */
const router = useRouter()
const today = todayStr()
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

/** 桌面主页视图模式，localStorage 持久化 */
const VIEW_OPTIONS = [
  { value: 'bento', label: '便当总览' },
  { value: 'spine', label: '一日脊柱' },
] as const
type HomeView = (typeof VIEW_OPTIONS)[number]['value']

const view = ref<HomeView>('bento')
try {
  const saved = localStorage.getItem('rein.homeView.v1')
  if (saved === 'spine' || saved === 'bento') view.value = saved
} catch {
  /* 忽略不可用的本地存储 */
}
watch(view, (v) => {
  try {
    localStorage.setItem('rein.homeView.v1', v)
  } catch {
    /* 同上 */
  }
})

const nutrition = useNutritionStore()
const diet = useDietStore()
const ledger = useLedgerStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void diet.load(today)
  void ledger.loadMonth()
  void ledger.loadBudget()
})

const quickOpen = ref(false)
const workoutOpen = ref(false)
</script>

<template>
  <div class="page" :class="{ 'desk-home': isDesktop }">
    <!-- ============ 桌面工作台：便当总览 / 一日脊柱 ============ -->
    <template v-if="isDesktop">
      <PageHeader title="今天" :subtitle="fmtDateCn(today)">
        <template #action>
          <SegmentedControl v-model="view" :options="[...VIEW_OPTIONS]" />
        </template>
      </PageHeader>
      <BentoOverview v-if="view === 'bento'" />
      <DaySpine v-else />
    </template>

    <!-- ============ 移动端（原结构） ============ -->
    <template v-else>
      <PageHeader title="今天" :subtitle="fmtDateCn(today)" />

      <!-- 能量与营养 -->
      <EnergySummary link-to="/nutrition" />

      <!-- 快捷入口 -->
      <ul class="quick">
        <li>
          <QuickTile label="记饮食" icon-bg="var(--accent-soft)" icon-color="var(--accent)" @click="quickOpen = true">
            <Camera :size="20" />
          </QuickTile>
        </li>
        <li>
          <QuickTile label="记运动" icon-bg="rgba(146, 232, 42, 0.18)" icon-color="#5ba800" @click="workoutOpen = true">
            <Dumbbell :size="20" />
          </QuickTile>
        </li>
        <li>
          <QuickTile label="专注" icon-bg="rgba(250, 17, 79, 0.12)" icon-color="var(--c-intake)" @click="router.push('/focus')">
            <Timer :size="20" />
          </QuickTile>
        </li>
        <li>
          <QuickTile label="AI 助手" icon-bg="rgba(88, 86, 214, 0.14)" icon-color="var(--cat-study)" @click="router.push('/ai')">
            <Sparkles :size="20" />
          </QuickTile>
        </li>
        <li class="ledger-row">
          <button class="ledger-btn row center" aria-label="记账" @click="router.push('/ledger')">
            <i class="ledger-ic center"><Wallet :size="20" /></i>
            <span class="grow col">
              <b>记账</b>
              <em class="num t-3">本月支出 ¥{{ fmtCents(ledger.monthExpenseCents) }}</em>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
        </li>
        <li class="ledger-row">
          <button class="ledger-btn row center" aria-label="饮食库" @click="router.push('/nutrition/foods')">
            <i class="ledger-ic lib-ic center"><Apple :size="20" /></i>
            <span class="grow col">
              <b>饮食库</b>
              <em class="t-3">食物营养速查 · 每 100g 全成分</em>
            </span>
            <ChevronRight :size="16" class="t-3" />
          </button>
        </li>
      </ul>

      <!-- 待办：紧急排序前列 3 条，可从「全部待办」页查看完整列表 -->
      <HomeTodoCard :date="today" />

      <!-- 待办时间线：折叠预览（自动锚定今天），点按打开完整虚拟时间线抽屉 -->
      <ScheduleCard :date="today" title="待办时间线" />

      <!-- 弹层（Teleport 到 body，挂在根节点内以保证页面单根） -->
      <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
      <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* 桌面：主人区全宽内容，内部由工作台组件约束 */
.page.desk-home {
  max-width: none;
  padding: 26px 34px 48px;
}

.quick {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin: 14px 0;
}

/* 记账入口：横贯整行的信息瓷砖 */
.ledger-row {
  grid-column: 1 / -1;
}

.ledger-btn {
  width: 100%;
  gap: 11px;
  padding: 12px 14px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
}

.ledger-ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.lib-ic {
  background: rgba(255, 159, 10, 0.14);
  color: var(--c-carb);
}

.ledger-btn b {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.ledger-btn em {
  font-style: normal;
  margin-top: 1px;
  font-size: var(--fs-footnote);
  font-weight: 500;
}

.grow {
  flex: 1;
  min-width: 0;
}
</style>
