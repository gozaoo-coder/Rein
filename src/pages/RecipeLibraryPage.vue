<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Sparkles, ThumbsDown, ThumbsUp } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { dietService } from '@/services/dietService'
import { useModelsStore } from '@/stores/models'
import { useNutritionStore } from '@/stores/nutrition'
import { generateAiMenu, type AiMenuMeal } from '@/ai/recipeGen'
import type { RecipeTemplate } from '@/utils/programEngine'
import seedRecipes from '@resources/recipe_templates.json'

/**
 * 食谱库：浏览内置食谱模板（营养由食物库实算），标记喜欢/不喜欢——
 * 偏好会改进方案引擎选菜；右上「AI 定制」按当日目标生成一日菜单（数值仍实算）。
 */
const n = useNutritionStore()
const models = useModelsStore()

const RECIPES = (seedRecipes as { recipes: RecipeTemplate[] }).recipes

const filter = ref<string>('all')
const prefs = ref<Record<string, 1 | -1>>({})

onMounted(async () => {
  await Promise.all([n.loadProfile(), loadPrefs()])
})

async function loadPrefs(): Promise<void> {
  const list = await dietService.recipePrefsList()
  prefs.value = Object.fromEntries(list.map((p) => [p.recipeId, p.rating]))
}

const MEAL_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
]
const MEAL_TYPE_LABEL: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }

const restrictions = computed(() =>
  (n.profile?.dietRestrictions ?? []).map((r) => r.trim()).filter(Boolean),
)

function isRestricted(r: RecipeTemplate): boolean {
  return restrictions.value.some(
    (kw) => r.allergens.some((a) => a.includes(kw)) || r.items.some((it) => it.food.includes(kw)),
  )
}

const visible = computed(() =>
  filter.value === 'all' ? RECIPES : RECIPES.filter((r) => r.mealType === filter.value),
)

/** 点按已选标记 = 清除；否则写入（乐观更新） */
async function togglePref(r: RecipeTemplate, rating: 1 | -1): Promise<void> {
  const current = prefs.value[r.id]
  try {
    if (current === rating) {
      prefs.value = { ...prefs.value }
      delete prefs.value[r.id]
      await dietService.recipePrefsClear(r.id)
    } else {
      prefs.value = { ...prefs.value, [r.id]: rating }
      await dietService.setRecipePref(r.id, rating)
    }
  } catch (e) {
    await loadPrefs()
    throw e
  }
}

/* ---- AI 定制菜单 ---- */
const aiOpen = ref(false)
const aiMealsCount = ref('4')
const aiGenerating = ref(false)
const aiMeals = ref<AiMenuMeal[]>([])
const aiWarnings = ref<string[]>([])
const aiError = ref('')

async function startAiMenu(): Promise<void> {
  aiOpen.value = true
  aiError.value = ''
  await generateAi()
}

async function generateAi(): Promise<void> {
  const profile = n.profile
  if (!profile) throw new Error('个人资料未加载')
  aiGenerating.value = true
  aiError.value = ''
  aiMeals.value = []
  aiWarnings.value = []
  try {
    await models.load()
    const cfg = models.defaultModel()
    if (!cfg) throw new Error('未配置 AI 模型，请先在「AI › 管理模型」添加')
    const likes = Object.entries(prefs.value)
      .filter(([, v]) => v === 1)
      .map(([id]) => RECIPES.find((r) => r.id === id)?.name ?? id)
    const dislikes = Object.entries(prefs.value)
      .filter(([, v]) => v === -1)
      .map(([id]) => RECIPES.find((r) => r.id === id)?.name ?? id)
    const res = await generateAiMenu(cfg, {
      targets: profile.targets,
      mealsCount: Number(aiMealsCount.value) as 3 | 4 | 5,
      restrictions: restrictions.value,
      likes,
      dislikes,
    })
    aiMeals.value = res.meals
    aiWarnings.value = res.warnings
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiGenerating.value = false
  }
}

const aiTotal = computed(() =>
  aiMeals.value.reduce(
    (s, m) => ({ kcal: s.kcal + m.kcal, protein: s.protein + m.protein }),
    { kcal: 0, protein: 0 },
  ),
)
</script>

