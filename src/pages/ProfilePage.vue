<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Settings2, Target } from 'lucide-vue-next'

import ConstraintsSheet from '@/components/profile/ConstraintsSheet.vue'
import MonthView from '@/components/todo/MonthView.vue'
import PillChip from '@/components/common/PillChip.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import WeekView from '@/components/todo/WeekView.vue'
import { EQUIPMENT_LABELS, EXPERIENCE_LABELS, GOAL_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { bmiBand, bmiOf } from '@/utils/health'
import { todayStr } from '@/utils/date'

/**
 * 我 · 生活面板：与主页卡片同一套版式语言——全宽 .card 竖排（radius-xl / 20px 内边距）、
 * 卡头「大黑标题 + 右侧去处胶囊」、数字 800 字重等宽、卡内分区靠发丝线。
 * 身份缩成一行；番茄钟不在面板里调（完整配置在「设置 › 番茄钟」）；
 * 个人约束是健康方案的生成依据，编辑抽屉与跳转保持既有链路。
 */
const router = useRouter()
const n = useNutritionStore()
const ledger = useLedgerStore()
const program = useProgramStore()
const features = useFeaturesStore()

onMounted(() => {
  void n.loadProfile()
  void n.loadSummary(todayStr())
  void ledger.loadMonth()
  void ledger.loadBudget()
  // 「有方案 / 没方案」决定约束卡上那条链路的文案，只有开着模块时才拉
  if (features.isEnabled('program')) void program.load()
})

const avatarChar = computed(() => (n.profile?.nickname ?? 'R').slice(0, 1))
const heightText = computed(() => n.profile?.heightCm ?? '--')
const weightText = computed(() => n.profile?.weightKg ?? '--')
const goalText = computed(() => (n.profile ? GOAL_LABELS[n.profile.goal] : ''))

/* BMI 分档：档案行上唯一带色的读数，异常档不用点进抽屉就能看见 */
const bmi = computed(() => bmiOf(n.profile?.weightKg ?? 0, n.profile?.heightCm ?? 0))
const bmiBandInfo = computed(() => (bmi.value == null ? null : bmiBand(bmi.value)))
const bmiText = computed(() => (bmi.value == null ? '' : bmi.value.toFixed(1)))

/* 身体读数串：目标体重没设时不渲染悬空的「→ --kg」，有几段拼几段 */
const metaLine = computed(() => {
  const parts = [`${heightText.value}cm`, `${weightText.value}kg`]
  if (n.profile?.targetWeightKg) parts.push(`→ ${n.profile.targetWeightKg}kg`)
  return parts.join(' · ')
})

/* ---- 每日目标 ---- */
const targetKcal = computed(() => (n.profile?.targets ? Math.round(n.profile.targets.kcal) : null))
const targetSub = computed(() => {
  const t = n.profile?.targets
  if (!t) return '未设置 · 点此配置'
  return `蛋白 ${Math.round(t.protein)}g · 碳水 ${Math.round(t.carb)}g · 脂肪 ${Math.round(t.fat)}g`
})

/* ---- 记账 ---- */
const balanceCents = computed(() => ledger.monthIncomeCents - ledger.monthExpenseCents)
const balancePos = computed(() => balanceCents.value >= 0)
/** 结余展示取绝对值，符号由 balancePos 单独渲染（与 ledgerSub 同为分位口径） */
const balanceText = computed(() => fmtCents(Math.abs(balanceCents.value), { group: true }))
const ledgerSub = computed(() => {
  const base = `支 ${fmtCents(ledger.monthExpenseCents)} / 收 ${fmtCents(ledger.monthIncomeCents)}`
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  if (budget <= 0) return base
  const used = Math.min(999, Math.round((ledger.monthExpenseCents / budget) * 100))
  return `${base} · 预算已用 ${used}%`
})

/* ---- 待办完成度（周 / 月） ---- */
const view = ref<'week' | 'month'>('week')
const selectedDate = ref(todayStr())

/* ---- 个人约束（健康方案生成依据） ---- */
/* 约束摘要卡 + 编辑抽屉（components/profile/ConstraintsSheet：分组行卡版式，
 * 身体数据与训练约束两组，草稿就地改、保存落库）。身体数据此前只有 AI 工具
 * 能写，抽屉是应用内唯一的手动入口。 */
const editOpen = ref(false)

const constraintSummary = computed(() => {
  const p = n.profile
  return [
    { label: '训练', value: p?.trainingDaysPerWeek != null ? `${p.trainingDaysPerWeek} 天 · ${p.preferredTimeSlots?.length ? p.preferredTimeSlots.map((s) => TIME_SLOT_LABELS[s] ?? s).join('·') : '自由安排'}` : '未设置' },
    { label: '器械', value: p?.equipment ? EQUIPMENT_LABELS[p.equipment] : '未设置' },
    { label: '经验', value: p?.experience ? EXPERIENCE_LABELS[p.experience] : '未设置' },
    { label: '忌口', value: p?.dietRestrictions?.length ? p.dietRestrictions.join('、') : '无' },
  ]
})

function openEdit(): void {
  editOpen.value = true
}
</script>

<template>
  <div class="page">
    <PageHeader title="我" />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 身份条：点头像区进约束/身体资料编辑；目标与 BMI 分档上卡面，省一趟抽屉 -->
    <button class="card id row" @click="openEdit">
      <div class="avatar col center">{{ avatarChar }}</div>
      <div class="idcol">
        <p class="nick">
          {{ n.profile?.nickname ?? '…' }}
          <span class="goal">{{ goalText || '未设目标' }}</span>
        </p>
        <p class="meta num">
          {{ metaLine }}
          <span v-if="bmiBandInfo" class="bmi" :class="`t-${bmiBandInfo.tone}`">· BMI {{ bmiText }} {{ bmiBandInfo.label }}</span>
        </p>
      </div>
      <ChevronRight :size="16" class="t-3" />
    </button>

    <!-- 待办完成度：周 / 月 -->
    <section class="card">
      <header class="row between chead">
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
      <WeekView v-if="view === 'week'" class="cbody" :selected="selectedDate" @select="selectedDate = $event" />
      <MonthView v-else class="cbody" :selected="selectedDate" @select="selectedDate = $event" />
    </section>

    <!-- 目标与结余：一卡两栏，发丝线分栏（摄入总览宏量区同一版式） -->
    <section class="card">
      <div class="stats">
        <button class="stat" @click="router.push('/nutrition/adjust')">
          <span class="s-label">每日目标</span>
          <span class="s-big num">{{ targetKcal ?? '--' }}<i>大卡</i></span>
          <span class="s-sub">{{ targetSub }}</span>
        </button>
        <button class="stat" @click="router.push('/ledger')">
          <span class="s-label">本月结余</span>
          <!-- 带千分位的金额比目标数字长一截：统一起见两栏同用 display-s，不折行 -->
          <span class="s-big num" :class="balancePos ? 'pos' : 'neg'">
            {{ balancePos ? '+' : '-' }}{{ balanceText }}<i>元</i>
          </span>
          <span class="s-sub num">{{ ledgerSub }}</span>
        </button>
      </div>
    </section>

    <!-- 个人约束：方案生成依据，去处收在卡头右侧胶囊（与「今日画布 · 详情」同位） -->
    <section class="card">
      <header class="row between chead">
        <h2>个人约束</h2>
        <PillChip as="button" tone="action" @click="openEdit">
          编辑 <ChevronRight :size="13" :stroke-width="2.6" />
        </PillChip>
      </header>
      <ul class="clist num cbody">
        <li v-for="c in constraintSummary" :key="c.label">
          <em>{{ c.label }}</em>
          <b>{{ c.value }}</b>
        </li>
      </ul>
      <!-- 约束是方案的计算依据，这里给方案一条直达（无方案=去制定，有方案=去看执行） -->
      <button v-if="features.isEnabled('program')" class="plan-link" @click="router.push('/program')">
        <Target :size="14" />
        <span class="grow">{{ program.active ? '方案执行中 · 查看与复盘' : '按这些约束制定健康方案' }}</span>
        <ChevronRight :size="14" />
      </button>
      <p class="hint t-3">健康方案按这些约束计算日程与食谱；也可在「健康方案」向导中临时调整</p>
    </section>

    <!-- 设置入口：二级页（功能开关 / 番茄钟完整配置 / 关于） -->
    <button class="card setrow row between" @click="router.push({ name: 'settings' })">
      <span class="row setlabel"><Settings2 :size="16" /> 设置</span>
      <span class="row setval">功能开关 · 番茄钟 · 关于<ChevronRight :size="15" class="chev" /></span>
    </button>

    <!-- 个人约束编辑：分组行卡抽屉（身体数据 / 训练约束 + 钉底保存） -->
    <ConstraintsSheet :open="editOpen" @close="editOpen = false" />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
  /* 竖排卡片间距交给全局 `.card + .card`（14px），与主页一致 */
}

