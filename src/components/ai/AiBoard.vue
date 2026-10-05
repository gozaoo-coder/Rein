<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Archive,
  Camera,
  ChartPie,
  Dumbbell,
  NotebookPen,
  Search as SearchIcon,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-vue-next'

import ActivityRings from '@/components/common/ActivityRings.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useAiStore } from '@/stores/ai'
import { useNutritionStore } from '@/stores/nutrition'
import { listFoodDrafts, type FoodDraft } from '@/utils/foodDrafts'
import { todayStr } from '@/utils/date'
import type { RingItem } from '@/components/common/ActivityRings.vue'

/**
 * AI 会话看板：**空会话时的整屏主页**。
 *
 * 为什么不是一条欢迎语：原来那句「你好，我是 Rein AI……」是纯文字，
 * 与下面第一条真实消息长得一模一样（都是气泡、都居左）—— 分不清哪条是机器说的、
 * 哪条是数据。而这个页面真正缺的不是寒暄，是**「我现在能干什么」**：
 * 拍照识食、记账、查知识库、语音纪要这些能力散落在各页，用户得先知道它们存在。
 *
 * 所以这里给三块，取代那一条字：
 *   1. 今天 —— 摄入/运动/剩余三个数（真实数据，不是装饰）
 *   2. 做什么 —— 五个能力入口，点开直接把那句话填进输入框（不是执行固定动作）
 *   3. 接着聊 —— 最近会话；没有草稿/会话时显示空状态而不是留白
 */

const emit = defineEmits<{
  /** 把一句现成的话递给输入框（不直接发送，见 quickAsks 的注释） */
  ask: [text: string]
  /** 打开饮食草稿箱弹层 —— 由 AIPage 实现（草稿箱的 state 在那边） */
  drafts: []
}>()

const ai = useAiStore()
const nutrition = useNutritionStore()

const today = todayStr()
const drafts = ref<FoodDraft[]>([])

onMounted(() => {
  if (!nutrition.summary) void nutrition.loadSummary(today)
  drafts.value = listFoodDrafts()
})

/* ---------- 1. 今天 ---------- */

const rings = computed<RingItem[]>(() => {
  const s = nutrition.summary
  if (!s) return []
  const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0)
  return [
    { key: 'intake', value: ratio(s.intake.kcal, s.targets.kcal), colorVar: 'var(--c-intake)' },
    { key: 'exercise', value: ratio(s.exerciseKcal, s.targets.kcal), colorVar: 'var(--c-exercise)' },
    { key: 'balance', value: ratio(Math.max(0, s.targets.kcal - s.intake.kcal), s.targets.kcal), colorVar: 'var(--c-balance)' },
  ]
})

/** 三格数字：已摄入 / 运动 / 剩余。空数据时给占位而不是 0 —— 0 会被读成「今天没吃」 */
const stats = computed(() => {
  const s = nutrition.summary
  if (!s) return null
  return {
    intake: Math.round(s.intake.kcal),
    target: Math.round(s.targets.kcal),
    exercise: Math.round(s.exerciseKcal),
    left: Math.max(0, Math.round(s.targets.kcal - s.intake.kcal - s.exerciseKcal)),
  }
})

/* ---------- 2. 做什么 ----------
 * 每一项只做一件事：把一句现成的话填进输入框。**不直接执行** ——
 * 「查一下我这周练了几次」该由模型决定调哪个工具、调到什么粒度；
 * 前端替它决定就成了「又一块设定好的卡片」，那正是要删掉的那种东西。 */

interface QuickAsk {
  id: string
  label: string
  hint: string
  icon: typeof Camera
  /** 圆章底与前景：走域色，与主页工具格同一套配方 */
  bg: string
  fg: string
  text: string
}

const quickAsks: QuickAsk[] = [
  {
    id: 'photo',
    label: '拍照识食',
    hint: '一句话记一餐',
    icon: Camera,
    bg: 'color-mix(in srgb, var(--c-intake) 12%, transparent)',
    fg: 'var(--c-intake)',
    text: '我刚吃了',
  },
  {
    id: 'analyze',
    label: '分析今日',
    hint: '让 AI 看真实条目',
    icon: ChartPie,
    bg: 'color-mix(in srgb, var(--c-intake) 12%, transparent)',
    fg: 'var(--c-intake)',
    text: '看看我今天的饮食摄入，分析一下结构和问题，并给出明天可以怎么调整的建议。',
  },
  {
    id: 'ledger',
    label: '记一笔账',
    hint: '说金额和用途',
    icon: Wallet,
    bg: 'color-mix(in srgb, var(--cat-workout) 12%, transparent)',
    fg: 'var(--ok-strong)',
    text: '帮我记一笔账：',
  },
  {
    id: 'workout',
    label: '问训练',
    hint: '看这周练了什么',
    icon: Dumbbell,
    bg: 'color-mix(in srgb, var(--c-exercise) 20%, transparent)',
    fg: 'var(--c-exercise-deep)',
    text: '看一下我这周练了几次，帮我总结一下',
  },
  {
    id: 'kb',
    label: '翻记录',
    hint: '找以前提过的事',
    icon: SearchIcon,
    bg: 'color-mix(in srgb, var(--cat-study) 14%, transparent)',
    fg: 'var(--cat-study)',
    text: '搜一下我的历史记录里关于',
  },
  {
    id: 'note',
    label: '记一条',
    hint: '随手记进知识库',
    icon: NotebookPen,
    bg: 'color-mix(in srgb, var(--led-shopping) 12%, transparent)',
    fg: 'var(--led-shopping)',
    text: '帮我记一条笔记：',
  },
]

