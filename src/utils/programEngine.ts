/**
 * 健康方案引擎 · 纯函数，无 IPC、无副作用。
 *
 * 「程序计算、AI 只调参」架构中的计算层：
 * 1. buildProgramPlans —— 由用户档案确定性生成三套档位方案（保守/均衡/进取），
 *    含可行性检查与日程级展开（训练课 + 食谱菜单 + 当日注意）；
 * 2. 所有数字来自 nutritionCalc 的公式与 recipe_templates.json 的实算营养
 *    （模板由 scripts/gen-recipes.mjs 从 foods.json 生成），不经过任何模型；
 * 3. AI 复盘产出的调整建议必须经 clampAdjustment 钳制后由用户确认应用，
 *    AI 永远不能自由生成新计划。
 */

import seedRecipes from '@resources/recipe_templates.json'

import type {
  Equipment,
  Goal,
  ProgramAdjustment,
  ProgramChange,
  ProgramBlob,
  ProgramDay,
  ProgramMeal,
  ProgramParams,
  ProgramPlan,
  ProgramTier,
  Profile,
  RecipePref,
  ScheduleTodoInput,
  TimeSlot,
} from '@/types'
import { addDays, ageFromBirthday, diffDays, todayStr } from '@/utils/date'
import { calcTargetsWith, type CalcParams } from './nutritionCalc'

/* ---------------- 食谱模板库（构建期生成的静态内容） ---------------- */

interface RecipeItem {
  food: string
  grams?: number
  unit?: string
  count?: number
  /** 单位制条目的单位克重（gen-recipes 生成时写入），供缩放展示 */
  unitGrams?: number | null
}

export interface RecipeTemplate {
  id: string
  name: string
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack'
  items: RecipeItem[]
  baseKcal: number
  baseProtein: number
  baseCarb: number
  baseFat: number
  allergens: string[]
}

const RECIPES = (seedRecipes as { recipes: RecipeTemplate[] }).recipes

/* ---------------- 档位参数表：初始方案 = 各目标的平均线 ---------------- */

interface TierSpec {
  label: string
  desc: string
  deltaByGoal: Record<Goal, number>
  proteinByGoal: Record<Goal, number>
  mealsCount: number
  trainingDays: number
}

export const TIER_SPECS: Record<ProgramTier, TierSpec> = {
  conservative: {
    label: '保守',
    desc: '小缺口慢进度，3 练 3 餐，容易坚持',
    deltaByGoal: { cut: -300, keep: -50, bulk: 200 },
    proteinByGoal: { cut: 1.6, keep: 1.2, bulk: 1.6 },
    mealsCount: 3,
    trainingDays: 3,
  },
  balanced: {
    label: '均衡',
    desc: '标准缺口节奏，4 练 4 餐，多数人的选择',
    deltaByGoal: { cut: -400, keep: 0, bulk: 300 },
    proteinByGoal: { cut: 1.8, keep: 1.3, bulk: 1.7 },
    mealsCount: 4,
    trainingDays: 4,
  },
  aggressive: {
    label: '进取',
    desc: '大缺口高频次，5 练 5 餐，需要较强执行力',
    deltaByGoal: { cut: -500, keep: 50, bulk: 400 },
    proteinByGoal: { cut: 2.0, keep: 1.5, bulk: 1.8 },
    mealsCount: 5,
    trainingDays: 5,
  },
}

/* ---------------- 周计划模板：days 下标 0=周一，值为课程 id / null=休息 ---------------- */

/**
 * 频次设计原则：研究里的「最佳频次 2~3 次/周」指**同一肌群**每周被直接练到的次数，
 * 不是每周去几次健身房。因此每个模板都用全身 / 上下 / 推拉腿混排分化，
 * 保证大肌群（胸背肩腿）每周 ≥2 次，而不是「一周 N 练但每部位只轮到 1 次」。
 */
export interface WeekTemplate {
  id: string
  label: string
  days: (string | null)[]
}

