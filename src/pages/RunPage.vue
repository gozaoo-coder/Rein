<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, LocateFixed, Play } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import GlassThumb from '@/components/common/GlassThumb.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useRunStore, fmtClock, fmtPace } from '@/stores/run'
import { buildRunSummary, fmtDuration, type SplitRow } from '@/utils/runSummary'
import { fmtDateCn, todayStr } from '@/utils/date'
import { motionRich } from '@/system/motion'
import { usePressGlow } from '@/composables/usePressGlow'
import { workoutRuntime } from '@/system/workoutRuntime'
import { openImmersive } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'

/**
 * 运动模式 · 跑步（R5 深色轨迹头部）：覆盖整个窗口的沉浸二级页。
 * 暗区承载空间数据（轨迹 / 距离 / 目标进度 / GPS），亮区承载时间数据
 * （时长 hero ＋ 千卡 ＋ 瞬时/平均配速对照卡），互不重复。
 * 与训练课同一条结束语义（结束键 → 二级确认）；GPS 不可用时
 * 退化为纯计时，距离在总结页手动补填（跑步机场景）。
 */
const r = useRunStore()
const router = useRouter()
const { toast } = useToast()

const endOpen = ref(false)
const conflictOpen = ref(false)
const countdownOpen = ref(false)
/**
 * 总结页距离输入。
 *
 * 类型是 `string | number` 而不是 `string`：`<input type="number" v-model>`
 * 在 Vue 里会把用户输入**写成数字**（"4.50" → 4.5），只有程序赋值
 * （syncManualKm 写 toFixed 串）时才是字符串。
 * 从前注释写着「字符串便于空值表示未填」，于是每个读它的地方都直接
 * `.trim()` —— 用户一改距离（变数字）computed 就抛 TypeError，
 * 界面静默停在旧状态（踩过：症状是「输入框改了、界面没反应」，
 * 控制台只有一条看起来无关的 render 错）。
 * 所以：**读它一律先 String(...) 归一**，别再加字符串方法。
 */
const manualKmText = ref<string | number>('')

onMounted(async () => {
  // 先等运动系统运行时的启动接管（冷开直达本页时防竞态）；
  // 状态机已激活（收起后再进入 / 运行时已恢复）则原样展示，不重复恢复
  await workoutRuntime.whenReady()
  if (r.isActive) {
    syncManualKm() // 恢复到总结页时预填 GPS 距离
    return
  }
  if (r.phase === 'ready') return // 已设过目标，保留
  const restored = await r.hydrateFromServer()
  if (restored) {
    syncManualKm()
    return
  }
  if (r.courseConflict) conflictOpen.value = true
  r.enterReady()
})

const clockText = computed(() => fmtClock(r.elapsedSec))
const paceText = computed(() => (r.paceSecPerKm != null ? fmtPace(r.paceSecPerKm) : '—'))
const instPaceText = computed(() =>
  r.paceInstantSecPerKm != null ? fmtPace(r.paceInstantSecPerKm) : '—',
)
const kmText = computed(() => (r.km > 0.005 ? r.km.toFixed(2) : '—'))

/* ---------- 总结派生（口径见 utils/runSummary） ---------- */

/**
 * 距离是否被用户改过：改过分段配速整体失效（轨迹距离与填入值对不上）。
 *
 * ⚠ `manualKmText` **不能当字符串用**：`<input type="number" v-model>` 在
 * Vue 里会把它写成**数字**（"4.50" → 4.5），所以 `.trim()` / `.toFixed()`
 * 这类字符串方法会在用户输入小数时抛 TypeError。
 * 症状很隐蔽：computed 抛错 → 渲染回退到上一次的 vnode →
 * 界面看起来「改了距离但什么都没变」，而控制台只有一条无关的 render 错。
 * 所以这里一律先 `String(...)` 归一，两个读它的地方都这么处理。
 */
const kmOverridden = computed(() => {
  const t = String(manualKmText.value ?? '').trim()
  if (!t) return false
  const v = Number(t)
  if (!Number.isFinite(v)) return false
  return Math.abs(v - r.km) > 0.005
})

const runSummary = computed(() => {
  const t = String(manualKmText.value ?? '').trim()
  const v = Number(t)
  const manual = kmOverridden.value && Number.isFinite(v) ? v : null
  return buildRunSummary(r.trackPoints, { manualKm: manual })
})
const runSplits = computed(() => runSummary.value.splits)
const runSplitsAvailable = computed(() => runSummary.value.splitsAvailable)
const runAscent = computed(() => runSummary.value.ascentM)
const runPaceSpread = computed(() => runSummary.value.paceSpread)

const isFastest = (sp: SplitRow): boolean => runSummary.value.fastestKm?.index === sp.index
const isSlowest = (sp: SplitRow): boolean => runSummary.value.slowestKm?.index === sp.index
const fastestPace = computed(() =>
  runSummary.value.fastestKm ? fmtPace(runSummary.value.fastestKm.paceSecPerKm) : '—',
)
const slowestPace = computed(() =>
  runSummary.value.slowestKm ? fmtPace(runSummary.value.slowestKm.paceSecPerKm) : '—',
)

/** 分段不可用时的那句说明：必须说清是「哪一档不可用」，不能只说「无数据」 */
const splitsHint = computed(() => {
  if (kmOverridden.value) return '距离已手动改填 · 分段配速按 GPS 原始轨迹计算，与改填值不一致，故不显示'
  if (r.trackPoints.length < 2) return '本次没有定位轨迹（GPS 不可用）· 分段配速需要轨迹'
  return `本次不足 1 公里（${kmText.value === '—' ? '无距离' : kmText.value + ' km'}）· 满 1 公里后才有分段`
})

const runSub = computed(() => {
  const parts = [fmtDateCn(todayStr())]
  parts.push(r.goalKind === 'time' ? `目标 ${r.goalTimeMin} 分钟` : r.goalKind === 'distance' ? `目标 ${r.goalDistanceKm.toFixed(2)} km` : '自由跑')
  parts.push(r.gpsStatus === 'unavailable' ? '无 GPS' : '全程完成')
  return parts.join(' · ')
})

