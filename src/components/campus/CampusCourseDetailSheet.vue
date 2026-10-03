<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CalendarDays, MapPin, RefreshCw, User } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { campusService } from '@/services/campusService'
import type { CourseDetail } from '@/types'

/**
 * 教务课程详情抽屉。
 *
 * 与 `CourseDetailSheet`（课表派生行的本地只读）是两回事：这一份的数据**每次打开
 * 现拉**，字段直接对齐教务「课程详情」页 —— 容量/已选人数在选课期是活的，
 * 缓存一份「51/52」下一秒就可能过时，所以详情不落库、不缓存。
 *
 * 生命周期（动画与请求必须对齐）：
 * - 打开 / 换课时发起请求，带自增 token；关闭时 token 立刻失效，
 *   挂钩中的旧响应回来会被丢弃，不会在下次打开时「诈尸」把内容盖回旧课；
 * - 关闭期间**保留上一份 detail**：抽屉是滑出而非瞬隐，内容若在同一帧清空，
 *   滑出过程会看到正文塌成空白。数据由下一次成功响应替换。
 */
const props = defineProps<{
  open: boolean
  semesterId: number | null
  /** **远端教学班 id**（`CampusCourse.remoteLessonId`），不是本地 `campus_courses.id` */
  lessonId: number | null
  weekday?: number | null
  startUnit?: number | null
  /** 首帧、慢网时先顶上课程名，别让标题空着 */
  fallbackCourseName?: string
}>()

const emit = defineEmits<{ close: [] }>()

const detail = ref<CourseDetail | null>(null)
const loading = ref(false)
const error = ref('')
/** 请求序号：只认最后一次发出的那个，迟到响应一律丢弃 */
let token = 0

async function load(): Promise<void> {
  const { semesterId, lessonId, weekday, startUnit } = props
  if (!props.open || semesterId == null || lessonId == null) return
  const t = ++token
  loading.value = true
  error.value = ''
  try {
    const d = await campusService.courseDetail({ semesterId, lessonId, weekday, startUnit })
    if (t !== token) return
    detail.value = d
  } catch (e) {
    if (t !== token) return
    detail.value = null
    error.value = e instanceof Error ? e.message : '课程详情获取失败'
  } finally {
    if (t === token) loading.value = false
  }
}

watch(
  () => [props.open, props.semesterId, props.lessonId, props.weekday, props.startUnit] as const,
  () => {
    if (!props.open) {
      // 关闭即作废在途请求，并落掉 spinner；detail 留着给离场动画
      token++
      loading.value = false
      return
    }
    void load()
  },
  { immediate: true },
)

/* ---------- 展示层：把远端数据摊成「标签 → 值」的两段清单 ---------- */

const DASH = '—'
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日']

interface Field {
  k: string
  v: string
  /** 长文本（院系 / 专业 / 教室别名…）独占整行 */
  wide?: boolean
}

/** null / 空串统一落成占位符，界面不留空洞 */
function s(v: string | number | null | undefined): string {
  const t = v == null ? '' : String(v).trim()
  return t === '' ? DASH : t
}

const name = computed(() => detail.value?.courseName ?? props.fallbackCourseName ?? '课程详情')

const chips = computed(() =>
  [detail.value?.courseTypeName, detail.value?.examCategory].filter((x): x is string => !!x),
)

const place = computed(() => {
  const d = detail.value
  if (!d) return ''
  return [d.room, d.roomAlias].filter(Boolean).join(' · ')
})

const scheduleFields = computed<Field[]>(() => {
  const d = detail.value
  if (!d) return []
  const wd = d.weekday >= 1 && d.weekday <= 7 ? `周${WEEK_CN[d.weekday - 1]}` : DASH
  return [
    { k: '教室', v: s(d.room) },
    { k: '教室别名', v: s(d.roomAlias), wide: true },
    { k: '开始时间', v: s(d.startTime) },
    { k: '结束时间', v: s(d.endTime) },
    { k: '开始小节', v: s(d.startUnit) },
    { k: '结束小节', v: s(d.endUnit) },
    { k: '大节节次', v: d.bigSection > 0 ? `第 ${d.bigSection} 大节` : DASH },
    { k: '开始周', v: s(d.startWeek) },
    { k: '结束周', v: s(d.endWeek) },
    { k: '星期', v: wd },
    { k: '课程备注', v: s(d.remark) === DASH ? '无备注' : s(d.remark), wide: true },
  ]
})

