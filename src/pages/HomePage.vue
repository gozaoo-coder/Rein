<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import PageHeader from '@/components/layout/PageHeader.vue'
import HomeCanvas from '@/components/home/HomeCanvas.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import IntakeOverview from '@/components/nutrition/IntakeOverview.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import DietHistorySheet from '@/components/diet/DietHistorySheet.vue'
import BentoOverview from '@/components/workbench/BentoOverview.vue'
import DaySpine from '@/components/workbench/DaySpine.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { openView as openVoiceView } from '@/system/voiceRuntime'
import { useLedgerStore } from '@/stores/ledger'
import { useFeaturesStore } from '@/stores/features'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import type { ToolAction, ToolContribution } from '@/plugins'
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
const features = useFeaturesStore()
const toast = useToast()

onMounted(() => {
  void nutrition.loadSummary(today)
  void nutrition.loadProfile()
  void nutrition.loadMetrics(10)
  void ledger.loadMonth()
  void ledger.loadBudget()
  // 健康方案被关掉时不必拉方案数据（插件层的收益之一：关掉的模块不产生请求）
  if (features.isEnabled('program')) void program.load()
})

/* ---- 体重趋势异常：连续异常时自动提醒复盘（主页卡片，可忽略）。
       提醒的落点是方案页复盘，方案模块关掉时整卡不出现 ---- */
const weightDismissed = ref(false)
const weightAlert = computed(() =>
  features.isEnabled('program')
    ? weightTrendAlert(nutrition.metrics, nutrition.profile?.goal ?? 'keep', nutrition.profile?.weightKg ?? null)
    : null,
)

/* ---- 移动端常用工具栏：插件层的工具卡贡献（关掉的功能模块不会出现在这里） ---- */
const tools = computed(() => features.tools)

const quickOpen = ref(false)
const workoutOpen = ref(false)
const historyOpen = ref(false)

/**
 * 就地动作表：插件只声明「哪个动作」（ToolAction），组件状态与运行时留在页面实现。
 * 卡片顺序与图标章配色由各插件自己声明（见 src/plugins/builtin）。
 */
const ACTIONS: Record<ToolAction, () => void> = {
  'smart-add': () => {
    quickOpen.value = true
  },
  'add-workout': () => {
    workoutOpen.value = true
  },
  'voice-session': () => {
    // 未配置豆包语音服务时引导去模型页
    void openVoiceView().then((ok) => {
      if (!ok) {
        toast.toast('先在「管理模型」里配置豆包语音服务')
        void router.push('/ai/models')
      }
    })
  },
}

/** 副标可为函数（读实时数据，如记账本月支出），模板统一在渲染时求值 */
function toolSub(t: ToolContribution): string {
  return typeof t.sub === 'function' ? t.sub() : t.sub
}

function runTool(t: ToolContribution): void {
  if (t.action) {
    ACTIONS[t.action]()
    return
  }
  if (t.to) void router.push(t.to)
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

      <!-- 摄入总览：挂卡片壳（.card 自带的 20px 内边距与材质），
           这样它与「今日画布」等卡片落在同一条竖线上；贴着页面底色时整块会散掉。 -->
      <button class="card strip pressable" aria-label="摄入总览详情" @click="router.push('/nutrition')">
        <IntakeOverview />
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

      <!-- 常用工具栏：移动便当风格（图标章 + 标题 + 副标），条目来自插件层 -->
      <div class="tools" role="toolbar" aria-label="常用动作">
        <button
          v-for="t in tools"
          :key="t.id"
          class="tool pressable"
          :aria-label="`${t.title} · ${toolSub(t)}`"
          @click="runTool(t)"
        >
          <i class="tool-ic" :style="t.ic">
            <component :is="t.icon" :size="19" />
          </i>
          <span class="col tool-txt">
            <b>{{ t.title }}</b>
            <em>{{ toolSub(t) }}</em>
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
  /* 页头遮罩按页面横向内边距向外铺满整帧（默认取 --page-pad-x=18px）；
     这里内边距是 34px，不跟着改的话两侧会露出没被遮住的窄条 */
  --ph-bleed: 34px;
}

/* 摄入总览：整条是按钮、壳交给 .card（内边距 20px 与全站卡片一致，别在这里再叠一层），
   这里只管「占满宽度、左对齐」——按钮默认居中文本，得掰回左对齐。
   与下方 HomeCanvas 的间距由全局 `.card + .card`（14px）负责。 */
.strip {
  display: block;
  width: 100%;
  text-align: left;
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

/* 高画质及以上：文字链跟着升成玻璃材质。
   这两个档位都把玻璃铺到卡片 / 快捷磁贴 / 操作面板（base.css 的两组选择器），
   唯独这三颗文字链还是扁平 --surface-2 —— 一屏里就它们「没有材质」，看着像漏了。
   落影取 `--glass-panel-shadow`（= --shadow-card）而**不是** `--glass-shadow`：
   项目里这两种落影是按「在流 / 浮层」分的（见 base.css 那两组注释）——
   在流的内容面用前者、浮在正文之上的浮层才用后者（更重的那份）。
   这些 chip 坐在页面流里、底下没有内容经过，用浮层那份会凭空浮起来；
   当初六个表面共用一条 box-shadow 时用户报的「改极致后卡片阴影异常变深变黑」正是这个错。
   不挂 backdrop-filter 也是同一条理由的延伸：在流面背后只有画布那一条平滑渐变，
   模糊与不模糊肉眼一致，而滤镜会给每颗 chip 开一个背景根、滚动时逐帧重采样。 */
html[data-perf]:not([data-perf='low']) .textlinks button {
  background: var(--glass-panel-fill);
  box-shadow: var(--glass-panel-shadow), var(--glass-insets);
}

/* 常用工具栏（移动便当风格） */
.tools {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 0;
}

.tool {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  min-width: 0;
}

/* 圆章：与快捷磁贴/营养页入口同一套几何（方章是主页一家的方言） */
.tool-ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
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
