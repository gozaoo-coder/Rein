<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import { sessionService } from '@/services/sessionService'
import { WORKOUT_META } from '@/config/domain'
import { SCORE_GROUP_LABELS, SCORE_GROUP_OF, type Level, type MuscleKey, type ScoreGroupKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useNutritionStore } from '@/stores/nutrition'
import { usePlanStore } from '@/stores/plan'
import { fmtClock, fmtPace } from '@/stores/run'
import { todayStr, fmtDateCn, minToHHmm } from '@/utils/date'
import { projectTrack, trackAscentM, trackSplits } from '@/utils/geo'
import { libraryMuscles } from '@/utils/libraryMuscles'
import { ACTIVATION_WEIGHT } from '@/utils/trainingAdvice'
import { computeTrainingScore, type GroupScore, type TrainingScoreResult } from '@/utils/trainingScore'
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

/* ---------- 肌群练够分提醒 ----------
 * 练完一次力量课，下一个问题是「这次练的肌群，本周练够了吗」——
 * 做组明细回答的是「练了什么」，这里回答「练够了没有」。
 * 数据全部来自既有的纯函数层（trainingScore 的练够分 + 激活折算），
 * 不新造口径：本次各评估组组数按激活档位折算（主攻 1 / 辅助 0.5 / 稳定 0.25），
 * 周分数与「本周练够分」卡同一份算法，所以两处数字永远对得上。 */
const lib = useExerciseLibStore()
const weeklyLoad = ref<TrainingScoreResult | null>(null)

/**
 * 本次训练各评估组的加权组数（只算正式组 —— 热身不计入，与全局口径一致）。
 * 折叠到评估组：细肌群先经 SCORE_GROUP_OF 归组，同一动作同一次里同一组只按组内
 * 最高激活档计一次，避免卧推那种「胸 + 三头 + 前束」各记一份的虚高组数。
 */
const sessionMuscles = computed<{ group: ScoreGroupKey; label: string; sets: number }[]>(() => {
  if (detail.value?.source !== 'course') return []
  const exById = new Map((detail.value.exercises ?? []).map((e) => [e.id, e]))
  const acc = new Map<ScoreGroupKey, number>()
  for (const row of courseRows.value) {
    if (row.kind !== 'strength' || row.done.length === 0) continue
    // 课程被删过的动作取不到肌群表，libraryMuscles 会按名称规则兜底（同一口径）
    const map = libraryMuscles({ name: row.name, muscles: exById.get(row.key)?.muscles ?? {} })
    const byGroup = new Map<ScoreGroupKey, Level>()
    for (const [m, lv] of Object.entries(map) as [MuscleKey, Level][]) {
      const g = SCORE_GROUP_OF[m]
      if (!g) continue
      const cur = byGroup.get(g)
      if (!cur || lv > cur) byGroup.set(g, lv)
    }
    for (const [g, lv] of byGroup) {
      acc.set(g, (acc.get(g) ?? 0) + (ACTIVATION_WEIGHT[lv] ?? 0.5) * row.done.length)
    }
  }
  return [...acc.entries()]
    .map(([group, sets]) => ({ group, label: SCORE_GROUP_LABELS[group], sets: Math.round(sets * 10) / 10 }))
    .sort((a, b) => b.sets - a.sets)
})

/** 提醒内容：本次练到的组 × 该组的本周练够分。取贡献最大的 5 个，再多就不是「提醒」了 */
const muscleReminder = computed(() => {
  if (!sessionMuscles.value.length || !weeklyLoad.value) return null
  const byGroup = new Map(weeklyLoad.value.groups.map((g) => [g.group, g]))
  const rows = sessionMuscles.value
    .map((s) => ({ group: s.group, label: s.label, sets: s.sets, score: byGroup.get(s.group) }))
    .filter((x): x is typeof x & { score: GroupScore } => !!x.score)
    .slice(0, 5)
  if (!rows.length) return null
  return { rows, low: rows.filter((x) => x.score.score < 60).length }
})

/** 直接给规范的六段档名（运动充分…明显不足） */
function statusLabel(g: GroupScore): string {
  return g.band
}

/**
 * 练够分条：**满格 = 100 分（运动充分）**，与旁边的 `NN 分` 同源。
 *
 * 分数本身就是 0–100 的最终结论，不再拿别的量表来换算 —— 条走到哪、
 * 数字写到哪、档名说到哪，三处永远一致（不再另设量表基准）。
 */
