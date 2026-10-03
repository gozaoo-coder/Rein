<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

import IntakeOverview from './IntakeOverview.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { parseDate } from '@/utils/date'

/**
 * 营养总览卡（桌面便当的 hero 格、营养全览页的首页卡）。
 *
 * 这里**只管卡片壳与「详情」入口**：数字层级、四根条、目标线的几何全在 IntakeOverview，
 * 与移动端顶栏共用同一份实现 —— 从前两端各画一套，改一处漏一处。
 *
 * `dense`：便当 hero 格只有 4/12 列宽（约 200–350px），必须降字号，否则数字把卡撑破。
 */
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
    <IntakeOverview dense>
      <template #action>
        <button v-if="linkTo" class="more row center pressable" @click="goDetail">
          详情<ChevronRight :size="14" />
        </button>
        <span v-else-if="n.summary" class="date num t-3">{{ shortDate(n.summary.date) }}</span>
      </template>
    </IntakeOverview>
  </section>
</template>

<style scoped>
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
  flex: none;
}
</style>
