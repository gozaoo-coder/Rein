<script setup lang="ts">
import { computed } from 'vue'
import { Play } from 'lucide-vue-next'

import ActivityRings from '@/components/common/ActivityRings.vue'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import type { MealType, ProgramDay, ProgramMeal } from '@/types'

/**
 * 生效方案的「今日驾驶舱」：把「方案今天要我做什么」压到一屏。
 *
 * 与主页面三环同源（红=摄入 / 绿=运动 / 青=均衡），不新造隐喻；
 * 三条进度条把方案日程翻译成可以清空的待办，回答「我今天还差什么」。
 */
const props = defineProps<{
  day: ProgramDay | null
  /** 当月展示用的日期文案，由页面格式化（页面统一的日期口径） */
  dateLabel: string
  /** 今天是方案第几天（1 起） */
  dayNo: number
  /** 方案总天数 */
  totalDays: number
  /** 今日训练待办是否已完成 */
  trainingDone: boolean
  /** 今日实际菜单（AI 菜单优先，未生成时回落模板菜单） */
  todayMenu: ProgramMeal[]
}>()

const emit = defineEmits<{
  start: [courseId: string]
  /** 记一笔：打开智能添加（携带下一餐的餐次供预选） */
  log: [mealType: MealType | null]
}>()

const n = useNutritionStore()
const diet = useDietStore()

/** 已记录的不同餐次数（同一餐次记多笔只算一次） */
const mealsLogged = computed(() => new Set(diet.meals.map((m) => m.mealType)).size)

/** 方案规定的每日餐次数：优先取当日菜单长度，回落到已记录数（至少 3） */
const mealsTarget = computed(() => {
  const fromMenu = props.todayMenu.length || props.day?.meals.length || 0
  return Math.max(fromMenu, mealsLogged.value, 3)
})

const proteinNow = computed(() => Math.round(n.summary?.intake.protein ?? 0))
const proteinTarget = computed(() => {
  const fromStore = Math.round(n.summary?.targets.protein ?? 0)
  if (fromStore > 0) return fromStore
  return Math.round(props.todayMenu.reduce((s, m) => s + m.protein, 0))
})

/** 下一餐：当日菜单里第一个还没记录的餐次 */
const nextMeal = computed<ProgramMeal | null>(() => {
  const meals = props.todayMenu.length > 0 ? props.todayMenu : (props.day?.meals ?? [])
  if (meals.length === 0) return null
  const logged = new Set(diet.meals.map((m) => m.mealType))
  return meals.find((m) => !logged.has(m.mealType)) ?? null
})

/** 进度条三件套：0~1，超出按 1 显示（与三环允许 >1 的口径区分） */
const bars = computed(() => {
  const cap = (v: number, max: number) => (max <= 0 ? 0 : Math.min(Math.max(v / max, 0), 1))
  return [
    {
      key: 'training',
      label: '今日训练',
      value: cap(props.trainingDone ? 1 : 0, 1),
      text: props.trainingDone ? '已完成' : '未完成',
      colorVar: '--c-exercise',
    },
    {
      key: 'meals',
      label: '餐次记录',
      value: cap(mealsLogged.value, mealsTarget.value),
      text: `${mealsLogged.value} / ${mealsTarget.value}`,
      colorVar: '--c-intake',
    },
    {
      key: 'protein',
      label: '蛋白质',
      value: cap(proteinNow.value, proteinTarget.value),
      text: `${proteinNow.value} / ${proteinTarget.value}g`,
      colorVar: '--c-balance',
    },
  ]
})
</script>

<template>
  <!-- 单根卡：三环+进度、训练动作、下一餐压进一屏，回答「今天还差什么」 -->
  <section v-if="day" class="pod">
    <header class="pod-head">
      <h2>{{ dateLabel }}</h2>
      <span class="day-no num">第 {{ dayNo }} / {{ totalDays }} 天</span>
    </header>

    <div class="cockpit">
      <ActivityRings :rings="n.rings" :size="86" />
      <div class="bars">
        <div v-for="b in bars" :key="b.key" class="bar-row">
          <div class="bar-top">
            <span>{{ b.label }}</span>
            <span class="num">{{ b.text }}</span>
          </div>
          <div class="bar-track">
            <i class="bar-fill" :style="{ transform: `scaleX(${b.value})`, background: `var(${b.colorVar})` }" />
          </div>
        </div>
      </div>
    </div>

    <div class="split" />

    <!-- 今日训练：只呈现当前最该做的一件事 -->
    <div class="action">
      <div class="action-copy">
        <p class="action-title">{{ day.courseName ?? '无训练安排 · 散步拉伸即可' }}</p>
        <p class="action-sub num">
          <template v-if="day.courseDurationMin">约 {{ day.courseDurationMin }} 分钟</template>
          <template v-else-if="!day.rest">时长未标注</template>
          <template v-else>休息日 · 让身体恢复</template>
        </p>
      </div>
      <button
        v-if="day.courseId && !trainingDone"
        class="go"
        :aria-label="`开始训练 ${day.courseName ?? ''}`"
        @click="emit('start', day.courseId)"
      >
        <Play :size="13" :stroke-width="2.6" />
        开始
      </button>
      <span v-else-if="day.courseId && trainingDone" class="done-tag">已完成</span>
    </div>

    <!-- 下一餐：并入驾驶舱的单行（明细见「今日菜单」卡）；记一笔打开智能添加并预选本餐次 -->
    <template v-if="nextMeal">
      <div class="split" />
      <div class="next-meal">
        <div class="nm-copy">
          <p class="nm-slot">下一餐 · {{ nextMeal.slot }}</p>
          <p class="nm-name">{{ nextMeal.name }}</p>
        </div>
        <div class="nm-acts">
          <button class="mini" @click="emit('log', nextMeal.mealType)">记一笔</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 单根卡：不再依赖跨组件的相邻选择器 */
.pod {
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.day-no {
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-weight: 600;
}

/* 驾驶舱：三环 + 三条进度 */
.cockpit {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.bars {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 9px;
}

.bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.bar-track {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.bar-fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-full);
  transform-origin: left center;
  transition: transform var(--dur-base) var(--ease-standard);
}

.split {
  height: 0.5px;
  margin: 13px 0;
  background: var(--line);
}

/* 训练动作行 */
.action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.action-copy {
  min-width: 0;
}

.action-title {
  font-size: var(--fs-callout);
  font-weight: 600;
}

.action-sub {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.go {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 14px;
  border-radius: var(--radius-full);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.go:active {
  transform: scale(0.96);
}

.done-tag {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--ok-strong);
}

/* 下一餐：并入驾驶舱的紧凑行 */
.next-meal {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.nm-copy {
  min-width: 0;
}

.nm-slot {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
}

.nm-name {
  margin-top: 3px;
  font-size: var(--fs-callout);
  font-weight: 600;
}

.nm-acts {
  flex: none;
  display: flex;
  gap: 7px;
}

.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.mini:active {
  transform: scale(0.95);
}


@media (prefers-reduced-motion: reduce) {
  .bar-fill,
  .go {
    transition: none;
  }
}
</style>
