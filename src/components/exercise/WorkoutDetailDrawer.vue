<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { sessionService } from '@/services/sessionService'
import { WORKOUT_META } from '@/config/domain'
import { usePlanStore } from '@/stores/plan'
import { fmtClock, fmtPace } from '@/stores/run'
import { fmtDateCn, minToHHmm } from '@/utils/date'
import { projectTrack, trackAscentM, trackSplits } from '@/utils/geo'
import type { DoneSet, PlanExercise, RunSnapshot, Workout } from '@/types'

/**
 * 运动详情抽屉：按记录来源渲染真实数据。
 *  - 跑步会话（state.kind='run'）：轨迹图 + 距离/配速/爬升 + 每公里分段；
 *  - 训练课会话：逐动作做组明细（重量×次数 / 计时秒）+ 总量统计；
 *  - 手动添加或快照不可用：概要视图（时长 / 强度 / 卡路里 / 时间 / 备注）。
 * 早期快照缺时间戳的轨迹不显示分段；无海拔数据不显示爬升——不做任何虚构。
 */
const props = defineProps<{
  open: boolean
  workout: Workout | null
}>()

defineEmits<{ close: [] }>()

type Detail =
  | { source: 'run'; startedAt: string; snap: RunSnapshot }
  | {
      source: 'course'
      planName: string
      startedAt: string
      doneSets: Record<string, DoneSet[]>
      /** null = 课程已被删除，动作退化为序号展示 */
      exercises: PlanExercise[] | null
    }
  | { source: 'summary'; fromSession: { planName: string; startedAt: string } | null }

const detail = ref<Detail | null>(null)
const loadFailed = ref(false)

watch(
  () => [props.open, props.workout?.id] as const,
  ([open]) => {
    if (!open || !props.workout) {
      detail.value = null
      loadFailed.value = false
      return
    }
    void load(props.workout)
  },
  { immediate: true },
)

async function load(w: Workout): Promise<void> {
  detail.value = null
  loadFailed.value = false
  if (w.sessionId == null) {
    detail.value = { source: 'summary', fromSession: null }
    return
  }
  try {
    const rec = await sessionService.forWorkout(w.id)
    if (!rec || !props.workout || props.workout.id !== w.id) return // 抽屉已切换/关闭
    const st = rec.state as unknown
    if (st && typeof st === 'object' && (st as RunSnapshot).kind === 'run') {
      detail.value = { source: 'run', startedAt: rec.startedAt, snap: st as RunSnapshot }
      return
    }
    if (st && typeof st === 'object' && 'doneSets' in st) {
      const courseState = st as { doneSets?: Record<string, DoneSet[]> }
      let exercises: PlanExercise[] | null = null
      try {
        const planStore = usePlanStore()
        let p = planStore.byId(rec.planId)
        if (!p) await planStore.ensureLoaded()
        p = planStore.byId(rec.planId)
        exercises = p ? p.exercises : null
      } catch {
        exercises = null
      }
      detail.value = {
        source: 'course',
        planName: rec.planName,
        startedAt: rec.startedAt,
        doneSets: courseState.doneSets ?? {},
        exercises,
      }
      return
    }
    detail.value = { source: 'summary', fromSession: { planName: rec.planName, startedAt: rec.startedAt } }
  } catch {
    loadFailed.value = true
  }
}

/* ---------- 公共展示 ---------- */

const typeLabel = computed(() =>
  props.workout ? WORKOUT_META[props.workout.type]?.label ?? props.workout.type : '',
)

const INTENSITY_LABELS = { low: '低强度', moderate: '中等强度', high: '高强度' } as const

const intensityLabel = computed(() =>
  props.workout ? INTENSITY_LABELS[props.workout.intensity] ?? props.workout.intensity : '',
)

