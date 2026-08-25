<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue'

import PageHeader from '@/components/layout/PageHeader.vue'
import AiTargetAdjustCard from '@/components/nutrition/AiTargetAdjustCard.vue'
import BodyTrackerCard from '@/components/nutrition/BodyTrackerCard.vue'
import TargetCalculator from '@/components/nutrition/TargetCalculator.vue'
import TargetsEditor from '@/components/nutrition/TargetsEditor.vue'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import type { DailyTargets } from '@/types'

/** 饮食调整 · 二级页：方案计算 / AI 智能调整 / 手动微调。 */
const n = useNutritionStore()
const { toast } = useToast()

/* ---- 手动微调（本地副本，防抖自动保存） ---- */
const targets = reactive<DailyTargets>({ kcal: 2000, protein: 80, carb: 250, fat: 65, sodiumMg: 1500, waterMl: 1700 })

onMounted(async () => {
  if (!n.profile) await n.loadProfile()
})

watch(
  () => n.profile?.targets,
  (t) => {
    if (t) Object.assign(targets, t)
  },
  { immediate: true },
)

let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(targets, () => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await n.saveTargets({ ...targets })
    toast('每日目标已更新')
  }, 600)
})
</script>

<template>
  <div class="page">
    <PageHeader title="饮食调整" subtitle="方案计算 · AI 建议 · 手动微调" back />

    <!-- 方案计算器 -->
    <TargetCalculator />

    <!-- 体重 · 身高追踪 -->
    <BodyTrackerCard />

    <!-- AI 智能调整 -->
    <AiTargetAdjustCard />

    <!-- 手动微调 -->
    <section class="card">
      <header class="head">
        <h2>手动微调</h2>
        <p class="t-3">直接修改各项数值 · 自动保存</p>
      </header>
      <TargetsEditor v-model="targets" />
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}
</style>
