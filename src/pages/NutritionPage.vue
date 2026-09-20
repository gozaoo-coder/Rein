<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Camera, SlidersHorizontal, Sparkles } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import QuickTile from '@/components/common/QuickTile.vue'
import SmartAddSheet from '@/components/common/SmartAddSheet.vue'
import EnergySummary from '@/components/nutrition/EnergySummary.vue'
import MacroDetailCard from '@/components/nutrition/MacroDetailCard.vue'
import DietChecksCard from '@/components/nutrition/DietChecksCard.vue'
import MicrosCard from '@/components/nutrition/MicrosCard.vue'
import { useDietStore } from '@/stores/diet'
import { useNutritionStore } from '@/stores/nutrition'
import { todayStr } from '@/utils/date'

/** 营养全览 · 二级页：能量总览 + 宏量/微量元素详解 + 记饮食/改目标快捷入口。 */
const router = useRouter()
const today = todayStr()

const nutrition = useNutritionStore()
const diet = useDietStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void diet.load(today)
})

const quickOpen = ref(false)
</script>

<template>
  <div class="page">
    <PageHeader title="营养全览" subtitle="能量 · 宏量与微量元素详解" back />

    <!-- 快捷入口 -->
    <ul class="quick">
      <li>
        <QuickTile label="记饮食" icon-bg="color-mix(in srgb, var(--c-intake) 12%, transparent)" icon-color="var(--c-intake)" @click="quickOpen = true">
          <Camera :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="改目标" icon-bg="rgba(255, 149, 0, 0.14)" icon-color="var(--warn)" @click="router.push('/nutrition/adjust')">
          <SlidersHorizontal :size="20" />
        </QuickTile>
      </li>
      <li>
        <QuickTile label="AI 助手" icon-bg="rgba(88, 86, 214, 0.14)" icon-color="var(--cat-study)" @click="router.push('/ai')">
          <Sparkles :size="20" />
        </QuickTile>
      </li>
    </ul>

    <!-- 能量与宏量进度（复用首页卡片） -->
    <EnergySummary />

    <!-- 宏量详解 / 类别打卡 / 微量元素详解 -->
    <MacroDetailCard />
    <DietChecksCard />
    <MicrosCard />

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.quick {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
</style>