/* 身份条：一行的信息条不是大卡，收紧行卡内边距（.card 默认 20px 是给内容卡的） */
.id {
  gap: 11px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.id:active {
  background: var(--surface-2);
}

.avatar {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--c-intake), #ff6482);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
}

.idcol {
  flex: 1;
  min-width: 0;
}

.nick {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

/* 目标贴着姓名：身份行只有两行字，把目标推到卡右缘会跟箭头打架、读着像掉出来的 */
.goal {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.meta {
  margin-top: 1px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* BMI 分档色（与约束抽屉卡头同一套档色；muted 档不另设色，随 meta 灰） */
.bmi.t-ok {
  color: var(--ok-strong);
}

.bmi.t-warn {
  color: var(--warn);
}

.bmi.t-danger {
  color: var(--danger);
}

/* 卡头：与「摄入总览 / 今日画布」同一规格 —— title3 / 700 / -0.3px / 主色文字 */
.chead h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text-1);
}

/* 卡头行与卡内容之间恒为 10px（周/月视图、摘要列表都吃这条） */
.cbody {
  margin-top: 10px;
}

.seg {
  width: 104px;
}

/* 目标与结余：两栏 + 发丝竖线 */
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding-right: 14px;
  text-align: left;
  font: inherit;
  color: inherit;
}

