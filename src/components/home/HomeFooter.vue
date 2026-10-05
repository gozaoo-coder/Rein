<script setup lang="ts">
/**
 * 主页页脚（移动端）· 「翻新」稿落地
 *
 * 骨架＝旧版页脚：卡片铺在页面底色上、14px 网格、工具 chip 居中收尾 —— 不扎堆成一张大卡。
 * 与旧版的差别在**内容与归属**：
 *   · 入口变事实：课表 → 课程条（正在上 / 还剩多久 / 下一节倒计时）；饮食、训练、专注、钱 →
 *     各自的实时事实格。事实的数据源一律是各域 store，这里不做第二份口径。
 *   · 饮食一族扶正：「饮食库 / 食谱库 / 饮食历史」与「记饮食」同权，一起住进「吃」卡；
 *     「练」卡同理（记运动 + 健康方案）。归属关系替代了边角位置。
 *   · 练卡的事实由**练够分**驱动，但「未练」优先于「分低」：本周没练、4 周内常练的部位
 *     先说（断练该捡回来），从没练过的组不凑热闹；分化今天定的课主攻了谁，就顺着它说。
 *   · 「立刻练」直接开练：有今天的课就开课，休息日排一节能补上未练/弱项的课，
 *     都没有就给弱项加练组一节临时课 —— 不让用户再去训练页翻。
 *
 * 插件层契约不变：成员全部从 `features.tools` 按 id 取，关掉模块 = 对应的卡/成员消失；
 * 没有落进任何区的工具（未来的插件）会落到末尾的工具行，不会凭空消失。
 * 就地动作（开抽屉）仍由页面实现：这里持有抽屉与 ACTIONS 表（从 HomePage 迁来）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Dumbbell, Play, Plus, Timer, Utensils, Wallet } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import AddWorkoutSheet from '@/components/exercise/AddWorkoutSheet.vue'
import DietHistorySheet from '@/components/diet/DietHistorySheet.vue'
import MuscleCatchupSheet from '@/components/exercise/MuscleCatchupSheet.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import { MEAL_LABELS, MEAL_ORDER } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { SCORE_GROUPS, type ScoreGroupKey } from '@/config/muscles'
import type { ToolContribution } from '@/plugins'
import type { ToolAction } from '@/plugins/types'
import type { WorkoutPlanRecord } from '@/types'
import { defaultRange, useCampusStore } from '@/stores/campus'
import { useDietStore } from '@/stores/diet'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useFeaturesStore } from '@/stores/features'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePlanStore } from '@/stores/plan'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useProgramStore } from '@/stores/program'
import { useSessionStore } from '@/stores/session'
import { useTodoStore } from '@/stores/todo'
import { useToast } from '@/composables/useToast'
import { sessionService } from '@/services/sessionService'
import { openImmersive } from '@/system/sessionImmersive'
import { openView as openVoiceView } from '@/system/voiceRuntime'
import { diffDays, todayStr } from '@/utils/date'
import { courseOnDate, programStatus } from '@/utils/programCycle'
import { parseBlob } from '@/utils/programEngine'
import { computeTrainingScore, type GroupScore, type TrainingScoreResult } from '@/utils/trainingScore'
import { focusGroup, lapsedIdleGroups, weakGroups } from '@/utils/weakMuscles'

const props = defineProps<{ date: string }>()

const router = useRouter()
const features = useFeaturesStore()
const toast = useToast()

const campus = useCampusStore()
const diet = useDietStore()
const ledger = useLedgerStore()
const pomo = usePomodoroStore()
const program = useProgramStore()
const todo = useTodoStore()
const lib = useExerciseLibStore()
const planStore = usePlanStore()
const nutrition = useNutritionStore()

/* ---- 就地动作：插件声明「做什么」，这里实现「怎么做」（含三张抽屉） ---- */
const quickOpen = ref(false)
const workoutOpen = ref(false)
const historyOpen = ref(false)

const ACTIONS: Record<ToolAction, () => void> = {
  'smart-add': () => {
    quickOpen.value = true
  },
  'add-workout': () => {
    workoutOpen.value = true
  },
  'voice-session': () => {
    // 未配置豆包语音服务时引导去模型页
    void openVoiceView().then((ok) => {
      if (!ok) {
        toast.toast('先在「管理模型」里配置豆包语音服务')
        void router.push('/ai/models')
      }
    })
  },
  'diet-history': () => {
    historyOpen.value = true
  },
}

