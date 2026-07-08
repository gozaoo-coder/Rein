<script setup lang="ts">
/**
 * FoodDatabasePage — 食品数据库
 *
 * - 搜索 + 分类chip（横向滚动+边缘渐变遮罩）
 * - 简化列表：食物名 / 健康评分 / 每份热量 / 右侧添加按钮
 * - 自定义食品增/改/删（含完整营养素表单）
 * - 点击列表项 → 详情 BottomSheet（营养素明细 + 单位切换）
 * - 点击 + 按钮 → 添加到今日饮食 BottomSheet（含 AI 拍照估重）
 */
import { computed, onMounted, reactive, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { FOOD_CATEGORIES } from "@/data/foodDatabase";
import { HEALTH_SCORE_LABEL, type FoodItem, type FoodUnit, type HealthScore, type CustomNutrient } from "@/types/health";
import { BottomSheet } from "@/components/ui";
import { useToast } from "@/composables/useToast";
import { useAiConfigStore } from "@/stores/aiConfigStore";
import { nutrientsForGrams, type NutrientEntry } from "@/utils/foodNutrients";
import { fileToDataURL, estimateGramsByVision } from "@/composables/useAiVisionEstimate";

const store = useHealthDataStore();
const toast = useToast();
const aiConfigStore = useAiConfigStore();

onMounted(() => {
  void store.load();
  void aiConfigStore.load();
});

const searchQuery = ref("");
const activeCategory = ref<string>("全部");

const filteredFoods = computed<FoodItem[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return store.foodDb.filter((f) => {
    const matchCat = activeCategory.value === "全部" || f.category === activeCategory.value;
    const matchQ = !q || f.name.toLowerCase().includes(q) || f.category.toLowerCase().includes(q);
    return matchCat && matchQ;
  });
});

const groupedFoods = computed<{ category: string; items: FoodItem[] }[]>(() => {
  const groups: { category: string; items: FoodItem[] }[] = [];
  for (const cat of FOOD_CATEGORIES) {
    const items = filteredFoods.value.filter((f) => f.category === cat);
    if (items.length > 0) groups.push({ category: cat, items });
  }
  const others = filteredFoods.value.filter((f) => !FOOD_CATEGORIES.includes(f.category));
  if (others.length > 0) groups.push({ category: "其他", items: others });
  return groups;
});

function caloriesPerUnit(food: FoodItem, unit: FoodUnit): number {
  return Math.round((food.caloriesPer100g * unit.grams) / 100);
}

function primaryUnit(food: FoodItem): FoodUnit {
  return food.units[0] ?? { name: "100g", grams: 100 };
}

const HEALTH_SCORE_COLORS: Record<HealthScore, string> = {
  0: "#dc3545",
  1: "#fd7e14",
  2: "#ffc107",
  3: "#20c997",
  4: "#28a745",
  5: "#0a59f7",
};

function addToLog(food: FoodItem) {
  const unit = primaryUnit(food);
  store.addFoodRecord({
    foodId: food.id,
    foodName: food.name,
    grams: unit.grams,
  });
}

// ===== 详情 BottomSheet =====
const showDetailSheet = ref(false);
const detailFood = ref<FoodItem | null>(null);
const detailBasis = ref<{ kind: "100g" } | { kind: "unit"; idx: number }>({ kind: "100g" });

function openDetail(food: FoodItem) {
  detailFood.value = food;
  detailBasis.value = { kind: "100g" };
  showDetailSheet.value = true;
}

const detailGrams = computed<number>(() => {
  if (!detailFood.value) return 100;
  const b = detailBasis.value;
  if (b.kind === "100g") return 100;
  return detailFood.value.units[b.idx]?.grams ?? 100;
});

const detailNutrients = computed<NutrientEntry[]>(() => {
  if (!detailFood.value) return [];
  return nutrientsForGrams(detailFood.value, detailGrams.value);
});

const GROUP_LABEL: Record<NutrientEntry["group"], string> = {
  macro: "三大营养素",
  fiber: "膳食纤维",
  mineral: "矿物质",
  vitamin: "维生素",
  other: "其他",
};
const GROUP_ORDER: NutrientEntry["group"][] = ["macro", "fiber", "mineral", "vitamin", "other"];