/** 开始时刻：手动记录用 startMin，会话记录用 startedAt */
function startTimeText(startedAt: string): string {
  const d = new Date(startedAt)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const metaLine = computed(() => {
  const w = props.workout
  if (!w) return ''
  const parts = [fmtDateCn(w.date)]
  if (w.startMin != null) parts.push(minToHHmm(w.startMin))
  else if (detail.value && detail.value.source !== 'summary') {
    const t = startTimeText(detail.value.startedAt)
    if (t) parts.push(t)
  } else if (detail.value?.fromSession) {
    const t = startTimeText(detail.value.fromSession.startedAt)
    if (t) parts.push(t)
  }
  parts.push(typeLabel.value)
  return parts.join(' · ')
})

/* ---------- 跑步视图 ---------- */

const ROUTE_W = 480
const ROUTE_H = 260
const ROUTE_PAD = 26

const runRoute = computed(() => {
  if (detail.value?.source !== 'run') return null
  return projectTrack(detail.value.snap.points ?? [], ROUTE_W, ROUTE_H, ROUTE_PAD)
})

/** 距离 km：优先取总结页确认后的值（note 首段即最终距离），无则用快照 GPS 距离 */
const runKm = computed<number | null>(() => {
  if (detail.value?.source !== 'run' || !props.workout) return null
  const m = props.workout.note?.match(/^([\d.]+)\s*km(?:\s|$)/)
  if (m) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > 0) return v
  }
  const dm = detail.value.snap.distanceM ?? 0
  return dm > 5 ? Math.round(dm) / 1000 : null
})

const runDurationSec = computed(() => {
  if (detail.value?.source !== 'run') return 0
  return Math.round((detail.value.snap.accumMs ?? 0) / 1000)
})

const runAvgPace = computed(() => {
  const dur = runDurationSec.value
  if (dur < 10 || runKm.value == null || runKm.value < 0.05) return null
  return Math.round(dur / runKm.value)
})

/** 骑行等类型显示均速而不是配速 */
const isCycle = computed(() => props.workout?.type === 'cycle')

const runAvgSpeedKmh = computed(() => {
  if (runAvgPace.value == null) return null
  return Math.round((3600 / runAvgPace.value) * 10) / 10
})

const goalLine = computed(() => {
  if (detail.value?.source !== 'run') return ''
  const s = detail.value.snap
  if (s.goalKind === 'time') {
    const hit = runDurationSec.value >= s.goalTimeMin * 60
    return `目标 ${s.goalTimeMin} 分钟 · ${hit ? '已达成' : `实际 ${Math.round(runDurationSec.value / 60)} 分钟`}`
  }
  if (s.goalKind === 'distance') {
    const km = runKm.value
    const hit = km != null && km >= s.goalDistanceKm
    return `目标 ${s.goalDistanceKm} km · ${hit ? '已达成' : km != null ? `实际 ${km.toFixed(2)} km` : '未记录距离'}`
  }
  return '自由跑'
})

interface SplitRow {
  label: string
  text: string
  widthPct: number
  color: string
}

