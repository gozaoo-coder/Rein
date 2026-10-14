<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Pause, Play, RotateCcw } from 'lucide-vue-next'

import RingProgress from '@/components/common/RingProgress.vue'
import InfoHint from '@/components/common/InfoHint.vue'
import PillChip from '@/components/common/PillChip.vue'
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

/** 当前长休周期内已完成的轮数（「本轮 X/N」的 X，同时决定圆点点亮几颗） */
const roundDone = computed(() => {
  const n = pomo.settings.roundsBeforeLongBreak
  const done = pomo.todaySessions.length % n
  return done === 0 && pomo.todaySessions.length > 0 ? n : done
})

/** 当前长休周期内的轮次（用于点亮圆点） */
const roundDots = computed(() => {
  const n = pomo.settings.roundsBeforeLongBreak
  return Array.from({ length: n }, (_, i) => i < roundDone.value)
})

function onPickTodo(event: Event): void {
  const v = (event.target as HTMLSelectElement).value
  pomo.linkedTodoId = v === '' ? null : Number(v)
}
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>番茄钟</h2>
      <span class="head-right">
        <!-- 「N 个番茄」胶囊：条数与轮次进度合成一处（原先卡头条数、卡底分钟、
             卡底圆点三处各念一遍同一批 todaySessions）。「本轮 X/N」写在 .trail 里，
             圆点只作辅助；几轮进长休是可改的设置，收进右侧说明入口。 -->
        <PillChip tone="muted" size="sm">
          <span class="num">{{ pomo.todaySessions.length }}</span> 个番茄
          <span class="trail">
            本轮 <span class="num">{{ roundDone }}</span>/<span class="num">{{ pomo.settings.roundsBeforeLongBreak }}</span>
          </span>
          <span v-for="(on, i) in roundDots" :key="i" class="rdot" :class="{ on }" />
        </PillChip>
        <InfoHint title="轮次圆点">
          <p>每 {{ pomo.settings.roundsBeforeLongBreak }} 次专注后进入一次长休息。</p>
          <p>圆点记录本轮进度：点亮的是本轮已完成的次数，点满即进入长休息，之后重新开始点亮。</p>
          <p>轮数可以在设置里调整。</p>
        </InfoHint>
      </span>
    </header>

    <div class="col center body">
      <RingProgress
        :value="pomo.progress"
        :color-var="pomo.phase === 'focus' ? '--c-intake' : '--c-exercise'"
        :size="158"
        :stroke="11"
      >
        <b class="num time">{{ pomo.displayTime }}</b>
        <span class="phase">{{ pomo.running ? (pomo.phase === 'focus' ? '专注中' : '休息中') : '已暂停' }}</span>
      </RingProgress>

      <div class="row controls">
        <button class="ghost" aria-label="重置" @click="pomo.reset()">
          <RotateCcw :size="19" />
        </button>
        <button
          class="main"
          :aria-label="pomo.running ? '暂停' : '开始'"
          @click="pomo.running ? pomo.pause() : pomo.start()"
        >
          <Pause v-if="pomo.running" :size="24" />
          <Play v-else :size="24" style="margin-left: 3px" />
        </button>
        <select class="pick" :value="pomo.linkedTodoId ?? ''" @change="onPickTodo">
          <option value="">专注对象…</option>
          <option v-for="t in todo.dayTodos" :key="t.id" :value="t.id" :disabled="t.status === 'done'">
            {{ t.title }}
          </option>
        </select>
      </div>

      <p class="stat">
        今日专注 <b class="num">{{ pomo.todayFocusMin }}</b> 分钟
      </p>
    </div>
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

.phase {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.controls {
  width: 100%;
  gap: 12px;
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

.ghost {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.pick {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  appearance: none;
  text-overflow: ellipsis;
}

/* 卡底唯一主数值：今日专注分钟数提到主档，其余事实都进了卡头胶囊 */
.stat {
  font-size: var(--fs-caption);
  color: var(--text-2);
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.stat .num {
  font-size: var(--fs-title3);
  font-weight: 700;
  color: var(--text-1);
}

.rdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 0.5px solid var(--line-strong);
}

.rdot.on {
  background: var(--c-intake);
  border-color: transparent;
}
</style>