function runTool(t: ToolContribution): void {
  if (t.action) {
    ACTIONS[t.action]()
    return
  }
  if (t.to) void router.push(t.to)
}

/** 按 id 取工具：插件层是成员的唯一来源，取不到 = 模块关着 */
function toolById(id: string): ToolContribution | undefined {
  return features.tools.find((t) => t.id === id)
}

/* ---- 两个「记录域」的成员清单（add = 那枚带 ＋ 的记录动作） ---- */
const EAT_IDS = ['nutrition.smart-add', 'nutrition.foods', 'nutrition.recipes', 'nutrition.history'] as const
const TRAIN_IDS = ['sports.log', 'program.open'] as const

const eatMembers = computed(() => EAT_IDS.map(toolById).filter((t): t is ToolContribution => t != null))
const trainMembers = computed(() => TRAIN_IDS.map(toolById).filter((t): t is ToolContribution => t != null))

/** 没落进任何区的工具（未来插件）：收进末尾工具行，不凭空消失 */
const rowTools = computed<ToolContribution[]>(() => {
  const consumed = new Set<string>([
    ...EAT_IDS,
    ...TRAIN_IDS,
    'campus.schedule',
    'focus.open',
    'ledger.open',
    'voice.session',
    'ai.chat',
  ])
  const fixed = ['voice.session', 'ai.chat'].map(toolById).filter((t): t is ToolContribution => t != null)
  return [...fixed, ...features.tools.filter((t) => !consumed.has(t.id))]
})

/* ---- 课程条：正在上 / 下一节 ---- */
const campusOn = computed(() => features.isEnabled('campus'))

/** 「还剩几分钟」是会走的：半分钟校一次（倒计时精度到分钟即可） */
const now = ref(new Date())
let ticker = 0
onMounted(() => {
  ticker = window.setInterval(() => (now.value = new Date()), 30_000)
})
onBeforeUnmount(() => window.clearInterval(ticker))
const nowMin = computed(() => now.value.getHours() * 60 + now.value.getMinutes())

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

const todayEntries = computed(() => (campusOn.value ? campus.entriesOn(props.date) : []))
/** 正在上：start ≤ 现在 < end */
const currentEntry = computed(
  () => todayEntries.value.find((e) => toMin(e.session.startTime) <= nowMin.value && nowMin.value < toMin(e.session.endTime)) ?? null,
)
const nextEntry = computed(() => todayEntries.value.find((e) => toMin(e.session.startTime) > nowMin.value) ?? null)
/** 今天没课时，看加载窗口里的下一天 */
const nextDayEntry = computed(() => {
  if (todayEntries.value.length) return null
  return (
    [...campus.entries]
      .filter((e) => e.date > props.date)
      .sort((a, b) => (a.date === b.date ? toMin(a.session.startTime) - toMin(b.session.startTime) : a.date < b.date ? -1 : 1))[0] ?? null
  )
})

function teacherOf(courseId: number): string {
  return campus.courses.find((c) => c.id === courseId)?.teachers.join('、') ?? ''
}

const currentPct = computed(() => {
  const e = currentEntry.value
  if (!e) return 0
  const a = toMin(e.session.startTime)
  const b = toMin(e.session.endTime)
  return Math.min(100, Math.max(0, ((nowMin.value - a) / Math.max(b - a, 1)) * 100))
})

function awayFrom(entry: { date: string; session: { startTime: string; weekday: number } }): string {
  if (entry.date > props.date) {
    const wd = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][entry.session.weekday] ?? ''
    return `${wd} ${entry.session.startTime}`
  }
  const d = toMin(entry.session.startTime) - nowMin.value
  if (d <= 0) return '现在'
  const h = Math.floor(d / 60)
  return h ? `${h} 小时 ${d % 60} 分后` : `${d} 分钟后`
}

const currentLeft = computed(() => {
  const e = currentEntry.value
  if (!e) return ''
  const left = toMin(e.session.endTime) - nowMin.value
  return left > 0 ? `还剩 ${left} 分钟` : '快下了'
})

