<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, ClockPlus, Coffee, Ellipsis, Gauge, Info, PlusCircle, RotateCcw, SkipForward, Timer } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import RingProgress from '@/components/common/RingProgress.vue'
// 这两块按需加载：肌群图本体是 160 KB 的解剖 SVG（三个视图 raw 内联）＋ 一处
// 只在点开动作详情时才出现的抽屉。它们是沉浸层**内部**的详情块，用户不开到那一屏
// 就用不到 —— 而沉浸层挂在 App 根上，静态 import 等于让每个路由都背着这 160 KB 首屏。
// 沉浸层自身的显隐与形变动画不受影响：这两个组件都渲染在 v-if 分支里。
const ExerciseDetailDrawer = defineAsyncComponent(
  () => import('@/components/exercise/ExerciseDetailDrawer.vue'),
)
const MuscleMap = defineAsyncComponent(() => import('@/components/exercise/MuscleMap.vue'))
import SessionBigNumberInput from '@/components/exercise/SessionBigNumberInput.vue'
import SessionCourseDrawer from '@/components/exercise/SessionCourseDrawer.vue'
import SessionGlassButton from '@/components/exercise/SessionGlassButton.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { useSessionStore } from '@/stores/session'
import { usePressGlow } from '@/composables/usePressGlow'
import { useScrolled } from '@/composables/useScrolled'
import { motionOn } from '@/system/motion'
import { perfDegraded } from '@/system/perf'
import { workoutRuntime } from '@/system/workoutRuntime'
import { useToast } from '@/composables/useToast'
import {
  closeImmersive,
  closeImmersiveNow,
  immersiveClosing,
  immersiveOpen,
  immersiveOpenSeq,
  immersiveOriginSnapshot,
  measureOriginNow,
  settleClosed,
  type ImmersiveOriginSnapshot,
} from '@/system/sessionImmersive'

/**
 * 运动模式 · 训练课沉浸层（底部坞 × 组格矩阵）：覆盖整个窗口（含底部导航栏）。
 * 不再走路由：App.vue 常驻挂载本组件，由 system/sessionImmersive 驱动显隐——
 * 收起 / 恢复不触发整页卸载重建，与悬浮运动条之间做 container transform
 * 连续形变（从浮窗当前 rect 生长到全屏，任意吸附位同理）。
 * 结构：顶栏 → 全课分格进度条（每格一组，按动作分组留缝）→ 可滚动内容区
 * （动作名 hero ＋ 重量输入 ＋ 次数输入 ＋ 动作要点 ＋ 接下来）→ 常驻底部操作坞
 * （组格即完成控件；热身态为小重量激活格；休息态为时长抽屉图标＋跳过）。
 * 坞内「更多」菜单提供跳过当前组 / 临时休息 / 再加一组 / 上一组 / 当前动作详解。
 * 顶部组数胶囊（带 ›）唤起全课浏览抽屉：逐动作逐组浏览、跳至某组、临时更换未做的动作。
 * 重量 / 次数登记：数字可点，就地变成输入框用输入法键入；也可用 ± 步进微调。
 * 正式组与激活热身组都支持现场调整，完成组即落当前值，结束保存后展开为逐组记录
 * （重量曲线数据源）。只有「结束 → 二级确认」才结束会话。
 */
const s = useSessionStore()
const lib = useExerciseLibStore()
const router = useRouter()
const { toast } = useToast()

const endOpen = ref(false)
const restSheetOpen = ref(false)
const moreOpen = ref(false)
const detailOpen = ref(false)
const courseOpen = ref(false)

/** bind 菜单锚定元素：坞内触发各菜单的图标钮；临时休息从更多菜单二级唤起，沿用更多钮位置 */
const moreAnchor = ref<HTMLElement | null>(null)
const restAnchor = ref<HTMLElement | null>(null)

function openMore(e: MouseEvent): void {
  moreAnchor.value = (e.currentTarget as HTMLElement) ?? null
  moreOpen.value = true
}

function openRestAdd(e: MouseEvent): void {
  restAnchor.value = (e.currentTarget as HTMLElement) ?? null
  restSheetOpen.value = true
}