/** 快→慢从绿渐变到红（Apple 配速色带的简化版） */
function splitColor(norm: number): string {
  const fast = [146, 232, 42]
  const slow = [250, 17, 79]
  const c = fast.map((f, i) => Math.round(f + (slow[i]! - f) * norm))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

const splitRows = computed<SplitRow[]>(() => {
  if (detail.value?.source !== 'run') return []
  const km = runKm.value
  const splits = trackSplits(detail.value.snap.points ?? [], km != null ? km * 1000 : 0)
  if (!splits) return []
  const paces = splits.map((s) => s.paceSec)
  const min = Math.min(...paces)
  const max = Math.max(...paces)
  const span = Math.max(1e-6, max - min)
  return splits.map((s) => {
    const norm = (s.paceSec - min) / span
    return {
      label: s.label,
      text: isCycle.value ? `${(3600 / s.paceSec).toFixed(1)}` : fmtPace(s.paceSec),
      widthPct: Math.round(58 + (1 - norm) * 34),
      color: splitColor(norm),
    }
  })
})

const ascentM = computed(() => {
  if (detail.value?.source !== 'run') return null
  return trackAscentM(detail.value.snap.points ?? [])
})

/* ---------- 课程视图 ---------- */

interface CourseExRow {
  key: string
  name: string
  kind: 'strength' | 'timed' | 'cardio'
  plannedSets: number
  reps: number | null
  done: DoneSet[]
}

const courseRows = computed<CourseExRow[]>(() => {
  if (detail.value?.source !== 'course') return []
  const d = detail.value
  if (!d.exercises) {
    // 课程已删除：按落盘顺序以序号展示原始做组数据
    return Object.entries(d.doneSets).map(([key, sets], i) => ({
      key,
      name: `动作 ${i + 1}`,
      kind: typeof sets[0]?.sec === 'number' ? ('timed' as const) : ('strength' as const),
      plannedSets: sets.length,
      reps: null,
      done: sets,
    }))
  }
  const rows = d.exercises.map((ex) => ({
    key: ex.id,
    name: ex.name,
    kind: ex.kind,
    plannedSets: ex.sets,
    reps: ex.reps,
    done: d.doneSets[ex.id] ?? [],
  }))
  // 快照里有但课程里已不存在的动作 id（课程后来被编辑过）
  for (const [key, sets] of Object.entries(d.doneSets)) {
    if (rows.some((r) => r.key === key)) continue
    rows.push({
      key,
      name: `其他动作`,
      kind: typeof sets[0]?.sec === 'number' ? 'timed' : 'strength',
      plannedSets: sets.length,
      reps: null,
      done: sets,
    })
  }
  return rows
})

function setChip(ex: CourseExRow, d: DoneSet): string {
  if (ex.kind === 'strength') {
    if (d.weight == null) return '完成'
    return `${Number(d.weight)}kg × ${ex.reps ?? '?'}`
  }
  return d.sec != null ? fmtClock(d.sec) : '完成'
}

const courseTotals = computed(() => {
  let volume = 0
  let timedSec = 0
  let doneCount = 0
  let totalCount = 0
  for (const row of courseRows.value) {
    totalCount += row.plannedSets
    doneCount += Math.min(row.done.length, row.plannedSets)
    for (const d of row.done) {
      if (d.weight != null && row.reps != null) volume += d.weight * row.reps
      else if (row.reps == null && d.weight != null) volume += d.weight
      if (d.sec != null) timedSec += d.sec
    }
  }
  return {
    volume: Math.round(volume),
    timedSec,
    doneCount,
    totalCount,
    earlyEnd: doneCount < totalCount,
  }
})
</script>

<template>
  <SheetModal :open="open" title="运动详情" initial-snap="large" @close="$emit('close')">
    <template v-if="workout">
      <p class="name">{{ workout.name }}</p>
      <p class="meta num">{{ metaLine }} · {{ workout.durationMin }} 分钟 · {{ workout.kcal }} 大卡</p>

      <p v-if="loadFailed" class="hint">详情数据加载失败，请稍后重试。</p>

      <!-- 跑步：轨迹 + 真实指标 -->
      <template v-else-if="detail?.source === 'run'">
        <div class="routebox">
          <svg :viewBox="`0 0 ${ROUTE_W} ${ROUTE_H}`" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <path v-if="runRoute?.d" class="routeline" :d="runRoute.d" />
            <circle v-if="runRoute?.start" class="mk-start" :cx="runRoute.start.x" :cy="runRoute.start.y" r="5" />
            <circle v-if="runRoute?.last" class="mk-end" :cx="runRoute.last.x" :cy="runRoute.last.y" r="6" />
          </svg>
          <p v-if="!runRoute?.d" class="route-empty">该次跑步未记录轨迹</p>
          <p class="goal num">{{ goalLine }}</p>
        </div>

        <div class="dgrid">
          <div v-if="runKm != null" class="cell"><div class="v num">{{ runKm.toFixed(2) }}</div><div class="k">距离 km</div></div>
          <div class="cell"><div class="v num">{{ fmtClock(runDurationSec) }}</div><div class="k">运动时长</div></div>
          <div v-if="isCycle" class="cell"><div class="v num">{{ runAvgSpeedKmh ?? '--' }}</div><div class="k">平均时速 km/h</div></div>
          <div v-else-if="runAvgPace != null" class="cell"><div class="v num">{{ fmtPace(runAvgPace) }}</div><div class="k">平均配速</div></div>
          <div v-if="ascentM != null" class="cell"><div class="v num">{{ ascentM }}</div><div class="k">累计爬升 m</div></div>
        </div>

        <template v-if="splitRows.length > 0">
          <p class="sec">每公里{{ isCycle ? '用时' : '配速' }}</p>
          <div v-for="(row, i) in splitRows" :key="i" class="splitrow row">
            <span class="k num">{{ row.label }}</span>
            <div class="bar">
              <i :style="{ width: `${row.widthPct}%`, background: row.color }" />
            </div>
            <span class="v num">{{ row.text }}<b v-if="isCycle" class="unit">km/h</b></span>
          </div>
        </template>
      </template>

      <!-- 训练课：逐动作做组明细 -->
      <template v-else-if="detail?.source === 'course'">
        <div class="dgrid">
          <div class="cell"><div class="v num">{{ courseTotals.doneCount }}<span class="sub">/{{ courseTotals.totalCount }}</span></div><div class="k">完成组数</div></div>
          <div v-if="courseTotals.volume > 0" class="cell"><div class="v num">{{ courseTotals.volume }}</div><div class="k">总容量 kg</div></div>
          <div v-if="courseTotals.timedSec > 0" class="cell"><div class="v num">{{ fmtClock(courseTotals.timedSec) }}</div><div class="k">计时合计</div></div>
          <div v-if="courseTotals.volume <= 0 && courseTotals.timedSec <= 0" class="cell"><div class="v num">--</div><div class="k">暂无明细数据</div></div>
        </div>

        <p class="sec">做组明细<span v-if="courseTotals.earlyEnd" class="early"> · 提前结束</span></p>
        <div v-for="row in courseRows" :key="row.key" class="excard">
          <div class="row exhead">
            <span class="exname">{{ row.name }}</span>
            <span class="num excount">{{ row.done.length }}/{{ row.plannedSets }} 组</span>
          </div>
          <div class="chips">
            <span v-for="(d, i) in row.done" :key="i" class="chip num">{{ setChip(row, d) }}</span>
            <span v-for="i in Math.max(0, row.plannedSets - row.done.length)" :key="'miss' + i" class="chip miss">未完成</span>
          </div>
        </div>
      </template>

      <!-- 手动添加 / 快照不可用：概要 -->
      <template v-else-if="detail?.source === 'summary'">
        <div class="dgrid">
          <div class="cell"><div class="v num">{{ workout.durationMin }}</div><div class="k">时长 分钟</div></div>
          <div class="cell"><div class="v num">{{ workout.kcal }}</div><div class="k">消耗 大卡</div></div>
          <div class="cell"><div class="v">{{ intensityLabel }}</div><div class="k">强度</div></div>
          <div class="cell"><div class="v">{{ typeLabel }}</div><div class="k">类型</div></div>
        </div>
        <p v-if="detail.fromSession" class="hint">
          该记录来自「{{ detail.fromSession.planName }}」，但没有可用的过程快照。
        </p>
      </template>

      <p v-if="workout.note" class="note t-3">{{ workout.note }}</p>
    </template>
  </SheetModal>
</template>

<style scoped>
.name {
  font-size: var(--fs-title3);
  font-weight: 700;
}

.meta {
  margin-top: 3px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.sec {
  margin: 18px 0 10px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--text-3);
}

.early {
  color: #fa114f;
  letter-spacing: 0;
}

.hint {
  margin-top: 12px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

/* 轨迹块沿用跑步沉浸页的暗色语言 */
.routebox {
  position: relative;
  margin-top: 14px;
  border-radius: 18px;
  padding: 10px 10px 8px;
  background: var(--hero-bg);
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 28px 28px;
}

.routebox svg {
  display: block;
  width: 100%;
}

.routeline {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px var(--hero-route-glow));
}

.mk-start {
  fill: var(--hero-text);
}

.mk-end {
  fill: var(--hero-bg);
  stroke: var(--hero-route-line);
  stroke-width: 3;
}

.route-empty {
  padding: 44px 0;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--hero-text-dim);
}