.stat + .stat {
  border-left: 0.5px solid color-mix(in srgb, var(--text-1) 10%, transparent);
  padding-left: 14px;
  padding-right: 0;
}

/* 分栏小帽：与摄入总览宏量标签同一档（caption / 700 / 三级灰） */
.s-label {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-3);
}

.s-big {
  font-size: var(--fs-display-s);
  font-weight: 800;
  letter-spacing: -1.2px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.s-big i {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: 400;
  color: var(--text-3);
  margin-left: 3px;
  letter-spacing: 0;
}

.s-big.pos {
  color: var(--ok-strong);
}

.s-big.neg {
  color: var(--danger);
}

.s-sub {
  max-width: 100%;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 约束摘要 */
.clist {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}

.clist em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.clist b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-footnote);
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hint {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid color-mix(in srgb, var(--text-1) 10%, transparent);
  font-size: var(--fs-micro);
}

/* 约束 → 方案 的直达链路：一行，强调色文字（约束是方案的输入，去向要显眼但别抢编辑胶囊） */
.plan-link {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
  text-align: left;
}

.plan-link .grow {
  flex: 1;
  min-width: 0;
}

/* 设置入口行 */
.setrow {
  width: 100%;
  gap: 10px;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.setrow:active {
  background: var(--surface-2);
}

.setlabel {
  gap: 8px;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-1);
}

.setval {
  gap: 2px;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.chev {
  color: var(--text-3);
}
</style>