const gpsChip = computed(() => {
  if (r.phase !== 'running' && r.phase !== 'paused') return ''
  if (r.gpsStatus === 'active') return 'GPS 已连接'
  if (r.gpsStatus === 'acquiring') return '定位中…'
  if (r.gpsStatus === 'unavailable') return '无法定位 · 结束后可补填距离'
  return ''
})

const goalLabel = computed(() => {
  if (r.goalKind === 'time') return `目标 ${r.goalTimeMin} 分钟`
  if (r.goalKind === 'distance') return `目标 ${r.goalDistanceKm} km`
  return '自由跑'
})

const distChipText = computed(() => {
  const km = r.km > 0.005 ? r.km.toFixed(2) : '0.00'
  return r.goalKind === 'distance' ? `${km} / ${r.goalDistanceKm.toFixed(2)} km` : `${km} km`
})

const goalBarWidth = computed(() => `${(Math.min(r.goalProgress, 1) * 100).toFixed(1)}%`)

const heroWaitText = computed(() => {
  if (r.phase === 'ready') return '开跑后轨迹将在此描绘'
  if (r.gpsStatus === 'unavailable') return '' // 状态 chip 已说明，不重复
  return '等待轨迹…'
})

/* ---------- 轨迹相机：世界坐标 = 相对首点的局部米坐标，屏幕 = R(rot)·p·scale + t ---------- */

const VIEW_W = 480
const VIEW_H = 320
const VIEW_PAD = 30
/** 固定缩放档基准：1 视口 px = 1 m（宽约 480 m 视野），捏合可在此上下调整 */
const BASE_SCALE = 1
const SCALE_MIN = 0.15
const SCALE_MAX = 12
/** 每纬度米数（等距圆柱近似） */
const M_LAT = 111_320

interface Cam {
  scale: number
  rot: number
  tx: number
  ty: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 相机模式：follow = 跟随「我」+ 运动方向朝上（默认）；manual = 手势接管；fit = 全览整条轨迹 */
type CamMode = 'follow' | 'manual' | 'fit'
const camMode = ref<CamMode>('follow')
/** 固定档捏合比例（回到 follow 时保留用户缩放） */
const userScale = ref(1)

/**
 * 相机模式两段切换的液态滑块（丰富档）：与 SegmentedControl 同一套做法 ——
 * 两段是等宽的，GlassThumb 要的就是"均分槽位"这个前提。
 * manual 与 follow 在这一格上语义相同（都锁定跟随），所以手动接管后仍高亮「固定」。
 */
const goo = motionRich
const msegIndex = computed(() => (camMode.value === 'fit' ? 1 : 0))
/** 手势接管的冻结相机（世界坐标稳定：锚定首点） */
const manualCam = ref<Cam | null>(null)
/** 运动方向朝上的旋转角（度，EMA 平滑） */
const headingDeg = ref(0)

/** 局部米坐标（相对轨迹首点；首点不增不改 → 手动相机在世界系下稳定） */
const trackMeters = computed(() => {
  const pts = r.trackPoints
  if (pts.length === 0) return null
  const o = pts[0]!
  const kx = Math.cos((o.lat * Math.PI) / 180)
  return pts.map((p) => ({ x: (p.lon - o.lon) * kx * M_LAT, y: -(p.lat - o.lat) * M_LAT }))
})

watch(trackMeters, (m) => {
  if (!m || m.length < 2 || r.phase !== 'running') return
  const a = m[m.length - 2]!
  const b = m[m.length - 1]!
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.hypot(dx, dy) < 3) return // 位移太小不更新朝向（GPS 抖动）
  // 把运动方向向量旋到屏幕上方 (0, -1)
  const target = -90 - (Math.atan2(dy, dx) * 180) / Math.PI
  let diff = target - headingDeg.value
  diff = ((diff + 540) % 360) - 180 // 最短角差
  headingDeg.value = (headingDeg.value + diff * 0.25 + 360) % 360
})

const view = computed(() => {
  const m = trackMeters.value
  if (!m || m.length === 0) return { cam: null, d: null, start: null, last: null }

  let cam: Cam
  if (camMode.value === 'fit') {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of m) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const scale = clamp(
      Math.min((VIEW_W - VIEW_PAD * 2) / spanX, (VIEW_H - VIEW_PAD * 2) / spanY),
      SCALE_MIN,
      SCALE_MAX,
    )
    cam = {
      scale,
      rot: 0,
      tx: VIEW_W / 2 - ((minX + maxX) / 2) * scale,
      ty: VIEW_H / 2 - ((minY + maxY) / 2) * scale,
    }
  } else if (camMode.value === 'manual' && manualCam.value) {
    cam = manualCam.value
  } else {
    const scale = clamp(BASE_SCALE * userScale.value, SCALE_MIN, SCALE_MAX)
    const rot = ((headingDeg.value % 360) + 360) % 360
    const rad = (rot * Math.PI) / 180
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const last = m[m.length - 1]!
    cam = {
      scale,
      rot,
      tx: VIEW_W / 2 - (c * last.x - s * last.y) * scale,
      ty: VIEW_H / 2 - (s * last.x + c * last.y) * scale,
    }
  }

  const rad = (cam.rot * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const to = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: (c * p.x - s * p.y) * cam.scale + cam.tx,
    y: (s * p.x + c * p.y) * cam.scale + cam.ty,
  })

  // 抽稀描线（≤400 点），末点必含
  let d: string | null = null
  if (m.length >= 2) {
    const step = Math.max(1, Math.ceil(m.length / 400))
    const idxs: number[] = []
    for (let i = 0; i < m.length; i += step) idxs.push(i)
    if (idxs[idxs.length - 1] !== m.length - 1) idxs.push(m.length - 1)
    const p0 = to(m[idxs[0]!]!)
    d = `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)}`
    for (let k = 1; k < idxs.length; k++) {
      const q = to(m[idxs[k]!]!)
      d += ` L ${q.x.toFixed(1)} ${q.y.toFixed(1)}`
    }
  }
  return { cam, d, start: to(m[0]!), last: to(m[m.length - 1]!) }
})

/* ---------- 地图手势：单指平移 / 双指捏合缩放平移 ---------- */

