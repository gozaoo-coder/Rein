<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarOff, CalendarX2, ChevronLeft, ChevronRight, GraduationCap, RefreshCw, Settings2, Zap } from 'lucide-vue-next'

import ScheduleDayView from '@/components/campus/ScheduleDayView.vue'
import ScheduleMonthView from '@/components/campus/ScheduleMonthView.vue'
import ScheduleWeekView from '@/components/campus/ScheduleWeekView.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { addDays, addMonths, endOfMonth, fmtDateCn, startOfMonth, todayStr, weekDates } from '@/utils/date'

type ViewKey = 'day' | 'week' | 'month'

const store = useCampusStore()
const router = useRouter()
const toast = useToast()

const view = ref<ViewKey>('week')
const anchor = ref(todayStr())

const viewOptions: { value: ViewKey; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

/** 当前视图对应的日期区间 —— 只请求要显示的那一段，避免整学期数据来回传 */
const range = computed<[string, string]>(() => {
  const a = anchor.value
  if (view.value === 'day') return [a, a]
  if (view.value === 'week') {
    const days = weekDates(a)
    return [days[0]!, days[6]!]
  }
  return [startOfMonth(a), endOfMonth(a)]
})

const periodLabel = computed(() => {
  const a = anchor.value
  if (view.value === 'day') return fmtDateCn(a)
  if (view.value === 'week') {
    const days = weekDates(a)
    const [s, e] = [days[0]!, days[6]!]
    return `${fmtDateCn(s).replace(/ 周.$/, '')} – ${fmtDateCn(e).replace(/ 周.$/, '')}`
  }
  const d = new Date(a)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
})

const isThisPeriod = computed(() => {
  const t = todayStr()
  const [from, to] = range.value
  return t >= from && t <= to
})

/** 学期是否真的落在当前浏览区间内 —— 区间外不必提示“没课”，那只是寒假/暑假 */
const semesterCovers = computed(() => {
  const s = store.semester
  if (!s) return false
  const [from, to] = range.value
  return from <= s.endDate && to >= s.startDate
})

const showEmpty = computed(() => !store.hasAccount)
const showNoData = computed(() => store.hasAccount && store.entries.length === 0)

async function reload(): Promise<void> {
  const [from, to] = range.value
  await store.loadRange(from, to)
}

function step(dir: -1 | 1): void {
  const a = anchor.value
  if (view.value === 'day') anchor.value = addDays(a, dir)
  else if (view.value === 'week') anchor.value = addDays(a, dir * 7)
  else anchor.value = addMonths(a, dir)
}

function goToday(): void {
  anchor.value = todayStr()
}

function goDay(date: string): void {
  anchor.value = date
  view.value = 'day'
}

async function onSync(): Promise<void> {
  try {
    const r = await store.sync()
    await reload()
    const extra = r.skippedActivities > 0 ? `（${r.skippedActivities} 条考试/非排课已跳过）` : ''
    toast.toast(`${r.semesterName}：${r.courses} 门课 / ${r.sessions} 个时段${extra}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失败'
    // 会话过期且自动重登也没成（多半是没存密码）：直接把入口递到手上，
    // 而不是丢一句「请重新登录」让用户自己找路
    if (isSessionLostMessage(msg)) {
      toast.toast(msg, {
        action: { label: '去重新登录', run: () => void router.push({ name: 'campus-settings' }) },
      })
    } else {
      toast.toast(msg)
    }
  }
}

onMounted(async () => {
  await store.init()
  await reload()
})

watch([view, anchor], reload)
</script>

<template>
  <div class="page">
    <PageHeader title="我的课表" :subtitle="store.headerSubtitle" back>
      <template #action>
        <button
          class="hdr-btn"
          :disabled="store.syncing || !store.hasAccount"
          aria-label="同步课程"
          @click="onSync"
        >
          <RefreshCw :size="19" :class="{ spin: store.syncing }" />
        </button>
        <button class="hdr-btn" aria-label="课表配置与设置" @click="router.push({ name: 'campus-settings' })">
          <Settings2 :size="19" />
        </button>
      </template>
    </PageHeader>

    <!-- 空态：还没绑定学校教务系统 -->
    <EmptyState
      v-if="showEmpty"
      :icon="CalendarOff"
      title="还没有课表数据"
      hint="绑定学校教务系统后，课表会自动同步到这里，并写进时间线"
    >
      <template #action>
        <button class="cta" @click="router.push({ name: 'campus-settings' })">去配置</button>
      </template>
    </EmptyState>

    <template v-else>
      <div class="bar">
        <SegmentedControl v-model="view" :options="viewOptions" class="seg" />
        <div class="nav">
          <button class="nv" aria-label="上一段" @click="step(-1)">
            <ChevronLeft :size="17" :stroke-width="2.4" />
          </button>
          <button class="label" :disabled="isThisPeriod" @click="goToday">
            {{ periodLabel }}
          </button>
          <button class="nv" aria-label="下一段" @click="step(1)">
            <ChevronRight :size="17" :stroke-width="2.4" />
          </button>
        </div>
      </div>

      <EmptyState
        v-if="showNoData"
        :icon="CalendarX2"
        :title="semesterCovers ? '这段时间没有课' : '不在本学期内'"
        :hint="semesterCovers ? '换个日期看看，或者回本周' : `当前学期：${store.semester?.name ?? '未设置'}`"
      >
        <template #action>
          <button class="cta" @click="goToday">回到今天</button>
        </template>
      </EmptyState>

      <ScheduleDayView v-else-if="view === 'day'" :entries="store.entries" :date="anchor" />
      <ScheduleWeekView
        v-else-if="view === 'week'"
        :entries="store.entries"
        :time-slots="store.timeSlots"
        :anchor="anchor"
      />
      <ScheduleMonthView v-else :entries="store.entries" :anchor="anchor" @select="goDay" />

      <!-- 课表下方的常驻入口。
           放在这里而不是只留在「课表配置」里：这两个是**学期尺度**的东西
           （培养方案看四年、抢课看这一两周），用户想起它们的时候多半正看着课表，
           而不是在配置页里找开关。 -->
      <nav class="links">
        <button class="link-row" @click="router.push({ name: 'campus-course-select' })">
          <i class="pic grab"><Zap :size="17" /></i>
          <span class="col flex-1">
            <b>选课 · 抢课</b>
            <em class="t-3">排好任务单，到点自动抢</em>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
        <button class="link-row" @click="router.push({ name: 'campus-program' })">
          <i class="pic prog"><GraduationCap :size="17" /></i>
          <span class="col flex-1">
            <b>培养方案与学分</b>
            <em class="t-3">学分完成度、课程清单</em>
          </span>
          <ChevronRight :size="16" class="t-3" />
        </button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ---------- 课表下方的常驻入口 ---------- */
.links {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.link-row:active {
  transform: scale(0.985);
}

.links .pic {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
}

.links .pic.grab {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.links .pic.prog {
  color: var(--cat-study, var(--accent));
  background: color-mix(in srgb, var(--cat-study, var(--accent)) 12%, transparent);
}

.links b {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
}

.links em {
  font-size: var(--fs-micro);
  font-style: normal;
  margin-top: 1px;
}

.seg {
  flex: none;
  width: 132px;
}

.nav {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-card);
  padding: 2px;
  min-width: 0;
}

.nv {
  flex: none;
  width: 30px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.nv:active {
  transform: scale(0.9);
}

.label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.label:disabled {
  color: var(--accent);
}

.cta {
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: 8px 22px;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.cta:active {
  transform: scale(0.95);
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation-duration: 2.4s;
  }
}
</style>
