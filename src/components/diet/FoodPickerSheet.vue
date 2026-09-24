<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronLeft, Minus, Plus, Search } from 'lucide-vue-next'

import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER } from '@/config/domain'
import { dietService } from '@/services/dietService'
import { useDietStore } from '@/stores/diet'
import { useToast } from '@/composables/useToast'
import { todayStr } from '@/utils/date'
import type { Food, MealType } from '@/types'

/**
 * 食物库选择器：搜索 → 选食物 → 克重 / 份量 → 餐次 → 写入当日记录。
 *  initialFood：外部已选定食物时（如食品详情页）跳过搜索，直接进数量/餐次。
 *  selectOnly：纯选择模式（识别结果换匹配用）——点结果即回传 pick 并关闭，不落库。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    initialFood?: Food | null
    selectOnly?: boolean
    title?: string
    /** 预选餐次（智能添加跟随其餐次选择）；缺省早餐 */
    defaultMeal?: MealType | null
  }>(),
  { initialFood: null, selectOnly: false, title: '添加食物' },
)

const emit = defineEmits<{
  close: []
  /** selectOnly 模式：选中某个食物 */
  pick: [Food]
}>()

const diet = useDietStore()
const { toast } = useToast()

/* 外部带食物打开（详情页「记录」）：隐藏搜索与返回，纯记录面板 */
const external = computed(() => !!props.initialFood)

const query = ref('')
const results = ref<Food[]>([])
const selected = ref<Food | null>(null)

const mode = ref<'grams' | 'unit'>('grams')
const grams = ref(100)
const unitName = ref('')
const unitCount = ref(1)
const mealType = ref<MealType>('breakfast')

