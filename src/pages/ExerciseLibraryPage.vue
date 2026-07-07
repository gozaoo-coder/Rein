<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useExerciseStore } from "@/stores/exerciseStore";
import {
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
  MUSCLE_GROUP_LABEL,
  type ExerciseCategory,
  type MuscleGroup,
} from "@/types/exercise";

const router = useRouter();
const exerciseStore = useExerciseStore();

const search = ref("");
const filterCategory = ref<ExerciseCategory | "all">("all");
const filterMuscle = ref<MuscleGroup | "all">("all");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return exerciseStore.exercises.filter((e) => {
    if (filterCategory.value !== "all" && e.category !== filterCategory.value) return false;
    if (filterMuscle.value !== "all" && e.muscleGroup !== filterMuscle.value) return false;
    if (q && !e.name.toLowerCase().includes(q) && !(e.equipment ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
});

const grouped = computed(() => {
  const map = new Map<MuscleGroup, typeof filtered.value>();
  for (const e of filtered.value) {
    if (!map.has(e.muscleGroup)) map.set(e.muscleGroup, []);
    map.get(e.muscleGroup)!.push(e);
  }
  return Array.from(map.entries())
    .map(([key, list]) => ({
      key,
      label: MUSCLE_GROUP_LABEL[key],
      exercises: list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
});

const muscleOptions: { value: MuscleGroup | "all"; label: string }[] = [
  { value: "all", label: "全部部位" },
  ...(Object.entries(MUSCLE_GROUP_LABEL) as [MuscleGroup, string][]).map(([value, label]) => ({ value, label })),
];
const categoryOptions: { value: ExerciseCategory | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  ...(Object.entries(EXERCISE_CATEGORY_LABEL) as [ExerciseCategory, string][]).map(([value, label]) => ({ value, label })),
];

function goBack() {
  router.push("/sports");
}
function openNew() {
  router.push("/sports/exercises/new");
}
function openEdit(id: string) {
  router.push(`/sports/exercises/${id}`);
}

onMounted(() => {
  exerciseStore.load();
});
</script>

<template>
  <div class="ex-lib-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h2 class="sub-title">动作库</h2>
      <button class="add-btn" @click="openNew">+ 新增</button>
    </header>

    <!-- 搜索与筛选 -->
    <section class="clean-card filters">
      <div class="search-row">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input v-model="search" type="text" placeholder="搜索动作名/器械" />
      </div>
      <div class="filter-row">
        <select v-model="filterCategory" class="filter-select">
          <option v-for="o in categoryOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select v-model="filterMuscle" class="filter-select">
          <option v-for="o in muscleOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
    </section>

    <!-- 提示：完整预设动作库待办 -->
    <div class="todo-banner">
      预设动作库（徒手/器械）数据扩展中。当前为支撑三分化课程的最小集，支持自定义新增。
    </div>

    <!-- 分组列表 -->
    <section v-for="g in grouped" :key="g.key" class="group">
      <h3 class="group-title">
        {{ g.label }}
        <span class="group-count">{{ g.exercises.length }}</span>
      </h3>
      <div class="ex-list">
        <button
          v-for="ex in g.exercises"
          :key="ex.id"
          class="clean-card clean-card--interactive ex-row"
          @click="openEdit(ex.id)"
        >
          <div class="ex-icon-circle" :data-cat="ex.category">
            <svg v-if="ex.category === 'equipment'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6.5 6.5h11v11h-11z" />
              <path d="M3 9.5v5M21 9.5v5" />
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="5" r="2" />
              <path d="M12 7v5" />
              <path d="M8 20l4-8 4 8" />
            </svg>
          </div>
          <div class="ex-info">
            <div class="ex-name">
              {{ ex.name }}
              <span v-if="ex.custom" class="custom-tag">自定义</span>
            </div>
            <div class="ex-meta">
              <span>{{ EXERCISE_CATEGORY_LABEL[ex.category] }}</span>
              <span class="dot">·</span>
              <span v-if="ex.equipment">{{ ex.equipment }}</span>
              <span v-if="ex.equipment" class="dot">·</span>
              <span class="diff" :data-diff="ex.difficulty">{{ EXERCISE_DIFFICULTY_LABEL[ex.difficulty] }}</span>
            </div>
          </div>
          <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </section>

    <div v-if="!grouped.length" class="empty">未找到匹配的动作</div>
  </div>
</template>

<style scoped>
.ex-lib-page {
  padding: var(--space-2) 0 var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sub-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
}
.back-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sub-title {
  flex: 1;
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.add-btn {
  background: var(--color-warm);
  color: #fff;
  border: none;
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  padding: 6px 14px;
  border-radius: var(--radius-full);
  cursor: pointer;
}

/* 筛选 */
.filters { padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  background: var(--bg-200);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
}
.search-row input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.filter-row { display: flex; gap: var(--space-2); }
.filter-select {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  background: var(--bg-50);
  font-size: var(--text-sm);
  color: var(--color-text);
  outline: none;
}

.todo-banner {
  padding: var(--space-3) var(--space-4);
  background: var(--warm-100);
  color: var(--color-warm);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  line-height: 1.5;
}

/* 分组 */
.group { display: flex; flex-direction: column; gap: var(--space-2); }
.group-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: var(--space-2) 0 0;
  padding: 0 var(--space-1);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.group-count {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  background: var(--bg-200);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-regular);
}

.ex-list { display: flex; flex-direction: column; gap: var(--space-2); }
.ex-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: none;
  text-align: left;
  width: 100%;
}
.ex-icon-circle {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
}
.ex-icon-circle[data-cat="equipment"] { background: var(--icon-orange); }
.ex-icon-circle[data-cat="bodyweight"] { background: var(--icon-blue); }
.ex-info { flex: 1; min-width: 0; }
.ex-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.custom-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--warm-100);
  color: var(--color-warm);
  font-weight: var(--fw-medium);
}
.ex-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.ex-meta .dot { color: var(--color-text-tertiary); }
.diff {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.diff[data-diff="beginner"] { background: var(--success-50); color: var(--success-600); }
.diff[data-diff="intermediate"] { background: var(--warning-50); color: var(--warning-600); }
.diff[data-diff="advanced"] { background: var(--danger-50); color: var(--danger-600); }

.empty {
  text-align: center;
  padding: var(--space-10);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}
</style>
