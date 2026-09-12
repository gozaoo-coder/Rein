/**
 * 浏览器开发用内存后端：与 Rust 后端实现同一套命令契约。
 * 仅在非 Tauri 环境（`npm run dev` 直接开网页）时被 transport.ts 动态加载，
 * 附带少量演示数据便于 UI 迭代；正式数据路径永远是 Rust + SQLite。
 */
import seedJson from '@resources/foods.json'
import seedPlansJson from '@resources/workout_plans.json'

import type {
  AiChatMessage,
  AiChatMessageInput,
  AiModel,
  AiModelInput,
  AiProbeResult,
  BodyMetric,
  BodyMetricInput,
  CalcState,
  ChatSearchHit,
  DailySummary,
  DailyTargets,
  Food,
  FoodCreateInput,
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
  ScheduleTodoInput,
  TargetAdjustProposal,
  TargetChange,
  Todo,
  Workout,
  WorkoutPlanInput,
  WorkoutPlanRecord,
} from '@/types'
import { addDays, startOfMonth, startOfWeek, todayStr } from '@/utils/date'
import { ruleMatchesDate } from '@/utils/recurrence'

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

/** 重量曲线数据源：session_finish 时展开落行；exercise_name 跨课程/编辑稳定 */
interface MockStrengthSet {
  id: number
  workoutId: number
  planId: string | null
  exerciseKey: string
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
  kind: 'text' | 'image' | 'file' | 'audio'
  parentId: string | null
  title: string
  summary: string
  body: string
  occurredOn: string | null
  tags: string[]
  updatedAt: string
}

interface MockKbFile {
  id: number
  path: string
  content: string
  system: boolean
  createdAt: string
  updatedAt: string
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

/** 把用户给的路径归位成 笔记/ 下的合法路径（与 Rust files::normalize_path 同构） */
function kbNormalizePath(raw: string): string {
  let p = raw.trim().replace(/^\/+/, '')
  if (!p) throw new Error('文件路径不能为空')
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`路径不允许包含 ..：${p}`)
  if (p.startsWith('规范/')) throw new Error('规范/ 是系统命名空间，只能由应用更新，不能由用户写入')
  if (!p.startsWith('笔记/') && !p.startsWith('文档/')) p = `笔记/${p}`
  p = p
    .split('/')
    .filter(Boolean)
    .map((seg) => kbSanitize(seg, 60))
    .join('/')
  return p.endsWith('.md') ? p : `${p}.md`
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
  content: string
  confidence: number
  activeCount: number
  sourceChatId: string | null
  createdAt: string
  updatedAt: string
}

// 规范文件内容与 src-tauri 的 include_str! 同源（docs/kb-vfs.md），浏览器 mock 也读同一份
import specMarkdown from '../../docs/kb-vfs.md?raw'

const KB_SETTINGS_KEY = 'rein.mock.kb_settings.v1'
const KB_MEMORY_KEY = 'rein.mock.kb_memories.v1'
const KB_FILE_KEY = 'rein.mock.kb_files.v1'
const KB_SPEC_PATH = '规范/知识库规范.md'

const kbDocs: MockKbDoc[] = []
let kbDocId = 0
const kbMemories: MockKbMemory[] = []
let kbMemoryId = 0
const kbFiles: MockKbFile[] = []
let kbFileId = 0
let kbIndexed = false

