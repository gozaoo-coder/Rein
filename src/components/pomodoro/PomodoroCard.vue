<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Pause, Play, RotateCcw } from 'lucide-vue-next'

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

/** 当前长休周期内的轮次（用于点亮圆点） */
const roundDots = computed(() => {
  const n = pomo.settings.roundsBeforeLongBreak
  const done = pomo.todaySessions.length % n
  return Array.from({ length: n }, (_, i) => i < (done === 0 && pomo.todaySessions.length > 0 ? n : done))
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
      <span class="rounds num">{{ pomo.todaySessions.length }} 个番茄</span>
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
        今日专注 <b class="num">{{ pomo.todayFocusMin }}</b> 分钟 · 轮次
        <span v-for="(on, i) in roundDots" :key="i" class="rdot" :class="{ on }" />
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

.rounds {
  font-size: var(--fs-caption);
  color: var(--text-3);
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

.stat {
  font-size: var(--fs-caption);
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 5px;
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