const infoFields = computed<Field[]>(() => {
  const d = detail.value
  if (!d) return []
  return [
    { k: '课号', v: s(d.lessonCode) },
    { k: '课程代码', v: s(d.courseCode) },
    { k: '课程类型', v: s(d.courseTypeCode) },
    { k: '类型名称', v: s(d.courseTypeName) },
    { k: '考试类别', v: s(d.examCategory) },
    { k: '考试方式', v: s(d.examType) },
    { k: '课程属性', v: s(d.courseProperty) },
    { k: '开课院系', v: s(d.openDepartment), wide: true },
    { k: '学分', v: s(d.credits) },
    { k: '年级', v: s(d.grade) },
    { k: '专业名称', v: s(d.major), wide: true },
    { k: '学期名称', v: s(d.semesterName) },
    { k: '实验课', v: d.hasExperiment ? '是' : '否' },
    { k: '实验批次', v: s(d.experimentBatch) },
    { k: '实验批次号', v: s(d.experimentBatchNo) },
    { k: '实验名称', v: s(d.experimentName), wide: true },
    { k: '教学班', v: s(d.lessonName), wide: true },
    { k: '课程说明', v: s(d.description), wide: true },
  ]
})

const periodFields = computed<Field[]>(() => {
  const p = detail.value?.period
  if (!p) return []
  return [
    { k: '总学时', v: s(p.total) },
    { k: '周学时', v: s(p.weeks) },
    { k: '理论', v: s(p.theory) },
    { k: '实践', v: s(p.practice) },
    { k: '测验', v: s(p.test) },
    { k: '实验', v: s(p.experiment) },
    { k: '上机', v: s(p.machine) },
    { k: '设计', v: s(p.design) },
    { k: '其他', v: s(p.extra) },
  ]
})

/** 已选/容量占比：满员时给一个明确的视觉信号 */
const fillPct = computed<number | null>(() => {
  const c = detail.value?.capacity ?? null
  const e = detail.value?.enrolled ?? null
  if (c == null || c <= 0 || e == null) return null
  return Math.max(0, Math.min(100, Math.round((e / c) * 100)))
})

const enrolledText = computed(() => `${detail.value?.enrolled ?? DASH} / ${detail.value?.capacity ?? DASH}`)
</script>

