<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  CheckCircle2,
  ChevronRight,
  Circle,
  Info,
  MoreHorizontal,
  ShoppingBag,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import ProgramCompare from '@/components/program/ProgramCompare.vue'
import ProgramConstraints from '@/components/program/ProgramConstraints.vue'
import ProgramCycleMap from '@/components/program/ProgramCycleMap.vue'
import ProgramDashboard from '@/components/program/ProgramDashboard.vue'
import ProgramEvolutionChart from '@/components/program/ProgramEvolutionChart.vue'
import ProgramEvidenceSheet from '@/components/program/ProgramEvidenceSheet.vue'
import ProgramNutritionCompass from '@/components/program/ProgramNutritionCompass.vue'
import ProgramReviewSheet from '@/components/program/ProgramReviewSheet.vue'
import ProgramWeightChannel from '@/components/program/ProgramWeightChannel.vue'
import { nutritionService } from '@/services/nutritionService'
import { planService } from '@/services/planService'
import { todoService } from '@/services/todoService'
import { copyText } from '@/utils/clipboard'
import {
  amountText,
  groupShoppingRows,
  shoppingListText,
  type CheckedRow,
} from '@/utils/shoppingList'
import { GOAL_LABELS, mealTypeOfSlot } from '@/config/domain'
import { useModelsStore } from '@/stores/models'
import { useNutritionStore } from '@/stores/nutrition'
import {
  DEFAULT_PROGRAM_WEEKS,
  defaultStartDate,
  useProgramStore,
} from '@/stores/program'
import type {
  BodyMetric,
  MealType,
  ProgramAdjustment,
  ProgramBlob,
  ProgramMeal,
  ProgramPlan,
  ProgramRecord,
  ProgramStart,
  ProgramTier,
  Todo,
} from '@/types'
import type { AiMenuMeal } from '@/ai/recipeGen'
import { diffDays, fmtDateCn, todayStr } from '@/utils/date'
import {
  ADJUSTMENT_LIMITS,
  parseBlob,
  programEndDate,
  type AdjustmentPatch,
} from '@/utils/programEngine'
import { buildDayCells, cycleStats } from '@/utils/programProgress'
import { constraintSnapshotOf, sameConstraint, type ConstraintSnapshot } from '@/utils/programSetup'
import {
  buildReviewPayload,
  buildWeekCompare,
  reviewProgram,
  type WeekCompare,
} from '@/ai/programReview'

/**
 * 健康方案：程序计算三档基线方案（保守/均衡/进取），展开到日程级；
 * AI 只负责基于执行数据的参数复盘，且必须经用户确认、引擎钳制后生效。
 */
const router = useRouter()
const store = useProgramStore()
const n = useNutritionStore()
const models = useModelsStore()

type Phase = 'loading' | 'setup' | 'active'
const phase = ref<Phase>('loading')

onMounted(async () => {
  await Promise.all([store.load(), n.loadProfile()])
  phase.value = store.active ? 'active' : 'setup'
  await loadSchedule()
  loadBodyMetrics()
  // 课程名（首练选择的展示用），失败不影响主流程
  planService
    .list()
    .then((ps) => {
      courseNames.value = Object.fromEntries(ps.map((x) => [x.id, x.name]))
    })
    .catch(() => undefined)
})

/* ---------------- 方案日程待办（周期地图 / 今日完成态的数据来源） ---------------- */

const scheduleTodos = ref<Todo[]>([])

/** 只取当前方案的日程待办；失败时退化为空数组（地图按「无记录」渲染，不阻塞页面） */
async function loadSchedule(): Promise<void> {
  const id = store.active?.id
  if (id == null) {
    scheduleTodos.value = []
    return
  }
  try {
    const all = await todoService.listAllTodos()
    scheduleTodos.value = all.filter((t) => t.programId === id)
  } catch {
    scheduleTodos.value = []
  }
}

/* ---------------- 生成流 ---------------- */

const generating = ref(false)
const drafts = ref<ProgramPlan[] | null>(null)
const selectedTier = ref<ProgramTier>('balanced')
const activating = ref(false)
const confirmOpen = ref(false)

/** 开始日与首练：提前开跑 + 相位平移（接续当前训练节奏）。
 * 状态在向导内维护，经 start-change 即时回传；这里只消费。 */
const start = ref<ProgramStart>({ startMode: 'next', firstCourseId: null, phase: 0, startDate: defaultStartDate() })

const startLabel = computed(() =>
  start.value.startMode === 'today' ? '今天' : start.value.startMode === 'tomorrow' ? '明天' : '下周一',
)

/** 课程 id → 名称（首练选择的展示用） */
const courseNames = ref<Record<string, string>>({})

const selectedPlan = computed(
  () => drafts.value?.find((d) => d.tier === selectedTier.value) ?? null,
)

/** 生成时的约束快照：之后约束又改过 → 提示重新计算 */
const draftSnap = ref<ConstraintSnapshot | null>(null)
const constraintsStale = computed(() => {
  if (!drafts.value || !draftSnap.value || !n.profile) return false
  return !sameConstraint(draftSnap.value, constraintSnapshotOf(n.profile, {
    startMode: start.value.startMode,
    firstCourseId: start.value.firstCourseId,
  }))
})