const heroEl = ref<HTMLElement | null>(null)
const pointers = new Map<number, { x: number; y: number }>()
type Gesture =
  | { kind: 'pan'; startCam: Cam; startPt: { x: number; y: number } }
  | { kind: 'pinch'; startCam: Cam; startDist: number; startMid: { x: number; y: number } }
let gesture: Gesture | null = null

/** client 坐标 → SVG 视口坐标（slice 裁剪补偿） */
function toView(clientX: number, clientY: number): { x: number; y: number } {
  const el = heroEl.value
  if (!el) return { x: clientX, y: clientY }
  const rect = el.getBoundingClientRect()
  const k = Math.max(rect.width / VIEW_W, rect.height / VIEW_H)
  return {
    x: (clientX - rect.left - (rect.width - VIEW_W * k) / 2) / k,
    y: (clientY - rect.top - (rect.height - VIEW_H * k) / 2) / k,
  }
}

function camNow(): Cam {
  // 手动态用冻结相机；跟随/全览态用 view computed 解析出的当前相机（含用户缩放与朝向）
  return manualCam.value ?? view.value.cam ?? { scale: BASE_SCALE, rot: 0, tx: VIEW_W / 2, ty: VIEW_H / 2 }
}

function onMapDown(e: PointerEvent): void {
  if ((e.target as HTMLElement).closest('button, .chip, input, a')) return
  try {
    heroEl.value?.setPointerCapture?.(e.pointerId)
  } catch {
    /* 合成指针事件（自动化/测试）无真实活动指针，忽略 */
  }
  const pt = toView(e.clientX, e.clientY)
  pointers.set(e.pointerId, pt)
  if (pointers.size === 1) {
    gesture = { kind: 'pan', startCam: camNow(), startPt: pt }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    gesture = {
      kind: 'pinch',
      startCam: camNow(),
      startDist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
      startMid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    }
  }
}

function onMapMove(e: PointerEvent): void {
  if (!pointers.has(e.pointerId) || !gesture) return
  const pt = toView(e.clientX, e.clientY)
  pointers.set(e.pointerId, pt)
  const g = gesture
  if (g.kind === 'pan' && pointers.size === 1) {
    const dx = pt.x - g.startPt.x
    const dy = pt.y - g.startPt.y
    if (camMode.value !== 'manual' && Math.hypot(dx, dy) < 4) return // 抑制点按抖动
    manualCam.value = { ...g.startCam, tx: g.startCam.tx + dx, ty: g.startCam.ty + dy }
  } else if (g.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const dist = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y))
    const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }
    const scale = clamp(g.startCam.scale * (dist / g.startDist), SCALE_MIN, SCALE_MAX)
    // 起始中点下的世界点钉在当前中点下（锚点不漂移）
    const rad = (g.startCam.rot * Math.PI) / 180
    const c = Math.cos(rad)
    const s = Math.sin(rad)
    const wx = (g.startMid.x - g.startCam.tx) / g.startCam.scale
    const wy = (g.startMid.y - g.startCam.ty) / g.startCam.scale
    const ux = c * wx + s * wy // R(-rot) 逆变换回世界系
    const uy = -s * wx + c * wy
    manualCam.value = {
      scale,
      rot: g.startCam.rot,
      tx: mid.x - (c * ux - s * uy) * scale,
      ty: mid.y - (s * ux + c * uy) * scale,
    }
  } else {
    return
  }
  camMode.value = 'manual'
  userScale.value = clamp((manualCam.value?.scale ?? BASE_SCALE) / BASE_SCALE, SCALE_MIN / BASE_SCALE, SCALE_MAX / BASE_SCALE)
}

function onMapUp(e: PointerEvent): void {
  pointers.delete(e.pointerId)
  if (pointers.size === 1 && gesture?.kind === 'pinch') {
    // 双指抬成一指 → 无缝转为平移
    const [pt] = [...pointers.values()]
    gesture = { kind: 'pan', startCam: manualCam.value ?? camNow(), startPt: pt! }
  } else if (pointers.size === 0) {
    gesture = null
  }
}

function recenter(): void {
  camMode.value = 'follow'
  manualCam.value = null
}

function fitAll(): void {
  camMode.value = 'fit'
  manualCam.value = null
}

// 阶段切换时重置相机：开跑回跟随默认档，总结页自动全览
watch(
  () => r.phase,
  (p) => {
    if (p === 'summary') {
      fitAll()
      drawerCollapsed.value = false
      return
    }
    if (p === 'ready') {
      camMode.value = 'follow'
      manualCam.value = null
      userScale.value = 1
      headingDeg.value = 0
      drawerCollapsed.value = false
    }
  },
)

/* ---------- 底部抽屉拖拽：展开 ↔ 收起（露出 peek）两档吸附 ---------- */

const drawerEl = ref<HTMLElement | null>(null)
/** 按压定向光晕（丰富档）：整页一份委托 —— :active 决定亮不亮，即时反馈等不得事件 */
usePressGlow(drawerEl, '.glow-layer')
/** 丰富档的滚动边缘：抽屉里任一面板滚起来即置位（暗带只画一条，在抽屉上缘） */
const paneScrolled = ref(false)

/** 三个面板各是独立的滚动框（v-if 换面），事件冒泡到抽屉根统一收一份。 */
function onDrawerScroll(e: Event): void {
  const t = e.target as HTMLElement
  paneScrolled.value = t.scrollTop > 4
}

// 阶段切换时换了一整个面板，滚动位置随之归零 —— 暗带不能留着上一面的状态
watch(() => r.phase, () => (paneScrolled.value = false))

const drawerCollapsed = ref(false)
const drawerDragging = ref(false)
const dragY = ref<number | null>(null)
/** 收起态露出的 peek 高度：把手 + 时长/千卡行 */
const PEEK_PX = 176
let dragBase = 0
let dragStartY = 0
let dragMoved = false

const dragStyle = computed(() =>
  dragY.value != null ? { transform: `translateY(${dragY.value}px)` } : undefined,
)

