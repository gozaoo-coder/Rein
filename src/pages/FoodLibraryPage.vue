<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, Pencil, Search } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import FoodDetailDrawer from '@/components/diet/FoodDetailDrawer.vue'
import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import { dietService } from '@/services/dietService'
import type { Food } from '@/types'

/** 饮食库：全部食物浏览（搜索 + 分类筛选），点行进详情抽屉；右下角「记录」悬浮按钮直接记一笔。 */
const all = ref<Food[]>([])
const ready = ref(false)
const query = ref('')
const category = ref<string | null>(null)

const detailOpen = ref(false)
const detailFood = ref<Food | null>(null)
const recordOpen = ref(false)
const recordFood = ref<Food | null>(null)

function openFood(f: Food): void {
  detailFood.value = f
  detailOpen.value = true
}

function onAdd(): void {
  recordFood.value = null
  recordOpen.value = true
}

/** 抽屉内「记录这一食物」：关闭抽屉并带上该食物进入数量/餐次 */
function onRecord(): void {
  recordFood.value = detailFood.value
  detailOpen.value = false
  recordOpen.value = true
}

/* 库量级数千：默认只渲染首屏一批，避免一次性建几千个 DOM 节点 */
const CAP = 150
const expanded = ref(false)
watch([query, category], () => (expanded.value = false))

onMounted(async () => {
  all.value = await dietService.listFoods(undefined, null, 9999)
  ready.value = true
})

const categories = computed(() => [...new Set(all.value.map((f) => f.category ?? '其他'))])

const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  return all.value.filter(
    (f) =>
      (!category.value || (f.category ?? '其他') === category.value) &&
      (!q || f.name.toLowerCase().includes(q) || (f.category ?? '').toLowerCase().includes(q)),
  )
})

const shown = computed(() => (expanded.value ? list.value : list.value.slice(0, CAP)))
</script>

<template>
  <div class="page">
    <PageHeader back title="饮食库" :subtitle="`共 ${all.length} 种食物 · 数值为每 100 克`" />

    <div class="finder row">
      <Search :size="17" class="t-3" />
      <input v-model="query" type="text" placeholder="搜索食物或分类，如「主食」「牛奶」">
    </div>

    <!-- 分类筛选 -->
    <ul v-if="categories.length" class="cats row">
      <li>
        <button class="chip" :class="{ on: category === null }" @click="category = null">全部</button>
      </li>
      <li v-for="c in categories" :key="c">
        <button class="chip" :class="{ on: category === c }" @click="category = c">{{ c }}</button>
      </li>
    </ul>

    <section class="card">
      <ul v-if="list.length" class="foods">
        <li v-for="f in shown" :key="f.id">
          <button class="row item" @click="openFood(f)">
            <span class="flex-1">
              <b>{{ f.name }}</b>
              <small>{{ f.category ?? '其他' }}<template v-if="f.units.length"> · 1{{ f.defaultUnit ?? f.units[0]!.name }}≈{{ f.units[0]!.grams }}g</template></small>
            </span>
            <span class="num kcal">{{ f.kcal }}<em>/100g</em></span>
            <ChevronRight :size="16" class="t-3 chev" />
          </button>
        </li>
      </ul>
      <button v-if="list.length > shown.length" class="more t-2" @click="expanded = true">
        显示全部 {{ list.length }} 条（当前前 {{ shown.length }} 条，可先搜索/筛选）
      </button>
      <EmptyState v-else-if="ready" :icon="Search" title="没有匹配的食物" hint="换个关键词或分类试试" />
    </section>

    <!-- 右下角悬浮按钮：快速记一笔（Teleport 出页面层：translate 会改 fixed 后代的包含块） -->
    <Teleport to="body">
      <button class="fab row center" aria-label="记录食物" @click="onAdd">
        <Pencil :size="18" :stroke-width="2.4" />
        <span>记录</span>
      </button>
    </Teleport>

    <!-- 详情抽屉（Teleport；保证页面单根） -->
    <FoodDetailDrawer :open="detailOpen" :food="detailFood" @close="detailOpen = false" @record="onRecord" />

    <!-- 记录弹层：无食物 = 搜索选择；抽屉记录 = 带入食物直接进数量/餐次 -->
    <FoodPickerSheet :open="recordOpen" :initial-food="recordFood" @close="recordOpen = false" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.finder {
  gap: 8px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.finder input {
  flex: 1;
  font-size: var(--fs-subhead);
}

.cats {
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.chip {
  padding: 7px 14px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--accent);
  color: #fff;
}

.card {
  margin-top: 14px;
  padding: 6px 20px;
}

.item {
  width: 100%;
  text-align: left;
  gap: 10px;
  padding: 13px 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.item b {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
}

.item small {
  color: var(--text-3);
  font-size: var(--fs-caption);
}

.kcal {
  font-weight: 700;
  font-size: var(--fs-callout);
}

.kcal em {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--text-3);
}

.chev {
  flex: none;
}

.more {
  width: 100%;
  padding: 13px 0 7px;
  font-size: var(--fs-footnote);
  font-weight: 600;
}

/* 「记录」悬浮按钮（TabBar 之上，锚定页面右缘） */
.fab {
  position: fixed;
  right: max(18px, calc(50% - var(--frame-max) / 2 + 18px));
  bottom: calc(var(--dock-top) + 14px);
  z-index: 50;
  gap: 6px;
  padding: 12px 20px;
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  box-shadow: var(--shadow-float);
  font-size: var(--fs-headline);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.fab:active {
  transform: scale(0.95);
}
</style>