/* ---------- 3. 接着聊 ---------- */

const recent = computed(() => ai.chats.slice(0, 4))

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

const isEmpty = computed(() => recent.value.length === 0 && drafts.value.length === 0)
</script>

<template>
  <div class="board">
    <!-- 1. 今天 -->
    <section v-if="stats" class="today">
      <ActivityRings :rings="rings" :size="52" />
      <div class="t-stats">
        <div class="t-row">
          <b class="num">{{ stats.intake }}</b>
          <span class="t-lab">已摄入 / {{ stats.target }} 大卡</span>
        </div>
        <p class="t-sub">
          <span><i class="d" style="background: var(--c-exercise)" />运动 {{ stats.exercise }}</span>
          <span><i class="d" style="background: var(--c-balance)" />还可吃 {{ stats.left }}</span>
        </p>
      </div>
    </section>

    <!-- 2. 做什么 -->
    <section class="sec">
      <h2 class="sec-t">做什么</h2>
      <div class="grid">
        <button
          v-for="q in quickAsks"
          :key="q.id"
          class="qa"
          @click="emit('ask', q.text)"
        >
          <i class="qa-ic" :style="{ background: q.bg, color: q.fg }">
            <component :is="q.icon" :size="18" :stroke-width="2.2" />
          </i>
          <span class="qa-t">
            <b>{{ q.label }}</b>
            <em>{{ q.hint }}</em>
          </span>
        </button>
      </div>
      <p class="qa-tip">点一下只是把话递给你 —— 接下来你说多少、问什么，AI 那边自己判断。</p>
    </section>

    <!-- 3. 接着聊 -->
    <section class="sec">
      <template v-if="!isEmpty">
        <div v-if="drafts.length" class="drafts">
          <!-- 打开草稿箱弹层（不 push 路由 —— 本来就在 AI 页上，push 到自己等于没反应） -->
          <button class="dr" @click="emit('drafts')">
            <i class="dr-ic"><Archive :size="15" /></i>
            <span class="flex-1">
              <b>饮食草稿箱 · {{ drafts.length }}</b>
              <em>{{ drafts[0]?.items.map((i) => i.foodName).slice(0, 3).join('、') ?? '' }}</em>
            </span>
            <span class="dr-go">继续 ›</span>
          </button>
        </div>

        <div v-if="recent.length">
          <h2 class="sec-t">接着聊</h2>
          <ul class="chats">
            <li v-for="c in recent" :key="c.id">
              <button class="ch" @click="ai.selectChat(c.id)">
                <i class="ch-ic"><Sparkles :size="14" /></i>
                <span class="flex-1">
                  <b>{{ c.title }}</b>
                </span>
                <span class="t-3 ch-t num">{{ fmtTime(c.updatedAt) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </template>

      <EmptyState
        v-else
        :icon="TrendingUp"
        title="还没有会话"
        hint="上面选一件事开始，或者直接在下面说话"
      />
    </section>
  </div>
</template>

<style scoped>
.board {
  padding: 4px 2px 8px;
}

/* ---------- 今天 ---------- */
.today {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  margin-bottom: 22px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.t-stats {
  min-width: 0;
  flex: 1;
}

.t-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.t-row b {
  font-size: var(--fs-large-title);
  font-weight: 200;
  letter-spacing: -1px;
  line-height: 1;
  color: var(--c-intake);
  font-variant-numeric: tabular-nums;
}

.t-lab {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.t-sub {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.t-sub .d {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 5px;
}

/* ---------- 分节 ---------- */
.sec {
  margin-bottom: 22px;
}

.sec-t {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
  margin-bottom: 10px;
  padding-left: 2px;
}

/* ---------- 做什么 ---------- */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.qa {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  min-width: 0;
}

/* 圆章：与主页工具格同一套几何（40px 圆 + 域色 12–20% 底） */
.qa-ic {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
}

.qa-t {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.qa-t b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.qa-t em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qa-tip {
  margin-top: 10px;
  padding-left: 2px;
  font-size: var(--fs-micro);
  line-height: 1.5;
  color: var(--text-3);
}

/* ---------- 草稿 / 会话 ---------- */
.dr {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 11px 14px;
  margin-bottom: 12px;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--ok) 10%, var(--surface));
  text-align: left;
  min-width: 0;
}

.dr-ic {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: var(--ok-strong);
}

.dr b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.dr em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dr-go {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--ok-strong);
}

.chats {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.ch {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  min-width: 0;
}

.ch + .ch {
  border-top: 0.5px solid var(--line);
}

.ch-ic {
  width: 24px;
  height: 24px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.ch b {
  display: block;
  font-size: var(--fs-subhead);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-t {
  flex: none;
  font-size: var(--fs-caption);
}
</style>