function onHandleDown(e: PointerEvent): void {
  if (r.phase !== 'running' && r.phase !== 'paused') return
  if ((e.target as HTMLElement).closest('button')) return
  const el = e.currentTarget as HTMLElement | null
  if (!el) return
  try {
    // 捕获到把手自身：捕获后事件只流向 handle（含其监听），不会经过父容器
    el.setPointerCapture(e.pointerId)
  } catch {
    /* 合成指针事件，忽略 */
  }
  const drawer = drawerEl.value
  dragBase = drawerCollapsed.value && drawer ? drawer.offsetHeight - PEEK_PX : 0
  dragStartY = e.clientY
  dragMoved = false
  drawerDragging.value = true
}

function onHandleMove(e: PointerEvent): void {
  if (!drawerDragging.value) return
  const el = drawerEl.value
  if (!el) return
  const max = el.offsetHeight - PEEK_PX
  if (Math.abs(e.clientY - dragStartY) > 6) dragMoved = true
  dragY.value = clamp(dragBase + e.clientY - dragStartY, 0, max)
}

function onHandleUp(): void {
  if (!drawerDragging.value) return
  drawerDragging.value = false
  const el = drawerEl.value
  if (dragMoved && el && dragY.value != null) {
    drawerCollapsed.value = dragY.value > (el.offsetHeight - PEEK_PX) / 2
  } else if (!dragMoved) {
    drawerCollapsed.value = !drawerCollapsed.value // 轻点把手 = 切换档位
  }
  dragY.value = null
}

function syncManualKm(): void {
  manualKmText.value = r.km > 0.005 ? r.km.toFixed(2) : ''
}

function minimize(): void {
  if (r.isActive) void router.push('/sports')
  else void router.replace('/sports')
}

function onGo(): void {
  countdownOpen.value = true
}

async function onCountdownDone(): Promise<void> {
  const res = await r.begin()
  if (res === 'conflict' && r.courseConflict) conflictOpen.value = true
}

function onEndPick(value: string): void {
  endOpen.value = false
  if (value === 'finish') {
    r.enterSummary()
    syncManualKm()
  } else if (value === 'discard') {
    void doDiscard()
  }
}

async function doDiscard(): Promise<void> {
  await r.discard()
  toast('已放弃本次跑步')
  void router.replace('/sports')
}

async function doSave(): Promise<void> {
  // String(...) 归一：type=number 的 v-model 给回的是**数字**而非字符串
  // （理由见 kmOverridden 的注释）。parseFloat 对数字虽能工作，
  // 但那依赖隐式转字符串，属于「碰巧对」，与上面两处保持同一写法。
  const parsed = Number.parseFloat(String(manualKmText.value ?? ''))
  const manualKm = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null
  const result = await r.save(manualKm)
  const parts = [`已保存跑步 ${result.durationMin} 分钟 · ${result.kcal} 大卡`]
  if (result.km != null) parts.push(`${result.km.toFixed(2)} km`)
  toast(parts.join(' · '))
  void router.replace('/sports')
}

function bumpKm(delta: number): void {
  const cur = Math.round(r.goalDistanceKm * 2) / 2
  r.goalDistanceKm = Math.min(42, Math.max(0.5, cur + delta))
}
</script>