<template>
  <div class="page">
    <PageHeader
      title="食谱库"
      :subtitle="`${RECIPES.length} 个模板 · 营养由食物库实算`"
      back
    />

    <!-- AI 定制入口 -->
    <section class="card ai-card">
      <div class="row" style="gap: 10px">
        <i class="ai-ic center"><Sparkles :size="18" /></i>
        <div class="col flex-1" style="gap: 2px">
          <b>AI 定制一日菜单</b>
          <span class="t-3 ai-sub">按你的目标与偏好生成，热量由食物库实算</span>
        </div>
        <button class="ai-go pressable" @click="startAiMenu">生成</button>
      </div>
    </section>

    <!-- 餐次过滤 -->
    <SegmentedControl v-model="filter" :options="MEAL_FILTERS" class="seg" />

    <!-- 食谱列表 -->
    <ul class="rlist">
      <li v-for="r in visible" :key="r.id" class="row rrow" :class="{ off: isRestricted(r) }">
        <div class="col flex-1" style="gap: 3px; min-width: 0">
          <p class="rname">
            {{ r.name }}<em class="slot">{{ MEAL_TYPE_LABEL[r.mealType] }}</em>
            <span v-if="isRestricted(r)" class="badge">忌口</span>
          </p>
          <p class="num rmeta">
            <b>{{ r.baseKcal }}</b> 大卡 · 蛋白 <b>{{ r.baseProtein }}</b>g · 碳水
            <b>{{ r.baseCarb }}</b>g · 脂肪 <b>{{ r.baseFat }}</b>g
          </p>
          <p class="tags t-3">
            <span v-for="a in r.allergens" :key="a" class="tag">{{ a }}</span>
            <span v-if="!r.allergens.length" class="tag">无常见过敏原</span>
          </p>
        </div>
        <div class="row prefs">
          <button
            class="pf pressable"
            :class="{ on: prefs[r.id] === 1 }"
            :aria-label="`喜欢 ${r.name}`"
            @click="togglePref(r, 1)"
          >
            <ThumbsUp :size="15" />
          </button>
          <button
            class="pf pressable"
            :class="{ on: prefs[r.id] === -1 }"
            :aria-label="`不喜欢 ${r.name}`"
            @click="togglePref(r, -1)"
          >
            <ThumbsDown :size="15" />
          </button>
        </div>
      </li>
    </ul>

    <!-- AI 菜单弹层 -->
    <SheetModal :open="aiOpen" title="AI 定制一日菜单" initial-snap="large" @close="aiOpen = false">
      <div class="ai-panel">
        <div class="row between">
          <p class="t-2">每日餐次</p>
          <SegmentedControl
            v-model="aiMealsCount"
            :options="[
              { value: '3', label: '3 餐' },
              { value: '4', label: '4 餐' },
              { value: '5', label: '5 餐' },
            ]"
            class="seg-sm"
          />
        </div>

        <template v-if="aiError">
          <p class="ai-err">{{ aiError }}</p>
          <button class="ai-go wide pressable" @click="generateAi">重试</button>
        </template>

        <template v-else-if="aiGenerating">
          <p class="t-2 center ai-wait">正在按你的目标设计菜单并实算营养…</p>
        </template>

        <template v-else-if="aiMeals.length">
          <p class="num t-2 ai-total">
            全天合计 <b>{{ aiTotal.kcal }}</b> 大卡 · 蛋白 <b>{{ aiTotal.protein }}</b>g
          </p>
          <ul class="ai-meals">
            <li v-for="(m, i) in aiMeals" :key="i">
              <p class="ai-mhead">
                <em>{{ m.slot }}</em>{{ m.name }}<b class="num"> 约{{ m.kcal }} 大卡</b>
              </p>
              <p class="t-3 ai-items">{{ m.items.map((it) => `${it.label} ${it.grams}g`).join('、') }}</p>
            </li>
          </ul>
          <p v-for="w in aiWarnings" :key="w" class="t-3 ai-warn">{{ w }}</p>
          <div class="row" style="gap: 10px">
            <button class="ai-go wide pressable" style="flex: 1" @click="generateAi">换一批</button>
            <button class="ai-done pressable" style="flex: 1" @click="aiOpen = false">完成</button>
          </div>
        </template>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.ai-card {
  background: var(--accent-soft);
}

.ai-ic {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 12px;
  background: var(--accent);
  color: var(--on-accent);
}

.ai-card b {
  font-size: var(--fs-callout);
}

.ai-sub {
  font-size: var(--fs-caption);
}

.ai-go {
  flex: none;
  padding: 7px 15px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.ai-go.wide {
  padding: 12px 0;
  border-radius: var(--radius-s);
}

.ai-done {
  padding: 12px 0;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--text-1);
}

.seg {
  margin-top: 14px;
}

.rlist {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}

.rrow {
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.rrow.off {
  opacity: 0.45;
}

.rname {
  font-size: var(--fs-subhead);
  font-weight: 700;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.rname .slot {
  font-style: normal;
  font-weight: 500;
  font-size: var(--fs-micro);
  color: var(--text-3);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.badge {
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger);
}

.rmeta {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.rmeta b {
  color: var(--text-1);
  font-weight: 600;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 1px;
}

.tag {
  font-size: var(--fs-micro);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.prefs {
  flex: none;
  gap: 8px;
}

.pf {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-3);
  display: grid;
  place-items: center;
}

.pf.on[aria-label*='喜欢'] {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.pf.on[aria-label*='不喜欢'] {
  background: var(--danger-soft);
  color: var(--danger);
}

/* AI 弹层 */
.ai-panel {
  display: grid;
  gap: 14px;
  padding-bottom: 20px;
}

.seg-sm {
  width: 210px;
}

.ai-wait {
  padding: 30px 0;
}

.ai-err {
  color: var(--danger);
  font-size: var(--fs-subhead);
}

.ai-total {
  font-size: var(--fs-subhead);
}

.ai-total b {
  color: var(--text-1);
}

.ai-meals {
  display: grid;
  gap: 10px;
}

.ai-meals li {
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.ai-mhead {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.ai-mhead em {
  font-style: normal;
  margin-right: 7px;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.ai-mhead b {
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--text-3);
}

.ai-items {
  margin-top: 3px;
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.ai-warn {
  font-size: var(--fs-caption);
}
</style>
