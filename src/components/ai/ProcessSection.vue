<script setup lang="ts">
/**
 * ProcessSection —— 推理过程 + 工具调用的合并展示区块（照搬 EffiBuddy 同名组件）
 *
 * 设计目标：让 agent 回复像文档一样简洁——
 * - 推理与工具调用合并为单行摘要标题（"已思考 8 秒 · 使用了 3 个工具"）
 * - 进行中（思考中 / 工具执行中）自动展开；仅在过程彻底结束
 *   （正文已输出 / 流已结束）后自动折叠一次。
 *   连续多轮思考+工具（期间无正文）保持展开，避免每轮结束折叠、
 *   下一轮思考又重新展开的抖动——直到输出一次正文才合并一次。
 * - 展开后：按流式到达顺序穿插展示思考文字与工具执行结果（segments），
 *   工具结果直接嵌在思考文字之间，而非与思考文字隔开单独成块；
 *   点击工具行可弹出完整参数与返回结果
 * - 点击标题行可随时手动展开/折叠
 */
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { animate } from 'animejs'
import { Brain, ChevronDown } from 'lucide-vue-next'
import ToolCallGroup from './ToolCallGroup.vue'
import { perfDegraded } from '@/system/perf'
import type { ProcessSegment } from '@/types'

const props = withDefaults(
  defineProps<{
    /** 推理过程段（思考文字与工具调用按到达顺序穿插） */
    segments?: ProcessSegment[]
    /** 是否仍在思考中 */
    isThinking?: boolean
    /** 已完成思考段的累计秒数（由数据层持有，跨组件重建存活） */
    thinkingSec?: number
    /** 过程是否已彻底结束（正文已输出 / 流已结束）。
     *  仅在此为 true 且空闲时才自动折叠；连续多轮思考+工具（无正文）
     *  期间保持展开，避免每轮结束折叠、下一轮思考又重新展开的抖动。 */
    final?: boolean
  }>(),
  {
    segments: () => [],
    isThinking: false,
    thinkingSec: 0,
    final: false,
  },
)

// 工具调用记录（从 segments 提取，供忙碌判定与标题统计）
const toolCalls = computed(() =>
  props.segments.filter((s) => s.kind === 'tool').map((s) => s.call),
)

// 是否忙碌：思考中或仍有工具在执行
const busy = computed(
  () => props.isThinking || toolCalls.value.some((c) => c.pending),
)

// 历史消息（加载时已全部完成）默认折叠；进行中默认展开
const collapsed = ref(!busy.value)
const bodyRef = ref<HTMLElement | null>(null)

// 已思考时长（秒）：基准 props.thinkingSec 由数据层按消息 id 持有（跨组件重建存活），
// 思考中叠加本地实时秒数 liveElapsed（仅展示用；权威累计在数据层按时间戳进行）
const thinkStart = ref<number>(0)
const liveElapsed = ref<number>(0)
let tickTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.isThinking,
  (thinking) => {
    if (thinking) {
      thinkStart.value = Date.now()
      liveElapsed.value = 0
      startTicker()
    } else {
      stopTicker()
      thinkStart.value = 0
      liveElapsed.value = 0
    }
  },
  { immediate: true },
)

// 思考中每秒刷新"思考中 X 秒"文案
function startTicker(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    if (props.isThinking && thinkStart.value) {
      liveElapsed.value = Math.max(
        1,
        Math.round((Date.now() - thinkStart.value) / 1000),
      )
    }
  }, 1000)
}

