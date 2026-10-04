<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Utensils } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import MealDetailSheet from '@/components/diet/MealDetailSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_META, MEAL_ORDER, fmtGrams, mealKcal, mealQtyText } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { dietService } from '@/services/dietService'
import { nutritionService } from '@/services/nutritionService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { WEEKDAY_LABELS, addDays, fmtDateCn, startOfWeek, todayStr, weekDates } from '@/utils/date'
import type { DailySummary, MealLog } from '@/types'

/** 饮食历史悬浮窗：周条选日 + 分餐次记录列表；点行进单笔详情（实际营养素 + 删除）。
 *  数据全部落在本地（直调 service），不污染全局 store 的「今天」视图；
   仅删除今天的记录时回流刷新，让首页宽条即时同步。 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const toast = useToast().toast
const diet = useDietStore()
const nutrition = useNutritionStore()

const today = todayStr()
const anchor = ref(today) // 当前显示周的锚点（周内任意一天）
const selected = ref(today)
const logs = ref<MealLog[]>([])
const summary = ref<DailySummary | null>(null)
const loading = ref(false)

/* ---------- 周条 ---------- */
const days = computed(() => weekDates(anchor.value))
const targetKcal = computed(() => Math.round(summary.value?.targets.kcal ?? 0))
const atCurrentWeek = computed(() => anchor.value === startOfWeek(today))

/** 周内每日摄入占目标百分比（迷你条）；目标未设时全为 0（不显示） */
const dayPct = computed(() => {
  const t = targetKcal.value
  const kcalByDay = new Map<string, number>()
  for (const l of logs.value) kcalByDay.set(l.date, (kcalByDay.get(l.date) ?? 0) + (mealKcal(l) ?? 0))
  const pct = new Map<string, number>()
  for (const [d, kcal] of kcalByDay) pct.set(d, t <= 0 ? 0 : Math.min(100, Math.round((kcal / t) * 100)))
  return pct
})

/* ---------- 数据拉取（序号防快翻竞态） ---------- */
let weekSeq = 0
let summarySeq = 0

async function fetchWeek(): Promise<void> {
  const seq = ++weekSeq
  loading.value = true
  try {
    const ws = startOfWeek(anchor.value)
    const list = await dietService.listMealsRange(ws, addDays(ws, 6))
    if (seq === weekSeq) logs.value = list
  } finally {
    if (seq === weekSeq) loading.value = false
  }
}

async function fetchSummary(): Promise<void> {
  const seq = ++summarySeq
  const s = await nutritionService.getDailySummary(selected.value)
  if (seq === summarySeq) summary.value = s
}

function pickDay(d: string): void {
  if (d === selected.value) return
  selected.value = d
  void fetchSummary()
}

/** 翻周：锚点平移一周；选中日跟随平移并钳制在本周内、不越过今天 */
function shiftWeek(delta: number): void {
  const ws = startOfWeek(addDays(anchor.value, delta * 7))
  const we = addDays(ws, 6)
  const limit = we < today ? we : today
  let next = addDays(selected.value, delta * 7)
  if (next < ws) next = ws
  if (next > limit) next = limit
  anchor.value = ws
  pickDay(next)
  void fetchWeek()
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    anchor.value = startOfWeek(today)
    selected.value = today
    void fetchWeek()
    void fetchSummary()
  },
)

/* ---------- 当日列表 ---------- */
const dayLogs = computed(() => logs.value.filter((l) => l.date === selected.value))

/** 行内四格指标：本笔占当日目标的百分比；目标未设（≤0）回落显示克数 */
const ROW_METRICS = [
  { key: 'kcal', label: '热量', colorVar: '--c-intake' },
  { key: 'protein', label: '蛋白', colorVar: '--c-protein' },
  { key: 'carb', label: '碳水', colorVar: '--c-carb' },
  { key: 'fat', label: '脂肪', colorVar: '--c-fat' },
] as const

function rowMetrics(l: MealLog) {
  const f = l.food
  if (!f) return null
  const k = l.grams / 100
  const t = summary.value?.targets
  const actual = {
    kcal: f.kcal * k,
    protein: f.protein * k,
    carb: f.carb * k,
    fat: f.fat * k,
  }
  const target = {
    kcal: t?.kcal ?? 0,
    protein: t?.protein ?? 0,
    carb: t?.carb ?? 0,
    fat: t?.fat ?? 0,
  }
  return ROW_METRICS.map((m) => {
    const pct = target[m.key] > 0 ? Math.round((actual[m.key] / target[m.key]) * 100) : null
    return { ...m, pct, fill: pct == null ? 0 : Math.min(100, pct), gramsText: fmtGrams(actual[m.key]) }
  })
}

