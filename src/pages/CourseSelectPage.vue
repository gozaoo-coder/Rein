<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronLeft,
  CircleCheck,
  ExternalLink,
  Hourglass,
  Info,
  RefreshCw,
  Search,
  Settings2,
  Zap,
} from 'lucide-vue-next'

import GrabPanel from '@/components/campus/GrabPanel.vue'
import GrabSettingsSheet from '@/components/campus/GrabSettingsSheet.vue'
import GrabSheet from '@/components/campus/GrabSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import { grabStatusMeta, idOf, useCourseSelectStore } from '@/stores/courseSelect'
import type { CourseSelectLesson } from '@/types'

/**
 * 选课（API 直接抢课）。
 *
 * 与课表页的关键区别：课表读的是本地快照，**选课打的是教务的实时接口**，
 * 所以这里的每个动作都是网络请求，且令牌可能过期（过期后会自动去门户重换一张）。
 *
 * 大一新生的选课窗口由教务处统一开放，在那之前批次列表是空的 ——
 * 页面必须把「还没有窗口」讲清楚，而不是显示成故障。
 *
 * **抢课不靠这个页面**：任务单交给 Rust 后台引擎（见 `modules/campus/grab.rs`），
 * 页面只负责「下单」和「看进度」。所以这里既能一键把课排进任务单，
 * 也能整页关掉 —— 引擎照跑。
 */
const store = useCourseSelectStore()
const campus = useCampusStore()
const toast = useToast()

const refresh = ref(false)
const settingsOpen = ref(false)
/**
 * 抽屉里正在配置的教学班 **id**。
 *
 * 存 id 不存对象：自动刷新会整表替换 `store.lessons`，存下来的那个对象会变成一份
 * 没人再更新的孤儿数据 —— 抽屉里的「已选 12 / 30」会停在打开那一刻的旧数字，
 * 而页面上其它地方都是新的。存 id 每次从 store 取，两边永远同源。
 */
const sheetLessonId = ref<string | null>(null)
const sheetLesson = computed<CourseSelectLesson | null>(() => {
  const id = sheetLessonId.value
  if (id == null) return null
  return store.lessons.find((l) => idOf(l.id) === id) ?? null
})

const status = computed(() => store.status)
const skew = computed(() => store.clockSkewSec)

/** 偏差超过 30 秒才提示：小偏差是网络往返造成的，不必惊动用户 */
const skewWarning = computed(() => {
  const s = skew.value
  if (s == null || Math.abs(s) < 30) return ''
  return s > 0
    ? `教务服务器比你本机快 ${s} 秒，抢课时以服务器时间为准`
    : `教务服务器比你本机慢 ${-s} 秒，抢课时以服务器时间为准`
})

function lessonName(l: CourseSelectLesson): string {
  return l.course?.nameZh || l.course?.nameEn || '（教务未给课程名）'
}

function lessonCode(l: CourseSelectLesson): string {
  return l.course?.code ?? ''
}

function picked(l: CourseSelectLesson): boolean {
  return l.selectedLesson != null
}

function seatText(l: CourseSelectLesson): string {
  const a = l.stdCount
  const b = l.limitCount
  if (a == null && b == null) return ''
  return `${a ?? '?'} / ${b ?? '?'}`
}

/** 已满：有上限且已选人数达到上限 */
function full(l: CourseSelectLesson): boolean {
  return l.limitCount != null && l.stdCount != null && l.stdCount >= l.limitCount
}

/** 这门课在抢课任务单里的状态（没有则 null） */
function grabChip(l: CourseSelectLesson): { label: string; tone: string } | null {
  const t = store.taskFor(l)
  if (!t) return null
  return grabStatusMeta(t)
}

async function onRefresh(): Promise<void> {
  refresh.value = true
  try {
    await store.loadStatus()
    lastStatusAt = Date.now()
    if (store.activeTurn) {
      await store.loadLessons()
      lastLessonsAt = Date.now()
    }
    autoAt.value = new Date()
  } finally {
    refresh.value = false
  }
  // 任务单是旁路：它自己会被引擎的事件推着更新，**不该拖着刷新按钮一起等** ——
  // 让用户抢课途中按第二下没反应，比少刷新一次任务单糟得多
  void store.refreshGrab()
}