async function generate(): Promise<void> {
  generating.value = true
  try {
    drafts.value = await store.generateDrafts(start.value.startDate, DEFAULT_PROGRAM_WEEKS, start.value.phase)
    if (n.profile) {
      draftSnap.value = constraintSnapshotOf(n.profile, {
        startMode: start.value.startMode,
        firstCourseId: start.value.firstCourseId,
      })
    }
    if (!drafts.value.some((d) => d.tier === selectedTier.value)) selectedTier.value = 'balanced'
  } finally {
    generating.value = false
  }
}

function askActivate(): void {
  if (selectedPlan.value?.feasible) confirmOpen.value = true
}

async function activate(): Promise<void> {
  if (!selectedPlan.value) return
  activating.value = true
  try {
    await store.activate(selectedPlan.value)
    confirmOpen.value = false
    drafts.value = null
    phase.value = 'active'
  } finally {
    activating.value = false
  }
}

/* ---------------- 生效方案展示 ---------------- */

/**
 * 方案数据可能损坏（params_json 被外部改写 / 版本不兼容）。解析失败不能让整页
 * 崩在 computed 里，降级成明确的错误提示；解析成功与失败成对返回，避免在
 * computed 内写 ref 造成副作用。
 */
const parsedBlob = computed<{ blob: ProgramBlob | null; error: string }>(() => {
  if (!store.active) return { blob: null, error: '' }
  try {
    return { blob: parseBlob(store.active), error: '' }
  } catch (e) {
    return { blob: null, error: e instanceof Error ? e.message : '方案数据损坏，无法解析' }
  }
})
const blob = computed(() => parsedBlob.value.blob)

/** 状态条展开（静态参数详情）与页头「⋯」操作菜单 */
const stripOpen = ref(false)
const moreOpen = ref(false)

const activeTierLabel = computed(() =>
  store.active?.tier === 'conservative' ? '保守' : store.active?.tier === 'aggressive' ? '进取' : '均衡',
)

/** ⋯ 菜单项：方案结束后归档项让位给成绩单 */
const moreActions = computed(() => {
  if (!store.active) return []
  const items: { label: string; value: string; danger?: boolean }[] = []
  if (isEnded.value) items.push({ label: '生成本期成绩单', value: 'wrapup' })
  if (!isEnded.value) items.push({ label: '归档方案', value: 'archive' })
  items.push({ label: '删除方案', value: 'delete', danger: true })
  return items
})

function onMore(value: string): void {
  moreOpen.value = false
  if (value === 'wrapup' && store.active) openWrapup(store.active)
  else if (value === 'archive') void archiveCurrent()
  else if (value === 'delete') void deleteCurrent()
}
const blobError = computed(() => parsedBlob.value.error)
const startDate = computed(() => blob.value?.days[0]?.date ?? null)
const endDate = computed(() => (blob.value ? programEndDate(blob.value) : null))
const isEnded = computed(() => endDate.value != null && endDate.value < todayStr())
const currentWeek = computed(() => {
  if (!blob.value || !startDate.value || !store.active) return 0
  const passed = diffDays(startDate.value, todayStr())
  return Math.max(1, Math.min(store.active.weeks, Math.floor(passed / 7) + 1))
})

/** 聚焦日：用户点选 > 今天（若在周期内） > 第一个即将到来的方案日。
 * 方案从下周一开跑时，生效态也能预览第一天的完整安排而不是空白。 */
const focusedDay = ref<string | null>(null)
const focusDay = computed(() => {
  const b = blob.value
  if (!b) return null
  return (
    b.days.find((d) => d.date === focusedDay.value) ??
    b.days.find((d) => d.date === todayStr()) ??
    b.days.find((d) => d.date >= todayStr()) ??
    null
  )
})
const focusIsToday = computed(() => focusDay.value?.date === todayStr())
const adjustments = computed<ProgramAdjustment[]>(() => {
  if (!store.active) return []
  try {
    return JSON.parse(store.active.adjustmentsJson || '[]') as ProgramAdjustment[]
  } catch {
    // 调整历史损坏只影响历史列表，不应连带整页白屏
    return []
  }
})

/* ---------------- 周期进度 · 驾驶舱 ---------------- */

/** 周期地图格子：方案日 × 日程待办 左连接（统计口径与 programReport 一致） */
const dayCells = computed(() => {
  const b = blob.value
  const rec = store.active
  if (!b || !rec) return []
  return buildDayCells(b, scheduleTodos.value, rec.id, todayStr())
})

const cycle = computed(() => cycleStats(dayCells.value))

/* ---------------- 体重航道 ---------------- */

const bodyMetrics = ref<BodyMetric[]>([])

async function loadBodyMetrics(): Promise<void> {
  try {
    bodyMetrics.value = await nutritionService.listBodyMetrics(100)
  } catch {
    bodyMetrics.value = []
  }
}