const groups = computed(() =>
  MEAL_ORDER.map((type) => ({
    type,
    items: dayLogs.value
      .filter((l) => l.mealType === type)
      .map((l) => ({ log: l, metrics: rowMetrics(l) })),
  })).filter((g) => g.items.length > 0),
)

function groupKcal(items: { log: MealLog }[]): number {
  return items.reduce((s, it) => s + (mealKcal(it.log) ?? 0), 0)
}

/* ---------- 详情与删除 ---------- */
const detail = ref<MealLog | null>(null)
const delTarget = ref<MealLog | null>(null)
const busy = ref(false)

/** 详情页里的删除：带上这条记录打开既有二次确认 */
function askDelete(): void {
  if (!detail.value) return
  delTarget.value = detail.value
}

async function onDelete(): Promise<void> {
  const t = delTarget.value
  if (!t || busy.value) return
  busy.value = true
  try {
    await dietService.deleteMeal(t.id)
    logs.value = logs.value.filter((x) => x.id !== t.id)
    void fetchSummary()
    // 删的是今天的记录 → 回流刷新首页的能量汇总与时间轴
    if (t.date === today) {
      void diet.load(today)
      void nutrition.loadSummary(today)
    }
    toast('已删除')
  } finally {
    busy.value = false
    delTarget.value = null
    detail.value = null
  }
}
</script>

<template>
  <SheetModal :open="open" initial-snap="large" title="饮食历史" @close="emit('close')">
    <div class="hist">
      <!-- 周条：吸顶，翻周切换查看日期 -->
      <div class="weekbar">
        <button class="nav pressable" aria-label="上一周" @click="shiftWeek(-1)">
          <ChevronLeft :size="18" />
        </button>
        <div class="days">
          <button
            v-for="(d, i) in days"
            :key="d"
            class="day"
            :class="{ sel: d === selected }"
            :disabled="d > today"
            :aria-label="fmtDateCn(d)"
            @click="pickDay(d)"
          >
            <span class="dw">{{ WEEKDAY_LABELS[i] }}</span>
            <span class="dn num">{{ Number(d.slice(8)) }}</span>
            <i class="mbar"><i class="fill" :style="{ width: (dayPct.get(d) ?? 0) + '%' }" /></i>
          </button>
        </div>
        <button class="nav pressable" aria-label="下一周" :disabled="atCurrentWeek" @click="shiftWeek(1)">
          <ChevronRight :size="18" />
        </button>
      </div>

      <!-- 当日汇总 -->
      <div class="dayhead">
        <b>{{ fmtDateCn(selected) }}</b>
        <span class="num t-3">
          已摄入 {{ Math.round(summary?.intake.kcal ?? 0) }}{{ targetKcal ? ` / ${targetKcal}` : '' }} kcal ·
          {{ dayLogs.length }} 笔
        </span>
      </div>

      <!-- 分餐次列表 -->
      <section v-for="g in groups" :key="g.type" class="meal">
        <header class="mhead">
          <i
            class="mic"
            :style="{
              background: `color-mix(in srgb, ${MEAL_META[g.type].colorVar} 14%, transparent)`,
              color: MEAL_META[g.type].colorVar,
            }"
          >
            <component :is="MEAL_META[g.type].icon" :size="17" />
          </i>
          <b>{{ MEAL_LABELS[g.type] }}</b>
          <span class="num ksum">{{ groupKcal(g.items) }} kcal</span>
        </header>
        <button v-for="it in g.items" :key="it.log.id" class="row pressable" @click="detail = it.log">
          <span class="rcol">
            <span class="rname">{{ it.log.food?.name ?? MEAL_LABELS[it.log.mealType] }}</span>
            <span class="rsub">
              {{ mealQtyText(it.log) }}<template v-if="it.log.note"> · {{ it.log.note }}</template>
            </span>
            <span v-if="it.metrics" class="nutgrid">
              <span v-for="m in it.metrics" :key="m.key" class="ncell">
                <span class="nlab">
                  {{ m.label }}
                  <b class="num nval">{{ m.pct != null ? `${m.pct}%` : `${m.gramsText}g` }}</b>
                </span>
                <i class="nbar" :class="{ 'notgt': m.pct == null }">
                  <i class="nfill" :style="{ width: m.fill + '%', background: `var(${m.colorVar})` }" />
                </i>
              </span>
            </span>
          </span>
          <b class="num rkcal">{{ mealKcal(it.log) != null ? `${mealKcal(it.log)} kcal` : '—' }}</b>
        </button>
      </section>

      <EmptyState
        v-if="!loading && dayLogs.length === 0"
        :icon="Utensils"
        title="这一天还没有饮食记录"
        hint="从首页「记一笔」或 AI 助手添加"
      />
    </div>

    <!-- 单笔详情（Teleport 到 body）：点行看这份实际吃进去的营养素 -->
    <MealDetailSheet
      :open="detail !== null"
      :log="detail"
      :targets="summary?.targets ?? null"
      @close="detail = null"
      @delete="askDelete"
    />

    <!-- 删除确认（Teleport 到 body） -->
    <ActionSheet
      :open="delTarget !== null"
      :title="`删除「${delTarget?.food?.name ?? '记录'}」？`"
      :actions="[{ label: '删除这条记录', value: 'delete', danger: true }]"
      @close="delTarget = null"
      @select="onDelete"
    />
  </SheetModal>
