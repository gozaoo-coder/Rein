/**
 * 「弱项加练」的纯函数层（无 IPC、不落库，与 trainingAdvice 同一条纪律）。
 *
 * 从练够分结果里挑出**练得不够的肌群**，组装一份只活在内存里的**临时课程**：
 * `session.start()` 直接开练，**不写进课程库** —— 它是「今天补一下」而不是
 * 「我的训练计划」，混进课程列表只会污染那份清单。
 *
 * 另含主页「练」卡的焦点推荐（`lapsedIdleGroups` / `focusGroup`）：
 * 回答「现在最该练谁」，与加练共用同一份练够分口径。
 *
 * 四条口径（都可复核，沿用本文件的既有纪律，只把判据从旧「容量」换成练够分）：
 *  1. **弱项 = 本周有记录（!idle）且练够分 < 60**，即规范里的「不够 / 明显不足」。
 *     刻意排除本周完全没练的组（idle）：那更可能是「这个肌群我根本不专门练」，
 *     排进加练没有意义；练过但没练够的才是真弱项（与 trainingScore.summarize 同口径）。
 *     排序按练够分升序，最弱的排最前。
 *  2. **缺口来自组数满分区间下沿**：`setsTarget[0] - sets`，向上取整并夹在 [2, 6]。
 *     练够分的组数分以 `setsTarget` 为满分区，下沿就是「离满分还差几组」；
 *     夹持是因为过小的缺口不值得单独加练、过大的缺口一次也补不完。
 *  3. **只用主攻动作补弱**：候选动作必须 `kind === 'strength'`，且该评估组的任一细肌群
 *     在动作肌群表（`libraryMuscles`）里为 **3（主攻）**。用辅助动作凑数效率低，还会把
 *     别的肌群一起推高（那是"脏容量"，会掩盖真正的弱项）；某个弱项一个主攻动作都挑不到时
 *     **跳过它**，不拿辅助动作糊弄 —— 否则用户看到「AI 给我补了」，实际弱项没补到。
 *  4. 候选排序：用户练过的（有历史 = 不用重新学动作、重量也有底）优先，其次按库内既定顺序
 *     （内置课程/种子的顺序本身有教学质量含义）；同组最多两个动作（再多是堆量不是补弱）。
 *
 * 上面第 3、4 条服务于**临时课**（库里没有合适的现成课时的兜底）。
 * **优先的是现成课**：课程库里已配置好的课，训练目的若与弱项高度相似（`matchCourse`），
 * 直接练它 —— 用户自己排过的处方比现场拼的草稿可信，也不必再学一遍新动作。
 *
 * 评估粒度与练够分一致，是 10 个**评估组**（`config/muscles` 的 SCORE_GROUPS）而非 39 个肌束。
 */

import { SCORE_GROUPS, type ActivationMap, type MuscleKey, type ScoreGroupKey } from '@/config/muscles'
import { libraryMuscles } from '@/utils/libraryMuscles'
import type { GroupScore } from '@/utils/trainingScore'
import type { ExerciseRecord, PlanExercise, WorkoutPlan } from '@/types'

/** 评估组 → 成员细肌群（SCORE_GROUPS 是唯一折叠口径，这里建一次索引复用） */
const MEMBERS_OF = new Map<ScoreGroupKey, readonly MuscleKey[]>(
  SCORE_GROUPS.map((g) => [g.key, g.members]),
)

/** 「不够」的分界：练够分 < 60 即规范里的「不够 / 明显不足」，其余都算练够了 */
const WEAK_SCORE = 60
/** 加练缺口的下限与上限（组）：低于下限不值得单独加练，高于上限一次补不完 */
const GAP_MIN = 2
const GAP_MAX = 6

/**
 * 弱项评估组：本周有记录且练够分 < 60，按练够分升序（最弱在前）。
 *
 * 刻意**排除**本周完全没练的组（`idle`）—— 那更可能是「这个肌群我根本不打算专门练」，
 * 把它排进「弱项加练」会给出一个没有意义的课程。练过但没练够的才是真弱项。
 */
export function weakGroups(groups: GroupScore[], limit = 6): GroupScore[] {
  return groups
    .filter((g) => !g.idle && g.score < WEAK_SCORE)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
}

/** 一组「还差多少组」——加练课按它分配工作量（离满分区下沿的距离，夹在 [2, 6]） */
export function gapOf(g: GroupScore): number {
  const gap = Math.ceil(g.setsTarget[0] - g.sets)
  return Math.min(GAP_MAX, Math.max(GAP_MIN, gap))
}