async function onSearch(): Promise<void> {
  try {
    await store.loadLessons()
    lastLessonsAt = Date.now()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '查询教学班失败')
  }
}

async function onEnter(turnId: unknown): Promise<void> {
  const turn = store.turns.find((t) => idOf(t.id) === idOf(turnId))
  if (!turn) return
  store.enterTurn(turn)
  try {
    await store.loadLessons()
    lastLessonsAt = Date.now()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '查询教学班失败')
  }
}

function openSheet(l: CourseSelectLesson): void {
  if (picked(l)) return
  sheetLessonId.value = idOf(l.id)
}

/* ---------------- 批量预定 ----------------
 * 「多个抢课任务」在引擎里本来就是一行一条，缺的是**一次把它们排好**的入口：
 * 一门课挂着 5 个教学班时，逐个点开抽屉加 5 遍，还得自己记住谁排第几。
 *
 * 勾选顺序**就是**志愿顺序 —— 所以这里用数组而不是 Set。
 */
const selectMode = ref(false)
const selectedIds = ref<string[]>([])
const batchOpen = ref(false)
const batchSquad = ref(false)
const batchPriority = ref(1)

const selectedLessons = computed(() =>
  selectedIds.value
    .map((id) => store.lessons.find((l) => idOf(l.id) === id))
    .filter((l): l is CourseSelectLesson => !!l),
)

function toggleSelect(l: CourseSelectLesson): void {
  const id = idOf(l.id)
  const i = selectedIds.value.indexOf(id)
  if (i >= 0) selectedIds.value.splice(i, 1)
  else selectedIds.value.push(id)
}

function exitSelect(): void {
  selectMode.value = false
  selectedIds.value = []
  batchOpen.value = false
}

function openBatch(): void {
  if (!selectedLessons.value.length) return
  // 选了两门以上，多半就是「同一门课的备选」或「时间冲突的几门」—— 默认按志愿组排
  batchSquad.value = selectedLessons.value.length > 1
  batchPriority.value = 1
  batchOpen.value = true
}

async function confirmBatch(): Promise<void> {
  const lessons = selectedLessons.value
  if (!lessons.length) return
  const squad = batchSquad.value
  try {
    const key = squad
      ? (globalThis.crypto?.randomUUID?.() ?? `g-${Date.now().toString(36)}`)
      : null
    const name = squad
      ? (lessons[0]?.course?.nameZh ?? lessons[0]?.course?.nameEn ?? '志愿组')
      : null
    const n = await store.enqueue(lessons, {
      groupKey: key,
      groupName: name,
      priority: batchPriority.value,
    })
    exitSelect()
    toast.toast(
      n
        ? squad
          ? `已排入志愿组：${n} 个志愿，同组只会中一个`
          : `已预定 ${n} 门课，到点自动开抢`
        : '没有加入任何课程',
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '加入抢课失败')
  }
}

/* ---------------- 自动刷新 ----------------
 * 抢课这件事上「界面旧了」是有代价的：窗口开放、名额释放都发生在你没点按钮的时候。
 * 所以批次和教学班都自己刷，手动按钮只留作「我现在就想刷一次」的出口。
 *
 * 节奏是权衡出来的：批次 60s 一次（那三个接口很轻），教学班 30s 一次
 * （批次开着的时候名额才是活的，但一次要拉一批教学班，别太频繁）。
 */
const STATUS_EVERY_MS = 60_000
const LESSONS_EVERY_MS = 30_000
const TICK_MS = 15_000

const autoAt = ref<Date | null>(null)
let ticker: number | null = null
let lastStatusAt = 0
let lastLessonsAt = 0

const autoText = computed(() => {
  const t = autoAt.value
  if (!t) return '开启中…'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
})

/** 有请求在飞、或正在提交，就别插队 —— 叠请求既浪费也容易把令牌撞出 401 */
function autoBusy(): boolean {
  return store.loading || store.lessonsLoading || store.submitting != null || store.grabBusy
}

