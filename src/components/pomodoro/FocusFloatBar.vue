<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Expand, Maximize2, Pause, Play } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import GlassFilter from '@/components/common/GlassFilter.vue'
import { enterFocusImmersive } from '@/system/focusImmersive'
import { liquidGlass } from '@/system/perf'
import { useDragDock } from '@/composables/useDragDock'
import { usePomodoroStore } from '@/stores/pomodoro'

/**
 * 专注悬浮条：一轮专注「进行中 / 暂停未走完」时全应用常驻（App.vue 挂载，沉浸形态隐藏）。
 *
 * 这是专注域此前最大的产品缺口：番茄钟的计时**本来**就在切页后继续跑（store 是全局单例），
 * 但用户在任何别的页面都看不见它 —— 状态只被关在 /focus 专用页里。录音 / 语音 / 运动 /
 * 抢课四个域都已用「runtime 单例 + FloatBar 常驻」这一范式，专注缺的正是这一层。
 *
 * 与 ActiveWorkoutBar / RecordFloatBar 同构（结构三层：root 只管 fixed + z、.dock-pos 只被
 * 弹簧写 transform、.dock-body 承载材质与两层内容交叉淡变），并用同一套 useDragDock 拖拽停靠，
 * 但**独立持久化 key**（rein.fbar.dock.v1）—— 与录音 / 运动各停各位，互不挤占。
 * 条形态：状态点 + 相位文案 + 读数 + 暂停 / 继续 / 结束 / 进沉浸 / 打开专注页；拖到左右边缘
 * 收成 64px 方块泊车，轻点展开回条。
 *
 * 文案分两套口径（`settings.mode`）：倒计时才有「专注 / 休息」两个相位，正计时永不进休息 ——
 * 所以相位文案与结束确认都按方向分支，不能让正计时套上「结束就进休息」这类假承诺。
 */
const router = useRouter()
const pomo = usePomodoroStore()

const posEl = ref<HTMLElement | null>(null)
const { slot, form, pressing, dragging, onPointerDown, expandFromBlob } = useDragDock(posEl, {
  storageKey: 'rein.fbar.dock.v1',
})

/* 材质：超高 / 极致档换**真折射**，与悬浮运动条 / 录音条同一套做法（为什么这么做、
   以及三条边界见 ActiveWorkoutBar.vue 的那段注释）：把元素自己的 backdrop-filter 从 blur()
   换成 `url(#…)`，底 / 受光边 / 光学层继续由 `.glass-surface` 那套令牌给。滤镜定义在
   common/GlassFilter.vue，量尺默认是父元素（这条浮条的 .dock-body 自己）。 */
const glassFilterId = `glass-filter-${Math.random().toString(36).slice(2, 10)}`
const glassStyle = computed<Record<string, string> | undefined>(() => {
  if (!liquidGlass.value) return undefined
  const filter = `url(#${glassFilterId}) saturate(var(--glass-sat))`
  return { backdropFilter: filter, WebkitBackdropFilter: filter }
})

/** 计时方向。正计时没有休息相位（走满一个周期只记账、继续走），文案不能套倒计时那套 */
const upMode = computed(() => pomo.settings.mode === 'up')

/** 状态点：专注中走 --cat-work 呼吸、休息中 --cat-general、已暂停 --warn（色相只在色点上，不落到文字）。
 *  正计时只有专注一种相位，在走就是 work —— 与下面的文案分支同源 */
const dotClass = computed(() => {
  if (!pomo.running) return 'paused'
  return pomo.phase === 'focus' ? 'work' : 'brk'
})

/** 相位文案：与卡片同一套口径。倒计时照旧「专注中 / 休息中 / 已暂停」；
 *  正计时只有「在走」与「停着」两态，如实说「正计时」，别让它冒充「专注中」（那个词在
 *  倒计时里意味着「正在倒数」），也不会有「休息中」 */
const phaseLabel = computed(() => {
  if (upMode.value) return pomo.running ? '正计时中' : '正计时 · 已暂停'
  if (!pomo.running) return '已暂停'
  return pomo.phase === 'focus' ? '专注中' : '休息中'
})

/* 结束确认：与卡片同一套语义，标题说后果不说规定（文案即代价）。
   倒计时 · 专注：结束会记录这一轮的投入并进入休息，放弃则不留记录；
   倒计时 · 休息：`reset()` 是「跳过休息」——休息不计入记录，跳过不影响已保存的专注；
   正计时：永远不进休息 —— 结束只把这段累计专注收尾（走满的周期早已各记一颗，
   `endUpSession` 把剩下的零头按中断口径处理），放弃则整段不留记录。 */