/** 方案区间内的体重点（时间正序）；起点缺记录时用档案体重兜底 */
const weightPoints = computed<{ date: string; kg: number }[]>(() => {
  if (!startDate.value) return []
  const end = endDate.value ?? todayStr()
  return bodyMetrics.value
    .filter((m) => m.weightKg != null && m.date >= startDate.value! && m.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => ({ date: m.date, kg: m.weightKg as number }))
})

const weightChannel = computed(() => {
  const start = startDate.value
  if (!start) return null
  const startWeight = weightPoints.value[0]?.kg ?? n.profile?.weightKg ?? null
  if (startWeight == null) return null
  return {
    startWeight,
    targetWeight: n.profile?.targetWeightKg ?? null,
    /** 档位预期速率：缺口 × 7 ÷ 7700（kg/周） */
    weeklyRateKg: Math.round(((blob.value?.params.kcalDelta ?? 0) * 7) / 7700 * 100) / 100,
    endDate: endDate.value && endDate.value > todayStr() ? endDate.value : todayStr(),
  }
})

/** 今日训练待办是否已完成（驱动驾驶舱的训练进度条） */
const trainingDone = computed(() => {
  const t = todayStr()
  return scheduleTodos.value.some(
    (x) => x.date === t && x.category === 'workout' && x.status === 'done',
  )
})

/** 驾驶舱的当日菜单：AI 菜单优先，未生成时回落模板菜单 */
const dashboardMenu = computed<ProgramMeal[]>(() => {
  const ai = dayMenu.value
  if (ai) {
    return ai.map((m) => ({
      mealType: mealTypeOfSlot(m.slot),
      slot: m.slot,
      name: m.name,
      items: m.items.map((it) => `${it.label} ${it.grams}g`),
      kcal: m.kcal,
      protein: m.protein,
      carb: m.carb,
      fat: m.fat,
    }))
  }
  return focusDay.value?.meals ?? []
})

/** 科学依据（三条研究曲线）弹层 */
const evidenceOpen = ref(false)
/** 弹层里高亮的档位：生效方案优先，setup 阶段跟随当前选中的草稿 */
const evidenceTier = computed<ProgramTier>(() => {
  const active = store.active?.tier
  if (active) return active
  const sel = selectedTier.value
  return sel === 'conservative' || sel === 'aggressive' ? sel : 'balanced'
})

/** 驾驶舱「开始」：进课程详情，那里有成熟的开始训练流程 */
function startCourse(courseId: string): void {
  void router.push(`/sports/plans/${courseId}`)
}

/** 驾驶舱「记一笔」：打开智能添加（可带下一餐的餐次预选） */
function quickLog(mealType: MealType | null = null): void {
  openSmartAdd(mealType)
}

/** 「记一笔」：打开智能添加（food 模式）；下一餐入口会带餐次预选 */
const smartAddOpen = ref(false)
const smartAddMeal = ref<MealType | null>(null)

function openSmartAdd(mealType: MealType | null): void {
  smartAddMeal.value = mealType
  smartAddOpen.value = true
}

/* ---------------- 聚焦日的 AI 菜单（未生成回落模板菜单） ---------------- */

const dayMenu = ref<AiMenuMeal[] | null>(null)
const dayMenuLoading = ref(false)
const dayMenuError = ref('')
/** 逐日菜单生成中的流式活动摘要（匹配食材…） */
const dayMenuStatus = ref('')

watch(
  () => focusDay.value?.date,
  async (d, _prev, onCleanup) => {
    // 快速切换日期时旧请求的响应可能后到并覆盖新日期的菜单，
    // 用 watch 自带的 cleanup 标记过期结果并丢弃
    let stale = false
    onCleanup(() => {
      stale = true
    })
    dayMenu.value = null
    dayMenuError.value = ''
    if (!d || !store.active) return
    try {
      const meals = await store.loadDayMeals(store.active, d)
      if (!stale) dayMenu.value = meals
    } catch {
      /* 缓存读取失败按未生成处理 */
    }
  },
  { immediate: true },
)

async function genDayMenu(): Promise<void> {
  if (!store.active || !focusDay.value) return
  dayMenuLoading.value = true
  dayMenuError.value = ''
  dayMenuStatus.value = ''
  try {
    dayMenu.value = await store.generateDayMeals(store.active, focusDay.value.date, (s) => {
      // 流式：匹配食材等活动摘要实时上屏
      dayMenuStatus.value = s
    })
  } catch (e) {
    dayMenuError.value = e instanceof Error ? e.message : String(e)
  } finally {
    dayMenuLoading.value = false
    dayMenuStatus.value = ''
  }
}

/* ---------------- 手动调整 ---------------- */

const adjustOpen = ref(false)
const adjusting = ref(false)
const patchDelta = ref(-400)
const patchProtein = ref(1.8)
const patchDays = ref(4)
const manualSummary = ref('手动调整')

function openAdjust(): void {
  const p = blob.value?.params
  if (!p) return
  patchDelta.value = p.kcalDelta
  patchProtein.value = p.proteinPerKg
  patchDays.value = p.trainingDays
  adjustOpen.value = true
}

