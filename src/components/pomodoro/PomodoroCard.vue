<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ChevronDown, Pause, Play, Timer } from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
import RingProgress from '@/components/common/RingProgress.vue'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/** 番茄钟：环内倒计时，可关联一条今日待办；完成一轮自动进入休息。 */
const pomo = usePomodoroStore()
const todo = useTodoStore()

onMounted(() => {
  void pomo.loadToday()
  if (todo.dayTodos.length === 0) void todo.loadDay(todayStr())
})

/* ---------- 相位读数 ---------- */

/** 相位小字是**必读信息**（专注中 / 休息中 / 已暂停），走 --text-2 而不是三级灰 */
const phaseLabel = computed(() => {
  if (!pomo.running) return '已暂停'
  return pomo.phase === 'focus' ? '专注中' : '休息中'
})

/** 状态色点：专注中 = 专注模块 accent（--cat-work）呼吸点；休息中 = 中性 --cat-general；
 *  已暂停 = --warn。扫描到的圆点、图标、色点属配额允许的色相落点。 */
const phaseDot = computed(() => (pomo.running ? (pomo.phase === 'focus' ? 'live' : 'rest') : 'pause'))

/** 主按钮语义：跑着 = 暂停；停在半途 = 继续；尚未开始 = 开始 */
const mainLabel = computed(() => {
  if (pomo.running) return '暂停'
  return pomo.remainingSec < pomo.phaseTotalSec ? '继续' : '开始'
})

/* ---------- 关联待办 ---------- */

const linkedTodo = computed(() => todo.dayTodos.find((t) => t.id === pomo.linkedTodoId) ?? null)
/** 未选时给引导文案「在做哪件」（引导但不阻塞起跑）；已选时显示待办标题（超长省略） */
const pickLabel = computed(() => linkedTodo.value?.title ?? '在做哪件')

/** 菜单项：done 的待办不可选；已关联时补一条「不关联」 */
const todoMenu = computed<MenuItem[]>(() => {
  const items: MenuItem[] = todo.dayTodos
    .filter((t) => t.status !== 'done')
    .map((t) => ({ label: t.title, value: String(t.id) }))
  if (pomo.linkedTodoId != null) items.push({ label: '不关联待办', value: '' })
  return items
})
const todoMenuOpen = ref(false)
const pickBtn = ref<HTMLButtonElement | null>(null)

function onPickTodo(value: string): void {
  pomo.setLinkedTodo(value === '' ? null : Number(value))
}

/* ---------- 卡底口径 ---------- */

/** 完整段分钟数。store 只暴露了段数计数，分钟从唯一真源 todaySessions 派生，
 *  保证「完整段」与「中断段」两组分钟各自独立、不被混算 */
const doneMin = computed(() =>
  pomo.todaySessions.filter((s) => s.completed).reduce((a, s) => a + s.focusMin, 0),
)
const interruptedMin = computed(() =>
  pomo.todaySessions.filter((s) => !s.completed).reduce((a, s) => a + s.focusMin, 0),
)
const hasToday = computed(() => pomo.todayCompletedCount > 0 || pomo.todayInterruptedCount > 0)

/* ---------- 建议时长（循证：从近 7 天完成段中位数给建议，用户显式采纳才改） ---------- */

const showSuggest = computed(
  () => pomo.suggestedFocusMin != null && pomo.suggestedFocusMin !== pomo.settings.focusMin,
)
function adoptSuggest(): void {
  const v = pomo.suggestedFocusMin
  if (v != null) pomo.settings.focusMin = v
}

/* ---------- 结束流程 ---------- */

const endOpen = ref(false)
/** 本段已投入的秒数 */
const endElapsedSec = computed(() => Math.max(0, pomo.phaseTotalSec - pomo.remainingSec))
/** 是否够写一条中断记录：与 store 的 60 秒门槛同源，避免文案许下做不到的承诺 */
const endWillRecord = computed(() => endElapsedSec.value >= 60)
const endElapsedMin = computed(() => Math.max(1, Math.round(endElapsedSec.value / 60)))

/** 文案即代价（同 ActiveWorkoutBar）：说清记录 / 放弃各会拿走什么、留下什么。
 *  不足 1 分钟时 store 按误触处理、不写记录 —— 文案要如实说，不能让用户以为「记录了」。 */