async function initCampus(): Promise<void> {
  try {
    await campus.init()
    if (campus.hasAccount) {
      const r = defaultRange(props.date)
      await campus.loadRange(r.from, r.to)
    }
  } catch (e) {
    console.warn('[home-footer] 课表读取失败', e)
  }
}

/* ---- 吃：今天记了几餐、下一餐该记什么 ---- */
const logged = computed(() => new Set(diet.grouped.filter((g) => g.logs.length > 0).map((g) => g.mealType)))
const mainMeals = MEAL_ORDER.filter((t) => t !== 'snack')
const eatValue = computed(() => `${mainMeals.filter((t) => logged.value.has(t)).length}/3 餐`)

/** 「该记哪餐」按时段猜：10 点前问早餐、15 点前问午餐、之后问晚餐 */
const expectedMeal = computed(() => {
  const h = now.value.getHours()
  if (h < 10) return 'breakfast'
  if (h < 15) return 'lunch'
  return 'dinner'
})

const lastAgoMin = computed<number | null>(() => {
  const times = diet.grouped.flatMap((g) => g.logs.map((l) => new Date(l.createdAt).getTime()))
  if (!times.length) return null
  return Math.max(0, Math.round((now.value.getTime() - Math.max(...times)) / 60000))
})

const eatNote = computed(() => {
  const parts: string[] = []
  if (!logged.value.has(expectedMeal.value)) parts.push(`${MEAL_LABELS[expectedMeal.value]}未记`)
  const ago = lastAgoMin.value
  if (ago == null) parts.push('今天还没记')
  else if (ago < 8 * 60) parts.push(ago < 60 ? `上一餐 ${ago} 分钟前` : `上一餐 ${Math.floor(ago / 60)} 小时前`)
  if (!parts.length) parts.push('三餐都记了')
  return parts.join(' · ')
})

/* ---- 练：未练优先于分低，分化定的课一步开练 ---- */
const trainOn = computed(() => features.isEnabled('sports') || features.isEnabled('program'))

const score = ref<TrainingScoreResult | null>(null)
const parsed = computed(() => {
  if (!program.active) return null
  try {
    return parseBlob(program.active)
  } catch {
    return null /* 数据损坏时练卡退化成纯入口，不阻塞主页 */
  }
})
const status = computed(() => (program.active && parsed.value ? programStatus(program.active, parsed.value) : null))
const todayCourse = computed(() => (parsed.value ? courseOnDate(parsed.value, props.date) : null))

/** 练过但练够分 < 60 的组（与弱项加练同口径），最弱的排最前 */
const weakList = computed<GroupScore[]>(() => (score.value ? weakGroups(score.value.groups) : []))

/** 本周没练但 4 周内常练 = 断练，该捡回来；从未练过的组不凑热闹 */
const lapsedIdle = computed<GroupScore[]>(() => (score.value ? lapsedIdleGroups(score.value.groups) : []))

/** 课程主攻的评估组（组内任一细肌群 3 档）—— 与 weakMuscles 的 isPrimaryFor 同口径 */
function courseGroupKeys(courseId: string): ScoreGroupKey[] {
  const exs = planStore.byId(courseId)?.exercises
  if (!exs?.length) return []
  return SCORE_GROUPS.filter((g) => exs.some((e) => g.members.some((m) => e.muscles?.[m] === 3))).map((g) => g.key)
}

function courseCovers(courseId: string, group: ScoreGroupKey): boolean {
  return courseGroupKeys(courseId).includes(group)
}

/** 练卡焦点组：现在最该练谁（未练优先于分低，优先级口径见 weakMuscles.focusGroup） */
const focus = computed<GroupScore | null>(() => {
  const gs = score.value?.groups ?? []
  if (!gs.length) return null
  const c = todayCourse.value
  return focusGroup(gs, c ? courseGroupKeys(c.courseId) : null)
})