const detailGrouped = computed<{ group: NutrientEntry["group"]; label: string; items: NutrientEntry[] }[]>(() => {
  const map = new Map<NutrientEntry["group"], NutrientEntry[]>();
  for (const n of detailNutrients.value) {
    const arr = map.get(n.group) ?? [];
    arr.push(n);
    map.set(n.group, arr);
  }
  return GROUP_ORDER
    .filter((g) => map.has(g))
    .map((g) => ({ group: g, label: GROUP_LABEL[g], items: map.get(g)! }));
});

function detailEdit() {
  const f = detailFood.value;
  if (!f || !f.custom) return;
  showDetailSheet.value = false;
  openEdit(f);
}

// ===== 添加到今日饮食 BottomSheet =====
const showAddSheet = ref(false);
const addFood = ref<FoodItem | null>(null);
const addUnitIdx = ref(-1); // -1 表示 100g
const addGrams = ref(100);
const aiProcessing = ref(false);
const aiHint = ref("");
const aiFileInput = ref<HTMLInputElement | null>(null);

function openAddToToday(food: FoodItem) {
  addFood.value = food;
  addUnitIdx.value = -1;
  addGrams.value = 100;
  aiProcessing.value = false;
  aiHint.value = "";
  showAddSheet.value = true;
}

const addUnitGrams = computed<number>(() => {
  if (!addFood.value) return 100;
  if (addUnitIdx.value === -1) return 100;
  return addFood.value.units[addUnitIdx.value]?.grams ?? 100;
});

function setAddUnit(idx: number) {
  addUnitIdx.value = idx;
  addGrams.value = addUnitGrams.value;
}

const addPreview = computed(() => {
  const f = addFood.value;
  if (!f) return { calories: 0, carbs: 0, protein: 0, fat: 0 };
  const r = addGrams.value / 100;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    calories: Math.round(f.caloriesPer100g * r),
    carbs: round(f.carbsPer100g * r),
    protein: round(f.proteinPer100g * r),
    fat: round(f.fatPer100g * r),
  };
});

const QUICK_GRAMS = [50, 100, 150, 200, 300];

function onAiPickClick() {
  aiFileInput.value?.click();
}

async function onAiFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file || !addFood.value) return;
  aiProcessing.value = true;
  aiHint.value = "";
  try {
    const dataURL = await fileToDataURL(file);
    const result = await estimateGramsByVision(addFood.value.name, dataURL);
    addGrams.value = result.grams;
    if (result.reasoning) aiHint.value = result.reasoning;
    toast.success(`AI 估重 ${result.grams}g`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "AI 估重失败");
  } finally {
    aiProcessing.value = false;
    target.value = "";
  }
}

function confirmAddToToday() {
  const f = addFood.value;
  if (!f) return;
  const grams = Math.max(0, Number(addGrams.value) || 0);
  if (grams <= 0) {
    toast.warning("请输入有效克数");
    return;
  }
  store.addFoodRecord({
    foodId: f.id,
    foodName: f.name,
    grams,
  });
  toast.success(`已添加 ${grams}克 ${f.name}`);
  showAddSheet.value = false;
}

// ===== 表单 =====
interface FoodFormState {
  id: string | null;
  name: string;
  category: string;
  caloriesPer100g: number | null;
  carbsPer100g: number | null;
  proteinPer100g: number | null;
  fatPer100g: number | null;
  fiberPer100g: number | null;
  sugarPer100g: number | null;
  sodiumPer100g: number | null;
  healthScore: HealthScore;
  description: string;
  units: FoodUnit[];
  customNutrients: CustomNutrient[];
}

const showForm = ref(false);
const editingCustom = ref(false);
const form = reactive<FoodFormState>({
  id: null,
  name: "",
  category: FOOD_CATEGORIES[0],
  caloriesPer100g: null,
  carbsPer100g: null,
  proteinPer100g: null,
  fatPer100g: null,
  fiberPer100g: null,
  sugarPer100g: null,
  sodiumPer100g: null,
  healthScore: 3,
  description: "",
  units: [{ name: "", grams: null as number | null }],
  customNutrients: [],
});