async function autoRefresh(force = false): Promise<void> {
  if (autoBusy()) return
  const now = Date.now()
  try {
    if (force || now - lastStatusAt >= STATUS_EVERY_MS) {
      lastStatusAt = now
      await store.loadStatus()
    }
    if (store.activeTurn && (force || now - lastLessonsAt >= LESSONS_EVERY_MS)) {
      lastLessonsAt = now
      await store.loadLessons()
    }
    autoAt.value = new Date()
  } catch {
    // 自动刷新失败不打扰用户：store.error 会显示，下一次成功再把它抹掉
  }
}

function tick(): void {
  // 后台标签页的定时器会被 WebView 节流（普遍降到 1 次/分钟），
  // 与其按一个不准的节拍空打教务，不如等切回来时补一次
  if (document.hidden) return
  void autoRefresh()
}

/** 切回前台立刻补一次 —— 这比定时器值钱，也是「不用手点刷新」真正好用的地方 */
function onVisible(): void {
  if (document.hidden) return
  void autoRefresh(true)
}

function onFocus(): void {
  void autoRefresh(true)
}

/** 「加入抢课」：交给后台引擎持续重试 */
async function onGrab(payload: {
  mode: 'predicate' | 'direct'
  virtualCost: number
  scheduleGroupId: unknown
  groupKey: string | null
  groupName: string | null
  priority: number
}): Promise<void> {
  const lesson = sheetLesson.value
  if (!lesson) return
  try {
    const n = await store.enqueue([lesson], {
      mode: payload.mode,
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
      scheduleGroupId: payload.scheduleGroupId,
      groupKey: payload.groupKey,
      groupName: payload.groupName,
      priority: payload.priority,
    })
    sheetLessonId.value = null
    toast.toast(
      n
        ? payload.groupKey
          ? `已加入志愿组（第 ${payload.priority} 志愿），同组只会中一个`
          : '已加入抢课任务，到点自动开抢'
        : '没有加入任何课程',
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '加入抢课失败')
  }
}

/** 「立即试一次」：一次性提交并等结果 */
async function onApply(payload: { virtualCost: number }): Promise<void> {
  const lesson = sheetLesson.value
  if (!lesson) return
  try {
    const msg = await store.apply(lesson, {
      virtualCost: payload.virtualCost > 0 ? payload.virtualCost : null,
    })
    sheetLessonId.value = null
    toast.toast(msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '选课失败')
  }
}

onMounted(async () => {
  await campus.init()
  if (!campus.hasAccount) {
    toast.toast('还没有绑定教务系统账号，请先到「课表配置」登录')
    return
  }
  await store.loadStatus()
  lastStatusAt = Date.now()
  // 任务单与引擎推送是全局的：进页面就接上，这次看到的进度和上次关页面时是连贯的
  await store.attachGrab()

  ticker = window.setInterval(tick, TICK_MS)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onFocus)
})

onBeforeUnmount(() => {
  if (ticker != null) window.clearInterval(ticker)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('focus', onFocus)
  exitSelect()
  store.detachGrab()
})
</script>