/** 方案里主攻焦点组的那节课（「腿还没练 → 腿日」） */
const recommendedCourse = computed<{ courseId: string; courseName: string } | null>(() => {
  const f = focus.value
  const blob = parsed.value
  if (!f || !blob) return null
  const seen = new Set<string>()
  for (const d of blob.days) {
    if (!d.courseId || !d.courseName || seen.has(d.courseId)) continue
    seen.add(d.courseId)
    if (courseCovers(d.courseId, f.group)) return { courseId: d.courseId, courseName: d.courseName }
  }
  return null
})

/** 焦点组的课下一次排在哪天（分化每周一轮）——文案好说「明天腿日」 */
const nextCourseDate = computed<string | null>(() => {
  const rec = recommendedCourse.value
  const blob = parsed.value
  if (!rec || !blob) return null
  return blob.days.find((d) => d.date >= props.date && d.courseId === rec.courseId && !d.rest)?.date ?? null
})

function dayLabel(date: string): string {
  if (diffDays(props.date, date) === 1) return '明天'
  const wd = '日一二三四五六'[new Date(`${date}T00:00:00`).getDay()] ?? ''
  return wd ? `周${wd}` : date.slice(5)
}

/** 练卡的主事实：有方案 = 今天的课程（或休息 / 未开跑 / 已结束）；无方案 = 未排训练。
 *  焦点组的状态跟在值里（「拉日 · 背未练」「拉日 · 背 48」），模板里按档位着色 ——
 *  所以这里的文案不再重复分数。 */
const trainMain = computed(() => {
  if (!program.active) return '未排训练'
  if (status.value?.upcoming) return '未开跑'
  if (status.value?.ended) return '已结束'
  return todayCourse.value?.courseName ?? '休息'
})

const trainNote = computed(() => {
  const f = focus.value
  if (status.value?.upcoming) {
    const first = status.value.startDate && parsed.value ? courseOnDate(parsed.value, status.value.startDate) : null
    return `${status.value.startDate.slice(5)} 开跑${first ? ` · 首日 ${first.courseName}` : ''}`
  }
  if (status.value?.ended) return '本期已结束 · 去生成成绩单'
  if (!program.active) {
    if (f?.idle) return `${f.label}本周还没练 · 加练一次补上`
    if (f) return `本周${f.label}练得不够 · 排一份方案跟着练`
    return '排一份健康方案 · 训练跟着日程走'
  }
  const c = todayCourse.value
  if (!c) {
    const rec = recommendedCourse.value
    if (f?.idle && rec) {
      const day = nextCourseDate.value
      return day
        ? `${f.label}还没练 · ${dayLabel(day)}「${rec.courseName}」正好补上`
        : `${f.label}还没练 · 排「${rec.courseName}」正好补上`
    }
    if (f?.idle) return `${f.label}还没练 · 想练就来一次加练`
    if (f && rec) return `建议排「${rec.courseName}」· 想练就来一次加练`
    return f ? '今天不排训练 · 想练就来一次加练' : '今天不排训练 · 想动就去运动页'
  }
  const n = planStore.byId(c.courseId)?.exercises.length
  const suffix = `${n ?? '—'} 个动作 · 约 ${c.durationMin} 分钟`
  if (f && courseCovers(c.courseId, f.group)) {
    return f.idle ? `正好补上未练的${f.label} · ${suffix}` : `正好补它 · ${suffix}`
  }
  return suffix
})

/* ---- 立刻练：卡上一步开练，不让用户去训练页翻 ---- */
const session = useSessionStore()
const startBusy = ref(false)
const conflictOpen = ref(false)
const catchupOpen = ref(false)

/** 开练目标：今天的课优先；休息日排一节能补上焦点组的课；都没有就落到弱项加练 */
const startPlan = computed<WorkoutPlanRecord | null>(() => {
  const c = todayCourse.value
  if (c) return planStore.byId(c.courseId) ?? null
  const rec = recommendedCourse.value
  return rec ? (planStore.byId(rec.courseId) ?? null) : null
})

const startReady = computed(() => startPlan.value != null || focus.value != null)

const startLabel = computed(() => {
  const p = startPlan.value
  return p ? `立刻开练「${p.name}」` : '开练弱项加练'
})

/** 弱项加练的候选：断练未练的组在前，弱项随后（从未练过的不进加练） */
const catchupWeak = computed<GroupScore[]>(() => [...lapsedIdle.value, ...weakList.value])

