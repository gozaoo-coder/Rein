<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, NotebookPen, Plus, Search, SearchX } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import BudgetSheet from '@/components/ledger/BudgetSheet.vue'
import LedgerEntrySheet from '@/components/ledger/LedgerEntrySheet.vue'
import LedgerList from '@/components/ledger/LedgerList.vue'
import LedgerStats from '@/components/ledger/LedgerStats.vue'
import { categoryOf } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { addMonths, monthKey, todayStr } from '@/utils/date'
import type { LedgerEntry } from '@/types'

/** 记账：月度统计 + 流水列表 + 记一笔 / 编辑 / 预算设置。 */
const store = useLedgerStore()

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

/** 本月一条流水都没有。区别于「筛出来是空」——后者是关键词/分类的锅，筛选条得留着让人撤回来。 */
const noEntries = computed(() => store.monthEntries.length === 0)
const noMatch = computed(() => kw.value.trim() !== '' || filterCat.value !== null)
/** 空月份整条收起筛选：没有东西可筛，那条孤零零的「全部」胶囊还占着 40px，
 *  把空态卡一路顶到悬浮钮底下（用户截图里被压住的正是这一块）。 */
const showFilters = computed(() => !noEntries.value || noMatch.value)

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

const emptyCopy = computed(() => {
  if (noMatch.value) {
    return {
      icon: SearchX,
      title: '没有匹配的流水',
      hint: usedCats.value.length > 0 ? '换个关键词，或点上面的分类重新筛' : '换个关键词试试',
    }
  }
  return { icon: NotebookPen, title: '本月还没有流水', hint: '点下面的「记一笔」，第一笔就落在这个月' }
})
</script>

<template>
  <div class="page">
    <PageHeader title="记账" subtitle="每一笔都有数" back>
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
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 桌面：左统计 / 右流水的主从构图。
         .board 在移动端就是普通的一列（内容与顺序**完全不变**），桌面才分成两栏 ——
         495px 高的统计卡独占一栏、整列流水交给右栏，省掉的是眼睛在
         「月份数字 ↔ 流水条目」之间来回横跳的距离。 -->
    <div class="board d-full">
      <!-- 本月统计 + 预算 + 趋势 -->
      <LedgerStats @edit-budget="budgetOpen = true" />

      <div class="flow">
        <!-- 筛选：关键词 + 分类（分类胶囊按本月实际用到的分类生成）。
             本月一条流水都没有时整条收起 —— 没有东西可筛，那条孤零零的「全部」胶囊
             还白占 40px，把空态卡一路顶到浮层底下。 -->
        <div v-if="showFilters" class="filters">
          <div class="searchrow row">
            <label class="search row center flex-1">
              <Search :size="15" class="t-3" />
              <input v-model="kw" type="search" placeholder="搜索备注" aria-label="搜索备注" />
            </label>
            <!-- 主操作「记一笔」：**全端就这一处**（原先移动端是底部那颗 fixed 居中胶囊）。
                 胶囊压在滚动内容上，一页里永远有一块被它盖住 —— 393×749 下是分类胶囊与
                 搜索框，430×932 下是某行的分类名与备注，空月份下正是空态那句提示本身。
                 补 padding-bottom 只能保证「滚到底能露出来」，静止时被压的那一行照样读不了；
                 这一页的流水是逐行读的列表，最经不起盖，所以主操作回到流里（而不是把
                 碰撞挪个位置）。它按 `filtered.length` 与空态卡二选一，同一屏只有一颗。 -->
            <button v-if="filtered.length > 0" class="add-inline row center pressable" @click="onAdd">
              <Plus :size="16" :stroke-width="2.6" />
              <span>记一笔</span>
            </button>
          </div>
          <div v-if="usedCats.length > 0" class="chips" data-rubber-self>
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
        <!-- 空态：与抢课/知识库同用 EmptyState（图标 + 标题 + 提示）。
             没有可读的流水时，行动出口就落在这张卡里（筛选条那时也收起了，
             不落在卡里就等于整个月没有入口记第一笔）。 -->
        <section v-else class="card">
          <EmptyState :icon="emptyCopy.icon" :title="emptyCopy.title" :hint="emptyCopy.hint">
            <template #action>
              <button class="add-inline row center pressable" @click="onAdd">
                <Plus :size="16" :stroke-width="2.6" />
                <span>记一笔</span>
              </button>
            </template>
          </EmptyState>
        </section>
      </div>
    </div>

    <LedgerEntrySheet :open="entryOpen" :entry="editing" @close="entryOpen = false" @saved="entryOpen = false" />
    <BudgetSheet :open="budgetOpen" @close="budgetOpen = false" @saved="budgetOpen = false" />
    </div>
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
  /* 排进筛选条时是 flex 项、落进空态卡（.act 是文本居中的块）时必须是 inline-flex，
     否则按钮会被拉满整卡宽 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
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

/* 页头副标题：窄窗下宁可截断也不折成两行 —— 月份切换器固定占 156px，
   390 宽时标题块只剩 132px，12 个字的副标题一折行就把页头顶到 98px，
   切换器随之被推到第二行旁边，整条页头读起来是散的。
   文案已按 360 宽（Android 最窄机型）收在一行内，这条只是兜底。 */
.page-header :deep(p) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* EmptyState 自带 26px 上下内边距，而 .card 外面又给了一圈 16 —— 两层叠起来，
   卡里上下一共 84px 的空白，空态卡因此顶到 208px 高（390 宽的下限窗口里，
   它一路伸到 dock 底下）。组件内边距在这里收掉，外侧的卡已经提供了呼吸。 */
.card :deep(.empty) {
  padding: 4px 12px;
}

/* 空态卡里那颗是当月唯一的入口（筛选条同时收起了），给它 44px 的触控高度；
   筛选条里那颗仍留在行高内，与搜索框齐平。 */
.card .add-inline {
  padding: 11px 20px;
}

/* 主操作现在全端就这一处（悬浮钮已取消），命中区必须够拇指：视觉高度跟着搜索框
   （35px），命中区按项目惯例（PageHeader 的 .back / .hdr-btn）撑到 44 —— 只上下扩，
   不横向扩：左边就是搜索框，横向扩会把它右端那一段的点击抢走。 */
.add-inline::after {
  content: '';
  position: absolute;
  inset: -5px 0;
}
</style>
