<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import type { PeriodSlot, ScheduleEntry } from '@/types'
import { parseDate, weekDates, todayStr } from '@/utils/date'

/**
 * 周视图 · 7 列 × 节次行。
 *
 * 行 = 教务的真实节次区间（`TimeSlot`），左侧列显示**实际上课时间**而不是「第几节」——
 * 数据直接来自教务的 `startTime`/`endTime`，不需要我们维护节次表。
 * 表头在星期几下方标注具体日期（需求明确要求）。
 *
 * 滚动体验的三个关键决定：
 * 1. **单一滚动容器同时承担 x/y**：斜向滑动自然，不会出现两个滚动上下文互相打架；
 * 2. **双向冻结窗格**：表头 `sticky top`、时间列 `sticky left`、左上角两者兼具，
 *    横滑不丢时间、纵滑不丢星期；
 * 3. **刻意不用 `scroll-snap`**：吸附会在纵向滚动时劫持手势，横滑到头也会触发浏览器的
 *    返回手势。改为 `overscroll-behavior: contain` 把滚动留在网格内，手感更稳。
 */
const props = defineProps<{
  entries: ScheduleEntry[]
  timeSlots: PeriodSlot[]
  /** 该周内任意一天，用来定位这一周 */
  anchor: string
}>()

const today = todayStr()

/** 行标识：节次区间就是行身份（同一区间的时间必然一致） */
function rowKey(slot: { startUnit: number; endUnit: number }): string {
  return `${slot.startUnit}-${slot.endUnit}`
}

function cellKey(date: string, slot: { startUnit: number; endUnit: number }): string {
  return `${date}|${rowKey(slot)}`
}

const days = computed(() => weekDates(props.anchor))

const rows = computed(() => [...props.timeSlots].sort((a, b) => a.startMin - b.startMin))

const cells = computed(() => {
  const map = new Map<string, ScheduleEntry[]>()
  for (const e of props.entries) {
    const key = cellKey(e.date, e.session)
    const list = map.get(key)
    if (list) list.push(e)
    else map.set(key, [e])
  }
  return map
})

/** 同格多课：>2 门时只画两门，其余折成「+N」提示（课程冲突不是常态，不必为它牺牲可读性） */
function visible(list: ScheduleEntry[]): ScheduleEntry[] {
  return list.length > 2 ? list.slice(0, 2) : list
}

/** 把课落到它所属的节次行上 —— 用节次区间匹配，而不是比较时间字符串 */
function cellEntries(date: string, slot: PeriodSlot): ScheduleEntry[] {
  return cells.value.get(cellKey(date, slot)) ?? []
}

function colorOf(e: ScheduleEntry): string {
  return e.session.color ?? 'var(--cat-class)'
}

function dayLabel(d: string): string {
  return `周${'一二三四五六日'[(parseDate(d).getDay() + 6) % 7]}`
}

function monthDay(d: string): string {
  const dt = parseDate(d)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

/** 教学周序号：优先用当天的课自带的周次，没有就留空 */
function weekNoOf(d: string): number | null {
  for (const e of props.entries) {
    if (e.date === d) return e.week
  }
  return null
}

const scroller = ref<HTMLElement | null>(null)

/**
 * 打开时把「今天」那一列滚进视野（今天不在本周则滚到周一）。
 * 课表有 7 列，窄屏下默认停在最左边会让用户以为今天没课。
 */
function scrollToToday(): void {
  const el = scroller.value
  if (!el) return
  const grid = el.querySelector<HTMLElement>('.grid')
  const timeCell = el.querySelector<HTMLElement>('.cell.time')
  if (!grid || !timeCell) return
  const idx = days.value.findIndex((d) => d === today)
  if (idx < 0) {
    el.scrollLeft = 0
    return
  }
  // 宽度全部实测：列宽受 minmax 下限与实际可用宽度共同决定，时间列也由 CSS 定死，
  // 任何一处用常量估算都会偏。
  const timeW = timeCell.getBoundingClientRect().width
  const colWidth = (grid.scrollWidth - timeW) / 7
  if (colWidth <= 0) return
  // 一屏能完整放下几天（冻结的时间列要先扣掉）
  const perScreen = Math.max(1, Math.min(7, Math.floor((el.clientWidth - timeW) / colWidth)))
  // **必须对齐到列边界**：按像素居中会让边上那一列只露半截，看起来像渲染坏了
  let first = Math.max(0, Math.min(idx - Math.floor(perScreen / 2), 7 - perScreen))
  // 目标位置可能超出「能滚到的范围」（右边已经没有更多内容）：浏览器会把它夹住，
  // 而夹完的结果**不落在列边界上** —— 左边会留下几像素的前一天残影。
  // 这种情况退到最靠右的列边界：今天照样在屏幕里，只是不贴左边。
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth)
  if (first * colWidth > maxScroll) {
    first = Math.floor(maxScroll / colWidth)
  }
  el.scrollLeft = first * colWidth
}

onMounted(scrollToToday)
watch(() => props.anchor, scrollToToday)

const todayIndex = computed(() => days.value.findIndex((d) => d === today))
</script>