<template>
  <div class="run-page" :class="r.phase">
    <!-- ========== 暗区 · 轨迹剧场（满屏，抽屉覆盖其下沿） ==========
         stage-dark：这一片是深色底，浮在上面的 chip 要取**暗场**玻璃令牌
         （暗色下 halo 是溢到背后的微光、rim 收得更低），亮色那套压上来会翻白。 -->
    <section
      ref="heroEl"
      class="hero stage-dark"
      @pointerdown="onMapDown"
      @pointermove="onMapMove"
      @pointerup="onMapUp"
      @pointercancel="onMapUp"
    >
      <svg class="map" viewBox="0 0 480 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path v-if="view.d" class="route" :d="view.d" />
        <circle v-if="view.start" class="mk-start" :cx="view.start.x" :cy="view.start.y" r="5.5" />
        <g v-if="view.last">
          <circle class="mk-pulse" :cx="view.last.x" :cy="view.last.y" r="7" />
          <circle class="mk-dot" :cx="view.last.x" :cy="view.last.y" r="7" />
        </g>
      </svg>
      <p v-if="!view.d && heroWaitText" class="hero-wait">{{ heroWaitText }}</p>

      <header class="shead row between">
        <button class="min" aria-label="收起运动模式" @click="minimize">
          <ChevronDown :size="20" /> 收起
        </button>
        <span class="ptitle">跑步 · {{ goalLabel }}</span>
        <button v-if="r.phase !== 'ready' && r.phase !== 'summary'" class="end" @click="endOpen = true">
          结束
        </button>
        <span v-else class="ph" />
      </header>

      <span v-if="gpsChip" class="chip gps glass-surface" :class="{ ok: r.gpsStatus === 'active' }">
        <i class="gdot" />{{ gpsChip }}
      </span>

      <span v-if="r.phase === 'running' || r.phase === 'paused'" class="chip dist glass-surface">
        <span class="lab num">{{ distChipText }}</span>
        <span v-if="r.goalKind !== 'open'" class="bar"><i :style="{ width: goalBarWidth }" /></span>
      </span>

      <span v-if="r.phase === 'paused'" class="paused-badge glass-surface">已暂停 · 计时停止</span>
    </section>

    <p v-if="r.persistError" class="warn">⚠ 进度同步失败：{{ r.persistError }}</p>

    <!-- ========== 亮区 · 可拖拽抽屉 ========== -->
    <main
      ref="drawerEl"
      class="drawer"
      :class="{ collapsed: drawerCollapsed, dragging: drawerDragging, 'is-scrolled': paneScrolled }"
      :style="dragStyle"
      @scroll.capture="onDrawerScroll"
    >
      <!-- 把手行：回中 / 拖拽档位 / 缩放模式（仅进行中与暂停） -->
      <div
        v-if="r.phase === 'running' || r.phase === 'paused'"
        class="handle"
        @pointerdown="onHandleDown"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
      >
        <button v-if="camMode === 'manual'" class="hbtn glass-surface" aria-label="回到跟随锁定" @click="recenter">
          <LocateFixed :size="16" />
        </button>
        <span v-else class="hph" />
        <i class="grab" />
        <div ref="msegEl" class="mseg glass-surface" :class="{ goo: goo }">
          <GlassThumb v-if="goo" :index="msegIndex" :count="2" />
          <button class="seg-item glow-layer" :class="{ on: camMode !== 'fit' }" @click="recenter">固定</button>
          <button class="seg-item glow-layer" :class="{ on: camMode === 'fit' }" @click="fitAll">全览</button>
        </div>
      </div>

      <!-- 准备页：目标选择 -->
      <div v-if="r.phase === 'ready'" class="pane col center">
        <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 页面框站住，只有 item 位移（system/rubberScroll） -->
        <div class="rubber-layer" data-rubber-content>
          <p class="eyebrow">设定目标</p>
          <SegmentedControl
            class="seg"
            :options="[
              { value: 'open', label: '自由跑' },
              { value: 'time', label: '时长' },
              { value: 'distance', label: '距离' },
            ]"
            :model-value="r.goalKind"
            @update:model-value="r.goalKind = $event as typeof r.goalKind"
          />

          <div v-if="r.goalKind === 'time'" class="goalbox row">
            <button class="gbtn glass-surface glow-layer" :disabled="r.goalTimeMin <= 5" @click="r.goalTimeMin -= 5">− 5</button>
            <b class="num gval">{{ r.goalTimeMin }}</b>
            <small class="gunit">分钟</small>
            <button class="gbtn glass-surface glow-layer" :disabled="r.goalTimeMin >= 180" @click="r.goalTimeMin += 5">+ 5</button>
          </div>
          <div v-else-if="r.goalKind === 'distance'" class="goalbox row">
            <button class="gbtn glass-surface glow-layer" @click="bumpKm(-0.5)">− 0.5</button>
            <b class="num gval">{{ r.goalDistanceKm }}</b>
            <small class="gunit">公里</small>
            <button class="gbtn glass-surface glow-layer" @click="bumpKm(0.5)">+ 0.5</button>
          </div>
          <p v-else class="meta">不限时长与距离，随时结束并保存</p>

          <button class="gobtn glass-surface glow-layer" @click="onGo">
            <Play :size="30" :stroke-width="2.6" />
            <span>开始跑步</span>
          </button>
          <p class="hint">点击后倒数 3 秒开跑 · 中途暂停不计时</p>
        </div>
      </div>

      <!-- 进行中 / 暂停：时长 hero ＋ 千卡 ＋ 双配速对照卡 -->
      <div v-else-if="r.phase === 'running' || r.phase === 'paused'" class="pane col center live">
        <!-- 超范围平移层：同上（item 超伸） -->
        <div class="rubber-layer" data-rubber-content>
          <div class="time-row row between">
            <div>
              <b class="num tnum">{{ clockText }}</b>
              <p class="tcap">{{ r.phase === 'paused' ? '已暂停' : '运动时长' }}</p>
            </div>
            <div class="kcal">
              <b class="num">{{ r.kcal }}</b>
              <span>千卡</span>
            </div>
          </div>

          <div class="pace row glass-surface">
            <div class="col center">
              <span class="lab"><i class="live-dot" />瞬时配速</span>
              <b class="num pv">{{ instPaceText }}</b>
              <span class="pu">/km</span>
            </div>
            <div class="col center">
              <span class="lab">平均配速</span>
              <b class="num pv avg">{{ paceText }}</b>
              <span class="pu">/km</span>
            </div>
          </div>

          <div class="ctl row">
            <template v-if="r.phase === 'running'">
              <button class="primary" @click="r.pause()">暂停</button>
            </template>
            <template v-else>
              <button class="ghost glass-surface glow-layer danger" @click="endOpen = true">结束</button>
              <button class="primary" @click="r.resume()">继续</button>
            </template>
          </div>
        </div>
      </div>

      <!-- 总结页：成绩单（分段配速 / 爬升）+ 距离核对（可修正）后保存 -->
      <div v-else-if="r.phase === 'summary'" class="pane col center sumpane">
        <!-- 超范围平移层：同上（item 超伸）。总结屏内容比其它阶段长，
             所以这一屏取消居中（align-items/justify-content 覆盖回 flex-start）——
             居中会把顶部一截顶出可滚范围，用户以为没有更多内容。 -->
        <div class="rubber-layer sumlayer" data-rubber-content>
          <span class="doneemoji">🏃</span>
          <p class="donetitle">跑步完成</p>
          <p class="donemeta">{{ runSub }}</p>

          <!-- 四项指标：总时长 / 距离 / 平均配速 / 消耗。
               配速与距离在 GPS 丢失时是「—」而不是 0 —— 那一格要如实说"没测到"，
               画成 0 会被读成"跑了个零"。 -->
          <div class="sumgrid">
            <div class="sumstat">
              <span class="sslabel">总时长</span>
              <b class="ssval num">{{ clockText }}</b>
            </div>
            <div class="sumstat">
              <span class="sslabel">距离</span>
              <b class="ssval num">{{ kmText }}<i v-if="kmText !== '—'" class="ssunit">km</i></b>
            </div>
            <div class="sumstat">
              <span class="sslabel">平均配速</span>
              <b class="ssval num">{{ paceText }}<i v-if="paceText !== '—'" class="ssunit">/km</i></b>
            </div>
            <div class="sumstat">
              <span class="sslabel">消耗</span>
              <b class="ssval num">{{ r.kcal }}<i class="ssunit">kcal</i></b>
            </div>
          </div>

          <!-- 逐公里分段：跑步这一边唯一能回答「为什么这次这么快/这么慢」的地方。
               不可用时（手动补填距离 / 不足 1km）说清为什么，而不是画一张空表。 -->
          <section v-if="runSplitsAvailable" class="sumcard">
            <h3>逐公里分段</h3>
            <div class="splitrow">
              <span v-for="sp in runSplits" :key="sp.index" class="splitcell" :class="{ fast: isFastest(sp), slow: isSlowest(sp) }">
                <span class="spidx num">{{ sp.index }}</span>
                <span class="sppace num">{{ fmtPace(sp.paceSecPerKm) }}</span>
                <span v-if="sp.ascentM > 0" class="spup num">↑{{ sp.ascentM }}</span>
              </span>
            </div>
            <p v-if="runPaceSpread" class="hint left">
              最快 {{ fastestPace }} · 最慢 {{ slowestPace }} · 相差 {{ fmtDuration(runPaceSpread) }}
            </p>
          </section>
          <section v-else class="sumcard">
            <h3>逐公里分段</h3>
            <p class="hint left">{{ splitsHint }}</p>
          </section>

          <!-- 爬升：只计正增量（GPS 高程噪声向下也算会把平路跑出几十米假爬升） -->
          <section v-if="runAscent != null" class="sumcard">
            <h3>累计爬升</h3>
            <p class="sumbig num">{{ runAscent }}<span class="ssunit"> m</span></p>
          </section>

          <label class="distfield row between">
            <span>距离（公里）</span>
            <input
              v-model="manualKmText"
              class="num"
              type="number"
              inputmode="decimal"
              step="0.01"
              min="0"
              max="999"
              placeholder="未测得，可补填"
            />
          </label>
          <p class="hint left">{{ kmText === '—' ? '未获取到定位：跑步机跑完可手动填距离' : 'GPS 距离已预填，可按实际修正' }}</p>

          <button class="primary" @click="doSave">保存训练</button>
          <button class="ghost glass-surface glow-layer danger" @click="endOpen = true">放弃不保存</button>
        </div>
      </div>
    </main>

    <!-- 覆盖层：3·2·1 倒数 -->
    <CountdownOverlay :show="countdownOpen" label="" sub="准备开跑" :count-from="3" @done="countdownOpen = false; void onCountdownDone()" />

    <!-- 结束（二级确认）：只有这里才算正常结束 -->
    <ActionSheet
      :open="endOpen"
      title="结束本次跑步？"
      :actions="[
        { label: '结束并保存', value: 'finish' },
        { label: '放弃本次跑步（不保存）', value: 'discard', danger: true },
      ]"
      @select="onEndPick"
      @close="endOpen = false"
    />

    <!-- 有进行中的训练课：引导前往接续，防止覆盖 -->
    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练课，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="conflictOpen = false; openImmersive()"
      @close="conflictOpen = false; void router.replace('/sports')"
    />
  </div>
