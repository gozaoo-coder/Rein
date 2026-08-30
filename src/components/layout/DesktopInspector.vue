<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Check } from 'lucide-vue-next'

import ActivityRings from '@/components/common/ActivityRings.vue'
import { CATEGORY_META } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useTodoStore } from '@/stores/todo'
import { todayStr } from '@/utils/date'

/** 桌面三窗格壳 · 右侧信息栏：今日小结 + 待办快切 + AI 问句。 */
const today = todayStr()
const router = useRouter()

const nutrition = useNutritionStore()
const pomo = usePomodoroStore()
const todo = useTodoStore()
const ledger = useLedgerStore()

const ask = ref('')

onMounted(() => {
  void nutrition.loadSummary(today)
  void pomo.loadToday()
  void todo.loadDay(today)
  void ledger.loadMonth()
})

const todayExpenseCents = computed(() =>
  ledger.entries.filter((e) => e.date === today && e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0),
)

function sendAsk(): void {
  const q = ask.value.trim()
  if (!q) return
  ask.value = ''
  // 问题随路由带过去，AI 页接住预填——不能让用户的输入石沉大海
  void router.push({ name: 'ai', query: { ask: q } })
}

function hhmm(startMin: number): string {
  return `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`
}
</script>

<template>
  <aside class="inspector">
    <!-- 今日小结：三环 + 摄入/专注/支出 -->
    <section class="card">
      <div class="row" style="gap: 12px">
        <ActivityRings :rings="nutrition.rings" :size="86" />
        <div class="col" style="gap: 7px; min-width: 0">
          <div class="row between">
            <b class="num knum">{{ nutrition.kcalIntake }}</b>
            <span class="t-3 cap">摄入 kcal</span>
          </div>
          <div class="row between">
            <b class="num knum">{{ pomo.todayFocusMin }}</b>
            <span class="t-3 cap">专注 分</span>
          </div>
          <div class="row between">
            <b class="num knum">¥{{ fmtCents(todayExpenseCents) }}</b>
            <span class="t-3 cap">今日支出</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 今日待办：点勾即完成 -->
    <section class="card">
      <header class="row between">
        <h2 class="ct" style="font-size: var(--fs-headline)">今日待办</h2>
        <button class="more pressable" aria-label="查看全部待办" @click="router.push({ name: 'todos' })">
          全部<ArrowRight :size="13" />
        </button>
      </header>
      <ul v-if="todo.dayTodos.length" class="list">
        <li v-for="t in todo.dayTodos.slice(0, 4)" :key="t.id">
          <button
            class="row pressable item"
            :style="{ '--tc': 'var(' + CATEGORY_META[t.category].colorVar + ')' }"
            @click="void todo.toggle(t)"
          >
            <i class="tick" :class="{ on: t.status === 'done' }">
              <Transition name="ckin">
                <Check v-if="t.status === 'done'" :size="13" :stroke-width="3" />
              </Transition>
            </i>
            <span class="flex-1 line" :class="{ done: t.status === 'done' }">{{ t.title }}</span>
            <span v-if="t.startMin != null" class="num t-3 time">{{ hhmm(t.startMin) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="t-3 empty">今天还没有待办</p>
    </section>

    <!-- AI 问句 -->
    <form class="ask row" @submit.prevent="sendAsk">
      <input v-model="ask" placeholder="问点什么，比如「今天的蛋白质够吗？」" />
      <button class="send" aria-label="发送" type="submit">
        <ArrowRight :size="17" :stroke-width="2.4" />
      </button>
    </form>
  </aside>
</template>

<style scoped>
.inspector {
  width: 298px;
  flex: none;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px 20px 120px 0;
  background: color-mix(in srgb, var(--surface) 24%, transparent);
  border-left: 0.5px solid var(--line);
}

.knum {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.cap {
  font-size: var(--fs-caption);
  font-weight: 600;
}

.more {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.list {
  margin-top: 6px;
}

.item {
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  text-align: left;
}

.tick {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 0 1.7px var(--line-strong);
  color: transparent;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    box-shadow var(--dur-fast) var(--ease-standard);
}

.tick.on {
  background: var(--tc, var(--cat-general));
  box-shadow: none;
  color: var(--on-accent);
}

/* 对勾弹入 */
.ckin-enter-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.ckin-enter-from {
  transform: scale(0.5);
  opacity: 0;
}

.line {
  font-size: var(--fs-subhead);
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-decoration: line-through;
  text-decoration-color: transparent;
  transition:
    color var(--dur-base) var(--ease-standard),
    text-decoration-color var(--dur-base) var(--ease-standard);
}

.line.done {
  color: var(--text-3);
  text-decoration-color: currentColor;
}

.time {
  font-size: var(--fs-caption);
  font-weight: 600;
}

.empty {
  padding: 12px 0 4px;
  font-size: var(--fs-footnote);
}

.ask {
  gap: 10px;
  padding: 11px 11px 11px 16px;
  border-radius: var(--radius-full);
  background: var(--surface-translucent);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 0.5px solid var(--line);
  box-shadow: var(--shadow-card);
}

.ask input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-footnote);
  font-weight: 500;
}

.send {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