<template>
  <div class="page">
    <PageHeader
      :title="store.activeTurn ? '选择教学班' : '选课'"
      :subtitle="store.activeTurn ? String(store.activeTurn.name ?? '') : '直连教务选课接口'"
      back
    >
      <template #action>
        <button class="hdr-btn" aria-label="抢课节奏设置" @click="settingsOpen = true">
          <Settings2 :size="19" />
        </button>
        <button class="hdr-btn" :disabled="refresh" aria-label="立即刷新" title="立即刷新" @click="onRefresh">
          <RefreshCw :size="19" :class="{ spin: refresh }" />
        </button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="!campus.hasAccount"
      :icon="AlertTriangle"
      title="还没有绑定教务系统账号"
      hint="选课要用教务的登录态换令牌，先去「课表配置」登录一次"
    >
      <template #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去配置</RouterLink>
      </template>
    </EmptyState>

    <!-- 会话过期时给一条明确的路：选课令牌是拿教务会话换来的，重登一次即可恢复 -->
    <EmptyState
      v-else-if="store.error"
      :icon="AlertTriangle"
      :title="store.error"
      :hint="isSessionLostMessage(store.error) ? '选课令牌要用教务登录态换取，重新登录一次就能恢复' : '下拉刷新或稍后再试'"
    >
      <template v-if="isSessionLostMessage(store.error)" #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去重新登录</RouterLink>
      </template>
    </EmptyState>

    <template v-else>
      <!-- 服务器时间：抢课对时全靠它 -->
      <section class="card stat">
        <div class="row">
          <CalendarClock :size="16" />
          <span class="k">教务服务器时间</span>
          <span class="v num">{{ store.serverTime || '—' }}</span>
        </div>
        <div v-if="status?.studentCode" class="row">
          <CircleCheck :size="16" class="ok" />
          <span class="k">账号</span>
          <span class="v">{{ status.studentName ?? '' }} {{ status.studentCode }}</span>
        </div>
        <!-- 自动刷新的节拍是看得见的：不然「数字怎么自己变了」比「数字旧了」更让人不安 -->
        <div class="row">
          <RefreshCw :size="16" />
          <span class="k">自动刷新</span>
          <span class="v num">{{ autoText }}</span>
        </div>
        <p v-if="skewWarning" class="warn">
          <AlertTriangle :size="14" /> {{ skewWarning }}
        </p>
      </section>

      <!-- 抢课任务单：全局的，批次列表与教学班列表下都看得到 -->
      <GrabPanel />

      <!-- 批次列表 -->
      <template v-if="!store.activeTurn">
        <EmptyState
          v-if="!store.hasTurn"
          :icon="Hourglass"
          title="当前没有开放的选课批次"
          hint="选课窗口由教务处统一开放。开放后这里会自动出现批次，进来就能一键选课。"
        >
          <template #action>
            <a v-if="status?.entryUrl" class="cta ghost" :href="status.entryUrl" target="_blank" rel="noreferrer">
              打开官方选课页 <ExternalLink :size="14" />
            </a>
          </template>
        </EmptyState>

        <section v-for="t in store.turns" :key="idOf(t.id)" class="card turn">
          <div class="turn-head">
            <h2>{{ t.name ?? '选课批次' }}</h2>
            <span class="tag" :class="{ open: t.allowEnter }">
              {{ t.allowEnter ? '可进入' : '未开放' }}
            </span>
          </div>

          <p v-if="t.selectDateTimeText" class="line">选课时间：{{ t.selectDateTimeText }}</p>
          <p v-if="t.dropDateTimeText" class="line">退课时间：{{ t.dropDateTimeText }}</p>

          <ul v-if="t.disallowReasons?.length" class="reasons">
            <li v-for="(r, i) in t.disallowReasons" :key="i">{{ r }}</li>
          </ul>

          <p v-if="t.bulletin" class="bulletin">{{ t.bulletin }}</p>

          <button class="primary" :disabled="!t.allowEnter" @click="onEnter(t.id)">
            {{ t.allowEnter ? '进入选课' : '尚未开放' }}
          </button>
        </section>
      </template>

      <!-- 教学班列表 -->
      <template v-else>
        <button class="back-row" @click="store.leaveTurn(); exitSelect()">
          <ChevronLeft :size="16" /> 返回批次列表
        </button>

        <div class="search">
          <Search :size="15" />
          <input
            v-model="store.keyword"
            type="search"
            placeholder="搜索课程名或代码"
            @keyup.enter="onSearch"
          />
          <button class="go" :disabled="store.lessonsLoading" @click="onSearch">
            {{ store.lessonsLoading ? '…' : '查询' }}
          </button>
        </div>

        <div class="pick-bar">
          <button class="mini" :class="{ on: selectMode }" @click="selectMode ? exitSelect() : (selectMode = true)">
            {{ selectMode ? '退出多选' : '多选预定' }}
          </button>
          <span v-if="selectMode" class="t-3 count">已选 {{ selectedIds.length }}</span>
          <button v-if="selectMode" class="mini primary-mini" :disabled="!selectedIds.length" @click="openBatch">
            加入抢课
          </button>
        </div>

        <p v-if="store.progress" class="progress">{{ store.progress }}</p>

        <EmptyState
          v-if="!store.lessonsLoading && store.lessons.length === 0"
          :icon="Search"
          title="没有查到教学班"
          hint="换个关键字试试，或清空搜索看全部"
        />

        <ul v-else class="lessons" :class="{ picking: selectMode }">
          <li
            v-for="l in store.lessons"
            :key="idOf(l.id)"
            class="lesson"
            :class="{ sel: selectMode && selectedIds.includes(idOf(l.id)) }"
          >
            <!-- 点整行开抽屉（选「上课小组 / 意愿值 / 志愿组」的地方）；多选模式下改成勾选 -->
            <button
              class="l-main"
              :disabled="picked(l) && !selectMode"
              @click="selectMode ? toggleSelect(l) : openSheet(l)"
            >
              <span class="l-top">
                <span v-if="selectMode" class="tick" :class="{ on: selectedIds.includes(idOf(l.id)) }" />
                <span class="l-name">{{ lessonName(l) }}</span>
                <span v-if="picked(l)" class="chip ok">已选</span>
                <span v-else-if="full(l)" class="chip bad">已满</span>
              </span>
              <span class="l-meta">
                <span v-if="lessonCode(l)" class="num">{{ lessonCode(l) }}</span>
                <span v-if="l.course?.credits != null">{{ l.course.credits }} 学分</span>
                <span v-if="seatText(l)" class="num">已选 {{ seatText(l) }}</span>
                <span v-if="selectMode && selectedIds.includes(idOf(l.id))" class="num ord">
                  第 {{ selectedIds.indexOf(idOf(l.id)) + 1 }} 志愿
                </span>
              </span>
              <span v-if="l.scheduleGroups?.length" class="l-meta dim">
                {{ l.scheduleGroups.length }} 个上课小组
              </span>
            </button>

            <!-- 已在任务单里：显示引擎给的状态，而不是再给一个按钮 -->
            <span
              v-if="grabChip(l) && !selectMode"
              class="chip grab"
              :class="grabChip(l)!.tone"
            >{{ grabChip(l)!.label }}</span>
            <button
              v-else-if="!selectMode"
              class="pick"
              :disabled="picked(l) || store.grabBusy"
              @click="openSheet(l)"
            >
              <template v-if="picked(l)"><Check :size="14" /> 已选</template>
              <template v-else><Zap :size="14" /> 抢课</template>
            </button>
          </li>
        </ul>
      </template>
    </template>

    <GrabSheet
      :open="!!sheetLesson"
      :lesson="sheetLesson"
      :allow-enter="!!store.activeTurn?.allowEnter"
      :busy="store.grabBusy || !!store.submitting"
      @close="sheetLessonId = null"
      @grab="onGrab"
      @apply="onApply"
    />

    <GrabSettingsSheet :open="settingsOpen" @close="settingsOpen = false" />

    <!-- 批量预定：一次把多个教学班排好次序交给引擎 -->
    <SheetModal :open="batchOpen" title="批量预定" initial-snap="medium" @close="batchOpen = false">
      <p class="lead t-2">
        选中 <b>{{ selectedLessons.length }}</b> 个教学班。<b>勾选顺序就是志愿顺序</b>，
        可以直接在列表里再点几下调整。
      </p>

      <SegmentedControl
        :model-value="batchSquad ? 'squad' : 'solo'"
        :options="[
          { value: 'solo', label: '各抢各的' },
          { value: 'squad', label: '排成志愿组' },
        ]"
        @update:model-value="batchSquad = $event === 'squad'"
      />

      <p v-if="batchSquad" class="hint">
        <Info :size="13" />
        <span>
          同组<b>互斥</b>：只会中一个，中选后其余自动取消。同一门课的多个教学班、
          或时间冲突的几门课，都该排进一组。
        </span>
      </p>
      <p v-else class="hint">
        <Info :size="13" /> 各抢各的：互不干扰，适合时间不冲突、想全都要的几门课。
      </p>

      <NumberStepper
        v-if="batchSquad"
        v-model="batchPriority"
        :min="1"
        :max="20"
        :step="1"
        label="起始志愿序"
      />

      <ol class="batch-list">
        <li v-for="(l, i) in selectedLessons" :key="idOf(l.id)">
          <span class="tag-mini">{{ batchSquad ? `第 ${batchPriority + i}` : '独立' }}</span>
          <span class="flex-1">{{ lessonName(l) }}</span>
          <span v-if="lessonCode(l)" class="t-3 num">{{ lessonCode(l) }}</span>
        </li>
      </ol>

      <div class="acts">
        <button class="primary" :disabled="store.grabBusy || !selectedLessons.length" @click="confirmBatch">
          <Zap :size="16" />
          加入抢课（{{ selectedLessons.length }}）
        </button>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}