</template>

<style scoped>
.run-page {
  position: fixed;
  inset: 0;
  z-index: 80; /* 覆盖 TabBar(60) 与全部页面内容 */
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  /* fixed 定位不随 .app-frame 偏移，顶部安全区自行处理 */
  padding-top: var(--safe-top);
}

/* ---------- 暗区 · 轨迹剧场（满屏底图，抽屉覆盖下沿） ---------- */
.hero {
  position: absolute;
  inset: 0;
  background: var(--hero-bg);
  overflow: hidden;
  touch-action: none; /* 手势：单指平移 / 双指捏合，不触发页面滚动 */
  transition: filter var(--dur-sheet) var(--ease-standard);
}

.run-page.paused .hero {
  filter: brightness(0.55) saturate(0.75);
}

/* 底图网格：向右上渐隐 */
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--hero-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-grid) 1px, transparent 1px);
  background-size: 44px 44px;
  -webkit-mask-image: radial-gradient(130% 110% at 62% 18%, #000 45%, transparent 100%);
  mask-image: radial-gradient(130% 110% at 62% 18%, #000 45%, transparent 100%);
}

.hero .map {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.route {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 6px var(--hero-route-glow));
}

.mk-start {
  fill: var(--hero-text);
  opacity: 0.85;
}

.mk-dot {
  fill: var(--surface);
  stroke: var(--hero-route-line);
  stroke-width: 3;
}

.mk-pulse {
  fill: none;
  stroke: var(--hero-route-line);
  stroke-width: 2;
  transform-box: fill-box;
  transform-origin: center;
  animation: ping 1.8s var(--ease-standard) infinite;
}

.run-page.paused .mk-pulse {
  animation-play-state: paused;
}

@keyframes ping {
  0% {
    transform: scale(1);
    opacity: 0.9;
  }
  100% {
    transform: scale(3);
    opacity: 0;
  }
}

.hero-wait {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  letter-spacing: 1px;
  color: var(--hero-text-dim);
}

/* 顶栏（暗区上） */
.shead {
  position: absolute;
  top: var(--safe-top);
  left: 0;
  right: 0;
  z-index: 5;
  height: 54px;
  padding: 0 18px;
  background: linear-gradient(rgba(6, 6, 8, 0.55), rgba(6, 6, 8, 0));
}

.min {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--hero-text);
}

.end {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--hero-end);
  padding: 8px 4px;
}

.ptitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--hero-text-dim);
}

.ph {
  width: 48px;
}

/* 悬浮信息 chip —— 走 .glass-surface + .stage-dark 的暗场令牌
   （超高档的 halo/caustic/rim 在暗场里才有意义：亮色下的落影压在深色地图上
   才是"这块玻璃浮在画面之上"的重量感。手写 blur(14px) 拿不到那三层光学层，
   弱档也顶不掉 blur —— 都交给令牌。） */
.chip {
  position: absolute;
  z-index: 4;
  padding: 9px 13px;
  border-radius: 16px;
  color: var(--hero-text);
}

.gps {
  top: calc(var(--safe-top) + 62px);
  left: 14px;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-caption);
  font-weight: 600;
}

.gdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hero-text-dim);
}

.gps.ok .gdot {
  background: var(--hero-route-line);
  box-shadow: 0 0 8px var(--hero-route-glow);
  animation: breathe 1.8s infinite;
}

.run-page.paused .gps.ok .gdot {
  animation-play-state: paused;
}

.dist {
  top: calc(var(--safe-top) + 62px);
  right: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.dist .lab {
  font-size: var(--fs-title3);
  font-weight: 700;
}

.dist .bar {
  width: 112px;
  height: 4px;
  border-radius: 2px;
  background: var(--hero-chip-line);
  overflow: hidden;
}

.dist .bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--hero-route-line);
  transition: width 1s linear;
}

/* 暂停徽标 —— 材质同 chip（.glass-surface + .stage-dark 令牌）。
   暂停是"运动被冻结"的状态，徽标要压得住画面：底色仍偏黑（stage-dark 令牌
   里 --glass-fill 就是 --hero-chip-bg），只是光学层与饱和度交给令牌统一管。 */