/* ---------------- 练卡焦点（主页「练」卡推荐谁） ---------------- */

/**
 * 「断练」组：本周没练（idle）但 4 周基线窗里常练 —— 该捡回来。
 * 从未练过的 idle 组不在此列：那更可能是「这个肌群我根本不专门练」，
 * 排进推荐只会每周空喊（与上面 weakGroups 排除 idle 的理由同源，判据见 trainingScore.baseSets）。
 */
export function lapsedIdleGroups(groups: GroupScore[]): GroupScore[] {
  return groups.filter((g) => g.idle && g.baseSets > 0)
}

/**
 * 练卡焦点组：现在最该练谁，**未练优先于分低**。
 *
 *  · covered 非空（今天的课主攻了这些组）：主攻里先找未练的（分化定的课正好把没练的补上），
 *    再找弱项（「正好补它」）；主攻组都练够了 → null —— 其他部位分化自会安排，卡上不多嘴。
 *  · covered 为 null（今天没课 / 无方案）：先说断练未练的，再退到弱项。
 *  · covered 为空数组：有课但还没解析出主攻组（课程库未就绪）→ null，不猜。
 */
export function focusGroup(groups: GroupScore[], covered: ScoreGroupKey[] | null): GroupScore | null {
  if (!groups.length) return null
  if (covered === null) return lapsedIdleGroups(groups)[0] ?? weakGroups(groups)[0] ?? null
  if (!covered.length) return null
  const byKey = new Map(groups.map((g) => [g.group, g] as const))
  const idleHit = covered.map((k) => byKey.get(k)).find((g) => g?.idle)
  if (idleHit) return idleHit
  return weakGroups(groups).find((g) => covered.includes(g.group)) ?? null
}

/**
 * 该动作是否以某评估组为**主攻**：组内任一细肌群在动作肌群表里为 3 档。
 * 只看主攻（理由见文件头第 3 条），辅助/稳定档一律不算。
 */
function isPrimaryFor(ex: ExerciseRecord, group: ScoreGroupKey): boolean {
  const members = MEMBERS_OF.get(group)
  if (!members) return false
  const map = libraryMuscles(ex)
  return members.some((m) => map[m] === 3)
}

export interface CatchupPick {
  group: ScoreGroupKey
  label: string
  /**
   * 该组本周练够分。`catchupPrompt` 要求把练够分写进交给 AI 的那段话，
   * 而 `pickCatchup` 是唯一能看到 `GroupScore` 的环节，故随选组一起带出来
   * （其余三字段是调用方渲染所需，签名保持不变）。
   */
  score: number
  /** 加练缺口（组），已夹在 [2, 6] */
  gap: number
  exercises: ExerciseRecord[]
}

/**
 * 为弱项评估组挑动作。`historyIds` = 用户练过的动作 id（优先挑这些）。
 * 返回按弱项顺序（练够分升序）；某个弱项一个主攻动作都挑不到时**跳过它**，
 * 而不是拿辅助动作凑数 —— 凑出来的课程会把别的肌群一起堆高，
 * 而用户看到的是「AI 给我补了」，实际上弱项没补到。
 */
export function pickCatchup(
  weak: GroupScore[],
  library: ExerciseRecord[],
  historyIds: Set<string>,
  perMuscle = 2,
): CatchupPick[] {
  const strengthLib = library.filter((e) => e.kind === 'strength')
  const out: CatchupPick[] = []
  for (const g of weak) {
    const candidates = strengthLib.filter((e) => isPrimaryFor(e, g.group))
    if (!candidates.length) continue
    const picked = [...candidates]
      // 练过的优先；其次按库内既定顺序（内置课程/种子给的顺序本身有教学质量含义）
      .sort((a, b) => Number(historyIds.has(b.id)) - Number(historyIds.has(a.id)))
      .slice(0, perMuscle)
    out.push({ group: g.group, label: g.label, score: g.score, gap: gapOf(g), exercises: picked })
  }
  return out
}

/** 库记录 → 课程条目（组次取库默认处方，重量留空由训练页的建议引擎填） */
function asPlanExercise(ex: ExerciseRecord, idx: number): PlanExercise {
  return {
    id: `catchup-${idx}`,
    exerciseId: ex.id,
    name: ex.name,
    kind: ex.kind,
    sets: ex.defaultSets,
    reps: ex.defaultReps,
    weightKg: ex.defaultWeightKg,
    targetSec: ex.defaultTargetSec,
    durationMin: ex.defaultDurationMin,
    restSec: ex.defaultRestSec,
    tips: ex.tips,
    muscles: ex.muscles,
  }
}