async function startNow(e: MouseEvent): Promise<void> {
  if (startBusy.value) return
  const plan = startPlan.value
  if (!plan) {
    catchupOpen.value = true /* 没有现成的课 → 组一节临时加练课 */
    return
  }
  const origin = e.currentTarget as HTMLElement | null /* await 后 currentTarget 已置 null，同步先抓 */
  startBusy.value = true
  try {
    const r = await session.start(plan)
    if (r === 'conflict') {
      conflictOpen.value = true
      return
    }
    openImmersive(origin)
  } finally {
    startBusy.value = false
  }
}

function goConflict(): void {
  conflictOpen.value = false
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive()
}

/* ---- 专注 / 钱 ---- */
const focusTool = computed(() => toolById('focus.open'))
const moneyTool = computed(() => toolById('ledger.open'))

const doneSessions = computed(() => pomo.todaySessions.filter((s) => s.completed))
const focusMin = computed(() => doneSessions.value.reduce((s, x) => s + x.focusMin, 0))
const openTodos = computed(() => todo.allTodos.filter((t) => t.date === props.date && t.status !== 'done').length)

const moneyValue = computed(() => `¥${fmtCents(ledger.monthExpenseCents)}`)
const moneyNote = computed(() => {
  const today = ledger.monthEntries
    .filter((e) => e.date === props.date && e.kind === 'expense')
    .reduce((s, e) => s + e.amountCents, 0)
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  const pct = budget > 0 ? ` · 预算用了 ${Math.round((ledger.monthExpenseCents / budget) * 100)}%` : ''
  return `今天 ¥${fmtCents(today)}${pct}`
})

/* ---- 数据装载 ---- */
async function loadScore(): Promise<void> {
  if (!trainOn.value) return
  try {
    await lib.ensureLoaded()
    await nutrition.loadProfile()
    const sets = await sessionService.strengthRecentSets(42)
    if (sets.length) {
      score.value = computeTrainingScore({
        sets,
        library: lib.list,
        today: todayStr(),
        goal: nutrition.profile?.goal ?? null,
      })
    }
  } catch (e) {
    console.warn('[home-footer] 练够分统计失败', e)
  }
  if (features.isEnabled('program')) void planStore.ensureLoaded()
}

onMounted(() => {
  void diet.load(props.date)
  void todo.loadAll()
  if (features.isEnabled('focus')) void pomo.loadToday()
  if (campusOn.value) void initCampus()
  void loadScore()
})
</script>