.paused-badge {
  position: absolute;
  z-index: 6;
  left: 50%;
  top: 26%;
  transform: translate(-50%, -50%);
  padding: 10px 22px;
  border-radius: var(--radius-full);
  color: var(--hero-text);
  font-size: var(--fs-callout);
  font-weight: 700;
  letter-spacing: 1px;
}

@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.55);
    opacity: 0.45;
  }
}

.warn {
  position: absolute;
  top: calc(var(--safe-top) + 56px);
  left: 0;
  right: 0;
  z-index: 30;
  text-align: center;
  padding: 4px;
  font-size: var(--fs-micro);
  color: var(--warn);
  background: rgba(255, 149, 0, 0.14);
}

/* ---------- 亮区 · 可拖拽抽屉 ----------
   抽屉本身**不玻璃化**：它是大面积可滚动的内容载体，自身带 backdrop-filter
   会成为整棵子树的后备根，把里面每一块玻璃的采样范围都锁死在抽屉自己的内容上
   （同 DesktopInspector 的取舍）。所以它保持不透明底，玻璃交给把手行上的
   离散控件与浮在上面的 HUD chip。
   丰富档的滚动边缘暗带挂在上缘：内容滚起来时把这条边抬离移动的内容。 */
.drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: 46%;
  z-index: 10;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-radius: 22px 22px 0 0;
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  transform: translateY(0);
  transition: transform var(--dur-sheet) var(--ease-standard);
}

html[data-motion='rich'] .drawer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 22px;
  pointer-events: none;
  opacity: 0;
  z-index: 2;
  background: linear-gradient(to bottom, var(--glass-scroll-edge), transparent);
  transition: opacity var(--dur-base) var(--ease-standard);
}

html[data-motion='rich'] .drawer.is-scrolled::before {
  opacity: 1;
}

/* 收起档：只露出 peek（把手 + 时长/千卡行） */
.drawer.collapsed {
  transform: translateY(calc(100% - 176px));
}

.drawer.dragging {
  transition: none;
}

.run-page.ready .drawer {
  top: 26%;
}

.run-page.summary .drawer {
  top: 32%;
}

/* 把手行：回中按钮 ｜ 拖拽条 ｜ 缩放模式切换 */
.handle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px 5px;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

/* 回中按钮：抽屉上的离散小控件 —— 走 .glass-surface。
   它压在抽屉的不透明底上，玻璃采样的正是抽屉本身，得到的是真的磨砂层次。 */
.hbtn {
  width: 30px;
  height: 30px;
  border-radius: 15px;
  color: var(--c-exercise);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hph {
  width: 30px;
}

.grab {
  flex: 1;
  max-width: 44px;
  height: 5px;
  border-radius: 3px;
  background: var(--line);
}

/* 相机模式切换：两段分段控件 —— 轨道走 .glass-surface（抽屉上的浮玻璃），
   滑块在丰富档换成 GlassThumb（液态融合 + 形变），与 SegmentedControl 同一套做法。 */
.mseg {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 12px;
  overflow: hidden;
}

/* 丰富档：滑块落在这条**玻璃轨道**上，所以用半透 blob 语义（不覆写令牌），
   融合时能看到它与轨道玻璃的通透关系。 */
.mseg button {
  position: relative;
  padding: 4px 11px;
  border-radius: 10px;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

.mseg button.on {
  color: var(--text-1);
}

/* 默认档：没有 goo 滤镜，纯色滑块常驻；丰富档由 GlassThumb 接管并压掉这块 */
.mseg:not(.goo) button.on {
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.mseg.goo button.on {
  background: transparent;
  box-shadow: none;
}

.pane {
  flex: 1;
  min-height: 0;
  gap: 14px;
  padding: 18px 28px calc(30px + var(--safe-bottom));
  overflow-y: auto;
}

/* 超范围平移层：镜像 .pane 的弹性列布局（只承载 transform，不改观感）。
   flex:1 让内容不足一屏时由它占满容器、居中与原来一致；内容超一屏时按内容撑高，
   滚动照常，且不会再出现「居中把顶部一截顶出可滚范围」的老问题。 */
.rubber-layer {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.eyebrow {
  font-size: var(--fs-footnote);
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--text-3);
}

.seg {
  width: min(300px, 100%);
}

.goalbox {
  align-items: baseline;
  gap: 14px;
  margin-top: 6px;
}

/* 目标步进钮：控制层小胶囊 —— 材质走 .glass-surface，这里只补几何 */
.gbtn {
  align-self: center;
  min-width: 64px;
  height: 44px;
  border-radius: 22px;
  font-size: var(--fs-callout);
  font-weight: 600;
}

.gbtn:disabled {
  opacity: 0.35;
}

.gval {
  font-size: 56px;
  font-weight: 200;
  letter-spacing: -2px;
  line-height: 1;
  min-width: 110px;
  text-align: center;
}

.gunit {
  font-size: var(--fs-callout);
  color: var(--text-2);
}

.meta {
  max-width: 320px;
  text-align: center;
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
  text-align: center;
}

.hint.left {
  align-self: stretch;
  text-align: left;
  margin: -8px 0 0;
}

/* 开始跑步：全屏那颗最大的离散控件 —— 走玻璃材质（模板上的 .glass-surface）。
   3px 绿描边收成 1px 透明边框（受光边由背景渐变画出，硬描边会盖掉它），
   悬停仍翻成实底 —— 那是"确认要开始了"，不该被半透明削弱。 */
.gobtn {
  width: 216px;
  height: 216px;
  margin-top: 10px;
  border-radius: 50%;
  color: #3d7a00;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: var(--fs-title3);
  font-weight: 700;
  transition: all var(--dur-base) var(--ease-standard);
}

.gobtn:hover {
  background: var(--c-exercise);
  color: #1a2b00;
}

.gobtn:active {
  transform: scale(0.95);
}

@media (prefers-color-scheme: dark) {
  .gobtn {
    color: var(--c-exercise);
  }
}

/* 进行中：内容贴顶（收起档 peek 正好露出时长/千卡行），控制按钮沉底 */
.live {
  justify-content: flex-start;
}

.time-row {
  align-items: flex-end;
  width: 100%;
}

.tnum {
  font-size: 84px;
  font-weight: 200;
  letter-spacing: -3.5px;
  line-height: 0.95;
}

.tcap {
  font-size: var(--fs-caption);
  letter-spacing: 0.5px;
  color: var(--text-3);
  margin-top: 9px;
}

.kcal {
  text-align: right;
  padding-bottom: 10px;
}

.kcal b {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.kcal span {
  display: block;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-top: 2px;
}

/* 双配速对照卡：瞬时（呼吸点 · 活的）｜平均（更重 · 稳的）
   材质走 .glass-surface —— 它是抽屉里最大的一张数据卡，超高档下该半透出下面的
   距离/千卡行，形成一块悬浮的玻璃板；弱档令牌自动顶回实底。 */
.pace {
  width: 100%;
  border-radius: var(--radius-l);
  overflow: hidden;
}

.pace > div {
  flex: 1;
  padding: 16px 8px 15px;
  gap: 5px;
}

.pace > div + div {
  border-left: 0.5px solid var(--line);
}

.pace .lab {
  display: flex;
  flex-direction: row;
  align-items: center;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-3);
  gap: 6px;
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-exercise);
  animation: breathe 1.6s infinite;
}

.run-page.paused .live-dot {
  animation-play-state: paused;
}

.pace .pv {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.5px;
}

.pace .pv.avg {
  font-weight: 800;
}

.pace .pu {
  font-size: 10px;
  color: var(--text-3);
}

.ctl {
  gap: 14px;
  justify-content: center;
  margin-top: auto;
}

/* 主按钮：实底是**语义选择**不是玻璃 —— 保持"这一屏唯一的主行动"最高对比层级 */
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
}

/* 次按钮：控制层玻璃 —— 材质走 .glass-surface（全仓一份定义），这里只补几何 */
.ghost {
  height: 50px;
  border-radius: 25px;
  padding: 0 24px;
  font-size: var(--fs-callout);
  font-weight: 600;
  color: var(--text-1);
}

.ghost.danger {
  color: var(--danger);
}

/* 总结 */
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
  margin-bottom: 4px;
}

