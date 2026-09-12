<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, LocateFixed, Play } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useRunStore, fmtClock, fmtPace } from '@/stores/run'
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
/** 总结页距离输入（字符串便于空值表示「未填」） */
const manualKmText = ref('')

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
  const parsed = Number.parseFloat(manualKmText.value)
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
    <!-- ========== 暗区 · 轨迹剧场（满屏，抽屉覆盖其下沿） ========== -->
    <section
      ref="heroEl"
      class="hero"
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

      <span v-if="gpsChip" class="chip gps" :class="{ ok: r.gpsStatus === 'active' }">
        <i class="gdot" />{{ gpsChip }}
      </span>

      <span v-if="r.phase === 'running' || r.phase === 'paused'" class="chip dist">
        <span class="lab num">{{ distChipText }}</span>
        <span v-if="r.goalKind !== 'open'" class="bar"><i :style="{ width: goalBarWidth }" /></span>
      </span>

      <span v-if="r.phase === 'paused'" class="paused-badge">已暂停 · 计时停止</span>
    </section>

    <p v-if="r.persistError" class="warn">⚠ 进度同步失败：{{ r.persistError }}</p>

    <!-- ========== 亮区 · 可拖拽抽屉 ========== -->
    <main
      ref="drawerEl"
      class="drawer"
      :class="{ collapsed: drawerCollapsed, dragging: drawerDragging }"
      :style="dragStyle"
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
        <button v-if="camMode === 'manual'" class="hbtn" aria-label="回到跟随锁定" @click="recenter">
          <LocateFixed :size="16" />
        </button>
        <span v-else class="hph" />
        <i class="grab" />
        <div class="mseg">
          <button :class="{ on: camMode !== 'fit' }" @click="recenter">固定</button>
          <button :class="{ on: camMode === 'fit' }" @click="fitAll">全览</button>
        </div>
      </div>

      <!-- 准备页：目标选择 -->
      <div v-if="r.phase === 'ready'" class="pane col center">
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
          <button class="gbtn" :disabled="r.goalTimeMin <= 5" @click="r.goalTimeMin -= 5">− 5</button>
          <b class="num gval">{{ r.goalTimeMin }}</b>
          <small class="gunit">分钟</small>
          <button class="gbtn" :disabled="r.goalTimeMin >= 180" @click="r.goalTimeMin += 5">+ 5</button>
        </div>
        <div v-else-if="r.goalKind === 'distance'" class="goalbox row">
          <button class="gbtn" @click="bumpKm(-0.5)">− 0.5</button>
          <b class="num gval">{{ r.goalDistanceKm }}</b>
          <small class="gunit">公里</small>
          <button class="gbtn" @click="bumpKm(0.5)">+ 0.5</button>
        </div>
        <p v-else class="meta">不限时长与距离，随时结束并保存</p>

        <button class="gobtn" @click="onGo">
          <Play :size="30" :stroke-width="2.6" />
          <span>开始跑步</span>
        </button>
        <p class="hint">点击后倒数 3 秒开跑 · 中途暂停不计时</p>
      </div>

      <!-- 进行中 / 暂停：时长 hero ＋ 千卡 ＋ 双配速对照卡 -->
      <div v-else-if="r.phase === 'running' || r.phase === 'paused'" class="pane col center live">
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

        <div class="pace row">
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
            <button class="ghost danger" @click="endOpen = true">结束</button>
            <button class="primary" @click="r.resume()">继续</button>
          </template>
        </div>
      </div>

      <!-- 总结页：核对（可修正距离）后保存 -->
      <div v-else-if="r.phase === 'summary'" class="pane col center">
        <span class="doneemoji">🏃</span>
        <p class="donetitle">跑步完成</p>
        <p class="num donemeta">
          {{ clockText }}<template v-if="kmText !== '—'"> · {{ kmText }} km · {{ paceText }}/km</template>
          · 约 {{ r.kcal }} 大卡
        </p>

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
        <button class="ghost danger" @click="endOpen = true">放弃不保存</button>
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

/* 悬浮信息 chip */
.chip {
  position: absolute;
  z-index: 4;
  padding: 9px 13px;
  border-radius: 16px;
  background: var(--hero-chip-bg);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  border: 0.5px solid var(--hero-chip-line);
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

.paused-badge {
  position: absolute;
  z-index: 6;
  left: 50%;
  top: 26%;
  transform: translate(-50%, -50%);
  padding: 10px 22px;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 0.5px solid var(--hero-chip-line);
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

/* ---------- 亮区 · 可拖拽抽屉 ---------- */
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

.hbtn {
  width: 30px;
  height: 30px;
  border-radius: 15px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
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

.mseg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 12px;
  background: var(--surface-2);
}

.mseg button {
  padding: 4px 11px;
  border-radius: 10px;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-3);
}

.mseg button.on {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-card);
}

.pane {
  flex: 1;
  min-height: 0;
  gap: 14px;
  padding: 18px 28px calc(30px + var(--safe-bottom));
  overflow-y: auto;
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

.gbtn {
  align-self: center;
  min-width: 64px;
  height: 44px;
  border-radius: 22px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
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

.gobtn {
  width: 216px;
  height: 216px;
  margin-top: 10px;
  border-radius: 50%;
  border: 3px solid var(--c-exercise);
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

/* 双配速对照卡：瞬时（呼吸点 · 活的）｜平均（更重 · 稳的） */
.pace {
  width: 100%;
  background: var(--surface);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-card);
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

/* 按钮 */
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

.ghost {
  height: 50px;
  border-radius: 25px;
  padding: 0 24px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
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