function stopTicker(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

onUnmounted(() => {
  stopTicker()
  // 清理自动折叠定时器与进行中的伸开/闭合动画
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  stopBodyAnim()
})

// 进行中 → 展开；全部完成 → 短暂延迟后自动折叠
let collapseTimer: ReturnType<typeof setTimeout> | null = null

// 伸开/闭合动画的统一引用：快速 toggle、自动展开打断残留折叠动画时 pause
let bodyAnim: ReturnType<typeof animate> | null = null

// 无障碍：reduce 下不做位移/高度动画，直接瞬时切换
const reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// 免动画档：系统减弱动效，或运行时性能降级（system/perf）。
// 伸开/闭合补的是 maxHeight——每帧都要重排，是这里最贵的一段。
const skipAnim = computed(() => reducedMotion || perfDegraded.value)

/** 打断残留动画并释放内联 maxHeight（恢复 CSS 自然高度） */
function stopBodyAnim(): void {
  if (bodyAnim) {
    bodyAnim.pause()
    bodyAnim = null
  }
  const el = bodyRef.value
  if (el && el.style.maxHeight) el.style.maxHeight = ''
}

watch(
  busy,
  (b, was) => {
    if (collapseTimer) {
      clearTimeout(collapseTimer)
      collapseTimer = null
    }
    if (b && !was) {
      // 进行中 → 立即展开；先打断可能仍在运行的折叠动画（防内容被强制收起）
      stopBodyAnim()
      collapsed.value = false
    } else if (!b && was) {
      // 空闲：仅当过程彻底结束（正文已输出 / 流已结束）才自动折叠。
      // 连续多轮思考+工具（无正文）之间 busy 会短暂回落，此时不折叠，
      // 避免每轮结束收起、下一轮思考又重新展开的反复抖动。
      if (props.final) {
        collapseTimer = setTimeout(() => {
          collapseNow()
        }, 600)
      }
    }
  },
)

// 过程彻底结束（正文输出 / 流结束）且当前空闲：补一次自动折叠。
// 覆盖 busy 未再变化（如工具结果后正文到来，busy 早已为 false）的场景。
watch(
  () => props.final,
  (f, was) => {
    if (f && !was) {
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = null
      }
      collapseTimer = setTimeout(() => {
        collapseNow()
      }, 600)
    }
  },
)

function toggle(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  if (collapsed.value) expandNow()
  else collapseNow()
}

// 展开：打断残留折叠动画后，手动展开带 240ms 高度动画（ease out(3)），
// 完成后定位到底部；reduced-motion 下瞬时显示
function expandNow(): void {
  stopBodyAnim()
  collapsed.value = false
  nextTick(() => {
    const el = bodyRef.value
    if (!el) return
    if (skipAnim.value) {
      el.scrollTop = el.scrollHeight
      return
    }
    const target = el.scrollHeight
    el.style.maxHeight = '0px'
    void el.offsetHeight // 强制 reflow，确保动画从 0 起步
    bodyAnim = animate(el, {
      maxHeight: ['0px', `${target}px`],
      duration: 240,
      ease: 'out(3)',
      onComplete: () => {
        bodyAnim = null
        el.style.maxHeight = ''
        el.scrollTop = el.scrollHeight
      },
    })
  })
}

// 闭合：仅高度变小动画（不做透明度变化）。
// 起点用当前可视高度（offsetHeight）而非内容高度（scrollHeight）——
// max-height:320px 上限下二者不一致，用 scrollHeight 会让动画前段"假停顿"
function collapseNow(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  const el = bodyRef.value
  if (!el) {
    collapsed.value = true
    return
  }
  stopBodyAnim()
  if (skipAnim.value) {
    collapsed.value = true
    return
  }
  const start = Math.min(el.offsetHeight, el.scrollHeight)
  bodyAnim = animate(el, {
    maxHeight: [`${start}px`, '0px'],
    duration: 200,
    ease: 'inOut(2)',
    onComplete: () => {
      bodyAnim = null
      collapsed.value = true
      el.style.maxHeight = ''
    },
  })
}