function resetForm() {
  form.id = null;
  form.name = "";
  form.category = FOOD_CATEGORIES[0];
  form.caloriesPer100g = null;
  form.carbsPer100g = null;
  form.proteinPer100g = null;
  form.fatPer100g = null;
  form.fiberPer100g = null;
  form.sugarPer100g = null;
  form.sodiumPer100g = null;
  form.healthScore = 3;
  form.description = "";
  form.units = [{ name: "", grams: null }];
  form.customNutrients = [];
  editingCustom.value = false;
}

function openAdd() {
  resetForm();
  showForm.value = true;
}

function openEdit(food: FoodItem) {
  form.id = food.id;
  form.name = food.name;
  form.category = food.category;
  form.caloriesPer100g = food.caloriesPer100g;
  form.carbsPer100g = food.carbsPer100g;
  form.proteinPer100g = food.proteinPer100g;
  form.fatPer100g = food.fatPer100g;
  form.fiberPer100g = food.fiberPer100g ?? null;
  form.sugarPer100g = food.sugarPer100g ?? null;
  form.sodiumPer100g = food.sodiumPer100g ?? null;
  form.healthScore = food.healthScore;
  form.description = food.description ?? "";
  form.units = food.units.map((u) => ({ name: u.name, grams: u.grams }));
  form.customNutrients = food.customNutrients ? [...food.customNutrients] : [];
  editingCustom.value = true;
  showForm.value = true;
}

function closeForm() {
  showForm.value = false;
  resetForm();
}

function addUnit() {
  form.units.push({ name: "", grams: null });
}
function removeUnit(idx: number) {
  if (form.units.length <= 1) return;
  form.units.splice(idx, 1);
}
function addCustomNutrient() {
  form.customNutrients.push({ name: "", value: 0, unit: "mg" });
}
function removeCustomNutrient(idx: number) {
  form.customNutrients.splice(idx, 1);
}

function submitForm() {
  if (!form.name.trim()) return;
  if (form.caloriesPer100g == null || form.caloriesPer100g < 0) return;
  const payload = {
    name: form.name.trim(),
    category: form.category,
    caloriesPer100g: Number(form.caloriesPer100g) || 0,
    carbsPer100g: Number(form.carbsPer100g) || 0,
    proteinPer100g: Number(form.proteinPer100g) || 0,
    fatPer100g: Number(form.fatPer100g) || 0,
    fiberPer100g: form.fiberPer100g != null ? Number(form.fiberPer100g) : undefined,
    sugarPer100g: form.sugarPer100g != null ? Number(form.sugarPer100g) : undefined,
    sodiumPer100g: form.sodiumPer100g != null ? Number(form.sodiumPer100g) : undefined,
    healthScore: form.healthScore,
    description: form.description.trim() || undefined,
    units: form.units
      .filter((u) => u.name.trim() && u.grams != null && u.grams > 0)
      .map((u) => ({ name: u.name.trim(), grams: Number(u.grams) || 0 })),
    customNutrients: form.customNutrients.filter((n) => n.name.trim()).length > 0
      ? form.customNutrients.filter((n) => n.name.trim()).map((n) => ({
          name: n.name.trim(),
          value: Number(n.value) || 0,
          unit: n.unit.trim() || "mg",
        }))
      : undefined,
  };
  if (editingCustom.value && form.id) {
    store.updateFoodItem(form.id, payload);
  } else {
    store.addFoodItem(payload);
  }
  closeForm();
}

function removeFood(food: FoodItem) {
  if (!food.custom) return;
  if (confirm(`删除「${food.name}」？`)) {
    store.deleteFoodItem(food.id);
  }
}
</script>