async function applyManual(): Promise<void> {
  if (!store.active) return
  adjusting.value = true
  try {
    await store.adjust(
      store.active,
      { kcalDelta: patchDelta.value, proteinPerKg: patchProtein.value, trainingDays: patchDays.value },
      manualSummary.value.trim() || '手动调整',
      'manual',
    )
    adjustOpen.value = false
  } finally {
    adjusting.value = false
  }
}

/* ---------------- AI 周复盘（卡片流：数据先行 + 单条采纳） ---------------- */

interface ReviewState {
  phase: 'running' | 'done' | 'error'
  diagnosis: string
  advice: string[]
  /** 模型原始建议（未经钳制；钳制在弹层内按勾选子集实时试算） */
  proposed: AdjustmentPatch
  error: string
}
const reviewOpen = ref(false)
const review = ref<ReviewState>({ phase: 'running', diagnosis: '', advice: [], proposed: {}, error: '' })
const reviewCompare = ref<WeekCompare | null>(null)

async function startReview(): Promise<void> {
  if (!store.active) return
  reviewOpen.value = true
  review.value = { phase: 'running', diagnosis: '', advice: [], proposed: {}, error: '' }
  // 数据先行区与 AI 请求并行：模型慢的时候对比条已经在了
  reviewCompare.value = null
  const comparePromise = buildWeekCompare(store.active).then(
    (c) => (reviewCompare.value = c),
    () => undefined,
  )
  try {
    await models.load()
    const cfg = models.defaultModel()
    if (!cfg) throw new Error('未配置 AI 模型，请先在「AI › 管理模型」添加')
    const payload = await buildReviewPayload(store.active)
    const sug = await reviewProgram(cfg, payload, (partial) => {
      // 流式：诊断文本边生成边上屏（phase 保持 running）
      review.value = { ...review.value, diagnosis: partial }
    })
    review.value = {
      phase: 'done',
      diagnosis: sug.diagnosis,
      advice: sug.advice,
      proposed: sug.changes,
      error: '',
    }
  } catch (e) {
    review.value = { ...review.value, phase: 'error', error: e instanceof Error ? e.message : String(e) }
  }
  await comparePromise
}

/** 弹层「应用」：只提交勾选的子集（钳制在 store.adjust 内仍会再走一遍） */
async function applyReview(patch: AdjustmentPatch, summary: string): Promise<void> {
  if (!store.active) return
  await store.adjust(store.active, patch, summary, 'ai')
  reviewOpen.value = false
}

/* ---------------- 本周采购清单（未来 7 天菜单食材聚合 + 勾选已买） ---------------- */

const SHOP_HORIZON_DAYS = 7

const shoppingOpen = ref(false)
const shoppingLoading = ref(false)
const shoppingError = ref('')
const shoppingRows = ref<CheckedRow[]>([])
const shoppingRangeLabel = ref('')
const shoppingAiDays = ref(0)
const shoppingTemplateDays = ref(0)
const shoppingCopied = ref(false)
const shoppingCopyErr = ref('')

const shoppingSourceLabel = computed(() => {
  const parts = [
    shoppingAiDays.value ? `${shoppingAiDays.value} 天 AI 菜单` : '',
    shoppingTemplateDays.value ? `${shoppingTemplateDays.value} 天模板菜单` : '',
  ].filter(Boolean)
  return parts.join(' · ')
})
const shoppingGroups = computed(() => groupShoppingRows(shoppingRows.value))
const shoppingHasTemplate = computed(() => shoppingTemplateDays.value > 0)
const shoppingCheckedCount = computed(() => shoppingRows.value.filter((r) => r.checked).length)

async function openShopping(): Promise<void> {
  if (!store.active) return
  shoppingOpen.value = true
  shoppingLoading.value = true
  shoppingError.value = ''
  shoppingCopied.value = false
  shoppingCopyErr.value = ''
  try {
    const res = await store.buildShopping(store.active, SHOP_HORIZON_DAYS)
    shoppingRows.value = res.rows
    shoppingRangeLabel.value = res.rangeLabel
    shoppingAiDays.value = res.aiDays
    shoppingTemplateDays.value = res.templateDays
  } catch (e) {
    shoppingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    shoppingLoading.value = false
  }
}

/** 勾选/取消一个采购项（乐观更新，失败回滚）；已勾行从复制全文剔除 */
async function toggleCheck(row: CheckedRow): Promise<void> {
  const next = !row.checked
  row.checked = next
  try {
    await store.setShoppingCheck(row.key, next)
  } catch {
    row.checked = !next
  }
}

async function clearChecks(): Promise<void> {
  try {
    await store.clearShoppingChecks()
    for (const r of shoppingRows.value) r.checked = false
  } catch {
    /* 清空失败保持原状，下一次打开会重新对齐 */
  }
}