/** 重量显示：整数不带小数，62.5 保留一位 */
function fmtKg(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 上次做组参照（渐进超负荷对照，按动作库 id 取） */
const lastRef = computed(() => s.lastWeights[s.currentEx?.exerciseId ?? ''])

/** 今日建议：平均状态（近 3 次 e1RM 加权）× 今日状态（恢复/容量/趋势/自评） */
const curAdvice = computed(() => (s.currentEx ? s.adviceFor(s.currentEx) : null))

/** 建议依据默认收起，点一下展开（训练中不打扰，但随时可查） */
const whyOpen = ref(false)

/** 展开后逐条列出的部分：首条已经当摘要行显示了，展开时不再重复它 */
const whyRest = computed(() => (curAdvice.value?.rationale ?? []).slice(1))

/** 展示名：库内名优先（动作库改名全端跟随），回落课程条目快照 */
const displayName = computed(() => (s.currentEx ? lib.resolveName(s.currentEx) : ''))

/** 动作要点：课程条目优先，缺失回落库内要点 */
const exTips = computed(() => (s.currentEx ? lib.tipsOf(s.currentEx) : ''))

const WEIGHT_STEP = 2.5

/** 当前待做的激活热身组定义（热身页据此预填并展示建议值） */
const curWarmup = computed(() => {
  const ex = s.currentEx
  if (!ex?.warmups?.length) return null
  return ex.warmups[Math.min(s.warmupDone(ex), ex.warmups.length - 1)] ?? null
})

/** 今日状态自评档位（短文案版；更多菜单里的 READINESS_ACTIONS 是同一套档位的长文案版） */
const READINESS_CHIPS = [
  { value: 5, label: '很好' },
  { value: 4, label: '不错' },
  { value: 3, label: '一般' },
  { value: 2, label: '疲惫' },
  { value: 1, label: '很差' },
] as const

/** 一键填入的重量候选：同一个重量的三个出处（今日建议 / 上次 / 计划），点一下即填入 */
interface FillSource {
  key: string
  caption: string
  value: string
  weight: number
  /** 主推来源（今日建议 / 热身处方）：在候选里抬起来，其余为备选参照 */
  recommended: boolean
}

const fillSources = computed<FillSource[]>(() => {
  const ex = s.currentEx
  if (!ex) return []
  // 热身页给的是这一组的激活重量处方，只有一个出处
  if (s.phase === 'warmup') {
    const w = curWarmup.value
    if (!w) return []
    return [{ key: 'warmup', caption: '热身组', value: `${fmtKg(w.weightKg)} kg × ${w.reps}`, weight: w.weightKg, recommended: true }]
  }
  const list: FillSource[] = []
  const advised = curAdvice.value?.suggestedWeight
  if (advised != null) {
    list.push({ key: 'advice', caption: '建议', value: `${fmtKg(advised)} kg`, weight: advised, recommended: true })
  }
  const last = lastRef.value
  if (last) {
    list.push({
      key: 'last',
      caption: '上次',
      value: last.reps != null ? `${fmtKg(last.weightKg)} kg × ${last.reps}` : `${fmtKg(last.weightKg)} kg`,
      weight: last.weightKg,
      recommended: false,
    })
  }
  if (ex.weightKg != null) {
    list.push({ key: 'plan', caption: '计划', value: `${fmtKg(ex.weightKg)} kg`, weight: ex.weightKg, recommended: false })
  }
  return list
})

/**
 * 重量回写：一律走 store action（直接改 s.weight 不会 touch()，快照不落盘）。
 * 输入框清空时组件给 null，此时保留原值，不让重量凭空变 0。
 */
function onWeight(v: number | null): void {
  if (v != null) s.setWeight(v)
}

/** 次数回写：清空表示「该动作没配次数」，允许置空由用户自行键入 */
function onReps(v: number | null): void {
  s.setReps(v)
}

/** 打开即接管：等运动系统运行时的启动接管完成，再从服务端恢复会话。
 *  已激活（收起后再展开）则原样展示；服务端也没有进行中的训练课 →
 *  原地关层（页面路由从未变化），跑步会话转去跑步路由。 */
watch(
  immersiveOpenSeq,
  async () => {
    await workoutRuntime.whenReady()
    if (s.phase !== 'idle') return
    const ok = await s.hydrateFromServer()
    if (!ok && s.phase === 'idle') {
      closeImmersiveNow()
      if (s.foreignRoute) void router.push(s.foreignRoute)
    }
  },
  { flush: 'post' },
)

/* ---------- 全课进度格条 ---------- */

/**
 * 顶栏占位高度：内容区据此留出顶部内边距。
 * 常量与 .ctrl-top 的版式一一对应（一行胶囊 --cap-h ＋ 上缘偏移 10 ＋ 下缘留白 16），
 * 两侧引用同一组数值，改版式时不会只剩一边更新。
 *
 * 进度轨退场后这条占位从 94 降到 62：从前栏里是「32 控件行 ＋ 24 进度轨」两行，
 * 现在只有一行胶囊 —— 内容区凭空多出的 32px 就是这次顶栏改版的直接收益之一。
 */
const TOP_OFFSET = 10
const CAP_H = 36
const TOP_GAP = 16

const topHeight = computed(() => TOP_OFFSET + CAP_H + TOP_GAP)

/**
 * 同步失败警示的高度（没有警示时为 0）：顶簇是绝对定位的，得知道这一段被警示占了
 * 多高才能整块下移、不被它盖住。**必须量而不是写死**：那条信息里嵌着底层错误原文，
 * 窄屏上会折成两三行，任何"一行 26px"的常量都会在真机上错位。
 * ResizeObserver 在布局后、绘制前回调，所以纠正落在**同一帧**里，看不到跳动。
 */
const warnEl = ref<HTMLElement | null>(null)
const warnH = ref(0)
let warnRO: ResizeObserver | null = null

watch(warnEl, (el) => {
  warnRO?.disconnect()
  warnRO = null
  warnH.value = el ? el.offsetHeight : 0
  if (!el) return
  warnRO = new ResizeObserver(() => {
    warnH.value = el.offsetHeight
  })
  warnRO.observe(el)
})

onBeforeUnmount(() => warnRO?.disconnect())

/* ---------- 坞与内容派生 ---------- */

const dockMode = computed<'warmup' | 'exercise' | 'rest' | 'timed-ready' | 'timed' | 'summary' | 'none'>(() => {
  if (s.phase === 'warmup' && s.currentEx) return 'warmup'
  if (s.phase === 'exercise' && s.currentEx) return 'exercise'
  if (s.phase === 'rest') return 'rest'
  if (s.phase === 'timed-ready' && s.currentEx) return 'timed-ready'
  if (s.phase === 'timed-run') return 'timed'
  if (s.phase === 'summary') return 'summary'
  return 'none'
})

/**
 * 底簇占位高度：内容区据此留出底部内边距，让内容**从玻璃下面滚过去**
 * 而不是被玻璃挡住。数值必须与 .ctrl-dock 的实际高度一致，所以两条
 * 行高写成常量，样式里也只引用这两个常量。
 */
const DOCK_ROW_H = 54
const DOCK_TRACK_H = 64
const DOCK_GAP = 12

const dockHeight = computed(() => {
  if (dockMode.value === 'warmup' || dockMode.value === 'exercise') return DOCK_TRACK_H + DOCK_GAP + DOCK_ROW_H
  if (dockMode.value === 'none') return 0
  return DOCK_ROW_H
})

/** 坞内组格的当前序号：exercise 用 setIndex；rest 中下一组 = 已完成 + 1 */
const curTile = computed(() => (s.phase === 'exercise' ? s.setIndex : s.exDoneSets.filter((d) => !d.warmup).length + 1))

/** 当前动作已完成正式组数（热身行不计入组格） */
const workingDone = computed(() => s.exDoneSets.filter((d) => !d.warmup).length)

const nextEx = computed(() => s.plan?.exercises[s.exIndex + 1] ?? null)

/** 当前动作的肌群激活表（库内显式数据优先 → 课程条目 → 按动作名关键词；均无 → 隐藏卡片） */
const activation = computed(() => (s.currentEx ? lib.musclesOf(s.currentEx) : null))

/** 下一动作的处方摘要：单位按类型取（计时只认秒、有氧认分钟；次数带脏值时也不能顶掉秒） */
const nextExDesc = computed(() => {
  const n = nextEx.value
  if (!n) return ''
  const per =
    n.kind === 'timed'
      ? n.targetSec != null
        ? `${n.targetSec} 秒`
        : ''
      : n.kind === 'cardio'
        ? n.durationMin != null
          ? `${n.durationMin} 分钟`
          : ''
        : n.reps != null
          ? `${n.reps} 次`
          : ''
  return `${s.effSets(n)} 组${per ? ` · ${per}` : ''}`
})

const nextExName = computed(() => (nextEx.value ? lib.resolveName(nextEx.value) : ''))

const restMetaText = computed(() => {
  if (s.restWarmup) return '激活热身组间 · 准备下一次小重量激活'
  if (s.restIsTemp) return '临时休息 · 结束后继续当前训练'
    if (s.restTargetIsNextSet) {
      const parts = [`下一组 · 第 ${s.setIndex + 1} 组`]
      if (s.reps != null) parts.push(`${s.reps} 次`)
      if (s.weight > 0) parts.push(`${fmtKg(s.weight)} kg`)
      return parts.join(' · ')
    }
  return `下一个 · ${nextExName.value}`
})

const restSheetTitle = computed(() => `还要休息多久？剩余 ${s.restLeft} 秒`)

const REST_ADD_ACTIONS: MenuItem[] = [
  { label: '+ 15 秒', value: '15', icon: ClockPlus },
  { label: '+ 30 秒', value: '30', icon: ClockPlus },
  { label: '+ 60 秒', value: '60', icon: ClockPlus },
  { label: '+ 2 分钟', value: '120', icon: ClockPlus },
]

/* ---------- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 ---------- */

const MORE_TITLE = computed(() => `更多 · ${displayName.value || '训练中'}`)

/** 跳过当前组只在真正「手上有一组」的阶段出现：热身态有专门的跳过热身，休息态当前组已经做完了 */
const CAN_SKIP_PHASES = ['exercise', 'timed-ready', 'timed-run'] as const

const MORE_ACTIONS = computed<MenuItem[]>(() => {
  const list: MenuItem[] = []
  if (CAN_SKIP_PHASES.includes(s.phase as (typeof CAN_SKIP_PHASES)[number])) {
    list.push({ label: '跳过当前组', value: 'skip-set', icon: SkipForward })
  }
  list.push(
    // 临时休息：层叠二级菜单直接选时长；仅做组/计时阶段可用（热身、休息中置灰）
    { label: '临时休息', value: 'temp-rest', icon: Coffee, disabled: !CAN_SKIP_PHASES.includes(s.phase as (typeof CAN_SKIP_PHASES)[number]), children: TEMP_REST_ACTIONS },
    { label: '再加一组', value: 'extra-set', icon: PlusCircle },
    { label: '上一组（重做）', value: 'redo-last', icon: RotateCcw },
    { label: '今日状态', value: 'readiness', icon: Gauge, children: READINESS_ACTIONS },
    { label: '当前动作详解', value: 'detail', icon: Info },
  )
  return list
})

/** 今日状态自评档位（写进快照，建议引擎据此修正今日处方） */
const READINESS_ACTIONS: MenuItem[] = [
  { label: '很好 · 精力充沛', value: '5', icon: Gauge },
  { label: '不错 · 状态在线', value: '4', icon: Gauge },
  { label: '一般 · 正常', value: '3', icon: Gauge },
  { label: '疲惫 · 有点顶', value: '2', icon: Gauge },
  { label: '很差 · 硬撑', value: '1', icon: Gauge },
  { label: '清除自评（纯自动推断）', value: 'clear', icon: Gauge },
]

/** 首次进入力量训练时的一次性自评入口（跳过即纯自动推断） */
const showReadinessPrompt = computed(
  () =>
    s.readiness === null &&
    !!s.currentEx &&
    s.currentEx.kind === 'strength' &&
    (s.phase === 'exercise' || s.phase === 'warmup') &&
    s.doneCount === 0,
)

/** 临时休息时长：作为更多菜单「临时休息」的层叠子菜单 */
const TEMP_REST_ACTIONS: MenuItem[] = [
  { label: '1 分钟', value: '1', icon: Timer },
  { label: '2 分钟', value: '2', icon: Timer },
  { label: '3 分钟', value: '3', icon: Timer },
  { label: '5 分钟', value: '5', icon: Timer },
  { label: '10 分钟', value: '10', icon: Timer },
]

/** 详解抽屉用的动作：组数展示为「计划 + 加练」后的实际值 */
const detailExercise = computed(() => {
  const e = s.currentEx
  return e ? { ...e, sets: s.effSets(e) } : null
})

function onMorePick(value: string): void {
  if (value === 'skip-set') {
    // 跳过 = 未做 = 不统计：只推进流程，不写 doneSets
    if (s.skipCurrentSet()) toast('已跳过当前组 · 不计入统计')
    else toast('当前没有可跳过的组')
  } else if (value === 'extra-set') {
    const ex = s.currentEx
    if (!ex) return
    s.addExtraSet()
    toast(`已加练 1 组 · 「${ex.name}」共 ${s.effSets(ex)} 组`)
  } else if (value === 'redo-last') {
    if (!s.redoLastSet()) toast('还没有已完成的组')
  } else if (value === 'clear') {
    s.setReadiness(null)
    toast('已清除自评 · 建议按训练历史自动推断')
  } else if (value === '5' || value === '4' || value === '3' || value === '2' || value === '1') {
    s.setReadiness(Number(value))
    toast('已记录今日状态 · 建议重量已同步调整')
  } else if (value === 'detail') {
    detailOpen.value = true
  } else {
    // 临时休息子菜单：直接给分钟数
    const min = Number(value)
    if (Number.isFinite(min) && min > 0 && s.startTempRest(min)) toast(`临时休息 ${min} 分钟`)
  }
}

const restProgress = computed(() =>
  s.restTotal <= 0 ? 0 : Math.min(s.restLeft / s.restTotal, 1),
)

const timedText = computed(() => {
  const t = Math.floor(s.timedElapsed)
  const d = Math.floor((s.timedElapsed * 10) % 10)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.${d}`
})

const timedTargetText = computed(() => {
  const t = s.timedTotal
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
})

const timedProgress = computed(() =>
  s.timedTotal <= 0 ? 0 : Math.min(s.timedElapsed / s.timedTotal, 1),
)

/* ---------- 动作 ---------- */

function minimize(): void {
  // 播形变动画收回到悬浮条当前位置；页面路由不再变化（沉浸层与路由已解耦）
  closeImmersive()
}

function onEndPick(value: string): void {
  endOpen.value = false
  if (value === 'save') {
    void saveNow()
  } else if (value === 'discard') {
    void s.discard().then(() => {
      toast('已放弃本次训练')
      closeImmersiveNow()
    })
  }
}

function onRestAdd(value: string): void {
  s.addRest(Number(value))
}

async function saveNow(): Promise<void> {
  const r = await s.finishAndSave()
  if (r) toast(`已保存 ${r.done} 组 · 约 ${r.durationMin} 分钟 · ${r.kcal} 大卡`)
  // 会话已关闭、悬浮条随之消失：直接关层，不做形变动画
  closeImmersiveNow()
}

/* ---------- container transform：悬浮条 ⇄ 全屏形变 ---------- */

const layerEl = ref<HTMLElement | null>(null)
const fadeEl = ref<HTMLElement | null>(null)

/* 丰富档的按压定向光晕：跟随手指位置的那一路反馈（另一路 scale 挤压各控件自带）。
   事件走整层委托，:active 决定亮不亮 —— 即时反馈等不得一个事件回调。 */
usePressGlow(layerEl, '.glow-layer')

/* 滚动边缘（丰富档）：内容滚离顶部即置位，CSS 据此浮起底坞的暗带 */
const scrollEl = ref<HTMLElement | null>(null)
const bodyScrolled = useScrolled(scrollEl)

const EXPAND_MS = 480
const COLLAPSE_MS = 400
const EXPAND_MS_LOW = 360
const COLLAPSE_MS_LOW = 300

/** 形变锚点：无浮窗几何（课程页直接开课等）时兜底为屏幕中央卡片 */
function anchorFrom(s: ImmersiveOriginSnapshot | null): { rect: DOMRect; radius: number } {
  if (s) return s
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(300, vw * 0.6)
  return {
    rect: new DOMRect((vw - w) / 2, (vh - 120) / 2, w, 120),
    radius: 28,
  }
}

/* 形变走自管 rAF 逐帧插值（与 useDragDock 弹簧同模式），不用 WAAPI：
   平移与缩放必须各自线性插值，锚点才会匀速滑向悬浮条；WAAPI 对
   matrix/函数列表的插值策略不可控（矩阵分解会让块中途原地收缩）。
   cur 是当前形变态的唯一真源，打断即从现值继续，天然可反转。 */
interface MorphState {
  sx: number
  sy: number
  tx: number
  ty: number
  r: number
  fade: number
}

const IDENTITY = (): MorphState => ({ sx: 1, sy: 1, tx: 0, ty: 0, r: 0, fade: 1 })

let cur: MorphState = IDENTITY()
let morphRaf = 0
let morphFrom: MorphState | null = null
let morphTo: MorphState | null = null
let morphT0 = 0
let morphDur = 0
let morphDone: (() => void) | null = null

/** M3 emphasized 近似：起始快、收尾缓。二分求解 cubic-bezier 的进度映射 */
const easeAt = ((): ((x: number) => number) => {
  const X1 = 0.32
  const Y1 = 0.72
  const X2 = 0
  const Y2 = 1
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * X1 + 3 * (1 - t) * t * t * X2 + t ** 3
  const by = (t: number) => 3 * (1 - t) ** 2 * t * Y1 + 3 * (1 - t) * t * t * Y2 + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 12; i++) {
      const t = (lo + hi) / 2
      if (bx(t) < x) lo = t
      else hi = t
    }
    return by((lo + hi) / 2)
  }
})()

function writeMorph(m: MorphState): void {
  const el = layerEl.value
  const fade = fadeEl.value
  if (!el || !fade) return
  cur = m
  if (m.sx === 1 && m.sy === 1 && m.tx === 0 && m.ty === 0 && m.r === 0) {
    el.style.transform = ''
    el.style.borderRadius = ''
  } else {
    el.style.transform = `translate3d(${m.tx}px, ${m.ty}px, 0) scale(${m.sx}, ${m.sy})`
  }
  fade.style.opacity = String(m.fade)
  fade.style.visibility = m.fade <= 0.001 ? 'hidden' : 'visible'
}

function stopMorph(): void {
  if (morphRaf) cancelAnimationFrame(morphRaf)
  morphRaf = 0
  morphFrom = null
  morphTo = null
  morphDone = null
  // 无论正常收尾还是中途打断，都恢复毛玻璃材质
  const layer = layerEl.value
  layer?.classList.remove('is-morphing')
  if (layer) layer.style.borderRadius = ''
}

/* ---- 形变调试日志（默认静默）：控制台执行
   localStorage.setItem('reinMorphDebug','1') 后刷新/下一次开合生效，
   输出锚点取值、优先级决策与形变首末帧的屏幕坐标，真机远程调试可读；
   关闭：localStorage.removeItem('reinMorphDebug') ---- */
let morphDebugOn = false
let morphFrameLogged = false
function debugMorph(label: string, data: Record<string, unknown>): void {
  if (!morphDebugOn) return
  const rect = (el: Element | null | undefined) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: +b.left.toFixed(1), y: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }
  }
  console.warn(`[morph] ${label}`, JSON.stringify({ ...data, layer: rect(layerEl.value), dockPos: rect(document.querySelector('.dock-pos')) }))
}

function stepMorph(now: number): void {
  if (!morphFrom || !morphTo) return
  const p = easeAt(Math.min(1, (now - morphT0) / morphDur))
  const lp = (a: number, b: number) => a + (b - a) * p
  // 收起方向的内容淡出走前段加速的独立进度：壳还在收缩早期就把内容
  // 淡干净，避免「微缩快照」残影；展开方向保持全程淡入（壳先长内容后现）
  const pf = morphTo.fade < morphFrom.fade ? Math.min(1, p * 2.5) : p
  const lpf = (a: number, b: number) => a + (b - a) * pf
  writeMorph({
    sx: lp(morphFrom.sx, morphTo.sx),
    sy: lp(morphFrom.sy, morphTo.sy),
    tx: lp(morphFrom.tx, morphTo.tx),
    ty: lp(morphFrom.ty, morphTo.ty),
    r: morphFrom.r,
    fade: lpf(morphFrom.fade, morphTo.fade),
  })
  const contentThreshold = morphTo.fade > morphFrom.fade ? (perfDegraded.value ? 0.9 : 0.95) : 2
  fadeEl.value!.style.visibility = p < contentThreshold ? 'hidden' : 'visible'
  if (!morphFrameLogged) {
    morphFrameLogged = true
    debugMorph('firstFrame', { p: +p.toFixed(3), cur: { ...cur, sx: +cur.sx.toFixed(4), sy: +cur.sy.toFixed(4), tx: +cur.tx.toFixed(1), ty: +cur.ty.toFixed(1), r: +cur.r.toFixed(1), fade: +cur.fade.toFixed(3) } })
  }
  if (p >= 1) {
    debugMorph('lastFrame', { cur: { ...cur, sx: +cur.sx.toFixed(4), sy: +cur.sy.toFixed(4), tx: +cur.tx.toFixed(1), ty: +cur.ty.toFixed(1), r: +cur.r.toFixed(1) } })
    const done = morphDone
    stopMorph()
    done?.()
    return
  }
  morphRaf = requestAnimationFrame(stepMorph)
}

/** 从 from 向 to 逐帧插值；动效关掉时直接落到 to */
function morphRun(from: MorphState, to: MorphState, dur: number, done?: () => void): void {
  stopMorph()
  const brief = (m: MorphState) => ({ sx: +m.sx.toFixed(4), sy: +m.sy.toFixed(4), tx: +m.tx.toFixed(1), ty: +m.ty.toFixed(1), r: +m.r.toFixed(1), fade: +m.fade.toFixed(3) })
  debugMorph('run', { from: brief(from), to: brief(to), dur })
  if (!motionOn.value) {
    prepareMorphShell(to.r)
    writeMorph(to)
    stopMorph()
    done?.()
    return
  }
  morphFrameLogged = false
  prepareMorphShell(from.r || to.r)
  if (to.fade <= from.fade) fadeEl.value!.style.visibility = 'hidden'
  morphFrom = { ...from }
  morphTo = { ...to }
  morphT0 = performance.now()
  morphDur = dur
  morphDone = done ?? null
  morphRaf = requestAnimationFrame(stepMorph)
}

function prepareMorphShell(radius: number): void {
  const layer = layerEl.value
  if (!layer) return
  layer.classList.add('is-open', 'is-morphing')
  layer.style.borderRadius = perfDegraded.value ? '0px' : `${radius}px`
}

function playExpand(): void {
  if (!layerEl.value || !fadeEl.value) return
  morphDebugOn = !!localStorage.getItem('reinMorphDebug')
  const presetSnap = immersiveOriginSnapshot()
  prepareMorphShell(presetSnap?.radius ?? anchorFrom(presetSnap).radius)
  fadeEl.value.style.visibility = 'hidden'
  debugMorph('expand:req', {
    explicit: presetSnap?.explicit ?? false,
    snapshot: presetSnap ? { x: +presetSnap.rect.left.toFixed(1), y: +presetSnap.rect.top.toFixed(1), w: +presetSnap.rect.width.toFixed(1), h: +presetSnap.rect.height.toFixed(1), r: presetSnap.radius } : null,
  })
  if (presetSnap) {
    const preset = morphStateOf(presetSnap.rect, presetSnap.radius)
    preset.fade = 0
    writeMorph(preset)
  }
  requestAnimationFrame(() => {
    if (!immersiveOpen.value || !layerEl.value || !fadeEl.value) return
    // 锚点优先级：显式锚（开课按钮等）恒用打开时快照——浮窗在会话开始后
    // 立即出现，若被「现量浮窗」覆盖，块会从底部而非用户点击处长出；
    // 无显式锚（从浮窗打开 / 收起途中反打）才现量优先，量不到落回快照
    const snap = immersiveOriginSnapshot()
    const anchor = snap ?? measureOriginNow()
    debugMorph('expand:anchor', {
      source: anchor?.explicit ? 'snapshot(显式锚)' : anchor ? 'snapshot(打开时测量)' : 'fallback(中央兜底)',
      rect: anchor ? { x: +anchor.rect.left.toFixed(1), y: +anchor.rect.top.toFixed(1), w: +anchor.rect.width.toFixed(1), h: +anchor.rect.height.toFixed(1) } : null,
      radius: anchor?.radius ?? null,
    })
    const { rect, radius } = anchorFrom(anchor)
    // 内容与不透明底随形变淡入：形变初期只见材质壳长大，内容随后浮现
    // （形变中断后的反向展开从当前透明度接续，不闪跳）
    const from = morphStateOf(rect, radius)
    from.fade = cur.fade < 1 ? cur.fade : 0
    morphRun(from, IDENTITY(), perfDegraded.value ? EXPAND_MS_LOW : EXPAND_MS)
  })
}

/** rect + 圆角 → 形变态。scale 分母用层自身布局尺寸（inset:0 的实际
 *  渲染宽高）而非 innerWidth/innerHeight——桌面端常驻滚动条会让后者
 *  偏大，起点块随之偏窄且中心错位 */
function morphStateOf(rect: DOMRect, radius: number): MorphState {
  const el = layerEl.value!
  // 层未完成布局时（offsetWidth 为 0）回退视口尺寸，避免 scale 出 NaN
  // 导致 transform 写入被浏览器拒绝——动画整段失效、层无过渡直接出现
  const w = el.offsetWidth || window.innerWidth
  const h = el.offsetHeight || window.innerHeight
  return {
    sx: rect.width / w,
    sy: rect.height / h,
    tx: rect.left,
    ty: rect.top,
    r: radius,
    fade: cur.fade,
  }
}

function playCollapse(): void {
  if (!layerEl.value || !fadeEl.value) return
  // closing 驱动的浮窗 v-show 可能晚一拍才 patch 生效：先等一帧再量锚点，
  // 否则量到 display:none 的零矩形会掉进中央卡片兜底（轨迹跳向屏幕中部）。
  // 层在等待帧内保持全屏静止，视觉无感；若期间状态被打断则静默放弃。
  requestAnimationFrame(() => {
    if (!immersiveClosing.value || !layerEl.value || !fadeEl.value) return
    const anchor = measureOriginNow()
    debugMorph('collapse:anchor', {
      rect: anchor ? { x: +anchor.rect.left.toFixed(1), y: +anchor.rect.top.toFixed(1), w: +anchor.rect.width.toFixed(1), h: +anchor.rect.height.toFixed(1) } : 'fallback(中央兜底)',
      radius: anchor?.radius ?? null,
    })
    const { rect, radius } = anchorFrom(anchor)
    // 收缩到悬浮条 rect：内容快速淡出，材质壳滑回原位与浮窗同位接续
    morphRun(
      { ...cur },
      { ...morphStateOf(rect, radius), fade: 0 },
      perfDegraded.value ? COLLAPSE_MS_LOW : COLLAPSE_MS,
      () => {
        // 恒等基态写入与置 closed 隐藏在同一任务帧，无中间渲染
        writeMorph(IDENTITY())
        settleClosed()
      },
    )
  })
}

// flush:'post' 是锚点正确性的关键：展开时层已随 v-show 显示、收起时悬浮条
// 已先恢复显示（closing 驱动），此刻量 rect 才是真实位置——pre 时机量到
// display:none 的零矩形，会掉进「屏幕中央卡片」兜底、形变锚点跳到屏幕中央
watch(immersiveOpenSeq, () => playExpand(), { flush: 'post' })
watch(immersiveClosing, (closing) => {
  if (closing) playCollapse()
}, { flush: 'post' })
watch(immersiveOpen, (open) => {
  if (!open) {
    layerEl.value?.classList.remove('is-open')
    stopMorph()
  }
})
</script>

<template>
  <!-- 沉浸层根：形变壳（transform/border-radius 由 container transform 动画驱动，静止恒为全屏） -->
  <div ref="layerEl" class="session-layer">
    <!-- 内容画布 + 浮起的控制层。派生的 --dock-h 让内容区知道底簇占了多高，
         内容因此从玻璃**下面**滚过（玻璃才有东西可采样），而不是被玻璃切掉。 -->
    <div
      ref="fadeEl"
      class="session-page"
      :class="{ 'is-scrolled': bodyScrolled }"
      :style="{
        '--dock-h': `${dockHeight}px`,
        '--top-h': `${topHeight}px`,
        '--warn-h': `${warnH}px`,
        '--cap-h': `${CAP_H}px`,
        '--imm-btn-h': `${DOCK_ROW_H}px`,
      }"
    >
      <!-- 同步失败警示：留在页面流首位（**不是**滚动区里），所以永远不会被浮起的顶簇
           盖住；它占的高度由 ResizeObserver 量成 --warn-h，顶簇据此整体下移同样的距离，
           内容区（在它之后的流里）自然也让出这一段。 -->
      <p v-if="s.persistError" ref="warnEl" class="warn">⚠ 进度同步失败：{{ s.persistError }}</p>

      <!-- 内容区（内容层：全程不透明，不参与玻璃）。上下缘用遮罩渐隐而不是硬边：
           滚到玻璃底下的内容「溶解」进背景，而不是被一条横线切断。
           两簇玻璃是它的绝对定位兄弟 —— 内容因此从玻璃**下面**滚过（玻璃才有东西
           可采样），而不是被夹在两条不透明玻璃条之间。 -->
      <main ref="scrollEl" class="scrollbody">
        <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 滚动框站住，只有 item 位移
             （system/rubberScroll）。各态的 .pane 都留在层内：它们带 fadeUp 入场动画，
             自己不能当层（会与动画抢同一个 transform）。 -->
        <div class="rubber-layer" data-rubber-content>
          <!-- 激活热身：小重量找发力感 / 复合动作渐进 ramp-up -->
          <div v-if="s.phase === 'warmup' && s.currentEx" class="pane col center">
            <p class="eyebrow">激活热身 · 第 {{ s.warmupDone(s.currentEx) + 1 }} / {{ s.currentEx.warmups!.length }} 组</p>
            <h1 class="actname">{{ displayName }}</h1>
            <p class="meta">先用小重量激活目标肌群与动作模式，找发力感后再上正式重量</p>
            <div class="wlist">
              <span
                v-for="(wd, i) in s.currentEx.warmups"
                :key="i"
                class="wstep num"
                :class="{ done: i < s.warmupDone(s.currentEx!), cur: i === s.warmupDone(s.currentEx!) }"
              >
                {{ i < s.warmupDone(s.currentEx!) ? '✓' : '' }} {{ fmtKg(wd.weightKg) }} kg × {{ wd.reps }}
              </span>
            </div>

            <!-- 本组登记：小重量找发力感，重量可现场调整，完成即按实际重量登记 -->
            <div class="setcard">
              <!-- 今日状态自评：首次进入力量训练时出现一次（跳过即纯自动推断）。
                   排在重量之前是有意的 —— 它正是下面那条建议的输入，先说因后说果 -->
              <div v-if="showReadinessPrompt" class="rdsec">
                <div class="rdhead">
                  <span class="rdlabel">今日状态</span>
                  <span class="rdhint">影响建议重量 · 可跳过</span>
                </div>
                <div class="rchips">
                  <button
                    v-for="opt in READINESS_CHIPS"
                    :key="opt.value"
                    type="button"
                    class="rchip"
                    @click="s.setReadiness(opt.value)"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>

              <div class="field">
                <span class="flabel">重量</span>
                <SessionBigNumberInput
                  :model-value="s.weight"
                  label="热身重量"
                  unit="kg"
                  :step="WEIGHT_STEP"
                  :precision="1"
                  :max="999"
                  @update:model-value="onWeight"
                />
              </div>

              <div v-if="fillSources.length" class="qfill">
                <button
                  v-for="f in fillSources"
                  :key="f.key"
                  type="button"
                  class="qseg"
                  :class="{ rec: f.recommended }"
                  :aria-label="`填入${f.caption}重量 ${f.value}`"
                  @click="onWeight(f.weight)"
                >
                  <span class="qcap">{{ f.caption }}</span>
                  <span class="qval num">{{ f.value }}</span>
                </button>
              </div>

              <p class="whint">热身组不计入组数与总容量，重量可按需调整</p>
            </div>

            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>

            <div v-if="exTips" class="blockcard">
              <h3>动作要点</h3>
              <p>{{ exTips }}</p>
            </div>
          </div>

          <!-- 动作中：名称 hero ＋ 重量输入 ＋ 次数输入 ＋ 要点 ＋ 接下来 -->
          <div v-else-if="s.phase === 'exercise' && s.currentEx" class="pane col center">
            <p class="eyebrow">当前动作 · 第 {{ s.setIndex }} / {{ s.effSets(s.currentEx) }} 组</p>
            <h1 class="actname">{{ displayName }}</h1>

            <!-- 本组登记（重量 ＋ 次数同卡同构）：数字可点键入，± 微调；完成本组即记录当前值。
                 这两行是同一组记录的两个字段，之前分开在两处（重量在卡里、次数裸在卡外当大字），
                 视觉上像两件不相干的事，中间还夹着今日状态那张卡，谁主谁次读不出来 -->
            <div class="setcard">
              <!-- 今日状态自评：首次进入力量训练时出现一次（跳过即纯自动推断）。
                   排在重量之前是有意的 —— 它正是下面那条建议的输入，先说因后说果 -->
              <div v-if="showReadinessPrompt" class="rdsec">
                <div class="rdhead">
                  <span class="rdlabel">今日状态</span>
                  <span class="rdhint">影响建议重量 · 可跳过</span>
                </div>
                <div class="rchips">
                  <button
                    v-for="opt in READINESS_CHIPS"
                    :key="opt.value"
                    type="button"
                    class="rchip"
                    @click="s.setReadiness(opt.value)"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>

              <div class="field">
                <span class="flabel">重量</span>
                <SessionBigNumberInput
                  :model-value="s.weight"
                  label="重量"
                  unit="kg"
                  :step="WEIGHT_STEP"
                  :precision="1"
                  :max="999"
                  @update:model-value="onWeight"
                />
              </div>

              <!-- 一键填入：建议 / 上次 / 计划三个出处等宽并列，点一下即填入。
                   等宽是为了让「同一个值的三个候选」这层关系读得出来 —— 从前三个
                   宽度不一的胶囊各自飘着，加上重量本身，五个数字挤在一张卡里没有主次 -->
              <div v-if="fillSources.length" class="qfill">
                <button
                  v-for="f in fillSources"
                  :key="f.key"
                  type="button"
                  class="qseg"
                  :class="{ rec: f.recommended }"
                  :aria-label="`填入${f.caption}重量 ${f.value}`"
                  @click="onWeight(f.weight)"
                >
                  <span class="qcap">{{ f.caption }}</span>
                  <span class="qval num">{{ f.value }}</span>
                </button>
              </div>

              <!-- 建议依据：一行摘要，点开看完整推导（平均状态 × 今日状态）。
                   摘要是推导的首条，展开时从第二条开始列，不在下面重复同一句 -->
              <template v-if="curAdvice?.hasHistory || curAdvice?.rationale.length">
                <button class="whydis" :aria-expanded="whyOpen" @click="whyOpen = !whyOpen">
                  <span class="whytxt">{{ curAdvice?.rationale[0] }}</span>
                  <ChevronDown v-if="whyRest.length" :size="14" :class="{ flip: whyOpen }" />
                </button>
                <ul v-if="whyOpen && whyRest.length" class="whylist">
                  <li v-for="(r, i) in whyRest" :key="i">{{ r }}</li>
                </ul>
              </template>

              <div class="fsep" />

              <!-- 次数：同样可点键入，登记的是实际完成次数（与计划不同也能如实记录） -->
              <div class="field">
                <span class="flabel">次数</span>
                <SessionBigNumberInput
                  :model-value="s.reps"
                  label="次数"
                  unit="次"
                  :step="1"
                  :max="999"
                  @update:model-value="onReps"
                />
              </div>
            </div>

            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>

            <div v-if="exTips" class="blockcard">
              <h3>动作要点</h3>
              <p>{{ exTips }}</p>
            </div>

            <div v-if="nextEx" class="blockcard">
              <h3>接下来</h3>
              <p class="nextrow">▸ 下一动作 · <b>{{ nextExName }}</b> · {{ nextExDesc }}</p>
            </div>
          </div>

          <!-- 组间休息：青环倒数（临时休息/热身组间同视图，结束后回到对应流程） -->
          <div v-else-if="s.phase === 'rest'" class="pane col center">
            <p class="eyebrow">{{ s.restIsTemp ? '临时休息' : s.restWarmup ? '热身组间' : '组间休息' }}</p>
            <RingProgress :value="restProgress" color-var="--c-balance" :size="216" :stroke="13">
              <b class="num restnum">{{ s.restLeft }}</b>
              <span class="restsec">秒</span>
            </RingProgress>
            <p class="meta">{{ restMetaText }}</p>
          </div>

          <!-- 计时动作准备 -->
          <div v-else-if="s.phase === 'timed-ready' && s.currentEx" class="pane col center">
            <p class="eyebrow">{{ s.currentEx.kind === 'cardio' ? '有氧计时' : '计时动作' }}</p>
            <h1 class="actname">{{ displayName }}</h1>
            <p class="meta">
              目标
              {{ s.currentEx.kind === 'timed' ? `${s.currentEx.targetSec}s × ${s.effSets(s.currentEx)} 组` : `${s.currentEx.durationMin} 分钟` }}
              <template v-if="s.currentEx.kind === 'timed'"> · 组间休息 {{ s.currentEx.restSec }}s</template>
            </p>
            <div v-if="activation" class="blockcard">
              <h3>肌群激活</h3>
              <MuscleMap :activation="activation" interactive />
            </div>
            <p class="hint">准备好后，点下方「我准备好了」开始倒数</p>
          </div>

          <!-- 计时进行中 -->
          <div v-else-if="s.phase === 'timed-run'" class="pane col center">
            <RingProgress :value="timedProgress" color-var="--c-intake" :size="248" :stroke="15">
              <b class="num timernum">{{ timedText }}</b>
              <span class="hint">目标 {{ timedTargetText }}</span>
            </RingProgress>
          </div>

          <!-- 总结：只剩庆祝与成绩，动作交给底簇（与其它阶段同槽同位） -->
          <div v-else-if="s.phase === 'summary'" class="pane col center">
            <span class="doneemoji">🎉</span>
            <p class="donetitle">{{ s.plan?.name }}完成</p>
            <p class="num donemeta">
              {{ s.doneCount }}/{{ s.totalCount }} 组
              <template v-if="s.totalVolume > 0"> · 总容量约 {{ s.totalVolume }} kg</template>
              · 用时约 {{ s.durationMin }} 分钟 · 约 {{ s.estimateKcalValue }} 大卡
            </p>
          </div>
        </div>
      </main>

      <!-- 顶栏：**三块并列的玻璃**，中间夹状态显示 —— 收起一枚胶囊、结束一枚胶囊，
           组数状态居中。苹果对文字按钮的规矩是「让它坐在自己的容器里」：从前两枚是
           裸文字、只有中间那颗有底，三者的层级在版式上读不出来。
           整课进度不再占第二行：逐组明细在全课抽屉里，栏上只留「n/N 组」这条状态 ——
           苹果的做法是「层级靠版式与分组表达，能去掉的就去掉」，而不是同一条栏里
           叠两层进度。三块各自是独立的玻璃体，并排不叠压（同 Dock 的语言）。 -->
      <header class="ctrl-top">
        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn min" aria-label="收起运动模式" @click="minimize">
            <ChevronDown :size="18" /> 收起
          </button>
        </SessionGlassButton>

        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn pcapsule" aria-label="查看全课程进度" @click="courseOpen = true">
            <span class="num">{{ s.doneCount }}/{{ s.totalCount }}</span>
            <span class="punit">组</span>
            <ChevronRight :size="13" class="chev" />
          </button>
        </SessionGlassButton>

        <!-- 结束是这条栏里唯一的「主行动」：苹果的规矩是它单独着色（tinted）当焦点，
             其余留中性 —— 所以色落在字上，不把整颗胶囊染红 -->
        <SessionGlassButton h="var(--cap-h)">
          <button class="cbtn end" @click="endOpen = true">结束</button>
        </SessionGlassButton>
      </header>

      <!-- 底簇：组格轨（热身态=重量格，做组态=组矩阵）＋ 一行并排的独立控件。
           两行各自都是**并排的独立块**，不是嵌套 —— 轨内的组格是填充（fill），
           不再是第二层玻璃（苹果明令禁止 glass on glass）。
           主行动是实底、独立于玻璃之外：这是这一步唯一的主行动，不能被半透明削弱。 -->
      <div v-if="dockMode !== 'none'" class="ctrl-dock col">
        <!-- 组格轨：一块玻璃，轨内的组格是**填充**（fill），不是第二层玻璃 ——
             苹果明令禁止 glass on glass；GlassSurface 的折射因此作用在整条轨上，
             组格与缝隙里的内容从它底下滚过时才真的被折射（不是只糊一层）。 -->
        <SessionGlassButton
          v-if="dockMode === 'warmup' || dockMode === 'exercise'"
          w="100%"
          h="auto"
          radius="var(--radius-l)"
        >
          <div class="tiles">
            <template v-if="dockMode === 'warmup'">
              <button
                v-for="(wd, i) in s.currentEx!.warmups"
                :key="i"
                type="button"
                class="dtile wtile num"
                :class="{ done: i < s.warmupDone(s.currentEx!), cur: i === s.warmupDone(s.currentEx!) }"
                :disabled="i !== s.warmupDone(s.currentEx!)"
                @click="s.completeWarmup()"
              >
                <template v-if="i < s.warmupDone(s.currentEx!)">✓</template>
                <!-- 当前组显示实时重量，调整后立刻可见 -->
                <template v-else>{{ i === s.warmupDone(s.currentEx!) ? fmtKg(s.weight) : fmtKg(wd.weightKg) }}</template>
              </button>
            </template>
            <template v-else>
              <button
                v-for="i in s.effSets(s.currentEx!)"
                :key="i"
                type="button"
                class="dtile num"
                :class="{ done: i <= workingDone, cur: i === curTile }"
                :disabled="i !== curTile"
                @click="s.completeSet()"
              >
                <template v-if="i <= workingDone">✓</template>
                <template v-else>{{ i }}</template>
              </button>
            </template>
          </div>
        </SessionGlassButton>

        <div class="drow row">
          <template v-if="dockMode === 'warmup'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <SessionGlassButton h="var(--imm-btn-h)">
              <button class="ghost" @click="s.skipWarmup()">跳过热身</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.completeWarmup()">完成热身组</button>
          </template>

          <template v-else-if="dockMode === 'exercise'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.completeSet()">完成第 {{ s.setIndex }} 组</button>
          </template>

          <template v-else-if="dockMode === 'rest'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="调整休息时长" @click="openRestAdd($event)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="13.5" r="7.5" />
                  <path d="M11 13.5V9.5" />
                  <path d="M9 2.5h4" />
                  <path d="M18.5 4.5h4" />
                  <path d="M20.5 2.5v4" />
                </svg>
              </button>
            </SessionGlassButton>
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.skipRest()">
              {{ s.restIsTemp ? '继续训练' : s.restTargetIsNextSet ? '跳过休息' : '开始下一动作' }}
            </button>
          </template>

          <!-- 计时准备：主行动与其它阶段同槽同位（从前它是内容区里一颗 216px 的玻璃大圆，
               既占掉最多的玻璃面积、又让它随内容一起滚走） -->
          <template v-else-if="dockMode === 'timed-ready'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <button class="primary flex-1 glow-layer" @click="s.prepareTimed()">我准备好了</button>
          </template>

          <template v-else-if="dockMode === 'timed'">
            <SessionGlassButton w="var(--imm-btn-h)" h="var(--imm-btn-h)" radius="50%">
              <button class="iconbtn" aria-label="更多功能" @click="openMore($event)">
                <Ellipsis :size="24" />
              </button>
            </SessionGlassButton>
            <SessionGlassButton h="var(--imm-btn-h)">
              <button class="ghost danger" @click="s.abortTimed()">放弃</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="s.finishTimed()">完成</button>
          </template>

          <!-- 总结：保存是本阶段唯一的主行动，与「放弃不保存」并排（同 timed 的
               放弃 + 完成）。从前它俩在内容区居中飘着 —— 全页只有这一阶段的动作
               不在底簇里，既够不着拇指，也和别的阶段不是一个地方 -->
          <template v-else-if="dockMode === 'summary'">
            <SessionGlassButton h="var(--imm-btn-h)">
              <button class="ghost danger" @click="endOpen = true">放弃不保存</button>
            </SessionGlassButton>
            <button class="primary flex-1" @click="saveNow">保存训练</button>
          </template>
        </div>
      </div>

      <!-- 覆盖层：闪现提示 / 3·2·1 倒数 -->
      <CountdownOverlay
        :show="s.overlay.show"
        :label="s.overlay.label"
        :sub="s.overlay.sub"
        :count-from="s.overlay.countFrom"
        @done="s.onOverlayDone()"
      />

      <!-- 结束（二级确认）：只有这里才算正常结束 -->
      <ActionSheet
        :open="endOpen"
        title="结束本次训练？"
        :actions="[
          { label: '结束并保存', value: 'save' },
          { label: '放弃本次训练（不保存）', value: 'discard', danger: true },
        ]"
        @select="onEndPick"
        @close="endOpen = false"
      />

      <!-- 休息时长加时菜单：图标钮唤起 -->
      <AppMenu
        :open="restSheetOpen"
        :title="restSheetTitle"
        :actions="REST_ADD_ACTIONS"
        :anchor="restAnchor"
        @select="onRestAdd"
        @close="restSheetOpen = false"
      />

      <!-- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 -->
      <AppMenu
        :open="moreOpen"
        :title="MORE_TITLE"
        :actions="MORE_ACTIONS"
        :anchor="moreAnchor"
        @select="onMorePick"
        @close="moreOpen = false"
      />

      <!-- 当前动作详解 -->
      <ExerciseDetailDrawer :open="detailOpen" :exercise="detailExercise" @close="detailOpen = false" />

      <!-- 全课浏览抽屉：逐组进度 / 跳至该组 / 临时换动作 -->
      <SessionCourseDrawer :open="courseOpen" @close="courseOpen = false" />
    </div>
  </div>
</template>

<style scoped>
/* 沉浸层根（形变壳）：transform/border-radius 由 container transform 动画驱动，
   静止时恒为全屏恒等。**壳不是玻璃** —— 静止时它整块被 .session-page 盖住，
   形变期又是逐帧缩放（blur + 逐帧 transform 正是 Android WebView 合成器最易
   冻结的组合，原先这里那条全屏 backdrop-filter 既拿不到任何折射、又白付一次
   全视口采样）。壳只留一个不透明表面色给形变首帧用，投影让块在生长中仍有分量。
   刻意不写 will-change：常驻合成层提升会把层冻在动画中途（真机实测：半透明
   残影叠在真实 UI 上），手写 rAF 每帧写 transform 自带提升，无需常驻提示。 */
.session-layer {
  position: fixed;
  inset: 0;
  z-index: 80; /* 覆盖 TabBar(60) 与全部页面内容 */
  overflow: hidden;
  contain: layout paint;
  transform-origin: 0 0;
  opacity: 0;
  pointer-events: none;
  box-shadow: var(--shadow-float);
  background: var(--surface);
}

.session-layer.is-open {
  opacity: 1;
  pointer-events: auto;
}

/* 形变进行中：控制层的玻璃退成**近材质**而不是纯透明——令牌换成实底 + 常规描边，
   这样即使折射被摘掉，顶栏/底簇仍是可读的一层，而不是空掉。形变期整个层在逐帧
   缩放，每多一块 backdrop-filter 就多一处重采样（折射那一路尤其贵）。 */
.session-layer.is-morphing :deep(.sgbtn) {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  transition: none !important;
  background: var(--surface);
  border-color: var(--line);
  box-shadow: none;
}

.session-layer.is-morphing :deep(.wstep.cur) {
  animation: none !important;
}

/* 淡入层：不透明底 + 全部内容的统一 opacity 载体——形变初期只见材质壳
   长大，内容随后浮现；收起时先淡出内容再缩回，压扁过程不可见。
   底部安全区在这里处理：底簇按它上浮，内容区也据它留出末段内边距。 */
.session-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  /* 层定位不随 .app-frame 偏移，顶部/底部安全区自行处理 */
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}

/* ---------- 控制层 · 顶栏 ----------
   苹果对控制层的要求是**浮起、内缩、圆角、内容从底下滚过去**，外加「文字按钮要坐在
   自己的容器里」。所以这条栏是三块**并列的独立玻璃**：收起一枚胶囊、结束一枚胶囊、
   组数状态居中 —— 三块各自带受光边、并排留缝、互不叠压（叠压会在缝上出现月牙硬边，
   与 Dock 三块是同一条结论）。

   材质归 GlassSurface（超高 / 极致折射，其余档位退成毛玻璃，弱档顶成实底）：
   从前这条栏挂的是 .glass-surface —— 它只有 backdrop-filter，超高下**也只是糊**，
   拿不到任何折射。几何归这里，材质归组件，两边不重复定义同一件事。

   同心：胶囊是**独立控件**（不在任何玻璃里面），所以 --radius-full 成立；
   栏内不再有需要同心的嵌套层（进度轨退场后，「内圈 = 外圈 − 内边距」这条约束随之消失）。 */
.ctrl-top {
  position: absolute;
  /* 绝对定位的包含块是 .session-page 的 padding box，而 padding 不会把 padding box
     边界推下来 —— 安全区因此得在这里自己加上，不能指望父层的 padding-top。
     `--warn-h` 是同步失败警示实占的高度（无警示时 0）：整条栏让开它，否则会被盖住。 */
  top: calc(var(--safe-top) + 10px + var(--warn-h));
  /* 左右各留余量：Android 手势导航在屏幕两缘留返回手势带，停靠元素要整体收进带外
     （--safe-left 已含 20px 兜底），这里再叠 6px 呼吸空间。 */
  inset-inline: calc(var(--safe-left) + 6px);
  z-index: 2;
  max-width: var(--frame-max);
  margin-inline: auto;
  /* 三栏等分：左右各占一份、中间那格按内容宽 —— 中间那颗因此是**数学居中**的
     （两侧宽度不等时 space-between 会让它偏，而苹果对这种情形的态度是「能居中就居中」）。
     两枚胶囊靠边对齐，格宽不参与伸缩：胶囊的宽度只由「字 + 自己的内边距」决定 ——
     从前这里的按钮被拉伸成 134px 的隐形命中区（点空白处会把训练收起来）。 */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}

.ctrl-top > :first-child {
  justify-self: start;
}

.ctrl-top > :last-child {
  justify-self: end;
}

/* 胶囊里那颗按钮：内边距归它（玻璃跟着内容走，宽度天然就是「字 + 这个内边距」），
   按压反馈也加在它身上 —— 它是玻璃的**后代**，缩放不会动到玻璃自己那块背景根
   （GlassSurface 的折射靠 backdrop-filter，祖先带 transform / filter 会把它废掉）。 */
.ctrl-top .min,
.ctrl-top .end,
.ctrl-top .pcapsule {
  height: 100%;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-full);
  font-size: var(--fs-subhead);
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.ctrl-top .min {
  gap: 2px;
  padding: 0 14px 0 10px;
  font-weight: 600;
}

/* 组数状态：点开全课抽屉。它是这条栏里唯一的「读数」，所以数字给最重的字重、
   「组」与箭头退到次级色 —— 层级靠前景，不靠再叠一层底。 */
.ctrl-top .pcapsule {
  gap: 1px;
  padding: 0 10px 0 14px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

/* 结束是这条栏唯一的「主行动」：苹果的规矩是它单独着色（tinted）当焦点 ——
   色落在字上（不把整颗胶囊染红），按压时才给一层 soft 反馈。 */
.ctrl-top .end {
  padding: 0 14px;
  font-weight: 700;
  color: var(--danger-strong);
}

.ctrl-top .min:active,
.ctrl-top .end:active,
.ctrl-top .pcapsule:active {
  transform: scale(1.04, 0.92);
  transition: transform 120ms var(--ease-out);
}

.ctrl-top .end:active {
  background: var(--danger-soft);
}

.punit {
  margin-right: 1px;
}

.pcapsule .chev {
  color: var(--text-3);
}

/* 同步失败警示：它是页面 flex 列的第一行，而顶簇是绝对定位的 —— 从前两者互不知情，
   一有同步失败，警示就被那块玻璃整个盖住（审查实测：警示在 y=0..24，顶簇在 10..78）。
   现在顶簇的 top 加上 `--warn-h`（见脚本里的 ResizeObserver），整块让开这一段；
   内容区在它之后的流里，自然也让出同样的高度，于是"警示 → 顶簇 → 内容"的次序
   在任何高度下都成立，不需要写死任何一行的像素数。
   底是**不透明**的：它压着页面画布，半透明底在暗色下会糊成一片看不出是警示。 */
.warn {
  flex: none;
  margin: 0 26px;
  padding: 6px 10px;
  border-radius: var(--radius-s);
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--warn-strong);
  background: color-mix(in srgb, var(--warn) 14%, var(--surface));
}

/* 组格行：它坐在 SessionGlassButton 那块玻璃的 .gbody 里（那一层已经是 100%×100%
   的居中盒），所以这里只管排布 —— 轨的材质 / 圆角 / 折射全在组件里，再写一遍必然漂。
   内边距 6 与玻璃的圆角 22 是一对：组格 16 = 22 − 6，同心。 */
.tiles {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 6px;
}

/* ---------- 内容层 ----------
   内容铺满整块舞台并**从两簇玻璃底下滚过去**（这是玻璃能采样到东西、而不是当装饰
   的前提）。上下留出两簇的占位高度，于是静止时首屏内容正好落在玻璃下缘之外。

   上下缘用一条**遮罩渐隐**而不是硬边：滚到玻璃底下的内容在进入玻璃之前就溶解进背景，
   而不是被玻璃的边缘切成一条横线（苹果的 Scroll Edge Effect —— 「把内容溶解进背景」，
   它不遮挡、也不压暗；从前这里是一条压暗的暗带，方向正好是反的）。
   遮罩是纯合成器操作，代价约等于零，且不产生背景根。

   渐隐段的长度**取自浮层实际盖住的区域**（这是苹果对这条效果的定度：效果铺满
   固定控件与它下面那块 accessory view 的高度）：
     · 下缘 = 底簇占位 + 26（那 26 正是内容末段的内边距，见 padding-bottom）——
       于是滚到底时最后一屏正文正好落在**完全不透明**的那条线上，不会被自己的渐隐吃掉；
       而滚过底簇的内容全程处在渐隐里，组格上的数字因此始终读得清。
     · 上缘只需抹掉视口顶缘那条硬边（顶簇里没有需要压在内容上读的字），34 就够。 */
.scrollbody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: var(--top-h);
  /* 与下面的渐隐同值：正文的终点 = 完全不透明的那条线 */
  padding-bottom: calc(var(--dock-h) + 26px);
  --edge-fade-top: 34px;
  --edge-fade-bottom: calc(var(--dock-h) + 26px);
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--edge-fade-top),
    #000 calc(100% - var(--edge-fade-bottom)),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--edge-fade-top),
    #000 calc(100% - var(--edge-fade-bottom)),
    transparent 100%
  );
}

/* 超范围平移层：撑满滚动框（min-height:100%），让内容不足一屏时 .pane 仍能居中；
   内容超一屏时按内容撑高，滚动与原来一致。只承载 transform，不改观感。 */
.rubber-layer {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.pane {
  /* 原来是 min-height:100%（百分比落在 auto 高的包裹层上会失效），改用 flex:1：
     在包裹层里等价地撑满，且内容超一屏时按内容撑高 */
  flex: 1;
  gap: 12px;
  padding: 24px 26px;
  animation: fadeUp var(--dur-sheet) var(--ease-standard);
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

.eyebrow {
  font-size: var(--fs-footnote);
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--text-3);
}

.actname {
  font-size: 40px;
  font-weight: 800;
  letter-spacing: -1px;
  line-height: 1.1;
  text-align: center;
}

.meta {
  max-width: 330px;
  text-align: center;
  font-size: var(--fs-subhead);
  color: var(--text-2);
  line-height: 1.6;
}

/* 本组登记卡：重量与次数同卡同构 —— 标签定宽在左、± 分列两端、数值居中，
   两行因此左右严格对齐，读起来是一张表，而不是几块拼图。
   今日状态（首次进入时的一次性自评）也收进这张卡：它是建议重量的输入，
   单开一张卡夹在重量与次数之间，等于把「一组记录」切成了两半。

   材质：**内容层，不是玻璃**。苹果的分层是内容层 —— 导航层 —— 覆盖层三层，
   玻璃只属于中间那层；把表格这类内容做成玻璃，它会和别的元素抢注意力、把层级
   搅浑（原话：making it Liquid Glass would make it compete with other elements
   and muddy the hierarchy）。这里还有两个本地理由：① 它宽 min(360px) 几乎贴满
   内容区，玻璃面积与成本都最大；② 它要从底簇玻璃**下面**滚过去，自己再是玻璃
   就成了玻璃叠玻璃。所以内容层用的是「实底 + 轻投影」这套全仓通用的 .card 语汇。 */
.setcard {
  width: min(360px, 100%);
  border-radius: var(--radius-l);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 标签定宽：两行的 ± 与数值因此落在同一条竖线上 */
.flabel {
  flex: none;
  width: 32px;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.field > :deep(.biginput) {
  flex: 1;
  min-width: 0;
}

/* 重量块与次数之间的分格线 */
.fsep {
  height: 0;
  border-top: 0.5px solid var(--line);
}

.whint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 一键填入：建议 / 上次 / 计划 等宽并列（同一个重量的三个出处） */
.qfill {
  display: flex;
  gap: 6px;
  padding: 3px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.qseg {
  flex: 1;
  min-width: 0;
  padding: 7px 4px;
  border-radius: calc(var(--radius-m) - 3px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.qseg:active {
  transform: scale(0.96);
}

.qcap {
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}

.qval {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-2);
  white-space: nowrap;
}

/* 主推来源（今日建议 / 热身处方）在候选里抬起来。刻意不用主色实底：
   它是「可以填进去」的候选，不是已经生效的状态，实底会与完成态的绿撞语义 */
.qseg.rec {
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
}

.qseg.rec .qval {
  color: var(--c-exercise-deep);
}

/* 建议依据：全宽左对齐的展开行（从前是居中飘着的一行小字，看不出可点） */
.whydis {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-3);
  font-size: var(--fs-caption);
  text-align: left;
}

.whytxt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.whydis svg {
  flex: none;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.whydis svg.flip {
  transform: rotate(180deg);
}

.whylist {
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.7;
}

.whylist li + li {
  margin-top: 3px;
}

/* 今日状态自评：卡内的上分段，一条细分隔线与下面的重量行分开 */
.rdsec {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid var(--line);
}

.rdhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.rdlabel {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-1);
}

.rdhint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* 五档等宽：档位是同一把尺子上的五点，等宽才读得出一条量表。
   五枚都压在同一张内容卡里，各自再带一层玻璃会互相折射、把量表读成五块噪声 ——
   所以这一组走**卡内的实底分档**（--surface-2），只有玻璃那张卡在外层。 */
.rchips {
  display: flex;
  gap: 6px;
}

.rchip {
  flex: 1;
  min-width: 0;
  padding: 10px 2px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.rchip:active {
  transform: scale(0.94);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

/* 热身清单步骤 chips */
.wlist {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.wstep {
  padding: 7px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-2);
}

.wstep.cur {
  background: var(--text-1);
  color: var(--bg);
  animation: cellbreath 1.6s infinite;
}

.wstep.done {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

/* 热身组格：重量标注，小一号 */
.dtile.wtile {
  font-size: var(--fs-body);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-top: 8px;
}

/* 要点 / 接下来 卡片 —— 与 .setcard 同材质（内容层实底），只补几何 */
.blockcard {
  width: min(360px, 100%);
  border-radius: var(--radius-l);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.blockcard h3 {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
  letter-spacing: 0.4px;
}

.blockcard p {
  font-size: var(--fs-subhead);
  color: var(--text-1);
  line-height: 1.65;
}

.nextrow {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-2);
}

.nextrow b {
  color: var(--text-1);
}

/* 休息 */
.restnum {
  font-size: 76px;
  font-weight: 200;
  letter-spacing: -3px;
  line-height: 1;
}

.restsec {
  font-size: var(--fs-callout);
  color: var(--text-2);
  font-weight: 500;
}

/* 计时中 */
.timernum {
  font-size: 64px;
  font-weight: 200;
  letter-spacing: -2.5px;
  line-height: 1;
}

/* ---------- 控制层 · 底簇 ----------
   两行并排的独立块：组格轨（一块玻璃，轨内组格是填充）＋ 一行独立控件
   （图标钮/次按钮用玻璃，主行动用实底）。没有任何一层玻璃套在另一层玻璃里。

   底簇本身**不是**玻璃 —— 它是这两行的定位容器，行内的每块各自是浮起的玻璃体。
   这样它们与悬浮 Dock（圆形钮 + 药丸 + 圆形钮）是同一套语言：并排的独立玻璃块，
   而不是一大块玻璃里塞满小玻璃。 */
.ctrl-dock {
  position: absolute;
  /* 同顶簇：安全区要在这里自己加（包含块是 padding box） */
  bottom: calc(var(--safe-bottom) + 14px);
  inset-inline: calc(var(--safe-left) + 6px);
  z-index: 2;
  max-width: var(--frame-max);
  margin-inline: auto;
  gap: 12px;
}

/* 滚起来之后加一层更沉的外投影：苹果的玻璃会**随背后内容自适应影子深浅** ——
   内容压到玻璃底下时影子变重，把玻璃和内容分开。静止时那道轻影读作「这是浮层」。
   目标是 .sgbtn（SessionGlassButton 的那层玻璃根）—— 背景根在它身上，
   光学层的清单与 GlassSurface 里那份逐条对齐（少一条就会掉档）。 */
.session-page.is-scrolled :deep(.sgbtn) {
  box-shadow:
    var(--glass-shadow-lifted),
    var(--glass-halo),
    inset 0 1px 0 0 var(--glass-rim-hi),
    inset 0 -1px 0 0 var(--glass-rim-lo),
    inset 0 14px 22px -16px var(--glass-sheen),
    inset 0 0 0 1px var(--glass-rim-2),
    inset 0 1px 10px -2px var(--glass-caustic);
}

/* 上面那条把整串 box-shadow 重写了一遍（CSS 没法只覆盖列表里的第一项），
   所以「减弱透明度」下要在这里再压回去一次：系统要的是实底 + 常规投影，
   不能因为内容滚起来了就把光学层和重落影又请回来。同权重、排在后面，故它赢。 */
@media (prefers-reduced-transparency: reduce) {
  .session-page.is-scrolled :deep(.sgbtn) {
    box-shadow: var(--shadow-float);
  }
}

.drow {
  gap: 12px;
  width: 100%;
}

/* 坞内主按钮随行伸缩：休息态两枚图标钮 + 主键在窄屏也要放得下；
   热身态三键并排（图标 + 跳过 + 完成），收窄内边距避免 390px 挤爆 */
.drow .primary {
  min-width: 0;
  padding: 0 26px;
}

.dtile {
  width: 58px;
  height: 52px;
  /* 同心：16 = 玻璃轨圆角 22 − 行内边距 6（.tiles）。热身重量格与正式组格同一档 ——
     从前是两个值（52 与 58 两种高度、17 与无圆角两种角），同一块轨里换模式会跳一下 */
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-title2);
  font-weight: 700;
  /* 待做的组：**不挂填充**本身就是「还不能点」的信号，文字因此留在能读的 --text-2，
     而不是更淡一档 —— 它压在会滚动的玻璃上，再淡一点在亮环境 / 窄屏下就真读不出了
     （苹果对禁用态的要求是「仍然可读」，不是「看不见」）。 */
  color: var(--text-2);
  cursor: default;
  transition:
    background-color var(--dur-base) var(--ease-standard),
    color var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

/* 已完成的组：全仓统一的完成态（soft 底 + 深色前景） */
.dtile.done {
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

/* 待完成（当前组）：抬起来的**中性填充**，不带色相也不带渐变 —— 与底部 Dock 的活动底
   同一条规矩（选中/当前交给底的明度，色相留给前景）。
   底取 --surface + --shadow-thumb，也就是卡内「一键填入」里那枚主推候选（.qseg.rec）
   的同一套：一块白底从玻璃轨上抬起来。不用 --glass-tab-fill 是因为它压在**内容**上
   （不是压在页面画布上）：它自己就是半透明白，叠在同样是半透明白的玻璃轨上等于没提亮，
   组格数字压着背后滚过的东西读不清 —— 而这里恰恰是「必须读得清」的那一格。
   从前它是黑实底：底下那颗唯一的主行动也是黑实底，两块黑互相抢，谁主谁次读不出来。 */
.dtile.cur {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-thumb);
  cursor: pointer;
}

.dtile.cur:active {
  transform: scale(0.92);
}

/* 主按钮 —— 实底是**语义选择**不是玻璃：它是这一步唯一的主行动，
   超高档也要保住"黑/白实底 + 玻璃"这条最高的对比层级，玻璃化会和内容糊在一起。
   它也因此**独立于玻璃之外**（苹果：主行动单独放、并且着色当焦点），
   于是它是胶囊这件事不构成同心问题 —— 胶囊只对独立控件成立，嵌套进玻璃里才会「胀角」。
   按压走全仓 Dock 那套体积守恒挤压 + 回弹（见 base.css 的 .dock-tab）。 */
.primary {
  min-width: 240px;
  height: 54px;
  padding: 0 38px;
  border-radius: 27px;
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-headline);
  font-weight: 600;
  box-shadow: 0 8px 20px rgba(29, 29, 31, 0.22);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.primary:active {
  /* 纵向压得多、横向略胀，近似体积守恒；松手沿弹簧曲线过冲回正 */
  transform: scale(1.04, 0.92);
  transition: transform 120ms var(--ease-out);
}

/* 次按钮与图标钮：它们**坐在 SessionGlassButton 那块玻璃里**，所以这里只管内容与
   按压 —— 材质 / 圆角 / 尺寸都在玻璃那一层（写在这里会和折射抢同一块盒子）。
   两者都撑满玻璃的 .gbody：玻璃多大，命中区就多大，不会出现「看着是玻璃、
   点下去只有中间一小块」那种偏差。 */
.ghost {
  width: 100%;
  height: 100%;
  padding: 0 22px;
  border-radius: var(--radius-full);
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.ghost:active {
  transform: scale(1.03, 0.94);
  transition: transform 120ms var(--ease-out);
}

.ghost.danger {
  color: var(--danger-strong);
}

/* 休息时长图标钮：正圆由玻璃根给（radius 50%），按钮撑满即可 */
.iconbtn {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-standard);
}

.iconbtn:active {
  transform: scale(1.05, 0.9);
  transition: transform 120ms var(--ease-out);
}

.iconbtn svg {
  width: 24px;
  height: 24px;
}

/* 完成态 */
.doneemoji {
  font-size: 52px;
}

.donetitle {
  font-size: var(--fs-large-title);
  font-weight: 700;
  letter-spacing: -0.5px;
}

.donemeta {
  font-size: var(--fs-subhead);
  color: var(--text-2);
  margin-bottom: 8px;
}
</style>
