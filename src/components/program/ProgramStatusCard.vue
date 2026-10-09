<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Target, Wand2 } from 'lucide-vue-next'

import { GOAL_LABELS } from '@/config/domain'
import { useProgramStore } from '@/stores/program'
import { courseOnDate, programStatus, reviewDue } from '@/utils/programCycle'
import { parseBlob } from '@/utils/programEngine'
import { todayStr } from '@/utils/date'

/**
 * 主页方案状态卡：方案在执行期的唯一常驻落点。
 *
 * 一行说清「什么方案、走到哪、今天做什么」，点击进方案页；
 * 距上次复盘满一周时追加「本周复盘」入口（深链到方案页自动发起）。
 * 主页从「今天该做什么」到「方案在推进什么」的这一层连接，过去只在方案页里。
 */
const router = useRouter()
const program = useProgramStore()

const parsed = computed(() => {
  if (!program.active) return null
  try {
    return parseBlob(program.active)
  } catch {
    return null /* 数据损坏时整卡退化为「打开方案页」，不阻塞主页 */
  }
})

const status = computed(() =>
  program.active && parsed.value ? programStatus(program.active, parsed.value) : null,
)

const tierLabel = computed(() =>
  program.active?.tier === 'conservative' ? '保守' : program.active?.tier === 'aggressive' ? '进取' : '均衡',
)

const heading = computed(() => {
  if (!program.active || !status.value) return ''
  return `${GOAL_LABELS[program.active.goal]} · ${tierLabel.value} · 第 ${status.value.week} 周 / ${status.value.weeks}`
})

/** 第二行：今天做什么（或未开跑 / 已结束的状态说明） */
const todayText = computed(() => {
  const st = status.value
  const b = parsed.value
  if (!st || !b) return ''
  if (st.ended) return '本期已结束 · 生成成绩单'
  if (st.upcoming) {
    const first = courseOnDate(b, st.startDate)
    return `${st.startDate.slice(5)} 开跑${first ? ` · 首日 ${first.courseName}` : ''}`
  }
  const course = courseOnDate(b, todayStr())
  return course ? `今天 ${course.courseName} · ${course.durationMin} 分钟` : '今天休息'
})

const due = computed(() => {
  if (!program.active || !parsed.value) return false
  return reviewDue(program.active, parsed.value)
})

function open(): void {
  if (!program.active) return
  const st = status.value
  if (st?.ended) void router.push(`/program/wrapup/${program.active.id}`)
  else void router.push('/program')
}

function openReview(): void {
  void router.push({ path: '/program', query: { review: '1' } })
}
</script>

<template>
  <section v-if="program.active && status" class="card pcard" data-testid="program-card">
    <button class="main pressable" @click="open">
      <i class="ic"><Target :size="18" :stroke-width="2.2" /></i>
      <span class="col txt">
        <b>{{ heading }}</b>
        <em>{{ todayText }}</em>
      </span>
      <ChevronRight :size="15" class="chev" />
    </button>
    <!-- 到期行：出现/消失用栅格壳收高度（退出比进入快，行内不加外边距故不掺 margin） -->
    <Transition name="due">
      <div v-if="due" class="due-wrap">
        <!-- 裸壳：按钮自带 padding/border-top，直接当轨道项 0fr 收不干净 -->
        <div class="due-shell">
          <button class="due pressable" @click="openReview">
            <Wand2 :size="14" />
            <span class="grow">距上次复盘已满一周，看看数据怎么调</span>
            <b class="go">本周复盘</b>
          </button>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
/* 卡壳交给全局 .card（圆角/阴影），这里只收掉它的内边距（主行自带 13/16px）——
   带上 .card 提升特异性，不依赖样式注入顺序 */
.card.pcard {
  padding: 0;
  overflow: hidden;
}

/* 主行：图标章 + 两行文案 + chevron，与主页工具格同一套几何 */
.main {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 13px 16px;
  text-align: left;
}

.ic {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}

.txt {
  flex: 1;
  min-width: 0;
  gap: 1px;
}

.txt b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.txt em {
  font-style: normal;
  font-size: var(--fs-caption);
  /* --text-2：这行是「今天做什么」，属要读的信息（契约见 tokens.css） */
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chev {
  flex: none;
  color: var(--text-3);
}

/* 复盘到期行：强调色的窄条，只在满一周时出现 */
.due {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 10px 16px;
  border-top: 0.5px solid var(--line);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  text-align: left;
}

.due .grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.due .go {
  flex: none;
  font-weight: 700;
}

/* 到期行的进出场外壳：0fr↔1fr 收高度；出现走入场时长、消失走退场时长。
   轨道项（.due-shell）保持裸壳：按钮自身的 padding/border-top 若画在轨道项上，
   折叠后会留下一截按钮内边距高的缝 */
.due-wrap {
  display: grid;
  grid-template-rows: 1fr;
}

.due-shell {
  min-height: 0;
  overflow: hidden;
}

.due-enter-active {
  transition: grid-template-rows var(--dur-base) var(--ease-standard);
}

.due-leave-active {
  transition: grid-template-rows var(--dur-fast) var(--ease-standard);
}

.due-enter-from,
.due-leave-to {
  grid-template-rows: 0fr;
}
</style>