async function copyShopping(): Promise<void> {
  shoppingCopied.value = false
  shoppingCopyErr.value = ''
  try {
    await copyText(
      shoppingListText({
        rows: shoppingRows.value,
        rangeLabel: shoppingRangeLabel.value,
        aiDays: shoppingAiDays.value,
        templateDays: shoppingTemplateDays.value,
      }),
    )
    shoppingCopied.value = true
    setTimeout(() => (shoppingCopied.value = false), 1800)
  } catch {
    shoppingCopyErr.value = '复制失败，请重试'
  }
}

/* ---------------- 归档 / 删除 ---------------- */

const deleteArmed = ref(false)

async function archiveCurrent(): Promise<void> {
  if (!store.active) return
  await store.archive(store.active.id)
  phase.value = 'setup'
}

async function deleteCurrent(): Promise<void> {
  if (!store.active) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  await store.remove(store.active.id)
  deleteArmed.value = false
  phase.value = 'setup'
}

/* ---------------- 历史方案（结营成绩单入口） ---------------- */

const archivedList = computed(() => store.history.filter((r) => r.status === 'archived'))

function tierLabel(tier: ProgramRecord['tier']): string {
  return tier === 'conservative' ? '保守' : tier === 'aggressive' ? '进取' : '均衡'
}

function openWrapup(r: ProgramRecord): void {
  void router.push(`/program/wrapup/${r.id}`)
}

function reportSpanOf(r: ProgramRecord): string {
  try {
    const b = parseBlob(r)
    const s = b.days[0]?.date ?? r.activatedAt.slice(0, 10)
    const e = b.days.at(-1)?.date ?? s
    return `${s} ~ ${e}`
  } catch {
    return ''
  }
}