.goal {
  margin: 4px 4px 2px;
  font-size: var(--fs-micro);
  color: var(--hero-text-dim);
}

.splitrow {
  gap: 10px;
  margin: 9px 0;
}

.splitrow .k {
  width: 34px;
  flex: none;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: right;
}

.bar {
  flex: 1;
  height: 14px;
  border-radius: 7px;
  background: var(--surface-2);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 7px;
  transition: width var(--dur-slow) var(--ease-standard);
}

.splitrow .v {
  width: 64px;
  text-align: right;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
}

.splitrow .v .unit {
  margin-left: 2px;
  font-size: var(--fs-micro);
  font-weight: 500;
  color: var(--text-3);
}

.dgrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}

.cell {
  background: var(--surface-2);
  border-radius: 16px;
  padding: 14px 16px;
}

.cell .v {
  font-size: 26px;
  font-weight: 200;
  letter-spacing: -0.5px;
}

.cell .v .sub {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-3);
}

.cell .k {
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-top: 2px;
}

.excard {
  padding: 12px 0;
}

.excard:not(:first-of-type) {
  border-top: 0.5px solid var(--line);
}

.exhead {
  gap: 8px;
}

.exname {
  font-size: var(--fs-body);
  font-weight: 600;
}

.excount {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 9px;
}

.chip {
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(146, 232, 42, 0.16);
  color: #5ba800;
  font-size: var(--fs-caption);
  font-weight: 600;
}

.chip.miss {
  background: var(--surface-2);
  color: var(--text-3);
  font-weight: 400;
}

.note {
  margin-top: 14px;
  font-size: var(--fs-caption);
}
</style>
