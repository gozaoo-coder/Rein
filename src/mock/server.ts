/**
 * 浏览器开发用内存后端：与 Rust 后端实现同一套命令契约。
 * 仅在非 Tauri 环境（`npm run dev` 直接开网页）时被 transport.ts 动态加载，
 * 附带少量演示数据便于 UI 迭代；正式数据路径永远是 Rust + SQLite。
 */
import seedJson from '@resources/foods.json'
import seedPlansJson from '@resources/workout_plans.json'
import seedExercisesJson from '@resources/exercises.json'

import type {
  AiChatMessage,
  AiChatMessageInput,
  AiModel,
  AiModelInput,
  AiProbeResult,
  AiUsageByModel,
  AiUsageInput,
  AiUsageSummary,
  AiUsageTotals,
  BodyMetric,
  BodyMetricInput,
  CalcState,
  ChatSearchHit,
  DailySummary,
  DailyTargets,
  ExerciseCategory,
  ExerciseEquipment,
  ExerciseInput,
  ExerciseKind,
  ExerciseRecord,
  Food,
  FoodCreateInput,
  GrabSettings,
  GrabIntent,
  GrabMatch,
  GrabState,
  GrabTurnBrief,
  LedgerEntry,
  LedgerEntryInput,
  LedgerSettings,
  MealLog,
  NutrientIntake,
  ParsedFoodItem,
  RecipePref,
  PomodoroSession,
  PlanSeedStatus,
  ProgramRecord,
  Profile,
  OnlineCatalog,
  ScheduleTodoInput,
  TargetAdjustProposal,
  TargetChange,
  Todo,
  UpdateCheck,
  UpdateSettings,
  UpdateSettingsPatch,
  UpdateSnapshot,
  DownloadState,
  SourceReport,
  Workout,
  WorkoutPlanInput,
  WorkoutPlanRecord,
} from '@/types'
import { addDays, startOfMonth, startOfWeek, todayStr } from '@/utils/date'
import { ruleMatchesDate } from '@/utils/recurrence'
import { COURSE_CATEGORY } from '@/types/todo'

/* ---------------- 种子载入 ---------------- */

interface SeedFood {
  name: string
  category: string
  kcal: number
  protein: number
  carb: number
  fat: number
  fiber: number
  sugar: number
  sodiumMg: number
  potassiumMg: number
  calciumMg: number
  ironMg: number
  zincMg: number
  magnesiumMg: number
  vitAUg: number
  vitCMg: number
  vitDUg: number
  vitEMg: number
  vitB12Ug: number
  folateUg: number
  defaultUnit: string
  units: { name: string; grams: number }[]
}

const seed = seedJson as unknown as { foods: SeedFood[] }

const NUTRIENT_KEYS = [
  'kcal', 'protein', 'carb', 'fat', 'fiber', 'sugar',
  'sodiumMg', 'potassiumMg', 'calciumMg', 'ironMg', 'zincMg', 'magnesiumMg',
  'vitAUg', 'vitCMg', 'vitDUg', 'vitEMg', 'vitB12Ug', 'folateUg',
] as const satisfies readonly (keyof NutrientIntake)[]

function zeroIntake(): NutrientIntake {
  const zero = {} as NutrientIntake
  for (const k of NUTRIENT_KEYS) zero[k] = 0
  return zero
}

/* ---------------- 内存数据库 ---------------- */

let foodId = 0
const foods: Food[] = seed.foods.map((f) => ({ id: ++foodId, ...f }))

const today = todayStr()
const yesterday = addDays(today, -1)
const weekStart = startOfWeek(today)

let mealId = 0
const meals: MealLog[] = []

/** 食谱偏好（与 Rust recipe_prefs 表同契约） */
const recipePrefs: RecipePref[] = []

let todoId = 0
const todos: Todo[] = []

/** 健康方案（与 Rust programs 表同契约） */
let programId = 0
const programs: ProgramRecord[] = []

/** 每日 AI 菜单缓存（与 Rust program_meals 表同契约） */
const programMeals: { programId: number; date: string; mealsJson: string; updatedAt: string }[] = []

/** 采购清单勾选状态（与 Rust shopping_checks 表同契约） */
const shoppingChecks: { itemKey: string; checkedAt: string }[] = []

let workoutId = 0
const workouts: Workout[] = []

let sessionId = 0
interface MockSession {
  id: number
  planId: string
  planName: string
  status: 'active' | 'finished' | 'aborted'
  startedAt: string
  updatedAt: string
  exIndex: number
  setIndex: number
  weightKg: number
  elapsedSec: number
  state: Record<string, unknown>
}
const sessions: MockSession[] = []
const SESSION_STORE_KEY = 'rein.mock.sessions.v1'

/** 会话存储走 localStorage：模拟真实后端的持久化（页面刷新/重启不丢），
 *  用于验证「中断恢复」链路；后端真实实现是 SQLite workout_sessions 表。 */
function loadSessions(): void {
  try {
    const raw = localStorage.getItem(SESSION_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as MockSession[]
      sessions.push(...list)
      sessionId = Math.max(sessionId, ...list.map((s) => s.id), 0)
    }
  } catch {
    /* 忽略损坏数据，按空处理 */
  }
}

