<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, Ellipsis } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import CountdownOverlay from '@/components/common/CountdownOverlay.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import ExerciseDetailDrawer from '@/components/exercise/ExerciseDetailDrawer.vue'
import MuscleMap from '@/components/exercise/MuscleMap.vue'
import SessionBigNumberInput from '@/components/exercise/SessionBigNumberInput.vue'
import SessionCourseDrawer from '@/components/exercise/SessionCourseDrawer.vue'
import { resolveActivation } from '@/config/muscles'
import { useSessionStore } from '@/stores/session'
import { workoutRuntime } from '@/system/workoutRuntime'
import { useToast } from '@/composables/useToast'
import {
  closeImmersive,
  closeImmersiveNow,
  immersiveClosing,
  immersiveOpen,
  immersiveOpenSeq,
  immersiveOrigin,
  settleClosed,
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
const router = useRouter()
const { toast } = useToast()

const endOpen = ref(false)
const restSheetOpen = ref(false)
const moreOpen = ref(false)
const tempRestSheetOpen = ref(false)
const detailOpen = ref(false)
const courseOpen = ref(false)

/** 重量显示：整数不带小数，62.5 保留一位 */
function fmtKg(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 上次做组参照（渐进超负荷对照） */
const lastRef = computed(() => s.lastWeights[s.currentEx?.name ?? ''])

const WEIGHT_STEP = 2.5

/** 当前待做的激活热身组定义（热身页据此预填并展示建议值） */
const curWarmup = computed(() => {
  const ex = s.currentEx
  if (!ex?.warmups?.length) return null
  return ex.warmups[Math.min(s.warmupDone(ex), ex.warmups.length - 1)] ?? null
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

interface ProgressCell {
  grp: boolean // 动作分组间的缝
  on: boolean // 已完成
  skip: boolean // 已跳过（未做 / 不统计）
  cur: boolean // 呼吸提示：下一组
}

/** 直接消费 store 的全课组清单：跳过与完成用同一份状态，避免两处各算一套 */
const cells = computed<ProgressCell[]>(() =>
  s.setSlots.map((slot, i) => ({
    grp: slot.setNo === 1 && i > 0,
    on: slot.state === 'done',
    skip: slot.state === 'skipped',
    cur: slot.state === 'current',
  })),
)

/* ---------- 坞与内容派生 ---------- */

const dockMode = computed<'warmup' | 'exercise' | 'rest' | 'timed' | 'none'>(() => {
  if (s.phase === 'warmup' && s.currentEx) return 'warmup'
  if (s.phase === 'exercise' && s.currentEx) return 'exercise'
  if (s.phase === 'rest') return 'rest'
  if (s.phase === 'timed-run') return 'timed'
  return 'none'
})

/** 坞内组格的当前序号：exercise 用 setIndex；rest 中下一组 = 已完成 + 1 */
const curTile = computed(() => (s.phase === 'exercise' ? s.setIndex : s.exDoneSets.filter((d) => !d.warmup).length + 1))

/** 当前动作已完成正式组数（热身行不计入组格） */
const workingDone = computed(() => s.exDoneSets.filter((d) => !d.warmup).length)

const nextEx = computed(() => s.plan?.exercises[s.exIndex + 1] ?? null)

/** 当前动作的肌群激活表（显式 muscles 优先，否则按动作名关键词匹配；均无 → 隐藏卡片） */
const activation = computed(() => s.currentEx?.muscles ?? resolveActivation(s.currentEx?.name))

const nextExDesc = computed(() => {
  const n = nextEx.value
  if (!n) return ''
  const per =
    n.reps != null ? `${n.reps} 次` : n.targetSec != null ? `${n.targetSec} 秒` : n.durationMin != null ? `${n.durationMin} 分钟` : ''
  return `${s.effSets(n)} 组${per ? ` · ${per}` : ''}`
})

const restMetaText = computed(() => {
  if (s.restWarmup) return '激活热身组间 · 准备下一次小重量激活'
  if (s.restIsTemp) return '临时休息 · 结束后继续当前训练'
    if (s.restTargetIsNextSet) {
      const parts = [`下一组 · 第 ${s.setIndex + 1} 组`]
      if (s.reps != null) parts.push(`${s.reps} 次`)
      if (s.weight > 0) parts.push(`${fmtKg(s.weight)} kg`)
      return parts.join(' · ')
    }
  return `下一个 · ${nextEx.value?.name ?? ''}`
})

const restSheetTitle = computed(() => `还要休息多久？剩余 ${s.restLeft} 秒`)

const REST_ADD_ACTIONS = [
  { label: '+ 15 秒', value: '15' },
  { label: '+ 30 秒', value: '30' },
  { label: '+ 60 秒', value: '60' },
  { label: '+ 2 分钟', value: '120' },
]

/* ---------- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 ---------- */

const MORE_TITLE = computed(() => `更多 · ${s.currentEx?.name ?? '训练中'}`)

/** 跳过当前组只在真正「手上有一组」的阶段出现：热身态有专门的跳过热身，休息态当前组已经做完了 */
const CAN_SKIP_PHASES = ['exercise', 'timed-ready', 'timed-run'] as const

const MORE_ACTIONS = computed(() => {
  const list: { label: string; value: string; danger?: boolean }[] = []
  if (CAN_SKIP_PHASES.includes(s.phase as (typeof CAN_SKIP_PHASES)[number])) {
    list.push({ label: '跳过当前组', value: 'skip-set' })
  }
  list.push(
    { label: '临时休息', value: 'temp-rest' },
    { label: '再加一组', value: 'extra-set' },
    { label: '上一组（重做）', value: 'redo-last' },
    { label: '当前动作详解', value: 'detail' },
  )
  return list
})

const TEMP_REST_ACTIONS = [
  { label: '1 分钟', value: '1' },
  { label: '2 分钟', value: '2' },
  { label: '3 分钟', value: '3' },
  { label: '5 分钟', value: '5' },
  { label: '10 分钟', value: '10' },
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
  } else if (value === 'temp-rest') {
    if (s.phase === 'rest') toast('已在休息中，可用休息页加时')
    else tempRestSheetOpen.value = true
  } else if (value === 'extra-set') {
    const ex = s.currentEx
    if (!ex) return
    s.addExtraSet()
    toast(`已加练 1 组 · 「${ex.name}」共 ${s.effSets(ex)} 组`)
  } else if (value === 'redo-last') {
    if (!s.redoLastSet()) toast('还没有已完成的组')
  } else if (value === 'detail') {
    detailOpen.value = true
  }
}

function onTempRestPick(value: string): void {
  const min = Number(value)
  if (!Number.isFinite(min) || min <= 0) return
  if (s.startTempRest(min)) toast(`临时休息 ${min} 分钟`)
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

let layerAnim: Animation | null = null
let fadeAnim: Animation | null = null

const EXPAND_MS = 480
const COLLAPSE_MS = 400
/** M3 emphasized 近似：起始快、收尾缓，形变块有「被拉出来」的分量感 */
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function stopAnims(): void {
  layerAnim?.cancel()
  fadeAnim?.cancel()
  layerAnim = null
  fadeAnim = null
}

/** 有效形变锚点：悬浮条 hidden / 尺寸异常时兜底为屏幕中央卡片（课程页直接开课等场景） */
function originAnchor(): { rect: DOMRect; radius: number } {
  const el = immersiveOrigin()
  if (el) {
    const r = el.getBoundingClientRect()
    if (r.width > 4 && r.height > 4) {
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius)
      return { rect: r, radius: Number.isFinite(radius) ? radius : 16 }
    }
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(300, vw * 0.6)
  return {
    rect: new DOMRect((vw - w) / 2, (vh - 120) / 2, w, 120),
    radius: 28,
  }
}

/** 全屏层 → 目标 rect：origin 左上 + scale 后左上不动，再平移落位（层恒为全屏尺寸） */
function squashTransform(rect: DOMRect): string {
  const sx = rect.width / window.innerWidth
  const sy = rect.height / window.innerHeight
  return `translate(${rect.left}px, ${rect.top}px) scale(${sx}, ${sy})`
}

/** 非均匀缩放下把圆角按轴补偿成椭圆，起始帧恰为浮窗圆角的视觉半径 */
function squashRadius(rect: DOMRect, radius: number): string {
  const sx = rect.width / window.innerWidth
  const sy = rect.height / window.innerHeight
  return `${radius / sx}px / ${radius / sy}px`
}

/** 打断接续：读当前实时帧值作为起点，形变途中反转不跳变 */
function currentLayerState(): { transform: string; borderRadius: string } {
  const cs = getComputedStyle(layerEl.value!)
  return { transform: cs.transform, borderRadius: cs.borderRadius }
}

function currentFade(): number {
  return parseFloat(getComputedStyle(fadeEl.value!).opacity)
}

function playExpand(): void {
  if (!layerEl.value || !fadeEl.value || reducedMotion()) return
  stopAnims()
  const { rect, radius } = originAnchor()
  layerAnim = layerEl.value.animate(
    [
      { transform: squashTransform(rect), borderRadius: squashRadius(rect, radius) },
      { transform: 'translate(0px, 0px) scale(1, 1)', borderRadius: '0px' },
    ],
    { duration: EXPAND_MS, easing: EASE },
  )
  layerAnim.onfinish = () => stopAnims()
  // 内容与不透明底一起淡入：形变初期只见材质壳长大，内容随后浮现
  fadeAnim = fadeEl.value.animate([{ opacity: currentFade() }, { opacity: 1 }], {
    duration: 260,
    delay: 70,
    easing: 'ease-out',
    fill: 'both',
  })
}

function playCollapse(): void {
  if (!layerEl.value || !fadeEl.value) return
  if (reducedMotion()) {
    settleClosed()
    return
  }
  stopAnims()
  const { rect, radius } = originAnchor()
  const cur = currentLayerState()
  layerAnim = layerEl.value.animate(
    [
      { transform: cur.transform, borderRadius: cur.borderRadius },
      { transform: squashTransform(rect), borderRadius: squashRadius(rect, radius) },
    ],
    { duration: COLLAPSE_MS, easing: EASE },
  )
  fadeAnim = fadeEl.value.animate([{ opacity: currentFade() }, { opacity: 0 }], {
    duration: Math.round(COLLAPSE_MS * 0.45),
    easing: 'ease-out',
    fill: 'both',
  })
  layerAnim.onfinish = () => {
    // cancel 回恒等基态与置 closed 隐藏在同一任务帧，无中间渲染
    stopAnims()
    settleClosed()
  }
}

// flush:'post' 保证展开时层已随 v-show 显示、收起时悬浮条已恢复可量
watch(immersiveOpenSeq, () => playExpand(), { flush: 'post' })
watch(immersiveClosing, (closing) => {
  if (closing) playCollapse()
})
watch(immersiveOpen, (open) => {
  if (!open) stopAnims()
})
</script>

<template>
  <!-- 沉浸层根：形变壳（transform/border-radius 由 container transform 动画驱动，静止恒为全屏） -->
  <div v-show="immersiveOpen" ref="layerEl" class="session-layer">
    <div ref="fadeEl" class="session-page">
      <!-- 顶部：收起 / 进度 / 结束键 -->
      <header class="shead row between">
        <button class="min" aria-label="收起运动模式" @click="minimize">
          <ChevronDown :size="20" /> 收起
        </button>
        <!-- 组数胶囊：点击唤起全课浏览抽屉（逐组进度 / 跳至该组 / 换动作） -->
        <button class="pcapsule" aria-label="查看全课程进度" @click="courseOpen = true">
          <span class="num">{{ s.doneCount }}/{{ s.totalCount }}</span>
          <span class="punit">组</span>
          <ChevronRight :size="13" class="chev" />
        </button>
        <button class="end" @click="endOpen = true">结束</button>
      </header>

      <p v-if="s.persistError" class="warn">⚠ 进度同步失败：{{ s.persistError }}</p>

      <!-- 全课进度格条：每格一组，动作分组留缝，下一组呼吸 -->
      <div v-if="cells.length" class="progwrap">
        <div class="obar">
          <i
            v-for="(c, i) in cells"
            :key="i"
            :class="{ grp: c.grp, on: c.on, skip: c.skip, cur: c.cur }"
          />
        </div>
      </div>

      <main class="scrollbody">
        <!-- 激活热身：小重量找发力感 / 复合动作渐进 ramp-up -->
        <div v-if="s.phase === 'warmup' && s.currentEx" class="pane col center">
          <p class="eyebrow">激活热身 · 第 {{ s.warmupDone(s.currentEx) + 1 }} / {{ s.currentEx.warmups!.length }} 组</p>
          <h1 class="actname">{{ s.currentEx.name }}</h1>
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

          <!-- 热身重量同样可现场调整：默认预填该组建议重量，完成即按实际重量登记 -->
          <div class="weightcard">
            <SessionBigNumberInput
              :model-value="s.weight"
              label="热身重量"
              unit="kg"
              :step="WEIGHT_STEP"
              :precision="1"
              :max="999"
              @update:model-value="onWeight"
            />
            <div v-if="curWarmup" class="wchips row center">
              <button class="wchip num" :aria-label="`设为建议重量 ${fmtKg(curWarmup.weightKg)} 公斤`" @click="onWeight(curWarmup.weightKg)">
                建议 {{ fmtKg(curWarmup.weightKg) }}kg × {{ curWarmup.reps }}
              </button>
            </div>
            <p class="whint">热身组不计入组数与总容量，重量可按需调整</p>
          </div>

          <div v-if="activation" class="blockcard">
            <h3>肌群激活</h3>
            <MuscleMap :activation="activation" interactive />
          </div>

          <div v-if="s.currentEx.tips" class="blockcard">
            <h3>动作要点</h3>
            <p>{{ s.currentEx.tips }}</p>
          </div>
        </div>

        <!-- 动作中：名称 hero ＋ 重量输入 ＋ 次数输入 ＋ 要点 ＋ 接下来 -->
        <div v-else-if="s.phase === 'exercise' && s.currentEx" class="pane col center">
          <p class="eyebrow">当前动作 · 第 {{ s.setIndex }} / {{ s.effSets(s.currentEx) }} 组</p>
          <h1 class="actname">{{ s.currentEx.name }}</h1>

          <!-- 重量登记：数字可点键入，±2.5kg 微调；完成本组即记录当前重量 -->
          <div class="weightcard">
            <SessionBigNumberInput
              :model-value="s.weight"
              label="重量"
              unit="kg"
              :step="WEIGHT_STEP"
              :precision="1"
              :max="999"
              @update:model-value="onWeight"
            />
            <div v-if="lastRef || s.currentEx.weightKg != null" class="wchips row center">
              <button v-if="lastRef" class="wchip num" :aria-label="`设为上次重量 ${fmtKg(lastRef.weightKg)} 公斤`" @click="onWeight(lastRef.weightKg)">
                上次 {{ fmtKg(lastRef.weightKg) }}kg{{ lastRef.reps != null ? ` × ${lastRef.reps}` : '' }}
              </button>
              <button v-if="s.currentEx.weightKg != null" class="wchip num" :aria-label="`设为计划重量 ${fmtKg(s.currentEx.weightKg)} 公斤`" @click="onWeight(s.currentEx.weightKg)">
                计划 {{ fmtKg(s.currentEx.weightKg) }}kg
              </button>
            </div>
          </div>

          <!-- 次数：同样可点键入，登记的是实际完成次数（与计划不同也能如实记录） -->
          <SessionBigNumberInput
            size="lg"
            :model-value="s.reps"
            label="次数"
            unit="次"
            :step="1"
            :max="999"
            @update:model-value="onReps"
          />

          <div v-if="activation" class="blockcard">
            <h3>肌群激活</h3>
            <MuscleMap :activation="activation" interactive />
          </div>

          <div v-if="s.currentEx.tips" class="blockcard">
            <h3>动作要点</h3>
            <p>{{ s.currentEx.tips }}</p>
          </div>

          <div v-if="nextEx" class="blockcard">
            <h3>接下来</h3>
            <p class="nextrow">▸ 下一动作 · <b>{{ nextEx.name }}</b> · {{ nextExDesc }}</p>
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
          <h1 class="actname">{{ s.currentEx.name }}</h1>
          <p class="meta">
            目标
            {{ s.currentEx.kind === 'timed' ? `${s.currentEx.targetSec}s × ${s.currentEx.sets} 组` : `${s.currentEx.durationMin} 分钟` }}
            <template v-if="s.currentEx.kind === 'timed'"> · 组间休息 {{ s.currentEx.restSec }}s</template>
          </p>
          <div v-if="activation" class="blockcard">
            <h3>肌群激活</h3>
            <MuscleMap :activation="activation" interactive />
          </div>
          <button class="readybtn" @click="s.prepareTimed()">我准备好了</button>
          <p class="hint">准备好后点击开始倒数</p>
        </div>

        <!-- 计时进行中 -->
        <div v-else-if="s.phase === 'timed-run'" class="pane col center">
          <RingProgress :value="timedProgress" color-var="--c-intake" :size="248" :stroke="15">
            <b class="num timernum">{{ timedText }}</b>
            <span class="hint">目标 {{ timedTargetText }}</span>
          </RingProgress>
        </div>

        <!-- 总结 -->
        <div v-else-if="s.phase === 'summary'" class="pane col center">
          <span class="doneemoji">🎉</span>
          <p class="donetitle">{{ s.plan?.name }}完成</p>
          <p class="num donemeta">
            {{ s.doneCount }}/{{ s.totalCount }} 组
            <template v-if="s.totalVolume > 0"> · 总容量约 {{ s.totalVolume }} kg</template>
            · 用时约 {{ s.durationMin }} 分钟 · 约 {{ s.estimateKcalValue }} 大卡
          </p>
          <button class="primary" @click="saveNow">保存训练</button>
          <button class="ghost danger" @click="endOpen = true">放弃不保存</button>
        </div>
      </main>

      <!-- 底部操作坞：热身态=激活格；组格即完成控件；休息态 = 时长抽屉 ＋ 跳过 -->
      <div v-if="dockMode !== 'none'" class="dock col">
        <template v-if="dockMode === 'warmup'">
          <div class="tiles row">
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
          </div>
          <div class="drow row">
            <button class="iconbtn" aria-label="更多功能" @click="moreOpen = true">
              <Ellipsis :size="24" />
            </button>
            <button class="ghost flex-1" @click="s.skipWarmup()">跳过热身</button>
            <button class="primary" @click="s.completeWarmup()">完成热身组</button>
          </div>
        </template>

        <template v-else-if="dockMode === 'exercise'">
          <div class="tiles row">
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
          </div>
          <div class="drow row">
            <button class="iconbtn" aria-label="更多功能" @click="moreOpen = true">
              <Ellipsis :size="24" />
            </button>
            <button class="primary flex-1" @click="s.completeSet()">完成第 {{ s.setIndex }} 组</button>
          </div>
        </template>

        <template v-else-if="dockMode === 'rest'">
          <div class="drow row">
            <button class="iconbtn" aria-label="调整休息时长" @click="restSheetOpen = true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="13.5" r="7.5" />
                <path d="M11 13.5V9.5" />
                <path d="M9 2.5h4" />
                <path d="M18.5 4.5h4" />
                <path d="M20.5 2.5v4" />
              </svg>
            </button>
            <button class="iconbtn" aria-label="更多功能" @click="moreOpen = true">
              <Ellipsis :size="24" />
            </button>
            <button class="primary flex-1" @click="s.skipRest()">
              {{ s.restIsTemp ? '继续训练' : s.restTargetIsNextSet ? '跳过休息' : '开始下一动作' }}
            </button>
          </div>
        </template>

        <template v-else-if="dockMode === 'timed'">
          <div class="drow row">
            <button class="iconbtn" aria-label="更多功能" @click="moreOpen = true">
              <Ellipsis :size="24" />
            </button>
            <button class="ghost danger" @click="s.abortTimed()">放弃</button>
            <button class="primary flex-1" @click="s.finishTimed()">完成</button>
          </div>
        </template>
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

      <!-- 休息时长抽屉：图标钮唤起 -->
      <ActionSheet
        :open="restSheetOpen"
        :title="restSheetTitle"
        :actions="REST_ADD_ACTIONS"
        @select="onRestAdd"
        @close="restSheetOpen = false"
      />

      <!-- 更多菜单：临时休息 / 再加一组 / 上一组 / 当前动作详解 -->
      <ActionSheet
        :open="moreOpen"
        :title="MORE_TITLE"
        :actions="MORE_ACTIONS"
        @select="onMorePick"
        @close="moreOpen = false"
      />

      <!-- 临时休息：指定分钟计时 -->
      <ActionSheet
        :open="tempRestSheetOpen"
        title="临时休息多久？"
        :actions="TEMP_REST_ACTIONS"
        @select="onTempRestPick"
        @close="tempRestSheetOpen = false"
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
   静止时恒为全屏恒等。背景与毛玻璃与悬浮条同材质，形变首尾帧视觉连续。 */
.session-layer {
  position: fixed;
  inset: 0;
  z-index: 80; /* 覆盖 TabBar(60) 与全部页面内容 */
  overflow: hidden;
  transform-origin: 0 0;
  will-change: transform;
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

@media (prefers-reduced-transparency: reduce) {
  .session-layer {
    background: var(--bg);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

/* 淡入层：不透明底 + 全部内容的统一 opacity 载体——形变初期只见材质壳
   长大，内容随后浮现；收起时先淡出内容再缩回，压扁过程不可见 */
.session-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  /* 层定位不随 .app-frame 偏移，顶部安全区自行处理 */
  padding-top: var(--safe-top);
}

/* 顶部栏 */
.shead {
  flex: none;
  height: 54px;
  padding: 0 18px;
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 0.5px solid var(--line);
}

.min {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
}

.end {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--danger);
  padding: 8px 4px;
}

/* 组数胶囊：点击进全课抽屉；› 提示可展开 */
.pcapsule {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 30px;
  padding: 0 8px 0 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.pcapsule:active {
  transform: scale(0.94);
}

.punit {
  margin-right: 1px;
}

.pcapsule .chev {
  color: var(--text-3);
}

.warn {
  flex: none;
  text-align: center;
  padding: 4px;
  font-size: var(--fs-micro);
  color: var(--warn);
  background: rgba(255, 149, 0, 0.14);
}

/* 全课进度格条 */
.progwrap {
  flex: none;
  padding: 12px 18px 11px;
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 0.5px solid var(--line);
}

.obar {
  display: flex;
  gap: 2.5px;
}

.obar i {
  flex: 1;
  height: 8px;
  border-radius: 3px;
  background: var(--surface-2);
  transition: background var(--dur-base) var(--ease-standard);
}

.obar i.grp {
  margin-left: 6px; /* 动作分组之间的缝 */
}

.obar i.on {
  background: var(--c-exercise);
}

/* 跳过的组：压暗留在原位，一眼看出「这组没做」且不计入统计 */
.obar i.skip {
  background: var(--line-strong);
}

.obar i.cur {
  background: var(--c-exercise-soft);
  animation: cellbreath 1.6s infinite;
}

@keyframes cellbreath {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* 内容区 */
.scrollbody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.pane {
  min-height: 100%;
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

/* 重量 / 次数输入卡：数字与步进由 SessionBigNumberInput 负责，这里只管容器与参照 chips */
.weightcard {
  width: min(360px, 100%);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.weightcard > :deep(.biginput) {
  width: 100%;
}

.whint {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.wchips {
  gap: 8px;
  flex-wrap: wrap;
}

.wchip {
  padding: 6px 13px;
  border-radius: var(--radius-full);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-size: var(--fs-caption);
  font-weight: 600;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.wchip:active {
  transform: scale(0.94);
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
  background: var(--surface);
  box-shadow: var(--shadow-card);
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
  box-shadow: none;
}

/* 热身组格：重量标注，小一号 */
.dtile.wtile {
  height: 52px;
  font-size: var(--fs-body);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin-top: 8px;
}

/* 要点 / 接下来 卡片 */
.blockcard {
  width: min(360px, 100%);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
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

/* 计时准备 */
.readybtn {
  width: 216px;
  height: 216px;
  margin-top: 14px;
  border-radius: 50%;
  border: 3px solid var(--text-1);
  font-size: var(--fs-title2);
  font-weight: 600;
  color: var(--text-1);
  transition: all var(--dur-base) var(--ease-standard);
}

.readybtn:hover {
  background: var(--text-1);
  color: var(--bg);
}

.readybtn:active {
  transform: scale(0.95);
}

/* 计时中 */
.timernum {
  font-size: 64px;
  font-weight: 200;
  letter-spacing: -2.5px;
  line-height: 1;
}

/* ---------- 底部操作坞 ---------- */
.dock {
  flex: none;
  gap: 12px;
  padding: 12px 18px calc(14px + var(--safe-bottom));
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-top: 0.5px solid var(--line);
}

.drow {
  gap: 14px;
  width: 100%;
}

/* 坞内主按钮随行伸缩：休息态两枚图标钮 + 主键在窄屏也要放得下；
   热身坞三键并排（图标 + 跳过 + 完成），收窄内边距避免 390px 挤爆 */
.drow .primary {
  min-width: 0;
  padding: 0 26px;
}

/* 组格矩阵：点当前格 = 完成该组 */
.tiles {
  justify-content: center;
  gap: 12px;
}

.dtile {
  width: 58px;
  height: 58px;
  border: 2px solid transparent;
  border-radius: 17px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-title2);
  font-weight: 700;
  color: var(--text-2);
  cursor: default;
  transition: all var(--dur-base) var(--ease-standard);
}

.dtile.done {
  background: var(--c-exercise-soft);
  color: #3d7a00;
  box-shadow: none;
}

.dtile.cur {
  background: var(--text-1);
  color: var(--bg);
  box-shadow: 0 6px 18px rgba(29, 29, 31, 0.3);
  cursor: pointer;
}

.dtile.cur:active {
  transform: scale(0.92);
}

@media (prefers-color-scheme: dark) {
  .dtile.done {
    color: var(--c-exercise);
  }
}

/* 主按钮 */
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
  transition: transform var(--dur-fast) var(--ease-standard);
}

.primary:active {
  transform: scale(0.96);
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

/* 休息时长图标钮 */
.iconbtn {
  width: 54px;
  height: 54px;
  flex: none;
  border-radius: 27px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.iconbtn:active {
  transform: scale(0.92);
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