const WEEK_TEMPLATES: Record<'gym' | 'home', WeekTemplate[]> = {
  gym: [
    { id: 'gym-3', label: '三练 · 全身×3（每肌群 3 次/周）', days: ['gym-fullbody', null, 'gym-fullbody', null, 'gym-fullbody', null, null] },
    { id: 'gym-4', label: '四练 · 上下×2（每肌群 2 次/周）', days: ['gym-upper', 'gym-lower', null, 'gym-upper', 'gym-lower', null, null] },
    { id: 'gym-5', label: '五练 · 推拉腿加上下（每肌群 2 次/周）', days: ['ppl-push', 'ppl-pull', 'ppl-legs', null, 'gym-upper', 'gym-lower', null] },
    { id: 'gym-6', label: '六练 · 推拉腿上下核（每肌群 2 次/周）', days: ['ppl-push', 'ppl-pull', 'ppl-legs', 'gym-upper', 'gym-lower', 'core', null] },
    { id: 'gym-7', label: '七练 · 推拉腿循环（每肌群 2 次/周）', days: ['ppl-push', 'ppl-pull', 'ppl-legs', 'gym-upper', 'gym-lower', 'home-hiit', 'core'] },
  ],
  home: [
    { id: 'home-3', label: '居家三练 · 全身上下（每肌群 2 次/周）', days: ['home-fullbody', null, 'home-upper', null, 'home-lower', null, null] },
    { id: 'home-4', label: '居家四练 · 加燃脂间歇（每肌群 2 次/周）', days: ['home-fullbody', 'home-upper', null, 'home-lower', null, 'home-hiit', null] },
    { id: 'home-5', label: '居家五练 · 循环加量（每肌群 2 次/周）', days: ['home-fullbody', 'home-upper', 'home-lower', null, 'home-hiit', 'core', null] },
    { id: 'home-6', label: '居家六练 · 高频循环（每肌群 3 次/周）', days: ['home-fullbody', 'home-upper', 'home-lower', 'home-hiit', 'home-fullbody', 'core', null] },
    { id: 'home-7', label: '居家七练 · 每日循环（每肌群 3 次/周）', days: ['home-fullbody', 'home-upper', 'home-lower', 'home-hiit', 'home-upper', 'home-lower', 'core'] },
  ],
}

/**
 * 课程覆盖的肌群（用于计算模板的单肌群频次）；
 * home-hiit 是燃肺间歇，不算大肌群直接刺激，仅计核心。
 */
const COURSE_MUSCLES: Record<string, string[]> = {
  'gym-fullbody': ['胸', '背', '肩', '腿'],
  'gym-upper': ['胸', '背', '肩'],
  'gym-lower': ['腿'],
  'ppl-push': ['胸', '肩'],
  'ppl-pull': ['背'],
  'ppl-legs': ['腿'],
  'core': [],
  'home-fullbody': ['胸', '背', '肩', '腿'],
  'home-upper': ['胸', '背', '肩'],
  'home-lower': ['腿'],
  'home-hiit': [],
}

/**
 * 模板的单肌群训练频次：大肌群（胸/背/肩/腿）一周内被覆盖的最低次数。
 * 用于对比矩阵向用户展示「每个肌群一周练到几次」——这是研究结论真正指向的指标。
 */
export function weekMuscleFreq(templateId: string): number | null {
  const tpl = [...WEEK_TEMPLATES.gym, ...WEEK_TEMPLATES.home].find((t) => t.id === templateId)
  if (!tpl) return null
  const hits = new Map(['胸', '背', '肩', '腿'].map((m) => [m, 0]))
  for (const day of tpl.days) {
    if (day == null) continue
    for (const m of COURSE_MUSCLES[day] ?? []) hits.set(m, (hits.get(m) ?? 0) + 1)
  }
  return Math.min(...hits.values())
}

/** 课程元信息（引擎只需要这几项；来自 workout_plans 表） */
export interface CourseLite {
  id: string
  name: string
  equipment: 'gym' | 'home' | null
  estDurationMin: number | null
}