</template>

<style scoped>
.hist {
  padding-bottom: 8px;
}

/* 周条 */
/* 流畅档的抽屉是实底：条用同一个 --surface，观感与历史一致。
   高画质及以上抽屉本体是半透明玻璃 —— 条**不能再铺自己的玻璃底**：
   两层 0.86~0.66 的白叠起来是 0.96，条带会比面板亮出一档（白带以弱化形式回来）。
   正确做法是玻璃档下背景透明：backdrop root 是面板，条的 backdrop 只含面板内
   画在它之下的内容 —— 静止时与面板逐像素一致，滚动时把从条下过的记录行磨成霜。
   负 margin 全宽出血：否则内容会从条两侧 18px 的沟里滚过去。 */
.weekbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 -18px;
  background: var(--surface);
  padding: 4px 18px 10px;
}

/* 玻璃档：面板自己的 backdrop-filter 只作用于「面板背后的页面」，
   从条底下滚过的记录行要靠条自己这层模糊滤掉，玻璃的厚度才读得出来 */
html[data-perf]:not([data-perf='low']) .weekbar {
  background: transparent;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
}

/* 减弱透明度：面板被 base.css 顶回实底（该媒体查询覆盖不到组件内的自定义表面），
   条同样回实底、去模糊，与面板同材质 */
@media (prefers-reduced-transparency: reduce) {
  html[data-perf] .weekbar {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

.nav {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav:disabled {
  opacity: 0.35;
}

.days {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 5px;
}

.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 0 7px;
  border-radius: var(--radius-l);
  min-width: 0;
}

.day:disabled {
  opacity: 0.32;
}

.dw {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
}

.dn {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.mbar {
  width: 60%;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

.mbar .fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
}

.day.sel {
  background: var(--accent);
}

.day.sel .dw {
  color: var(--on-accent);
  opacity: 0.75;
}

.day.sel .dn {
  color: var(--on-accent);
}

.day.sel .mbar {
  background: color-mix(in srgb, var(--on-accent) 28%, transparent);
}

.day.sel .mbar .fill {
  background: var(--on-accent);
}

/* 当日汇总 */
.dayhead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.dayhead b {
  font-size: var(--fs-callout);
  font-weight: 700;
}

.dayhead span {
  font-size: var(--fs-footnote);
}

/* 餐次小节 */
.meal {
  margin-top: 16px;
}

.mhead {
  display: flex;
  align-items: center;
  gap: 9px;
}

.mic {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mhead b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.ksum {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-weight: 600;
}

/* 记录行：高频列表，不加过渡 */
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 7px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.rcol {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rname {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rsub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 行内指标格：本笔四大指标占当日目标（颜色留在条上，数字走中性） */
.nutgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-top: 8px;
}

.ncell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.nlab {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}

.nval {
  font-weight: 700;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.nbar {
  display: block;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--line);
  overflow: hidden;
}

/* 目标未设：不画空槽，克数文案就是全部信息 */
.nbar.notgt {
  background: transparent;
}

.nfill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
}

.rkcal {
  flex: none;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}
</style>