const endOpen = ref(false)
const endTitle = computed(() => {
  if (upMode.value) return '结束正计时会记录这段累计专注；放弃则不留记录'
  return pomo.phase === 'focus'
    ? '现在结束会记录这一轮的专注时长并进入休息；放弃则这一轮不留记录'
    : '现在是休息 —— 跳过休息会直接回到下一轮专注；休息不计入记录，跳过不影响已保存的专注'
})
const endActions = computed(() => {
  if (upMode.value) {
    return [
      { label: '结束并记录', value: 'end' },
      { label: '放弃（不留记录）', value: 'reset', danger: true },
    ]
  }
  return pomo.phase === 'focus'
    ? [
        { label: '结束并保留记录', value: 'end' },
        { label: '放弃这一轮（不保存）', value: 'reset', danger: true },
      ]
    : [{ label: '跳过休息', value: 'reset' }]
})
/** 结束按钮的文案随相位换：专注（含正计时）里是「结束」，倒计时的休息里其实是「跳过」 */
const endLabel = computed(() => (!upMode.value && pomo.phase === 'break' ? '跳过' : '结束'))

function onEndPick(value: string): void {
  if (value === 'end') void pomo.endRound()
  else if (value === 'reset') pomo.reset()
}

/** 暂停 / 继续：start() 幂等（已在跑就直接返回），暂停态再点即续走 */
function toggleRun(): void {
  if (pomo.running) pomo.pause()
  else pomo.start()
}

function openPage(): void {
  void router.push({ name: 'focus' })
}

/** 直接进沉浸层：浮条挂在全应用身上，「现在就专注」的入口该送到手边，
 *  不必先跳专注页再双击读数（卡片那边的双击手势留在卡片上）。
 *  沉浸层由 App.vue 全局挂载，不依赖当前路由；它一置位，本浮条按 base.css 的
 *  `html[data-focus-immersive]` 规则自行收起，不会与全屏层抢视线。 */
function enterImmersive(): void {
  enterFocusImmersive()
}
</script>

<template>
  <Transition name="fdock">
    <section
      v-if="pomo.active"
      class="fdock-root"
      :class="[`dock-${slot}`, { dragging }]"
    >
      <div ref="posEl" class="dock-pos">
        <div
          class="dock-body glass-surface"
          :class="[form === 'blob' ? 'is-blob' : 'is-bar', { pressing, dragging }]"
          :style="glassStyle"
          role="region"
          aria-label="专注计时"
          @pointerdown="onPointerDown"
        >
          <!-- 折射滤镜定义（不参与绘制，绝对定位）：只在超高档挂，量尺是这个 .dock-body -->
          <GlassFilter :id="glassFilterId" :enabled="liquidGlass" />

          <!-- 全宽条形态 -->
          <div class="layer layer-bar" :class="{ off: form !== 'bar' }">
            <button class="info row" type="button" @click="openPage">
              <span class="dot" :class="dotClass" />
              <b class="t">{{ phaseLabel }}</b>
              <span class="s num">{{ pomo.displayTime }}</span>
            </button>
            <div class="acts row">
              <button class="abtn main" type="button" @click="toggleRun">
                <component :is="pomo.running ? Pause : Play" :size="13" :stroke-width="2.6" />
                {{ pomo.running ? '暂停' : '继续' }}
              </button>
              <button class="abtn end" type="button" @click="endOpen = true">{{ endLabel }}</button>
              <button class="abtn ico" type="button" aria-label="打开专注页" @click="openPage">
                <Expand :size="15" :stroke-width="2.5" />
              </button>
              <!-- 进沉浸层（与「打开专注页」分开两颗：一个是去另一个页面，一个是就地放大，
                   两件事的目的地不同，合成一颗就得先猜用户想要哪个） -->
              <button
                class="abtn ico"
                type="button"
                aria-label="进入沉浸模式"
                @click="enterImmersive"
              >
                <Maximize2 :size="15" :stroke-width="2.5" />
              </button>
            </div>
          </div>

          <!-- 方块泊车形态：轻点展开回全宽条 -->
          <button
            class="layer layer-blob"
            :class="{ off: form !== 'blob' }"
            type="button"
            aria-label="展开专注控制"
            @click="expandFromBlob"
          >
            <span class="dot" :class="dotClass" />
            <b class="bt num">{{ pomo.displayTime }}</b>
          </button>
        </div>
      </div>

      <!-- 结束（二级确认）：与卡片同一套结束语义 -->
      <ActionSheet
        :open="endOpen"
        :title="endTitle"
        :actions="endActions"
        @select="onEndPick"
        @close="endOpen = false"
      />
    </section>
  </Transition>
