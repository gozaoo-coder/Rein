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
import ProgramMenuCard from '@/components/nutrition/ProgramMenuCard.vue'
import { useDietStore } from '@/stores/diet'
import { useFeaturesStore } from '@/stores/features'
import { useNutritionStore } from '@/stores/nutrition'
import { useProgramStore } from '@/stores/program'
import { todayStr } from '@/utils/date'

/** 营养全览 · 二级页：能量总览 + 宏量/微量元素详解 + 记饮食/改目标快捷入口。
 *  方案生效时多一张「今日菜单」卡（菜单归营养，方案页只管方案）。 */
const router = useRouter()
const today = todayStr()

const nutrition = useNutritionStore()
const diet = useDietStore()
const program = useProgramStore()
const features = useFeaturesStore()

onMounted(() => {
  void nutrition.loadSummary(today)
  void diet.load(today)
  // 关掉方案模块时不产生请求（与主页同一条纪律）
  if (features.isEnabled('program')) void program.load()
})

const quickOpen = ref(false)
</script>

<template>
  <div class="page">
    <PageHeader title="营养全览" subtitle="能量 · 宏量与微量元素详解" back />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

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

    <!-- 方案生效时的今日菜单：吃什么归营养页；生成按需，未生成回落模板 -->
    <ProgramMenuCard @log="quickOpen = true" />

    <!-- 宏量详解：与左侧「能量与营养」配成一行（两张都是纵向长卡，高度也接近）。

         类别打卡与微量元素**通栏**：微量元素卡展开后有 1300px 高，跟一张 227px 的
         打卡卡并排，右半边会空出一整屏；它们的内容本来就是「左标签 + 右数值」的
         宽行，铺满一行反而更好读。 -->
    <MacroDetailCard />
    <DietChecksCard class="d-full" />
    <MicrosCard class="d-full" />

    <!-- 弹层 -->
    <SmartAddSheet :open="quickOpen" mode="food" :date="today" @close="quickOpen = false" />
    </div>
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