<template>
  <div class="food-db-page page-scroll">
    <h2 class="page-title">食品数据库</h2>

    <div class="search-row clean-card">
      <i class="bi bi-search search-icon"></i>
      <input v-model="searchQuery" type="text" placeholder="搜索食品名 / 分类" class="search-input" />
    </div>

    <div class="chip-row">
      <button
        class="chip"
        :class="{ 'chip--active': activeCategory === '全部' }"
        @click="activeCategory = '全部'"
      >全部</button>
      <button
        v-for="cat in FOOD_CATEGORIES"
        :key="cat"
        class="chip"
        :class="{ 'chip--active': activeCategory === cat }"
        @click="activeCategory = cat"
      >{{ cat }}</button>
    </div>

    <button class="add-btn" @click="openAdd">
      <i class="bi bi-plus-lg"></i>
      <span>新建食品</span>
    </button>

    <div v-if="groupedFoods.length === 0" class="empty clean-card">暂无匹配食品</div>

    <div v-for="group in groupedFoods" :key="group.category" class="group-card clean-card">
      <div class="group-header">
        <h3 class="group-title">{{ group.category }}</h3>
        <span class="group-count">{{ group.items.length }}</span>
      </div>
      <div class="food-list">
        <div v-for="food in group.items" :key="food.id" class="food-item">
          <div class="food-main" @click="openDetail(food)">
            <div class="food-top">
              <span class="food-name">{{ food.name }}</span>
              <span v-if="food.custom" class="preset-badge">自定</span>
            </div>
            <div class="food-meta">
              <span
                class="health-dot"
                :style="{ background: HEALTH_SCORE_COLORS[food.healthScore] }"
              />
              <span class="health-label">{{ HEALTH_SCORE_LABEL[food.healthScore] }}</span>
              <span class="sep">·</span>
              <span class="cal-text">
                {{ caloriesPerUnit(food, primaryUnit(food)) }}千卡/{{ primaryUnit(food).name }}
              </span>
            </div>
          </div>
          <button class="add-food-btn" @click.stop="openAddToToday(food)" aria-label="添加到今日饮食">
            <i class="bi bi-plus-lg"></i>
          </button>
          <div v-if="food.custom" class="food-actions">
            <button class="icon-btn" @click="openEdit(food)" aria-label="编辑">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="icon-btn icon-btn--del" @click="removeFood(food)" aria-label="删除">
              <i class="bi bi-trash3"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 详情 BottomSheet -->
    <BottomSheet
      v-model:visible="showDetailSheet"
      :title="detailFood?.name ?? ''"
      :detents="['medium', 'large']"
      default-detent="medium"
    >
      <div v-if="detailFood" class="detail-content">
        <div class="detail-basis-row">
          <span class="detail-basis-label">单位基准</span>
          <div class="basis-chips">
            <button
              class="basis-chip"
              :class="{ 'basis-chip--active': detailBasis.kind === '100g' }"
              @click="detailBasis = { kind: '100g' }"
            >100g</button>
            <button
              v-for="(u, i) in detailFood.units"
              :key="i"
              class="basis-chip"
              :class="{ 'basis-chip--active': detailBasis.kind === 'unit' && detailBasis.idx === i }"
              @click="detailBasis = { kind: 'unit', idx: i }"
            >{{ u.name }}({{ u.grams }}g)</button>
          </div>
        </div>

        <div class="detail-grams-hint">
          当前按 <strong>{{ detailGrams }}g</strong> 计算营养素
        </div>

        <div v-for="g in detailGrouped" :key="g.group" class="detail-group">
          <h4 class="detail-group-title">{{ g.label }}</h4>
          <div class="nutrient-grid">
            <div v-for="n in g.items" :key="n.name" class="nutrient-cell">
              <div class="n-top">
                <span class="n-name">{{ n.name }}</span>
                <span class="n-val">{{ n.value }}<span class="n-unit">{{ n.unit }}</span></span>
              </div>
              <div v-if="n.group === 'macro' && n.name !== '热量'" class="n-bar">
                <div class="n-bar-fill" :style="{
                  width: Math.min(n.value / (n.name === '碳水化合物' ? 250 : n.name === '蛋白质' ? 60 : 70) * 100, 100) + '%',
                  background: n.name === '碳水化合物' ? '#f5a623' : n.name === '蛋白质' ? '#64bb5c' : '#9b59b6',
                }" />
              </div>
            </div>
          </div>
        </div>

        <div v-if="detailFood.description" class="detail-desc">
          <span class="detail-desc-label">描述</span>
          <p class="detail-desc-text">{{ detailFood.description }}</p>
        </div>

        <button
          v-if="detailFood.custom"
          class="detail-edit-btn"
          @click="detailEdit"
        >
          <i class="bi bi-pencil"></i>
          <span>编辑食品</span>
        </button>
      </div>
    </BottomSheet>

    <!-- 添加到今日饮食 BottomSheet -->
    <BottomSheet
      v-model:visible="showAddSheet"
      :title="addFood ? `添加 ${addFood.name}` : '添加到今日饮食'"
      :detents="['medium', 'large']"
      default-detent="medium"
    >
      <div v-if="addFood" class="add-content">
        <div class="add-section">
          <span class="add-label">单位</span>
          <div class="basis-chips">
            <button
              class="basis-chip"
              :class="{ 'basis-chip--active': addUnitIdx === -1 }"
              @click="setAddUnit(-1)"
            >100g</button>
            <button
              v-for="(u, i) in addFood.units"
              :key="i"
              class="basis-chip"
              :class="{ 'basis-chip--active': addUnitIdx === i }"
              @click="setAddUnit(i)"
            >{{ u.name }}({{ u.grams }}g)</button>
          </div>
        </div>

        <div class="add-section">
          <span class="add-label">克数</span>
          <input
            v-model.number="addGrams"
            type="number"
            min="0"
            step="1"
            placeholder="克数"
            class="text-input add-grams-input"
          />
        </div>

        <div class="add-section">
          <span class="add-label">快速选择</span>
          <div class="quick-chips">
            <button
              v-for="g in QUICK_GRAMS"
              :key="g"
              class="quick-chip"
              :class="{ 'quick-chip--active': addGrams === g }"
              @click="addGrams = g"
            >{{ g }}g</button>
          </div>
        </div>

        <div v-if="aiConfigStore.isConfigured" class="add-section">
          <button
            class="ai-estimate-btn"
            :disabled="aiProcessing"
            @click="onAiPickClick"
          >
            <i class="bi bi-camera"></i>
            <span>{{ aiProcessing ? 'AI 估算中…' : 'AI 拍照估重' }}</span>
          </button>
          <input
            ref="aiFileInput"
            type="file"
            accept="image/*"
            capture="environment"
            class="ai-file-input"
            @change="onAiFileChange"
          />
          <p v-if="aiHint" class="ai-hint">
            <i class="bi bi-info-circle"></i>
            {{ aiHint }}
          </p>
        </div>

        <div class="add-preview clean-card">
          <div class="preview-title">营养预览（{{ addGrams }}g）</div>
          <div class="preview-row">
            <div class="preview-cell">
              <span class="preview-name">热量</span>
              <span class="preview-val">{{ addPreview.calories }}<span class="preview-unit">千卡</span></span>
            </div>
            <div class="preview-cell">
              <span class="preview-name">碳水</span>
              <span class="preview-val">{{ addPreview.carbs }}<span class="preview-unit">g</span></span>
            </div>
            <div class="preview-cell">
              <span class="preview-name">蛋白质</span>
              <span class="preview-val">{{ addPreview.protein }}<span class="preview-unit">g</span></span>
            </div>
            <div class="preview-cell">
              <span class="preview-name">脂肪</span>
              <span class="preview-val">{{ addPreview.fat }}<span class="preview-unit">g</span></span>
            </div>
          </div>
        </div>

        <button class="confirm-add-btn" @click="confirmAddToToday">
          添加 {{ addGrams }}克
        </button>
      </div>
    </BottomSheet>

    <!-- 表单 Sheet -->
    <div v-if="showForm" class="sheet-mask" @click.self="closeForm">
      <div class="sheet clean-card">
        <div class="sheet-header">
          <h3 class="sheet-title">{{ editingCustom ? "编辑食品" : "新建食品" }}</h3>
          <button class="close-btn" @click="closeForm" aria-label="关闭">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>

        <div class="sheet-body">
          <label class="field">
            <span class="field-label">名称</span>
            <input v-model="form.name" type="text" placeholder="如 鸡胸肉" class="text-input" />
          </label>

          <label class="field">
            <span class="field-label">分类</span>
            <select v-model="form.category" class="text-input">
              <option v-for="cat in FOOD_CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
            </select>
          </label>

          <div class="field">
            <span class="field-label">健康评分</span>
            <div class="score-row">
              <button
                v-for="s in ([0,1,2,3,4,5] as HealthScore[])"
                :key="s"
                class="score-btn"
                :class="{ 'score-btn--active': form.healthScore === s }"
                :style="form.healthScore === s ? { background: HEALTH_SCORE_COLORS[s], color: '#fff', borderColor: HEALTH_SCORE_COLORS[s] } : {}"
                @click="form.healthScore = s"
              >
                {{ HEALTH_SCORE_LABEL[s] }}
              </button>
            </div>
          </div>

          <div class="field-grid">
            <label class="field">
              <span class="field-label">热量 / 100g (千卡)</span>
              <input v-model.number="form.caloriesPer100g" type="number" min="0" placeholder="千卡" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">碳水 / 100g</span>
              <input v-model.number="form.carbsPer100g" type="number" min="0" placeholder="g" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">蛋白质 / 100g</span>
              <input v-model.number="form.proteinPer100g" type="number" min="0" placeholder="g" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">脂肪 / 100g</span>
              <input v-model.number="form.fatPer100g" type="number" min="0" placeholder="g" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">膳食纤维 / 100g</span>
              <input v-model.number="form.fiberPer100g" type="number" min="0" placeholder="g" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">糖 / 100g</span>
              <input v-model.number="form.sugarPer100g" type="number" min="0" placeholder="g" class="text-input" />
            </label>
            <label class="field">
              <span class="field-label">钠 / 100g</span>
              <input v-model.number="form.sodiumPer100g" type="number" min="0" placeholder="mg" class="text-input" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">描述（可选）</span>
            <input v-model="form.description" type="text" placeholder="食品描述/备注" class="text-input" />
          </label>

          <div class="field">
            <div class="units-header">
              <span class="field-label">单位换算</span>
              <button class="link-btn" @click="addUnit">+ 添加单位</button>
            </div>
            <div class="units-list">
              <div v-for="(u, i) in form.units" :key="i" class="unit-row">
                <input v-model="u.name" type="text" placeholder="单位名（如 个）" class="text-input unit-name" />
                <input v-model.number="u.grams" type="number" min="0" placeholder="克数" class="text-input unit-grams" />
                <button
                  v-if="form.units.length > 1"
                  class="icon-btn icon-btn--del"
                  @click="removeUnit(i)"
                  aria-label="删除单位"
                ><i class="bi bi-dash-lg"></i></button>
              </div>
            </div>
          </div>

          <div class="field">
            <div class="units-header">
              <span class="field-label">自定义营养素（咖啡因等）</span>
              <button class="link-btn" @click="addCustomNutrient">+ 添加</button>
            </div>
            <div class="units-list">
              <div v-for="(n, i) in form.customNutrients" :key="i" class="unit-row">
                <input v-model="n.name" type="text" placeholder="名称（如 咖啡因）" class="text-input unit-name" />
                <input v-model.number="n.value" type="number" min="0" placeholder="数值" class="text-input unit-grams" />
                <input v-model="n.unit" type="text" placeholder="单位" class="text-input unit-unit" />
                <button class="icon-btn icon-btn--del" @click="removeCustomNutrient(i)" aria-label="删除">
                  <i class="bi bi-dash-lg"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="sheet-footer">
          <button class="cancel-btn" @click="closeForm">取消</button>
          <button class="submit-btn" :disabled="!form.name.trim()" @click="submitForm">
            {{ editingCustom ? "保存" : "添加" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.food-db-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
}

.page-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
}
.search-icon {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  font-size: 16px;
}
.search-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--text-md);
  color: var(--color-text);
  outline: none;
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1.5px dashed var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}
.add-btn:active { transform: scale(0.98); }