function adjustmentsOf(r: ProgramRecord): number {
  try {
    const arr = JSON.parse(r.adjustmentsJson) as unknown
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="健康方案" subtitle="程序算基线 · 日程级安排 · AI 只复盘调参" back>
      <template v-if="phase === 'active'" #action>
        <button class="hdr-btn" aria-label="更多方案操作" @click="moreOpen = true">
          <MoreHorizontal :size="19" />
        </button>
      </template>
    </PageHeader>

    <!-- 加载 -->
    <section v-if="phase === 'loading'" class="card center empty">
      <span class="t-3">加载中…</span>
    </section>

    <!-- 方案数据损坏：给明确出口，而不是白屏或静默回落到向导 -->
    <section v-else-if="blobError" class="card center empty">
      <span class="t-3">{{ blobError }}</span>
    </section>

    <!-- 生成流：约束向导内联在方案页上，改完当场重算 -->
    <template v-else-if="phase === 'setup'">
      <ProgramConstraints
        :stale="constraintsStale"
        :generating="generating"
        :has-drafts="!!drafts"
        :course-names="courseNames"
        @start-change="start = $event"
        @generate="generate"
      />

      <template v-if="drafts">
        <section v-if="!drafts.every((d) => d.feasible)" class="card warn t-2">
          {{ drafts[0]?.issues.join('；') }}
          <button class="linkbtn" @click="router.push('/me')">去补全<ChevronRight :size="13" /></button>
        </section>

        <!-- 01 对比矩阵 + 02 强度预览：分段双视图，点列选中 -->
        <ProgramCompare
          :plans="drafts"
          :selected-tier="selectedTier"
          :goal="n.profile?.goal ?? 'cut'"
          @select="selectedTier = $event"
          @activate="askActivate"
        />

        <button class="why-link" @click="evidenceOpen = true">
          <Info :size="13" style="vertical-align:-2px;margin-right:3px" />为什么每个肌群要练 2~3 次？看研究曲线
        </button>

        <!-- 启用确认 -->
        <SheetModal :open="confirmOpen" title="启用这套方案？" @close="confirmOpen = false">
          <div v-if="selectedPlan" class="form">
            <p class="t-2">「{{ selectedPlan.tierLabel }}」· {{ DEFAULT_PROGRAM_WEEKS }} 周，从{{ startLabel }}（{{ start.startDate }}）开始。</p>
            <ul class="confirm-list t-2">
              <li>未来 {{ DEFAULT_PROGRAM_WEEKS }} 周的训练课与每日饮食安排将写入日程表；</li>
              <li v-if="start.startMode !== 'next' || start.firstCourseId">
                从{{ startLabel }}起按你选的节奏循环{{ start.firstCourseId ? `，首个训练日是「${courseNames[start.firstCourseId] ?? ''}」` : '' }}{{ start.startMode !== 'next' ? '；今天若已练过，直接勾掉当天课程即可' : '' }}；
              </li>
              <li>每日营养目标同步为方案值（能量环与记录页同源）；</li>
              <li>已有生效方案会被自动归档，可随时手动调整或让 AI 复盘微调。</li>
            </ul>
            <button class="primary" :disabled="activating" @click="activate">
              {{ activating ? '正在启用…' : '确认启用' }}
            </button>
          </div>
        </SheetModal>
      </template>
    </template>

    <!-- 生效中 -->
    <template v-else-if="blob && store.active && startDate && endDate">
      <!-- 方案状态条：一行概要（目标·档位·周次·截止），静态参数点开展开（example 对齐） -->
      <section class="head-strip">
        <button class="strip" :aria-expanded="stripOpen" @click="stripOpen = !stripOpen">
          <span class="grow">{{ GOAL_LABELS[store.active.goal] }} · {{ activeTierLabel }} v{{ store.active.version }} · 第 {{ currentWeek }} 周 / {{ store.active.weeks }}</span>
          <span class="end num">{{ endDate!.slice(5) }} 结束</span>
          <ChevronRight :size="12" class="chev" :class="{ open: stripOpen }" />
        </button>
        <div class="strip-detail" :class="{ open: stripOpen }">
          <ul class="stats num">
            <li><em>每日热量</em><b>{{ Math.round(blob.params.targets.kcal) }}<i>大卡</i></b></li>
            <li><em>蛋白</em><b>{{ Math.round(blob.params.targets.protein) }}<i>g</i></b></li>
            <li><em>热量偏移</em><b>{{ blob.params.kcalDelta > 0 ? '+' : '' }}{{ blob.params.kcalDelta }}</b></li>
            <li><em>BMR/TDEE</em><b>{{ blob.params.bmr }}/{{ blob.params.tdee }}</b></li>
          </ul>
          <p class="strip-meta num">{{ startDate }} ~ {{ endDate }} · {{ blob.params.mealsCount }}餐{{ blob.params.trainingDays }}练</p>
        </div>
      </section>

      <!-- 今日驾驶舱：进度 + 训练 + 下一餐，回答「我今天还差什么」 -->
      <ProgramDashboard
        v-if="focusDay"
        :day="focusDay"
        :date-label="focusIsToday ? '今天' : fmtDateCn(focusDay.date)"
        :day-no="focusDay.dayIndex + 1"
        :total-days="blob.days.length"
        :training-done="trainingDone"
        :today-menu="dashboardMenu"
        @start="startCourse"
        @log="quickLog"
      />

      <!-- 今日菜单：供能结构 + 餐次列表一张卡（罗盘与全天菜单合并，消除双环与菜单双写） -->
      <ProgramNutritionCompass
        v-if="focusDay && dashboardMenu.length"
        :meals="dashboardMenu"
        :target-protein="Math.round(blob.params.targets.protein)"
        :training-day="!focusDay.rest"
        :title="focusIsToday ? '今日菜单' : fmtDateCn(focusDay.date)"
        :subtitle="!focusIsToday && focusDay.date > todayStr() ? '该日尚未到来 · 提前查看当日安排' : ''"
        :ai-generated="!!dayMenu"
        :ai-loading="dayMenuLoading"
        :ai-status="dayMenuStatus"
        :ai-error="dayMenuError"
        :loggable="focusIsToday"
        @regenerate="genDayMenu"
        @log="openSmartAdd(null)"
      />

      <!-- 全周期地图：已经走过的日子同样在场，长周期需要「已坚持」的实感；
           点格子即把上方驾驶舱 / 今日菜单切到那一天 -->
      <ProgramCycleMap
        :cells="dayCells"
        :stats="cycle"
        :focused-date="focusedDay ?? focusDay?.date ?? null"
        :today="todayStr()"
        @focus="focusedDay = $event"
      />

      <!-- 体重航道：方案唯一的真相指标，走廊按档位速率铺出 -->
      <ProgramWeightChannel
        v-if="weightChannel"
        :points="weightPoints"
        :goal="store.active.goal"
        :weekly-rate-kg="weightChannel.weeklyRateKg"
        :start-weight="weightChannel.startWeight"
        :target-weight="weightChannel.targetWeight"
        :start-date="startDate"
        :end-date="weightChannel.endDate"
      />

      <section class="card acts">
        <button v-if="isEnded" class="primary" @click="openWrapup(store.active!)">
          生成本期成绩单<span class="t-3">方案期已结束 · 对照与下一期建议</span>
        </button>
        <div class="acts-grid">
          <button class="act" @click="evidenceOpen = true">
            <Info :size="17" />为什么是这样<span>3 条研究曲线</span>
          </button>
          <button class="act" @click="startReview">
            <Wand2 :size="17" />AI 本周复盘<span>看数据调下一周</span>
          </button>
          <button v-if="!isEnded" class="act" @click="openShopping">
            <ShoppingBag :size="17" />本周采购清单<span>未来 7 天食材汇总</span>
          </button>
          <button class="act" @click="openAdjust">
            <Sparkles :size="17" />手动调参<span>缺口 / 蛋白 / 频率</span>
          </button>
        </div>
        <div class="acts-minor">
          <button v-if="!isEnded" class="cap" @click="archiveCurrent">
            <Archive :size="14" />归档方案
          </button>
          <button class="cap danger" :class="{ armed: deleteArmed }" @click="deleteCurrent">
            <Trash2 :size="14" />
            {{ deleteArmed ? '再点一次确认删除' : '删除方案' }}
          </button>
        </div>
      </section>

      <!-- 参数演进：调整历史画成双泳道图，点节点看 diff -->
      <ProgramEvolutionChart
        v-if="adjustments.length"
        :adjustments="adjustments"
        :goal="store.active.goal"
      />

      <!-- 手动调参 -->
      <SheetModal :open="adjustOpen" title="手动调参" @close="adjustOpen = false">
        <div class="form">
          <!-- 上下界一律取 ADJUSTMENT_LIMITS，避免与引擎的钳制口径漂移 -->
          <NumberStepper
            v-model="patchDelta"
            label="每日热量偏移（大卡）"
            :step="50"
            :min="ADJUSTMENT_LIMITS.kcalDeltaMin"
            :max="ADJUSTMENT_LIMITS.kcalDeltaMax"
          />
          <NumberStepper
            v-model="patchProtein"
            label="蛋白质（g/kg 体重）"
            :step="0.1"
            :min="ADJUSTMENT_LIMITS.proteinPerKgMin"
            :max="ADJUSTMENT_LIMITS.proteinPerKgMax"
          />
          <NumberStepper
            v-model="patchDays"
            label="每周训练天数"
            :min="0"
            :max="ADJUSTMENT_LIMITS.trainingDaysMax"
          />
          <input v-model="manualSummary" class="sumin" placeholder="一句话原因（可选）">
          <button class="primary" :disabled="adjusting" @click="applyManual">
            {{ adjusting ? '应用中…' : '应用并重排今日起的日程' }}
          </button>
        </div>
      </SheetModal>

      <!-- AI 复盘：数据先行 + 建议逐条采纳 -->
      <ProgramReviewSheet
        :open="reviewOpen"
        :phase="review.phase"
        :error="review.error"
        :diagnosis="review.diagnosis"
        :advice="review.advice"
        :proposed="review.proposed"
        :current="blob?.params ?? null"
        :compare="reviewCompare"
        @apply="applyReview"
        @retry="startReview"
        @close="reviewOpen = false"
      />

      <!-- 本周采购清单：未来 7 天菜单食材按类聚合（AI 菜单按 id、模板菜单解析展示串） -->
      <SheetModal :open="shoppingOpen" title="本周采购清单" @close="shoppingOpen = false">
        <div v-if="shoppingLoading" class="shop-state center"><span class="t-3">正在汇总菜单食材…</span></div>
        <div v-else-if="shoppingError" class="shop-state center"><span class="ai-err">{{ shoppingError }}</span></div>
        <template v-else>
          <div class="shop-head">
            <p class="shop-note num">{{ shoppingRangeLabel }}<span class="t-3">{{ shoppingSourceLabel ? ` · ${shoppingSourceLabel}` : '' }}</span></p>
            <button v-if="shoppingCheckedCount" class="linkbtn" @click="clearChecks">清空勾选</button>
          </div>
          <p v-if="!shoppingRows.length" class="shop-state center"><span class="t-3">范围内没有可汇总的菜单</span></p>
          <div v-for="g in shoppingGroups" :key="g.name" class="shop-group">
            <p class="g-name">{{ g.name }}</p>
            <ul class="shop-list">
              <li v-for="r in g.rows" :key="r.key">
                <button class="s-row" :class="{ done: r.checked }" @click="toggleCheck(r)">
                  <CheckCircle2 v-if="r.checked" :size="15" class="s-check on" />
                  <Circle v-else :size="15" class="s-check" />
                  <span class="s-label">{{ r.label }}</span>
                  <span class="s-days t-3 num">{{ r.days }}天</span>
                  <b class="s-amt num">{{ amountText(r) }}</b>
                </button>
              </li>
            </ul>
          </div>
          <p v-if="shoppingRows.length && shoppingHasTemplate" class="shop-hint t-3">
            含模板菜单的估算份量 · 在对应日期点「AI 生成这一天的菜单」可按目标校准
          </p>
          <button v-if="shoppingRows.length" class="primary shop-copy" @click="copyShopping">
            {{ shoppingCopyErr || (shoppingCopied ? '已复制到剪贴板' : '复制全文') }}
          </button>
        </template>
      </SheetModal>

      <!-- 智能添加（food 模式）：文字/图片描述 → 食物卡确认写入；餐次可由下一餐预选 -->
      <SmartAddSheet :open="smartAddOpen" mode="food" :date="todayStr()" :default-meal="smartAddMeal" @close="smartAddOpen = false" />

      <!-- 页头「⋯」：低频方案操作的收纳入口（胶囊快捷钮的双通道备份） -->
      <ActionSheet :open="moreOpen" title="方案操作" :actions="moreActions" @select="onMore" @close="moreOpen = false" />

    </template>

    <!-- 历史方案（归档）：点开看结营成绩单 -->
    <section v-if="archivedList.length" class="card">
      <header class="row between">
        <h2>历史方案</h2>
        <span class="t-3 num">{{ archivedList.length }} 份</span>
      </header>
      <ul class="hist-list">
        <li v-for="r in archivedList" :key="r.id">
          <button class="hist-item pressable row between center" @click="openWrapup(r)">
            <span class="col" style="gap: 2px; min-width: 0">
              <b>{{ GOAL_LABELS[r.goal] }} · {{ tierLabel(r.tier) }} · v{{ r.version }}</b>
              <em class="t-3 num">{{ reportSpanOf(r) }} · 调整 {{ adjustmentsOf(r) }} 次</em>
            </span>
            <span class="hist-cta">结营成绩单 ›</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- 档位科学依据：setup 与生效态共用，档位随上下文切换 -->
    <ProgramEvidenceSheet
      :open="evidenceOpen"
      :tier="evidenceTier"
      @close="evidenceOpen = false"
    />
  </div>
</template>

<style scoped>
/* flex + gap 统一卡片间距：生效页的卡片来自多个子组件（.card / .pod 混排），
   全局 .card + .card 的相邻选择器跨组件会断链，这里由页面容器统一负责 */
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page > .card + .card {
  margin-top: 0; /* 全局规则的 14px 已由 gap 提供，避免叠加 */
}

.empty {
  padding: 40px 0;
}

.card h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.primary {
  width: 100%;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: 0.45;
}

.linkbtn {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

/* 科学依据入口：选档时最需要「为什么」，做成文字链不抢主按钮 */
.why-link {
  display: block;
  width: 100%;
  margin: 4px 0 12px;
  text-align: center;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

/* 引导与档位卡样式已随 01/02/03 组件化移除 */

.warn {
  background: var(--danger-soft);
  color: var(--text-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.stats em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.stats b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.stats i {
  font-style: normal;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}

/* 状态条：一行概要 + 可展开参数详情（example 对齐） */
.head-strip {
  flex: none;
}

.strip {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
  text-align: left;
}

.strip .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strip .end {
  flex: none;
  font-size: var(--fs-caption);
}

.strip .chev {
  flex: none;
  transition: transform var(--dur-base) var(--ease-sheet);
}

.strip .chev.open {
  transform: rotate(90deg);
}

.strip-detail {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition:
    max-height var(--dur-sheet) var(--ease-sheet),
    opacity var(--dur-base) var(--ease-standard);
}

.strip-detail.open {
  max-height: 160px;
  opacity: 1;
}

.strip-detail .stats {
  margin: 10px 0 0;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.strip-meta {
  margin: 7px 2px 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

@media (prefers-reduced-motion: reduce) {
  .strip-detail,
  .strip .chev {
    transition: none;
  }
}

/* 操作区：高频操作 2 列网格，归档 / 删除降级为文字链 */
.acts {
  display: grid;
  gap: 12px;
}

.acts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
}

.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 14px 8px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 600;
  text-align: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.act:active {
  transform: scale(0.97);
}

.act span {
  font-weight: 400;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.acts-minor {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

/* 归档 / 删除：胶囊按钮——低频但有引导性，危险项 armed 态红底强化 */
.cap {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.cap:active {
  transform: scale(0.96);
}

.cap.danger {
  color: var(--danger);
}

.cap.danger.armed {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
  font-weight: 700;
}

.acts .primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.acts .primary .t-3 {
  font-size: var(--fs-micro);
  font-weight: 400;
  opacity: 0.8;
}

/* 采购清单弹层 */
.shop-state {
  padding: 36px 0;
}

.shop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.shop-note {
  margin: 0 0 12px;
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.shop-group {
  margin-bottom: 16px;
}

.shop-group .g-name {
  margin: 0 0 4px;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-3);
}

.shop-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.s-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 9px 0;
  background: none;
  border: none;
  border-top: 0.5px solid var(--line);
  text-align: left;
  font: inherit;
  color: inherit;
}

.shop-group .shop-list li:first-child .s-row {
  border-top: none;
}

.s-check {
  flex: none;
  align-self: center;
  color: var(--text-3);
}

.s-check.on {
  color: var(--accent);
}

.s-row.done .s-label,
.s-row.done .s-amt {
  color: var(--text-3);
}

.s-row.done .s-label {
  text-decoration: line-through;
}

.s-label {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.s-days {
  white-space: nowrap;
}

.s-amt {
  min-width: 64px;
  text-align: right;
  font-size: var(--fs-subhead);
}

.shop-hint {
  margin: 4px 0 0;
}

.shop-copy {
  width: 100%;
  margin-top: 14px;
}

/* 历史方案列表 */
.hist-list li + li {
  border-top: 0.5px solid var(--line);
}

.hist-item {
  width: 100%;
  gap: 10px;
  padding: 11px 0;
  text-align: left;
}

.hist-item b {
  font-size: var(--fs-subhead);
}

.hist-item em {
  font-style: normal;
  font-size: var(--fs-caption);
}

.hist-cta {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

/* 执行报告样式已随结营成绩单页移除 */

/* 弹层表单 */
.form {
  display: grid;
  gap: 16px;
  padding-bottom: 20px;
}

.confirm-list {
  display: grid;
  gap: 6px;
  list-style: disc inside;
  line-height: 1.5;
}

.sumin {
  padding: 10px 12px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}
</style>
