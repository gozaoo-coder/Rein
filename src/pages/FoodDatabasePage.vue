<script setup lang="ts">
/**
 * FoodDatabasePage — 食品数据库
 *
 * - 搜索 + 分类筛选
 * - 按分类分组展示
 * - 自定义食品增/改/删，预设食品仅展示
 */
import { computed, onMounted, reactive, ref } from "vue";
import { useHealthDataStore } from "@/stores/healthDataStore";
import { FOOD_CATEGORIES } from "@/data/foodDatabase";
import type { FoodItem, FoodUnit } from "@/types/health";

const store = useHealthDataStore();

onMounted(() => {
  void store.load();
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

// ===== 表单 =====
interface FoodFormState {
  id: string | null;
  name: string;
  category: string;
  caloriesPer100g: number | null;
  carbsPer100g: number | null;
  proteinPer100g: number | null;
  fatPer100g: number | null;
  microNutrients: string;
  units: FoodUnit[];
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
  microNutrients: "",
  units: [{ name: "", grams: null as number | null }],
});

function resetForm() {
  form.id = null;
  form.name = "";
  form.category = FOOD_CATEGORIES[0];
  form.caloriesPer100g = null;
  form.carbsPer100g = null;
  form.proteinPer100g = null;
  form.fatPer100g = null;
  form.microNutrients = "";
  form.units = [{ name: "", grams: null }];
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
  form.microNutrients = food.microNutrients ?? "";
  form.units = food.units.map((u) => ({ name: u.name, grams: u.grams }));
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
    microNutrients: form.microNutrients.trim() || undefined,
    units: form.units
      .filter((u) => u.name.trim() && u.grams != null && u.grams > 0)
      .map((u) => ({ name: u.name.trim(), grams: Number(u.grams) || 0 })),
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
  <div class="food-db-page">
    <h2 class="page-title">食品数据库</h2>

    <!-- 搜索 -->
    <div class="search-row clean-card">
      <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input v-model="searchQuery" type="text" placeholder="搜索食品名 / 分类" class="search-input" />
    </div>

    <!-- 分类筛选 -->
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

    <!-- 添加按钮 -->
    <button class="add-btn" @click="openAdd">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span>新建食品</span>
    </button>

    <!-- 分组列表 -->
    <div v-if="groupedFoods.length === 0" class="empty clean-card">暂无匹配食品</div>

    <div v-for="group in groupedFoods" :key="group.category" class="group-card clean-card">
      <div class="group-header">
        <h3 class="group-title">{{ group.category }}</h3>
        <span class="group-count">{{ group.items.length }}</span>
      </div>
      <div class="food-list">
        <div v-for="food in group.items" :key="food.id" class="food-item">
          <div class="food-main">
            <div class="food-top">
              <span class="food-name">{{ food.name }}</span>
              <span v-if="!food.custom" class="preset-badge">预设</span>
            </div>
            <div class="food-cal">{{ food.caloriesPer100g }} 千卡/100g</div>
            <div class="food-macros">
              <span>碳水 {{ food.carbsPer100g }}g</span>
              <span>蛋白 {{ food.proteinPer100g }}g</span>
              <span>脂肪 {{ food.fatPer100g }}g</span>
            </div>
            <div v-if="food.units.length > 0" class="food-units">
              <span v-for="(u, i) in food.units" :key="i" class="unit-tag">{{ u.name }}·{{ u.grams }}g</span>
            </div>
            <div v-if="food.microNutrients" class="food-micro">{{ food.microNutrients }}</div>
          </div>
          <div v-if="food.custom" class="food-actions">
            <button class="icon-btn icon-btn--edit" @click="openEdit(food)" aria-label="编辑">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            <button class="icon-btn icon-btn--del" @click="removeFood(food)" aria-label="删除">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 表单 Sheet -->
    <div v-if="showForm" class="sheet-mask" @click.self="closeForm">
      <div class="sheet clean-card">
        <div class="sheet-header">
          <h3 class="sheet-title">{{ editingCustom ? "编辑食品" : "新建食品" }}</h3>
          <button class="close-btn" @click="closeForm" aria-label="关闭">×</button>
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

          <div class="field-grid">
            <label class="field">
              <span class="field-label">热量 / 100g</span>
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
          </div>

          <label class="field">
            <span class="field-label">微量营养（可选）</span>
            <input v-model="form.microNutrients" type="text" placeholder="如 富含维生素 B12" class="text-input" />
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
                >×</button>
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

/* 搜索 */
.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
}

.search-icon {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--text-md);
  color: var(--color-text);
  outline: none;
}

/* 分类 chips */
.chip-row {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding: 4px 2px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.chip-row::-webkit-scrollbar { display: none; }

.chip {
  flex-shrink: 0;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-divider);
  background: var(--bg-100);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  cursor: pointer;
  transition: all 0.15s var(--ease-immersive);
}

.chip--active {
  background: var(--color-warm);
  color: #fff;
  border-color: var(--color-warm);
}

/* 添加按钮 */
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

/* 空态 */
.empty {
  padding: var(--space-5);
  font-size: var(--text-sm);
  color: var(--color-text-tertiary);
  text-align: center;
}

/* 分组卡片 */
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
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-100);
  border-radius: var(--radius-md);
}

.food-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
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

.food-cal {
  font-size: var(--text-sm);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
}

.food-macros {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.food-units {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.unit-tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-200);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.food-micro {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  font-style: italic;
}

.food-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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
  transition: all 0.15s;
}

.icon-btn--edit:active { color: var(--color-warm); }
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

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

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

@keyframes sheet-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

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
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: 22px;
  cursor: pointer;
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

.unit-name { flex: 1; }
.unit-grams { flex: 1; }

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

.cancel-btn {
  background: var(--bg-200);
  color: var(--color-text-secondary);
}

.submit-btn {
  background: var(--color-warm);
  color: #fff;
}

.submit-btn:disabled {
  background: var(--bg-300);
  cursor: not-allowed;
}
</style>