/**
 * 组装临时课程。组数按缺口分配：
 * 缺口 ≥6 组给 4 组、≥3 给 3 组、其余 2 组 —— 用一个明面上的规则代替"看着给"，
 * 免得两份相近的弱项拿到差很多的工作量而没有理由。
 * 单次总组数封顶 24 组：超过就不是"补一下"而是一节完整训练，
 * 那会与用户当天的正式训练叠量（容量最怕的就是这种叠加）。
 */
export function buildCatchupPlan(picks: CatchupPick[]): WorkoutPlan {
  const pairs = picks.flatMap((p) => p.exercises.map((e) => ({ e, gap: p.gap })))
  const perGap = (gap: number): number => (gap >= 6 ? 4 : gap >= 3 ? 3 : 2)

  const MAX_TOTAL = 24
  const exercises: PlanExercise[] = []
  let total = 0
  for (const { e, gap } of pairs) {
    const sets = perGap(gap)
    if (total + sets > MAX_TOTAL) break
    total += sets
    const item = asPlanExercise(e, exercises.length)
    exercises.push({ ...item, sets })
  }

  return {
    id: `catchup-${Date.now().toString(36)}`,
    name: '弱项加练',
    subtitle: exercises.length ? `补 ${picks.length} 个练得不够的肌群 · ${total} 组` : '没有可补的肌群',
    workoutType: 'strength',
    exercises,
  }
}

/**
 * 交给 AI 的那段话：把弱项与草稿都写进去，模型才有得改（不给它就只能瞎猜）。
 *
 * 有现成课时（`course`）把它写上，并把问题改成「这节课要不要动」—— 那种情况下用户要的是核对，
 * 只递草稿会让模型从零重排一节，等于把课程库里那节正好对症、正等着开练的课白扔掉。
 * 草稿为空（弱项全被现成课覆盖）时不再提草稿，免得让模型对着「我初步排的草稿：」后面一片空白。
 */
export function catchupPrompt(
  picks: CatchupPick[],
  plan: WorkoutPlan,
  course?: CourseLite | null,
): string {
  const lines = picks.map(
    (p) =>
      `· ${p.label}：本周练够分 ${p.score}，还差约 ${p.gap} 组（可练 ${p.exercises.map((e) => e.name).join('、')}）`,
  )
  const draft = plan.exercises
    .map((e) => `${e.name} ${e.sets} 组 × ${e.reps ?? '—'} 次`)
    .join('；')
  /** 课程在话里的称呼：带上副标（「背 · 肱二头 · 前臂」这种），模型才知道它是什么课 */
  const named = course ? `「${course.name}」${course.subtitle ? `（${course.subtitle}）` : ''}` : ''
  return [
    course
      ? `我的课程库里有${named}，训练目的与这些弱项高度一致，我打算练它。`
      : '帮我排一节临时加练课，目标是补上本周练得不够的肌群。',
    '',
    '我的弱项：',
    ...lines,
    ...(draft ? ['', `我初步排的草稿：${draft}`] : []),
    '',
    course
      ? '请判断这节现成的课要不要调整：不用改就说可以练；要改就给出改后的安排（动作、组数、次数、组间休息）并说明理由。'
      : '请据此给一份更合理的临时加练课（动作、组数、次数、组间休息），并说明为什么这样排。',
  ].join('\n')
}

/* ---------------- 现成课程：弱项 → 课程库里已配置好的那一节 ---------------- */

/**
 * 动作 → 肌群激活表。做成参数而不是直接 import store：本文件是纯函数层
 * （文件头第一条纪律），不该知道 store 的存在；调用方传 `lib.musclesOf` 即可。
 */
export type MusclesResolver = (item: PlanExercise) => ActivationMap | null

/**
 * 课程主攻的评估组 = 这门课的**训练目的**。
 *
 * 与 `isPrimaryFor` 是同一个判据、相反的问法：那边问「这个动作主攻不主攻某组」，
 * 这边问「这门课主攻哪几组」。粒度同样是 10 个评估组。
 *
 * 必须经 `musclesOf` 解析而不是读 `item.muscles` 就完事：课程条目只在 AI 写入时
 * 才自带肌群表，内置课程/编辑器建的课只存 `exerciseId`，肌群在**动作库**里 ——
 * 读条目字段会让内置课全都得到空表（这门课看起来没有任何训练目的）。
 */
