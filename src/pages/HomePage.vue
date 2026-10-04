<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import PageHeader from '@/components/layout/PageHeader.vue'
import HomeCanvas from '@/components/home/HomeCanvas.vue'
import HomeFooter from '@/components/home/HomeFooter.vue'
import IntakeOverview from '@/components/nutrition/IntakeOverview.vue'
import ProgramStatusCard from '@/components/program/ProgramStatusCard.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import BentoOverview from '@/components/workbench/BentoOverview.vue'
import DaySpine from '@/components/workbench/DaySpine.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { DESKTOP_MIN } from '@/config/domain'
import { useFeaturesStore } from '@/stores/features'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { fmtDateCn, todayStr } from '@/utils/date'
import { weightTrendAlert } from '@/utils/weightTrend'

/** 主页。桌面端（≥ DESKTOP_MIN）：工作台双视图（便当总览 / 一日脊柱）。
 *  移动端：状态条 + 一日时间线 + 页脚动作区——主页即今天。 */
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
const program = useProgramStore()
const features = useFeaturesStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void nutrition.loadProfile()
  void nutrition.loadMetrics(10)
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

/* ---- 移动端页脚：课程条 / 吃 / 练 / 专注·钱 / 工具，见 HomeFooter.vue。
       成员仍来自插件层，就地动作与三张抽屉都在那里面 —— 这页只负责挂。 ---- */
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

      <!-- 方案状态卡：执行期的常驻落点（今天练什么/走到哪/该复盘了），关掉模块整卡不出现 -->
      <ProgramStatusCard v-if="features.isEnabled('program')" />

      <HomeCanvas :date="today" />

      <!-- 体重趋势异常提醒 -->
      <section v-if="weightAlert && !weightDismissed" class="card warn-card">
        <p class="t-2 warn-txt">{{ weightAlert.reason }}</p>
        <div class="row" style="gap: 10px; margin-top: 12px">
          <button class="warn-go pressable" @click="router.push('/program')">去复盘</button>
          <button class="warn-later pressable" @click="weightDismissed = true">知道了</button>
        </div>
      </section>

      <!-- 页脚动作区：课程条 / 吃 / 练 / 专注·钱 / 工具（HomeFooter 持有抽屉与就地动作） -->
      <HomeFooter :date="today" />
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

/* 白字压 --danger(#ff3b30) 实测只有 3.55:1 —— 14px 粗体够不着 4.5:1 的门槛。
   --danger-strong 是「危险色的文字/实底档」，压白字 5.87:1，肉眼仍是同一支红。 */
.warn-go {
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--danger-strong);
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

/* 页脚动作区（课程条 / 吃 / 练 / 专注·钱 / 工具）的样式在 HomeFooter.vue 里 */
</style>