.card {
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  padding: 16px;
  margin-bottom: 14px;
}

/* ---------- 服务器时间 ---------- */
.stat {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
}

.row .k {
  font-size: var(--fs-caption);
  flex: none;
}

.row .v {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
  margin-left: auto;
}

.ok {
  color: var(--ok);
}

.num {
  font-variant-numeric: tabular-nums;
}

.warn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--warn);
  line-height: 1.4;
}

/* ---------- 批次 ---------- */
.turn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.turn-head h2 {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
}

.tag {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
}

.tag.open {
  background: var(--accent-soft);
  color: var(--accent);
}

.line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}

.reasons {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: var(--fs-micro);
  color: var(--warn);
  line-height: 1.5;
}

.bulletin {
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.5;
  white-space: pre-wrap;
}

.primary {
  width: 100%;
  margin-top: 14px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.985);
}

.primary:disabled {
  opacity: 0.45;
}

/* ---------- 空态出口 ---------- */
.cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: 9px 22px;
}

.cta.ghost {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ---------- 教学班 ---------- */
.back-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
  padding: 2px 0 10px;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-3);
  margin-bottom: 10px;
}

.search input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  background: none;
}

.go {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
  padding: 2px 8px;
}

.go:disabled {
  opacity: 0.5;
}

.progress {
  font-size: var(--fs-micro);
  color: var(--accent);
  margin-bottom: 8px;
}

