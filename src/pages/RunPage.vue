<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, Play } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useRunStore, fmtClock, fmtPace } from '@/stores/run'
import { workoutRuntime } from '@/system/workoutRuntime'
import { openImmersive } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'
import { projectTrack } from '@/utils/geo'

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

/* ---------- 轨迹投影：经纬度 → 暗区 SVG 视口（共享实现见 utils/geo.ts） ---------- */

const VIEW_W = 480
const VIEW_H = 320
const VIEW_PAD = 30

const routeView = computed(() => projectTrack(r.trackPoints, VIEW_W, VIEW_H, VIEW_PAD))

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
    <!-- ========== 暗区 · 轨迹剧场 ========== -->
    <section class="hero">
      <svg class="map" viewBox="0 0 480 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path v-if="routeView.d" class="route" :d="routeView.d" />
        <circle v-if="routeView.start" class="mk-start" :cx="routeView.start.x" :cy="routeView.start.y" r="5.5" />
        <g v-if="routeView.last">
          <circle class="mk-pulse" :cx="routeView.last.x" :cy="routeView.last.y" r="7" />
          <circle class="mk-dot" :cx="routeView.last.x" :cy="routeView.last.y" r="7" />
        </g>
      </svg>
      <p v-if="!routeView.d && heroWaitText" class="hero-wait">{{ heroWaitText }}</p>

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

    <!-- ========== 亮区 ========== -->
    <main class="bright col">
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

/* ---------- 暗区 · 轨迹剧场 ---------- */
.hero {
  position: relative;
  flex: 0 0 42%;
  min-height: 264px;
  background: var(--hero-bg);
  overflow: hidden;
  transition:
    flex-basis var(--dur-sheet) var(--ease-standard),
    filter var(--dur-sheet) var(--ease-standard);
}

.run-page.ready .hero {
  flex-basis: 20%;
  min-height: 132px;
}

.run-page.summary .hero {
  flex-basis: 30%;
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
  top: 0;
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
  bottom: 14px;
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
  bottom: 14px;
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
  top: 50%;
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
  flex: none;
  text-align: center;
  padding: 4px;
  font-size: var(--fs-micro);
  color: var(--warn);
  background: rgba(255, 149, 0, 0.14);
}

/* ---------- 亮区 ---------- */
.bright {
  flex: 1;
  min-height: 0;
}

.pane {
  height: 100%;
  gap: 14px;
  padding: 24px 28px calc(30px + var(--safe-bottom));
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

/* 进行中 */
.live {
  justify-content: center;
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
