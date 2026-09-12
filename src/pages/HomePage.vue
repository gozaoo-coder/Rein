<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, Dumbbell, Mic, Sparkles, Target, Timer, Wallet } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import HomeCanvas from '@/components/home/HomeCanvas.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import ActivityRings from '@/components/common/ActivityRings.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import DietHistorySheet from '@/components/diet/DietHistorySheet.vue'
import BentoOverview from '@/components/workbench/BentoOverview.vue'
import DaySpine from '@/components/workbench/DaySpine.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { openView as openVoiceView } from '@/system/voiceRuntime'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { fmtDateCn, todayStr } from '@/utils/date'
import { weightTrendAlert } from '@/utils/weightTrend'

/** 主页。桌面端（≥ DESKTOP_MIN）：工作台双视图（便当总览 / 一日脊柱）。
 *  移动端：状态条 + 一日时间线 + 动作堆——主页即今天（V3 一日脊柱方向）。 */
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
const ledger = useLedgerStore()
const program = useProgramStore()
const toast = useToast()

onMounted(() => {
  void nutrition.loadSummary(today)
  void nutrition.loadProfile()
  void nutrition.loadMetrics(10)
  void ledger.loadMonth()
  void ledger.loadBudget()
  void program.load()
})

/* ---- 体重趋势异常：连续异常时自动提醒复盘（主页卡片，可忽略） ---- */
const weightDismissed = ref(false)
const weightAlert = computed(() =>
  weightTrendAlert(nutrition.metrics, nutrition.profile?.goal ?? 'keep', nutrition.profile?.weightKg ?? null),
)

/* ---- 移动端常用工具栏：高频动作（移动便当风格，图标章 + 标题 + 副标） ---- */
const quickOpen = ref(false)
const workoutOpen = ref(false)
const historyOpen = ref(false)

/** 工具栏顺序：使用频率从高到低排布在 2 列网格里 */
const toolCards = computed(() => [
  { id: 1, label: '记饮食' },
  { id: 2, label: '记运动' },
  { id: 3, label: '语音对话' },
  { id: 4, label: 'AI 助手' },
  { id: 5, label: '专注' },
  { id: 6, label: `记账 · 本月支出 ¥${fmtCents(ledger.monthExpenseCents)}` },
  { id: 7, label: `健康方案${program.active ? ` · 执行中 v${program.active.version}` : ''}` },
])

const TOOL_META = computed<Record<number, { icon: Component; style: Record<string, string>; title: string; sub: string }>>(() => ({
  1: { icon: Camera, style: { background: 'var(--accent-soft)', color: 'var(--accent)' }, title: '记饮食', sub: '拍照 / 文字 · AI 帮你记' },
  2: { icon: Dumbbell, style: { background: 'var(--c-exercise-soft)', color: 'var(--c-exercise-deep)' }, title: '记运动', sub: '力量 / 有氧 · MET 估算' },
  3: { icon: Mic, style: { background: 'linear-gradient(135deg, #0a84ff, #1eeaef)', color: '#fff' }, title: '语音对话', sub: '实时转写 · AI 纪要' },
  4: { icon: Sparkles, style: { background: 'rgba(88, 86, 214, 0.14)', color: 'var(--cat-study)' }, title: 'AI 助手', sub: '提问 · 拍照识别' },
  5: { icon: Timer, style: { background: 'var(--intake-soft)', color: 'var(--c-intake)' }, title: '专注', sub: '番茄钟 · 待办 · 日程' },
  6: { icon: Wallet, style: { background: 'var(--surface-2)', color: 'var(--text-2)' }, title: '记账', sub: `本月支出 ¥${fmtCents(ledger.monthExpenseCents)}` },
  7: {
    icon: Target,
    style: { background: 'var(--accent-soft)', color: 'var(--accent)' },
    title: '健康方案',
    sub: program.active ? `执行中 · v${program.active.version}` : '三套方案，排进日程',
  },
}))