/**
 * 按器械条件与每周可用天数选周模板。
 * 可用天数不足最低频模板时，取最低频模板的**前 N 个训练日位**合成（按位置截断；
 * 不能按课程 id 去重——全身×3 这类模板同一课程会出现多次），尊重用户的真实约束。
 */
export function pickWeekTemplate(equipment: Equipment | null, days: number): WeekTemplate {
  const pool = WEEK_TEMPLATES[equipment === 'home' ? 'home' : 'gym']
  const freqOf = (t: WeekTemplate) => t.days.filter(Boolean).length
  if (days <= 0) {
    return { id: 'rest-only', label: '纯饮食安排（无训练日）', days: Array.from({ length: 7 }, () => null) }
  }
  const exact = pool.find((t) => freqOf(t) === days)
  if (exact) return exact
  const base = pool[0]!
  const keptIdx = new Set(
    base.days
      .map((d, i) => (d != null ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, days),
  )
  return {
    ...base,
    id: `${base.id}-x${days}`,
    days: base.days.map((d, i) => (keptIdx.has(i) ? d : null)),
  }
}

/**
 * 周模板相位反解：让「方案第一个训练日」恰好是指定课程——
 * 场景：今天刚练完拉日，用户希望方案首练接腿日，避免推→拉→推连续上肢高负荷。
 * 在 0-6 相位里找「首个非 null 位 = courseId 且训练日到来最早」的相位；模板没有
 * 该课程时返回 0（按模板默认顺序）。
 */
export function phaseForFirstCourse(tpl: WeekTemplate, courseId: string): number {
  let best: { phase: number; offset: number } | null = null
  for (let p = 0; p < 7; p++) {
    for (let i = 0; i < 7; i++) {
      const id = tpl.days[(p + i) % 7]
      if (id == null) continue
      if (id === courseId && (best == null || i < best.offset)) best = { phase: p, offset: i }
      break
    }
  }
  return best?.phase ?? 0
}

/* ---------------- 方案生成 ---------------- */

function missingDataIssues(profile: Profile): string[] {
  const issues: string[] = []
  if (!profile.sex) issues.push('性别未填写')
  if (!ageFromBirthday(profile.birthday)) issues.push('生日未填写或无效')
  if (!profile.heightCm) issues.push('身高未填写')
  if (!profile.weightKg) issues.push('体重未填写')
  return issues.map((x) => `缺少身体数据（${x}），请先在「我」页补全`)
}

/** 忌口关键词命中的模板 id 集合（过敏原标签与食材名双向子串匹配） */
function restrictedRecipeIds(restrictions: string[] | null): Set<string> {
  const ids = new Set<string>()
  const kws = (restrictions ?? []).map((r) => r.trim()).filter(Boolean)
  if (!kws.length) return ids
  for (const r of RECIPES) {
    const hit = kws.some(
      (kw) => r.allergens.some((a) => a.includes(kw)) || r.items.some((it) => it.food.includes(kw)),
    )
    if (hit) ids.add(r.id)
  }
  return ids
}

interface MealSlotDef {
  mealType: RecipeTemplate['mealType']
  slot: string
  share: number
}

/** 餐次结构与热量分配比例（按每日餐次数） */
const MEAL_LAYOUTS: Record<number, MealSlotDef[]> = {
  3: [
    { mealType: 'breakfast', slot: '早餐', share: 0.27 },
    { mealType: 'lunch', slot: '午餐', share: 0.38 },
    { mealType: 'dinner', slot: '晚餐', share: 0.35 },
  ],
  4: [
    { mealType: 'breakfast', slot: '早餐', share: 0.25 },
    { mealType: 'lunch', slot: '午餐', share: 0.33 },
    { mealType: 'snack', slot: '下午加餐', share: 0.12 },
    { mealType: 'dinner', slot: '晚餐', share: 0.3 },
  ],
  5: [
    { mealType: 'breakfast', slot: '早餐', share: 0.23 },
    { mealType: 'snack', slot: '上午加餐', share: 0.09 },
    { mealType: 'lunch', slot: '午餐', share: 0.31 },
    { mealType: 'snack', slot: '下午加餐', share: 0.09 },
    { mealType: 'dinner', slot: '晚餐', share: 0.28 },
  ],
}

const round5 = (x: number): number => Math.round(x / 5) * 5

export interface MealSlotPlan {
  mealType: RecipeTemplate['mealType']
  slot: string
  share: number
}

/** 餐次布局（槽位名 + 热量占比）：AI 菜单生成与模板装配共用同一分布 */
export function mealLayoutFor(mealsCount: number): MealSlotPlan[] {
  return (MEAL_LAYOUTS[mealsCount] ?? MEAL_LAYOUTS[3]!).map((d) => ({
    mealType: d.mealType,
    slot: d.slot,
    share: d.share,
  }))
}

/** 模板整体缩放后的展示条目：「燕麦片 50g」「鸡蛋 1个」（单位制按 0.5 步进取整） */
function formatItems(t: RecipeTemplate, f: number): string[] {
  return t.items.map((it) => {
    if (it.grams != null) return `${it.food} ${round5(it.grams * f)}g`
    const count = Math.max(0.5, Math.round((it.count ?? 1) * f * 2) / 2)
    const shown = Number.isInteger(count) ? String(count) : count.toFixed(1)
    return `${it.food} ${shown}${it.unit ?? ''}`
  })
}

/** 选一个食谱模板：排除不喜欢项，喜欢项优先，再按与目标热量的接近度排名；
 *  在同一天序的 Top3 内轮换避免天天重样（首轮=喜欢优先，后续也稳定） */
function pickRecipe(
  type: RecipeTemplate['mealType'],
  targetKcal: number,
  rotation: number,
  liked: Set<string>,
  disliked: Set<string>,
): RecipeTemplate {
  const all = RECIPES.filter((r) => r.mealType === type)
  const pool = all.some((r) => !disliked.has(r.id)) ? all.filter((r) => !disliked.has(r.id)) : all
  const ranked = [...pool].sort((a, b) => {
    const la = liked.has(a.id) ? 0 : 1
    const lb = liked.has(b.id) ? 0 : 1
    return (
      la - lb || Math.abs(a.baseKcal - targetKcal) - Math.abs(b.baseKcal - targetKcal)
    )
  })
  const top = ranked.slice(0, Math.min(3, ranked.length))
  return top[rotation % top.length]!
}

/** 单日菜单：各餐按热量占比装配模板并整体缩放（0.6~1.8 倍，宏量比例不变） */
function buildDayMeals(
  dailyKcal: number,
  mealsCount: number,
  dayIndex: number,
  banned: Set<string>,
  liked: Set<string>,
  disliked: Set<string>,
): ProgramMeal[] {
  const layout = MEAL_LAYOUTS[mealsCount] ?? MEAL_LAYOUTS[3]!
  return layout.map((def, i) => {
    const targetKcal = dailyKcal * def.share
    let t = pickRecipe(def.mealType, targetKcal, dayIndex + i, liked, disliked)
    if (banned.has(t.id)) {
      const alt = RECIPES.filter(
        (r) => r.mealType === def.mealType && !banned.has(r.id) && !disliked.has(r.id),
      )
      if (alt.length) {
        t = alt.sort(
          (a, b) => Math.abs(a.baseKcal - targetKcal) - Math.abs(b.baseKcal - targetKcal),
        )[0]!
      }
    }
    const f = Math.min(1.8, Math.max(0.6, targetKcal / t.baseKcal))
    return {
      // mealType 随菜单一起下发：下游按它归类/打卡，避免从展示名反查
      // （「上午加餐/下午加餐」都对不上 MEAL_LABELS.snack 的「加餐」）
      mealType: def.mealType,
      slot: def.slot,
      name: t.name,
      items: formatItems(t, f),
      kcal: Math.round(t.baseKcal * f),
      protein: Math.round(t.baseProtein * f),
      carb: Math.round(t.baseCarb * f),
      fat: Math.round(t.baseFat * f),
    }
  })
}

/** 当日注意（日程级「不要干什么」）：训练/休息差异 + 忌口提醒 + 通用作息 */
function buildDayRules(rest: boolean, profile: Profile): string[] {
  const rules: string[] = []
  if (rest) {
    rules.push('休息日 · 以散步拉伸为主，不做大强度训练')
  } else {
    rules.push('训练日 · 碳水集中在练前练后两餐')
    rules.push('练后 30 分钟内补充蛋白质 + 快碳')
  }
  const restrictions = (profile.dietRestrictions ?? []).map((r) => r.trim()).filter(Boolean)
  if (restrictions.length) rules.push(`忌口：不吃${restrictions.join('、')}`)
  rules.push('睡前 3 小时停止进食，保证 7 小时以上睡眠')
  return rules
}

/** 展开方案为逐日安排（startDate 起共 totalDays 天）。
 * 课程按「方案相对天数 + 相位」从周模板循环序列取——开始日可以是任何一天
 * （今天/明天/下周一），相位让序列接续用户当前节奏，而非死绑日历周。 */
function expandDays(
  params: ProgramParams,
  tpl: WeekTemplate,
  profile: Profile,
  courseMap: Map<string, CourseLite>,
  startDate: string,
  totalDays: number,
  liked: Set<string>,
  disliked: Set<string>,
): ProgramDay[] {
  const banned = restrictedRecipeIds(profile.dietRestrictions)
  const phase = ((params.phase % 7) + 7) % 7
  const days: ProgramDay[] = []
  for (let i = 0; i < totalDays; i++) {
    const date = addDays(startDate, i)
    const courseId = tpl.days[(phase + i) % 7] ?? null
    const course = courseId != null ? (courseMap.get(courseId) ?? null) : null
    days.push({
      date,
      dayIndex: i,
      rest: course == null,
      courseId: course?.id ?? null,
      courseName: course?.name ?? null,
      courseDurationMin: course?.estDurationMin ?? null,
      meals: buildDayMeals(params.targets.kcal, params.mealsCount, i, banned, liked, disliked),
      rules: buildDayRules(course == null, profile),
    })
  }
  return days
}

/** 三档方案草稿：确定性生成，同输入必得同输出（平均线基线）。
 * phase = 周模板序列相位（0-6）：startDate 当天取模板第 phase 位，
 * 支持从今天/明天开始并接续当前训练节奏（默认 0 + 下周一 = 经典对齐）。 */
export function buildProgramPlans(
  profile: Profile,
  startDate: string,
  weeks: number,
  courses: CourseLite[],
  prefs: RecipePref[] = [],
  phase = 0,
): ProgramPlan[] {
  const body: CalcParams | null = (() => {
    const age = ageFromBirthday(profile.birthday)
    if (!profile.sex || age == null || !profile.heightCm || !profile.weightKg) return null
    return {
      sex: profile.sex,
      age,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      activityLevel: profile.activityLevel,
      goal: profile.goal,
    }
  })()

  const courseMap = new Map(courses.map((c) => [c.id, c]))
  const issues = missingDataIssues(profile)
  const liked = new Set(prefs.filter((p) => p.rating === 1).map((p) => p.recipeId))
  const disliked = new Set(prefs.filter((p) => p.rating === -1).map((p) => p.recipeId))

  return (Object.keys(TIER_SPECS) as ProgramTier[]).map((tier) => {
    const spec = TIER_SPECS[tier]
    const notes: string[] = []
    // 训练频率以用户设置的「每周可训练天数」为权威（档位频率仅在未设置时作为默认）；
    // 档位差异体现在热量缺口 / 蛋白配比 / 餐次结构上
    const available = profile.trainingDaysPerWeek
    const trainingDays =
      available == null ? spec.trainingDays : Math.min(Math.max(available, 0), 7)

    const equipment: Equipment | null = profile.equipment ?? 'gym'
    const tpl = pickWeekTemplate(equipment, trainingDays)

    if (!body) {
      // 身体数据缺失时仍给出结构预览（热量按默认值占位），但标记不可启用
      const fallbackTargets = { kcal: 2000, protein: 100, carb: 220, fat: 60, sodiumMg: 1500, waterMl: 2000 }
      const params: ProgramParams = {
        kcalDelta: spec.deltaByGoal[profile.goal],
        proteinPerKg: spec.proteinByGoal[profile.goal],
        targets: fallbackTargets,
        bmr: 0,
        tdee: 0,
        mealsCount: spec.mealsCount,
        trainingDays,
        weekTemplateId: tpl.id,
        equipment,
        phase,
      }
      return {
        goal: profile.goal,
        tier,
        tierLabel: spec.label,
        tierDesc: spec.desc,
        weeks,
        startDate,
        feasible: false,
        issues,
        notes,
        params,
        days: [],
      }
    }

    const res = calcTargetsWith(body, {
      kcalDelta: spec.deltaByGoal[profile.goal],
      proteinPerKg: spec.proteinByGoal[profile.goal],
    })
    const params: ProgramParams = {
      kcalDelta: spec.deltaByGoal[profile.goal],
      proteinPerKg: spec.proteinByGoal[profile.goal],
      targets: res.targets,
      bmr: res.bmr,
      tdee: res.tdee,
      mealsCount: spec.mealsCount,
      trainingDays,
      weekTemplateId: tpl.id,
      equipment,
      phase,
    }
    return {
      goal: profile.goal,
      tier,
      tierLabel: spec.label,
      tierDesc: spec.desc,
      weeks,
      startDate,
      feasible: true,
      issues: [],
      notes,
      params,
      days: expandDays(params, tpl, profile, courseMap, startDate, weeks * 7, liked, disliked),
    }
  })
}

/* ---------------- 日程待办展开 ---------------- */

function trainStartMin(slots: TimeSlot[] | null): number {
  if (slots?.includes('evening')) return 18 * 60
  if (slots?.includes('noon')) return 12 * 60
  if (slots?.includes('morning')) return 6 * 60 + 30
  return 18 * 60
}

function breakfastStartMin(slots: TimeSlot[] | null): number {
  return slots?.includes('morning') ? 7 * 60 : 7 * 60 + 40
}

/** 把方案内容铺成日程待办（饮食锚点 + 有课日的训练条目）。
 * 训练日的饮食锚点排在课程结束之后——方案规则本身就是「练后 30 分钟内补充
 * 蛋白质 + 快碳」，也让两条固定日程不再同刻度常态化重叠；休息日按早餐时间。 */
export function buildScheduleTodos(blob: ProgramBlob, preferredSlots: TimeSlot[] | null): ScheduleTodoInput[] {
  const trainMin = trainStartMin(preferredSlots)
  const dietMin = breakfastStartMin(preferredSlots)
  const out: ScheduleTodoInput[] = []
  for (const day of blob.days) {
    const kcalSum = day.meals.reduce((s, m) => s + m.kcal, 0)
    const menuLines = day.meals
      .map((m) => `${m.slot}｜${m.name}（约${m.kcal}大卡）\n${m.items.join('、')}`)
      .join('\n')
    const hasCourse = !!(day.courseId && day.courseName && !day.rest)
    const anchorMin = hasCourse ? trainMin + (day.courseDurationMin ?? 45) : dietMin
    out.push({
      title: `方案饮食 · 约${kcalSum}大卡`,
      notes: `${menuLines}\n注意：${day.rules.join('；')}`,
      date: day.date,
      startMin: anchorMin,
      durationMin: 15,
      category: 'health',
      priority: 1,
    })
    if (hasCourse) {
      out.push({
        title: `方案·${day.courseName}`,
        notes: day.rules.join('；'),
        date: day.date,
        startMin: trainMin,
        durationMin: day.courseDurationMin ?? 45,
        category: 'workout',
        priority: 1,
      })
    }
  }
  return out
}

/* ---------------- 调整钳制：AI 只能在框架内调参 ---------------- */

export interface AdjustmentPatch {
  kcalDelta?: number
  proteinPerKg?: number
  trainingDays?: number
}

/** 调整边界：任何来源（AI / 手动）的建议都必须落在这些范围内 */
export const ADJUSTMENT_LIMITS = {
  kcalDeltaMin: -800,
  kcalDeltaMax: 600,
  proteinPerKgMin: 1.0,
  proteinPerKgMax: 2.4,
  trainingDaysMax: 7,
} as const

const clampNum = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/**
 * AI 返回的参数可能是 NaN / Infinity，而 `Math.max(min, NaN)` 恒为 NaN ——
 * 钳制函数本身对非有限值无防御，NaN 会一路穿透写进 params_json 并渲染成「NaN 大卡」。
 * 入口统一把非有限值丢弃、回退到当前值。
 */
const finiteOr = <T>(v: T | undefined, fallback: T): T =>
  typeof v === 'number' && !Number.isFinite(v) ? fallback : (v ?? fallback)

const fmtDelta = (v: number): string => `${v > 0 ? '+' : ''}${v} 大卡`

/**
 * 应用调整补丁：用最新身体数据重算目标，越界值直接钳到边界（不报错、不拒绝，
 * 保证「采纳建议」总能得到一份安全的新方案）；返回新参数与变更明细供确认 UI 展示。
 */
export function clampAdjustment(
  profile: Profile,
  current: ProgramParams,
  patch: AdjustmentPatch,
): { next: ProgramParams; changes: ProgramChange[] } {
  const body = (() => {
    const age = ageFromBirthday(profile.birthday)
    if (!profile.sex || age == null || !profile.heightCm || !profile.weightKg) return null
    return {
      sex: profile.sex,
      age,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      activityLevel: profile.activityLevel,
      goal: profile.goal,
    } satisfies CalcParams
  })()
  if (!body) throw new Error('缺少身体数据（性别/生日/身高/体重），无法重算目标')

  const nextDelta = clampNum(finiteOr(patch.kcalDelta, current.kcalDelta), ADJUSTMENT_LIMITS.kcalDeltaMin, ADJUSTMENT_LIMITS.kcalDeltaMax)
  const nextProtein = clampNum(finiteOr(patch.proteinPerKg, current.proteinPerKg), ADJUSTMENT_LIMITS.proteinPerKgMin, ADJUSTMENT_LIMITS.proteinPerKgMax)
  const availCap = Math.min(profile.trainingDaysPerWeek ?? ADJUSTMENT_LIMITS.trainingDaysMax, ADJUSTMENT_LIMITS.trainingDaysMax)
  const nextDays = clampNum(Math.round(finiteOr(patch.trainingDays, current.trainingDays)), 0, availCap)
  const changes: ProgramChange[] = []
  if (nextDelta !== current.kcalDelta) {
    changes.push({ field: 'kcalDelta', label: '每日热量偏移', before: fmtDelta(current.kcalDelta), after: fmtDelta(nextDelta) })
  }
  if (nextProtein !== current.proteinPerKg) {
    changes.push({
      field: 'proteinPerKg',
      label: '蛋白质配比',
      before: `${current.proteinPerKg.toFixed(1)} g/kg`,
      after: `${nextProtein.toFixed(1)} g/kg`,
    })
  }
  if (nextDays !== current.trainingDays) {
    changes.push({ field: 'trainingDays', label: '每周训练天数', before: `${current.trainingDays} 天`, after: `${nextDays} 天` })
  }

  const res = calcTargetsWith(body, { kcalDelta: nextDelta, proteinPerKg: nextProtein })
  const targetUnit = (key: 'kcal' | 'protein' | 'carb' | 'fat'): string => (key === 'kcal' ? ' 大卡' : ' g')
  const targetLabel = { kcal: '每日热量', protein: '蛋白质目标', carb: '碳水目标', fat: '脂肪目标' } as const
  for (const key of ['kcal', 'protein', 'carb', 'fat'] as const) {
    if (Math.round(res.targets[key]) !== Math.round(current.targets[key])) {
      changes.push({
        field: `targets.${key}`,
        label: targetLabel[key],
        before: `${Math.round(current.targets[key])}${targetUnit(key)}`,
        after: `${Math.round(res.targets[key])}${targetUnit(key)}`,
      })
    }
  }

  const nextTpl = pickWeekTemplate(current.equipment, nextDays)
  const next: ProgramParams = {
    ...current,
    kcalDelta: nextDelta,
    proteinPerKg: nextProtein,
    targets: res.targets,
    bmr: res.bmr,
    tdee: res.tdee,
    trainingDays: nextDays,
    // 训练天数变化时换用匹配的周模板（store 在重建日程前调用）；模板换了，
    // 旧相位的「首练接续」语义失效，回到模板默认顺序
    weekTemplateId: nextTpl.id,
    phase: nextTpl.id === current.weekTemplateId ? (((current.phase ?? 0) % 7) + 7) % 7 : 0,
  }
  return { next, changes }
}

/**
 * 调整后的内容重建：保留 fromDate 之前的历史天（执行记录），其后按新参数重新展开
 * 到原方案的结束日期。训练天数变化会自动换周模板。
 * 相位保持连续：fromDate 那天的模板位 = 旧相位 + 已走过的天数（同模板时），
 * 未来天无缝接上原循环；换了模板则从新模板头部开始。
 */
export function rebuildBlob(
  old: ProgramBlob,
  nextParams: ProgramParams,
  profile: Profile,
  fromDate: string,
  courses: CourseLite[],
  prefs: RecipePref[] = [],
): ProgramBlob {
  const past = old.days.filter((d) => d.date < fromDate)
  const oldEnd = old.days.at(-1)?.date
  const remaining = oldEnd ? diffDays(fromDate, oldEnd) + 1 : 0
  if (remaining <= 0) return { params: nextParams, days: past }
  const oldStart = old.days[0]?.date
  const tplChanged = old.params.weekTemplateId !== nextParams.weekTemplateId
  const continuedPhase =
    oldStart != null && oldStart <= fromDate
      ? ((((nextParams.phase ?? 0) + diffDays(oldStart, fromDate)) % 7) + 7) % 7
      : (((nextParams.phase ?? 0) % 7) + 7) % 7
  const startPhase = tplChanged ? 0 : continuedPhase
  const tpl = pickWeekTemplate(nextParams.equipment, nextParams.trainingDays)
  const liked = new Set(prefs.filter((p) => p.rating === 1).map((p) => p.recipeId))
  const disliked = new Set(prefs.filter((p) => p.rating === -1).map((p) => p.recipeId))
  const future = expandDays(
    { ...nextParams, phase: startPhase },
    tpl,
    profile,
    new Map(courses.map((c) => [c.id, c])),
    fromDate,
    remaining,
    liked,
    disliked,
  )
  // expandDays 从 0 重新编号，直接拼接会与 past 的序号撞车（「第 N 天 / 总天数」
  // 与进度计算都读 dayIndex）。续接 past 的序号，保证全期单调递增唯一。
  const offset = past.length
  const renumbered =
    offset === 0 ? future : future.map((d) => ({ ...d, dayIndex: d.dayIndex + offset }))
  return { params: { ...nextParams, phase: startPhase }, days: [...past, ...renumbered] }
}

/** 组装一条调整历史记录（版本号在 store 侧随落库结果回填亦可） */
export function makeAdjustmentEntry(
  version: number,
  summary: string,
  changes: ProgramChange[],
  source: 'ai' | 'manual',
): ProgramAdjustment {
  return { version, at: new Date().toISOString(), summary, changes, source }
}

/** 解析 programs.params_json；损坏时抛出带上下文的错误而非静默吞掉 */
export function parseBlob(record: { paramsJson: string }): ProgramBlob {
  try {
    const blob = JSON.parse(record.paramsJson) as ProgramBlob
    if (!blob.params || !Array.isArray(blob.days)) throw new Error('结构缺失')
    return blob
  } catch (e) {
    throw new Error(`方案数据损坏，无法解析：${String(e)}`)
  }
}

/** 方案结束日期（最后一天）；空方案时返回今天 */
export function programEndDate(blob: ProgramBlob): string {
  return blob.days.at(-1)?.date ?? todayStr()
}
