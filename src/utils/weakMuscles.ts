/**
 * 「弱项加练」的纯函数层（无 IPC、不落库，与 trainingAdvice 同一条纪律）。
 *
 * 从练够分结果里挑出**练得不够的肌群**，组装一份只活在内存里的**临时课程**：
 * `session.start()` 直接开练，**不写进课程库** —— 它是「今天补一下」而不是
 * 「我的训练计划」，混进课程列表只会污染那份清单。
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
 * 评估粒度与练够分一致，是 10 个**评估组**（`config/muscles` 的 SCORE_GROUPS）而非 39 个肌束。
 */

import { SCORE_GROUPS, type MuscleKey, type ScoreGroupKey } from '@/config/muscles'
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

/** 交给 AI 的那段话：把弱项与草稿都写进去，模型才有得改（不给它就只能瞎猜） */
export function catchupPrompt(picks: CatchupPick[], plan: WorkoutPlan): string {
  const lines = picks.map(
    (p) =>
      `· ${p.label}：本周练够分 ${p.score}，还差约 ${p.gap} 组（可练 ${p.exercises.map((e) => e.name).join('、')}）`,
  )
  const draft = plan.exercises
    .map((e) => `${e.name} ${e.sets} 组 × ${e.reps ?? '—'} 次`)
    .join('；')
  return [
    '帮我排一节临时加练课，目标是补上本周练得不够的肌群。',
    '',
    '我的弱项：',
    ...lines,
    '',
    `我初步排的草稿：${draft}`,
    '',
    '请据此给一份更合理的临时加练课（动作、组数、次数、组间休息），并说明为什么这样排。',
  ].join('\n')
}