let kbSettings: {
  embeddingMode: 'keyword' | 'local' | 'cloud'
  cloudBaseUrl: string | null
  cloudApiKey: string | null
  cloudModel: string | null
  cloudDim: number | null
  sourcesEnabled: Record<string, boolean>
  autoMemory: boolean
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
      kbMemories.push(...list)
      kbMemoryId = Math.max(kbMemoryId, ...list.map((m) => m.id), 0)
    }
    const f = localStorage.getItem(KB_FILE_KEY)
    if (f) {
      const list = JSON.parse(f) as MockKbFile[]
      kbFiles.push(...list)
      kbFileId = Math.max(kbFileId, ...list.map((x) => x.id), 0)
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

/** 播种规范文件（幂等，内容与 docs/kb-vfs.md 同源） */
function kbEnsureSpec(): void {
  const have = kbFiles.find((f) => f.path === KB_SPEC_PATH)
  if (have) return
  const now = new Date().toISOString()
  kbFiles.push({ id: ++kbFileId, path: KB_SPEC_PATH, content: specMarkdown, system: true, createdAt: now, updatedAt: now })
  saveKbFiles()
}

/** 把各 mock 数据源扫一遍建索引。真实实现由 SQLite 触发器登记 + 后台线程消费。 */
function kbEnsureIndex(): void {
  if (kbIndexed) return
  kbIndexed = true

  // 规范文件（system=1，只读）与用户笔记
  kbEnsureSpec()
  for (const f of kbFiles) {
    const base = f.path.split('/').pop() ?? f.path
    kbUpsertDoc(
      'note',
      String(f.id),
      base.replace(/\.md$/, ''),
      kbCacheBody(f.content),
      f.createdAt.slice(0, 10),
      [f.system ? '规范' : '笔记'],
      { path: f.path, editable: !f.system, system: f.system },
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
    )
  }
  // 长期记忆也编目（kb_docs 的一类来源，可被 glob/检索）
  for (const m of kbMemories) {
    kbUpsertDoc(
      'memory',
      String(m.id),
      m.topic ? `记忆 · ${m.topic}` : `记忆 · ${m.memType}`,
      m.content,
      m.createdAt.slice(0, 10),
      [m.memType],
      { path: `记忆/${m.memType}/${m.topic || '未命名'}-${m.id}.md`, editable: true },
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
  return { ...m }
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

    /* ---------- 重量曲线（逐组记录查询，与 Rust 同语义） ---------- */

    case 'strength_history': {
      const name = String(args.exerciseName)
      const rows = strengthSets
        .filter((r) => r.exerciseName === name)
        .map((r) => {
          const w = workouts.find((x) => x.id === r.workoutId)
          return {
            workoutId: r.workoutId,
            date: w?.date ?? r.createdAt.slice(0, 10),
            exerciseName: r.exerciseName,
            setNo: r.setNo,
            weightKg: r.weightKg,
            reps: r.reps,
            sec: r.sec,
            warmup: r.warmup,
          }
        })
        .sort((a, b) => a.date.localeCompare(b.date) || a.workoutId - b.workoutId)
      return delay(structuredClone(rows) as T)
    }

    case 'strength_exercises': {
      const agg = new Map<string, { lastDate: string; sessions: Set<number> }>()
      for (const r of strengthSets) {
        if (r.warmup || r.weightKg == null) continue
        const w = workouts.find((x) => x.id === r.workoutId)
        const date = w?.date ?? r.createdAt.slice(0, 10)
        const cur = agg.get(r.exerciseName) ?? { lastDate: '', sessions: new Set<number>() }
        if (date > cur.lastDate) cur.lastDate = date
        cur.sessions.add(r.workoutId)
        agg.set(r.exerciseName, cur)
      }
      const rows = [...agg.entries()]
        .map(([name, v]) => ({ name, lastDate: v.lastDate, sessions: v.sessions.size }))
        .sort((a, b) => b.lastDate.localeCompare(a.lastDate))
      return delay(structuredClone(rows) as T)
    }

    case 'strength_last_weights': {
      const names = (args.names as string[]) ?? []
      const rows = names
        .map((name) => {
          const done = strengthSets
            .filter((r) => r.exerciseName === name && !r.warmup && r.weightKg != null)
            .map((r) => {
              const w = workouts.find((x) => x.id === r.workoutId)
              return { ...r, date: w?.date ?? r.createdAt.slice(0, 10) }
            })
            // 与 Rust ORDER BY date DESC, workout_id DESC, id DESC 对齐：id 决胜保证取「最后一组」
            .sort((a, b) => b.date.localeCompare(a.date) || b.workoutId - a.workoutId || b.id - a.id)
          const last = done[0]
          return last
            ? { name, weightKg: last.weightKg!, reps: last.reps, date: last.date }
            : null
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
      return delay(structuredClone(rows) as T)
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
      const existing = plans.find((x) => x.id === input.id)
      if (existing) {
        existing.name = name
        existing.subtitle = String(input.subtitle ?? '').trim()
        existing.workoutType = input.workoutType
        existing.exercises = JSON.parse(JSON.stringify(input.exercises)) as WorkoutPlanRecord['exercises']
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
        exercises: JSON.parse(JSON.stringify(input.exercises)) as WorkoutPlanRecord['exercises'],
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
    case 'voice_config_status':
      return delay((voiceConfig.asrAdapter === 'qwen'
        ? !!voiceConfig.appKey
        : voiceConfig.mode === 'new'
          ? !!voiceConfig.appKey
          : !!voiceConfig.appKey && !!voiceConfig.accessKey) as T)
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
      const path = kbNormalizePath(String(input.path ?? ''))
      const content = String(input.content ?? '')
      if (!content.trim()) throw new Error('文件内容不能为空')
      const now = new Date().toISOString()
      let f = kbFiles.find((x) => x.path === path)
      if (f) {
        f.content = content
        f.updatedAt = now
      } else {
        f = { id: ++kbFileId, path, content, system: false, createdAt: now, updatedAt: now }
        kbFiles.push(f)
      }
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      const doc = kbDocs.find((d) => d.sourceType === 'note' && d.sourceId === String(f!.id))!
      return delay({ ...f, docId: doc.id } as T)
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
      const path = kbNormalizePath(String(args.path ?? ''))
      if (kbFiles.some((x) => x.path === path && x.id !== id)) throw new Error(`目标路径已存在：${path}`)
      f.path = path
      f.updatedAt = new Date().toISOString()
      saveKbFiles()
      kbIndexed = false
      kbEnsureIndex()
      return delay({ ...f } as T)
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
      return delay({ ...f } as T)
    }

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
      const list = (t ? kbMemories.filter((m) => m.memType === t) : kbMemories)
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return delay(plain(list.map(kbDocToMemory)) as T)
    }

    case 'kb_memory_apply': {
      loadKbStore()
      const candidates = plain(args.candidates as Record<string, unknown>[]) ?? []
      const chatId = (args.chatId as string | undefined) ?? null
      let added = 0
      let updated = 0
      let deleted = 0
      let skipped = 0
      const validTypes = ['preference', 'constraint', 'event', 'entity', 'profile', 'pattern']
      for (const c of candidates) {
        const op = String(c.op ?? '')
        if (op === 'delete') {
          const id = Number(c.id)
          const i = kbMemories.findIndex((m) => m.id === id)
          if (i >= 0) {
            kbMemories.splice(i, 1)
            deleted++
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
        if (op === 'add') {
          const dup = kbMemories.find((m) => m.memType === memType && m.topic === topic && m.content === content)
          if (dup) {
            skipped++
            continue
          }
          const now = new Date().toISOString()
          kbMemories.push({
            id: ++kbMemoryId,
            memType,
            topic,
            content,
            confidence: Number(c.confidence ?? 0.7),
            activeCount: 0,
            sourceChatId: chatId,
            createdAt: now,
            updatedAt: now,
          })
          added++
        } else if (op === 'update') {
          const id = Number(c.id)
          const m = kbMemories.find((x) => x.id === id)
          if (!m) {
            skipped++
            continue
          }
          Object.assign(m, { memType, topic, content, confidence: Number(c.confidence ?? m.confidence), updatedAt: new Date().toISOString() })
          updated++
        } else {
          throw new Error(`记忆操作只支持 add / update / delete，收到：${op}`)
        }
      }
      if (added || updated || deleted) saveKbMemories()
      // 编目同步：新增/更新走重建，删除直接摘除对应文档
      if (deleted > 0) {
        for (const c of candidates) {
          if (String(c.op ?? '') !== 'delete') continue
          const di = kbDocs.findIndex((d) => d.sourceType === 'memory' && d.sourceId === String(c.id))
          if (di >= 0) kbDocs.splice(di, 1)
        }
      }
      if (added > 0 || updated > 0) {
        kbIndexed = false
        kbEnsureIndex()
      }
      return delay({ added, updated, deleted, skipped } as T)
    }

    case 'kb_memory_delete': {
      loadKbStore()
      const id = Number(args.id)
      const i = kbMemories.findIndex((m) => m.id === id)
      if (i < 0) return delay(false as T)
      kbMemories.splice(i, 1)
      saveKbMemories()
      return delay(true as T)
    }

    case 'kb_cognition': {
      loadKbStore()
      const sorted = kbMemories
        .slice()
        .sort((a, b) => b.activeCount - a.activeCount || b.confidence - a.confidence)
        .slice(0, 24)
      const labels: Record<string, string> = {
        preference: '偏好', constraint: '约束', event: '事件',
        entity: '实体', profile: '画像', pattern: '规律',
      }
      let text = ''
      for (const m of sorted) {
        const line = `- [${labels[m.memType] ?? m.memType}] ${m.content}`
        if (text.length + line.length + 1 > 1200) break
        text = text ? `${text}\n${line}` : line
      }
      return delay({ memories: plain(sorted.map(kbDocToMemory)), text } as T)
    }

    case 'kb_memory_bump': {
      loadKbStore()
      const ids = (args.ids as number[]) ?? []
      for (const id of ids) {
        const m = kbMemories.find((x) => x.id === id)
        if (m) m.activeCount++
      }
      saveKbMemories()
      return delay(undefined as T)
    }

    default:
      throw new Error(`mock 未实现的命令: ${cmd}`)
  }
}

// 供测试 / 开发检查使用
export const __weekStart = weekStart