export function courseGroups(exercises: PlanExercise[], musclesOf: MusclesResolver): ScoreGroupKey[] {
  return SCORE_GROUPS.filter((g) =>
    exercises.some((e) => {
      const map = musclesOf(e) ?? {}
      return g.members.some((m) => map[m] === 3)
    }),
  ).map((g) => g.key)
}

/**
 * 「训练目的高度相似」的判据：课程的主攻组里至少 **2/3** 落在弱项上。
 *
 * 为什么不是「有交集就算」：全身课的主攻组覆盖一切，有交集永远成立 ——
 * 于是任何弱项都会推出「练全身课」，那不是目的相似，是「什么都练一点」，
 * 而且会把已经练够的组一起堆量（脏容量）。为什么不是 100%：推日（主攻 胸·肩·三头·核心）
 * 在「胸肩三头都弱」的场景里显然该选，核心只是那节平板支撑顺带练到的，
 * 不该因为这一组就判它「不像」。2/3 让一门课带一两个顺带的组，但不许带一半。
 */
const PURPOSE_FIT = 2 / 3

/** 候选课程：只取匹配与开练要用的字段（纯函数不依赖 store 的记录全貌，冒烟也便于构造） */
export interface CourseLite {
  id: string
  name: string
  subtitle: string
  workoutType: WorkoutPlan['workoutType']
  exercises: PlanExercise[]
  /** 预估时长（分钟）；null / 缺省 = 未标注 */
  estDurationMin?: number | null
}

/** 弱项匹配到的现成课程 */
export interface CoursePick<C extends CourseLite = CourseLite> {
  /** 课程本身：含动作清单，调用方可直接 `session.start(course)` 开练 */
  course: C
  /** 课程主攻的评估组（训练目的），按 SCORE_GROUPS 顺序 */
  groups: ScoreGroupKey[]
  /** 命中的弱项，按传入顺序 —— 这门课能补上的正是这些 */
  hits: GroupScore[]
  /** 相似度 = 命中数 / 主攻组数（≥ PURPOSE_FIT 才可能入选） */
  fit: number
}

/**
 * 从课程库里挑出**训练目的与弱项高度相似**的那一节；挑不到返回 null
 * （调用方回落到临时加练课 —— 现场拼的草稿仍是「库里没有」时的兜底）。
 *
 * 三个条件缺一不可：
 *  1. **有命中**：至少主攻一个弱项组；
 *  2. **够贴近**：`fit = 命中数 / 主攻组数 ≥ 2/3`（判据见 PURPOSE_FIT）；
 *  3. **补到点子上**：最该补的那个组（`weak[0]`，调用方按「未练优先」排好序）
 *     必须是它的主攻组 —— 只补到次要弱项的课，哪怕 100% 精准，也没解决最要紧的缺口。
 *
 * 排序：命中多的优先（一次补得更多）；同样多时主攻组少的优先（更专一，
 * 往已练够的组叠的量更少）；仍并列时按传入顺序（课程库已按最近使用排序，
 * 用户熟的那节在前）。
 *
 * **只收 strength 课**：加练补的是「还差几组」的量，HIIT / 拉伸课没有组数处方，
 * 拿它顶上等于换了个练法，缺口还在。
 */
export function matchCourse<C extends CourseLite>(
  weak: GroupScore[],
  courses: C[],
  musclesOf: MusclesResolver,
): CoursePick<C> | null {
  if (!weak.length) return null
  const anchor = weak[0].group
  let best: CoursePick<C> | null = null
  for (const course of courses) {
    if (course.workoutType !== 'strength') continue
    const groups = courseGroups(course.exercises, musclesOf)
    if (!groups.length || !groups.includes(anchor)) continue
    const hits = weak.filter((w) => groups.includes(w.group))
    if (!hits.length) continue
    const fit = hits.length / groups.length
    if (fit < PURPOSE_FIT) continue
    // 只有**严格更好**才替换：并列时保留先遇到的（课程库顺序 = 最近使用的在前）
    if (
      best &&
      !(
        hits.length > best.hits.length ||
        (hits.length === best.hits.length && groups.length < best.groups.length)
      )
    ) {
      continue
    }
    best = { course, groups, hits, fit }
  }
  return best
}