.chip-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  padding: 2px 4px;
  scrollbar-width: none;
  mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
}
.chip-row::-webkit-scrollbar { display: none; }
.chip {
  flex-shrink: 0;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--bg-300);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.chip:active { transform: scale(0.95); }
.chip--active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

.empty {
  padding: var(--space-5);
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
}

.group-card {
  padding: var(--space-4);
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}
.group-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.group-count {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.food-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.food-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.food-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.food-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.food-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.preset-badge {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--bg-300);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--fw-semibold);
}

.food-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.health-label {
  font-weight: var(--fw-semibold);
}
.sep {
  color: var(--color-text-tertiary);
}
.cal-text {
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}

.add-food-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--color-warm);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  flex-shrink: 0;
  transition: transform 0.15s;
}
.add-food-btn:active { transform: scale(0.9); }

.food-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
}
.icon-btn--del:active { color: var(--danger-500); }

/* Sheet */
.sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 100;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  animation: fade-in 0.2s var(--ease-immersive);
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

.sheet {
  width: 100%;
  max-width: 520px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-modal);
  animation: sheet-up 0.28s var(--ease-immersive);
}
@keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-divider);
}
.sheet-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}
.text-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  background: var(--bg-100);
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
}
.text-input:focus {
  border-color: var(--color-warm);
  background: var(--bg-50);
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.score-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.score-btn {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}

.units-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.link-btn {
  background: transparent;
  border: none;
  color: var(--color-warm);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.units-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.unit-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.unit-name { flex: 2; }
.unit-grams { flex: 1; }
.unit-unit { flex: 1; }

.sheet-footer {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-4);
  border-top: 1px solid var(--color-divider);
}
.cancel-btn,
.submit-btn {
  flex: 1;
  padding: 12px;
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.cancel-btn { background: var(--bg-200); color: var(--color-text-secondary); }
.submit-btn { background: var(--color-warm); color: #fff; }
.submit-btn:disabled { background: var(--bg-300); cursor: not-allowed; }

/* ===== 详情 BottomSheet ===== */
.detail-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.detail-basis-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-basis-label,
.add-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}

.basis-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.basis-chip {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--bg-300);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.basis-chip:active { transform: scale(0.95); }
.basis-chip--active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

.detail-grams-hint {
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  padding: 8px 10px;
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.detail-grams-hint strong {
  color: var(--color-warm);
  font-weight: var(--fw-bold);
}

.detail-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.detail-group-title {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}

.nutrient-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.nutrient-cell {
  padding: var(--space-2);
  background: var(--bg-100);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.n-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}
.n-name {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}
.n-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.n-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  margin-left: 2px;
}
.n-bar {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  overflow: hidden;
}
.n-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s var(--ease-immersive);
}

.detail-desc {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.detail-desc-label {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}
.detail-desc-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  line-height: 1.5;
}

.detail-edit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}
.detail-edit-btn:active { transform: scale(0.98); }