<template>
  <div class="hf">
    <!-- 课程条：只在连了教务时出现 —— 没连接就整条不渲染（课表入口由 Dock 左钮兜着），
         有账号没课才显示「最近没有课」。 -->
    <button
      v-if="campusOn && campus.hasAccount"
      type="button"
      class="hf-course pressable"
      data-testid="hf-course"
      @click="router.push({ name: 'campus-schedule' })"
    >
      <template v-if="currentEntry">
        <span class="hf-c1">
          <i class="hf-live" aria-hidden="true" />
          <b>{{ currentEntry.session.courseName }}</b>
          <span v-if="currentEntry.session.room || teacherOf(currentEntry.session.courseId)" class="hf-dim">{{ [currentEntry.session.room, teacherOf(currentEntry.session.courseId)].filter(Boolean).join(' · ') }}</span>
          <span class="hf-left">{{ currentLeft }}</span>
        </span>
        <span class="hf-bar" aria-hidden="true">
          <i :style="{ width: `${currentPct}%` }" />
          <em class="hf-from">{{ currentEntry.session.startTime }}</em>
          <em class="hf-to">{{ currentEntry.session.endTime }}</em>
        </span>
        <span v-if="nextEntry" class="hf-c2">
          <i class="hf-hollow" aria-hidden="true" />
          <span>下一节 {{ nextEntry.session.courseName }}</span>
          <span class="hf-dim">{{ nextEntry.session.room ?? '' }} · {{ nextEntry.session.startTime }}</span>
          <span class="hf-away">{{ awayFrom(nextEntry) }}</span>
        </span>
      </template>
      <template v-else-if="nextEntry">
        <span class="hf-c1">
          <i class="hf-hollow" aria-hidden="true" />
          <span class="hf-next">下一节 {{ nextEntry.session.courseName }}</span>
          <span class="hf-dim">{{ nextEntry.session.room ?? '' }} · {{ nextEntry.session.startTime }}</span>
          <span class="hf-away">{{ awayFrom(nextEntry) }}</span>
        </span>
      </template>
      <template v-else-if="nextDayEntry">
        <span class="hf-c1">
          <i class="hf-hollow" aria-hidden="true" />
          <span class="hf-next">下一节 {{ nextDayEntry.session.courseName }}</span>
          <span class="hf-dim">{{ nextDayEntry.date.slice(5) }} · {{ nextDayEntry.session.startTime }}</span>
          <span class="hf-away">{{ awayFrom(nextDayEntry) }}</span>
        </span>
      </template>
      <template v-else>
        <span class="hf-c1">
          <i class="hf-hollow" aria-hidden="true" />
          <span class="hf-next">最近没有课</span>
        </span>
      </template>
    </button>

    <!-- 吃：卡头是今天饮食的事实，卡里是这一族的全部成员（同权） -->
    <section v-if="eatMembers.length" class="hf-zone" data-testid="hf-zone-eat" style="--tint: var(--c-intake)">
      <header class="hf-z1">
        <i class="hf-zk"><Utensils :size="14" :stroke-width="2.2" />吃</i>
        <b class="hf-zv">{{ eatValue }}</b>
        <span class="hf-zn">{{ eatNote }}</span>
      </header>
      <div class="hf-members">
        <button
          v-for="m in eatMembers"
          :key="m.id"
          type="button"
          class="hf-member pressable"
          :class="{ 'is-add': m.id === 'nutrition.smart-add' }"
          :aria-label="`${m.title} · ${m.title === '记饮食' ? '拍照 / 文字 · AI 帮你记' : ''}`"
          @click="runTool(m)"
        >
          <Plus v-if="m.id === 'nutrition.smart-add'" :size="13" :stroke-width="2.8" />
          <component :is="m.icon" v-else :size="13" :stroke-width="2.2" />
          {{ m.title }}
        </button>
      </div>
    </section>

    <!-- 练：未练优先于分低，分化定的课一步开练 -->
    <section v-if="trainMembers.length" class="hf-zone" data-testid="hf-zone-train" style="--tint: var(--accent)">
      <header class="hf-z1">
        <i class="hf-zk"><Dumbbell :size="14" :stroke-width="2.2" />练</i>
        <!-- 得分状态点：五档与肌肉热力图同一份颜色（MuscleMap 图例），未练=灰档、颜色粗分 -->
        <i v-if="focus" class="hf-heat" :class="`hs${focus.level}`" aria-hidden="true" />
        <b class="hf-zv">
          <!-- 值 = 主事实 · 焦点组状态（有方案：「拉日 · 背未练」/「拉日 · 背 48」；无方案：焦点组就是主事实） -->
          <template v-if="program.active && focus">
            {{ trainMain }}<span class="hf-zsep">·</span>{{ focus.label }}
            <span v-if="focus.idle" class="hf-idle">未练</span>
            <span v-else class="hf-score" :class="`hs${focus.level}`">{{ focus.score }}</span>
          </template>
          <template v-else-if="focus">
            {{ focus.label }}
            <span v-if="focus.idle" class="hf-idle">未练</span>
            <template v-else>
              <span class="hf-score" :class="`hs${focus.level}`">{{ focus.score }}</span> 分
            </template>
          </template>
          <template v-else>{{ trainMain }}</template>
        </b>
        <span class="hf-zn">{{ trainNote }}</span>
      </header>
      <div class="hf-members">
        <!-- 立刻练：今天的课 / 能补上未练的那节课 / 弱项加练 —— 卡上唯一的实底动作 -->
        <button
          v-if="startReady"
          type="button"
          class="hf-member is-start pressable"
          data-testid="hf-start"
          :aria-label="startLabel"
          :disabled="startBusy"
          @click="startNow"
        >
          <Play :size="13" :stroke-width="2.6" />立刻练
        </button>
        <button
          v-for="m in trainMembers"
          :key="m.id"
          type="button"
          class="hf-member pressable"
          :class="{ 'is-add': m.id === 'sports.log' }"
          :aria-label="m.title"
          @click="runTool(m)"
        >
          <Plus v-if="m.id === 'sports.log'" :size="13" :stroke-width="2.8" />
          <component :is="m.icon" v-else :size="13" :stroke-width="2.2" />
          {{ m.title }}
        </button>
      </div>
    </section>

    <!-- 两格状态：一个数 + 一句事实 -->
    <div v-if="focusTool || moneyTool" class="hf-grid">
      <button
        v-if="focusTool"
        type="button"
        class="hf-fact pressable"
        data-testid="hf-fact-focus"
        style="--tint: var(--cat-work)"
        @click="runTool(focusTool)"
      >
        <span class="hf-f1">
          <i class="hf-fk"><Timer :size="13" />专注</i>
          <b class="hf-fv">{{ focusMin }}<em>分钟</em></b>
        </span>
        <span class="hf-fn">{{ focusMin > 0 ? `${doneSessions.length} 段番茄 · ${openTodos} 条待办` : `今天还没专注 · ${openTodos} 条待办` }}</span>
      </button>

      <button
        v-if="moneyTool"
        type="button"
        class="hf-fact pressable"
        data-testid="hf-fact-money"
        style="--tint: var(--ok-strong)"
        @click="runTool(moneyTool)"
      >
        <span class="hf-f1">
          <i class="hf-fk"><Wallet :size="13" />钱</i>
          <b class="hf-fv">{{ moneyValue }}<em>本月</em></b>
        </span>
        <span class="hf-fn">{{ moneyNote }}</span>
      </button>
    </div>

    <!-- 工具行：录音纪要 / AI 助手，以及未来插件的落点 -->
    <div v-if="rowTools.length" class="hf-tools" data-testid="hf-tools">
      <button v-for="t in rowTools" :key="t.id" type="button" class="hf-chip pressable" :aria-label="t.title" @click="runTool(t)">
        <component :is="t.icon" :size="13" :stroke-width="2.2" />{{ t.title }}
      </button>
    </div>

    <!-- 弹层（Teleport 到 body；原来挂 HomePage，跟着动作一起迁过来） -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="props.date" @close="quickOpen = false" />
    <AddWorkoutSheet :open="workoutOpen" @close="workoutOpen = false" />
    <DietHistorySheet :open="historyOpen" @close="historyOpen = false" />
    <!-- 立刻练没有现成的课可开时，落到弱项加练（断练未练的组也进候选） -->
    <MuscleCatchupSheet :open="catchupOpen" :weak="catchupWeak" @close="catchupOpen = false" />
    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="goConflict"
      @close="conflictOpen = false"
    />
  </div>