// 内容签名：思考文字 / 工具状态变化时滚动到底部（流式跟随）
const contentSig = computed(() =>
  props.segments
    .map((s) =>
      s.kind === 'reasoning'
        ? s.text
        : `${s.call.toolName}:${s.call.result ?? ''}:${s.call.pending}`,
    )
    .join('\u0000'),
)
watch(contentSig, () => {
  if (collapsed.value) return
  nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// 标题摘要文案：推理时长 + 工具数量合并
const titleText = computed(() => {
  const parts: string[] = []
  if (props.isThinking) {
    // 累计已思考时长(数据层) + 当前段实时秒数：工具调用后新一轮思考不归零，连续递增
    const total = props.thinkingSec + liveElapsed.value
    parts.push(total > 0 ? `思考中 ${total} 秒` : '思考中')
  } else if (props.segments.some((s) => s.kind === 'reasoning' && s.text)) {
    parts.push(
      props.thinkingSec > 0 ? `已思考 ${props.thinkingSec} 秒` : '推理过程',
    )
  }
  if (toolCalls.value.length) {
    const pending = toolCalls.value.filter((c) => c.pending).length
    parts.push(
      pending > 0
        ? `执行工具中 ${toolCalls.value.length - pending}/${toolCalls.value.length}`
        : toolCalls.value.length === 1
          ? '使用了工具'
          : `使用了 ${toolCalls.value.length} 个工具`,
    )
  }
  return parts.join(' · ')
})
</script>

<template>
  <div class="process-section" :class="{ collapsed }">
    <!-- 合并标题行：点击切换折叠 -->
    <div class="process-header" @click="toggle">
      <span class="process-icon"><Brain :size="14" /></span>
      <span class="process-title">{{ titleText }}</span>
      <span v-if="busy" class="process-dots">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </span>
      <span class="process-arrow" :class="{ collapsed }">
        <ChevronDown :size="12" />
      </span>
    </div>

    <!-- 展开内容：思考文字与工具执行结果按到达顺序穿插展示 -->
    <div v-show="!collapsed" ref="bodyRef" class="process-body">
      <!-- 超范围平移层：到边拖动时内容位移；包裹层镜像弹性列布局，只承载 transform -->
      <div class="rubber-layer" data-rubber-content>
        <template v-for="(seg, i) in segments" :key="i">
          <div v-if="seg.kind === 'reasoning'" class="process-reasoning">{{ seg.text }}</div>
          <ToolCallGroup v-else :calls="[seg.call]" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 无卡片外观：以文档流形式融入 assistant 回复；
   左侧缩进与正文形成明确的层级区分 */
.process-section {
  padding-left: 2px;
  font-size: 13px;
  color: var(--text-3);
}

.process-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 28px;
  padding: 0 8px;
  margin-left: -8px;
  border-radius: var(--radius-m);
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: background 120ms ease;
}

.process-header:hover {
  background: var(--surface-2);
}

.process-icon {
  line-height: 1;
  color: var(--text-3);
}

.process-title {
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 进行中跳动的点 */
.process-dots {
  display: inline-flex;
  flex: none;
  gap: 3px;
}

.process-dots .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-3);
  animation: process-fade 1.2s infinite ease-in-out;
}

.process-dots .dot:nth-child(2) {
  animation-delay: 0.15s;
}

.process-dots .dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes process-fade {
  0%, 80%, 100% {
    opacity: 0.4;
  }
  40% {
    opacity: 1;
  }
}

.process-arrow {
  line-height: 1;
  flex: none;
  color: var(--text-3);
  transition: transform 150ms ease;
}

/* 折叠时箭头由下转右（chevron-down 旋转 -90°），带过渡 */
.process-arrow.collapsed {
  transform: rotate(-90deg);
}

/* 展开内容：左侧细线标识层级，缩进与上下 margin 加大，与标题行/正文明确区分；
   整块可滚动（思考 + 工具穿插后统一滚动），overflow-y:auto 供流式跟随；
   overflow:hidden 由折叠动画时临时覆盖（collapseNow 内联 maxHeight） */
.process-body {
  margin: 8px 0 6px 8px;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 超范围平移层：镜像 .process-body 的弹性列布局（只承载 transform，不改观感） */
.rubber-layer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.process-reasoning {
  padding: 2px 6px 2px 0;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.process-body::-webkit-scrollbar {
  width: 6px;
}

.process-body::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: var(--radius-s);
}

/* 无障碍：reduce 下禁用位移类动效（箭头旋转、圆点跳动） */
@media (prefers-reduced-motion: reduce) {
  .process-arrow {
    transition: none;
  }
  .process-dots .dot {
    animation: none;
  }
}
</style>
