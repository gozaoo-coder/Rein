<script setup lang="ts">
import { computed } from 'vue'

import { useDietStore } from '@/stores/diet'

/** 今日建议打卡：按食物类别检查六大类覆盖情况（膳食指南多样性建议）。 */
const diet = useDietStore()

const CHECKS = [
  { label: '主食', cats: ['主食'] },
  { label: '优质蛋白', cats: ['肉蛋', '水产', '豆制品'] },
  { label: '蔬菜', cats: ['蔬菜'] },
  { label: '水果', cats: ['水果'] },
  { label: '奶制品', cats: ['奶类'] },
  { label: '坚果', cats: ['坚果'] },
] as const

const checks = computed(() =>
  CHECKS.map((c) => ({
    ...c,
    // as const 元组的 includes 参数是字面量类型，需放宽到 string 才能传入类别
    done: diet.meals.some((m) => m.food && (c.cats as readonly string[]).includes(m.food!.category ?? '')),
  })),
)

const doneCount = computed(() => checks.value.filter((c) => c.done).length)
</script>

<template>
  <section class="card">
    <header class="head row between">
      <div>
        <h2>今日建议打卡</h2>
        <p class="t-3">六大类食物 · 尽量每日覆盖</p>
      </div>
      <span class="num count">{{ doneCount }}<em>/{{ checks.length }}</em></span>
    </header>

    <ul class="checks">
      <li v-for="c in checks" :key="c.label" class="chip" :class="{ done: c.done }">
        <span class="mark">{{ c.done ? '✓' : '' }}</span>{{ c.label }}
      </li>
    </ul>

    <p class="tip t-3">
      参照膳食指南的食物多样性建议：主食、优质蛋白、蔬菜、水果、奶制品、坚果六类尽量都吃到，营养结构更均衡。
    </p>
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

.count {
  font-size: var(--fs-title2);
  font-weight: 200;
  color: var(--text-1);
  letter-spacing: -0.5px;
}

.count em {
  font-style: normal;
  font-size: var(--fs-subhead);
  color: var(--text-3);
  margin-left: 1px;
}

/* 打卡 */
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
  transition: background-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard);
}

.chip .mark {
  display: inline-flex;
  width: 15px;
  justify-content: center;
  font-size: var(--fs-micro);
}

.chip.done {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.tip {
  margin-top: 12px;
  font-size: var(--fs-footnote);
  line-height: 1.6;
}
</style>