</template>

<style scoped>
/* 与现状同一套土壤：卡片铺在页面底色上、14px 网格；这里不包一张大卡 */
.hf {
  position: relative;
  /* 与上方主页画布卡的 14px：全站卡间距靠 `.card + .card` 相邻选择器，
     这里隔着这层包装够不到，得自己给 —— 漏了就是两张圆角卡贴死（2026-10-04 用户实测抓到） */
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--text-1);
  font-size: var(--fs-caption);
}

.hf :where(button) {
  border: 0;
  margin: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}

/* ---------- 课程条 ---------- */
.hf-course {
  display: block;
  width: 100%;
  padding: 12px 16px 11px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.hf-c1,
.hf-c2 {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.hf-c1 b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.hf-next {
  font-size: var(--fs-caption);
  font-weight: 600;
}

.hf-live {
  width: 7px;
  height: 7px;
  flex: none;
  align-self: center;
  border-radius: var(--radius-full);
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}

.hf-hollow {
  width: 7px;
  height: 7px;
  flex: none;
  align-self: center;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--line-strong);
}

.hf-dim {
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hf-left {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--danger-strong);
  font-variant-numeric: tabular-nums;
}

.hf-away {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.hf-bar {
  position: relative;
  display: block;
  height: 4px;
  margin: 8px 0 9px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--text-1) 12%, transparent);
}

.hf-bar i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--radius-full);
  background: var(--danger);
}