function saveSessions(): void {
  try {
    localStorage.setItem(SESSION_STORE_KEY, JSON.stringify(sessions))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadSessions()

/* ---------------- 逐组做组记录（与 Rust workout_sets 表同契约） ---------------- */

/** 重量曲线数据源：session_finish 时展开落行；exercise_id 是聚合键（动作库），
 *  exercise_name 只是历史快照（与 Rust workout_sets 同契约） */
interface MockStrengthSet {
  id: number
  workoutId: number
  planId: string | null
  exerciseKey: string
  exerciseId: string
  exerciseName: string
  setNo: number
  kind: string
  weightKg: number | null
  reps: number | null
  sec: number | null
  warmup: boolean
  createdAt: string
}

let strengthSetId = 0
const strengthSets: MockStrengthSet[] = []
const SETS_STORE_KEY = 'rein.mock.sets.v1'
/**
 * 演示做组明细的种子版本。strengthSets 持久化在 localStorage，而演示播种写在模块
 * 顶层——若不设版本闸门，每次页面加载都会再叠一份演示行（20 → 40 → 60…），
 * 污染力量曲线与「上次重量」，且 localStorage 无上限增长。
 */
const SETS_SEED_VER_KEY = 'rein.mock.sets.seedVer.v1'
const SETS_SEED_VERSION = 1
let setsSeeded = false

function loadSets(): void {
  try {
    const raw = localStorage.getItem(SETS_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as MockStrengthSet[]
      strengthSets.push(...list)
      strengthSetId = Math.max(strengthSetId, ...list.map((s) => s.id), 0)
    }
    setsSeeded = Number(localStorage.getItem(SETS_SEED_VER_KEY) ?? '0') >= SETS_SEED_VERSION
  } catch {
    /* 忽略损坏数据，按空处理 */
  }
}

/** 播种完成后落版本位；升版或用户清库后自动补种一次 */
function markSetsSeeded(): void {
  setsSeeded = true
  try {
    localStorage.setItem(SETS_SEED_VER_KEY, String(SETS_SEED_VERSION))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveSets(): void {
  try {
    localStorage.setItem(SETS_STORE_KEY, JSON.stringify(strengthSets))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadSets()

/* ---------------- 课程库（与 Rust workout_plans 表同契约） ---------------- */

interface SeedPlan {
  id: string
  name: string
  subtitle: string
  workoutType: string
  exercises: unknown[]
  equipment?: 'gym' | 'home' | null
  estDurationMin?: number | null
}

const plans: WorkoutPlanRecord[] = []
const PLAN_STORE_KEY = 'rein.mock.plans.v1'
/**
 * 内置课程种子版本：种子内容变更时 +1。
 * v5 起语义：启动只做增量补种（补齐缺失的内置课），内容升级不再自动覆盖；
 * 由前端发起「兼容合并 / 使用新版本 / 保留我的」三选一（与 Rust 端 seed.rs 一致）。
 */
const PLAN_SEED_VERSION = 5
const PLAN_SEED_VER_KEY = 'rein.mock.plans.seedVer.v1'
/** 已应用（兼容合并或使用新版本）的目标版本；0 = 未应用 */
const PLAN_SEED_APPLIED_KEY = 'rein.mock.plans.applied.v1'

/**
 * 与会话一致：localStorage 持久化，模拟真实库的「用户编辑不丢失」。
 * 种子导入与 Rust 端 seed_builtin_plans 同语义：按 id 幂等补齐缺失项，
 * 已有行（含用户改过的）永不覆盖；种子版本升级后由前端决定如何应用（v5 起）。
 */
function loadPlans(): void {
  try {
    const raw = localStorage.getItem(PLAN_STORE_KEY)
    if (raw) {
      const list = JSON.parse(raw) as WorkoutPlanRecord[]
      plans.push(...list)
    }
  } catch {
    /* 损坏数据按空处理，走种子 */
  }

  let applied = 0
  try {
    applied = Number(localStorage.getItem(PLAN_SEED_APPLIED_KEY) ?? '0')
  } catch {
    /* 读不到按 0 */
  }
  // 已应用当前版本：仍要补缺失的内置课，但不再改动已有行
  const known = new Set(plans.map((p) => p.id))
  const now = new Date().toISOString()
  for (const p of (seedPlansJson as { plans: SeedPlan[] }).plans) {
    if (!known.has(p.id)) {
      plans.push({
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        workoutType: p.workoutType as WorkoutPlanRecord['workoutType'],
        exercises: structuredClone(p.exercises) as WorkoutPlanRecord['exercises'],
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
        equipment: p.equipment ?? null,
        estDurationMin: p.estDurationMin ?? null,
      })
    }
  }
  // 从未导入过种子（首次安装）：直接按最新版本导入并结清
  let ver = 0
  try {
    ver = Number(localStorage.getItem(PLAN_SEED_VER_KEY) ?? '0')
  } catch {
    /* 读不到按 0 */
  }
  if (ver === 0 && applied === 0) {
    localStorage.setItem(PLAN_SEED_VER_KEY, String(PLAN_SEED_VERSION))
  }
  savePlans()
}

/** 种子升级状态（模拟 Rust plan_seed_status）：已应用版本 = 决策版本 */
function planSeedStatus(): PlanSeedStatus {
  let applied = 0
  try {
    applied = Number(localStorage.getItem(PLAN_SEED_APPLIED_KEY) ?? '0')
  } catch {
    applied = 0
  }
  return {
    currentVersion: applied || Number(localStorage.getItem(PLAN_SEED_VER_KEY) ?? '0'),
    latestVersion: PLAN_SEED_VERSION,
  }
}

function settleSeed(appliedVersion: number): void {
  try {
    localStorage.setItem(PLAN_SEED_APPLIED_KEY, String(appliedVersion))
    localStorage.setItem(PLAN_SEED_VER_KEY, String(PLAN_SEED_VERSION))
  } catch {
    /* 写不进去时下次启动重跑，幂等无害 */
  }
}

/** 兼容合并：字段级合并新种子到本地内置课，不覆盖用户设置（与 Rust merge_plan_exercises 同语义） */
function migratePlans(): void {
  const seed = (seedPlansJson as { plans: SeedPlan[] }).plans
  const now = new Date().toISOString()
  for (const p of seed) {
    const row = plans.find((x) => x.id === p.id)
    if (!row) continue
    const local = (Array.isArray(row.exercises) ? row.exercises : []) as unknown as Array<Record<string, unknown>>
    const seedEx = (Array.isArray(p.exercises) ? p.exercises : []) as unknown as Array<Record<string, unknown>>
    const localMap = new Map(local.map((e) => [e.id, e]))
    const out: Array<Record<string, unknown>> = []
    for (const se of seedEx) {
      const id = se.id as string | undefined
      const le = id ? localMap.get(id) : undefined
      if (le) {
        // 只补本地缺失的字段，已有的（含用户改过的）保留
        const merged = { ...le }
        for (const [k, v] of Object.entries(se)) {
          if (!(k in merged)) merged[k] = v
        }
        out.push(merged)
      } else {
        out.push(se) // 新动作：整条补上
      }
    }
    // 本地独有的动作（用户新增）保留
    const seedIds = new Set(seedEx.map((e) => e.id))
    for (const le of local) {
      if (le.id && !seedIds.has(le.id)) out.push(le)
    }
    row.exercises = out as unknown as WorkoutPlanRecord['exercises']
    row.updatedAt = now
  }
  settleSeed(PLAN_SEED_VERSION)
  savePlans()
  backfillExerciseRefs() // 种子内容不含动作库 id：合并后立刻挂回（幂等）
}

/** 使用新版本：内置课内容整体替换为新种子 */
function overridePlans(): void {
  const seed = (seedPlansJson as { plans: SeedPlan[] }).plans
  const now = new Date().toISOString()
  for (const p of seed) {
    const row = plans.find((x) => x.id === p.id)
    if (!row) continue
    row.subtitle = p.subtitle
    row.exercises = structuredClone(p.exercises) as WorkoutPlanRecord['exercises']
    row.updatedAt = now
  }
  settleSeed(PLAN_SEED_VERSION)
  savePlans()
  backfillExerciseRefs() // 覆盖进来的种子内容不含动作库 id：立刻挂回（幂等）
}

/** 保留我的：本版本不再刷新内置课内容，只结清提示 */
function keepPlans(): void {
  settleSeed(PLAN_SEED_VERSION)
}

function savePlans(): void {
  try {
    localStorage.setItem(PLAN_STORE_KEY, JSON.stringify(plans))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/** 与 Rust list_workout_plans 的 ORDER BY 保持一致：最近使用的在前 */
function sortedPlans(): WorkoutPlanRecord[] {
  return [...plans].sort(
    (a, b) =>
      (a.lastUsedAt ? 0 : 1) - (b.lastUsedAt ? 0 : 1) ||
      (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

loadPlans()

/* ---------------- 动作库（与 Rust exercises 表同契约，0025） ---------------- */

interface SeedExercise {
  id: string
  name: string
  aliases?: string[]
  kind: string
  category: string
  equipment?: string | null
  muscles?: Record<string, number>
  tips?: string
  defaultSets: number
  defaultReps?: number | null
  defaultWeightKg?: number | null
  defaultTargetSec?: number | null
  defaultDurationMin?: number | null
  defaultRestSec: number
  weightStep: number
}

const exercises: ExerciseRecord[] = []
/** 只持久化自建动作：内置动作每次启动按种子覆盖式刷新（与 Rust seed_exercises 同语义） */
const EXERCISE_STORE_KEY = 'rein.mock.exercises.v1'
/** 用户隐藏的内置动作 id */
const EXERCISE_HIDDEN_KEY = 'rein.mock.exercises.hidden.v1'

function loadExercises(): void {
  let custom: ExerciseRecord[] = []
  let hidden: string[] = []
  try {
    custom = JSON.parse(localStorage.getItem(EXERCISE_STORE_KEY) ?? '[]') as ExerciseRecord[]
    hidden = JSON.parse(localStorage.getItem(EXERCISE_HIDDEN_KEY) ?? '[]') as string[]
  } catch {
    /* 损坏数据按空处理 */
  }
  const hiddenSet = new Set(hidden)
  const seed = seedExercisesJson as unknown as { exercises: SeedExercise[] }
  for (const e of seed.exercises) {
    exercises.push({
      id: e.id,
      name: e.name,
      aliases: e.aliases ?? [],
      kind: e.kind as ExerciseKind,
      category: e.category as ExerciseCategory,
      equipment: (e.equipment ?? null) as ExerciseEquipment | null,
      muscles: (e.muscles ?? {}) as ExerciseRecord['muscles'],
      tips: e.tips ?? '',
      defaultSets: e.defaultSets,
      defaultReps: e.defaultReps ?? null,
      defaultWeightKg: e.defaultWeightKg ?? null,
      defaultTargetSec: e.defaultTargetSec ?? null,
      defaultDurationMin: e.defaultDurationMin ?? null,
      defaultRestSec: e.defaultRestSec,
      weightStep: e.weightStep,
      isCustom: false,
      hidden: hiddenSet.has(e.id),
      sessions: 0,
      lastUsedAt: null,
    })
  }
  for (const c of custom) exercises.push({ ...c, isCustom: true, hidden: false })
}

function saveExercises(): void {
  try {
    localStorage.setItem(
      EXERCISE_STORE_KEY,
      JSON.stringify(exercises.filter((e) => e.isCustom)),
    )
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveExerciseHidden(): void {
  try {
    localStorage.setItem(
      EXERCISE_HIDDEN_KEY,
      JSON.stringify(exercises.filter((e) => !e.isCustom && e.hidden).map((e) => e.id)),
    )
  } catch {
    /* 同上 */
  }
}

/** 名称（或别名）精确匹配；名字已被 trim/规范化 */
function findExerciseByName(name: string): ExerciseRecord | undefined {
  const key = name.trim()
  return exercises.find((e) => e.name === key || e.aliases.includes(key))
}

interface ExerciseHint {
  kind?: string
  sets?: number | null
  reps?: number | null
  weightKg?: number | null
  targetSec?: number | null
  durationMin?: number | null
  restSec?: number | null
  tips?: string | null
}

/** 按名解析库 id；未命中则新建自建动作（与 Rust resolve::ensure_for_name 同语义） */
function ensureExerciseForName(name: string, hint: ExerciseHint = {}): string {
  const trimmed = name.trim() || '未命名动作'
  const hit = findExerciseByName(trimmed)
  if (hit) return hit.id
  const id = `custom-${crypto.randomUUID()}`
  const kind = (hint.kind ?? 'strength') as ExerciseKind
  exercises.push({
    id,
    name: trimmed,
    aliases: [],
    kind,
    category: 'other',
    equipment: null,
    muscles: {},
    tips: hint.tips ?? '',
    defaultSets: hint.sets ?? 3,
    defaultReps: hint.reps ?? null,
    defaultWeightKg: hint.weightKg ?? null,
    defaultTargetSec: hint.targetSec ?? null,
    defaultDurationMin: hint.durationMin ?? null,
    defaultRestSec: hint.restSec ?? 90,
    weightStep: kind === 'strength' ? 2.5 : 0,
    isCustom: true,
    hidden: false,
    sessions: 0,
    lastUsedAt: null,
  })
  saveExercises()
  return id
}

/** 课程条目一律经动作库解析（缺 exerciseId 的按名挂库），与 Rust 写入路径同语义 */
function resolvePlanExerciseIds(list: unknown[]): unknown[] {
  return list.map((raw) => {
    const item = raw as Record<string, unknown>
    if (typeof item.exerciseId === 'string' && item.exerciseId) return item
    const name = typeof item.name === 'string' ? item.name : ''
    if (!name.trim()) return item
    const id = ensureExerciseForName(name, {
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      sets: typeof item.sets === 'number' ? item.sets : null,
      reps: typeof item.reps === 'number' ? item.reps : null,
      weightKg: typeof item.weightKg === 'number' ? item.weightKg : null,
      targetSec: typeof item.targetSec === 'number' ? item.targetSec : null,
      durationMin: typeof item.durationMin === 'number' ? item.durationMin : null,
      restSec: typeof item.restSec === 'number' ? item.restSec : null,
      tips: typeof item.tips === 'string' ? item.tips : null,
    })
    return { ...item, exerciseId: id }
  })
}

/** 存量回填（幂等）：课程条目与做组记录都挂上库 id（与 Rust backfill_exercise_refs 同语义） */
function backfillExerciseRefs(): void {
  let setsChanged = false
  for (const s of strengthSets) {
    if (s.exerciseId) continue
    s.exerciseId = ensureExerciseForName(s.exerciseName, {
      kind: s.kind,
      weightKg: s.weightKg,
      reps: s.reps,
    })
    setsChanged = true
  }
  if (setsChanged) saveSets()

  let plansChanged = false
  for (const p of plans) {
    const arr = Array.isArray(p.exercises) ? (p.exercises as unknown[]) : []
    const next = resolvePlanExerciseIds(arr)
    if (JSON.stringify(next) !== JSON.stringify(arr)) {
      p.exercises = next as WorkoutPlanRecord['exercises']
      plansChanged = true
    }
  }
  if (plansChanged) savePlans()
}

/** 使用统计（sessions / lastUsedAt）：查询时按做组记录现算 */
function exerciseUsage(id: string): { sessions: number; lastUsedAt: string | null } {
  const ids = new Set<number>()
  let last: string | null = null
  for (const r of strengthSets) {
    if (r.exerciseId !== id) continue
    ids.add(r.workoutId)
    const w = workouts.find((x) => x.id === r.workoutId)
    const date = w?.date ?? r.createdAt.slice(0, 10)
    if (!last || date > last) last = date
  }
  return { sessions: ids.size, lastUsedAt: last }
}

/** 「动作库 id 或动作名」→ 库 id（旧调用 / AI 工具兼容，与 Rust resolve_exercise_id 同语义） */
function resolveExerciseId(key: string): string {
  const raw = key.trim()
  if (exercises.some((e) => e.id === raw)) return raw
  return findExerciseByName(raw)?.id ?? raw
}

/** 逐组记录 → 查询行（含 JOIN workouts 的日期与库内展示名） */
function strengthRecord(r: MockStrengthSet) {
  const w = workouts.find((x) => x.id === r.workoutId)
  return {
    workoutId: r.workoutId,
    date: w?.date ?? r.createdAt.slice(0, 10),
    exerciseKey: r.exerciseKey,
    exerciseId: r.exerciseId || null,
    exerciseName: exercises.find((e) => e.id === r.exerciseId)?.name ?? r.exerciseName,
    kind: r.kind,
    setNo: r.setNo,
    weightKg: r.weightKg,
    reps: r.reps,
    sec: r.sec,
    warmup: r.warmup,
  }
}

loadExercises()

let pomodoroSeq = 0
const pomodoroSessions: PomodoroSession[] = []

/* ---------------- 方案计算器快照 + 体重身高追踪（与 Rust calc_params / body_metrics 同契约） ---------------- */

interface MockBodyStore {
  /** null = 计算器从未保存过参数 */
  calc: CalcState | null
  metrics: BodyMetric[]
}

const bodyStore: MockBodyStore = { calc: null, metrics: [] }
let metricId = 0
const BODY_STORE_KEY = 'rein.mock.body.v1'

function loadBody(): void {
  try {
    const raw = localStorage.getItem(BODY_STORE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as MockBodyStore
    bodyStore.calc = data.calc ?? null
    bodyStore.metrics.push(...(data.metrics ?? []))
    metricId = Math.max(metricId, ...bodyStore.metrics.map((m) => m.id), 0)
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveBody(): void {
  try {
    localStorage.setItem(BODY_STORE_KEY, JSON.stringify(bodyStore))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/** 首次载入的演示数据：近八周体重缓降（截图 / 演示友好） */
function seedMetricsIfEmpty(): void {
  let has = false
  try {
    has = localStorage.getItem(BODY_STORE_KEY) != null
  } catch {
    /* 无存储环境时仍提供演示数据 */
  }
  if (has) return
  for (let w = 8; w >= 1; w--) {
    const date = addDays(today, -w * 7)
    const weightKg = Math.round((72.6 - (8 - w) * 0.32) * 10) / 10
    bodyStore.metrics.push({ id: ++metricId, date, weightKg, heightCm: 175, createdAt: `${date}T08:30:00` })
  }
  saveBody()
}

loadBody()
seedMetricsIfEmpty()

/* ---------------- AI：模型配置 + 聊天历史（localStorage，与真实后端同契约） ---------------- */

interface MockAiChat {
  id: string
  seq: number
  messages: AiChatMessage[]
  title: string
  createdAt: string
  updatedAt: string
}

const aiModels: AiModel[] = []
const aiChats = new Map<string, MockAiChat>()
let aiModelId = 0
const AI_MODEL_STORE_KEY = 'rein.mock.ai_models.v1'
const AI_CHAT_STORE_KEY = 'rein.mock.ai_chats.v1'

function loadAiStore(): void {
  try {
    const rawModels = localStorage.getItem(AI_MODEL_STORE_KEY)
    if (rawModels) {
      aiModels.push(...(JSON.parse(rawModels) as AiModel[]))
      aiModelId = Math.max(aiModelId, ...aiModels.map((m) => m.id), 0)
    }
    const rawChats = localStorage.getItem(AI_CHAT_STORE_KEY)
    if (rawChats) {
      for (const c of JSON.parse(rawChats) as MockAiChat[]) {
        aiChats.set(c.id, c)
      }
    }
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveAiModels(): void {
  try {
    localStorage.setItem(AI_MODEL_STORE_KEY, JSON.stringify(aiModels))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

/* ---- Rein 在线服务（浏览器演示的假服务端） + 本机成本账本 ---- */

const ONLINE_STORE_KEY = 'rein.mock.online_service.v1'
const AI_USAGE_STORE_KEY = 'rein.mock.ai_usage.v1'

let mockOnlineSettings = { baseUrl: 'http://47.100.36.179:8787', apiKey: '', savedAt: null as string | null }
let aiUsage: (AiUsageInput & { at: string })[] = []

/** 演示用目录：与真服务端 /v1/models 的 rein 扩展字段同构 */
const MOCK_ONLINE_MODELS = [
  { id: 'deepseek-flash', providerId: 'deepseek', providerName: 'DeepSeek', priceIn: 2, priceOut: 8 },
  { id: 'deepseek-v4-pro', providerId: 'deepseek', providerName: 'DeepSeek', priceIn: 9, priceOut: 27 },
  { id: 'qwen3-max', providerId: 'dashscope', providerName: '阿里云百炼', priceIn: 0, priceOut: 0 },
]

function buildMockCatalog(baseUrl: string, apiKey: string): OnlineCatalog {
  const base = (baseUrl || mockOnlineSettings.baseUrl).replace(/\/+$/, '')
  const key = (apiKey || mockOnlineSettings.apiKey).trim()
  const offline = mockFlag('__REIN_MOCK_SERVICE_OFFLINE__')
  const ok = Boolean(key) && !offline
  return {
    baseUrl: base,
    ok,
    status: ok ? 'ready' : offline ? 'unreachable' : 'unauthorized',
    modelsEndpoint: `${base}/v1/models`,
    chatEndpoint: `${base}/v1/chat/completions`,
    currency: 'CNY',
    trafficPerGb: 0.8,
    trafficScope: 'egress',
    clientName: ok ? '浏览器演示' : null,
    clientModels: [],
    models: ok
      ? MOCK_ONLINE_MODELS.map((m) => ({
          ...m,
          priced: m.priceIn > 0 || m.priceOut > 0,
          currency: 'CNY',
          unit: 'per_1m_tokens',
        }))
      : [],
    error: ok ? null : offline ? `无法连接 ${base}/v1/models` : '还没有填服务密钥（rein_sk_…）',
    checkedAt: new Date().toISOString(),
    elapsedMs: 12,
  }
}

function saveMockOnline(): void {
  try {
    localStorage.setItem(ONLINE_STORE_KEY, JSON.stringify(mockOnlineSettings))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function saveMockUsage(): void {
  try {
    localStorage.setItem(AI_USAGE_STORE_KEY, JSON.stringify(aiUsage))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

function loadMockOnlineAndUsage(): void {
  try {
    const rawOnline = localStorage.getItem(ONLINE_STORE_KEY)
    if (rawOnline) mockOnlineSettings = { ...mockOnlineSettings, ...(JSON.parse(rawOnline) as typeof mockOnlineSettings) }
    const rawUsage = localStorage.getItem(AI_USAGE_STORE_KEY)
    if (rawUsage) aiUsage = JSON.parse(rawUsage) as typeof aiUsage
  } catch {
    /* 损坏数据按空处理 */
  }
}

/** 本机账本汇总：与 Rust `ai_usage_summary` 同结构 */
function summarizeMockUsage(rows: typeof aiUsage, days: number, since: string): AiUsageSummary {
  const blank = (): AiUsageTotals => ({
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestBytes: 0,
    responseBytes: 0,
    costModelNano: 0,
    costTrafficNano: 0,
    costTotalNano: 0,
  })
  const add = (b: AiUsageTotals, u: (typeof aiUsage)[number]): AiUsageTotals => ({
    calls: b.calls + 1,
    promptTokens: b.promptTokens + (u.promptTokens ?? 0),
    completionTokens: b.completionTokens + (u.completionTokens ?? 0),
    requestBytes: b.requestBytes + (u.requestBytes ?? 0),
    responseBytes: b.responseBytes + (u.responseBytes ?? 0),
    costModelNano: b.costModelNano + (u.costModelNano ?? 0),
    costTrafficNano: b.costTrafficNano + (u.costTrafficNano ?? 0),
    costTotalNano: b.costTotalNano + (u.costModelNano ?? 0) + (u.costTrafficNano ?? 0),
  })

  const total = rows.reduce(add, blank())
  const todayKey = new Date().toISOString().slice(0, 10)
  const today = rows.filter((u) => u.at.slice(0, 10) === todayKey).reduce(add, blank())

  const dayMap = new Map<string, AiUsageTotals>()
  for (const u of rows) {
    const d = u.at.slice(0, 10)
    dayMap.set(d, add(dayMap.get(d) ?? blank(), u))
  }
  const modelMap = new Map<string, AiUsageByModel>()
  for (const u of rows) {
    const key = `${u.modelName}|${u.modelId}|${u.source ?? 'manual'}`
    const cur =
      modelMap.get(key) ??
      ({ modelPk: u.modelPk ?? null, modelName: u.modelName, modelId: u.modelId, source: u.source ?? 'manual', ...blank() } as AiUsageByModel)
    modelMap.set(key, { ...cur, ...add(cur, u) })
  }

  return {
    days,
    since,
    today,
    total,
    byDay: [...dayMap.entries()].map(([date, t]) => ({ date, ...t })).sort((a, b) => (a.date < b.date ? 1 : -1)),
    byModel: [...modelMap.values()].sort((a, b) => b.costTotalNano - a.costTotalNano),
  }
}

loadMockOnlineAndUsage()

function saveAiChats(): void {
  try {
    localStorage.setItem(AI_CHAT_STORE_KEY, JSON.stringify([...aiChats.values()]))
  } catch {
    /* localStorage 不可用时退化为内存态 */
  }
}

loadAiStore()

const defaultTargets: DailyTargets = {
  kcal: 2000,
  protein: 80,
  carb: 250,
  fat: 65,
  sodiumMg: 1500,
  waterMl: 1700,
}

const profile: Profile = {
  nickname: 'Rein 用户',
  sex: null,
  birthday: null,
  heightCm: 175,
  weightKg: 70,
  targetWeightKg: 68,
  activityLevel: 'light',
  goal: 'cut',
  targets: { ...defaultTargets },
  trainingDaysPerWeek: 3,
  preferredTimeSlots: ['evening'],
  equipment: 'gym',
  dietRestrictions: [],
  experience: 'beginner',
}

/* ---------------- 演示数据 ---------------- */

function foodByName(name: string): Food {
  const f = foods.find((x) => x.name.startsWith(name))
  if (!f) throw new Error(`演示数据缺少食物 ${name}`)
  return f
}

function unitGrams(f: Food, unitName: string): number {
  return f.units.find((u) => u.name === unitName)?.grams ?? 100
}

function addMeal(
  foodName: string,
  date: string,
  mealType: MealLog['mealType'],
  qty: { mode: 'grams'; grams: number } | { mode: 'unit'; unit: string; count: number },
  source: MealLog['source'] = 'search',
): void {
  const f = foodByName(foodName)
  const grams = qty.mode === 'grams' ? qty.grams : qty.count * unitGrams(f, qty.unit)
  meals.push({
    id: ++mealId,
    foodId: f.id,
    date,
    mealType,
    quantityMode: qty.mode === 'grams' ? 'grams' : 'unit',
    grams,
    units: qty.mode === 'unit' ? qty.count : null,
    unitName: qty.mode === 'unit' ? qty.unit : null,
    source,
    note: null,
    createdAt: `${date}T08:00:00`,
    food: f,
  })
}

// 今天的三餐（截图 / 演示友好）
addMeal('燕麦片', today, 'breakfast', { mode: 'grams', grams: 40 })
addMeal('鸡蛋', today, 'breakfast', { mode: 'unit', unit: '个', count: 1 })
addMeal('牛奶', today, 'breakfast', { mode: 'unit', unit: '杯', count: 1 })
addMeal('米饭', today, 'lunch', { mode: 'unit', unit: '碗', count: 1 })
addMeal('鸡胸肉', today, 'lunch', { mode: 'grams', grams: 150 })
addMeal('西兰花', today, 'lunch', { mode: 'grams', grams: 150 })
addMeal('蓝莓', today, 'snack', { mode: 'unit', unit: '盒', count: 1 })

function addTodo(t: Partial<Todo> & { title: string; date: string }): void {
  todos.push({
    id: ++todoId,
    title: t.title,
    notes: t.notes ?? null,
    date: t.date,
    startMin: t.startMin ?? null,
    durationMin: t.durationMin ?? null,
    category: t.category ?? 'general',
    priority: t.priority ?? 0,
    status: t.status ?? 'todo',
    completedAt: t.status === 'done' ? `${t.date}T09:00:00` : null,
    createdAt: `${t.date}T07:00:00`,
    programId: t.programId ?? null,
    recRule: t.recRule ?? null,
    recKey: t.recKey ?? null,
    subtasks: t.subtasks ?? null,
  })
}

addTodo({ title: '晨间拉伸', date: today, startMin: 7 * 60 + 20, durationMin: 15, category: 'health', status: 'done' })
addTodo({ title: '午休散步 20 分钟', date: today, startMin: 12 * 60 + 40, durationMin: 20, category: 'health', priority: 1 })
addTodo({ title: '力量训练 · 上肢', date: today, startMin: 18 * 60 + 30, durationMin: 45, category: 'workout', priority: 2 })
addTodo({ title: '写今日复盘', date: today, startMin: 21 * 60 + 30, category: 'study' })
// 未安排池演示：今天要做但还没定时间
addTodo({ title: '预约牙医', date: today, durationMin: 10, category: 'health' })
addTodo({ title: '回复产品反馈', date: today, durationMin: 15, category: 'work', priority: 1 })
addTodo({ title: '阅读《睡眠革命》', date: today, durationMin: 30, category: 'study' })
addTodo({ title: '跑步 5 公里', date: yesterday, startMin: 19 * 60, durationMin: 30, category: 'workout', status: 'done' })
addTodo({ title: '蔬菜摄入达标', date: yesterday, category: 'health', status: 'done' })
addTodo({ title: '整理周报提纲', date: addDays(today, 1), startMin: 10 * 60, durationMin: 30, category: 'work', priority: 1 })
// 重复模板演示：工作日每天 10 分钟拉伸（实例由 sync_recurrences 物化）
addTodo({
  title: '通勤骑行',
  date: today,
  startMin: 8 * 60 + 30,
  durationMin: 25,
  category: 'workout',
  recRule: { freq: 'weekly', weekdays: [0, 1, 2, 3, 4], intervalDays: 0, endDate: null },
})

function addWorkout(w: Partial<Workout> & { name: string; type: Workout['type']; date: string; durationMin: number; kcal: number }): void {
  workouts.push({
    id: ++workoutId,
    name: w.name,
    type: w.type,
    date: w.date,
    startMin: w.startMin ?? null,
    durationMin: w.durationMin,
    kcal: w.kcal,
    intensity: w.intensity ?? 'moderate',
    note: w.note ?? null,
    sessionId: w.sessionId ?? null,
    createdAt: `${w.date}T20:00:00`,
  })
}

addWorkout({ name: '夜跑', type: 'run', date: addDays(today, -2), startMin: 19 * 60 + 30, durationMin: 30, intensity: 'high', kcal: 360 })
addWorkout({ name: '力量训练 · 下肢', type: 'strength', date: yesterday, startMin: 18 * 60 + 30, durationMin: 40, intensity: 'moderate', kcal: 245 })

/** 演示会话落库（与 session_start/session_finish 同语义）：浏览器 dev 也能查看带轨迹/做组明细的详情 */
function addDemoSession(p: {
  planId: string
  planName: string
  startedAt: string
  elapsedSec: number
  state: Record<string, unknown>
}): number {
  const id = ++sessionId
  sessions.push({
    id,
    planId: p.planId,
    planName: p.planName,
    status: 'finished',
    startedAt: p.startedAt,
    updatedAt: p.startedAt,
    exIndex: 0,
    setIndex: 1,
    weightKg: 0,
    elapsedSec: p.elapsedSec,
    state: p.state,
  })
  return id
}

/** 合成一条绕圈 GPS 轨迹（含时间戳与海拔），用于演示跑步详情 */
function synthTrack(totalKm: number, totalSec: number, laps = 4): { lat: number; lon: number; t: number; alt: number }[] {
  const cx = 31.2304
  const cy = 121.4737
  const rBase = 0.0045 / laps // 每圈半径递增，避免完全重合
  const n = Math.min(400, Math.round(totalKm * 60))
  const points: { lat: number; lon: number; t: number; alt: number }[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const ang = f * laps * 2 * Math.PI
    const r = rBase * (1 + f * 0.25)
    points.push({
      lat: cx + r * Math.sin(ang),
      lon: cy + (r * Math.cos(ang)) / Math.cos((cx * Math.PI) / 180),
      t: Math.round(f * totalSec * 1000),
      alt: 8 + Math.sin(f * 7) * 6,
    })
  }
  return points
}

// 演示一：夜跑（5 km · 30 min，目标距离）→ 详情抽屉的跑步视图
{
  const durSec = 30 * 60
  const sid = addDemoSession({
    planId: '__run__',
    planName: '户外跑',
    startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    elapsedSec: durSec,
    state: {
      kind: 'run',
      phase: 'summary',
      goalKind: 'distance',
      goalTimeMin: 30,
      goalDistanceKm: 5,
      accumMs: durSec * 1000,
      segStartedAt: null,
      distanceM: 5000,
      points: synthTrack(5, durSec),
    },
  })
  workouts[0]!.sessionId = sid
  workouts[0]!.note = "5.00 km · 配速 6'00\""
}

// 演示二：腿日（ppl-legs 前四个动作）→ 详情抽屉的课程做组明细视图
{
  const doneSets: Record<string, { weight: number | null; sec: number | null; warmup?: boolean }[]> = {
    'ppl-legs-squat': [
      { weight: 35, sec: null, warmup: true },
      { weight: 52.5, sec: null, warmup: true },
      { weight: 70, sec: null },
      { weight: 72.5, sec: null },
      { weight: 75, sec: null },
      { weight: 75, sec: null },
    ],
    'ppl-legs-rdl': [
      { weight: 30, sec: null, warmup: true },
      { weight: 60, sec: null },
      { weight: 60, sec: null },
      { weight: 62.5, sec: null },
    ],
    'ppl-legs-bulgarian': [
      { weight: 16, sec: null },
      { weight: 16, sec: null },
      { weight: 16, sec: null },
    ],
    'ppl-legs-leg-curl': [{ weight: 30, sec: null }],
  }
  const sid = addDemoSession({
    planId: 'ppl-legs',
    planName: '腿日',
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    elapsedSec: 40 * 60,
    state: {
      doneSets,
      exIndex: 3,
      setIndex: 1,
      weight: 30,
      phase: 'exercise',
      restLeft: 0,
      restTargetIsNextSet: true,
      timedTotal: 0,
    },
  })
  workouts[1]!.sessionId = sid
  workouts[1]!.note = '11/26 组完成 · 提前结束 · 总容量约 5005 kg'
  // 深蹲/罗马尼亚硬拉的逐组明细（含热身行）→ 重量曲线演示数据
  const legSets: [string, string, { w: number | null; reps: number; warmup?: boolean }[]][] = [
    ['ppl-legs-squat', '杠铃深蹲', [{ w: 35, reps: 8, warmup: true }, { w: 52.5, reps: 4, warmup: true }, { w: 70, reps: 8 }, { w: 72.5, reps: 8 }, { w: 75, reps: 8 }, { w: 75, reps: 8 }]],
    ['ppl-legs-rdl', '罗马尼亚硬拉', [{ w: 30, reps: 12, warmup: true }, { w: 60, reps: 10 }, { w: 60, reps: 10 }, { w: 62.5, reps: 10 }]],
  ]
  if (!setsSeeded) {
    for (const [key, name, list] of legSets) {
      let warmNo = 0
      let setNo = 0
      for (const it of list) {
        if (it.warmup) warmNo++
        else setNo++
        strengthSets.push({
          id: ++strengthSetId,
          workoutId: workouts[1]!.id,
          planId: 'ppl-legs',
          exerciseKey: key,
          exerciseId: '',
          exerciseName: name,
          setNo: it.warmup ? warmNo : setNo,
          kind: 'strength',
          weightKg: it.w,
          reps: it.reps,
          sec: null,
          warmup: !!it.warmup,
          createdAt: new Date().toISOString(),
        })
      }
    }
    saveSets()
  }
}

// 演示三：杠铃卧推近 4 周渐进超负荷（推日，供力量曲线卡与「上次重量」演示）
{
  const benchWeeks = [
    { daysAgo: 27, sets: [55, 57.5, 57.5] },
    { daysAgo: 20, sets: [57.5, 60, 60] },
    { daysAgo: 13, sets: [60, 60, 60] },
    { daysAgo: 6, sets: [60, 62.5, 62.5] },
  ]
  for (const wk of benchWeeks) {
    const w: Workout = {
      id: ++workoutId,
      name: '推日',
      type: 'strength',
      date: addDays(today, -wk.daysAgo),
      startMin: 18 * 60 + 30,
      durationMin: 55,
      kcal: 320,
      intensity: 'moderate',
      note: null,
      sessionId: null,
      createdAt: new Date().toISOString(),
    }
    workouts.push(w)
    // 30×8 + 45×4 激活热身，正式组递增
    const rows: { w: number; reps: number; warmup?: boolean }[] = [
      { w: 30, reps: 8, warmup: true },
      { w: 45, reps: 4, warmup: true },
      ...wk.sets.map((weight) => ({ w: weight, reps: 8 })),
    ]
    if (setsSeeded) continue
    let warmNo = 0
    let setNo = 0
    for (const r of rows) {
      if (r.warmup) warmNo++
      else setNo++
      strengthSets.push({
        id: ++strengthSetId,
        workoutId: w.id,
        planId: 'ppl-push',
        exerciseKey: 'ppl-push-bench',
        exerciseId: '',
        exerciseName: '杠铃卧推',
        setNo: r.warmup ? warmNo : setNo,
        kind: 'strength',
        weightKg: r.w,
        reps: r.reps,
        sec: null,
        warmup: !!r.warmup,
        createdAt: new Date().toISOString(),
      })
    }
  }
  if (!setsSeeded) saveSets()
  markSetsSeeded()
}

/** 演示数据与老 localStorage 数据统一挂上动作库 id（幂等，与 Rust 启动回填同语义） */
backfillExerciseRefs()

// 历史演示记录：过去约 5 个月每周 1–2 次，确定性模式生成（供日/周/年视图浏览）
const DEMO_HISTORY = [
  { name: '晨跑', type: 'run' as const, startMin: 7 * 60, durationMin: 35, intensity: 'moderate' as const },
  { name: '力量训练 · 上肢', type: 'strength' as const, startMin: 19 * 60, durationMin: 45, intensity: 'moderate' as const },
  { name: '周末骑行', type: 'cycle' as const, startMin: 9 * 60 + 30, durationMin: 60, intensity: 'high' as const },
]
for (let wk = 1; wk <= 22; wk++) {
  for (let k = 0; k < (wk % 2 === 0 ? 2 : 1); k++) {
    const d = DEMO_HISTORY[(wk + k) % DEMO_HISTORY.length]!
    const date = addDays(today, -(wk * 7) - k * 2)
    addWorkout({ ...d, date, kcal: Math.round(d.durationMin * 6.5) })
  }
}

pomodoroSessions.push(
  { id: ++pomodoroSeq, todoId: null, startedAt: `${today}T10:00:00`, endedAt: `${today}T10:25:00`, focusMin: 25, breakMin: 5, completed: true },
  { id: ++pomodoroSeq, todoId: null, startedAt: `${today}T14:00:00`, endedAt: `${today}T14:50:00`, focusMin: 50, breakMin: 10, completed: true },
)

/* ---------------- 记账演示数据 ---------------- */

let ledgerId = 0
const ledgerEntries: LedgerEntry[] = []

const ledgerSettings: LedgerSettings = { id: 1, monthlyBudgetCents: 300000, updatedAt: null }

/** 本月演示流水：offset 为距今天的天数，越过月初则跳过 */
function addLedgerEntry(
  offset: number,
  kind: 'expense' | 'income',
  category: string,
  amountCents: number,
  note: string | null,
): void {
  const date = addDays(today, -offset)
  if (date < startOfMonth(today)) return
  ledgerEntries.push({
    id: ++ledgerId,
    kind,
    category,
    amountCents,
    note,
    date,
    createdAt: `${date}T12:00:00`,
  })
}

addLedgerEntry(0, 'expense', 'food', 3250, '午餐 + 咖啡')
addLedgerEntry(0, 'expense', 'transport', 600, '地铁通勤')
addLedgerEntry(0, 'expense', 'shopping', 12900, '超市采购')
addLedgerEntry(1, 'expense', 'food', 4590, '朋友聚餐')
addLedgerEntry(1, 'expense', 'entertainment', 3800, '电影票')
addLedgerEntry(2, 'expense', 'transport', 1500, '打车')
addLedgerEntry(2, 'expense', 'bills', 8800, '话费充值')
addLedgerEntry(3, 'expense', 'food', 2800, '晚餐')
addLedgerEntry(4, 'expense', 'medical', 5650, '感冒药')
addLedgerEntry(5, 'expense', 'shopping', 26800, '新跑鞋')
addLedgerEntry(6, 'expense', 'food', 1890, '早餐')
addLedgerEntry(9, 'expense', 'housing', 180000, '房租')
addLedgerEntry(13, 'expense', 'transport', 32000, '加油')
addLedgerEntry(1, 'income', 'salary', 1200000, '8 月工资')
addLedgerEntry(8, 'income', 'refund', 3900, '退款 · 退货')
addLedgerEntry(12, 'income', 'bonus', 200000, '项目奖金')

/* ---------------- 命令实现 ---------------- */

type Args = Record<string, unknown>

async function delay<T>(value: T): Promise<T> {
  await new Promise((r) => setTimeout(r, 120))
  return value
}

/**
 * 入参统一转纯 JSON 数据：store 传来的对象可能是响应式代理，
 * 直接 structuredClone 会抛 DataCloneError。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

function summarize(date: string): DailySummary {
  const intake = zeroIntake()
  for (const m of meals) {
    if (m.date !== date || !m.food) continue
    const k = m.grams / 100
    for (const key of NUTRIENT_KEYS) intake[key] += m.food[key] * k
  }
  const exerciseKcal = workouts.filter((w) => w.date === date).reduce((s, w) => s + w.kcal, 0)
  return { date, intake, targets: { ...profile.targets }, exerciseKcal }
}

const CN_NUM: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function defaultGrams(f: Food): number {
  if (f.defaultUnit) {
    const u = f.units.find((x) => x.name === f.defaultUnit)
    if (u) return u.grams
  }
  return 100
}

/** 关键词解析：食物名命中 + 就近数量词（"一个""200克"）→ 克重估计 */
export function parseFoodText(text: string): ParsedFoodItem[] {
  const out: ParsedFoodItem[] = []
  for (const f of foods) {
    if (out.length >= 6) break
    const base = f.name.replace(/\(.*?\)/g, '')
    const idx = text.indexOf(base)
    if (idx === -1 || out.some((r) => r.foodId === f.id)) continue

    const before = text.slice(Math.max(0, idx - 8), idx)
    let grams = defaultGrams(f)

    const gramMatch = [...before.matchAll(/(\d+(?:\.\d+)?)\s*(?:克|g)/gi)].pop()
    const unitMatch = [...before.matchAll(/([半一两二两三四五六七八九十\d]+)\s*(个|碗|杯|根|片|块|勺|份|颗|把|盒|支)/)].pop()

    if (gramMatch) {
      grams = Number(gramMatch[1])
    } else if (unitMatch && unitMatch[2]) {
      const count = CN_NUM[unitMatch[1]] ?? Number(unitMatch[1]) ?? 1
      const u = f.units.find((x) => x.name === unitMatch[2])
      grams = Math.round((u?.grams ?? defaultGrams(f)) * count)
    }

    out.push({
      foodId: f.id,
      foodName: base,
      grams,
      kcalEstimate: Math.round((f.kcal * grams) / 100),
      confidence: 0.6,
      note: null,
    })
  }
  return out
}

/* ---------------- AI 目标调整解析（与 Rust ai_parse_target_adjust 同规则镜像） ---------------- */

interface TargetFieldSpec {
  field: keyof DailyTargets
  label: string
  unit: string
  keywords: string[]
  min: number
  max: number
  roundStep: number
}

const TARGET_FIELD_SPECS: TargetFieldSpec[] = [
  { field: 'kcal', label: '能量', unit: '大卡', keywords: ['热量', '大卡', '千卡', '卡路里', 'kcal'], min: 800, max: 5000, roundStep: 10 },
  { field: 'protein', label: '蛋白质', unit: 'g', keywords: ['蛋白'], min: 20, max: 300, roundStep: 1 },
  { field: 'carb', label: '碳水', unit: 'g', keywords: ['碳水'], min: 50, max: 600, roundStep: 1 },
  { field: 'fat', label: '脂肪', unit: 'g', keywords: ['脂肪'], min: 20, max: 200, roundStep: 1 },
  { field: 'sodiumMg', label: '钠', unit: 'mg', keywords: ['钠', '盐'], min: 500, max: 5000, roundStep: 50 },
  { field: 'waterMl', label: '饮水', unit: 'ml', keywords: ['饮水', '喝水', '水'], min: 500, max: 5000, roundStep: 100 },
]

const UP_WORDS = ['提高', '提升', '增加', '上调', '多']
const DOWN_WORDS = ['降低', '降到', '减少', '下调', '少', '控制']
/** 方向词后紧跟这些字时按绝对目标理解（"降到1700"） */
const ABSOLUTE_PARTICLES = ['到', '为', '成', '至', '在']

function readTargetNumber(chars: string[], start: number): [value: number, end: number] | null {
  let i = start
  let seenDot = false
  while (i < chars.length && (/[\d]/.test(chars[i]!) || (chars[i] === '.' && !seenDot))) {
    if (chars[i] === '.') seenDot = true
    i += 1
  }
  if (i === start) return null
  return [Number(chars.slice(start, i).join('')), i]
}

function numberForward(chars: string[], from: number, skipLimit: number): [value: number, numStart: number] | null {
  const end = Math.min(chars.length, from + skipLimit)
  for (let i = from; i < end; i++) {
    if (/[\d]/.test(chars[i]!)) {
      const r = readTargetNumber(chars, i)
      return r && [r[0], i]
    }
  }
  return null
}

function numberBackward(chars: string[], before: number, window: number): [value: number, numStart: number] | null {
  const lo = Math.max(0, before - window)
  for (let i = before - 1; i >= lo; i--) {
    if (/[\d.]/.test(chars[i]!)) {
      let start = i
      while (start > 0 && /[\d.]/.test(chars[start - 1]!)) start -= 1
      const r = readTargetNumber(chars, start)
      return r && [r[0], start]
    }
  }
  return null
}

/** 数字前上下文：+1/-1 为增量，0 为绝对值语义 */
function directionBefore(chars: string[], numStart: number): number {
  const ctx = chars.slice(Math.max(0, numStart - 8), numStart).join('').replace(/\s+$/, '')
  if (ABSOLUTE_PARTICLES.includes(ctx.charAt(ctx.length - 1))) return 0
  if (UP_WORDS.some((w) => ctx.includes(w))) return 1
  if (DOWN_WORDS.some((w) => ctx.includes(w))) return -1
  return 0
}

function clampRoundTarget(v: number, spec: TargetFieldSpec): number {
  return Math.round(Math.min(spec.max, Math.max(spec.min, v)) / spec.roundStep) * spec.roundStep
}

export function parseTargetAdjustText(text: string, current: DailyTargets): TargetAdjustProposal {
  const chars = [...text.toLowerCase()]
  const proposal: DailyTargets = { ...current }
  const changes: TargetChange[] = []

  for (const spec of TARGET_FIELD_SPECS) {
    if (changes.some((c) => c.field === spec.field)) continue
    for (const kw of spec.keywords) {
      const pos = chars.join('').indexOf(kw)
      if (pos === -1) continue
      // 裸「水」排除「水果」等复合词
      if (kw === '水' && chars[pos + 1] === '果') continue

      const found = numberForward(chars, pos + [...kw].length, 6) ?? numberBackward(chars, pos, 6)
      if (!found) continue
      const [value, numStart] = found

      const sign = directionBefore(chars, numStart)
      const from = current[spec.field]
      const to =
        sign !== 0 ? clampRoundTarget(from + sign * value, spec) : clampRoundTarget(value, spec)
      if (to === from) continue
      proposal[spec.field] = to
      changes.push({ field: spec.field, label: spec.label, unit: spec.unit, from, to })
      break
    }
  }

  const reply =
    changes.length === 0
      ? '没有从这句话里识别出要调整的目标。可以这样说：「把热量降到 1800 大卡」「蛋白质提高到 130 克」。'
      : `已根据你的描述整理出 ${changes.length} 项目标调整，确认后立即生效。`
  return { targets: proposal, changes, reply }
}

/* ---- 模糊搜索（镜像 Rust `search_foods_fuzzy` 的打分算法） ---- */

function fuzzyNorm(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

function mockFuzzyScore(query: string, name: string): number {
  const qn = fuzzyNorm(query)
  const nn = fuzzyNorm(name)
  if (!qn) return 0
  if (qn === nn) return 100
  const qc = [...qn]
  const nc = [...nn]
  // LCS（保持顺序的最长公共子序列）
  const n = qc.length
  const m = nc.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = qc[i - 1] === nc[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const lcs = dp[n][m]
  if (!lcs) return 0
  const order = lcs / qc.length
  const len = Math.min(1, qc.length / nc.length)
  return Math.round((0.65 * order + 0.35 * len) * 100)
}

/** 简易 HTML → 纯文本（dev 环境镜像 Rust html2text 的粗粒度行为） */
function mockHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function mockWebFetch(url: string, maxChars: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    const html = await resp.text()
    const plain = mockHtmlToText(html)
    const chars = [...plain].length
    const truncated = chars > maxChars
    const text = truncated ? `${[...plain].slice(0, maxChars).join('')}\n\n…（内容已截断，如需更多请用更具体的关键词搜索）` : plain
    return {
      url: resp.url || url,
      contentType: resp.headers.get('content-type') ?? '',
      text,
      truncated,
      chars,
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 语音对话（modules/voice 同契约） ---------------- */

/** 浏览器 mock 的事件出口：voiceService 在非 Tauri 环境把 onAsr 挂到这里 */
export const mockVoice: { onAsr: ((e: unknown) => void) | null } = { onAsr: null }

interface MockVoiceConfig {
  mode: 'legacy' | 'new'
  appKey: string
  accessKey: string
  asrAdapter: string
  asrAdapterUserPicked: boolean
  asrBaseUrl: string
  ttsCredential: { mode: 'legacy' | 'new'; appKey: string; accessKey: string } | null
  asrResourceId: string
  ttsResourceId: string
  voiceName: string
  speed: number
}

let voiceConfig: MockVoiceConfig = {
  mode: 'legacy',
  appKey: '',
  accessKey: '',
  asrAdapter: 'auto',
  asrAdapterUserPicked: false,
  asrBaseUrl: '',
  ttsCredential: null,
  asrResourceId: 'volc.seedasr.sauc.duration',
  ttsResourceId: 'seed-tts-2.0',
  voiceName: '',
  speed: 1,
}

interface MockMemo {
  id: string
  chatId: string
  messageId: string | null
  title: string
  audioPath: string | null
  durationMs: number
  words: number
  sentences: unknown
  summary: unknown
  createdAt: string
}

const voiceMemos: MockMemo[] = []
let voiceDraft: unknown = null

/** 伪造识别会话：按脚本节奏发 partial/final 事件（e2e 与 UI 迭代用） */
// 时间压缩到 ~3.4s（mock 仅供 dev/e2e；真实节奏由服务端决定）
const MOCK_SENTENCES = [
  { startMs: 300, endMs: 700, text: '今天中午在公司楼下吃的，一个鸡胸肉汉堡，没喝可乐，加了杯无糖的。' },
  { startMs: 900, endMs: 1400, text: '对了，下午三点提醒我去拿快递，别忘记了。' },
  { startMs: 1600, endMs: 2500, text: '昨天练完腿，今天大腿前侧有点酸，晚上就不安排力量了，改成拉伸十五分钟。' },
  { startMs: 2700, endMs: 3200, text: '还有，帮我看看这个月外卖花了多少。' },
]

const voiceTimers = new Map<string, number[]>()
/** 已 final 的句子下标（finish 补发时去重） */
const voiceFinaled = new Map<string, Set<number>>()

function clearVoiceTimers(sessionId: string): void {
  const ids = voiceTimers.get(sessionId)
  if (ids) {
    for (const id of ids) clearTimeout(id)
    voiceTimers.delete(sessionId)
  }
}

function mockWavDataUrl(): string {
  const sampleRate = 16000
  const dataLen = sampleRate * 2 // 1s 静音
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const w = (off: number, str: string): void => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, dataLen, true)
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)))
  }
  return 'data:audio/wav;base64,' + btoa(bin)
}

/* ---------- 知识库与长期记忆（对应 Rust modules/kb）----------
 * 浏览器里没有 SQLite，所以这里用一份内存文档表模拟索引结果：
 * 首次访问时把各 mock 数据源扫一遍建成 kbDocs，之后 kb_memory_apply 等写入会顺带更新它。
 * 检索是 includes() 关键词匹配（真实实现是 FTS5 trigram + 向量 + RRF），
 * 形状与召回阶梯刻意保持一致（fts/like/fuzzy），这样 e2e 断言能复用。 */

interface MockKbDoc {
  id: number
  sourceType: string
  sourceId: string
  path: string | null
  editable: boolean
  system: boolean
  kind: 'text' | 'image' | 'file' | 'audio' | 'video' | 'folder'
  parentId: string | null
  title: string
  summary: string
  body: string
  occurredOn: string | null
  tags: string[]
  updatedAt: string
}

/** 文件节点（kb_files）：文本笔记 / 多模态节点 / 目录（ai-workspace §1） */
interface MockKbFile {
  id: number
  path: string
  content: string
  system: boolean
  kind: 'text' | 'multimodal' | 'folder'
  pinned: boolean
  classifyState: 'inbox' | 'filed' | 'manual'
  createdAt: string
  updatedAt: string
}

/** 模态表示（kb_assets）。浏览器 mock 无法落盘，本体一律以内联 data URL 存在 ref 里 */
interface MockKbAsset {
  id: number
  fileId: number
  modal: 'text' | 'image' | 'audio' | 'video' | 'binary'
  mime: string
  ref: string
  bytes: number
  durationMs: number | null
  transcriptState: 'none' | 'pending' | 'done' | 'failed'
  derivedFrom: string | null
  createdAt: string
}

/** 整理审计（kb_fs_moves，ai-workspace §3.3） */
interface MockKbFsMove {
  id: number
  batchId: string
  source: string
  op: string
  pathFrom: string
  pathTo: string
  reason: string
  at: string
  undone: boolean
}

/** 路径净化：与 Rust source::sanitize 同一条规则（docs/kb-vfs.md §2） */
function kbSanitize(raw: string, max: number): string {
  const bad = /[\/\\:*?"<>|\n\r\t]/
  let out = ''
  for (const ch of raw.trim()) {
    if (out.length >= max) break
    out += bad.test(ch) ? '-' : ch
  }
  const t = out.trim().replace(/^-+|-+$/g, '')
  return t || '未命名'
}

/** 系统命名空间（只读，ai-workspace §3.2） */
const KB_SYSTEM_ROOTS = ['规范', '系统提示词']
/** 知识区（可直接写的根） */
const KB_WRITABLE_ROOTS = ['笔记', '文档', '用户记忆', '未分类数据', '语音', '视频']
/** 投影区（派生文档所在的领域根；目录内保留区之外仍可写） */
const KB_DOMAIN_ROOTS = [
  '日程', '运动', '饮食', '体测', '课程', '食物', '方案', '菜单', '对话', '附件', '记忆', '纪要',
]

const kbKnownRoot = (seg: string): boolean =>
  KB_WRITABLE_ROOTS.includes(seg) || KB_DOMAIN_ROOTS.includes(seg)

/** 把用户给的路径归位成合法路径（与 Rust files::normalize_path 同构） */
function kbNormalizePath(raw: string): string {
  let p = raw.trim().replace(/^\/+/, '')
  if (!p) throw new Error('文件路径不能为空')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`路径不允许包含 ..：${p}`)
  const first = p.split('/')[0] ?? ''
  if (KB_SYSTEM_ROOTS.includes(first)) {
    throw new Error(`${first}/ 是系统命名空间，只能由应用更新，不能由用户写入`)
  }
  if (!kbKnownRoot(first)) p = `笔记/${p}`
  p = p
    .split('/')
    .filter(Boolean)
    .map((seg) => kbSanitize(seg, 60))
    .join('/')
  return p.endsWith('.md') ? p : `${p}.md`
}

/** 媒体路径归位：保留扩展名，裸路径默认落收件箱（与 Rust files::normalize_media_path 同构） */
function kbNormalizeMediaPath(raw: string, name: string): string {
  const p = raw.trim().replace(/^\/+/, '')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`路径不允许包含 ..：${p}`)
  const safeName = kbSanitize(name, 60)
  const last = p.split('/').pop() ?? ''
  let dir = ''
  let base = safeName
  if (last.includes('.')) {
    const cut = p.lastIndexOf('/')
    dir = cut >= 0 ? p.slice(0, cut) : ''
    base = kbSanitize(last, 60)
  } else {
    dir = p
  }
  if (dir) {
    const first = dir.split('/')[0] ?? ''
    if (KB_SYSTEM_ROOTS.includes(first)) {
      throw new Error(`${first}/ 是系统命名空间，只能由应用更新，不能由用户写入`)
    }
    if (!kbKnownRoot(first)) dir = `未分类数据/${kbSanitize(dir, 60)}`
  } else {
    dir = '未分类数据'
  }
  dir = dir
    .split('/')
    .filter(Boolean)
    .map((seg) => kbSanitize(seg, 60))
    .join('/')
  return dir ? `${dir}/${base}` : base
}

/** 保留区判定（与 Rust governance::is_reserved_path 同构）：
 *  `附件/` 全树、日期目录、以及**领域目录下**的 `-数字` 后缀；知识区的正常名字不受限。 */
function kbIsReservedPath(path: string): boolean {
  const segs = path.split('/').filter(Boolean)
  if (!segs.length) return true
  if (segs[0] === '附件') return true
  if (segs.some((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return true
  if (!KB_DOMAIN_ROOTS.includes(segs[0])) return false
  const file = segs[segs.length - 1] ?? ''
  const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file
  const tail = stem.includes('-') ? stem.slice(stem.lastIndexOf('-') + 1) : ''
  return tail.length > 0 && /^\d+$/.test(tail)
}

/** 保留目录整体让位（与 Rust governance::safe_dir 同构）：
 *  日期目录 → `{日期}-用户/`；`附件/` 整树是编目 → 改投收件箱。 */
function kbSafeDir(dir: string): string {
  const segs = dir.split('/').filter(Boolean)
  if (segs[0] === '附件') return '未分类数据'
  return segs.map((seg) => (/^\d{4}-\d{2}-\d{2}$/.test(seg) ? `${seg}-用户` : seg)).join('/')
}

/** 在 dir 下为 basename 找一个自由路径（保留区 / 已占用都加 -v2 后缀） */
function kbFreePath(dir: string, basename: string): string {
  const d = kbSafeDir(dir.trim().replace(/^\/+|\/+$/g, ''))
  const cut = basename.lastIndexOf('.')
  const stem = cut > 0 ? basename.slice(0, cut) : basename
  const ext = cut > 0 ? basename.slice(cut) : ''
  for (let i = 0; i < 64; i++) {
    const name = i === 0 ? basename : `${stem}-v${i + 1}${ext}`
    const path = d ? `${d}/${name}` : name
    if (KB_SYSTEM_ROOTS.includes(path.split('/')[0] ?? '')) throw new Error(`${path} 在系统命名空间，只读`)
    if (kbIsReservedPath(path)) continue
    const taken = kbFiles.some((f) => f.path === path) || kbDocs.some((doc) => doc.path === path)
    if (!taken) return path
  }
  throw new Error(`在 ${d}/ 下找不到可用文件名（${basename}）`)
}

/** 与 Rust chunk_text 同参数的简化分块（300 字 / 50 重叠），供 L2 分页与 totalChunks */
function kbChunkText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  if (normalized.length <= 300) return [normalized]
  const out: string[] = []
  let start = 0
  while (start < normalized.length) {
    const end = Math.min(start + 300, normalized.length)
    const piece = normalized.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= normalized.length) break
    const next = Math.max(end - 50, start + 1)
    start = next
  }
  return out
}

/** note 源正文进检索缓存的上限（对应 Rust source.rs MAX_BODY = 8000）。
 *  缓存截断只影响召回；阅读（kb_read）必须直读 kb_files 真源给全文，见 kb_read 的 note 特判。 */
const KB_BODY_CAP = 8000
const kbCacheBody = (content: string) =>
  content.length <= KB_BODY_CAP ? content : `${content.slice(0, KB_BODY_CAP)}…`

interface MockKbMemory {
  id: number
  memType: string
  topic: string
  /** 分层分类路径（如 健康/训练），可为空 */
  category: string
  content: string
  confidence: number
  activeCount: number
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
  /** 最近一次注入时间（衰减计时起点） */
  lastUsedAt: string | null
  /** 归档时间（软删除）；非空 = 不进注入与检索 */
  archivedAt: string | null
  archivedReason: string | null
}

/** 显著性半衰期（天），与 Rust memory.rs 的 SALIENCE_HALF_LIFE_DAYS 对齐 */
const KB_SALIENCE_HALF_LIFE_DAYS = 14
/** 低信号阈值，与 Rust memory.rs 的 STALE_SALIENCE 对齐 */
const KB_STALE_SALIENCE = 0.15
/** 自动归档判定，与 Rust memory.rs 对齐 */
const KB_NEVER_USED_PRUNE_DAYS = 30
const KB_STALE_PRUNE_DAYS = 45

/** 显著性 = 置信度 × 时间衰减 × 使用强化（读时计算，不落库存） */
function kbSalience(m: MockKbMemory): number {
  const since = Date.parse(m.lastUsedAt ?? m.updatedAt ?? m.createdAt)
  const idleDays = Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 86_400_000) : 0
  const decay = 0.5 ** (idleDays / KB_SALIENCE_HALF_LIFE_DAYS)
  const reinforcement = 1 + Math.log(1 + m.activeCount) / 4
  return m.confidence * decay * reinforcement
}

function kbIdleDays(m: MockKbMemory): number {
  const since = Date.parse(m.lastUsedAt ?? m.updatedAt ?? m.createdAt)
  return Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 86_400_000) : 0
}

/** 记忆类型 → 中文标签（与 Rust source.rs::mem_type_label 对齐） */
const KB_MEMORY_TYPE_LABELS: Record<string, string> = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  entity: '实体',
  profile: '画像',
  pattern: '规律',
}

/** 认知块的一行：`- [类型·分类] 内容`（与 Rust cognition_line 同构） */
function kbCognitionLine(m: MockKbMemory): string {
  const label = m.category
    ? `${KB_MEMORY_TYPE_LABELS[m.memType] ?? m.memType}·${m.category}`
    : (KB_MEMORY_TYPE_LABELS[m.memType] ?? m.memType)
  return `- [${label}] ${m.content.trim()}`
}

/** 从编目里摘掉某条记忆的文档（归档/删除共用） */
function kbDropMemoryDoc(id: number): void {
  const di = kbDocs.findIndex((d) => d.sourceType === 'memory' && d.sourceId === String(id))
  if (di >= 0) kbDocs.splice(di, 1)
}

// 规范文件内容与 src-tauri 的 include_str! 同源（docs/kb-vfs.md），浏览器 mock 也读同一份
import specMarkdown from '../../docs/kb-vfs.md?raw'

const KB_SETTINGS_KEY = 'rein.mock.kb_settings.v1'
const KB_MEMORY_KEY = 'rein.mock.kb_memories.v1'
const KB_FILE_KEY = 'rein.mock.kb_files.v1'
const KB_ASSET_KEY = 'rein.mock.kb_assets.v1'
const KB_MOVE_KEY = 'rein.mock.kb_fs_moves.v1'
const KB_SPEC_PATH = '规范/知识库规范.md'
/** 注入预算（与 Rust injection::BUDGET_CHARS 对齐） */
const KB_INJECT_BUDGET = 12000

const kbDocs: MockKbDoc[] = []
let kbDocId = 0
const kbMemories: MockKbMemory[] = []
let kbMemoryId = 0
const kbFiles: MockKbFile[] = []
let kbFileId = 0
const kbAssets: MockKbAsset[] = []
let kbAssetId = 0
const kbMoves: MockKbFsMove[] = []
let kbMoveId = 0
let kbIndexed = false

let kbSettings: {
  embeddingMode: 'keyword' | 'local' | 'cloud'
  cloudBaseUrl: string | null
  cloudApiKey: string | null
  cloudModel: string | null
  cloudDim: number | null
  sourcesEnabled: Record<string, boolean>
  autoMemory: boolean
  autoConsolidate: boolean
  lastConsolidateAt: string | null
  lastMaintainAt: string | null
  lastError: string | null
  updatedAt: string
} = {
  embeddingMode: 'keyword',
  cloudBaseUrl: null,
  cloudApiKey: null,
  cloudModel: null,
  cloudDim: null,
  sourcesEnabled: {},
  autoMemory: true,
  autoConsolidate: true,
  lastConsolidateAt: null,
  lastMaintainAt: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
}

let kbLoaded = false

function loadKbStore(): void {
  if (kbLoaded) return
  kbLoaded = true
  try {
    const raw = localStorage.getItem(KB_SETTINGS_KEY)
    if (raw) kbSettings = { ...kbSettings, ...(JSON.parse(raw) as typeof kbSettings) }
    const mem = localStorage.getItem(KB_MEMORY_KEY)
    if (mem) {
      const list = JSON.parse(mem) as MockKbMemory[]
      kbMemories.push(
        ...list.map((m) => ({
          ...m,
          // 老版本没有生命周期字段：补默认值，避免 undefined 渗进界面
          category: m.category ?? '',
          lastUsedAt: m.lastUsedAt ?? null,
          archivedAt: m.archivedAt ?? null,
          archivedReason: m.archivedReason ?? null,
        })),
      )
      kbMemoryId = Math.max(kbMemoryId, ...list.map((m) => m.id), 0)
    }
    const f = localStorage.getItem(KB_FILE_KEY)
    if (f) {
      const list = JSON.parse(f) as MockKbFile[]
      kbFiles.push(
        ...list.map((x) => ({
          ...x,
          // 老版本只存了 path/content/system：补上 v2 字段
          kind: x.kind ?? 'text',
          pinned: x.pinned ?? false,
          classifyState: x.classifyState ?? 'manual',
        })),
      )
      kbFileId = Math.max(kbFileId, ...list.map((x) => x.id), 0)
    }
    const a = localStorage.getItem(KB_ASSET_KEY)
    if (a) {
      const list = JSON.parse(a) as MockKbAsset[]
      kbAssets.push(...list.map((x) => ({ ...x, derivedFrom: x.derivedFrom ?? null })))
      kbAssetId = Math.max(kbAssetId, ...list.map((x) => x.id), 0)
    }
    const mv = localStorage.getItem(KB_MOVE_KEY)
    if (mv) {
      const list = JSON.parse(mv) as MockKbFsMove[]
      kbMoves.push(...list)
      kbMoveId = Math.max(kbMoveId, ...list.map((x) => x.id), 0)
    }
  } catch {
    /* 损坏数据按空处理 */
  }
}

function saveKbSettings(): void {
  try {
    localStorage.setItem(KB_SETTINGS_KEY, JSON.stringify(kbSettings))
  } catch {
    /* 忽略 */
  }
}

function saveKbMemories(): void {
  try {
    localStorage.setItem(KB_MEMORY_KEY, JSON.stringify(kbMemories))
  } catch {
    /* 忽略 */
  }
}

function saveKbFiles(): void {
  try {
    localStorage.setItem(KB_FILE_KEY, JSON.stringify(kbFiles))
  } catch {
    /* 忽略 */
  }
}

function saveKbAssets(): void {
  try {
    localStorage.setItem(KB_ASSET_KEY, JSON.stringify(kbAssets))
  } catch {
    /* 忽略 */
  }
}

function saveKbMoves(): void {
  try {
    localStorage.setItem(KB_MOVE_KEY, JSON.stringify(kbMoves))
  } catch {
    /* 忽略 */
  }
}

loadKbStore()

function kbUpsertDoc(
  sourceType: string,
  sourceId: string,
  title: string,
  body: string,
  occurredOn: string | null,
  tags: string[] = [],
  vfs: { path?: string | null; editable?: boolean; system?: boolean; kind?: MockKbDoc['kind']; parentId?: string | null } = {},
): void {
  const summary = body.trim().split(/[。！？\n]/)[0]?.slice(0, 120) ?? ''
  const existing = kbDocs.find((d) => d.sourceType === sourceType && d.sourceId === sourceId)
  if (existing) {
    Object.assign(existing, {
      title, summary, body, occurredOn, tags,
      path: vfs.path ?? existing.path,
      editable: vfs.editable ?? existing.editable,
      system: vfs.system ?? existing.system,
      kind: vfs.kind ?? existing.kind,
      parentId: vfs.parentId ?? existing.parentId,
      updatedAt: new Date().toISOString(),
    })
    return
  }
  kbDocs.push({
    id: ++kbDocId,
    sourceType,
    sourceId,
    path: vfs.path ?? null,
    editable: vfs.editable ?? false,
    system: vfs.system ?? false,
    kind: vfs.kind ?? 'text',
    parentId: vfs.parentId ?? null,
    title,
    summary,
    body,
    occurredOn,
    tags,
    updatedAt: new Date().toISOString(),
  })
}

/** 系统提示词与用户记忆模板（与 Rust files.rs 的常量同源，改一处要改两处） */
const KB_PROMPT_FILES: Record<string, string> = {
  '系统提示词/角色与语气.md': [
    '# 角色与语气',
    '',
    '- 你是 Rein AI：Rein 健康生活应用的内置助手，用户的数据与文件都在你的虚拟工作区里。',
    '- 用简体中文，语气自然亲切；直接给结论，不复述用户已知的信息。',
    '- 能用工具查到的事不要反问用户；需要决策时给两三个具体选项。',
    '',
  ].join('\n'),
  '系统提示词/工作区约定.md': [
    '# 工作区约定',
    '',
    '- 目录里的派生文档是应用数据的只读投影：要改内容就改源数据，直接改文件会被重放覆盖。',
    '- 可写：笔记/、文档/、未分类数据/、语音/、视频/、用户记忆/ 与各领域目录的用户子目录；系统区只读。',
    '- 新内容先落 未分类数据/，再用 classify_move 归类并写清 reason；被 pin 的文件不要动。',
    '- 文件可以有多种模态：需要原件时用 read_modal，音频/视频可能返回降级文本。',
    '',
  ].join('\n'),
}
const KB_MEMORY_TPLS: Record<string, string> = {
  '用户记忆/角色设定.md': '<!-- 角色设定：AI 该怎么称呼你、用什么语气、注意什么。有内容时每轮自动注入。 -->',
  '用户记忆/全局规范.md': '<!-- 全局规范：你希望 AI 始终遵守的规则。有内容时每轮自动注入。 -->',
}

/** 播种系统文件与默认目录（幂等，对应 Rust files::ensure_system_files） */
function kbEnsureSystemFiles(): void {
  const now = new Date().toISOString()
  const seed = (path: string, content: string, system: boolean): void => {
    const have = kbFiles.find((f) => f.path === path)
    if (have) {
      if (system && have.content !== content) {
        have.content = content
        have.updatedAt = now
      }
      return
    }
    kbFiles.push({
      id: ++kbFileId,
      path,
      content,
      system,
      kind: 'text',
      pinned: false,
      classifyState: 'manual',
      createdAt: now,
      updatedAt: now,
    })
  }

  seed(KB_SPEC_PATH, specMarkdown, true)
  for (const [path, content] of Object.entries(KB_PROMPT_FILES)) seed(path, content, true)
  // 用户记忆模板只在缺失时建，绝不覆盖用户编辑
  for (const [path, content] of Object.entries(KB_MEMORY_TPLS)) seed(path, content, false)
  // 收件箱目录：让默认树完整可见
  if (!kbFiles.some((f) => f.path === '未分类数据')) {
    kbFiles.push({
      id: ++kbFileId,
      path: '未分类数据',
      content: '【目录】未分类数据',
      system: false,
      kind: 'folder',
      pinned: false,
      classifyState: 'inbox',
      createdAt: now,
      updatedAt: now,
    })
  }
  saveKbFiles()
}

/* ---------- 模态层 / 目录治理 / 注入区的 mock 辅助（对应 Rust assets/governance/injection） ---------- */

const KB_MODAL_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  binary: '文件',
}

function kbModalOfMime(mime: string): MockKbAsset['modal'] {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('text/') || m.includes('json') || m.includes('markdown')) return 'text'
  return 'binary'
}

function kbMimeOfName(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

function primaryModalKind(fileId: number): MockKbDoc['kind'] {
  const modals = kbAssets.filter((a) => a.fileId === fileId).map((a) => a.modal)
  if (modals.includes('video')) return 'video'
  if (modals.includes('audio')) return 'audio'
  if (modals.includes('image')) return 'image'
  return 'file'
}

function kbHumanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 节点模态清单（含文本模态判定），对应 Rust assets::modals_for_source */
function kbModalsForSource(sourceType: string, sourceId: string, textChars: number): Array<{
  modal: string
  mime: string
  bytes: number
  durationMs: number | null
  transcriptState: string
  derivedFrom: string | null
  source: string
}> {
  const out: ReturnType<typeof kbModalsForSource> = []
  if (textChars > 0) {
    out.push({ modal: 'text', mime: 'text/markdown', bytes: textChars, durationMs: null, transcriptState: 'done', derivedFrom: null, source: 'text' })
  }
  if (sourceType === 'note') {
    for (const a of kbAssets.filter((x) => x.fileId === Number(sourceId))) {
      out.push({
        modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
        transcriptState: a.transcriptState, derivedFrom: null, source: 'asset',
      })
    }
  }
  if (sourceType === 'voice_memo') {
    const memo = voiceMemos.find((m) => m.id === sourceId)
    if (memo) {
      out.push({
        modal: 'audio', mime: 'audio/wav', bytes: 0,
        durationMs: memo.durationMs,
        transcriptState: 'done', derivedFrom: null, source: 'voice',
      })
    }
  }
  if (sourceType === 'todo_attachment') {
    const [todoId, idxRaw] = sourceId.split(':')
    const todo = todos.find((t) => String(t.id) === todoId)
    const att = todo?.attachments?.[Number(idxRaw)]
    if (att) {
      const attKind = String(att.kind)
      out.push({
        modal: attKind === 'text' ? 'text' : attKind,
        mime: kbMimeOfName(att.name),
        bytes: att.size ?? 0, durationMs: null,
        transcriptState: attKind === 'audio' || attKind === 'video' ? 'none' : 'done',
        derivedFrom: null, source: 'attachment',
      })
    }
  }
  return out
}

/** 整理审计写入（对应 Rust governance::audit） */
function kbAudit(source: string, op: string, from: string, to: string, reason: string): string {
  const batchId = `b${Date.now().toString(36)}-${++kbMoveId}`
  kbMoves.push({
    id: kbMoveId, batchId, source, op, pathFrom: from, pathTo: to,
    reason, at: new Date().toISOString(), undone: false,
  })
  saveKbMoves()
  return batchId
}

/** 注入块（对应 Rust injection::build）：注释行与空行不占预算，超限截断 */
function kbInjection(): {
  system: string
  memory: string
  files: Array<{ path: string; zone: string; chars: number; truncated: boolean }>
  totalChars: number
  budget: number
  truncated: boolean
} {
  kbEnsureIndex()
  const meaningful = (content: string): string | null => {
    const kept = content
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return t.length > 0 && !(t.startsWith('<!--') && t.endsWith('-->'))
      })
    const t = kept.join('\n').trim()
    return t ? t : null
  }
  const priority = (path: string): number => {
    if (path.startsWith('系统提示词/')) return 0
    if (path === '用户记忆/角色设定.md') return 1
    if (path === '用户记忆/全局规范.md') return 2
    return 3
  }
  const entries = kbFiles
    .filter((f) => f.path.startsWith('系统提示词/') || f.path.startsWith('用户记忆/'))
    .map((f) => ({ path: f.path, content: meaningful(f.content), zone: f.path.startsWith('系统提示词/') ? 'system' : 'memory' }))
    .filter((e): e is { path: string; content: string; zone: string } => e.content !== null)
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path))

  let used = 0
  let truncated = false
  let system = ''
  let memory = ''
  const files: Array<{ path: string; zone: string; chars: number; truncated: boolean }> = []
  for (const e of entries) {
    if (used >= KB_INJECT_BUDGET) {
      truncated = true
      break
    }
    const header = `【${e.path}】\n`
    const left = KB_INJECT_BUDGET - used
    let text: string
    let cut = false
    if (header.length + e.content.length <= left) {
      text = `${header}${e.content}\n`
    } else {
      truncated = true
      cut = true
      text = `${header}${e.content.slice(0, Math.max(left - header.length - 1, 0))}…\n`
    }
    used += text.length
    if (e.zone === 'system') system += text
    else memory += text
    files.push({ path: e.path, zone: e.zone, chars: e.content.length, truncated: cut })
    if (cut) break
  }
  if (truncated) {
    const note = '（注入预算已满：还有内容没有注入，需要时用 glob_knowledge / read_knowledge 自己读）\n'
    if (memory) memory += note
    else system += note
    used += note.length
  }
  return { system, memory, files, totalChars: used, budget: KB_INJECT_BUDGET, truncated }
}

/** 把各 mock 数据源扫一遍建索引。真实实现由 SQLite 触发器登记 + 后台线程消费。 */
function kbEnsureIndex(): void {
  if (kbIndexed) return
  kbIndexed = true

  // 系统文件（规范 / 系统提示词 / 用户记忆模板 / 收件箱）与用户文件
  kbEnsureSystemFiles()
  for (const f of kbFiles) {
    const base = f.path.split('/').pop() ?? f.path
    const docKind: MockKbDoc['kind'] =
      f.kind === 'folder'
        ? 'folder'
        : f.kind === 'multimodal'
          ? primaryModalKind(f.id)
          : 'text'
    kbUpsertDoc(
      'note',
      String(f.id),
      base.replace(/\.[a-z0-9]+$/i, ''),
      kbCacheBody(f.content),
      f.createdAt.slice(0, 10),
      [f.system ? '规范' : '笔记'],
      { path: f.path, editable: !f.system, system: f.system, kind: docKind },
    )
  }

  for (const t of todos) {
    const sub = (t.subtasks ?? []).map((s) => `${s.done ? '✓' : '○'} ${s.title}`).join('、')
    // 附件只取 text 正文，绝不把 data URL 带进索引（与 Rust 侧同一条约束）
    const atts = (t.attachments ?? [])
      .map((a) =>
        a.kind === 'text'
          ? (a.content ?? '')
          : `${a.kind === 'image' ? '图片' : a.kind === 'audio' ? '录音' : '文件'}「${a.name}」`,
      )
      .join(' ')
    kbUpsertDoc(
      'todo',
      String(t.id),
      t.title,
      [t.title, t.notes ?? '', sub, atts].filter(Boolean).join(' '),
      t.date,
      [t.category],
      { path: `日程/${t.date ?? '收件箱'}/${kbSanitize(t.title, 60)}-${t.id}.md` },
    )
    // 附件编目：二进制内容绝不进正文（与 Rust 同一条铁律）
    ;(t.attachments ?? []).forEach((a, idx) => {
      const isText = a.kind === 'text'
      const body = isText
        ? (a.content ?? '')
        : `${a.kind === 'image' ? '图片' : a.kind === 'audio' ? '录音' : '文件'}「${a.name}」（${Math.round((a.size ?? 0) / 1024)} KB），随待办《${t.title}》保存`
      if (!body.trim()) return
      kbUpsertDoc(
        'todo_attachment',
        `${t.id}:${idx}`,
        a.name,
        body,
        t.date,
        ['附件', a.kind],
        {
          path: `附件/日程/${t.id}/${idx}-${kbSanitize(a.name, 40)}`,
          kind: a.kind === 'text' ? 'text' : a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'audio' : 'file',
          parentId: String(t.id),
        },
      )
    })
  }
  for (const w of workouts) {
    const sets = strengthSets.filter((s) => s.workoutId === w.id)
    const detail = sets.map((s) => `${s.exerciseName} ${s.weightKg ?? 0}kg × ${s.reps ?? 0}`).join('；')
    kbUpsertDoc('workout', String(w.id), w.name, [w.name, w.note ?? '', detail].filter(Boolean).join(' '), w.date, [w.type])
  }
  for (const p of plans) {
    kbUpsertDoc('plan', p.id, p.name, [p.name, p.subtitle ?? '', p.equipment ?? ''].filter(Boolean).join(' '), null, [p.workoutType])
  }
  for (const m of meals) {
    const f = foods.find((x) => x.id === m.foodId)
    kbUpsertDoc('meal', String(m.id), `${m.date} ${f?.name ?? '食物'}`, `${f?.name ?? ''} ${m.grams}g`, m.date, [m.mealType])
  }
  for (const b of bodyStore.metrics) {
    kbUpsertDoc('body_metric', String(b.id), `${b.date} 体测`, `体重 ${b.weightKg ?? '—'} kg`, b.date, ['body_metric'])
  }
  for (const memo of voiceMemos) {
    const sents = Array.isArray(memo.sentences) ? (memo.sentences as { text?: string }[]) : []
    kbUpsertDoc(
      'voice_memo',
      memo.id,
      memo.title || '语音纪要',
      sents.map((s) => s.text ?? '').join(''),
      memo.createdAt?.slice(0, 10) ?? null,
      ['voice_memo'],
      { path: `语音/${memo.createdAt?.slice(0, 10) ?? '收件箱'}/${kbSanitize(memo.title || '语音纪要', 60)}-${memo.id}.md` },
    )
  }
  // 长期记忆也编目（kb_docs 的一类来源，可被 glob/检索）；归档记忆退出检索
  for (const m of kbMemories) {
    if (m.archivedAt) continue
    const sub = m.category ? `${m.category}/` : ''
    kbUpsertDoc(
      'memory',
      String(m.id),
      m.topic ? `记忆 · ${m.topic}` : `记忆 · ${m.memType}`,
      m.content,
      m.createdAt.slice(0, 10),
      m.category ? [m.memType, m.category] : [m.memType],
      { path: `记忆/${m.memType}/${sub}${m.topic || '未命名'}-${m.id}.md`, editable: true },
    )
  }

  // 会话文档（全文转录，跳过工具卡与协议 JSON）+ 单条消息 + 对话附件
  const aiRole = (r: string) => (r === 'user' ? '用户' : 'AI')
  for (const chat of aiChats.values()) {
    const lines: string[] = []
    for (const m of chat.messages) {
      if (m.kind === 'tools') continue
      const text = (m.text ?? '').trim()
      if (!text || text.startsWith('{')) continue
      lines.push(`[${m.seq}] ${aiRole(m.role)}：${text}`)
      kbUpsertDoc(
        'chat_message',
        m.id,
        text.slice(0, 40),
        text,
        m.createdAt?.slice(0, 10) ?? null,
        ['chat', m.role],
        { path: `对话/${chat.id}/${m.seq}-${aiRole(m.role)}.md` },
      )
      // 对话附件：照片消息
      if (m.imageBase64) {
        const size = Math.round((m.imageBase64.length * 3) / 4)
        kbUpsertDoc(
          'chat_attachment',
          `${m.id}:img`,
          `图片-${(m.createdAt ?? '').slice(0, 10)}.jpg`,
          `随对话消息保存的图片（${size} B）；图片本体在消息的 imageBase64 里`,
          m.createdAt?.slice(0, 10) ?? null,
          ['附件', 'image'],
          { path: `附件/对话/${m.id}/图片-${(m.createdAt ?? '').slice(0, 10)}.jpg`, kind: 'image', parentId: m.id },
        )
      }
    }
    if (lines.length === 0) continue
    kbUpsertDoc(
      'chat',
      chat.id,
      `对话 · ${kbSanitize(chat.title, 40)}`,
      `与用户共 ${lines.length} 条消息的完整转录：\n${lines.join('\n')}`,
      chat.createdAt?.slice(0, 10) ?? null,
      ['chat'],
      { path: `对话/${kbSanitize(chat.title, 40)}-${chat.id}.md` },
    )
  }
}

/** glob 匹配（与 Rust glob_match 同语义：星号不跨 /、双星跨、问号单字符、双星斜杠可匹配零层目录） */
function kbGlobMatch(pattern: string, path: string): boolean {
  const toRe = (pat: string) =>
    new RegExp(
      '^' +
        pat
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/\u0000/g, '.*') +
        '$',
    )
  if (toRe(pattern).test(path)) return true
  if (pattern.includes('/**/')) return toRe(pattern.replace('/**/', '/')).test(path)
  return false
}

function kbDocToMemory(m: MockKbMemory) {
  // 显著性读时计算：与 Rust 一样不落库，避免时间一长就和真实排序漂移
  return { ...m, salience: kbSalience(m) }
}

function kbSearchMock(query: string, opts: {
  sources?: string[]
  from?: string
  to?: string
  tags?: string[]
  limit?: number
}) {
  kbEnsureIndex()
  const q = query.trim()
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20)

  let pool = kbDocs.slice()
  if (opts.sources?.length) pool = pool.filter((d) => opts.sources!.includes(d.sourceType))
  if (opts.from) pool = pool.filter((d) => d.occurredOn && d.occurredOn >= opts.from!)
  if (opts.to) pool = pool.filter((d) => d.occurredOn && d.occurredOn <= opts.to!)
  if (opts.tags?.length) pool = pool.filter((d) => opts.tags!.some((t) => d.tags.includes(t)))

  if (!q) {
    return pool
      .sort((a, b) => (b.occurredOn ?? '').localeCompare(a.occurredOn ?? ''))
      .slice(0, limit)
      .map((d) => ({ ...d, snippet: d.summary, score: 0, matched: 'browse' as const }))
  }

  // 与真实实现同构的召回阶梯：整串命中 → 二字窗口模糊
  const exact = pool.filter((d) => `${d.title} ${d.body}`.includes(q))
  const tier = exact.length ? 'like' : 'fuzzy'
  const hits = exact.length
    ? exact
    : (() => {
        const chars = [...q.replace(/\s/g, '')]
        if (chars.length < 4) return []
        const grams = chars.slice(0, -1).map((c, i) => c + chars[i + 1]!)
        const need = Math.max(2, Math.ceil(grams.length * 0.6))
        return pool.filter((d) => {
          const hay = `${d.title} ${d.body}`
          return grams.filter((g) => hay.includes(g)).length >= need
        })
      })()

  return hits.slice(0, limit).map((d, i) => {
    const idx = d.body.indexOf(q)
    const snippet =
      idx >= 0
        ? `${idx > 20 ? '…' : ''}${d.body.slice(Math.max(0, idx - 20), idx + q.length + 20)}${idx + q.length + 20 < d.body.length ? '…' : ''}`
        : d.summary
    return { ...d, snippet, score: 1 / (i + 1), matched: tier }
  })
}

/* ---------- 校园教务（演示数据） ----------
 * 演示学期刻意锚定在「本周」，这样任何一天打开浏览器预览都能看到当周的课。
 * 「周次 → 公历日期」的展开在真实环境里由 Rust 完成，mock 必须自己算一遍，
 * 公式与 modules/campus/commands.rs::occurrence_date 保持一致。 */

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function campusMonday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

function campusRange(): [string, string] {
  const start = campusMonday()
  const from = new Date(start)
  from.setDate(from.getDate() - 7)
  const to = new Date(start)
  to.setDate(to.getDate() + 41)
  return [ymd(from), ymd(to)]
}

const CAMPUS_WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]

interface CampusSessionDemo {
  id: number
  courseId: number
  weekday: number
  startUnit: number
  endUnit: number
  startTime: string
  endTime: string
  weeks: number[]
  weeksStr: string | null
  room: string | null
  building: string | null
  campus: string | null
  courseName: string
  courseCode: string | null
  teachers: string[]
  credits: number | null
  courseType: string | null
  color: string | null
}

const CAMPUS_SLOTS = [
  { startUnit: 1, endUnit: 2, startTime: '08:00', endTime: '09:35', startMin: 480, durationMin: 95 },
  { startUnit: 3, endUnit: 4, startTime: '09:55', endTime: '11:30', startMin: 595, durationMin: 95 },
  { startUnit: 5, endUnit: 6, startTime: '14:00', endTime: '15:35', startMin: 840, durationMin: 95 },
  { startUnit: 7, endUnit: 8, startTime: '16:30', endTime: '18:05', startMin: 990, durationMin: 95 },
]

function campusSession(
  id: number,
  weekday: number,
  slot: (typeof CAMPUS_SLOTS)[number],
  courseName: string,
  code: string,
  teacher: string,
  room: string,
  color: string,
  weeks: number[] = CAMPUS_WEEKS,
): CampusSessionDemo {
  return {
    id,
    courseId: id,
    weekday,
    startUnit: slot.startUnit,
    endUnit: slot.endUnit,
    startTime: slot.startTime,
    endTime: slot.endTime,
    weeks,
    weeksStr: weeks.length ? `${weeks[0]}~${weeks[weeks.length - 1]}` : null,
    room,
    building: '花江校区第六教学楼',
    campus: '花江校区',
    courseName,
    courseCode: code,
    teachers: [teacher],
    credits: 3,
    courseType: '专业必修',
    color,
  }
}

const CAMPUS_SESSIONS: CampusSessionDemo[] = [
  campusSession(1, 1, CAMPUS_SLOTS[0]!, '高等数学（上）', '000001', '陈建国', '11A201', '#3B73B6'),
  campusSession(2, 3, CAMPUS_SLOTS[0]!, '高等数学（上）', '000001', '陈建国', '11A201', '#3B73B6'),
  campusSession(3, 2, CAMPUS_SLOTS[1]!, '大学英语（一）', '000002', 'Linda', '12B305', '#22A06B'),
  campusSession(4, 4, CAMPUS_SLOTS[1]!, '大学英语（一）', '000002', 'Linda', '12B305', '#22A06B'),
  campusSession(5, 1, CAMPUS_SLOTS[2]!, '数据结构与算法', '000101', '黄志远', '15C102', '#B5632E'),
  campusSession(6, 2, CAMPUS_SLOTS[2]!, '大学物理', '000201', '刘敏', '13A408', '#8257C8'),
  campusSession(7, 5, CAMPUS_SLOTS[1]!, '计算机组成原理', '000102', '周立', '15C210', '#C0392B'),
  campusSession(8, 5, CAMPUS_SLOTS[3]!, '体育（一）', '000301', '吴强', '体育馆', '#2E86C1', CAMPUS_WEEKS.filter((w) => w % 2 === 1)),
]

function campusExpand(
  sem: { startDate: string; weekStartOnSunday: boolean },
  from: string,
  to: string,
): unknown[] {
  const anchor = new Date(`${sem.startDate}T00:00:00`)
  const out: unknown[] = []
  for (const s of CAMPUS_SESSIONS) {
    for (const w of s.weeks) {
      const offset = s.weekday - 1
      const d = new Date(anchor)
      d.setDate(d.getDate() + (w - 1) * 7 + offset)
      const date = ymd(d)
      if (date < from || date > to) continue
      out.push({ date, week: w, session: s })
    }
  }
  out.sort((a, b) => {
    const x = a as { date: string; session: { startTime: string } }
    const y = b as { date: string; session: { startTime: string } }
    return x.date.localeCompare(y.date) || x.session.startTime.localeCompare(y.session.startTime)
  })
  return out
}

const campusSemester = () => ({
  id: 1,
  accountId: 1,
  remoteId: 321,
  code: '2026-2027_1',
  name: '2026-2027 第一学期',
  schoolYear: '2026-2027',
  season: 'AUTUMN',
  startDate: ymd(campusMonday()),
  endDate: ymd(new Date(campusMonday().getFullYear() + 1, 0, 24)),
  weekStartOnSunday: false,
  totalWeeks: 18,
  currentWeek: 1,
  isCurrent: true,
})

/** 物化窗口：过去一周 + 未来五周，与 Rust 的 MATERIALIZE_* 常量一致 */
const CAMPUS_BACK_DAYS = 7
const CAMPUS_FORWARD_DAYS = 35

const campusHhmmToMin = (t: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '')
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 派生行备注：第几节 · 教室 · 教师（与 Rust 的 class_notes 同构） */
function campusClassNotes(s: CampusSessionDemo): string | null {
  const bits: string[] = []
  if (s.startUnit > 0 && s.endUnit >= s.startUnit) {
    bits.push(s.startUnit === s.endUnit ? `第${s.startUnit}节` : `第${s.startUnit}-${s.endUnit}节`)
  }
  const place = [s.building, s.room].filter(Boolean).join(' ')
  if (place) bits.push(place)
  if (s.teachers.length) bits.push(s.teachers.join('、'))
  return bits.length ? bits.join(' · ') : null
}

/** 按日期区间展开成「某天某节课」的发生列表 */
function campusOccurrences(from: string, to: string): { date: string; session: CampusSessionDemo }[] {
  return campusExpand(campusSemester(), from, to) as { date: string; session: CampusSessionDemo }[]
}

/**
 * 重建课表在时间线上的派生行，返回写入条数。
 *
 * 与 Rust 的 `commands.rs::materialize_todos` 同一套语义：**先删后建**（幂等），
 * 且 `status='done'` 的历史行永不删除、重建时跳过「已存在完成行」的发生 ——
 * 否则用户打过卡的课会被重新创建成未完成态，同一天出现两行。
 *
 * mock 必须自己算这一遍，否则「课表进时间线」这个功能在浏览器里根本看不见。
 */
function campusMaterializeTodos(): number {
  for (let i = todos.length - 1; i >= 0; i--) {
    const t = todos[i]!
    if (t.courseSessionId != null && t.status !== 'done') todos.splice(i, 1)
  }

  const done = new Set<string>()
  for (const t of todos) {
    if (t.courseSessionId != null && t.status === 'done') done.add(`${t.courseSessionId}:${t.date}`)
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const from = new Date(today)
  from.setDate(from.getDate() - CAMPUS_BACK_DAYS)
  const to = new Date(today)
  to.setDate(to.getDate() + CAMPUS_FORWARD_DAYS)

  const now = new Date().toISOString()
  let written = 0
  for (const { date, session } of campusOccurrences(ymd(from), ymd(to))) {
    if (done.has(`${session.id}:${date}`)) continue
    const startMin = campusHhmmToMin(session.startTime)
    if (startMin == null) continue
    const endMin = campusHhmmToMin(session.endTime)
    todos.push({
      id: ++todoId,
      title: session.courseName,
      notes: campusClassNotes(session),
      date,
      startMin,
      durationMin: endMin != null && endMin > startMin ? endMin - startMin : 95,
      category: COURSE_CATEGORY,
      priority: 0,
      status: 'todo',
      completedAt: null,
      createdAt: now,
      courseSessionId: session.id,
      programId: null,
      recRule: null,
      recKey: null,
      subtasks: null,
      attachments: null,
    })
    written++
  }
  return written
}

const campusDemoCourses = () => {
  const seen = new Map<number, unknown>()
  for (const s of CAMPUS_SESSIONS) {
    if (seen.has(s.courseId)) continue
    seen.set(s.courseId, {
      id: s.courseId,
      semesterId: 1,
      remoteLessonId: s.courseId,
      courseCode: s.courseCode,
      courseName: s.courseName,
      lessonCode: null,
      lessonName: null,
      teachers: s.teachers,
      credits: s.credits,
      courseType: s.courseType,
      color: s.color,
    })
  }
  return [...seen.values()] as {
    id: number
    remoteLessonId: number
    courseName: string
    courseCode: string | null
    teachers: string[]
    credits: number | null
    color: string | null
  }[]
}

let campusAccount: Record<string, unknown> | null = null
let campusNeedCaptcha = false
let campusCourses = [] as ReturnType<typeof campusDemoCourses>

/* ---------- 救援面（AI 的最后补救）：审计 + 剧本化的原始请求 ----------
 * 浏览器里没有真教务，也没有真的 AI 会话，所以要验的是**这条链的形状**：
 * 「带会话的请求长什么样、审计里留下什么、导出的脚本能不能重放」。
 * 剧本刻意覆盖最要命的那组对照：会话活着但接口返回 HTML 回退（教务改接口）
 * vs 会话被踢回登录页 —— 这两件事的处理方式完全不同，判错就白折腾。 */

interface MockAiAction {
  id: number
  at: string
  kind: string
  summary: string
  detail?: unknown
  curl?: string | null
  status: 'ok' | 'error'
  accountId?: number | null
}

const mockAiActions: MockAiAction[] = []
let mockActionId = 0

function mockAction(kind: string, summary: string, curl?: string | null, status: 'ok' | 'error' = 'ok', detail?: unknown): number {
  mockAiActions.push({
    id: ++mockActionId,
    at: new Date().toISOString(),
    kind,
    summary,
    curl: curl ?? null,
    status,
    accountId: campusAccount ? 1 : null,
    detail,
  })
  return mockActionId
}

/** 与 Rust `rescue::render_curl` 同形：凭据写成变量引用，绝不在每行里复制一份 Cookie。 */
function mockRenderCurl(o: {
  method: string
  url: string
  headers: [string, string][]
  body?: string | null
  withCookie: boolean
  withToken: boolean
}): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const lines: string[] = []
  if (o.withCookie || o.withToken) {
    const vars = [o.withCookie ? 'COOKIE' : null, o.withToken ? 'SELECT_TOKEN' : null].filter(Boolean)
    lines.push(`# 先设变量再执行：export ${vars.join(' ')}='…'（导出脚本时脚本头部已定义）`)
  }
  let cmd = `curl -sS -i -X ${o.method} ${q(o.url)}`
  for (const [k, v] of o.headers) cmd += `\n  -H ${q(`${k}: ${v}`)}`
  if (o.withCookie) cmd += '\n  -H "Cookie: $COOKIE"'
  if (o.withToken) cmd += '\n  -H "Authorization: $SELECT_TOKEN"'
  if (o.body) cmd += `\n  --data-raw ${q(o.body)}`
  lines.push(cmd)
  return lines.join('\n')
}

/** 剧本化的响应体。命中不了就 404 —— 「教务回了个没见过的页面」本身也是要能演练的状态。 */
function mockHttpScript(url: string): { status: number; contentType: string; body: string } {
  const path = url.replace(/^https?:\/\/[^/]+/, '')
  const broken = !!(globalThis as { __REIN_MOCK_CAMPUS_BREAK__?: boolean })
    .__REIN_MOCK_CAMPUS_BREAK__
  const dead = !!(globalThis as { __REIN_MOCK_CAMPUS_SESSION_DEAD__?: boolean })
    .__REIN_MOCK_CAMPUS_SESSION_DEAD__

  // 会话被踢：门户用 302 回登录页，这是教务表达「你没登录」的唯一方式
  if (dead) {
    return { status: 302, contentType: 'text/html', body: '<html><body>302 → /login</body></html>' }
  }
  // 「教务改接口」：SPA 的回退页。信封不见了 —— 这正是最值钱的线索
  if (broken && path.startsWith('/course-selection-api/')) {
    return {
      status: 200,
      contentType: 'text/html;charset=UTF-8',
      body: '<!DOCTYPE html><html><head><title>选课</title></head><body><div id="app"></div></body></html>',
    }
  }
  if (path === '/student/home') {
    return { status: 200, contentType: 'text/html', body: '<html><body>桂电教务 · 学生首页</body></html>' }
  }
  if (path.includes('/course-selection-api/')) {
    if (path.includes('getCurrentDateTime')) {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: 0, message: '', data: campusServerTime() }),
      }
    }
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: 0, message: '', data: [] }),
    }
  }
  if (path.startsWith('/course-selection/')) {
    return { status: 200, contentType: 'text/html', body: '<html><body>选课 SPA</body></html>' }
  }
  return { status: 404, contentType: 'text/html', body: `<html><body>404 ${path}</body></html>` }
}

/* ---------- 选课（演示批次刻意设为「开放中」） ----------
 * 真实环境里大一新生的选课窗口还没开，`open-turns` 会返回空数组；
 * mock 这里给一个开放中的批次，好让「进入 → 查询 → 一键选 → 轮询结果」整套流程
 * 能在浏览器里走通并被 e2e 覆盖。空批次那条分支由真机构造（见 Rust 的真机联调测试）。 */

function campusServerTime(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function campusSelectTurns() {
  // e2e 钩子：置空批次列表，用来验证「选课窗口还没开放」的等待态 ——
  // 那才是大一新生的真实状态，而演示批次刻意是开放中的，两者都要能看。
  if ((globalThis as { __REIN_MOCK_NO_SELECT_TURN__?: boolean }).__REIN_MOCK_NO_SELECT_TURN__) {
    return []
  }
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  // 窗口从当天 00:00 起：写死在 08:00 的话，早上 7 点跑 e2e 会看到任务在「等开抢」而不是开抢，
  // 断言就随运行时刻飘了。演示批次要的是「窗口已经开着」这个状态。
  const opensAt = `${day} 00:00:00`
  const closesAt = `${day} 23:59:59`
  return [
    {
      id: 77,
      name: '2026-2027 第一学期 正选',
      bulletin: '本轮为正选轮次，先到先得。选中后请到「我的课表」核对。',
      allowEnter: true,
      disallowReasons: [],
      openDateTimeText: `${day} 00:00`,
      selectDateTimeText: `${day} 00:00 ~ 23:59`,
      dropDateTimeText: `${day} 00:00 ~ 23:59`,
      addRulesText: ['选课人数达到上限后不可再选'],
      dropRulesText: [],
      openDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
      selectDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
      dropDateTimeRange: { startDateTime: opensAt, endDateTime: closesAt },
    },
  ]
}

let campusPickedLessons = new Set<number>()
let campusSelectQueue: number[] = []
let campusSelectRequestId = ''
let campusSelectPolls = 0

function campusDemoLessons() {
  const mk = (
    id: number,
    code: string,
    nameZh: string,
    credits: number,
    stdCount: number,
    limitCount: number,
    groups: number,
    teachers: string[] = [],
  ) => ({
    id,
    course: { id: id * 10, code, nameZh, nameEn: null, credits },
    selectedLesson: campusPickedLessons.has(id)
      ? { status: '已选中', pinned: true, needAttend: false }
      : null,
    stdCount,
    limitCount,
    teachers: teachers.map((nameZh) => ({ nameZh })),
    scheduleGroups: Array.from({ length: groups }, (_, i) => ({
      id: id * 100 + i,
      no: i + 1,
      default: i === 0,
      limitCount: Math.floor(limitCount / groups),
      dateTimePlace: { text: `第${i + 1}组` },
    })),
    canSelect: true,
  })
  return [
    mk(9001, '000001', '高等数学（上）', 5, 118, 120, 2, ['李娜']),
    // 同一门课的第二个班，且已满、教师不同 ——
    // 计划的模糊匹配要能分辨「高数 张」与「000001 余量优先」这两件事
    mk(9006, '000001', '高等数学（上）', 5, 60, 60, 1, ['张伟']),
    // 9007 的老师名字**包含** 9006 的：用来验「打全了名字 = 只抢这位老师的班」
    // （查「张伟」不该把「张伟明」的班也拖进志愿组）
    mk(9007, '000003', '线性代数', 3, 40, 50, 1, ['张伟明']),
    mk(9002, '000002', '大学英语（一）', 3, 56, 60, 3, ['王芳']),
    // 9003 固定返回「需要免听」，用来演示时间冲突分支
    mk(9003, '000011', '大学物理（含实验）', 4, 60, 60, 1, ['刘洋']),
    mk(9004, '000021', '计算机科学导论', 2, 42, 80, 1, ['陈静']),
    // 9005 固定「先满员两次再放名额」，用来演示守着一个满员班的完整过程
    mk(9005, '000031', '体育（一）', 1, 30, 30, 4, ['赵强']),
  ]
}

/* ---------- 自动抢课（浏览器里的模拟引擎） ----------
 * 真实引擎在 Rust 后台线程（`modules/campus/grab.rs`），这里必须**自己实现一遍**：
 * 浏览器里没有那条线程，而「任务单会不会自己往前走」恰恰是这套 UI 的全部意义，
 * 不模拟的话 e2e 只能验一个静止的列表。
 *
 * 刻意压缩了时间尺度（轮询 400ms 而不是 2 秒）：断言的是**状态迁移**，不是时长。
 * 时间尺度上唯一不打折的是「开窗前不出手」那条闸门 —— 它是这套逻辑的核心不变量。 */

const GRAB_POLL_MS = 400
const GRAB_PROBE_MS = 1500

export const mockCampus: { onGrab: ((s: GrabState) => void) | null } = { onGrab: null }

interface MockGrabTask {
  id: number
  turnId: string
  turnName: string | null
  lessonId: unknown
  lessonName: string | null
  courseName: string | null
  courseCode: string | null
  teacher: string | null
  credits: number | null
  mode: 'predicate' | 'direct'
  virtualCost: number | null
  scheduleGroupId: unknown
  windowWall: string | null
  windowEndWall: string | null
  awaitWindow: boolean
  /** 占位是否已经交过。不能用 attempts===0 反推 —— 占位落定到正式提交之间它还是 0 */
  predicateDone: boolean
  status: string
  phase: 'idle' | 'submit' | 'poll'
  attempts: number
  polls: number
  strikes: number
  strikeKind: string | null
  requestId: string | null
  lastMessage: string | null
  nextAt: number
  fireAt: number | null
  queuedAt: number
  finishedAt: number | null
  /** 志愿组。同组互斥，只会中一个；空 = 独立任务 */
  groupKey: string | null
  groupName: string | null
  /** 志愿序：1 = 第一志愿，小的优先；0 = 不在组里 */
  priority: number
  /** 连续满员的起点（「让贤期限」读它） */
  stuckSince: number | null
  /** 派生值：把它压住的更高优先级任务 id（不落库，与真引擎一致） */
  heldBy: number | null
  /** mock 内部：窗口探测的下一次时刻 */
  probeAt?: number
  /** mock 内部：该教学班已报了几次满员 */
  fullTimes?: number
}

const grabTasks: MockGrabTask[] = []
let grabSeq = 0
let grabProbeSeq = 0
let grabLastEmit = ''

let grabSettings: GrabSettings = {
  minIntervalMs: 700,
  pollIntervalMs: 2000,
  fullRetryMs: 5000,
  backoffMs: 1500,
  maxBackoffMs: 30000,
  leadMs: 800,
  maxAttempts: 0,
  maxPolls: 15,
  cedeAfterMs: 0,
  watchWindow: true,
}

/* ---------------- 志愿组（与 Rust `grab.rs` 同一套规则） ----------------
 * 浏览器里没有那条后台线程，所以规则得在这儿再实现一遍 —— 但**必须同序**：
 * mock 与真引擎的行为只要分叉，e2e 就再也证明不了真引擎对不对。
 */
const GRAB_TERMINAL = new Set(['success', 'failed', 'conflict', 'cancelled'])

const grabGroupOf = (t: MockGrabTask): string => (t.groupKey ?? '').trim()

/** 是否已经让贤：连续满员超过期限（`cedeAfterMs === 0` 时恒为 false = 死守） */
function grabCeded(t: MockGrabTask, now: number): boolean {
  if (grabSettings.cedeAfterMs <= 0 || t.stuckSince == null) return false
  return now - t.stuckSince >= grabSettings.cedeAfterMs
}

/** 组里的当前志愿：还没结束的成员里 (priority, id) 最小的那个 */
function grabLead(group: string, now: number): MockGrabTask | null {
  const alive = grabTasks.filter(
    (t) => grabGroupOf(t) === group && !GRAB_TERMINAL.has(t.status) && t.status !== 'paused',
  )
  if (!alive.length) return null
  const fresh = alive.filter((t) => !grabCeded(t, now))
  // 整组都让贤了（罕见）就退回纯志愿序，否则整组会僵住
  const pool = fresh.length ? fresh : alive
  return pool.reduce((a, b) =>
    b.priority < a.priority || (b.priority === a.priority && b.id < a.id) ? b : a,
  )
}

/** 这个任务现在轮得到出手吗？不在组里的一律轮得到 */
function grabArmed(t: MockGrabTask, now: number): boolean {
  const g = grabGroupOf(t)
  if (!g) return true
  return grabLead(g, now)?.id === t.id
}

/** 同组有人中了：把其余还没结束的收摊（互斥志愿组的另一半保证） */
function grabCloseGroup(winner: MockGrabTask, now: number): void {
  const g = grabGroupOf(winner)
  if (!g) return
  const who = winner.courseName ?? winner.lessonName ?? '同组课程'
  for (const t of grabTasks) {
    if (grabGroupOf(t) !== g || t.id === winner.id || GRAB_TERMINAL.has(t.status)) continue
    t.status = 'cancelled'
    t.phase = 'idle'
    t.finishedAt = now
    t.lastMessage = `已被第 ${winner.priority} 志愿「${who}」抢先`
  }
}

/** 窗口监听的结果。`__REIN_MOCK_GRAB_TURNS__` 可以直接把批次摆出来（给 e2e 用）。 */
function grabTurns(): GrabTurnBrief[] {
  const g = globalThis as {
    __REIN_MOCK_GRAB_TURNS__?: GrabTurnBrief[]
    __REIN_MOCK_GRAB_NO_WINDOW__?: boolean
  }
  if (g.__REIN_MOCK_GRAB_TURNS__) return g.__REIN_MOCK_GRAB_TURNS__
  if (g.__REIN_MOCK_GRAB_NO_WINDOW__) return []
  const seen = new Map<string, GrabTurnBrief>()
  for (const t of grabTasks) {
    if (!t.windowWall || seen.has(t.turnId)) continue
    seen.set(t.turnId, {
      id: t.turnId,
      name: t.turnName,
      allowEnter: true,
      selectText: null,
      windowStart: t.windowWall,
      windowEnd: t.windowEndWall,
    })
  }
  return [...seen.values()]
}

/** 教务墙钟文本 → 本机毫秒。mock 里偏差恒为 0，所以按本地时区解析即可。 */
function grabWallToMs(text: string): number {
  const d = new Date(text.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

function grabWallOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ---------------- 计划的模糊匹配（与 Rust `matcher.rs` 同一套语义） ----------------
 *
 * mock 里必须再实现一遍：e2e 断言的是**界面显示出来的匹配与排序**，而它在真机上出自引擎。
 * 两边一旦分叉，这条 e2e 就什么都证明不了 —— 所以这里的规则逐条对齐 Rust：
 * 空格分词（每个词都要命中）、连续子串优先、退化为散落子序列、按抢课语义排序。 */

const GRAB_FIELD_WEIGHT: Record<string, number> = {
  course: 1,
  code: 0.85,
  teacher: 0.75,
  place: 0.5,
}

function grabNormalize(s: string): string {
  return s.toLowerCase().replace(/[\s()（）[\]【】·\-_—/\\、,，.。:：]/g, '')
}

/** 散落子序列命中：字符按序出现即可，按「被打散的程度」扣分 */
function grabSubseqScore(hay: string, needle: string): number | null {
  if (!needle.length || needle.length > hay.length) return null
  let cursor = 0
  let first = -1
  let last = 0
  for (const ch of needle) {
    const at = hay.indexOf(ch, cursor)
    if (at < 0) return null
    if (first < 0) first = at
    last = at
    cursor = at + 1
  }
  const span = last - first + 1
  return 360 - (span - needle.length) * 12 - Math.min(40, first)
}

function grabFieldScore(text: string, token: string): number | null {
  const hay = grabNormalize(text)
  if (!hay) return null
  if (hay === token) return 1000
  const pos = hay.indexOf(token)
  if (pos >= 0) return 700 - Math.min(60, pos) + (pos === 0 ? 120 : 0)
  return grabSubseqScore(hay, token)
}

/** 一个教学班身上所有可匹配的文本（权重与 Rust 一致，课程名最重） */
function grabLessonFields(l: Record<string, any>): {
  tag: string
  text: string
  names?: string[]
}[] {
  const out: { tag: string; text: string; names?: string[] }[] = []
  const course = l.course ?? {}
  for (const name of [course.nameZh, course.nameEn]) {
    if (typeof name === 'string' && name.trim()) out.push({ tag: 'course', text: name })
  }
  if (typeof course.code === 'string' && course.code.trim()) out.push({ tag: 'code', text: course.code })
  const teachers = (l.teachers ?? [])
    .map((t: any) => t?.nameZh ?? t?.person?.nameZh)
    .filter(Boolean)
  if (teachers.length) out.push({ tag: 'teacher', text: teachers.join('、'), names: teachers })
  const place: string[] = []
  const walk = (v: any): void => {
    if (typeof v === 'string') place.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  ;(l.scheduleGroups ?? []).forEach((g: any) => walk(g?.dateTimePlace))
  if (place.length) out.push({ tag: 'place', text: place.join(' ') })
  return out
}

/* 教师命中分三档（与 Rust `matcher.rs` 逐条对齐）：
 *   精确 = 全名全等 → 那是「指定」，只抢这位老师的班（见 grabPreferred）
 *   普通 = 子串 / 子序列命中
 *   近似 = 姓对了、其余最多差一个字 → 名字打错时的退路，只加分不独占 */
const GRAB_TEACHER_EXACT_SCORE = 1000
const GRAB_TEACHER_NEAR_SCORE = 240

function grabLcsLen(a: string[], b: string[]): number {
  let prev = new Array(b.length + 1).fill(0)
  let cur = new Array(b.length + 1).fill(0)
  for (const ca of a) {
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = ca === b[j] ? prev[j] + 1 : Math.max(cur[j], prev[j + 1])
    }
    const t = prev
    prev = cur
    cur = t
    cur.fill(0)
  }
  return prev[b.length]
}

/** 「姓对了、其余最多差一个字」：单字查询不放行（那是子串匹配的活） */
function grabNearName(name: string, token: string): boolean {
  const n = [...grabNormalize(name)]
  const q = [...grabNormalize(token)]
  if (q.length < 2 || !n.length || n[0] !== q[0]) return false
  return grabLcsLen(n, q) + 1 >= q.length
}

/** 一个词在一个字段里的命中：教师字段精确 → 通用 → 近似，精确独占，其余取分高的 */
function grabFieldHit(
  f: { tag: string; text: string; names?: string[] },
  token: string,
): { score: number; tag: string } | null {
  const weight = GRAB_FIELD_WEIGHT[f.tag] ?? 1
  if (f.tag === 'teacher') {
    const names = f.names ?? []
    if (names.some((n) => grabNormalize(n) === token)) {
      return { score: Math.round(GRAB_TEACHER_EXACT_SCORE * weight), tag: 'teacherExact' }
    }
    const raw = grabFieldScore(f.text, token)
    const generic = raw == null ? null : { score: Math.round(raw * weight), tag: 'teacher' }
    const nearName = names.find((n) => grabNearName(n, token))
    const near = nearName
      ? {
          score: Math.round(
            (GRAB_TEACHER_NEAR_SCORE - Math.abs([...nearName].length - [...token].length) * 20) * weight,
          ),
          tag: 'teacherNear',
        }
      : null
    if (generic && near) return generic.score >= near.score ? generic : near
    return generic ?? near
  }
  const s = grabFieldScore(f.text, token)
  return s == null ? null : { score: Math.round(s * weight), tag: f.tag }
}

interface GrabHit {
  lesson: Record<string, any>
  score: number
  fields: string[]
  /** 有词**精确命中**了教师名 —— 「我就要这位老师的课」的唯一判据（与 Rust 同名） */
  hard: boolean
}

const grabRemaining = (l: Record<string, any>): number | null =>
  l.stdCount != null && l.limitCount != null ? l.limitCount - l.stdCount : null

function grabMatchLessons(query: string, lessons: Record<string, any>[]): GrabHit[] {
  const tokens = query
    .split(/\s+/)
    .map(grabNormalize)
    .filter(Boolean)
  if (!tokens.length) return []

  const hits: GrabHit[] = []
  for (const l of lessons) {
    const fields = grabLessonFields(l)
    const used: string[] = []
    let total = 0
    let hard = false
    let ok = true
    for (const token of tokens) {
      // 一个词可能同时落在多个字段上：分数取最高，但每个命中都记下来 ——
      // 精确命中的教师不能被课名那次更高的分吞掉
      let best: number | null = null
      for (const f of fields) {
        const h = grabFieldHit(f, token)
        if (!h) continue
        best = best == null ? h.score : Math.max(best, h.score)
        if (h.tag === 'teacherExact') hard = true
        if (!used.includes(h.tag)) used.push(h.tag)
      }
      if (best == null) {
        ok = false
        break
      }
      total += best
    }
    if (ok) hits.push({ lesson: l, score: total, fields: used, hard })
  }

  // 抢课语义的排序：没选过的在前 → **精确指定了老师的在前** → 分高的在前 →
  // 有空位的在前 → 余量多的在前 → id 稳定。
  // 分在空位之前（与 Rust 同序）：查「张玮」时满员的「张伟」不能被有余量的
  // 「张伟明」挤到后面 —— 一个错字不该让目标换人。
  hits.sort((a, b) => {
    const pick = Number(a.lesson.selectedLesson != null) - Number(b.lesson.selectedLesson != null)
    if (pick) return pick
    const hard = Number(!a.hard) - Number(!b.hard)
    if (hard) return hard
    if (a.score !== b.score) return b.score - a.score
    const ra = grabRemaining(a.lesson)
    const rb = grabRemaining(b.lesson)
    const full = Number(ra != null && ra <= 0) - Number(rb != null && rb <= 0)
    if (full) return full
    const left = (rb ?? -1) - (ra ?? -1)
    if (left) return left
    return Number(a.lesson.id) - Number(b.lesson.id)
  })
  return hits
}

/**
 * 计划要抢的那一批（与 Rust `matcher::preferred` 同规则）：
 * 打全了老师名字 → 只抢那位老师的班；只打姓 / 打错字 → 原样返回，交给模糊匹配。
 */
function grabPreferred(hits: GrabHit[]): GrabHit[] {
  return hits.some((h) => h.hard) ? hits.filter((h) => h.hard) : hits
}

/** 命中 → 界面形状（与 Rust `matcher::to_match` 同形） */
function grabMatchDto(h: GrabHit): GrabMatch {
  const l = h.lesson
  const teachers = (l.teachers ?? []).map((t: any) => t?.nameZh ?? t?.person?.nameZh).filter(Boolean)
  return {
    lessonId: l.id,
    courseName: l.course?.nameZh ?? l.course?.nameEn ?? null,
    courseCode: l.course?.code ?? null,
    teacher: teachers.length ? teachers.join('、') : null,
    stdCount: l.stdCount ?? null,
    limitCount: l.limitCount ?? null,
    picked: l.selectedLesson != null,
    fields: h.fields,
  }
}

/** 命中分堆：默认合成一组（只中一个），`spread` 时按课程分堆（每门课各中一个） */
function grabPlanGroups(hits: GrabHit[], spread: boolean): GrabHit[][] {
  const grabbable = hits.filter((h) => h.lesson.selectedLesson == null)
  if (!grabbable.length) return []
  if (!spread) return [grabbable]
  const order: string[] = []
  const buckets = new Map<string, GrabHit[]>()
  for (const h of grabbable) {
    const c = h.lesson.course ?? {}
    const key = c.code?.trim() || c.nameZh?.trim() || String(h.lesson.id)
    if (!buckets.has(key)) order.push(key)
    const list = buckets.get(key) ?? []
    list.push(h)
    buckets.set(key, list)
  }
  return order.map((k) => buckets.get(k)!)
}

/* ---------------- 抢课计划（意向） ---------------- */

/** 计划解析失败/没匹配到之后的重试间隔（真引擎是 60 秒，mock 压到 2 秒） */
const GRAB_INTENT_RETRY_MS = 2000

interface MockGrabIntent extends GrabIntent {
  /** mock 内部：下一次该重试解析的时刻 */
  nextAt: number
}

const grabIntents: MockGrabIntent[] = []
let grabIntentSeq = 0

/** 批次摘要：与真引擎读的 `open-turns` 对应（mock 里就是那个演示批次） */
function grabIntentBriefs(): GrabTurnBrief[] {
  const noWindow = !!(globalThis as { __REIN_MOCK_GRAB_NO_WINDOW__?: boolean })
    .__REIN_MOCK_GRAB_NO_WINDOW__
  return campusSelectTurns().map((t) => ({
    id: String(t.id),
    name: t.name ?? null,
    allowEnter: !!t.allowEnter,
    selectText: t.selectDateTimeText ?? null,
    windowStart: noWindow ? null : (t.selectDateTimeRange?.startDateTime ?? null),
    windowEnd: noWindow ? null : (t.selectDateTimeRange?.endDateTime ?? null),
  }))
}

/**
 * 解析一条到点的计划 —— 与真引擎同序：挑批次 → 拉名单 → 模糊匹配 → 分堆建任务。
 * 一轮只做一条，返回「有没有干活」。
 */
function grabResolveIntents(): boolean {
  const now = Date.now()
  const due = grabIntents.find(
    (i) => (i.status === 'pending' || i.status === 'empty') && i.nextAt <= now,
  )
  if (!due) return false
  due.attempts += 1

  const briefs = grabIntentBriefs()
  const brief = due.turnId
    ? briefs.find((b) => b.id === due.turnId)
    : (briefs.find((b) => b.allowEnter) ?? briefs[0])
  if (!brief) {
    due.status = 'pending'
    due.lastMessage = '还没看到这个选课批次，教务公布后会自动继续'
    due.nextAt = now + GRAB_INTENT_RETRY_MS
    return true
  }
  due.turnId = brief.id
  due.turnName = brief.name ?? null

  const hits = grabMatchLessons(due.query, campusDemoLessons())
  // 打全了老师名字 → 那是指定，只抢他的班；只打姓 / 打错字 → 模糊匹配照旧
  const pool = grabPreferred(hits)
  const pickedOff = hits.length - pool.length
  const groups = grabPlanGroups(pool, !!due.spread)
  if (!groups.length) {
    due.status = 'empty'
    due.lastMessage = hits.length
      ? '匹配到的教学班都已经在你名下了'
      : `没匹配到「${due.query}」—— 课名 / 课程代码 / 教师名都可以，空格分词`
    due.nextAt = now + GRAB_INTENT_RETRY_MS
    return true
  }

  const awaitWindow = !brief.windowStart && !brief.allowEnter
  const keys: string[] = []
  let created = 0
  groups.forEach((group, gi) => {
    // 与 Rust 一致：一条计划生成的组用 `intent-{id}` 起头，界面靠它把任务归到计划名下
    const key = groups.length === 1 ? `intent-${due.id}` : `intent-${due.id}-${gi + 1}`
    const groupName = (due.spread ? group[0]?.lesson.course?.nameZh : null) ?? due.query
    let made = false
    group.forEach((h, i) => {
      if (grabTasks.some((t) => String(t.lessonId) === String(h.lesson.id) && !GRAB_TERMINAL.has(t.status))) {
        return // 同一门课已经在抢了
      }
      grabPushTask({
        turnId: brief.id,
        turnName: brief.name,
        lessonId: h.lesson.id,
        courseName: h.lesson.course?.nameZh ?? null,
        courseCode: h.lesson.course?.code ?? null,
        teacher: grabMatchDto(h).teacher,
        credits: h.lesson.course?.credits ?? null,
        mode: due.mode,
        scheduleGroupId: h.lesson.scheduleGroups?.length === 1 ? h.lesson.scheduleGroups[0].id : null,
        windowWall: brief.windowStart ?? null,
        windowEndWall: brief.windowEnd ?? null,
        awaitWindow,
        groupKey: key,
        groupName,
        priority: i + 1,
      })
      made = true
      created += 1
    })
    if (made) keys.push(key)
  })

  due.status = 'ready'
  due.groupKeys = keys
  // 候选只列**真会抢的**那些班：被「指定老师」筛掉的不列出来，
  // 否则用户会问「为什么预览里有它、任务单里没有」
  due.candidates = pool.slice(0, 12).map(grabMatchDto)
  due.resolvedAt = now
  due.nextAt = now
  // 指定了老师就明说一句 —— 用户下次看到这条计划时，那是解释而不是意外
  const byTeacher = pickedOff > 0 ? `，只抢指定教师的班（另有 ${pickedOff} 个匹配被滤掉）` : ''
  due.lastMessage =
    created === 0
      ? '这些教学班都已经在抢了'
      : groups.length > 1
        ? `已为 ${groups.length} 门课各排一组，共 ${created} 个志愿${byTeacher}`
        : `已排入 ${created} 个志愿，按序出手${byTeacher}`
  return true
}

/** 造一条任务 —— 手动入队与计划解析共用同一形状（否则两种来源的任务会长得不一样） */
function grabPushTask(input: {
  turnId: string
  turnName?: string | null
  lessonId: unknown
  lessonName?: string | null
  courseName?: string | null
  courseCode?: string | null
  teacher?: string | null
  credits?: number | null
  mode: 'predicate' | 'direct'
  virtualCost?: number | null
  scheduleGroupId?: unknown
  windowWall?: string | null
  windowEndWall?: string | null
  awaitWindow?: boolean
  groupKey?: string | null
  groupName?: string | null
  priority?: number
}): MockGrabTask {
  const id = ++grabSeq
  const windowWall = input.windowWall ?? null
  const task: MockGrabTask = {
    id,
    turnId: input.turnId,
    turnName: input.turnName ?? null,
    lessonId: input.lessonId,
    lessonName: input.lessonName ?? null,
    courseName: input.courseName ?? null,
    courseCode: input.courseCode ?? null,
    teacher: input.teacher ?? null,
    credits: input.credits ?? null,
    mode: input.mode,
    virtualCost: input.virtualCost ?? null,
    scheduleGroupId: input.scheduleGroupId ?? null,
    windowWall,
    windowEndWall: input.windowEndWall ?? null,
    // 没有窗口就往「等窗口」走 —— 盲撞出来的「不在选课时间」会被判终态
    awaitWindow: input.awaitWindow ?? !windowWall,
    predicateDone: false,
    status: 'waiting',
    phase: 'idle',
    attempts: 0,
    polls: 0,
    strikes: 0,
    strikeKind: null,
    requestId: null,
    lastMessage: windowWall ? `已排队，${windowWall} 开抢` : '等待教务公布选课窗口',
    nextAt: Date.now(),
    fireAt: null,
    queuedAt: Date.now(),
    finishedAt: null,
    groupKey: input.groupKey ?? null,
    groupName: input.groupName ?? null,
    priority: input.priority ?? 0,
    stuckSince: null,
    heldBy: null,
  }
  grabTasks.unshift(task)
  return task
}

function grabSnapshot(): GrabState {
  const now = Date.now()
  const active = grabTasks.some((t) => t.status === 'waiting' || t.status === 'running')
  // 派生值：谁被谁压着。与真引擎一样在快照这一层算，不落库
  const leads = new Map<string, number>()
  for (const t of grabTasks) {
    const g = grabGroupOf(t)
    if (!g || leads.has(g)) continue
    const lead = grabLead(g, now)
    if (lead) leads.set(g, lead.id)
  }
  return {
    alive: true,
    active,
    serverTime: grabWallOf(now),
    skewSec: 0,
    nextAt: grabTasks
      .filter((t) => t.status === 'waiting' || t.status === 'running')
      .reduce<number | null>((min, t) => (min == null ? t.nextAt : Math.min(min, t.nextAt)), null),
    nextFireAt: grabTasks
      .filter((t) => t.status === 'waiting' || t.status === 'running')
      .reduce<number | null>(
        (min, t) => (t.fireAt == null ? min : min == null ? t.fireAt : Math.min(min, t.fireAt)),
        null,
      ),
    lastError: null,
    turns: grabTurns(),
    probedAt: now,
    intents: grabIntents.map((i) => ({
      ...i,
      groupKeys: [...(i.groupKeys ?? [])],
      candidates: [...(i.candidates ?? [])],
    })),
    tasks: grabTasks.map((t) => {
      const g = grabGroupOf(t)
      const lead = g ? leads.get(g) : undefined
      // 只有还在场上的才谈得上被谁压着：终态/暂停的任务不在等任何人
      const inPlay = !GRAB_TERMINAL.has(t.status) && t.status !== 'paused'
      return { ...t, heldBy: inPlay && lead != null && lead !== t.id ? lead : null }
    }) as unknown as GrabState['tasks'],
  }
}

function grabEmit(): void {
  const snap = grabSnapshot()
  const json = JSON.stringify(snap)
  if (json === grabLastEmit) return
  grabLastEmit = json
  mockCampus.onGrab?.(snap)
}

/** 一轮推进：与 Rust 引擎同序 —— 先过窗口闸门，再做一步提交或轮询。 */
function grabTick(): void {
  const now = Date.now()
  // 先解析计划：它可能要新建任务（下面那一轮循环立刻就能推进它们）
  let worked = grabResolveIntents()

  for (const t of grabTasks) {
    if (t.status !== 'waiting' && t.status !== 'running') continue

    // ① 窗口还没公布：定期去「问」一次（3 秒后公布，用来演示等窗口这个真实状态）
    if (t.awaitWindow && !t.windowWall) {
      t.probeAt ??= now + GRAB_PROBE_MS
      if (now >= t.probeAt) {
        t.windowWall = grabWallOf(now)
        t.windowEndWall = grabWallOf(now + 6 * 3600_000)
        t.awaitWindow = false
        t.lastMessage = `已获知选课窗口：${t.windowWall} 开放`
        t.nextAt = now
        worked = true
      } else {
        t.lastMessage = '等待教务公布选课窗口'
        continue
      }
    }

    // ② 志愿组：没轮到它就站着别动 —— 也不参与任何计时推进。
    //    排在窗口探测之后：探测是引擎级的事，跟轮到谁出手无关。
    if (!grabArmed(t, now)) continue

    // ③ 开窗闸门：**没到点绝不出手**。闸门只管第一枪 ——
    //    交过占位或正式提交过之后，任务就完全由重试节奏支配了。
    t.fireAt =
      t.attempts === 0 && !t.predicateDone && t.windowWall
        ? grabWallToMs(t.windowWall) - grabSettings.leadMs
        : null
    if (t.fireAt != null && now < t.fireAt) continue
    if (now < t.nextAt) continue

    t.queuedAt ||= now
    t.status = 'running'

    if (t.phase === 'poll' && t.requestId) {
      t.polls += 1
      if (t.polls < 2) {
        t.lastMessage = '教务处理中'
        t.nextAt = now + GRAB_POLL_MS
        worked = true
        continue
      }
      // 占位落定 → 转正式确认（这一步不留间隔）
      if (t.mode === 'predicate' && !t.predicateDone) {
        t.phase = 'submit'
        t.requestId = null
        t.polls = 0
        t.nextAt = now
        t.lastMessage = '占位成功，正在正式确认'
        worked = true
        continue
      }
      // 正式提交的结果
      const id = Number(t.lessonId)
      if (id === 9003) {
        t.status = 'conflict'
        t.phase = 'idle'
        t.finishedAt = now
        t.lastMessage = '与已选课程时间冲突，需到教务网页端办理免听'
        worked = true
        continue
      }
      t.fullTimes = t.fullTimes ?? 0
      if (id === 9005 && t.fullTimes < 2) {
        t.fullTimes += 1
        t.strikes += 1
        t.strikeKind = 'full'
        // 满员是持续状态：记下起点，「让贤期限」才有东西可读
        t.stuckSince ??= now
        t.status = 'waiting'
        t.phase = 'idle'
        t.lastMessage = '已选人数已达上限'
        t.nextAt = now + GRAB_POLL_MS
        worked = true
        continue
      }
      campusPickedLessons.add(id)
      t.status = 'success'
      t.phase = 'idle'
      t.requestId = null
      t.finishedAt = now
      t.lastMessage = '已抢到'
      // 中选即收组：同组备选与它互斥，继续抢只会多抢到一门冲突课
      grabCloseGroup(t, now)
      worked = true
      continue
    }

    // ③ 提交一步
    if (t.mode === 'predicate' && !t.predicateDone) {
      t.phase = 'poll'
      t.predicateDone = true
      t.requestId = `gp${++grabProbeSeq}`
      t.polls = 0
      t.lastMessage = '已占位，等待教务受理'
      t.nextAt = now + GRAB_POLL_MS
    } else {
      t.attempts += 1
      t.phase = 'poll'
      t.requestId = `gr${++grabProbeSeq}`
      t.polls = 0
      t.lastMessage =
        t.attempts === 1 ? '已提交，等待教务处理' : `第 ${t.attempts} 次提交，等待教务处理`
      t.nextAt = now + GRAB_POLL_MS
    }
    worked = true
  }

  if (worked) grabEmit()
}

setInterval(grabTick, 250)

function grabFind(id: number): MockGrabTask | undefined {
  return grabTasks.find((t) => t.id === id)
}


/* ---------- 在线更新（mock：把「检查 → 下载 → 装」整条链路在浏览器里跑通） ----------
 *
 * 浏览器里没有 Rust 的 UpdateHub，也没有真实网络，所以这里自己维护一份同形的
 * 状态机，连**控制开关**都对齐真机的复杂度来源：
 *   window.__REIN_MOCK_UPDATE_NONE__    = true  → 检查结果「已是最新」
 *   window.__REIN_MOCK_SERVICE_OFFLINE__ = true → 在线服务探测不可达
 *   window.__REIN_MOCK_UPDATE_FAIL__     = true → 下载必定失败（用来验失败态与重试入口）
 * 唯一压缩的是时间尺度：3 秒下完，而不是真下几十 MB。
 */

const MOCK_CURRENT_VERSION = '0.2.1'
const MOCK_LATEST_VERSION = '0.2.2'

function mockFlag(name: string): boolean {
  return typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)[name] === true
}

function defaultUpdateSettings(): UpdateSettings {
  return {
    enabled: true,
    channel: 'stable',
    autoCheck: true,
    checkIntervalHours: 12,
    lastCheckAt: null,
    lastSeenVersion: null,
    ignoredVersion: null,
    allowHttp: true,
    silentInstall: false,
    sources: [
      {
        id: 'rein-service',
        name: 'Rein 在线服务',
        kind: 'rein',
        url: 'http://47.100.36.179:8787/updates/latest.json',
        enabled: true,
        priority: 0,
      },
      {
        id: 'github',
        name: 'GitHub Release',
        kind: 'tauri-static',
        url: 'https://github.com/gozaoo-coder/Rein/releases/latest/download/latest.json',
        enabled: true,
        priority: 10,
      },
    ],
  }
}

let updateSettings: UpdateSettings = defaultUpdateSettings()
let updateCheck: UpdateCheck | null = null
let updateDownload: DownloadState = idleDownload()
let updateTimer: ReturnType<typeof setInterval> | null = null

function idleDownload(): DownloadState {
  return {
    phase: 'idle',
    version: null,
    target: 'windows-x86_64',
    url: null,
    sourceName: null,
    received: 0,
    total: 0,
    bytesPerSec: 0,
    percent: 0,
    file: null,
    verified: false,
    error: null,
    startedAt: null,
    updatedAt: null,
  }
}

function stopUpdateTimer(): void {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
}

/** 演示用：下载进度按 200ms 一跳走满，然后进入「校验 → 就绪」。 */
function startMockDownload(): void {
  const total = 42 * 1024 * 1024
  updateDownload = {
    ...idleDownload(),
    phase: 'downloading',
    version: MOCK_LATEST_VERSION,
    url: 'http://47.100.36.179:8787/dl/stable/0.2.1/Rein-0.2.1-arm64.apk',
    sourceName: 'Rein 在线服务',
    total,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  stopUpdateTimer()
  updateTimer = setInterval(() => {
    if (updateDownload.phase !== 'downloading') return
    const next = Math.min(total, updateDownload.received + total / 15)
    updateDownload = {
      ...updateDownload,
      received: next,
      bytesPerSec: total / 15 / 0.2,
      percent: (next / total) * 100,
      updatedAt: new Date().toISOString(),
    }
    if (next >= total) {
      updateDownload = { ...updateDownload, phase: 'verifying', updatedAt: new Date().toISOString() }
      setTimeout(() => {
        if (mockFlag('__REIN_MOCK_UPDATE_FAIL__')) {
          updateDownload = {
            ...updateDownload,
            phase: 'failed',
            verified: false,
            error: '安装包签名校验失败：签名 keyId 与内置公钥不匹配',
          }
          return
        }
        updateDownload = {
          ...updateDownload,
          phase: 'ready',
          verified: true,
          file: 'updates/Rein-0.2.1-arm64.apk',
          updatedAt: new Date().toISOString(),
        }
      }, 600)
    }
  }, 200)
}

function updateSnapshot(): UpdateSnapshot {
  return {
    currentVersion: MOCK_CURRENT_VERSION,
    platform: 'windows-x86_64',
    installSupported: true,
    installHint: '下载完成后会静默运行安装器并重启应用',
    settings: updateSettings,
    check: updateCheck,
    download: updateDownload,
    readyToInstall: updateDownload.verified,
  }
}

export async function mockInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  switch (cmd) {
    case 'list_foods': {
      const q = String(args.query ?? '').toLowerCase()
      const cat = args.category as string | null
      const limit = Number(args.limit ?? 60)
      const list = foods.filter(
        (f) =>
          (!q || f.name.toLowerCase().includes(q) || (f.category ?? '').toLowerCase().includes(q)) &&
          (!cat || f.category === cat),
      )
      return delay(list.slice(0, limit) as T)
    }

    case 'search_foods_fuzzy': {
      const q = String(args.query ?? '').trim()
      const limit = Number(args.limit ?? 20)
      if (!q) return delay(foods.slice(0, limit) as T)
      const scored = foods
        .map((f) => ({ f, s: mockFuzzyScore(q, f.name) }))
        .filter((x) => x.s >= 35)
        .sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length || a.f.id - b.f.id)
      return delay(scored.slice(0, limit).map((x) => x.f) as T)
    }

    case 'web_search':
    case 'web_fetch': {
      const url =
        cmd === 'web_search'
          ? `https://www.bing.com/search?q=${encodeURIComponent(String(args.query ?? '').trim())}`
          : String(args.url ?? '')
      if (!url) throw new Error('搜索关键词或 URL 不能为空')
      const maxChars = Number(args.maxChars ?? 6000)
      try {
        return delay((await mockWebFetch(url, maxChars)) as T)
      } catch (e) {
        throw new Error(
          `浏览器开发环境无法抓取网页（CORS 限制：${e instanceof Error ? e.message : String(e)}），请在 Tauri 桌面端使用 web 工具`,
        )
      }
    }

    case 'share_poll':
      // 浏览器开发环境没有系统分享收件箱
      return delay([] as T)

    case 'share_read':
      throw new Error('浏览器开发环境没有分享收件箱')

    case 'get_food': {
      const f = foods.find((x) => x.id === Number(args.id)) ?? null
      return delay((f ? structuredClone(f) : null) as T)
    }

    case 'create_food': {
      const input = plain(args.food as FoodCreateInput)
      const name = input.name.trim()
      const exist = foods.find((x) => x.name === name)
      if (exist) return delay({ food: structuredClone(exist), created: false } as T)
      const food: Food = {
        id: ++foodId,
        name,
        category: input.category ?? null,
        ...zeroIntake(),
        kcal: Number(input.kcal) || 0,
        protein: Number(input.protein) || 0,
        carb: Number(input.carb) || 0,
        fat: Number(input.fat) || 0,
        fiber: Number(input.fiber) || 0,
        sugar: Number(input.sugar) || 0,
        sodiumMg: Number(input.sodiumMg) || 0,
        defaultUnit: input.defaultUnit ?? null,
        units: (input.units ?? []).map((u) => ({ name: String(u.name), grams: Number(u.grams) || 0 })),
      }
      foods.push(food)
      return delay({ food: structuredClone(food), created: true } as T)
    }

    case 'list_meals': {
      const date = String(args.date)
      const list = meals
        .filter((m) => m.date === date)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return delay(structuredClone(list) as T)
    }

    case 'list_meals_range': {
      const start = String(args.startDate)
      const end = String(args.endDate)
      const list = meals
        .filter((m) => m.date >= start && m.date <= end)
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      return delay(structuredClone(list) as T)
    }

    case 'log_meal': {
      const f = foods.find((x) => x.id === args.foodId)!
      const log: MealLog = {
        id: ++mealId,
        foodId: f.id,
        date: String(args.date),
        mealType: args.mealType as MealLog['mealType'],
        quantityMode: args.quantityMode as MealLog['quantityMode'],
        grams: Number(args.grams),
        units: (args.units as number | null) ?? null,
        unitName: (args.unitName as string | null) ?? null,
        source: args.source as MealLog['source'],
        note: (args.note as string | null) ?? null,
        createdAt: new Date().toISOString(),
        food: f,
      }
      meals.push(log)
      return delay(structuredClone(log) as T)
    }

    case 'delete_meal': {
      const i = meals.findIndex((m) => m.id === args.id)
      if (i !== -1) meals.splice(i, 1)
      return delay(undefined as T)
    }

    case 'recipe_prefs_list':
      return delay(structuredClone(recipePrefs) as T)

    case 'recipe_prefs_set': {
      const input = args.input as { recipeId: string; rating: number }
      if (input.rating !== 1 && input.rating !== -1) throw new Error('rating 应为 1（喜欢）或 -1（不喜欢）')
      const now = new Date().toISOString()
      const i = recipePrefs.findIndex((p) => p.recipeId === input.recipeId)
      if (i !== -1) {
        recipePrefs[i] = { recipeId: input.recipeId, rating: input.rating, updatedAt: now }
      } else {
        recipePrefs.push({ recipeId: input.recipeId, rating: input.rating, updatedAt: now })
      }
      return delay(structuredClone(recipePrefs.find((p) => p.recipeId === input.recipeId)) as T)
    }

    case 'recipe_prefs_delete': {
      const i = recipePrefs.findIndex((p) => p.recipeId === args.recipeId)
      if (i !== -1) recipePrefs.splice(i, 1)
      return delay(undefined as T)
    }

    case 'get_daily_summary':
      return delay(summarize(String(args.date)) as T)

    case 'get_targets':
      return delay({ ...profile.targets } as T)

    case 'set_targets':
      return delay((() => {
        profile.targets = plain(args.targets as DailyTargets)
        return undefined
      })() as T)

    case 'get_profile':
      return delay(structuredClone(profile) as T)

    case 'update_profile':
      return delay((() => {
        Object.assign(profile, plain(args.profile))
        return structuredClone(profile)
      })() as T)

    case 'get_calc_state':
      return delay((bodyStore.calc ? structuredClone(bodyStore.calc) : null) as T)

    case 'save_calc_state': {
      const s = plain(args.s as CalcState)
      s.savedAt = new Date().toISOString()
      bodyStore.calc = s
      saveBody()
      return delay(structuredClone(s) as T)
    }

    case 'list_body_metrics': {
      const limit = Number(args.limit ?? 180)
      const list = [...bodyStore.metrics]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 180)
      return delay(structuredClone(list) as T)
    }

    case 'record_body_metric': {
      const input = plain(args.metric as BodyMetricInput)
      if (input.weightKg == null && input.heightCm == null) {
        throw new Error('体重与身高至少填写一项')
      }
      let m = bodyStore.metrics.find((x) => x.date === input.date)
      if (m) {
        if (input.weightKg != null) m.weightKg = input.weightKg
        if (input.heightCm != null) m.heightCm = input.heightCm
      } else {
        m = {
          id: ++metricId,
          date: input.date,
          weightKg: input.weightKg ?? null,
          heightCm: input.heightCm ?? null,
          createdAt: new Date().toISOString(),
        }
        bodyStore.metrics.push(m)
      }
      // 与 Rust record_body_metric 同步：非空值写回身体资料
      if (input.weightKg != null) profile.weightKg = input.weightKg
      if (input.heightCm != null) profile.heightCm = input.heightCm
      saveBody()
      return delay(structuredClone(m) as T)
    }

    case 'delete_body_metric': {
      const i = bodyStore.metrics.findIndex((x) => x.id === Number(args.id))
      if (i !== -1) bodyStore.metrics.splice(i, 1)
      saveBody()
      return delay(undefined as T)
    }

    case 'ai_parse_target_adjust':
      return delay(parseTargetAdjustText(String(args.text), plain(args.current as DailyTargets)) as T)

    case 'list_todos': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = todos
        .filter((t) => t.date !== null && t.date >= s && t.date <= e)
        .sort(
          (a, b) =>
            a.date!.localeCompare(b.date!) ||
            (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
            b.priority - a.priority ||
            a.id - b.id,
        )
      return delay(structuredClone(list) as T)
    }

    case 'list_all_todos': {
      const list = [...todos].sort(
        (a, b) =>
          (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
          (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
          (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
          (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
          b.priority - a.priority ||
          a.id - b.id,
      )
      return delay(structuredClone(list) as T)
    }

    case 'query_todos': {
      // 与 Rust query_todos 同语义：focus 聚焦视图 / range 区间，LIMIT/OFFSET 分页
      const todayS = String(args.today)
      const winEnd = addDays(todayS, 7)
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50)
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const match =
        args.scope === 'range'
          ? (t: Todo) => t.date !== null && t.date >= String(args.start) && t.date <= String(args.end)
          : (t: Todo) =>
              t.date === null ||
              (t.status !== 'done' && (t.date < todayS || (t.date >= todayS && t.date <= winEnd)))
      const filtered = todos.filter(match).sort(
        (a, b) =>
          (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
          (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
          (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
          (a.startMin ?? 9999) - (b.startMin ?? 9999) ||
          b.priority - a.priority ||
          a.id - b.id,
      )
      return delay({
        items: structuredClone(filtered.slice(offset, offset + limit)),
        total: filtered.length,
        limit,
        offset,
      } as T)
    }

    case 'todo_distribution': {
      const todayS = String(args.today)
      const days = new Map<string, number>()
      let inbox = 0
      let overdue = 0
      for (const t of todos) {
        if (t.date === null) {
          inbox += 1
          continue
        }
        days.set(t.date, (days.get(t.date) ?? 0) + 1)
        if (t.status !== 'done' && t.date < todayS) overdue += 1
      }
      return delay({
        days: [...days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count })),
        inbox,
        overdue,
      } as T)
    }

    case 'create_todo': {
      const t: Todo = {
        id: ++todoId,
        title: String(args.title),
        notes: (args.notes as string | null) ?? null,
        date: (args.date as string | null) ?? null,
        startMin: (args.startMin as number | null) ?? null,
        durationMin: (args.durationMin as number | null) ?? null,
        category: (args.category as Todo['category']) ?? 'general',
        priority: (args.priority as number) ?? 0,
        status: 'todo',
        completedAt: null,
        createdAt: new Date().toISOString(),
        programId: null,
        recRule: (args.recRule as Todo['recRule']) ?? null,
        recKey: null,
        subtasks: (args.subtasks as Todo['subtasks']) ?? null,
        attachments: (args.attachments as Todo['attachments']) ?? null,
      }
      // 重复模板：自身即首日实例
      if (t.recRule && t.date) t.recKey = `${t.id}:${t.date}`
      todos.push(t)
      return delay(structuredClone(t) as T)
    }

    case 'update_todo': {
      // 注意：浏览器模式下入参可能是 Vue reactive 代理，structuredClone 会抛
      // DataCloneError，必须走 JSON 克隆（真实后端经 IPC 序列化无此问题）。
      const patch = JSON.parse(JSON.stringify(args.todo)) as Todo
      const i = todos.findIndex((t) => t.id === patch.id)
      if (i !== -1) todos[i] = patch
      return delay(JSON.parse(JSON.stringify(patch)) as T)
    }

    case 'delete_todo': {
      const i = todos.findIndex((t) => t.id === args.id)
      if (i !== -1) todos.splice(i, 1)
      return delay(undefined as T)
    }

    case 'sync_recurrences': {
      // 与 Rust sync_recurrences 同语义：清失效未来实例 + 补窗口 [今天-1, 今天+7] 缺失实例
      const todayS = String(args.today)
      const winStart = addDays(todayS, -1)
      const winEnd = addDays(todayS, 7)
      let inserted = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        const inst = todos[i]!
        if (!inst.recKey || inst.status === 'done' || !inst.date || inst.date <= todayS) continue
        const tid = Number(inst.recKey.split(':')[0])
        const tpl = todos.find((x) => x.id === tid)
        const match =
          tpl?.recRule && tpl.date
            ? ruleMatchesDate(tpl.recRule, tpl.date, inst.date)
            : false
        if (!match) todos.splice(i, 1)
      }
      for (const tpl of todos) {
        if (!tpl.recRule || !tpl.date) continue
        for (let d = winStart; d <= winEnd; d = addDays(d, 1)) {
          if (d === tpl.date || !ruleMatchesDate(tpl.recRule, tpl.date, d)) continue
          const key = `${tpl.id}:${d}`
          if (todos.some((x) => x.recKey === key)) continue
          todos.push({
            id: ++todoId,
            title: tpl.title,
            notes: tpl.notes,
            date: d,
            startMin: tpl.startMin,
            durationMin: tpl.durationMin,
            category: tpl.category,
            priority: tpl.priority,
            status: 'todo',
            completedAt: null,
            createdAt: new Date().toISOString(),
            programId: null,
            recRule: null,
            recKey: key,
            subtasks: tpl.subtasks?.map((s) => ({ title: s.title, done: false })) ?? null,
          })
          inserted++
        }
      }
      return delay(inserted as T)
    }

    case 'list_workouts': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = workouts
        .filter((w) => w.date >= s && w.date <= e)
        .sort((a, b) => b.date.localeCompare(a.date) || (a.startMin ?? 0) - (b.startMin ?? 0))
      return delay(structuredClone(list) as T)
    }

    case 'list_all_workouts': {
      const list = [...workouts].sort(
        (a, b) => b.date.localeCompare(a.date) || (a.startMin ?? 0) - (b.startMin ?? 0),
      )
      return delay(structuredClone(list) as T)
    }

    case 'create_workout': {
      const w: Workout = {
        id: ++workoutId,
        name: String(args.name),
        type: args.workoutType as Workout['type'],
        date: String(args.date),
        startMin: (args.startMin as number | null) ?? null,
        durationMin: Number(args.durationMin),
        kcal: Number(args.kcal),
        intensity: args.intensity as Workout['intensity'],
        note: (args.note as string | null) ?? null,
        sessionId: null,
        createdAt: new Date().toISOString(),
      }
      workouts.push(w)
      return delay(structuredClone(w) as T)
    }

    case 'delete_workout': {
      const i = workouts.findIndex((w) => w.id === args.id)
      if (i !== -1) workouts.splice(i, 1)
      // 与 Rust FK ON DELETE CASCADE 同语义：记录删除时清掉其逐组明细
      for (let k = strengthSets.length - 1; k >= 0; k--) {
        if (strengthSets[k]!.workoutId === Number(args.id)) strengthSets.splice(k, 1)
      }
      saveSets()
      return delay(undefined as T)
    }

    case 'save_pomodoro_session': {
      const s: PomodoroSession = { ...(args.session as Omit<PomodoroSession, 'id'>), id: ++pomodoroSeq }
      pomodoroSessions.push(s)
      return delay(structuredClone(s) as T)
    }

    case 'list_pomodoro_sessions': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const list = pomodoroSessions.filter((x) => x.startedAt.slice(0, 10) >= s && x.startedAt.slice(0, 10) <= e)
      return delay(structuredClone(list) as T)
    }

    case 'session_start': {
      // 防御：并发生效会话先作废
      for (const s of sessions) if (s.status === 'active') s.status = 'aborted'
      const s: MockSession = {
        id: ++sessionId,
        planId: String(args.planId),
        planName: String(args.planName),
        status: 'active',
        startedAt: String(args.startedAt),
        updatedAt: new Date().toISOString(),
        exIndex: 0,
        setIndex: 1,
        weightKg: 0,
        elapsedSec: 0,
        state: JSON.parse(JSON.stringify(args.stateJson)) as Record<string, unknown>,
      }
      sessions.push(s)
      saveSessions()
      return delay(structuredClone(s) as T)
    }

    case 'session_snapshot': {
      const s = sessions.find((x) => x.id === args.id && x.status === 'active')
      if (s) {
        s.exIndex = Number(args.exIndex)
        s.setIndex = Number(args.setIndex)
        s.weightKg = Number(args.weightKg)
        s.state = JSON.parse(JSON.stringify(args.stateJson)) as Record<string, unknown>
        const nowIso = new Date().toISOString()
        s.elapsedSec += Math.max(0, (Date.now() - Date.parse(s.updatedAt || nowIso)) / 1000)
        s.updatedAt = nowIso
        saveSessions()
      }
      return delay(undefined as T)
    }

    case 'session_active': {
      const active = [...sessions].reverse().find((x) => x.status === 'active') ?? null
      return delay((active ? structuredClone(active) : null) as T)
    }

    case 'session_finish': {
      const input = args.input as {
        id: number
        name: string
        workoutType: string
        date: string
        durationMin: number
        intensity: string
        kcal: number
        note: string | null
        sets?: {
          exerciseKey: string
          exerciseId?: string
          exerciseName: string
          kind: string
          setNo: number
          weightKg: number | null
          reps: number | null
          sec: number | null
          warmup: boolean
        }[]
      }
      const s = sessions.find((x) => x.id === input.id)
      if (s) {
        s.status = 'finished'
        saveSessions()
      }
      const w: Workout = {
        id: ++workoutId,
        name: input.name,
        type: input.workoutType as Workout['type'],
        date: input.date,
        startMin: null,
        durationMin: input.durationMin,
        kcal: input.kcal,
        intensity: input.intensity as Workout['intensity'],
        note: input.note,
        sessionId: input.id,
        createdAt: new Date().toISOString(),
      }
      workouts.push(w)
      // 逐组做组明细落库（重量曲线数据源，与 Rust session_finish 事务内写入同语义）
      const nowIso = new Date().toISOString()
      for (const st of input.sets ?? []) {
        strengthSets.push({
          id: ++strengthSetId,
          workoutId: w.id,
          planId: s?.planId ?? null,
          exerciseKey: st.exerciseKey,
          // 缺 exerciseId（旧客户端 / AI 提交）时按名称挂库，保证逐组记录进入对应曲线
          exerciseId: st.exerciseId?.trim() || ensureExerciseForName(st.exerciseName, { kind: st.kind, reps: st.reps, weightKg: st.weightKg }),
          exerciseName: st.exerciseName,
          setNo: st.setNo,
          kind: st.kind,
          weightKg: st.weightKg,
          reps: st.reps,
          sec: st.sec,
          warmup: !!st.warmup,
          createdAt: nowIso,
        })
      }
      if (input.sets?.length) saveSets()
      return delay(structuredClone(w) as T)
    }

    case 'session_abort': {
      const s = sessions.find((x) => x.id === args.id)
      if (s) {
        s.status = 'aborted'
        saveSessions()
      }
      return delay(undefined as T)
    }

    case 'session_for_workout': {
      const w = workouts.find((x) => x.id === Number(args.workoutId))
      const s = w?.sessionId != null ? sessions.find((x) => x.id === w.sessionId) : undefined
      return delay((s ? structuredClone(s) : null) as T)
    }

    /* ---------- 重量曲线（逐组记录查询，与 Rust 同语义；聚合键 = 动作库 id） ---------- */

    case 'strength_history': {
      const id = resolveExerciseId(String(args.exerciseId))
      const raw = String(args.exerciseId).trim()
      const rows = strengthSets
        .filter((r) => r.exerciseId === id || (!r.exerciseId && r.exerciseName === raw))
        .map(strengthRecord)
        .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
      return delay(structuredClone(rows) as T)
    }

    case 'strength_exercises': {
      const agg = new Map<string, { id: string; display: string; lastDate: string; sessions: Set<number> }>()
      for (const r of strengthSets) {
        if (r.warmup || r.weightKg == null) continue
        const lib = exercises.find((e) => e.id === r.exerciseId)
        const key = r.exerciseId || r.exerciseName
        const date = workouts.find((x) => x.id === r.workoutId)?.date ?? r.createdAt.slice(0, 10)
        const cur =
          agg.get(key) ?? { id: r.exerciseId, display: lib?.name ?? r.exerciseName, lastDate: '', sessions: new Set<number>() }
        if (date > cur.lastDate) cur.lastDate = date
        cur.sessions.add(r.workoutId)
        agg.set(key, cur)
      }
      const rows = [...agg.values()]
        .map((v) => ({ exerciseId: v.id, name: v.display, lastDate: v.lastDate, sessions: v.sessions.size }))
        .sort((a, b) => b.lastDate.localeCompare(a.lastDate))
      return delay(structuredClone(rows) as T)
    }

    case 'strength_last_weights': {
      const keys = (args.exerciseIds as string[]) ?? []
      const rows = keys
        .map((key) => {
          const id = resolveExerciseId(key)
          const raw = key.trim()
          const done = strengthSets
            .filter(
              (r) =>
                (r.exerciseId === id || (!r.exerciseId && r.exerciseName === raw)) &&
                !r.warmup &&
                r.weightKg != null,
            )
            .map((r) => {
              const w = workouts.find((x) => x.id === r.workoutId)
              return { ...r, date: w?.date ?? r.createdAt.slice(0, 10) }
            })
            // 与 Rust ORDER BY date DESC, workout_id DESC, id DESC 对齐：id 决胜保证取「最后一组」
            .sort((a, b) => b.date.localeCompare(a.date) || b.workoutId - a.workoutId || b.id - a.id)
          const last = done[0]
          return last
            ? {
                exerciseId: id,
                name: exercises.find((e) => e.id === id)?.name ?? last.exerciseName,
                weightKg: last.weightKg!,
                reps: last.reps,
                date: last.date,
              }
            : null
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
      return delay(structuredClone(rows) as T)
    }

    case 'strength_recent_sets': {
      const days = Number(args.days ?? 42)
      const from = addDays(todayStr(), -days)
      const rows = strengthSets
        .map(strengthRecord)
        .filter((r) => r.date >= from)
        .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
      return delay(structuredClone(rows) as T)
    }

    /* ---------- 动作库（与 Rust modules/exercise_lib 同语义） ---------- */

    case 'list_exercises': {
      const kind = args.kind ? String(args.kind) : ''
      const category = args.category ? String(args.category) : ''
      const query = String(args.query ?? '').trim().toLowerCase()
      const includeHidden = args.includeHidden === true
      const rows = exercises
        .filter((e) => (includeHidden ? true : !e.hidden))
        .filter((e) => !kind || e.kind === kind)
        .filter((e) => !category || e.category === category)
        .filter(
          (e) =>
            !query ||
            e.name.toLowerCase().includes(query) ||
            e.aliases.some((a) => a.toLowerCase().includes(query)),
        )
        .map((e) => {
          const u = exerciseUsage(e.id)
          return { ...e, sessions: u.sessions, lastUsedAt: u.lastUsedAt }
        })
        .sort(
          (a, b) =>
            (a.lastUsedAt ? 0 : 1) - (b.lastUsedAt ? 0 : 1) ||
            (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') ||
            a.name.localeCompare(b.name),
        )
      return delay(structuredClone(rows) as T)
    }

    case 'get_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (!e) throw new Error(`动作不存在：${String(args.id)}`)
      const u = exerciseUsage(e.id)
      return delay(structuredClone({ ...e, sessions: u.sessions, lastUsedAt: u.lastUsedAt }) as T)
    }

    case 'upsert_exercise': {
      const input = args.input as ExerciseInput
      const name = String(input.name ?? '').trim()
      if (!name) throw new Error('动作名称不能为空')
      const id = input.id?.trim() || `custom-${crypto.randomUUID()}`
      const existing = exercises.find((x) => x.id === id)
      if (existing && !existing.isCustom) {
        throw new Error('内置动作不可编辑：可以隐藏它，或另建一个自建动作')
      }
      const dup = exercises.find(
        (x) => x.id !== id && (x.name === name || x.aliases.includes(name)),
      )
      if (dup) throw new Error(`已有同名动作「${name}」（id=${dup.id}），请直接使用它`)
      const rec: ExerciseRecord = {
        id,
        name,
        aliases: input.aliases ?? [],
        kind: input.kind,
        category: input.category,
        equipment: input.equipment ?? null,
        muscles: input.muscles ?? {},
        tips: input.tips ?? '',
        defaultSets: input.defaultSets ?? 3,
        defaultReps: input.defaultReps ?? null,
        defaultWeightKg: input.defaultWeightKg ?? null,
        defaultTargetSec: input.defaultTargetSec ?? null,
        defaultDurationMin: input.defaultDurationMin ?? null,
        defaultRestSec: input.defaultRestSec ?? 90,
        weightStep: input.weightStep ?? 2.5,
        isCustom: true,
        hidden: false,
        sessions: 0,
        lastUsedAt: null,
      }
      if (existing) Object.assign(existing, rec)
      else exercises.push(rec)
      saveExercises()
      const u = exerciseUsage(id)
      return delay(structuredClone({ ...rec, sessions: u.sessions, lastUsedAt: u.lastUsedAt }) as T)
    }

    case 'delete_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (!e) throw new Error(`动作不存在：${String(args.id)}`)
      if (e.isCustom) {
        exercises.splice(exercises.indexOf(e), 1)
        saveExercises()
      } else {
        e.hidden = true
        saveExerciseHidden()
      }
      return delay(undefined as T)
    }

    case 'restore_exercise': {
      const e = exercises.find((x) => x.id === args.id)
      if (e) {
        e.hidden = false
        saveExerciseHidden()
      }
      return delay(undefined as T)
    }

    case 'list_workout_plans':
      return delay(structuredClone(sortedPlans()) as T)

    case 'get_workout_plan': {
      const p = plans.find((x) => x.id === args.id)
      if (!p) throw new Error(`课程不存在: ${String(args.id)}`)
      return delay(structuredClone(p) as T)
    }

    case 'upsert_workout_plan': {
      const input = args.input as WorkoutPlanInput
      const name = String(input.name ?? '').trim()
      if (!name) throw new Error('课程名称不能为空')
      const now = new Date().toISOString()
      // 动作条目一律经动作库解析（与 Rust upsert_workout_plan 同语义）
      const resolved = resolvePlanExerciseIds(
        Array.isArray(input.exercises) ? (input.exercises as unknown[]) : [],
      ) as WorkoutPlanRecord['exercises']
      const existing = plans.find((x) => x.id === input.id)
      if (existing) {
        existing.name = name
        existing.subtitle = String(input.subtitle ?? '').trim()
        existing.workoutType = input.workoutType
        existing.exercises = JSON.parse(JSON.stringify(resolved)) as WorkoutPlanRecord['exercises']
        // meta 字段编辑器不提供：缺省保留原值（与 Rust upsert 的 COALESCE 语义一致）
        if (input.equipment != null) existing.equipment = input.equipment
        if (input.estDurationMin != null) existing.estDurationMin = input.estDurationMin
        existing.updatedAt = now
        savePlans()
        return delay(structuredClone(existing) as T)
      }
      const rec: WorkoutPlanRecord = {
        id: input.id,
        name,
        subtitle: String(input.subtitle ?? '').trim(),
        workoutType: input.workoutType,
        exercises: JSON.parse(JSON.stringify(resolved)) as WorkoutPlanRecord['exercises'],
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
        equipment: input.equipment ?? null,
        estDurationMin: input.estDurationMin ?? null,
      }
      plans.push(rec)
      savePlans()
      return delay(structuredClone(rec) as T)
    }

    case 'delete_workout_plan': {
      const i = plans.findIndex((x) => x.id === args.id)
      if (i !== -1) plans.splice(i, 1)
      savePlans()
      return delay(undefined as T)
    }

    case 'touch_workout_plan': {
      const p = plans.find((x) => x.id === args.id)
      if (p) {
        p.lastUsedAt = new Date().toISOString()
        p.updatedAt = p.lastUsedAt
        savePlans()
      }
      return delay(undefined as T)
    }

    case 'plan_seed_status_cmd':
      return delay(planSeedStatus() as unknown as T)

    case 'apply_plan_seed_migrate': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) migratePlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'apply_plan_seed_override': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) overridePlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'apply_plan_seed_keep': {
      if (planSeedStatus().currentVersion < planSeedStatus().latestVersion) keepPlans()
      return delay(planSeedStatus() as unknown as T)
    }

    case 'ai_parse_food_text':
      return delay(parseFoodText(String(args.text)) as T)

    case 'list_ledger_entries': {
      const s = String(args.startDate)
      const e = String(args.endDate)
      const kw = args.keyword ? (String(args.keyword).trim().toLowerCase()) : null
      const cat = args.category ? String(args.category) : null
      const list = ledgerEntries.filter(
        (x) =>
          x.date >= s &&
          x.date <= e &&
          (!cat || x.category === cat) &&
          (!kw || (x.note ?? '').toLowerCase().includes(kw)),
      )
      return delay(structuredClone(list) as T)
    }

    case 'create_ledger_entry': {
      const input = plain(args.input as LedgerEntryInput)
      const entry: LedgerEntry = {
        id: ++ledgerId,
        kind: input.kind,
        category: input.category,
        amountCents: input.amountCents,
        note: input.note ?? null,
        date: input.date,
        createdAt: new Date().toISOString(),
      }
      ledgerEntries.push(entry)
      return delay(structuredClone(entry) as T)
    }

    case 'update_ledger_entry': {
      const patch = args.entry as LedgerEntry
      const i = ledgerEntries.findIndex((x) => x.id === patch.id)
      if (i !== -1) ledgerEntries[i] = structuredClone(patch)
      return delay(structuredClone(patch) as T)
    }

    case 'delete_ledger_entry': {
      const i = ledgerEntries.findIndex((x) => x.id === args.id)
      if (i !== -1) ledgerEntries.splice(i, 1)
      return delay(undefined as T)
    }

    case 'get_ledger_budget':
      return delay(structuredClone(ledgerSettings) as T)

    case 'set_ledger_budget': {
      ledgerSettings.monthlyBudgetCents = Number(args.monthlyBudgetCents)
      ledgerSettings.updatedAt = new Date().toISOString()
      return delay(structuredClone(ledgerSettings) as T)
    }

    case 'ai_model_list':
      return delay(structuredClone(aiModels) as T)

    case 'ai_model_add': {
      const input = plain(args.input as AiModelInput)
      const now = new Date().toISOString()
      // 镜像 Rust：库为空或显式默认时设为默认（同时清掉其他默认）
      const makeDefault = input.isDefault || aiModels.length === 0
      if (makeDefault) for (const m of aiModels) m.isDefault = false
      const model: AiModel = {
        id: ++aiModelId,
        name: input.name,
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
        isDefault: makeDefault,
        vision: null,
        thinking: null,
        effort: null,
        imageMaxEdge: input.imageMaxEdge ?? null,
        lastError: null,
        source: 'manual',
        serviceBase: null,
        priceIn: input.priceIn ?? null,
        priceOut: input.priceOut ?? null,
        priceCurrency: input.priceIn || input.priceOut ? 'CNY' : null,
        trafficPerGb: null,
        createdAt: now,
        updatedAt: now,
      }
      aiModels.push(model)
      saveAiModels()
      return delay(structuredClone(model) as T)
    }

    case 'ai_model_update': {
      const id = Number(args.id)
      const input = plain(args.input as AiModelInput)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      if (input.isDefault) for (const x of aiModels) x.isDefault = false
      Object.assign(m, input, {
        isDefault: input.isDefault || aiModels.length === 1,
        vision: null,
        thinking: null,
        effort: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      // 镜像 Rust：仍无默认时最早一条设为默认
      if (!aiModels.some((x) => x.isDefault)) aiModels[0].isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_delete': {
      const id = Number(args.id)
      const i = aiModels.findIndex((x) => x.id === id)
      if (i !== -1) aiModels.splice(i, 1)
      if (!aiModels.some((x) => x.isDefault) && aiModels.length > 0) aiModels[0].isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_set_default': {
      const id = Number(args.id)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      for (const x of aiModels) x.isDefault = false
      m.isDefault = true
      saveAiModels()
      return delay(undefined as T)
    }

    case 'ai_model_save_probe': {
      const id = Number(args.id)
      const r = plain(args.result as AiProbeResult)
      const m = aiModels.find((x) => x.id === id)
      if (!m) throw new Error('模型不存在')
      m.vision = r.vision ?? null
      m.thinking = r.thinking ?? null
      m.effort = r.effort ?? null
      m.lastError = r.error ?? null
      m.updatedAt = new Date().toISOString()
      saveAiModels()
      return delay(undefined as T)
    }

    /* ---- Rein 在线服务（浏览器演示：假服务端，但字段与真服务端一致） ---- */

    case 'online_service_settings_get':
      return delay(structuredClone(mockOnlineSettings) as T)

    case 'online_service_settings_save': {
      const input = plain(args.settings as typeof mockOnlineSettings)
      mockOnlineSettings = {
        baseUrl: (input.baseUrl ?? '').replace(/\/+$/, ''),
        apiKey: (input.apiKey ?? '').trim(),
        savedAt: new Date().toISOString(),
      }
      saveMockOnline()
      return delay(structuredClone(mockOnlineSettings) as T)
    }

    case 'online_service_catalog': {
      const catalog = buildMockCatalog(String(args.baseUrl ?? mockOnlineSettings.baseUrl), String(args.apiKey ?? ''))
      return delay(catalog as T)
    }

    case 'online_service_usage': {
      const days = Number(args.days ?? 30)
      const onlinePks = new Set(aiModels.filter((m) => m.source === 'online').map((m) => m.id))
      const rows = aiUsage.filter((u) => u.modelPk != null && onlinePks.has(u.modelPk))
      const costTokens = rows.reduce((s, u) => s + (u.costModelNano ?? 0), 0) / 1e9
      const costTraffic = rows.reduce((s, u) => s + (u.costTrafficNano ?? 0), 0) / 1e9
      return delay({
        ok: true,
        baseUrl: mockOnlineSettings.baseUrl,
        days,
        calls: rows.length,
        promptTokens: rows.reduce((s, u) => s + (u.promptTokens ?? 0), 0),
        completionTokens: rows.reduce((s, u) => s + (u.completionTokens ?? 0), 0),
        bytesIn: rows.reduce((s, u) => s + (u.requestBytes ?? 0), 0),
        bytesOut: rows.reduce((s, u) => s + (u.responseBytes ?? 0), 0),
        costTokens,
        costTraffic,
        costTotal: costTokens + costTraffic,
        currency: 'CNY',
        error: null,
      } as T)
    }

    case 'online_service_sync': {
      const catalog = buildMockCatalog(String(args.baseUrl ?? mockOnlineSettings.baseUrl), String(args.apiKey ?? ''))
      if (!catalog.ok) throw new Error(catalog.error ?? '在线服务不可用')
      const wantedIds = ((args.modelIds as string[] | null) ?? []).filter(Boolean)
      const wanted = catalog.models.filter((m) => wantedIds.length === 0 || wantedIds.includes(m.id))
      const base = catalog.baseUrl
      let added = 0
      let updated = 0
      for (const m of wanted) {
        const name = `${m.providerName} · ${m.id}`
        const existing = aiModels.find((x) => x.source === 'online' && x.serviceBase === base && x.modelId === m.id)
        if (existing) {
          Object.assign(existing, {
            name,
            baseUrl: `${base}/v1`,
            apiKey: mockOnlineSettings.apiKey,
            priceIn: m.priceIn,
            priceOut: m.priceOut,
            priceCurrency: m.currency,
            trafficPerGb: catalog.trafficPerGb,
            updatedAt: new Date().toISOString(),
          })
          updated += 1
        } else {
          aiModels.push({
            id: ++aiModelId,
            name,
            provider: 'rein-online',
            baseUrl: `${base}/v1`,
            apiKey: mockOnlineSettings.apiKey,
            modelId: m.id,
            isDefault: false,
            vision: null,
            thinking: null,
            effort: null,
            imageMaxEdge: null,
            lastError: null,
            source: 'online',
            serviceBase: base,
            priceIn: m.priceIn,
            priceOut: m.priceOut,
            priceCurrency: m.currency,
            trafficPerGb: catalog.trafficPerGb,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          added += 1
        }
      }
      // 服务端撤下的同源模型会被清掉（手动模型不动）
      const keep = new Set(wanted.map((m) => m.id))
      const before = aiModels.length
      for (let i = aiModels.length - 1; i >= 0; i -= 1) {
        const x = aiModels[i]!
        if (x.source === 'online' && x.serviceBase === base && !keep.has(x.modelId)) aiModels.splice(i, 1)
      }
      const removed = before - aiModels.length
      if (!aiModels.some((x) => x.isDefault) && aiModels.length > 0) aiModels[0]!.isDefault = true
      saveAiModels()
      return delay({
        added,
        updated,
        removed,
        models: structuredClone(aiModels.filter((x) => x.source === 'online' && x.serviceBase === base)),
      } as T)
    }

    /* ---- 本机成本账本 ---- */

    case 'ai_usage_record': {
      const input = plain(args.input as AiUsageInput)
      aiUsage.push({
        ...input,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        requestBytes: input.requestBytes ?? 0,
        responseBytes: input.responseBytes ?? 0,
        costModelNano: input.costModelNano ?? 0,
        costTrafficNano: input.costTrafficNano ?? 0,
        at: new Date().toISOString(),
      })
      saveMockUsage()
      return delay(undefined as T)
    }

    case 'ai_usage_summary': {
      const days = Number(args.days ?? 30)
      const since = Date.now() - days * 86_400_000
      const inRange = aiUsage.filter((u) => Date.parse(u.at) >= since)
      return delay(summarizeMockUsage(inRange, days, new Date(since).toISOString()) as T)
    }

    case 'ai_usage_clear':
      aiUsage = []
      saveMockUsage()
      return delay(undefined as T)

    case 'ai_chat_ensure': {
      const id = String(args.id)
      if (!aiChats.has(id)) {
        aiChats.set(id, {
          id,
          seq: 0,
          title: (args.title as string | null) ?? 'AI 对话',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        })
        saveAiChats()
      }
      const c = aiChats.get(id)!
      return delay({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      } as T)
    }

    case 'ai_chat_messages': {
      const id = String(args.chatId)
      const msgs = aiChats.get(id)?.messages ?? []
      return delay(structuredClone(msgs) as T)
    }

    case 'ai_chat_append': {
      const chatId = String(args.chatId)
      const input = plain(args.input as AiChatMessageInput)
      let c = aiChats.get(chatId)
      if (!c) {
        c = {
          id: chatId,
          seq: 0,
          title: 'AI 对话',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        }
        aiChats.set(chatId, c)
      }
      const existing = c.messages.find((m) => m.id === input.id)
      const now = new Date().toISOString()
      if (existing) {
        // 镜像 Rust upsert：重复追加只刷新内容，保持原 seq
        existing.role = input.role
        existing.kind = input.kind
        existing.text = input.text ?? null
        existing.imageBase64 = input.imageBase64 ?? null
        existing.mime = input.mime ?? null
        existing.payload = input.payload ?? null
      } else {
        c.messages.push({
          id: input.id,
          chatId,
          seq: ++c.seq,
          role: input.role,
          kind: input.kind,
          text: input.text ?? null,
          imageBase64: input.imageBase64 ?? null,
          mime: input.mime ?? null,
          payload: input.payload ?? null,
          createdAt: now,
        })
      }
      c.updatedAt = now
      saveAiChats()
      return delay(undefined as T)
    }

    case 'ai_chat_clear': {
      const c = aiChats.get(String(args.chatId))
      if (c) {
        c.messages = []
        c.updatedAt = new Date().toISOString()
        saveAiChats()
      }
      return delay(undefined as T)
    }

    case 'ai_chat_list': {
      const list = [...aiChats.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      )
      return delay(
        list.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt })) as T,
      )
    }

    case 'ai_chat_cut': {
      const id = String(args.chatId)
      const messageId = String(args.messageId)
      const c = aiChats.get(id)
      if (c) {
        const target = c.messages.find((m) => m.id === messageId)
        if (target) {
          c.messages = c.messages.filter((m) => m.seq < target.seq)
          c.updatedAt = new Date().toISOString()
          saveAiChats()
        }
      }
      return delay(undefined as T)
    }

    case 'ai_chat_rename': {
      const id = String(args.id)
      const title = String(args.title).trim()
      if (!title) throw new Error('会话标题不能为空')
      const c = aiChats.get(id)
      if (c) {
        c.title = title
        c.updatedAt = new Date().toISOString()
        saveAiChats()
      }
      return delay(undefined as T)
    }

    case 'ai_chat_search': {
      const keyword = String(args.keyword ?? '').trim().toLowerCase()
      if (!keyword) return delay([] as T)
      const limit = Number(args.limit ?? 8)
      const hits: ChatSearchHit[] = []
      for (const c of aiChats.values()) {
        for (const m of c.messages) {
          if ((m.text ?? '').toLowerCase().includes(keyword) || (m.payload ?? '').toLowerCase().includes(keyword)) {
            hits.push({
              chatId: c.id,
              chatTitle: c.title,
              seq: m.seq,
              role: m.role,
              kind: m.kind,
              text: m.text,
              createdAt: m.createdAt,
            })
          }
        }
      }
      hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return delay(hits.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 8) as T)
    }

    // ---- 健康方案（与 Rust modules/program 同契约：持久化 + 单激活 + 日程重排）----
    case 'program_list':
      return delay(
        structuredClone(programs.sort((a, b) => b.id - a.id).slice(0, 20)) as T,
      )

    case 'program_get_active': {
      const p = [...programs].filter((x) => x.status === 'active').sort((a, b) => b.id - a.id)[0]
      return delay((p ? structuredClone(p) : null) as T)
    }

    case 'program_create': {
      const input = args.input as {
        goal: ProgramRecord['goal']
        tier: ProgramRecord['tier']
        weeks: number
        paramsJson: string
      }
      if (!(input.weeks >= 1 && input.weeks <= 26)) throw new Error('方案周期应为 1~26 周')
      // 单激活约束：旧 active 自动归档，并回收归档方案今天起未完成的日程待办
      // （与 Rust 的 program_create 同语义，含历史归档方案的脏数据自愈）
      for (const x of programs) {
        if (x.status === 'active') {
          x.status = 'archived'
          x.updatedAt = new Date().toISOString()
        }
      }
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (
          t.programId != null &&
          t.date != null &&
          t.date >= today &&
          t.status !== 'done' &&
          programs.some((x) => x.id === t.programId && x.status === 'archived')
        ) {
          todos.splice(i, 1)
        }
      }
      const now = new Date().toISOString()
      const rec: ProgramRecord = {
        id: ++programId,
        goal: input.goal,
        tier: input.tier,
        status: 'active',
        version: 1,
        weeks: input.weeks,
        paramsJson: input.paramsJson,
        adjustmentsJson: '[]',
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      }
      programs.push(rec)
      return delay(structuredClone(rec) as T)
    }

    case 'program_update_params': {
      const p = programs.find((x) => x.id === args.id)
      if (!p) throw new Error('方案不存在')
      const input = args.input as { paramsJson: string; adjustmentsJson: string }
      p.paramsJson = input.paramsJson
      p.adjustmentsJson = input.adjustmentsJson
      p.version += 1
      p.updatedAt = new Date().toISOString()
      return delay(structuredClone(p) as T)
    }

    case 'program_archive': {
      const p = programs.find((x) => x.id === args.id)
      if (p) {
        p.status = 'archived'
        p.updatedAt = new Date().toISOString()
      }
      // 与 Rust 同语义：归档即回收 from_date（含）起未完成的日程待办
      const from = String(args.fromDate ?? today)
      let removed = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (t.programId === args.id && t.date != null && t.date >= from && t.status !== 'done') {
          todos.splice(i, 1)
          removed++
        }
      }
      return delay(removed as T)
    }

    case 'program_meals_get': {
      const row = programMeals.find(
        (m) => m.programId === Number(args.programId) && m.date === String(args.date),
      )
      return delay((row ? structuredClone(row) : null) as T)
    }

    case 'program_meals_range': {
      const pid = Number(args.programId)
      const from = String(args.startDate)
      const to = String(args.endDate)
      const rows = programMeals
        .filter((m) => m.programId === pid && m.date >= from && m.date <= to)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((m) => structuredClone(m))
      return delay(rows as T)
    }

    case 'program_meals_set': {
      const pid = Number(args.programId)
      const date = String(args.date)
      const mealsJson = String(args.mealsJson)
      if (!date || !mealsJson) throw new Error('date 与 mealsJson 不能为空')
      if (!programs.some((x) => x.id === pid)) throw new Error('方案不存在')
      const now = new Date().toISOString()
      const i = programMeals.findIndex((m) => m.programId === pid && m.date === date)
      if (i !== -1) programMeals[i] = { programId: pid, date, mealsJson, updatedAt: now }
      else programMeals.push({ programId: pid, date, mealsJson, updatedAt: now })
      return delay(structuredClone(programMeals.find((m) => m.programId === pid && m.date === date)) as T)
    }

    case 'program_meals_clear': {
      const pid = Number(args.programId)
      const from = String(args.fromDate)
      let n = 0
      for (let i = programMeals.length - 1; i >= 0; i--) {
        if (programMeals[i]!.programId === pid && programMeals[i]!.date >= from) {
          programMeals.splice(i, 1)
          n++
        }
      }
      return delay(n as T)
    }

    case 'shopping_checks_list':
      return delay(structuredClone(shoppingChecks) as T)

    case 'shopping_check_set': {
      const key = String(args.itemKey)
      const checked = Boolean(args.checked)
      const i = shoppingChecks.findIndex((c) => c.itemKey === key)
      if (checked) {
        const now = new Date().toISOString()
        if (i !== -1) shoppingChecks[i]!.checkedAt = now
        else shoppingChecks.push({ itemKey: key, checkedAt: now })
      } else if (i !== -1) {
        shoppingChecks.splice(i, 1)
      }
      return delay(undefined as T)
    }

    case 'shopping_checks_clear': {
      const n = shoppingChecks.length
      shoppingChecks.length = 0
      return delay(n as T)
    }

    case 'program_delete': {
      const id = Number(args.id)
      let removed = 0
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i]!.programId !== id) continue
        if (todos[i]!.status === 'done') todos[i]!.programId = null
        else {
          todos.splice(i, 1)
          removed++
        }
      }
      const pi = programs.findIndex((x) => x.id === id)
      if (pi !== -1) programs.splice(pi, 1)
      // 与 Rust 的 ON DELETE CASCADE 同语义：方案删除时清掉每日菜单缓存
      for (let i = programMeals.length - 1; i >= 0; i--) {
        if (programMeals[i]!.programId === id) programMeals.splice(i, 1)
      }
      return delay(removed as T)
    }

    case 'program_schedule_replace': {
      const id = Number(args.id)
      const fromDate = String(args.fromDate)
      const list = args.todos as ScheduleTodoInput[]
      if (!programs.some((x) => x.id === id)) throw new Error('方案不存在')
      for (let i = todos.length - 1; i >= 0; i--) {
        const t = todos[i]!
        if (t.programId === id && t.date !== null && t.date >= fromDate && t.status !== 'done') {
          todos.splice(i, 1)
        }
      }
      for (const item of list) {
        if (!item.title?.trim() || !item.date) continue
        todos.push({
          id: ++todoId,
          title: item.title.trim(),
          notes: item.notes ?? null,
          date: item.date,
          startMin: item.startMin ?? null,
          durationMin: item.durationMin ?? null,
          category: (item.category as Todo['category']) ?? 'general',
          priority: item.priority ?? 0,
          status: 'todo',
          completedAt: null,
          createdAt: new Date().toISOString(),
          programId: id,
          recRule: null,
          recKey: null,
          subtasks: null,
        })
      }
      return delay(list.length as T)
    }

    // voice（语音对话：配置 / 伪造 ASR 事件流 / 纪要 CRUD / 草稿）
    case 'voice_config_get':
      return delay(JSON.parse(JSON.stringify(voiceConfig)) as T)
    case 'voice_config_save':
      voiceConfig = JSON.parse(JSON.stringify(args.config)) as MockVoiceConfig
      return delay(undefined as T)
    case 'voice_config_status': {
      const s = `${voiceConfig.asrBaseUrl} ${voiceConfig.asrResourceId}`.toLowerCase()
      const adapter = voiceConfig.asrAdapter === 'auto'
        ? (/(qwen|dashscope|aliyun)/.test(s) ? 'qwen' : 'doubao')
        : voiceConfig.asrAdapter
      const asrReady = adapter === 'qwen'
        ? !!voiceConfig.appKey
        : voiceConfig.mode === 'new'
          ? !!voiceConfig.appKey
          : !!voiceConfig.appKey && !!voiceConfig.accessKey
      // mock 里 TTS 恒可合成；ttsReady 跟随音色是否有值，与真实端语义对齐
      return delay({
        asrReady,
        asrAdapter: adapter,
        ttsReady: !!voiceConfig.voiceName,
        ttsStandalone: !!voiceConfig.ttsCredential?.appKey,
      } as T)
    }
    case 'voice_tts_probe':
      return delay({ audioPath: mockWavDataUrl() } as T)
    case 'voice_asr_probe':
      return delay(undefined as T)
    case 'voice_tts_credential_save':
      voiceConfig.ttsCredential = (args.ttsCredential as MockVoiceConfig['ttsCredential']) ?? null
      return delay(undefined as T)
    case 'voice_asr_start': {
      const sessionId = String(args.sessionId)
      clearVoiceTimers(sessionId)
      voiceFinaled.set(sessionId, new Set())
      const ids: number[] = []
      MOCK_SENTENCES.forEach((sen, i) => {
        ids.push(
          window.setTimeout(() => {
            mockVoice.onAsr?.({ sessionId, kind: 'partial', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
          }, sen.startMs),
        )
        ids.push(
          window.setTimeout(() => {
            voiceFinaled.get(sessionId)?.add(i)
            mockVoice.onAsr?.({ sessionId, kind: 'final', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
          }, sen.endMs),
        )
      })
      voiceTimers.set(sessionId, ids)
      return delay(undefined as T)
    }
    case 'voice_asr_audio':
      return delay(undefined as T)
    case 'voice_asr_finish': {
      const sessionId = String(args.sessionId)
      clearVoiceTimers(sessionId)
      // 立即补发尚未 final 的句子 + ended（e2e 不必等真实时长）
      const done = voiceFinaled.get(sessionId) ?? new Set<number>()
      MOCK_SENTENCES.forEach((sen, i) => {
        if (!done.has(i)) {
          mockVoice.onAsr?.({ sessionId, kind: 'final', text: sen.text, startMs: sen.startMs, endMs: sen.endMs })
        }
      })
      voiceFinaled.delete(sessionId)
      mockVoice.onAsr?.({ sessionId, kind: 'ended', durationMs: 3400 })
      return delay(undefined as T)
    }
    case 'voice_asr_cancel':
      clearVoiceTimers(String(args.sessionId))
      voiceFinaled.delete(String(args.sessionId))
      return delay(undefined as T)
    case 'voice_tts_speak':
      return delay({ audioPath: mockWavDataUrl() } as T)
    case 'voice_memo_create': {
      const input = args.input as {
        id: string
        chatId: string
        messageId: string | null
        title?: string
        audioPath?: string | null
        durationMs?: number
        words?: number
        sentencesJson?: string
        summaryJson?: string
      }
      const memo: MockMemo = {
        id: input.id,
        chatId: input.chatId,
        messageId: input.messageId,
        title: input.title ?? '',
        audioPath: input.audioPath ?? null,
        durationMs: input.durationMs ?? 0,
        words: input.words ?? 0,
        sentences: input.sentencesJson ? JSON.parse(input.sentencesJson) : [],
        summary: input.summaryJson ? JSON.parse(input.summaryJson) : [],
        createdAt: new Date().toISOString(),
      }
      voiceMemos.unshift(memo)
      return delay(JSON.parse(JSON.stringify(memo)) as T)
    }
    case 'voice_memo_get': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (!m) throw new Error('纪要不存在')
      return delay(JSON.parse(JSON.stringify(m)) as T)
    }
    case 'voice_memo_list':
      return delay(JSON.parse(JSON.stringify(voiceMemos.slice(0, Number(args.limit ?? 200)))) as T)
    case 'voice_memo_set_summary': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (m) m.summary = JSON.parse(String(args.summaryJson))
      return delay(undefined as T)
    }
    case 'voice_memo_rename': {
      const m = voiceMemos.find((x) => x.id === String(args.id))
      if (m) m.title = String(args.title)
      return delay(undefined as T)
    }
    case 'voice_memo_delete': {
      const idx = voiceMemos.findIndex((x) => x.id === String(args.id))
      if (idx >= 0) voiceMemos.splice(idx, 1)
      return delay(undefined as T)
    }
    case 'voice_draft_save':
      voiceDraft = JSON.parse(String(args.draftJson))
      return delay(undefined as T)
    case 'voice_draft_get':
      return delay((voiceDraft ? JSON.parse(JSON.stringify(voiceDraft)) : null) as T)
    case 'voice_draft_clear':
      voiceDraft = null
      return delay(undefined as T)

    // tracking（跑步前台保活）：纯浏览器开发无需保活，空实现保持契约可见
    case 'tracking_keepalive':
      return delay(undefined as T)
    case 'tracking_status':
      return delay({ granted: true, busy: false } as T)

    /* ---------- 知识库与长期记忆 ---------- */
    case 'kb_status': {
      kbEnsureIndex()
      // 与 Rust enabled_sources 同语义：全量集合减去显式关闭的
      const allSources = [
        'todo', 'todo_attachment', 'workout', 'plan', 'meal', 'body_metric', 'food',
        'program', 'program_meal', 'voice_memo', 'chat', 'chat_message',
        'chat_attachment', 'memory', 'note',
      ]
      const enabled = allSources.filter((k) => kbSettings.sourcesEnabled[k] !== false)
      return delay({
        mode: kbSettings.embeddingMode,
        docs: kbDocs.length + kbMemories.length,
        chunks: kbDocs.length + kbMemories.length,
        // keyword 模式下永远不会产生向量，如实回 0 而不是假装有
        vectors: kbSettings.embeddingMode === 'keyword' ? 0 : kbDocs.length,
        pending: 0,
        indexing: false,
        progress: { phase: 'idle', done: 0, total: 0 },
        lastError: kbSettings.lastError,
        embedderReady: kbSettings.embeddingMode === 'cloud' ? !!kbSettings.cloudBaseUrl : true,
        vecModel: kbSettings.embeddingMode === 'keyword' ? null : kbSettings.cloudModel ?? 'bge-small-zh-v1.5-int8',
        enabledSources: enabled.length ? enabled : allSources,
      } as T)
    }

    case 'kb_search': {
      const q = plain(args.query as {
        query?: string
        sources?: string[]
        from?: string
        to?: string
        tags?: string[]
        limit?: number
      })
      const hits = kbSearchMock(String(q?.query ?? ''), q ?? {})
      // 记忆已编目进 kbDocs（见 kbEnsureIndex），与其它来源同池检索
      const merged = hits.filter((h) => !q?.sources?.length || q.sources.includes(h.sourceType))
      return delay(plain(merged) as T)
    }

    case 'kb_read': {
      kbEnsureIndex()
      const id = Number(args.docId)
      const level = String(args.level ?? 'l1')
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const limit = level === 'l1' ? 1 : Math.min(Math.max(Number(args.limit ?? 8), 1), 64)

      const packDoc = (doc: MockKbDoc) => {
        // 与 Rust 一致：note 源直读 kb_files 真源——缓存 body 有 8000 字上限，
        // 全文归档的文档超限后若按缓存切块，AI 分页到头也读不到剩余内容
        const file = doc.sourceType === 'note' ? kbFiles.find((f) => f.id === Number(doc.sourceId)) : undefined
        const chunks = kbChunkText(file ? file.content : doc.body).map((text, ord) => ({ id: doc.id * 1000 + ord, ord, text }))
        const picked = level === 'l1' ? chunks.slice(0, 1) : chunks.slice(offset, offset + limit)
        const textChars = doc.sourceType === 'note' ? (file?.content.length ?? 0) : doc.body.length
        return {
          id: doc.id,
          sourceType: doc.sourceType,
          sourceId: doc.sourceId,
          path: doc.path,
          editable: doc.editable,
          system: doc.system,
          kind: doc.kind,
          title: doc.title,
          summary: doc.summary,
          occurredOn: doc.occurredOn,
          tags: doc.tags,
          meta: {} as Record<string, unknown>,
          updatedAt: doc.updatedAt,
          level,
          totalChunks: chunks.length,
          offset,
          hasMore: offset + picked.length < chunks.length,
          chunks: picked,
          modalities: kbModalsForSource(doc.sourceType, doc.sourceId, textChars).map((m) => m.modal),
        }
      }

      const mem = kbMemories.find((m) => m.id === id)
      if (mem) {
        return delay({
          id,
          sourceType: 'memory',
          sourceId: String(id),
          path: `记忆/${mem.memType}/${mem.topic || '未命名'}-${id}.md`,
          editable: true,
          system: false,
          kind: 'text',
          title: mem.topic ? `记忆 · ${mem.topic}` : `记忆 · ${mem.memType}`,
          summary: mem.content.slice(0, 120),
          occurredOn: mem.createdAt.slice(0, 10),
          tags: [mem.memType],
          meta: { confidence: mem.confidence, memType: mem.memType },
          updatedAt: mem.updatedAt,
          level,
          totalChunks: 1,
          offset: 0,
          hasMore: false,
          chunks: [{ id, ord: 0, text: mem.content }],
          modalities: ['text'],
        } as T)
      }
      const doc = kbDocs.find((d) => d.id === id)
      if (!doc) throw new Error(`知识库条目不存在：id=${id}（先用 search_knowledge 查 id）`)
      return delay(packDoc(doc) as T)
    }

    case 'kb_glob': {
      kbEnsureIndex()
      const pattern = String(args.pattern ?? '')
      const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 200)
      const hits = kbDocs
        .filter((d) => d.path && kbGlobMatch(pattern, d.path))
        .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          path: d.path,
          sourceType: d.sourceType,
          title: d.title,
          kind: d.kind,
          editable: d.editable,
          system: d.system,
          occurredOn: d.occurredOn,
        }))
      return delay(plain(hits) as T)
    }

    case 'kb_file_write': {
      loadKbStore()
      const input = plain(args.input as { path: string; content: string }) ?? { path: '', content: '' }
      const content = String(input.content ?? '')
      if (!content.trim()) throw new Error('文件内容不能为空')
      let path = kbNormalizePath(String(input.path ?? ''))
      // 落到保留区 / 撞上派生文档时自动让位（与 Rust files::settle_path 同构）
      if (!kbFiles.some((x) => x.path === path)) {
        const cut = path.lastIndexOf('/')
        path = kbFreePath(cut > 0 ? path.slice(0, cut) : '', cut > 0 ? path.slice(cut + 1) : path)
      }
      const now = new Date().toISOString()
      let f = kbFiles.find((x) => x.path === path)
      if (f) {
        f.content = content
        f.kind = 'text'
        f.updatedAt = now
      } else {
        f = {
          id: ++kbFileId,
          path,
          content,
          system: false,
          kind: 'text',
          pinned: false,
          classifyState: path.startsWith('未分类数据/') ? 'inbox' : 'manual',
          createdAt: now,
          updatedAt: now,
        }
        kbFiles.push(f)
      }
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      const doc = kbDocs.find((d) => d.sourceType === 'note' && d.sourceId === String(f!.id))!
      return delay({ ...f, docId: doc.id, modalities: [] } as T)
    }

    case 'kb_file_rename': {
      loadKbStore()
      // 与 Rust resolve_file_id 同语义：收文档 id（glob/检索给的）或文件 id
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (f.system) throw new Error('该文件是系统文件（规范/），不能改名；它的内容随应用版本更新')
      let path = kbNormalizePath(String(args.path ?? ''))
      if (kbIsReservedPath(path)) {
        const cut = path.lastIndexOf('/')
        path = kbFreePath(cut > 0 ? path.slice(0, cut) : '', cut > 0 ? path.slice(cut + 1) : path)
      }
      if (kbFiles.some((x) => x.path === path && x.id !== id)) throw new Error(`目标路径已存在：${path}`)
      f.path = path
      f.updatedAt = new Date().toISOString()
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_file_delete': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (f.system) throw new Error('该文件是系统文件（规范/），不能删除；它的内容随应用版本更新')
      kbFiles.splice(kbFiles.indexOf(f), 1)
      // 模态行级联清掉（对应 Rust 的外键级联）
      for (let i = kbAssets.length - 1; i >= 0; i--) {
        if (kbAssets[i].fileId === id) kbAssets.splice(i, 1)
      }
      saveKbAssets()
      saveKbFiles()
      const di = kbDocs.findIndex((d) => d.sourceType === 'note' && d.sourceId === String(id))
      if (di >= 0) kbDocs.splice(di, 1)
      return delay(undefined as T)
    }

    case 'kb_file_get': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      const modals = kbAssets
        .filter((a) => a.fileId === id)
        .map((a) => ({
          modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
          transcriptState: a.transcriptState, derivedFrom: a.derivedFrom, source: 'asset',
        }))
      return delay({ ...f, modalities: modals } as T)
    }

    /* ---------- 模态层（对应 Rust kb_media_write / kb_media_get） ---------- */

    case 'kb_media_write': {
      loadKbStore()
      const input = plain(args.input as {
        path: string
        name?: string
        mime: string
        dataBase64: string
        text?: string
      }) ?? { path: '', mime: '', dataBase64: '' }
      const dataUrl = String(input.dataBase64 ?? '')
      if (!dataUrl.trim()) throw new Error('本体为空')
      const name = String(input.name ?? '').trim() || String(input.path ?? '').split('/').pop() || '未命名'
      const mime = String(input.mime ?? '').trim() || kbMimeOfName(name)
      const modal = kbModalOfMime(mime)
      const bytes = Math.round(((dataUrl.split(',').pop() ?? '').length * 3) / 4)
      const path = kbNormalizeMediaPath(String(input.path ?? ''), name)
      const text = String(input.text ?? '').trim() ||
        `【${KB_MODAL_LABEL[modal] ?? '文件'}】${name}（${mime}，${kbHumanSize(bytes)}）`
      const now = new Date().toISOString()
      let f = kbFiles.find((x) => x.path === path)
      if (f) {
        f.content = text
        f.kind = 'multimodal'
        f.updatedAt = now
      } else {
        f = {
          id: ++kbFileId,
          path,
          content: text,
          system: false,
          kind: 'multimodal',
          pinned: false,
          classifyState: path.startsWith('未分类数据/') ? 'inbox' : 'manual',
          createdAt: now,
          updatedAt: now,
        }
        kbFiles.push(f)
      }
      const existing = kbAssets.find((a) => a.fileId === f!.id && a.modal === modal)
      if (existing) {
        existing.ref = dataUrl
        existing.mime = mime
        existing.bytes = bytes
      } else {
        kbAssets.push({
          id: ++kbAssetId,
          fileId: f.id,
          modal,
          mime,
          ref: dataUrl,
          bytes,
          durationMs: null,
          transcriptState: modal === 'audio' || modal === 'video' ? 'none' : 'done',
          derivedFrom: null,
          createdAt: now,
        })
      }
      saveKbFiles()
      saveKbAssets()
      kbIndexed = false
      kbEnsureIndex()
      const modals = kbAssets
        .filter((a) => a.fileId === f!.id)
        .map((a) => ({
          modal: a.modal, mime: a.mime, bytes: a.bytes, durationMs: a.durationMs,
          transcriptState: a.transcriptState, derivedFrom: a.derivedFrom, source: 'asset',
        }))
      return delay({ ...f, modalities: modals } as T)
    }

    case 'kb_media_get': {
      loadKbStore()
      kbEnsureIndex()
      const docId = Number(args.docId)
      const requested = args.modal ? String(args.modal) : null
      const doc = kbDocs.find((d) => d.id === docId)
      if (!doc) throw new Error(`知识库条目不存在：id=${docId}（先用 search_knowledge 查 id）`)
      const file = doc.sourceType === 'note' ? kbFiles.find((f) => f.id === Number(doc.sourceId)) : undefined
      const textBody = file ? file.content : doc.body
      const infos = kbModalsForSource(doc.sourceType, doc.sourceId, textBody.length)
      const base = {
        docId,
        path: doc.path,
        title: doc.title,
        kind: doc.kind,
        modalities: infos,
        requested,
        degraded: false,
        degradeReason: null as string | null,
        mime: null as string | null,
        dataUrl: null as string | null,
        tooLarge: false,
        text: null as string | null,
        hint: null as string | null,
      }
      if (!requested) {
        return delay({
          ...base,
          hint: `该节点可用模态：${infos.map((m) => m.modal).join('、')}；需要本体时用 modal 指定`,
        } as T)
      }
      if (requested === 'text') {
        if (!infos.some((m) => m.modal === 'text')) {
          return delay({
            ...base,
            degraded: true,
            degradeReason: '该节点没有文本模态',
            text: `【${doc.kind}】${doc.title}（本体不在工作区，只有元信息）`,
          } as T)
        }
        return delay({ ...base, text: textBody } as T)
      }
      const info = infos.find((m) => m.modal === requested)
      if (!info) {
        return delay({
          ...base,
          degraded: true,
          degradeReason: `该节点没有 ${requested} 模态，已降级为文本`,
          text: textBody,
          hint: '已降级为文本模态；本体确实不存在时不要反复重试',
        } as T)
      }
      // 本体：asset（内联 data URL）或语音纪要（mock 生成静音 wav）
      let dataUrl: string | null = null
      if (info.source === 'voice') dataUrl = mockWavDataUrl()
      else if (info.source === 'asset') {
        dataUrl = kbAssets.find((a) => a.fileId === Number(doc.sourceId) && a.modal === requested)?.ref ?? null
      }
      const hint =
        info.transcriptState === 'none' && (requested === 'audio' || requested === 'video')
          ? '该本体尚未转写，暂不提供派生文本'
          : null
      return delay({ ...base, mime: info.mime, dataUrl, hint } as T)
    }

    /* ---------- 目录治理（对应 Rust kb_fs_*） ---------- */

    case 'kb_fs_move': {
      loadKbStore()
      const src = String(args.source ?? 'user')
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (KB_SYSTEM_ROOTS.includes(f.path.split('/')[0] ?? '')) {
        throw new Error(`${f.path} 在系统命名空间，只读`)
      }
      if (src === 'ai' && f.pinned) throw new Error(`${f.path} 被用户钉住（pin），AI 不能移动它`)
      const dir = String(args.toDir ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (src === 'ai') {
        const recent = kbMoves.find(
          (m) => m.pathTo === f!.path && m.source === 'ai' && m.op === 'move' && !m.undone &&
            Date.now() - new Date(m.at).getTime() < 24 * 3600 * 1000,
        )
        if (recent) throw new Error(`${f.path} 一天内已被自动整理过，暂不再移动（防抖）`)
      }
      const base = f.path.split('/').pop() ?? f.path
      const to = kbFreePath(dir, base)
      let batchId = ''
      const from = f.path
      if (to !== f.path) {
        f.path = to
        f.classifyState = dir.startsWith('未分类数据') ? 'inbox' : 'filed'
        f.updatedAt = new Date().toISOString()
        batchId = kbAudit(src, 'move', from, to, String(args.reason ?? ''))
        saveKbFiles()
        kbIndexed = false
        kbEnsureIndex()
      }
      return delay({ file: { ...f, modalities: [] }, from, to, batchId } as T)
    }

    case 'kb_fs_mkdir': {
      loadKbStore()
      const path = String(args.path ?? '').trim().replace(/^\/+|\/+$/g, '')
      if (!path) throw new Error('目录路径不能为空')
      if (KB_SYSTEM_ROOTS.includes(path.split('/')[0] ?? '')) {
        throw new Error(`${path} 在系统命名空间，只读`)
      }
      if (kbIsReservedPath(path)) throw new Error(`${path} 落在派生文档的保留命名空间里，不能建目录`)
      if (kbFiles.some((x) => x.path === path)) throw new Error(`路径已存在：${path}`)
      const now = new Date().toISOString()
      const f: MockKbFile = {
        id: ++kbFileId,
        path,
        content: `【目录】${path}`,
        system: false,
        kind: 'folder',
        pinned: false,
        classifyState: 'manual',
        createdAt: now,
        updatedAt: now,
      }
      kbFiles.push(f)
      kbAudit(String(args.source ?? 'user'), 'mkdir', '', path, String(args.reason ?? ''))
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_fs_pin': {
      loadKbStore()
      const raw = Number(args.id)
      const docHit = kbDocs.find((d) => d.id === raw && d.sourceType === 'note')
      const id = docHit ? Number(docHit.sourceId) : raw
      const f = kbFiles.find((x) => x.id === id)
      if (!f) throw new Error(`文件不存在：id=${id}`)
      if (KB_SYSTEM_ROOTS.includes(f.path.split('/')[0] ?? '')) {
        throw new Error(`${f.path} 在系统命名空间，只读`)
      }
      const pinned = Boolean(args.pinned)
      f.pinned = pinned
      f.classifyState = pinned ? 'manual' : 'filed'
      f.updatedAt = new Date().toISOString()
      kbAudit(String(args.source ?? 'user'), pinned ? 'pin' : 'unpin', f.path, f.path, pinned ? '用户钉住' : '取消钉住')
      saveKbFiles()
      return delay({ ...f, modalities: [] } as T)
    }

    case 'kb_fs_moves': {
      loadKbStore()
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200)
      return delay(plain([...kbMoves].sort((a, b) => b.id - a.id).slice(0, limit)) as T)
    }

    case 'kb_fs_undo': {
      loadKbStore()
      const batchId = String(args.batchId ?? '')
      let n = 0
      for (const m of [...kbMoves].filter((x) => x.batchId === batchId && !x.undone).sort((a, b) => b.id - a.id)) {
        if (m.op === 'move' && m.pathFrom && m.pathTo) {
          const f = kbFiles.find((x) => x.path === m.pathTo)
          if (f) {
            const cut = m.pathFrom.lastIndexOf('/')
            const back = kbFreePath(cut > 0 ? m.pathFrom.slice(0, cut) : '', cut > 0 ? m.pathFrom.slice(cut + 1) : m.pathFrom)
            f.path = back
            f.updatedAt = new Date().toISOString()
          }
        }
        m.undone = true
        n++
      }
      saveKbMoves()
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay(n as T)
    }

    case 'kb_injection_get':
      return delay(plain(kbInjection()) as T)

    case 'kb_reindex': {
      kbIndexed = false
      kbEnsureIndex()
      return delay(kbDocs.length as T)
    }

    case 'kb_settings_get':
      return delay({
        embeddingMode: kbSettings.embeddingMode,
        cloudBaseUrl: kbSettings.cloudBaseUrl,
        cloudApiKeyTail: kbSettings.cloudApiKey ? `…${kbSettings.cloudApiKey.slice(-4)}` : null,
        cloudModel: kbSettings.cloudModel,
        cloudDim: kbSettings.cloudDim,
        sourcesEnabled: kbSettings.sourcesEnabled,
        autoMemory: kbSettings.autoMemory,
        autoConsolidate: kbSettings.autoConsolidate,
        lastConsolidateAt: kbSettings.lastConsolidateAt,
        lastError: kbSettings.lastError,
        updatedAt: kbSettings.updatedAt,
      } as T)

    case 'kb_settings_set': {
      const input = plain(args.input as Record<string, unknown>) ?? {}
      if (input.embeddingMode !== undefined) {
        const mode = String(input.embeddingMode)
        if (!['keyword', 'local', 'cloud'].includes(mode)) {
          throw new Error(`未知的检索模式：${mode}（可选 keyword / local / cloud）`)
        }
        kbSettings.embeddingMode = mode as typeof kbSettings.embeddingMode
      }
      if (input.cloudBaseUrl !== undefined) kbSettings.cloudBaseUrl = String(input.cloudBaseUrl) || null
      if (input.cloudApiKey !== undefined) {
        const v = String(input.cloudApiKey)
        // 传空串=清除；不传=保留（前端拿不到明文）
        kbSettings.cloudApiKey = v.trim() ? v : null
      }
      if (input.cloudModel !== undefined) kbSettings.cloudModel = String(input.cloudModel) || null
      if (input.cloudDim !== undefined) kbSettings.cloudDim = Number(input.cloudDim) || null
      if (input.sourcesEnabled !== undefined) kbSettings.sourcesEnabled = input.sourcesEnabled as Record<string, boolean>
      if (input.autoMemory !== undefined) kbSettings.autoMemory = Boolean(input.autoMemory)
      if (input.autoConsolidate !== undefined) kbSettings.autoConsolidate = Boolean(input.autoConsolidate)
      kbSettings.updatedAt = new Date().toISOString()
      saveKbSettings()
      return mockInvoke<T>('kb_settings_get', {})
    }

    case 'kb_probe_embedder': {
      if (kbSettings.embeddingMode === 'keyword') {
        throw new Error('当前是纯关键词模式，没有可测试的嵌入后端')
      }
      // 浏览器里没有真的推理后端，如实报错而不是假装成功
      throw new Error('浏览器 mock 环境没有本地嵌入后端（真实应用走 ONNX Runtime）')
    }

    case 'kb_rebuild_vectors':
      return delay(0 as T)

    case 'kb_memories': {
      loadKbStore()
      const t = args.memType as string | undefined
      const scope = (args.scope as string | undefined) ?? 'active'
      let list = t ? kbMemories.filter((m) => m.memType === t) : kbMemories.slice()
      if (scope === 'active') list = list.filter((m) => !m.archivedAt)
      else if (scope === 'archived') list = list.filter((m) => m.archivedAt)
      // 活跃永远排在归档前面；组内按最近修改
      list.sort(
        (a, b) =>
          Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      return delay(plain(list.map(kbDocToMemory)) as T)
    }

    case 'kb_memory_apply': {
      loadKbStore()
      const candidates = plain(args.candidates as Record<string, unknown>[]) ?? []
      const chatId = (args.chatId as string | undefined) ?? null
      let added = 0
      let updated = 0
      let deleted = 0
      let archived = 0
      let restored = 0
      let skipped = 0
      const validTypes = ['preference', 'constraint', 'event', 'entity', 'profile', 'pattern']
      // 分类规范化：按 / 分层、逐段净化、最多两层（与 Rust normalize_category 对齐）
      const normalizeCategory = (raw: unknown): string =>
        String(raw ?? '')
          .split('/')
          .map((s) => s.trim().replace(/[\\:*?"<>|\n\r\t]/g, '-').replace(/^-+|-+$/g, ''))
          .filter(Boolean)
          .slice(0, 2)
          .join('/')
          .slice(0, 40)
      for (const c of candidates) {
        const op = String(c.op ?? '')
        if (op === 'delete') {
          const id = Number(c.id)
          const i = kbMemories.findIndex((m) => m.id === id)
          if (i >= 0) {
            kbMemories.splice(i, 1)
            kbDropMemoryDoc(id)
            deleted++
          } else skipped++
          continue
        }
        if (op === 'archive') {
          const id = Number(c.id)
          const m = kbMemories.find((x) => x.id === id)
          if (m && !m.archivedAt) {
            m.archivedAt = new Date().toISOString()
            m.archivedReason = String(c.reason ?? '').trim() || 'manual'
            kbDropMemoryDoc(id)
            archived++
          } else skipped++
          continue
        }
        const content = String(c.content ?? '').trim()
        if (!content) {
          skipped++
          continue
        }
        const memType = validTypes.includes(String(c.memType)) ? String(c.memType) : 'preference'
        const topic = String(c.topic ?? '').trim()
        const category = normalizeCategory(c.category)
        if (op === 'add') {
          const dup = kbMemories.find((m) => m.memType === memType && m.topic === topic && m.content === content)
          if (dup) {
            // 命中已归档条目 = 用户又提到了它 → 复活，而不是当重复跳过
            if (dup.archivedAt) {
              dup.archivedAt = null
              dup.archivedReason = null
              dup.updatedAt = new Date().toISOString()
              restored++
            } else skipped++
            continue
          }
          const now = new Date().toISOString()
          kbMemories.push({
            id: ++kbMemoryId,
            memType,
            topic,
            category,
            content,
            confidence: Number(c.confidence ?? 0.7),
            activeCount: 0,
            sourceChatId: chatId,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            archivedAt: null,
            archivedReason: null,
          })
          added++
        } else if (op === 'update') {
          const id = Number(c.id)
          const m = kbMemories.find((x) => x.id === id)
          if (!m) {
            skipped++
            continue
          }
          // 更新 = 重新确认：归档中的条目借机复活
          const wasArchived = Boolean(m.archivedAt)
          Object.assign(m, {
            memType,
            topic,
            category,
            content,
            confidence: Number(c.confidence ?? m.confidence),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
            archivedReason: null,
          })
          if (wasArchived) restored++
          else updated++
        } else {
          throw new Error(`记忆操作只支持 add / update / delete / archive，收到：${op}`)
        }
      }
      if (added || updated || deleted || archived || restored) {
        saveKbMemories()
        // 编目同步：新增/更新/复活走重建；删除与归档已直接摘除文档
        if (added > 0 || updated > 0 || restored > 0) {
          kbIndexed = false
          kbEnsureIndex()
        }
      }
      return delay({ added, updated, deleted, archived, restored, skipped } as T)
    }

    case 'kb_memory_delete': {
      loadKbStore()
      const id = Number(args.id)
      const i = kbMemories.findIndex((m) => m.id === id)
      if (i < 0) return delay(false as T)
      kbMemories.splice(i, 1)
      kbDropMemoryDoc(id)
      saveKbMemories()
      return delay(true as T)
    }

    case 'kb_memory_archive': {
      loadKbStore()
      const id = Number(args.id)
      const m = kbMemories.find((x) => x.id === id)
      if (!m || m.archivedAt) return delay(false as T)
      m.archivedAt = new Date().toISOString()
      m.archivedReason = String(args.reason ?? '').trim() || 'manual'
      kbDropMemoryDoc(id)
      saveKbMemories()
      return delay(true as T)
    }

    case 'kb_memory_restore': {
      loadKbStore()
      const id = Number(args.id)
      const m = kbMemories.find((x) => x.id === id)
      if (!m || !m.archivedAt) return delay(false as T)
      m.archivedAt = null
      m.archivedReason = null
      m.updatedAt = new Date().toISOString()
      saveKbMemories()
      kbIndexed = false
      kbEnsureIndex()
      return delay(true as T)
    }

    case 'kb_memory_maintain': {
      loadKbStore()
      let checked = 0
      let archived = 0
      for (const m of kbMemories) {
        if (m.archivedAt) continue
        checked++
        const idle = kbIdleDays(m)
        const stale = kbSalience(m) < KB_STALE_SALIENCE
        const due =
          (m.activeCount === 0 && idle > KB_NEVER_USED_PRUNE_DAYS) ||
          (stale && idle > KB_STALE_PRUNE_DAYS)
        if (due) {
          m.archivedAt = new Date().toISOString()
          m.archivedReason = 'decay'
          kbDropMemoryDoc(m.id)
          archived++
        }
      }
      kbSettings.lastMaintainAt = new Date().toISOString()
      saveKbMemories()
      saveKbSettings()
      return delay({ checked, archived } as T)
    }

    case 'kb_memory_stats': {
      loadKbStore()
      const activeList = kbMemories.filter((m) => !m.archivedAt)
      const sorted = activeList.slice().sort((a, b) => kbSalience(b) - kbSalience(a) || b.id - a.id)
      // 与 Rust cognition_selection 相同的双上限：条数 + 字符
      let injected = 0
      let injectedChars = 0
      for (const m of sorted) {
        if (injected >= 24) break
        const line = kbCognitionLine(m)
        if (injectedChars + line.length + 1 > 1200) break
        injectedChars += line.length + 1
        injected++
      }
      const stale = activeList.filter((m) => kbSalience(m) < KB_STALE_SALIENCE).length
      const avg = (f: (m: MockKbMemory) => number): number =>
        activeList.length
          ? Number((activeList.reduce((s, m) => s + f(m), 0) / activeList.length).toFixed(3))
          : 0
      return delay({
        active: activeList.length,
        archived: kbMemories.length - activeList.length,
        total: kbMemories.length,
        limit: 24,
        maxChars: 1200,
        injected,
        injectedChars,
        stale,
        avgConfidence: avg((m) => m.confidence),
        avgSalience: avg((m) => kbSalience(m)),
        signalRatio: activeList.length ? Number((injected / activeList.length).toFixed(3)) : 1,
        noiseRatio: activeList.length ? Number((stale / activeList.length).toFixed(3)) : 0,
        autoConsolidate: kbSettings.autoConsolidate,
        lastConsolidateAt: kbSettings.lastConsolidateAt,
        lastMaintainAt: kbSettings.lastMaintainAt,
      } as T)
    }

    case 'kb_memory_consolidated': {
      loadKbStore()
      kbSettings.lastConsolidateAt = new Date().toISOString()
      saveKbSettings()
      return delay(undefined as T)
    }

    case 'kb_cognition': {
      loadKbStore()
      // 归档不进注入；排序与 Rust 一致：显著性降序
      const sorted = kbMemories
        .filter((m) => !m.archivedAt)
        .sort((a, b) => kbSalience(b) - kbSalience(a) || b.id - a.id)
        .slice(0, 24)
      let text = ''
      for (const m of sorted) {
        const line = kbCognitionLine(m)
        if (text.length + line.length + 1 > 1200) break
        text = text ? `${text}\n${line}` : line
      }
      return delay({ memories: plain(sorted.map(kbDocToMemory)), text } as T)
    }

    case 'kb_memory_bump': {
      loadKbStore()
      const ids = (args.ids as number[]) ?? []
      const now = new Date().toISOString()
      for (const id of ids) {
        const m = kbMemories.find((x) => x.id === id)
        if (m) {
          m.activeCount++
          m.lastUsedAt = now
        }
      }
      saveKbMemories()
      return delay(undefined as T)
    }

    /* ---------- 校园教务（演示数据，只在 mock 里存在） ---------- */

    case 'campus_systems':
      return delay([
        {
          kind: 'guet-supwisdom-eams5',
          name: '桂林电子科技大学 · 本科生教学信息平台',
          vendor: '树维 Supwisdom EAMS5 · 学生端',
          defaultBaseUrl: 'https://bkjwtest.guet.edu.cn',
          loginStrategy: 'supwisdom-portal-rsa',
          bizTypeId: 2,
          mayRequireCaptcha: true,
        },
      ] as T)

    case 'campus_account_get':
      return delay((campusAccount ? { ...campusAccount } : null) as T)

    case 'campus_captcha': {
      campusNeedCaptcha = true
      // 1×1 的透明 JPEG，仅用于占位（真实环境由后端返回教务的图）
      const px =
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
      return delay(px as T)
    }

    case 'campus_login': {
      const loginName = String(args.loginName ?? '').trim()
      const password = String(args.password ?? '')
      // 与真后端同一套回落：密码留空 = 用账号里存下的那份（会话过期后的静默重登）
      const known = campusAccount?.loginName === loginName ? campusAccount : null
      const canReuseSaved = password === '' && known?.hasPassword === true
      if (!loginName || (password === '' && !canReuseSaved)) {
        const message = known
          ? '该账号没有保存密码，需要重新输入密码登录'
          : '请输入学号与密码'
        return delay({ ok: false, message, needCaptcha: false, actionRequired: null, account: null } as T)
      }
      // 演示约定：密码长度 < 3 视为「需要验证码」，方便在浏览器里走一遍验证码分支
      if (password.length < 3 && !canReuseSaved && !campusNeedCaptcha) {
        campusNeedCaptcha = true
        return delay({ ok: false, message: '需要输入验证码', needCaptcha: true, actionRequired: null, account: null } as T)
      }
      campusAccount = {
        id: 1,
        systemKind: String(args.systemKind ?? 'guet-supwisdom-eams5'),
        baseUrl: String(args.baseUrl ?? 'https://bkjwtest.guet.edu.cn'),
        loginName,
        hasPassword: args.savePassword !== false,
        loggedIn: true,
        sessionAt: new Date().toISOString(),
        studentId: '241250',
        studentCode: loginName,
        studentName: '演示同学',
        department: '计算机与信息安全学院',
        major: '智能科学与技术',
        adminclass: `${loginName.slice(0, 8)}01`,
        grade: '2026',
        totalCredits: 18.75,
        savePassword: args.savePassword !== false,
        active: true,
        lastSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      campusNeedCaptcha = false
      return delay({ ok: true, message: null, needCaptcha: false, actionRequired: null, account: { ...campusAccount } } as T)
    }

    case 'campus_session_probe':
      return delay((campusAccount?.loggedIn ?? false) as T)

    case 'campus_logout':
      if (campusAccount) {
        campusAccount.loggedIn = false
        campusAccount.sessionAt = null
      }
      return delay(undefined as T)

    case 'campus_account_delete': {
      campusAccount = null
      campusCourses = []
      campusPickedLessons = new Set<number>()
      campusSelectQueue = []
      campusSelectRequestId = ''
      campusSelectPolls = 0
      // 任务单与计划随账号一起清：换账号后旧任务不该还在后台排队
      grabTasks.length = 0
      grabIntents.length = 0
      grabEmit()
      // 删账号 = 连派生行一起清（与 Rust 一致：todos 未开外键级联，必须显式删）
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i]!.courseSessionId != null) todos.splice(i, 1)
      }
      return delay(undefined as T)
    }

    case 'campus_semesters':
      return delay((campusAccount ? [campusSemester()] : []) as T)

    case 'campus_set_current_semester':
      return delay(undefined as T)

    case 'campus_sync': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      campusCourses = campusDemoCourses()
      campusAccount.lastSyncAt = new Date().toISOString()
      const sem = campusSemester()
      const todosWritten = campusMaterializeTodos()
      return delay({
        courses: campusCourses.length,
        sessions: CAMPUS_SESSIONS.length,
        todosWritten,
        semesterId: sem.id,
        semesterName: sem.name,
        syncedAt: new Date().toISOString(),
        skippedActivities: 0,
      } as T)
    }

    case 'campus_schedule': {
      if (!campusAccount) {
        return delay({ account: null, semester: null, entries: [], timeSlots: [], courses: [] } as T)
      }
      const sem = campusSemester()
      const fallback = campusRange()
      const from = String(args.from ?? fallback[0])
      const to = String(args.to ?? fallback[1])
      return delay({
        account: { ...campusAccount },
        semester: sem,
        entries: campusExpand(sem, from, to),
        timeSlots: CAMPUS_SLOTS,
        courses: campusCourses,
      } as T)
    }

    /* ---- 选课（演示批次是「开放中」，好让整套流程能在浏览器里走通） ---- */

    case 'campus_course_select_status': {
      if (!campusAccount) {
        throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      }
      return delay({
        ready: true,
        reason: null,
        serverTime: campusServerTime(),
        studentId: 241250,
        studentCode: campusAccount.loginName ?? '2600350118',
        studentName: '演示同学',
        turns: campusSelectTurns(),
        entryUrl: 'https://bkjwtest.guet.edu.cn/course-selection/?token=demo',
      } as T)
    }

    case 'campus_course_select_lessons': {
      // 课程名 / 教学班名 / 教师是三个独立字段，界面那个搜索框三个都发
      // （与 Rust 侧和 SPA 一致），所以这里任意一个命中即可
      const q = (args.query ?? {}) as Record<string, unknown>
      const kws = [q.courseNameOrCode, q.lessonNameOrCode, q.teacherNameOrCode]
        .map((v) => String(v ?? '').trim().toLowerCase())
        .filter(Boolean)
      const all = campusDemoLessons()
      const list = kws.length
        ? all.filter((l) =>
            kws.some(
              (kw) =>
                l.course.nameZh.toLowerCase().includes(kw) ||
                l.course.code.toLowerCase().includes(kw),
            ),
          )
        : all
      return delay(list as T)
    }

    case 'campus_course_select_simplest_lessons':
      return delay(campusDemoLessons() as T)

    case 'campus_course_select_query_condition':
      // 批次未定义筛选表单时返回 null —— 界面据此回落到内置的搜索框
      return delay(null as T)

    case 'campus_course_select_apply': {
      const id = Number(args.lessonId)
      const picked = campusPickedLessons
      if (picked.has(id)) throw new Error('这门课已经选过了')
      campusSelectQueue.push(id)
      campusSelectRequestId = `req${Date.now()}`
      campusSelectPolls = 0
      return delay({ requestId: campusSelectRequestId } as T)
    }

    case 'campus_course_select_predicate': {
      campusSelectQueue.push(Number(args.lessonId))
      campusSelectRequestId = `pre${Date.now()}`
      campusSelectPolls = 0
      return delay({ requestId: campusSelectRequestId } as T)
    }

    case 'campus_course_select_result':
    case 'campus_course_select_predicate_result': {
      // 前两轮返回「处理中」，之后成功 —— 复刻真实教务的异步受理手感
      campusSelectPolls++
      if (campusSelectPolls < 2) {
        return delay({ pending: true, success: false, message: null, needAttend: false } as T)
      }
      const id = campusSelectQueue.shift()
      // 冲突演示：这门课固定返回「需要免听」，**不算选中** —— 真机上这条路
      // 也只是告诉你去网页端办免听，列表里不该出现「已选」。
      if (id === 9003) {
        return delay({ pending: false, success: false, message: null, needAttend: true } as T)
      }
      if (id != null) campusPickedLessons.add(id)
      return delay({ pending: false, success: true, message: null, needAttend: false } as T)
    }

    case 'campus_course_select_drop': {
      const ids = (args.lessonIds as unknown[] | undefined) ?? []
      for (const id of ids) campusPickedLessons.delete(Number(id))
      // 退课同样要「意向 → 正式」走一遍，所以给一点受理延迟
      return delay({
        pending: false,
        success: true,
        message: '已退课',
        needAttend: false,
      } as T)
    }

    /* ---- 自动抢课（模拟引擎见文件上方 grabTick） ---- */

    case 'campus_grab_state':
      return delay(grabSnapshot() as T)

    /* ---- 救援面（AI 的最后补救） ---- */

    case 'campus_rescue_state': {
      // e2e 钩子：把在场（或刚被抢到）的任务打成「连败到该被救」的样子。真引擎里这种状态
      // 要靠连续撞满员/未知错误攒出来，在无头浏览器里等不起，但它恰恰是 AI 最常要处理的那种。
      //
      // 两条细节都是踩出来的：
      // ① 终态的也要拉回来 —— 从「加计划」到「第一次读现场」之间有十几秒，mock 引擎早就抢到手了，
      //    只对非终态生效的话这个场景会随机落空；
      // ② 顺带按在「等窗口公布」上（`probeAt` 推到一小时外），否则引擎下一拍就把它抢走，
      //    「救一个卡住的任务」根本无从演练。
      if (!!(globalThis as { __REIN_MOCK_CAMPUS_STUCK__?: boolean }).__REIN_MOCK_CAMPUS_STUCK__) {
        for (const t of grabTasks) {
          if (t.status === 'paused') continue
          if (GRAB_TERMINAL.has(t.status)) {
            t.status = 'waiting'
            t.phase = 'idle'
            t.finishedAt = null
          }
          t.strikes = 5
          t.strikeKind = 'full'
          t.lastMessage = '教学班人数已满，继续守着'
          t.awaitWindow = true
          t.windowWall = null
          t.windowEndWall = null
          t.probeAt = Date.now() + 3600_000
        }
      }
      const snap = grabSnapshot()
      const now = Date.now()
      const tasks = snap.tasks as unknown as Array<{ id: number; status: string; strikes: number; nextAt: number }>
      const dead = !!(globalThis as { __REIN_MOCK_CAMPUS_SESSION_DEAD__?: boolean })
        .__REIN_MOCK_CAMPUS_SESSION_DEAD__
      return delay({
        account: campusAccount ? { ...campusAccount } : null,
        // 探针：没有账号 = null（没探）；被踢 = false；其余 = true
        sessionAlive: campusAccount ? !dead : null,
        sessionError: null,
        grab: snap,
        stuckTaskIds: tasks
          .filter((t) => !GRAB_TERMINAL.has(t.status) && t.status !== 'paused')
          .filter((t) => t.strikes >= 3 || t.nextAt <= now)
          .map((t) => t.id),
        recentActions: [...mockAiActions].reverse(),
      } as T)
    }

    case 'campus_http': {
      const req = plain((args.req ?? {}) as Record<string, unknown>)
      const raw = String(req.url ?? '').trim()
      const method = String(req.method ?? 'GET').toUpperCase()
      const reason = String(req.reason ?? '').trim()
      if (!reason) throw new Error('reason 不能为空：这条请求想搞清楚什么？')
      const base = String(campusAccount?.baseUrl ?? 'https://bkjwtest.guet.edu.cn')
      const url = /^https?:\/\//.test(raw) ? raw : `${base.replace(/\/$/, '')}${raw.startsWith('/') ? '' : '/'}${raw}`
      const sameOrigin = url.startsWith(base.replace(/\/$/, ''))
      const withToken = !!req.withSelectToken
      const withSession = req.withSession == null ? sameOrigin : !!req.withSession
      // 与 Rust 同一条硬边界：带凭据只许打教务同源（安静的降级比报错更危险）
      if (!sameOrigin && (withSession || withToken)) {
        throw new Error(`带凭据的请求只能打教务自己的域名（${base}），${url} 是外部地址`)
      }
      for (const h of (req.headers as [string, string][] | undefined) ?? []) {
        if (/^(cookie|authorization|host|content-length)$/i.test(String(h[0]))) {
          throw new Error(`请求头「${h[0]}」不允许手写：会话与令牌走 withSession / withSelectToken`)
        }
      }
      const script = mockHttpScript(url)
      const headers: [string, string][] = [
        ['content-type', script.contentType],
        ...(sameOrigin ? ([['set-cookie', '__pstsid__=demo; Path=/']] as [string, string][]) : []),
      ]
      const curl = mockRenderCurl({
        method,
        url,
        headers: (req.headers as [string, string][] | undefined) ?? [],
        body: (req.body as string | null) ?? null,
        withCookie: withSession,
        withToken,
      })
      mockAction('http', `${method} ${url} → HTTP ${script.status}`, curl, script.status < 400 ? 'ok' : 'error', {
        reason,
      })
      return delay({
        url,
        method,
        status: script.status,
        ok: script.status >= 200 && script.status < 300,
        sameOrigin,
        withSession,
        withSelectToken: withToken,
        headers,
        body: script.body,
        truncated: false,
        bytes: script.body.length,
        elapsedMs: 120,
        curl,
        healed: false,
        note: sameOrigin ? null : '外部地址：这条请求没有携带任何教务凭据',
      } as T)
    }

    case 'campus_rescue_note': {
      const kind = String(args.kind ?? '').trim()
      if (!kind) throw new Error('kind 不能为空')
      const summary = String(args.summary ?? '').trim()
      if (!summary) throw new Error('summary 不能为空')
      return delay(mockAction(kind, summary, null, 'ok', args.detail ?? undefined) as T)
    }

    case 'campus_curl_export': {
      const hours = Number(args.hours ?? 6)
      const entries = mockAiActions.filter((a) => a.curl)
      if (!entries.length) {
        throw new Error(`最近 ${hours} 小时里没有可导出的请求。先在 App 里打几条真实请求再导出。`)
      }
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
      const lines = [
        '#!/usr/bin/env bash',
        `# Rein 教务救援脚本 · 生成于 ${d.toISOString()}`,
        '#',
        '# 这是什么：把 AI 在 App 里对教务发出的请求**原样搬下来**，脱离 App 也能重放。',
        '# 用法：bash 本文件（逐条执行，每条之间空一行）。',
        '#',
        '# ⚠ 凭据是生成那一刻的快照：Cookie 通常几小时失效，选课令牌（JWT）更短。',
        '#   过期后不要手工改这里面的值，重新导出一次即可。',
        '# ⚠ 文件里有你自己的账号凭据，别传到别处去。',
        'set -euo pipefail',
        '',
        `BASE=${q(String(campusAccount?.baseUrl ?? 'https://bkjwtest.guet.edu.cn'))}`,
      ]
      if (entries.some((e) => e.curl?.includes('$COOKIE'))) lines.push(`COOKIE='__pstsid__=demo; SESSION=demo'`)
      if (entries.some((e) => e.curl?.includes('$SELECT_TOKEN'))) lines.push(`SELECT_TOKEN='eyJhbGciOiJIUzI1NiJ9.demo.demo'`)
      entries.forEach((e, i) => {
        lines.push('', `# ── ${i + 1}) ${e.at} · ${e.summary}`, String(e.curl), 'echo')
      })
      const script = lines.join('\n')
      const path = `C:\\Users\\demo\\AppData\\Roaming\\com.gozaoo.rein\\rescue\\rescue-${stamp}.sh`
      mockAction('script', `导出救援脚本：${entries.length} 条请求 → ${path}`)
      return delay({
        path,
        script,
        count: entries.length,
        generatedAt: d.toISOString(),
      } as T)
    }

    case 'campus_grab_enqueue': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const targets = (args.targets as Record<string, unknown>[] | undefined) ?? []
      if (!targets.length) throw new Error('没有要抢的课程')
      const mode = ((args.mode as string | null) ?? 'predicate') as 'predicate' | 'direct'
      // e2e 钩子：假装教务还没公布窗口，用来验「等窗口」这条真实状态
      const noWindow = !!(globalThis as { __REIN_MOCK_GRAB_NO_WINDOW__?: boolean })
        .__REIN_MOCK_GRAB_NO_WINDOW__
      const windowWall = noWindow ? null : ((args.windowWall as string | null) ?? null)
      const windowEndWall = noWindow ? null : ((args.windowEndWall as string | null) ?? null)

      const ids: number[] = []
      for (const t of targets) {
        const task = grabPushTask({
          turnId: String(args.turnId ?? ''),
          turnName: (args.turnName as string | null) ?? null,
          lessonId: t.lessonId,
          lessonName: (t.lessonName as string | null) ?? null,
          courseName: (t.courseName as string | null) ?? null,
          courseCode: (t.courseCode as string | null) ?? null,
          teacher: (t.teacher as string | null) ?? null,
          credits: (t.credits as number | null) ?? null,
          mode,
          virtualCost: (t.virtualCost as number | null) ?? null,
          scheduleGroupId: t.scheduleGroupId ?? null,
          windowWall,
          windowEndWall,
          groupKey: (t.groupKey as string | null) ?? null,
          groupName: (t.groupName as string | null) ?? null,
          priority: (t.priority as number | null) ?? 0,
        })
        ids.push(task.id)
      }
      grabEmit()
      return delay(ids as T)
    }

    /* ---- 抢课计划（模拟解析见文件上方 grabResolveIntents） ---- */

    case 'campus_grab_intent_add': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('要先写清楚想抢什么（课名 / 代码 / 教师）')
      const intent: MockGrabIntent = {
        id: ++grabIntentSeq,
        turnId: args.turnId ? String(args.turnId) : null,
        turnName: (args.turnName as string | null) ?? null,
        query,
        mode: args.mode === 'direct' ? 'direct' : 'predicate',
        spread: !!args.spread,
        status: 'pending',
        groupKeys: [],
        candidates: [],
        lastMessage: null,
        attempts: 0,
        nextAt: 0,
        createdAt: Date.now(),
        resolvedAt: null,
      }
      grabIntents.push(intent)
      grabEmit()
      return delay({ ...intent } as T)
    }

    case 'campus_grab_intent_action': {
      const id = Number(args.intentId)
      const i = grabIntents.findIndex((x) => x.id === id)
      if (i < 0) throw new Error('计划不存在（可能已被移除）')
      if (String(args.action) === 'remove') {
        // 与 Rust 一致：移除计划连它派出去的任务一起收
        const keys = grabIntents[i]!.groupKeys ?? []
        for (const t of grabTasks) {
          if (keys.includes(grabGroupOf(t)) && !GRAB_TERMINAL.has(t.status)) {
            t.status = 'cancelled'
            t.phase = 'idle'
            t.finishedAt = Date.now()
            t.lastMessage = '计划已移除'
          }
        }
        grabIntents.splice(i, 1)
      } else if (String(args.action) === 'now') {
        const it = grabIntents[i]!
        it.status = 'pending'
        it.nextAt = 0
        it.lastMessage = '正在重新解析教学班…'
      } else {
        throw new Error(`未知的操作：${String(args.action)}`)
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_intent_preview': {
      if (!campusAccount) throw new Error('还没有绑定教务系统账号，请先在「课表配置」里登录')
      const query = String(args.query ?? '').trim()
      const briefs = grabIntentBriefs()
      const want = args.turnId ? String(args.turnId) : null
      const brief = want
        ? briefs.find((b) => b.id === want)
        : (briefs.find((b) => b.allowEnter) ?? briefs[0])
      if (!brief) {
        throw new Error('教务还没公布选课批次，等它出现后预览会自动可用')
      }
      const lessons = campusDemoLessons()
      const hits = grabMatchLessons(query, lessons)
      return delay({
        turnId: brief.id,
        turnName: brief.name,
        total: lessons.length,
        matched: hits.length,
        // 与真引擎一致：打全了老师名字时只列那位老师的班
        matches: grabPreferred(hits).slice(0, 30).map(grabMatchDto),
      } as T)
    }

    case 'campus_grab_task_action': {
      const id = Number(args.taskId)
      const t = grabFind(id)
      if (!t) throw new Error('任务不存在（可能已被清理）')
      switch (String(args.action)) {
        case 'pause':
          t.status = 'paused'
          t.phase = 'idle'
          break
        case 'cancel':
          t.status = 'cancelled'
          t.phase = 'idle'
          t.finishedAt = Date.now()
          break
        case 'retry':
          t.status = 'waiting'
          t.phase = 'idle'
          t.attempts = 0
          t.polls = 0
          t.strikes = 0
          t.strikeKind = null
          t.requestId = null
          t.predicateDone = false
          t.finishedAt = null
          t.lastMessage = '已重新排队'
          t.nextAt = Date.now()
          break
        case 'remove': {
          const i = grabTasks.findIndex((x) => x.id === id)
          if (i >= 0) grabTasks.splice(i, 1)
          break
        }
        default:
          throw new Error(`未知的操作：${String(args.action)}`)
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_clear_finished': {
      const before = grabTasks.length
      for (let i = grabTasks.length - 1; i >= 0; i--) {
        const st = grabTasks[i]!.status
        if (st === 'success' || st === 'failed' || st === 'conflict' || st === 'cancelled') {
          grabTasks.splice(i, 1)
        }
      }
      grabEmit()
      return delay(before - grabTasks.length as T)
    }

    case 'campus_grab_pause_all': {
      for (const t of grabTasks) {
        if (t.status === 'waiting' || t.status === 'running') {
          t.status = 'paused'
          t.phase = 'idle'
        }
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_resume_all': {
      for (const t of grabTasks) {
        if (t.status === 'paused') {
          t.status = 'waiting'
          t.phase = 'idle'
          t.nextAt = Date.now()
        }
      }
      grabEmit()
      return delay(undefined as T)
    }

    case 'campus_grab_settings_get':
      return delay({ ...grabSettings } as T)

    case 'campus_grab_settings_set': {
      const incoming = plain(args.settings as GrabSettings)
      grabSettings = {
        minIntervalMs: Math.min(10000, Math.max(10, Number(incoming.minIntervalMs) || 700)),
        pollIntervalMs: Math.min(30000, Math.max(50, Number(incoming.pollIntervalMs) || 2000)),
        fullRetryMs: Math.min(120000, Math.max(100, Number(incoming.fullRetryMs) || 5000)),
        backoffMs: Math.min(60000, Math.max(50, Number(incoming.backoffMs) || 1500)),
        maxBackoffMs: Math.min(300000, Math.max(1000, Number(incoming.maxBackoffMs) || 30000)),
        leadMs: Math.min(5000, Math.max(0, Number(incoming.leadMs) ?? 800)),
        maxAttempts: Math.min(100000, Math.max(0, Number(incoming.maxAttempts) || 0)),
        maxPolls: Math.min(200, Math.max(1, Number(incoming.maxPolls) || 15)),
        // 0 是有意义的值（死守），不能用 `|| 0` 兜底写法把它换掉
        cedeAfterMs: Math.min(3600000, Math.max(0, Number(incoming.cedeAfterMs) || 0)),
        watchWindow: incoming.watchWindow !== false,
      }
      return delay({ ...grabSettings } as T)
    }

    case 'campus_program':
      return delay({
        programInfos: [
          {
            id: 5881,
            nameZh: '2026级智能科学与技术专业培养方案(主修)',
            grade: '2026',
            department: { nameZh: '计算机与信息安全学院' },
            major: { nameZh: '智能科学与技术' },
            education: { nameZh: '本科' },
            cultivateType: { nameZh: '主修' },
            printedTime: `打印日期：${ymd(new Date())}`,
            creditDistrTable: {
              type: null,
              courseStatistics: [],
              children: [
                { type: { nameZh: '通识必修课程' }, courseStatistics: [], children: [
                  { type: { nameZh: '思想政治理论课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 20, sumPeriod: 352 }] },
                  { type: { nameZh: '大学英语课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 12, sumPeriod: 192 }] },
                ] },
                { type: { nameZh: '专业必修课程' }, courseStatistics: [], children: [
                  { type: { nameZh: '专业核心课程' }, courseStatistics: [{ courseProperty: { nameZh: '必修' }, sumCredit: 46, sumPeriod: 736 }] },
                ] },
                { type: { nameZh: '通识选修课程' }, courseStatistics: [{ courseProperty: { nameZh: '选修' }, sumCredit: 10, sumPeriod: 160 }] },
              ],
              sumCredit: 162,
              sumPeriod: 2600,
            },
            courseList: campusDemoCourses().map((c) => ({
              id: c.remoteLessonId,
              nameZh: c.courseName,
              code: c.courseCode,
            })),
          },
        ],
      } as T)

    /* ---------- 在线更新 ---------- */
    case 'update_status':
      return delay(updateSnapshot() as T)

    case 'update_settings_set': {
      const patch = plain(args.patch as UpdateSettingsPatch)
      updateSettings = {
        ...updateSettings,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.channel === undefined ? {} : { channel: patch.channel.trim().toLowerCase() || 'stable' }),
        ...(patch.autoCheck === undefined ? {} : { autoCheck: patch.autoCheck }),
        ...(patch.checkIntervalHours === undefined
          ? {}
          : { checkIntervalHours: Math.min(720, Math.max(1, Number(patch.checkIntervalHours) || 12)) }),
        ...(patch.allowHttp === undefined ? {} : { allowHttp: patch.allowHttp }),
        ...(patch.silentInstall === undefined ? {} : { silentInstall: patch.silentInstall }),
        ...(patch.ignoredVersion === undefined
          ? {}
          : { ignoredVersion: patch.ignoredVersion.trim() ? patch.ignoredVersion : null }),
        ...(patch.sources === undefined ? {} : { sources: patch.sources }),
      }
      // 与 Rust 侧同一条规则：跳过/防降级这些派生判断取决于**设置**，
      // 所以设置一变就要拿新设置把上次的检查结果重算一遍（否则「点了跳过卡片还在」）
      if (updateCheck) {
        updateCheck = {
          ...updateCheck,
          ignored: updateSettings.ignoredVersion === updateCheck.latestVersion,
        }
      }
      return delay(updateSnapshot() as T)
    }

    case 'update_check': {
      const none = mockFlag('__REIN_MOCK_UPDATE_NONE__')
      const version = none ? MOCK_CURRENT_VERSION : MOCK_LATEST_VERSION
      const enabledSources = updateSettings.sources.filter((s) => s.enabled)
      const reports: SourceReport[] = enabledSources.map((s, i) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        url: s.url,
        ok: true,
        version,
        // 内置的两个源都发清单签名（与真实发布链路一致）
        manifestSigned: true,
        error: null,
        elapsedMs: 120 + i * 80,
      }))
      // 被关掉的源照样出现在报告里：界面要能解释「为什么这个源没结果」
      for (const s of updateSettings.sources.filter((x) => !x.enabled)) {
        reports.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          url: s.url,
          ok: false,
          version: null,
          manifestSigned: false,
          error: '已在设置里关闭',
          elapsedMs: 0,
        })
      }
      const checkedAt = new Date().toISOString()
      updateSettings = { ...updateSettings, lastCheckAt: checkedAt }
      updateCheck = {
        checkedAt,
        currentVersion: MOCK_CURRENT_VERSION,
        platform: 'windows-x86_64',
        available: !none,
        latestVersion: version,
        notes: none
          ? null
          : [
              '· 更新链路支持多源（自建服务 + GitHub）与断点续传',
              '· 安装包在下载与安装前各做一次 Ed25519 验签',
              '· 新增 Rein 在线服务能力探测（模型网关为预留接口）',
            ].join('\n'),
        publishedAt: new Date(Date.now() - 3600_000).toISOString(),
        sizeBytes: 42 * 1024 * 1024,
        sourceId: enabledSources[0]?.id ?? null,
        sourceName: enabledSources[0]?.name ?? null,
        sources: reports,
        mandatory: false,
        installSupported: true,
        installHint: '下载完成后会静默运行安装器并重启应用',
        ignored: updateSettings.ignoredVersion === version,
        downgradeBlocked: false,
      }
      return delay(updateCheck as T)
    }

    case 'update_download':
      if (updateDownload.verified) return delay(updateDownload as T)
      if (!updateCheck?.available) throw new Error('请先检查更新')
      startMockDownload()
      return delay(updateDownload as T)

    case 'update_cancel':
      stopUpdateTimer()
      updateDownload = { ...updateDownload, phase: 'cancelled', error: '已取消下载' }
      return delay(true as T)

    case 'update_discard':
      stopUpdateTimer()
      updateDownload = idleDownload()
      return delay(undefined as T)

    case 'update_install':
      updateDownload = { ...updateDownload, phase: 'installing' }
      return delay({
        ok: true,
        message: '（浏览器演示）真机上这里会交给系统安装器并重启应用',
        willExit: false,
      } as T)

    case 'update_progress':
      return delay(updateDownload as T)

    case 'update_prune_cache':
      return delay(0 as T)

    case 'online_service_status': {
      const offline = mockFlag('__REIN_MOCK_SERVICE_OFFLINE__')
      const base = (args.baseUrl as string | null) ?? updateSettings.sources[0]?.url.replace(/\/updates\/.*$/, '') ?? ''
      return delay({
        baseUrl: base,
        reachable: !offline,
        service: offline ? null : 'rein-online-service',
        version: offline ? null : '1.0.0',
        currentRelease: offline ? null : MOCK_LATEST_VERSION,
        channels: offline ? [] : [{ channel: 'stable', current: MOCK_LATEST_VERSION }],
        manifestUrl: offline ? null : `${base}/updates/latest.json`,
        ai: offline
          ? null
          : {
              status: 'not_configured',
              enabled: true,
              requireToken: true,
              clientCount: 0,
              providers: [
                { id: 'ark', name: '火山方舟', enabled: false, models: ['doubao-seed-1-6-250615'] },
                { id: 'deepseek', name: 'DeepSeek', enabled: false, models: ['deepseek-chat'] },
              ],
              modelsEndpoint: `${base}/v1/models`,
              chatEndpoint: `${base}/v1/chat/completions`,
            },
        error: offline ? '无法连接 /health：连接被拒绝（mock）' : null,
        checkedAt: new Date().toISOString(),
        elapsedMs: offline ? 3000 : 84,
      } as T)
    }

    default:
      throw new Error(`mock 未实现的命令: ${cmd}`)
  }
}

// 供测试 / 开发检查使用
export const __weekStart = weekStart