.lessons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lesson {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.l-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}

.l-main:disabled {
  opacity: 0.6;
}

.l-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.l-name {
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
  word-break: break-all;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
}

.chip.ok {
  color: var(--ok);
  background: var(--ok-soft);
}

.chip.bad {
  color: var(--danger);
  background: var(--danger-soft);
}

.chip.grab {
  color: var(--accent);
  background: var(--accent-soft);
}

.chip.grab.ok {
  color: var(--ok);
  background: var(--ok-soft);
}

.chip.grab.warn {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}

.chip.grab.bad {
  color: var(--danger);
  background: var(--danger-soft);
}

.chip.grab.idle {
  color: var(--text-3);
  background: var(--surface-2);
}

.l-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: var(--fs-micro);
  color: var(--text-2);
}

.l-meta.dim {
  color: var(--text-3);
}

.pick {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 8px 15px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.pick:active {
  transform: scale(0.94);
}

.pick:disabled {
  background: var(--surface-2);
  color: var(--text-3);
}

.spin {
  animation: spin 0.9s linear infinite;
}

/* ---------- 多选预定 ---------- */
.pick-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.mini {
  flex: none;
  padding: 6px 13px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.mini.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.mini.primary-mini {
  background: var(--accent);
  color: var(--on-accent);
  margin-left: auto;
}

.mini:disabled {
  opacity: 0.4;
}

.count {
  font-size: var(--fs-caption);
}

/* 选中态要一眼看得出，而且要看得出**排第几** —— 顺序就是志愿序 */
.lesson.sel {
  background: var(--accent-soft);
}

.tick {
  position: relative;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
}

.tick.on {
  border-color: var(--accent);
}

/* 实心点与 GrabSheet 的「上课小组」单选保持同一套视觉语言 */
.tick.on::after {
  content: '';
  position: absolute;
  inset: 3.5px;
  border-radius: 50%;
  background: var(--accent);
}

.l-meta .ord {
  color: var(--accent);
  font-weight: 700;
}

/* ---------- 批量预定抽屉 ---------- */
.lead {
  font-size: var(--fs-caption);
  line-height: 1.55;
  margin-bottom: 12px;
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.5;
  margin: 8px 0;
}

.hint svg {
  flex: none;
  margin-top: 2px;
}

.batch-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.batch-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.tag-mini {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
}

.flex-1 {
  flex: 1;
  min-width: 0;
}

.acts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.acts .primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 0;
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