const endTitle = computed(() =>
  endWillRecord.value
    ? `现在结束会把这一段记下来（${endElapsedMin.value} 分钟），然后进入休息；放弃则不留记录`
    : '还不到 1 分钟：结束不会留下记录。可以进入休息，或直接放弃这一轮',
)
const endActions = computed<{ label: string; value: string; danger?: boolean }[]>(() =>
  endWillRecord.value
    ? [
        { label: '记录这一段，进入休息', value: 'record' },
        { label: '放弃本轮（不留记录）', value: 'discard', danger: true },
      ]
    : [
        { label: '进入休息', value: 'record' },
        { label: '放弃这一轮', value: 'discard', danger: true },
      ],
)

/** 休息相位的「结束」= 跳过休息：直接 reset，无数据损失，不必再弹确认 */
function onEndClick(): void {
  if (pomo.phase === 'break') {
    pomo.reset()
    return
  }
  endOpen.value = true
}

function onEndPick(value: string): void {
  if (value === 'discard') pomo.reset()
  else void pomo.endRound()
}
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>番茄钟</h2>
      <span class="head-right">
        <!-- 胶囊只留「N 个番茄」（完整段条数）；轮次进度由圆点 + InfoHint 承载，
             不再把「本轮 X/N」塞进同一枚胶囊。圆点读 store 的 roundDots（唯一真源）。 -->
        <PillChip tone="muted" size="sm">
          <span class="num">{{ pomo.todayCompletedCount }}</span> 个番茄
          <span v-if="pomo.roundDots.length" class="dots" aria-hidden="true">
            <span v-for="(on, i) in pomo.roundDots" :key="i" class="rdot" :class="{ on }" />
          </span>
        </PillChip>
        <InfoHint title="轮次圆点">
          <p>每 {{ pomo.settings.roundsBeforeLongBreak }} 次专注后进入一次长休息。</p>
          <p>圆点记录本轮进度：点亮的是本轮已完成的次数，点满即进入长休息，之后重新开始点亮。</p>
          <p>轮数可以在设置里调整。</p>
        </InfoHint>
      </span>
    </header>

    <div class="col center body">
      <!-- 一域一 accent、休息用中性：专注环 = 专注模块自己的 --cat-work；
           休息环 = --cat-general（无域语义的中性灰，读作「不在专注」）——
           绝不给休息再找一支有域语义的彩（营养粉 / 运动绿都是错配）。 -->
      <RingProgress
        :value="pomo.progress"
        :color-var="pomo.phase === 'focus' ? '--cat-work' : '--cat-general'"
        :size="158"
        :stroke="11"
      >
        <!-- 展示级读数：--fs-display-m + 轻字重（与 CountdownOverlay 的 hero 读数同族）。
             letter-spacing -1px 是裸值、tokens.css 无对应令牌，保留原样、不自造令牌。 -->
        <b class="num time">{{ pomo.displayTime }}</b>
        <span class="phase">
          <i class="pdot" :class="phaseDot" aria-hidden="true" />
          {{ phaseLabel }}
        </span>
      </RingProgress>

      <!-- 休息相位：非屏幕恢复引导（注意力恢复理论），一句短提示、可跳过、不弹窗不强制 -->
      <p v-if="pomo.phase === 'break' && pomo.running" class="rest-tip">
        离开一下屏幕：站起来，看看远处，接杯水。
      </p>

      <div class="row controls">
        <button
          v-if="pomo.active"
          type="button"
          class="end"
          :aria-label="pomo.phase === 'break' ? '跳过休息' : '结束本轮'"
          @click="onEndClick"
        >
          {{ pomo.phase === 'break' ? '跳过休息' : '结束' }}
        </button>
        <button
          type="button"
          class="main"
          :aria-label="mainLabel"
          @click="pomo.running ? pomo.pause() : pomo.start()"
        >
          <Pause v-if="pomo.running" :size="24" />
          <Play v-else :size="24" style="margin-left: 3px" />
        </button>

        <!-- 关联待办：触发钮 + AppMenu 绑定式菜单（换掉原生 <select>）；
             一条待办都没有时不渲染为控件，降为一句引导、不阻塞起跑 -->
        <button
          v-if="todoMenu.length"
          ref="pickBtn"
          type="button"
          class="pick"
          aria-haspopup="menu"
          :aria-expanded="todoMenuOpen"
          :aria-label="`在做哪件：${pickLabel}`"
          @click="todoMenuOpen = true"
        >
          <span class="pick-t">{{ pickLabel }}</span>
          <ChevronDown :size="16" class="pick-c" />
        </button>
        <span v-else class="pick pick-idle">
          <span class="pick-t">在做哪件</span>
        </span>
        <AppMenu
          v-if="todoMenu.length"
          :open="todoMenuOpen"
          :anchor="pickBtn"
          :actions="todoMenu"
          title="在做哪件"
          @select="onPickTodo"
          @close="todoMenuOpen = false"
        />
      </div>

      <!-- 建议时长：循证给值，用户点了才写进设置（不自动改） -->
      <PillChip
        v-if="showSuggest"
        as="button"
        tone="action"
        size="sm"
        :aria-label="`采纳建议：专注 ${pomo.suggestedFocusMin} 分钟`"
        @click="adoptSuggest"
      >
        试试 <span class="num">{{ pomo.suggestedFocusMin }}</span> 分钟
      </PillChip>

      <!-- 卡底：有记录时诚实分账（完整段 / 中断段），空白时给一句中性引导 -->
      <template v-if="hasToday">
        <div class="stat">
          <p v-if="pomo.todayCompletedCount > 0" class="stat-main">
            <span>完整 <span class="num">{{ pomo.todayCompletedCount }}</span> 段 ·</span>
            <b class="num hero">{{ doneMin }}</b>
            <span>分钟</span>
          </p>
          <p v-if="pomo.todayInterruptedCount > 0" class="stat-sub">
            另有 <span class="num">{{ pomo.todayInterruptedCount }}</span> 段中途停下，共
            <span class="num">{{ interruptedMin }}</span> 分钟
          </p>
        </div>
      </template>
      <EmptyState
        v-else
        :icon="Timer"
        title="今天还没有专注记录"
        hint="开始一段，第一段就会记在这里。"
      />
    </div>

    <!-- 结束（专注相位）：记录进入休息 / 放弃不留记录，文案即代价 -->
    <ActionSheet
      :open="endOpen"
      :title="endTitle"
      :actions="endActions"
      @select="onEndPick"
      @close="endOpen = false"
    />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 圆点。未点亮态用 --surface-3 —— 与 PillChip（muted）的胶囊底 --surface-2 **拉开一档**，
   否则圆点与胶囊同值、深浅两档都只剩 0.5px 描边、看不见。 */
.rdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--surface-3);
  border: 0.5px solid var(--line-strong);
}

/* 点亮色随专注 accent（--cat-work），与环、状态点同源 */
.rdot.on {
  background: var(--cat-work);
  border-color: transparent;
}

.body {
  gap: 16px;
  margin-top: 12px;
}

.time {
  font-size: var(--fs-display-m);
  font-weight: 200;
  letter-spacing: -1px;
  line-height: 1.1;
}

/* 相位小字 + 左侧状态色点：必读信息，从三级灰提到 --text-2 */
.phase {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.pdot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--text-3);
}

.pdot.live {
  background: var(--cat-work);
  animation: pbreathe 1.8s infinite;
}

.pdot.rest {
  background: var(--cat-general);
}

.pdot.pause {
  background: var(--warn);
}

@keyframes pbreathe {
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

.rest-tip {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-align: center;
  text-wrap: balance;
}

.controls {
  width: 100%;
  gap: 10px;
}

.main {
  width: 62px;
  height: 62px;
  flex: none;
  border-radius: 50%;
  background: var(--text-1);
  color: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-float);
}

.end {
  flex: none;
  height: 44px;
  padding: 0 16px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
}

.pick {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  text-align: left;
}

/* 无待办时的静态引导：不再是控件，不做按压/悬停，只降一档色 */
.pick-idle {
  color: var(--text-2);
  cursor: default;
}

.pick-t {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pick-c {
  flex: none;
  color: var(--text-3);
}

/* 桌面（有悬停）：让「能不能点」有反馈 */
@media (hover: hover) {
  .end:hover,
  .pick:not(.pick-idle):hover {
    background: var(--surface-3);
  }

  .main:hover {
    opacity: 0.9;
  }
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: center;
}

.stat-main {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 5px;
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

/* 卡底唯一主数值：完整段分钟数提到主档（数值走中性 --text-1，不带色相） */
.stat-main .hero {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-1);
}

.stat-sub {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-wrap: balance;
}

/* 减弱动效：保留状态色点，去掉呼吸动画 */
@media (prefers-reduced-motion: reduce) {
  .pdot.live {
    animation: none;
  }
}
</style>