.hf-bar em {
  position: absolute;
  top: -2px;
  font-style: normal;
  font-size: 10px;
  line-height: 8px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.hf-from {
  left: 0;
}

.hf-to {
  right: 0;
}

/* ---------- 记录域（吃 / 练） ---------- */
.hf-zone {
  padding: 11px 14px 12px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.hf-z1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.hf-zk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 700;
}

.hf-zk svg {
  color: var(--tint);
}

.hf-zv {
  font-size: var(--fs-title3);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

/* 主事实与弱项分数之间的那枚点：小一号、退一档灰，别跟数字抢 */
.hf-zsep {
  margin: 0 4px;
  font-size: var(--fs-footnote);
  font-weight: 500;
  color: var(--text-3);
}

/* 「未练」没有分数可给 —— 一枚中性小字即可，灰点（hs0）已经表过态 */
.hf-idle {
  margin-left: 1px;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
}

.hf-zn {
  margin-left: auto;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 练够分状态色：点用肌肉热力图的原色（图例同源），文字取白底可读的 strong/deep 档。
   两套不能混用 —— --danger 压白底只有 3.55:1，--c-exercise 更是只有 1.6:1，
   只能当色块；文字一律走 --danger-strong / --warn-strong / --c-exercise-deep。 */
.hf-heat {
  width: 7px;
  height: 7px;
  flex: none;
  align-self: center;
  border-radius: var(--radius-full);
}

.hf-heat.hs0 {
  background: var(--text-3);
}

.hf-heat.hs1 {
  background: var(--danger);
}

.hf-heat.hs2 {
  background: var(--warn);
}

.hf-heat.hs3 {
  background: var(--heat-mid);
}

.hf-heat.hs4 {
  background: var(--c-exercise);
}

.hf-score.hs1 {
  color: var(--danger-strong);
}

.hf-score.hs2 {
  color: var(--warn-strong);
}

.hf-score.hs3,
.hf-score.hs4 {
  color: var(--c-exercise-deep);
}

/* 成员：同一种胶囊、同一个尺寸 —— 不做「一个主按钮 + 几个小链接」的层级 */
.hf-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}

.hf-member {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.hf-member svg {
  color: var(--text-3);
}

/* 记饮食 / 记运动：只比同族多一层色相，不放大 */
.hf-member.is-add {
  background: color-mix(in srgb, var(--tint) 14%, transparent);
  color: var(--text-1);
}

.hf-member.is-add svg {
  color: var(--tint);
}

/* 立刻练：卡上唯一的实底动作（成员仍走同一种胶囊的约定只约束成员之间 ——
   它不是「成员」，是这张卡的动作本身）。形变锚点在按钮上，沉浸层从这长出来。 */
.hf-member.is-start {
  background: var(--accent);
  color: var(--on-accent);
}

.hf-member.is-start svg {
  color: var(--on-accent);
}

.hf-member.is-start:disabled {
  opacity: 0.45;
}

/* ---------- 状态格 ---------- */
.hf-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.hf-fact {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 11px 14px 12px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.hf-f1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.hf-fk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
}

.hf-fk svg {
  color: var(--tint);
}

.hf-fv {
  margin-left: auto;
  font-size: var(--fs-title3);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.hf-fv em {
  margin-left: 2px;
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

.hf-fn {
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 工具行 ---------- */
.hf-tools {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.hf-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.hf-chip svg {
  color: var(--text-3);
}

/* 高画质及以上：这排跟着升成玻璃材质。落影取 --glass-panel-shadow（= --shadow-card）而
   不是 --glass-shadow —— 在流的内容面用前者、浮层才用后者（base.css 那两组注释的约定）。

   **不要写 `:global(html[…])`**：scoped 编译器只认「整条选择器都包在 :global() 里」这一种
   用法，`:global(甲) 乙 丙` 会被它截成 `甲` 一条 —— 这条规则 2026-10-04 就是这么变成了
   挂在 <html> 上的 `background: var(--glass-panel-fill)`（整页被压一层半透明白，
   footer 这两枚 chip 反倒没拿到材质）。前缀交给编译器自己加：它只给末段挂 data-v。 */
html[data-perf]:not([data-perf='low']) .hf-tools .hf-chip {
  background: var(--glass-panel-fill);
  box-shadow: var(--glass-panel-shadow), var(--glass-insets);
}
</style>