function onToolActivate(id: number): void {
  switch (id) {
    case 1:
      quickOpen.value = true
      break
    case 2:
      workoutOpen.value = true
      break
    case 3:
      // 语音对话：未配置豆包语音服务时引导去模型页
      void openVoiceView().then((ok) => {
        if (!ok) {
          toast.toast('先在「管理模型」里配置豆包语音服务')
          void router.push('/ai/models')
        }
      })
      break
    case 4:
      void router.push('/ai')
      break
    case 5:
      void router.push('/focus')
      break
    case 6:
      void router.push('/ledger')
      break
    case 7:
      void router.push('/program')
      break
  }
}
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

    <!-- ============ 移动端：状态条 + 一日时间线 + 动作堆 ============ -->
    <template v-else>
      <PageHeader title="今天" :subtitle="fmtDateCn(today)" />

      <!-- 状态条：无卡片壳，环 + 数字（详情进营养全览） -->
      <button class="strip pressable" aria-label="能量与营养详情" @click="router.push('/nutrition')">
        <ActivityRings :rings="nutrition.rings" :size="62" />
        <span class="col strip-nums">
          <span class="row big">
            <b class="num">{{ nutrition.kcalIntake }}</b>
            <span class="num">/ {{ nutrition.kcalTarget }} 大卡</span>
          </span>
          <span class="row subs num">
            <span class="row"><i class="dot" style="background: var(--c-exercise)" />运动 +{{ nutrition.exerciseKcal }}</span>
            <span class="row"><i class="dot" style="background: var(--c-balance)" />剩余 {{ nutrition.kcalRemaining }}</span>
          </span>
        </span>
        <span class="strip-more t-3">详情 ›</span>
      </button>

      <HomeCanvas :date="today" />

      <!-- 体重趋势异常提醒 -->
      <section v-if="weightAlert && !weightDismissed" class="card warn-card">
        <p class="t-2 warn-txt">{{ weightAlert.reason }}</p>
        <div class="row" style="gap: 10px; margin-top: 12px">
          <button class="warn-go pressable" @click="router.push('/program')">去复盘</button>
          <button class="warn-later pressable" @click="weightDismissed = true">知道了</button>
        </div>
      </section>

      <!-- 查阅类入口：低频，文字链 -->
      <div class="textlinks">
        <button class="pressable" @click="router.push('/nutrition/foods')">饮食库</button>
        <button class="pressable" @click="router.push('/nutrition/recipes')">食谱库</button>
        <button class="pressable" @click="historyOpen = true">饮食历史</button>
      </div>

      <!-- 常用工具栏：移动便当风格（图标章 + 标题 + 副标） -->
      <div class="tools" role="toolbar" aria-label="常用动作">
        <button
          v-for="c in toolCards"
          :key="c.id"
          class="tool pressable"
          :aria-label="c.label"
          @click="onToolActivate(c.id)"
        >
          <i class="tool-ic" :style="TOOL_META[c.id]?.style">
            <component :is="TOOL_META[c.id]?.icon" :size="17" />
          </i>
          <span class="col tool-txt">
            <b>{{ TOOL_META[c.id]?.title }}</b>
            <em>{{ TOOL_META[c.id]?.sub }}</em>
          </span>
        </button>
      </div>

      <!-- 弹层（Teleport 到 body，挂在根节点内以保证页面单根） -->
      <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
      <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
      <DietHistorySheet :open="historyOpen" @close="historyOpen = false" />
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

/* 状态条：无壳贴页面，整条可点进营养全览 */
.strip {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 4px 2px 14px;
  text-align: left;
}

.strip-nums {
  gap: 0;
  min-width: 0;
}

.strip-nums .big {
  align-items: baseline;
  gap: 6px;
}

.strip-nums .big b {
  font-size: var(--fs-display-m);
  font-weight: 200;
  letter-spacing: -1.2px;
  line-height: 1;
  color: var(--c-intake);
}

.strip-nums .big span {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.subs {
  margin-top: 7px;
  gap: 12px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.subs .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 5px;
  flex: none;
}

.strip-more {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-caption);
}

/* 体重趋势提醒 */
.warn-card {
  background: var(--danger-soft);
}

.warn-txt {
  font-size: var(--fs-subhead);
  line-height: 1.5;
}

.warn-go {
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--danger);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.warn-later {
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

/* 查阅文字链 */
.textlinks {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin: 14px 0;
}

.textlinks button {
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

/* 常用工具栏（移动便当风格） */
.tools {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 4px;
}

.tool {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  min-width: 0;
}

.tool-ic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 12px;
  display: grid;
  place-items: center;
}

.tool-txt {
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.tool-txt b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.tool-txt em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
