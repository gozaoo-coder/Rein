<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import ActivityRings from '@/components/common/ActivityRings.vue'
import MacroBars from './MacroBars.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { parseDate } from '@/utils/date'

/** 能量与营养总览：三环 + 摄入/消耗/剩余 + 宏量进度。数据来自 nutrition store。 */
const props = defineProps<{ linkTo?: string }>()

const n = useNutritionStore()
const router = useRouter()

function shortDate(s: string): string {
  const d = parseDate(s)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function goDetail(): void {
  if (props.linkTo) void router.push(props.linkTo)
}
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>能量与营养</h2>
      <button v-if="linkTo" class="more row center pressable" @click="goDetail">
        详情<ChevronRight :size="14" />
      </button>
      <span v-else-if="n.summary" class="date num t-3">{{ shortDate(n.summary.date) }}</span>
    </header>

    <div class="hero row">
      <ActivityRings :rings="n.rings" :size="106" />
      <div class="col flex-1 nums">
        <div class="big row">
          <span class="num intake">{{ n.kcalIntake }}</span>
          <span class="unit num">/ {{ n.kcalTarget }} 大卡</span>
        </div>
        <p class="cap">摄入 / 目标</p>
        <ul class="rows">
          <li class="row">
            <i class="dot" style="background: var(--c-exercise)" />
            运动消耗<b class="num">&nbsp;+{{ n.exerciseKcal }}</b>&nbsp;大卡
          </li>
          <li class="row">
            <i class="dot" style="background: var(--c-balance)" />
            剩余可吃<b class="num">&nbsp;{{ n.kcalRemaining }}</b>&nbsp;大卡
          </li>
        </ul>
      </div>
    </div>

    <MacroBars :macros="n.macros" />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.date {
  font-size: var(--fs-caption);
}

.more {
  gap: 1px;
  padding: 5px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.hero {
  gap: 18px;
  margin-top: 14px;
}

.nums .big {
  align-items: baseline;
  gap: 6px;
}

.intake {
  font-size: 44px;
  font-weight: 200;
  letter-spacing: -1.5px;
  line-height: 1;
  color: var(--c-intake);
}

.unit {
  font-size: var(--fs-callout);
  font-weight: 400;
  color: var(--text-2);
}

.cap {
  font-size: var(--fs-caption);
  color: var(--text-3);
  margin: 4px 0 10px;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-subhead);
  color: var(--text-2);
}

.rows b {
  font-weight: 700;
  color: var(--text-1);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  flex: none;
}
</style>