/* 打开时重置；带 initialFood 则直接进入数量/餐次 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    results.value = []
    selected.value = null
    mealType.value = props.defaultMeal ?? 'breakfast'
    if (props.initialFood) pick(props.initialFood)
    else void search()
  },
)

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void search(), 220)
})

async function search(): Promise<void> {
  const q = query.value.trim()
  // 有输入走 Rust 模糊搜索（按相似度排序），空输入回退常用列表
  results.value = q ? await dietService.searchFoodsFuzzy(q, 30) : await dietService.listFoods()
}

function pick(f: Food): void {
  if (props.selectOnly) {
    emit('pick', f)
    emit('close')
    return
  }
  selected.value = f
  const hasUnits = f.units.length > 0
  mode.value = hasUnits ? 'unit' : 'grams'
  unitName.value = f.defaultUnit ?? f.units[0]?.name ?? ''
  unitCount.value = 1
  grams.value = 100
}

const effGrams = computed(() => {
  if (!selected.value) return 0
  if (mode.value === 'grams') return Math.max(0, grams.value)
  const u = selected.value.units.find((x) => x.name === unitName.value)
  return Math.round(Math.max(0, unitCount.value) * (u?.grams ?? 100))
})

const kcalPreview = computed(() =>
  selected.value ? Math.round((selected.value.kcal * effGrams.value) / 100) : 0,
)

const adding = ref(false)

async function confirmAdd(): Promise<void> {
  const f = selected.value
  if (!f || effGrams.value <= 0 || adding.value) return
  adding.value = true
  try {
    await diet.add({
      foodId: f.id,
      date: todayStr(),
      mealType: mealType.value,
      quantityMode: mode.value,
      grams: effGrams.value,
      units: mode.value === 'unit' ? unitCount.value : null,
      unitName: mode.value === 'unit' ? unitName.value : null,
      source: 'search',
      note: null,
    })
    toast(`已记录 ${f.name} ${kcalPreview.value} 大卡`)
    selected.value = null
    emit('close')
  } finally {
    adding.value = false
  }
}

function bump(delta: number): void {
  if (mode.value === 'grams') grams.value = Math.max(0, grams.value + delta)
  else unitCount.value = Math.max(0, Math.round((unitCount.value + delta) * 2) / 2)
}
</script>

<template>
  <SheetModal :open :title @close="emit('close')">
    <!-- 搜索（外部带食物时隐藏） -->
    <div v-if="!external" class="finder row">
      <Search :size="17" class="t-3" />
      <input v-model="query" type="text" placeholder="搜索食物或分类，如「主食」「牛奶」">
    </div>

    <!-- 结果列表 -->
    <ul v-if="!selected" class="list" data-rubber-self>
      <li v-for="f in results" :key="f.id">
        <button class="row item" @click="pick(f)">
          <span class="flex-1">
            <b>{{ f.name }}</b>
            <small>{{ f.category ?? '其他' }}<template v-if="f.units.length"> · 1{{ f.defaultUnit ?? f.units[0]!.name }}≈{{ f.units[0]!.grams }}g</template></small>
          </span>
          <span class="num kcal">{{ f.kcal }}<em>/100g</em></span>
        </button>
      </li>
      <li v-if="results.length === 0" class="none t-3">没有匹配的食物</li>
    </ul>

    <!-- 数量与餐次 -->
    <div v-else class="detail">
      <button v-if="!external" class="back row" @click="selected = null">
        <ChevronLeft :size="18" /> 返回搜索
      </button>

      <header class="food-head">
        <h3>{{ selected.name }}</h3>
        <p class="num t-3">{{ selected.kcal }} 大卡 / 100g · 蛋白 {{ selected.protein }}g · 碳水 {{ selected.carb }}g · 脂肪 {{ selected.fat }}g</p>
      </header>

      <SegmentedControl
        v-if="selected.units.length > 0"
        v-model="mode"
        :options="[
          { value: 'grams', label: '按克重' },
          { value: 'unit', label: '按份' },
        ]"
      />

      <div v-if="mode === 'grams'" class="stepper row between">
        <button aria-label="减少" @click="bump(-50)"><Minus :size="18" /></button>
        <span class="num"><b>{{ grams }}</b> g</span>
        <button aria-label="增加" @click="bump(50)"><Plus :size="18" /></button>
      </div>

      <template v-else>
        <ul class="units row">
          <li v-for="u in selected.units" :key="u.name">
            <button class="uchip" :class="{ on: u.name === unitName }" @click="unitName = u.name">
              {{ u.name }}<small class="num">{{ u.grams }}g</small>
            </button>
          </li>
        </ul>
        <div class="stepper row between">
          <button aria-label="减少" @click="bump(-0.5)"><Minus :size="18" /></button>
          <span class="num"><b>{{ unitCount }}</b> {{ unitName }}</span>
          <button aria-label="增加" @click="bump(0.5)"><Plus :size="18" /></button>
        </div>
      </template>

      <SegmentedControl
        v-model="mealType"
        :options="MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))"
      />

      <div class="row preview between">
        <span>约 <b class="num">{{ kcalPreview }}</b> 大卡</span>
        <button class="add" :disabled="adding || effGrams <= 0" @click="confirmAdd">加入{{ MEAL_LABELS[mealType] }}</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.finder {
  gap: 8px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.finder input {
  flex: 1;
  font-size: var(--fs-subhead);
}

.list {
  margin-top: 8px;
  max-height: 46dvh;
  overflow-y: auto;
}

.item {
  width: 100%;
  text-align: left;
  gap: 10px;
  padding: 12px 2px;
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

.none {
  text-align: center;
  padding: 28px 0;
  font-size: var(--fs-subhead);
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 6px;
}

.back {
  align-self: flex-start;
  gap: 2px;
  color: var(--accent);
  font-size: var(--fs-subhead);
  font-weight: 600;
  margin-left: -6px;
}

.food-head h3 {
  font-size: var(--fs-title2);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.food-head p {
  font-size: var(--fs-caption);
  margin: 2px 0 4px;
}

.stepper {
  padding: 8px 6px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.stepper button {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  display: flex;
  align-items: center;
  justify-content: center;
}

.stepper b {
  font-size: var(--fs-title1);
  font-weight: 700;
  letter-spacing: -0.5px;
  margin-right: 3px;
}

.units {
  gap: 8px;
  flex-wrap: wrap;
}

.uchip {
  padding: 8px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
}

.uchip small {
  margin-left: 4px;
  color: var(--text-3);
  font-weight: 400;
}

.uchip.on {
  background: var(--accent);
  color: var(--on-accent);
}

.uchip.on small {
  color: color-mix(in srgb, var(--on-accent) 75%, transparent);
}

.preview span {
  font-size: var(--fs-body);
  color: var(--text-2);
}

.preview b {
  color: var(--text-1);
  font-weight: 700;
}

.add {
  padding: 12px 22px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-body);
  font-weight: 600;
}

.add:disabled {
  opacity: 0.35;
}
</style>