<template>
  <div ref="scroller" class="wrap">
    <div class="grid" :style="{ '--today-col': todayIndex + 1 }">
      <!-- 表头：星期 + 日期；左上角同时冻结两轴 -->
      <div class="cell head corner">时间</div>
      <div
        v-for="(d, i) in days"
        :key="d"
        class="cell head day"
        :class="{ today: i === todayIndex }"
      >
        <span class="dow">{{ dayLabel(d) }}</span>
        <span class="dnum">{{ monthDay(d) }}</span>
        <span v-if="weekNoOf(d)" class="wk">第{{ weekNoOf(d) }}周</span>
      </div>

      <!-- 主体：每行 = 一个节次区间 -->
      <template v-for="slot in rows" :key="rowKey(slot)">
        <div class="cell time">
          <span class="t1">{{ slot.startTime }}</span>
          <span class="t2">{{ slot.endTime }}</span>
          <span class="unit">第{{ slot.startUnit }}-{{ slot.endUnit }}节</span>
        </div>
        <div
          v-for="(d, i) in days"
          :key="d + rowKey(slot)"
          class="cell slot"
          :class="{ today: i === todayIndex }"
        >
          <div v-if="cellEntries(d, slot).length" class="blocks">
            <button
              v-for="e in visible(cellEntries(d, slot))"
              :key="e.session.id + d"
              class="blk"
              :style="{ '--blk': colorOf(e) }"
              :title="`${e.session.courseName} · ${e.session.building ?? ''}${e.session.room ?? ''}`"
            >
              <span class="name">{{ e.session.courseName }}</span>
              <span class="meta">{{ e.session.room ?? e.session.building ?? '' }}</span>
            </button>
            <span v-if="cellEntries(d, slot).length > 2" class="more">
              +{{ cellEntries(d, slot).length - 2 }}
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/**
 * 单一滚动容器：横竖都归它管。
 * 用定高而不是 max-height —— 节次少时课表也该铺满可用高度（和纸质课表一样），
 * 行高由 `minmax(62px, 1fr)` 均分；节次多时超出即滚动。
 */
.wrap {
  overflow: auto;
  overscroll-behavior: contain;
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  /* 轨道透明、滑块用分隔线的颜色：七列永远放不下一屏，这条细滚动条是
     「右边/下面还有」的唯一提示，不能像全局那样把它藏掉。 */
  scrollbar-color: var(--line-strong) transparent;
  height: calc(
    100dvh - var(--safe-top) - var(--tabbar-h) - var(--safe-bottom) - var(--wbar-reserve, 0px) - 236px
  );
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  user-select: none;
}

/* 全局那条 `::-webkit-scrollbar { width:0; height:0 }` 是「全应用不显示滚动条」的苹果风格，
   但这个网格**必须**双轴滚动 —— 藏掉滚动条后，右边被切掉的半列看起来像渲染坏了，
   而不是「还能往右滑」。这里按类选择器把这条细滚动条要回来（特异性高于全局那条）。
   滑块做得克制：只求一眼看出「还有」，不抢课表的视觉。 */
.wrap::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.wrap::-webkit-scrollbar-track,
.wrap::-webkit-scrollbar-corner {
  background: transparent;
}

.wrap::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: var(--radius-full);
}

.wrap::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}

.grid {
  display: grid;
  grid-template-columns: 58px repeat(7, minmax(92px, 1fr));
  grid-auto-rows: minmax(62px, 1fr);
  min-height: 100%;
}

.cell {
  border-bottom: 0.5px solid var(--line);
  border-right: 0.5px solid var(--line);
  min-width: 0;
}

/* ---------- 冻结三件套 ---------- */
.head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--surface-translucent);
  backdrop-filter: blur(14px) saturate(180%);
  -webkit-backdrop-filter: blur(14px) saturate(180%);
  border-bottom: 0.5px solid var(--line-strong);
}

.time {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--surface);
  /* 冻结边界的「封边」：一道硬分隔线 + 一道向右衰减的阴影。
     缺了它，横滑时左边缘与内容之间没有界线 —— 看起来只是「一列被切掉了」，
     而不是「左侧这一列是冻住的」。封边同时把任何从缝隙里透出来的内容挡住。 */
  box-shadow:
    1px 0 0 var(--line-strong),
    10px 0 12px -10px color-mix(in srgb, var(--text-1) 32%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 4px 2px;
}

.corner {
  left: 0;
  z-index: 4;
  /* 左上角要撑住两道边界（横滑 + 纵滑），封边与外层同款，否则滚动时会看到断层 */
  background: var(--surface);
  box-shadow:
    1px 0 0 var(--line-strong),
    10px 0 12px -10px color-mix(in srgb, var(--text-1) 32%, transparent);
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---------- 表头 ---------- */
.day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 6px 2px;
}

.dow {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.1;
}

.dnum {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.wk {
  font-size: 9px;
  color: var(--text-3);
  line-height: 1.1;
}

.day.today .dow {
  color: var(--accent);
}

.day.today .dnum {
  color: var(--accent);
  font-weight: 600;
}

/* ---------- 左侧时间列 ---------- */
.t1 {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}

.t2 {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}

.unit {
  font-size: 9px;
  color: var(--text-3);
  opacity: 0.75;
  line-height: 1.1;
}

/* ---------- 课程格 ---------- */
.slot {
  padding: 2px;
  display: flex;
}

.slot.today {
  background: var(--accent-soft);
}

.blocks {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.blk {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 5px;
  border-radius: var(--radius-s);
  border-left: 3px solid var(--blk);
  background: color-mix(in srgb, var(--blk) 14%, var(--surface));
  text-align: left;
  overflow: hidden;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.blk:active {
  transform: scale(0.97);
}

.name {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

.meta {
  font-size: 9px;
  color: var(--text-3);
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  align-self: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-weight: 600;
  padding: 0 2px;
}

@media (prefers-reduced-transparency: reduce) {
  .head {
    background: var(--surface);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