<template>
  <SheetModal :open="open" :title="name" initial-snap="large" @close="emit('close')">
    <!-- 加载态：首帧没有可展示的旧数据时给骨架，避免抽屉里一片空 -->
    <div v-if="loading" class="skeleton" aria-busy="true">
      <div class="sk sk-hero" />
      <div class="sk sk-line" />
      <div class="sk sk-line" />
      <div class="sk sk-line short" />
      <div class="sk sk-line" />
      <div class="sk sk-line short" />
    </div>

    <!-- 失败态：把后端原话端上来，给一条重试 -->
    <div v-else-if="error" class="fail">
      <p class="fail-msg">{{ error }}</p>
      <button class="retry" @click="load">
        <RefreshCw :size="15" /> 重试
      </button>
    </div>

    <div v-else-if="detail" class="detail">
      <!-- 概况：名称 + 标签 + 一眼要素 -->
      <div class="hero">
        <div class="hero-top">
          <h3>{{ detail.courseName }}</h3>
          <span v-for="c in chips" :key="c" class="chip">{{ c }}</span>
        </div>

        <div class="quick">
          <span v-if="detail.teachers.length" class="qi">
            <User :size="13" /> {{ detail.teachers.join('、') }}
          </span>
          <span v-if="place" class="qi"><MapPin :size="13" /> {{ place }}</span>
          <span v-if="detail.weeksStr" class="qi">
            <CalendarDays :size="13" /> 第 {{ detail.weeksStr }} 周
          </span>
        </div>

        <div v-if="fillPct !== null" class="cap">
          <div class="cap-row">
            <span>已选 / 容量</span>
            <b class="num">{{ enrolledText }}</b>
          </div>
          <div class="cap-bar">
            <i :style="{ width: `${fillPct}%` }" :class="{ full: fillPct >= 100 }" />
          </div>
        </div>
      </div>

      <section class="sec">
        <h4>排课信息</h4>
        <dl class="facts">
          <div v-for="f in scheduleFields" :key="f.k" :class="{ wide: f.wide }">
            <dt>{{ f.k }}</dt>
            <dd class="num" :class="{ dash: f.v === DASH }">{{ f.v }}</dd>
          </div>
        </dl>
      </section>

      <section class="sec">
        <h4>课程信息</h4>
        <dl class="facts">
          <div v-for="f in infoFields" :key="f.k" :class="{ wide: f.wide }">
            <dt>{{ f.k }}</dt>
            <dd :class="{ dash: f.v === DASH }">{{ f.v }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="periodFields.length" class="sec">
        <h4>学时构成</h4>
        <dl class="facts compact">
          <div v-for="f in periodFields" :key="f.k">
            <dt>{{ f.k }}</dt>
            <dd class="num" :class="{ dash: f.v === DASH }">{{ f.v }}</dd>
          </div>
        </dl>
      </section>

      <p class="src">数据取自教务系统课表，容量与已选人数为实时值。</p>
    </div>
  </SheetModal>
</template>

<style scoped>
/* ---------- 概况 ---------- */
.hero {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.hero-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.hero-top h3 {
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.3;
  word-break: break-all;
}

.chip {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-full);
  padding: 2px 9px;
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.qi {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.4;
}

/* ---------- 容量 ---------- */
.cap {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cap-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.cap-row b {
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.cap-bar {
  height: 5px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-3) 16%, transparent);
  overflow: hidden;
}

.cap-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-standard);
}

.cap-bar i.full {
  background: var(--warn, var(--accent));
}

/* ---------- 字段清单 ---------- */
.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sec h4 {
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.04em;
  padding: 0 2px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border-radius: var(--radius-l);
  overflow: hidden;
  background: var(--line);
}

.facts > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 9px 12px;
  background: var(--surface-2);
  min-width: 0;
}

.facts > div.wide {
  grid-column: 1 / -1;
}

.facts dt {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.45;
}

.facts dd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: 1.45;
  word-break: break-all;
}

.facts dd.num {
  font-variant-numeric: tabular-nums;
}

.facts dd.dash {
  color: var(--text-3);
}

/* 学时构成是纯数字短表，按三列铺 */
.facts.compact {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.facts.compact > div {
  justify-content: space-between;
}

.src {
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.55;
  padding: 0 2px;
}

/* ---------- 骨架 ---------- */
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sk {
  border-radius: var(--radius-m);
  background: linear-gradient(
    100deg,
    var(--surface-2) 30%,
    color-mix(in srgb, var(--text-3) 12%, var(--surface-2)) 50%,
    var(--surface-2) 70%
  );
  background-size: 220% 100%;
  animation: shimmer 1.3s linear infinite;
}

.sk-hero {
  height: 84px;
  border-radius: var(--radius-l);
}

.sk-line {
  height: 38px;
}

.sk-line.short {
  width: 62%;
}

@keyframes shimmer {
  from {
    background-position: 140% 0;
  }
  to {
    background-position: -40% 0;
  }
}

/* ---------- 失败 ---------- */
.fail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 40px 20px;
}

.fail-msg {
  font-size: var(--fs-callout);
  color: var(--text-2);
  text-align: center;
  line-height: 1.5;
}

.retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-radius: var(--radius-full);
  padding: 9px 22px;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.retry:active {
  transform: scale(0.95);
}

/* 窄屏（手机）单列：两列会把「开始时间 / 结束时间」这类值挤到换行 */
@media (max-width: 420px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }

  .facts.compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }

  .cap-bar i {
    transition: none;
  }
}
</style>