function loadPct(g: GroupScore): number {
  return Math.round(Math.max(0, Math.min(1, g.score / 100)) * 100)
}

watch(
  () => [props.open, props.workout?.id] as const,
  ([open]) => {
    if (!open || !props.workout) {
      detail.value = null
      loadFailed.value = false
      weeklyLoad.value = null
      return
    }
    void load(props.workout)
    void loadWeeklyLoad()
  },
  { immediate: true },
)

/**
 * 本周各肌群练够分（「肌群练够分提醒」用）。与「本周练够分」卡同一份算法与同一窗口
 * （42 天记录，引擎内部再切本周 7 天）。目标取自营养档案（cut → 减脂，其余 → 增肌）。
 * 失败时置 null、整块提醒不渲染 —— 这条是补充信息，不能因为它把详情抽屉带崩。
 */
async function loadWeeklyLoad(): Promise<void> {
  try {
    await lib.ensureLoaded()
    const sets = await sessionService.strengthRecentSets(42)
    const nutrition = useNutritionStore()
    await nutrition.loadProfile()
    const goal = nutrition.profile?.goal ?? null
    weeklyLoad.value = computeTrainingScore({ sets, library: lib.list, today: todayStr(), goal })
  } catch (e) {
    console.warn('[workout-detail] 本周练够分加载失败', e)
    weeklyLoad.value = null
  }
}

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
  /** 正式组（热身组已拆出） */
  done: DoneSet[]
  /** 激活热身组（不计入组数与总容量，单独展示） */
  warmups: DoneSet[]
  /** 热身组定义（课程存在时有，用于显示热身次数） */
  warmupDefs?: { weightKg: number; reps: number }[]
}

const courseRows = computed<CourseExRow[]>(() => {
  if (detail.value?.source !== 'course') return []
  const d = detail.value
  const split = (sets: DoneSet[]) => ({
    done: sets.filter((x) => !x.warmup),
    warmups: sets.filter((x) => x.warmup),
  })
  if (!d.exercises) {
    // 课程已删除：按落盘顺序以序号展示原始做组数据
    return Object.entries(d.doneSets).map(([key, sets], i) => ({
      key,
      name: `动作 ${i + 1}`,
      kind: typeof sets[0]?.sec === 'number' ? ('timed' as const) : ('strength' as const),
      plannedSets: sets.length,
      reps: null,
      ...split(sets),
    }))
  }
  const rows = d.exercises.map((ex): CourseExRow => ({
    key: ex.id,
    name: ex.name,
    kind: ex.kind,
    plannedSets: ex.sets,
    reps: ex.reps,
    warmupDefs: ex.warmups,
    ...split(d.doneSets[ex.id] ?? []),
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
      ...split(sets),
    })
  }
  return rows
})

/**
 * 做组芯片：次数优先取该组完成瞬间登记的 reps（课程可能事后被编辑/删除，
 * 回读定义会失真）；课程定义也没有时只显示重量，绝不拼出「× ?」。
 */
function setChip(ex: CourseExRow, d: DoneSet): string {
  if (ex.kind === 'strength') {
    if (d.weight == null) return '完成'
    const reps = d.reps ?? ex.reps
    return reps != null ? `${fmtWeight(d.weight)} × ${reps}` : fmtWeight(d.weight)
  }
  return d.sec != null ? fmtClock(d.sec) : '完成'
}

/** 热身组芯片：重量 × 热身次数（次数取逐组登记，旧数据回落课程定义；都没有只显示重量） */
function warmupChip(row: CourseExRow, d: DoneSet, i: number): string {
  const reps = d.reps ?? row.warmupDefs?.[i]?.reps
  if (d.weight == null) return '热身'
  return `热身 ${fmtWeight(d.weight)}${reps != null ? ` × ${reps}` : ''}`
}

