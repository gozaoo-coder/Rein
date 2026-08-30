<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Utensils } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_META, MEAL_ORDER, mealKcal } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { dietService } from '@/services/dietService'
import { nutritionService } from '@/services/nutritionService'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { WEEKDAY_LABELS, addDays, fmtDateCn, startOfWeek, todayStr, weekDates } from '@/utils/date'
import type { DailySummary, MealLog } from '@/types'

/** 饮食历史悬浮窗：周条选日 + 分餐次记录列表，可删单笔。
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
const groups = computed(() =>
  MEAL_ORDER.map((type) => ({ type, items: dayLogs.value.filter((l) => l.mealType === type) })).filter(
    (g) => g.items.length > 0,
  ),
)

function groupKcal(items: MealLog[]): number {
  return items.reduce((s, l) => s + (mealKcal(l) ?? 0), 0)
}

function qtyText(l: MealLog): string {
  if (l.quantityMode === 'unit' && l.units != null && l.unitName) {
    return `${l.units} ${l.unitName}（${Math.round(l.grams)} g）`
  }
  return `${Math.round(l.grams)} g`
}

/* ---------- 删除 ---------- */
const delTarget = ref<MealLog | null>(null)
const busy = ref(false)

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
        <button v-for="l in g.items" :key="l.id" class="row pressable" @click="delTarget = l">
          <span class="rcol">
            <span class="rname">{{ l.food?.name ?? MEAL_LABELS[l.mealType] }}</span>
            <span class="rsub">{{ qtyText(l) }}<template v-if="l.note"> · {{ l.note }}</template></span>
          </span>
          <b class="num rkcal">{{ mealKcal(l) != null ? `${mealKcal(l)} kcal` : '—' }}</b>
        </button>
      </section>

      <EmptyState
        v-if="!loading && dayLogs.length === 0"
        :icon="Utensils"
        title="这一天还没有饮食记录"
        hint="从首页「记一笔」或 AI 助手添加"
      />
    </div>

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
.weekbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  padding: 4px 0 10px;
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
  font-weight: 650;
  color: var(--text-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rsub {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.rkcal {
  flex: none;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}
</style>
