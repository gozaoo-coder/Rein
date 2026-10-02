<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import BudgetSheet from '@/components/ledger/BudgetSheet.vue'
import LedgerEntrySheet from '@/components/ledger/LedgerEntrySheet.vue'
import LedgerList from '@/components/ledger/LedgerList.vue'
import LedgerStats from '@/components/ledger/LedgerStats.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { categoryOf } from '@/config/ledger'
import { DESKTOP_MIN } from '@/config/domain'
import { useLedgerStore } from '@/stores/ledger'
import { addMonths, monthKey, todayStr } from '@/utils/date'
import type { LedgerEntry } from '@/types'

/** 记账：月度统计 + 流水列表 + 记一笔 / 编辑 / 预算设置。 */
const store = useLedgerStore()

/** 桌面上主操作落进筛选条，移动端仍用那颗悬浮的「记一笔」（见模板注释） */
const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN}px)`)

onMounted(() => {
  void store.loadMonth()
  void store.loadBudget()
})

/* ---- 月份切换 ---- */
const currentMonth = monthKey(todayStr())
const canNext = computed(() => store.month < currentMonth)

const monthTitle = computed(() => {
  const [y, m] = store.month.split('-')
  return `${y}年${Number(m)}月`
})

function shiftMonth(n: number): void {
  const next = monthKey(addMonths(`${store.month}-01`, n))
  if (n > 0 && next > currentMonth) return
  void store.loadMonth(next)
}

/* ---- 筛选 ---- */
const filterCat = ref<string | null>(null)
const kw = ref('')

const usedCats = computed(() => {
  const keys = new Set<string>()
  for (const e of store.monthEntries) keys.add(e.category)
  return [...keys]
})

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return store.monthEntries.filter(
    (e) =>
      (!filterCat.value || e.category === filterCat.value) &&
      (!k || (e.note ?? '').toLowerCase().includes(k)),
  )
})

/* ---- 弹层 ---- */
const entryOpen = ref(false)
const editing = ref<LedgerEntry | null>(null)
const budgetOpen = ref(false)

function onAdd(): void {
  editing.value = null
  entryOpen.value = true
}

function onEdit(e: LedgerEntry): void {
  editing.value = e
  entryOpen.value = true
}

const emptyText = computed(() =>
  kw.value.trim() || filterCat.value ? '没有匹配的流水' : '本月还没有流水，点右下角记一笔',
)
</script>

<template>
  <div class="page">
    <PageHeader title="记账" subtitle="每一笔都记录，月底心中有数" back>
      <template #action>
        <div class="month row center">
          <button class="nav" aria-label="上一个月" @click="shiftMonth(-1)">
            <ChevronLeft :size="16" :stroke-width="2.4" />
          </button>
          <span class="m-title num">{{ monthTitle }}</span>
          <button class="nav" aria-label="下一个月" :disabled="!canNext" @click="shiftMonth(1)">
            <ChevronRight :size="16" :stroke-width="2.4" />
          </button>
        </div>
      </template>
    </PageHeader>

    <!-- 桌面：左统计 / 右流水的主从构图。
         .board 在移动端就是普通的一列（内容与顺序**完全不变**），桌面才分成两栏 ——
         495px 高的统计卡独占一栏、整列流水交给右栏，省掉的是眼睛在
         「月份数字 ↔ 流水条目」之间来回横跳的距离。 -->
    <div class="board d-full">
      <!-- 本月统计 + 预算 + 趋势 -->
      <LedgerStats @edit-budget="budgetOpen = true" />

      <div class="flow">
        <!-- 筛选：关键词 + 分类 -->
        <div class="filters">
          <div class="searchrow row">
            <label class="search row center flex-1">
              <Search :size="15" class="t-3" />
              <input v-model="kw" type="search" placeholder="搜索备注" aria-label="搜索备注" />
            </label>
            <!-- 桌面的主操作落在筛选条右端：窗口底部正中的悬浮钮会压在流水上，
                 也不是桌面习惯（那个位置本该什么都没有）。移动端仍用悬浮钮。 -->
            <button v-if="isDesktop" class="add-inline row center pressable" @click="onAdd">
              <Plus :size="16" :stroke-width="2.6" />
              <span>记一笔</span>
            </button>
          </div>
          <div class="chips" data-rubber-self>
            <button class="chip" :class="{ on: filterCat === null }" @click="filterCat = null">全部</button>
            <button
              v-for="key in usedCats"
              :key="key"
              class="chip"
              :class="{ on: filterCat === key }"
              @click="filterCat = filterCat === key ? null : key"
            >
              <i class="dot" :style="{ background: categoryOf(key)?.colorVar ?? 'var(--led-other)' }" />
              {{ categoryOf(key)?.label ?? key }}
            </button>
          </div>
        </div>

        <!-- 流水 -->
        <LedgerList v-if="filtered.length > 0" :entries="filtered" @edit="onEdit" />
        <section v-else class="card empty t-3">{{ emptyText }}</section>
      </div>
    </div>

    <!-- 记一笔（Teleport 出页面层：translate 会改 fixed 后代的包含块，留在层内拖动时会跑位）。
         桌面不挂它：桌面的主操作在筛选条右端（见上），悬浮钮只留给触屏。 -->
    <Teleport v-if="!isDesktop" to="body">
      <button class="fab row center" aria-label="记一笔" @click="onAdd">
        <Plus :size="20" :stroke-width="2.6" />
        <span>记一笔</span>
      </button>
    </Teleport>

    <LedgerEntrySheet :open="entryOpen" :entry="editing" @close="entryOpen = false" @saved="entryOpen = false" />
    <BudgetSheet :open="budgetOpen" @close="budgetOpen = false" @saved="budgetOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* 月份切换（页头 action 槽） */
.month {
  gap: 2px;
  margin-bottom: 4px;
}

.nav {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav:disabled {
  opacity: 0.35;
}

.m-title {
  min-width: 92px;
  text-align: center;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

/* ---------- 桌面主从构图（.board 内的一切在移动端都是普通块） ---------- */
.board {
  display: block;
}

/* 左栏固定 360px：统计卡的内容（三栏数字 + 环形图 + 六个月柱）在 360 下刚好排得开，
   再宽只会让它在桌面画布里显得比右边的流水更重 */
.desk-main .board {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: var(--desk-gap);
  align-items: start;
}

/* 筛选 */
.filters {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: 14px;
}

/* 桌面上搜索框与主操作同一行：搜索框吃掉余量，按钮贴右端 */
.searchrow {
  gap: 8px;
}

.add-inline {
  flex: none;
  gap: 5px;
  padding: 8px 14px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

/* 桌面：流水一栏里那条 .card + .card 的边距照旧，但统计卡与右栏是栅格子项，
   不需要额外上边距 */
.desk-main .board > .card + .card {
  margin-top: 0;
}

.search {
  gap: 7px;
  padding: 8px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.search input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  color: var(--text-1);
  background: transparent;
}

.search input::placeholder {
  color: var(--text-3);
}

.chips {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 6px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.empty {
  padding: 26px 16px;
  text-align: center;
  font-size: var(--fs-footnote);
  font-weight: 500;
}

/* 记一笔悬浮按钮（TabBar 之上） */
.fab {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--dock-top) + 14px);
  z-index: 50;
  gap: 5px;
  padding: 13px 24px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: #fff;
  box-shadow: var(--shadow-float);
  font-size: var(--fs-headline);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.fab:active {
  transform: translateX(-50%) scale(0.95);
}
</style>