/* ---------- 总结屏 ----------
   卡片用**亮色面**（--surface / --surface-2 一族），不是 --hero-chip-bg。
   理由：总结屏的底是 .run-page 的 var(--bg)（亮色 #f5f5f7），
   轨迹剧场（.hero，绝对定位满屏）只在它**下面**当背景纹理透出来。
   早先按「这是暗区」用了半透明深色卡片，结果一块块深灰压在浅底上，
   整屏像蒙了层脏 —— 半透明的深色压在浅底上必然发灰，与它下层是什么无关。 */

.sumpane {
  padding-bottom: calc(30px + var(--safe-bottom));
}

/* 取消居中：内容长，居中会把顶部一截顶出可滚范围（用户以为没有更多）。
   保留 .pane 自己的 flex:1，让内容不足一屏时仍占满（滚动终点才确定）。 */
.sumlayer {
  justify-content: flex-start;
  align-items: stretch;
  max-width: 360px;
  text-align: left;
}

/* 四项指标 */
.sumgrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  width: 100%;
}

.sumstat {
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-m);
  padding: 8px 6px;
  min-width: 0;
  text-align: center;
}

.sslabel {
  display: block;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.ssval {
  display: block;
  font-size: 17px;
  font-weight: 600;
  margin-top: 2px;
  color: var(--text-1);
  letter-spacing: -0.3px;
}

.ssunit {
  font-size: var(--fs-micro);
  font-style: normal;
  font-weight: 400;
  color: var(--text-3);
  margin-left: 2px;
}

/* 分段 / 爬升卡 */
.sumcard {
  width: 100%;
  background: var(--surface);
  border: 0.5px solid var(--line);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-card);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sumcard h3 {
  font-size: var(--fs-footnote);
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-2);
  text-align: left;
}

.sumbig {
  font-size: var(--fs-display-s);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.1;
}

/* 逐公里分段：横向一排等宽格，横向滚。
   `flex: none` 要加在**格子**上而不是里面的文字上 —— flex 项是格子，
   只钉内部文字的话格子仍会被压缩，配速数字就会折行。 */
.splitrow {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
}

.splitrow::-webkit-scrollbar {
  display: none;
}

.splitcell {
  flex: none;
  min-width: 62px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 7px 8px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.spidx {
  font-size: 10px;
  color: var(--text-3);
}

.sppace {
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.15;
}

.spup {
  font-size: 10px;
  /* 用 --ok-strong 而不是 --c-exercise-deep：
     后者的注释写着「亮底上的文字绿」，但**暗色档把它覆写成亮绿 #a4f04b**，
     于是它在亮色档压 --surface-2 只有 2.67:1、暗色档压 --surface-2 只有 1.24:1
     —— 两边都不够（实测）。--ok-strong 是真正为「底上的绿字」留的一档
     （亮 #248a3d / 暗 #30d158），三级门槛 3:1 两边都过。
     上箭头「↑」本身已经说明了「爬升」，颜色不承担语义。 */
  color: var(--ok-strong);
}

/* 最快 / 最慢：靠底色 + 左侧色条区分，文字色保持 --text-1 ——
   绿字压绿底在任何组合下都到不了 4.5:1（实测最好 3.7:1），
   所以「哪公里最快」由底色说，不让文字去承担。 */
.splitcell.fast {
  background: color-mix(in srgb, var(--c-exercise) 24%, var(--surface));
  box-shadow: inset 2px 0 0 var(--c-exercise-deep);
}

.splitcell.slow {
  background: var(--surface-2);
  box-shadow: inset 2px 0 0 var(--text-3);
}

.sumcard .hint {
  text-align: left;
  color: var(--text-2);
}

.distfield {
  width: min(340px, 100%);
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-2);
}

.distfield input {
  width: 130px;
  text-align: right;
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  background: transparent;
}

.distfield input::placeholder {
  font-size: var(--fs-footnote);
  font-weight: 500;
  color: var(--text-3);
}
</style>