</template>

<style scoped>
/* 与 RecordFloatBar 同构：root 只管 fixed 与 z 序，位移在 .dock-pos */
.fdock-root {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 59;
  pointer-events: none;
}

.fdock-root.dragging {
  z-index: 70;
}

.dock-pos {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}

/* 材质走全局 .glass-surface（与底部 Dock 同一份定义），这里只留几何与手感 */
.dock-body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-l);
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition:
    transform var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.dock-body.is-blob {
  width: 64px;
  height: 64px;
  padding: 0;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  border-radius: var(--radius-l);
}

.dock-body.pressing {
  transform: scale(0.97);
}

.dock-body.is-bar {
  width: calc(100vw - 24px);
  max-width: calc(var(--frame-max) - 24px);
}

.dock-body.dragging {
  transform: scale(1.03);
  box-shadow: var(--shadow-float-lift);
}

.layer {
  visibility: visible;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s;
}

.layer.off {
  opacity: 0;
  transform: scale(0.92);
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    visibility 0s linear var(--dur-fast);
}

.layer-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.layer-blob {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.bt {
  max-width: 100%;
  padding: 0 4px;
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 出入不对称：入场 250、退场 150（同向量同向，见下方 .fdock-*-from/to 的位移） */
.fdock-enter-active {
  transition: opacity var(--dur-base) var(--ease-sheet), transform var(--dur-base) var(--ease-sheet);
}

.fdock-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}

.fdock-enter-from,
.fdock-leave-to {
  opacity: 0;
}

.dock-bottom.fdock-enter-from,
.dock-bottom.fdock-leave-to {
  transform: translateY(18px);
}

.dock-top.fdock-enter-from,
.dock-top.fdock-leave-to {
  transform: translateY(-18px);
}

.dock-left.fdock-enter-from,
.dock-left.fdock-leave-to {
  transform: translateX(-14px);
}

.dock-right.fdock-enter-from,
.dock-right.fdock-leave-to {
  transform: translateX(14px);
}

.info {
  flex: 1;
  min-width: 0;
  gap: 9px;
  overflow: hidden;
  text-align: left;
  border-radius: var(--radius-m);
  padding: 2px;
  transition: background var(--dur-fast) var(--ease-standard);
}

.info:active {
  background: var(--surface-2);
}

.dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

/* 专注中：与运动条同一条呼吸动画（色相只在色点上，文字保持中性） */
.dot.work {
  background: var(--cat-work);
  box-shadow: 0 0 8px color-mix(in srgb, var(--cat-work) 65%, transparent);
  animation: fbreathe 1.6s infinite;
}

/* 休息中：中性灰，节律与专注区分开 —— 不呼吸（它不需要「正在计数」的紧迫感） */
.dot.brk {
  background: var(--cat-general);
}

.dot.paused {
  background: var(--warn);
}

@keyframes fbreathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.6);
    opacity: 0.5;
  }
}

.t {
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: 700;
  letter-spacing: -0.2px;
  color: var(--text-1);
  white-space: nowrap;
  /* 相位文案是这条里唯一长短随方向变的段（正计时的「正计时 · 已暂停」有 8 个字），
     而读数必须始终在场上。窄窗下让它自己截断，别把后面的 .s 顶出 .info 的裁剪边界
     （.info 只 overflow: hidden，flex 项默认 min-width: auto 不会缩） */
  overflow: hidden;
  text-overflow: ellipsis;
}

.s {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.acts {
  flex: none;
  gap: 7px;
}

.abtn {
  flex: none;
  height: 34px;
  padding: 0 13px;
  border-radius: var(--radius-m);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.abtn:active {
  transform: scale(0.94);
}

/* 主操作：与运动条的 .abtn.main 同一份（实底 label 反色） */
.abtn.main {
  background: var(--text-1);
  color: var(--bg);
}

.abtn.end {
  color: var(--danger-strong);
  background: var(--danger-soft);
}

.abtn.ico {
  width: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .fdock-enter-from,
  .fdock-leave-to {
    transform: none;
  }

  .fdock-enter-active,
  .fdock-leave-active {
    transition-duration: 150ms;
  }

  .layer,
  .layer.off {
    transform: none;
    transition-duration: 120ms;
  }

  .dock-body {
    transition: none;
  }

  .dot.work {
    animation: none;
  }
}
</style>