@media (min-width: 480px) {
  .nutrient-grid {
    grid-template-columns: 1fr 1fr 1fr;
  }
}

/* ===== 添加到今日饮食 BottomSheet ===== */
.add-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-2);
}
.add-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.add-grams-input {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
}

.quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.quick-chip {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--bg-300);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
}
.quick-chip:active { transform: scale(0.95); }
.quick-chip--active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

.ai-estimate-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1.5px dashed var(--color-warm);
  background: var(--warm-50);
  color: var(--color-warm);
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s;
  width: 100%;
}
.ai-estimate-btn:active { transform: scale(0.98); }
.ai-estimate-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ai-file-input {
  display: none;
}
.ai-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  background: var(--warm-50);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.ai-hint i {
  flex-shrink: 0;
  color: var(--color-warm);
  margin-top: 2px;
}

.add-preview {
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.preview-title {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: var(--fw-semibold);
}
.preview-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.preview-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  background: var(--bg-100);
  border-radius: var(--radius-md);
}
.preview-name {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
.preview-val {
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  color: var(--color-text);
}
.preview-unit {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-weight: var(--fw-medium);
  margin-left: 2px;
}

.confirm-add-btn {
  padding: 14px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-bold);
  cursor: pointer;
  transition: transform 0.15s;
}
.confirm-add-btn:active { transform: scale(0.98); }
</style>