function fmtWeight(w: number): string {
  return `${Number.isInteger(w) ? w : w.toFixed(1)}kg`
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
      if (d.weight != null) {
        // 逐组登记次数优先，课程定义兜底；都没有则按 1 次计容量（避免凭空夸大）
        const reps = d.reps ?? row.reps
        volume += d.weight * (reps ?? 1)
      }
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
              <i :style="{ '--p': `${row.widthPct}%`, background: row.color }" />
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

        <!-- 肌群练够分提醒：紧接统计格 —— 上面那两个数字说的是「这次练了多少」，
             这里说的是「这次练的肌群，本周练够了没有」。数据与「本周练够分」卡同源。 -->
        <div v-if="muscleReminder" class="mvol">
          <div class="row between mvol-head">
            <span class="mv-t">肌群练够分 · 本周</span>
            <span class="mv-s" :class="{ low: muscleReminder.low > 0 }">
              {{ muscleReminder.low > 0 ? `${muscleReminder.low} 个仍不足` : '均已练够' }}
            </span>
          </div>
          <div v-for="m in muscleReminder.rows" :key="m.group" class="mv-row row">
            <span class="mv-n">{{ m.label }}</span>
            <span class="mv-barwrap"><i class="mv-bar" :class="{ low: m.score.score < 60 }" :style="{ width: `${loadPct(m.score)}%` }" /></span>
            <span class="mv-num num">{{ m.score.score }}<small> 分</small></span>
            <span class="mv-st" :class="{ low: m.score.score < 60 }">{{ statusLabel(m.score) }}</span>
          </div>
          <p class="mv-note">
            数字 = 本周练够分（0–100，满分即「运动充分」）· 条满格 = 100 分。分数按 频率/强度/体感 加权，间接刺激按激活档位折算，只取本周既有训练记录计算。
          </p>
        </div>

        <p class="sec">做组明细<span v-if="courseTotals.earlyEnd" class="early"> · 提前结束</span></p>
        <div v-for="row in courseRows" :key="row.key" class="excard">
          <div class="row exhead">
            <span class="exname">{{ row.name }}</span>
            <span class="num excount">{{ row.done.length }}/{{ row.plannedSets }} 组</span>
          </div>
          <div class="chips">
            <span v-for="(d, i) in row.warmups" :key="'w' + i" class="chip warm num">{{ warmupChip(row, d, i) }}</span>
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
  width: 100%;
  height: 100%;
  border-radius: inherit;
  clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0 round var(--radius-full));
  transition: clip-path var(--dur-base) var(--ease-standard);
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

/* ---------- 肌群练够分提醒 ----------
   与统计格同一块「次级底」（--surface-2），但用圆角 + 行内条把它读成"一组数据"
   而不是又一张卡：这一块是解释性的补充，不该和上面的完成组数/总容量抢层级。 */
.mvol {
  margin-top: 12px;
  padding: 13px 14px;
  border-radius: 16px;
  background: var(--surface-2);
}

.mvol-head {
  gap: 8px;
  margin-bottom: 9px;
}

.mv-t {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-1);
}

.mv-s {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--c-exercise-deep);
}

/* 有不足（练够分 < 60）时用青色 —— 与「不足」这一档在全应用的颜色一致（周分数的 low 也是它） */
.mv-s.low {
  color: var(--c-balance);
}

.mv-row {
  display: grid;
  grid-template-columns: 74px 1fr 52px 30px;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}

.mv-n {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mv-barwrap {
  height: 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  overflow: hidden;
}

.mv-bar {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--c-exercise);
  transition: width var(--dur-slow) var(--ease-standard);
}

/* 不足（练够分 < 60）才染色提醒，其余保持中性主色 —— 练够与否只分这一条线 */
.mv-bar.low {
  background: var(--c-balance);
}

.mv-num {
  text-align: right;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-1);
}

.mv-num small {
  font-weight: 500;
  color: var(--text-3);
}

.mv-st {
  font-size: var(--fs-micro);
  font-weight: 700;
  text-align: right;
  color: var(--text-3);
}

.mv-st.low {
  color: var(--c-balance);
}

.mv-note {
  margin-top: 7px;
  font-size: var(--fs-micro);
  line-height: 1.55;
  color: var(--text-3);
}

.cell {
  background: var(--surface-2);
  border-radius: 16px;
  padding: 14px 16px;
}

.cell .v {
  font-size: var(--fs-title1);
  font-weight: 200;
  letter-spacing: -0.5px;
}

.cell .v .sub {
  font-size: var(--fs-callout);
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
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-size: var(--fs-caption);
  font-weight: 600;
}

/* 热身组：中性描边样式与正式组区分 */
.chip.warm {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong, var(--line));
  color: var(--text-3);
  font-weight: 500;
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
