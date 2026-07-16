<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCourseStore } from "@/stores/courseStore";
import { useAnime } from "@/composables/useAnime";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  type Course,
  type CourseDifficulty,
} from "@/types/course";

const route = useRoute();
const router = useRouter();
const courseStore = useCourseStore();
const listRef = ref<HTMLElement | null>(null);
const { staggerEnter, reduced } = useAnime(listRef);
let staggerPlayed = false;

const difficultyFilter = computed<CourseDifficulty | null>(
  () => (route.query.difficulty as CourseDifficulty) ?? null,
);

const filtered = computed(() => {
  const all = courseStore.courses;
  if (!difficultyFilter.value) return all;
  return all.filter((c) => c.difficulty === difficultyFilter.value);
});

const grouped = computed(() => {
  const map = new Map<string, Course[]>();
  for (const c of filtered.value) {
    const key = c.category;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  return Array.from(map.entries())
    .map(([key, list]) => ({
      key,
      label: CATEGORY_LABEL[key as keyof typeof CATEGORY_LABEL] ?? key,
      courses: list.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
});

const totalCourses = computed(() => filtered.value.length);
const totalMinutes = computed(() =>
  filtered.value.reduce((s, c) => s + c.estimatedMinutes, 0),
);
const totalCalories = computed(() =>
  filtered.value.reduce((s, c) => s + c.estimatedCalories, 0),
);

const deleteConfirmId = ref<string | null>(null);

function openDetail(course: Course) {
  router.push(`/sports/courses/${course.id}`);
}

function togglePin(course: Course) {
  courseStore.togglePin(course.id);
}

function askDelete(course: Course) {
  deleteConfirmId.value = course.id;
}

function confirmDelete() {
  if (!deleteConfirmId.value) return;
  courseStore.deleteCourse(deleteConfirmId.value);
  deleteConfirmId.value = null;
}

function cancelDelete() {
  deleteConfirmId.value = null;
}

function goBack() {
  router.push("/sports");
}

function clearFilter() {
  router.replace({ path: "/sports/courses" });
}

// 列表数据首次到位后播放 stagger 入场。
// useAnime.enter 仅设置目标值（from 取当前），故先手动预设起点 opacity:0 / translateY:12px。
// 尊重 reduced-motion：降级时跳过预设与播放，元素保持默认可见。
watch(
  grouped,
  () => {
    if (staggerPlayed) return;
    nextTick(() => {
      if (!listRef.value || staggerPlayed) return;
      const items = listRef.value.querySelectorAll(".course-item");
      if (!items.length) return;
      staggerPlayed = true;
      if (reduced.value) return;
      items.forEach((el) => {
        const html = el as HTMLElement;
        html.style.opacity = "0";
        html.style.transform = "translateY(12px)";
      });
      staggerEnter(Array.from(items) as HTMLElement[], "fadeUp", "list");
    });
  },
  { flush: "post" },
);

onMounted(() => {
  courseStore.load();
});
</script>

<template>
  <div class="course-list-page" ref="listRef">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">
        全部课程
        <span v-if="difficultyFilter" class="filter-tag">
          {{ DIFFICULTY_LABEL[difficultyFilter] }}
          <button class="filter-clear" @click="clearFilter">×</button>
        </span>
      </h2>
    </header>

    <!-- 汇总 -->
    <section class="clean-card summary-card">
      <div class="sum-block">
        <div class="sum-num">{{ totalCourses }}</div>
        <div class="sum-label">课程</div>
      </div>
      <div class="sum-div" />
      <div class="sum-block">
        <div class="sum-num">{{ totalMinutes }}</div>
        <div class="sum-label">分钟</div>
      </div>
      <div class="sum-div" />
      <div class="sum-block">
        <div class="sum-num">{{ totalCalories }}</div>
        <div class="sum-label">千卡</div>
      </div>
    </section>

    <!-- 分组列表 -->
    <section v-for="grp in grouped" :key="grp.key" class="group">
      <h3 class="group-title">{{ grp.label }}</h3>
      <div class="group-list">
        <div
          v-for="c in grp.courses"
          :key="c.id"
          class="clean-card course-item"
        >
          <button class="course-main" @click="openDetail(c)">
            <div class="course-name">
              <span v-if="c.pinned" class="pin">★</span>
              {{ c.name }}
            </div>
            <div class="course-meta">
              <span>{{ c.steps.length }}组</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedMinutes }}min</span>
              <span class="dot">·</span>
              <span>{{ c.estimatedCalories }}kcal</span>
              <span class="dot">·</span>
              <span class="diff-tag" :data-diff="c.difficulty">{{ DIFFICULTY_LABEL[c.difficulty] }}</span>
            </div>
            <div v-if="c.description" class="course-desc">{{ c.description }}</div>
          </button>
          <div class="course-ops">
            <button class="op-btn" @click="togglePin(c)" :title="c.pinned ? '取消置顶' : '置顶'">
              <i :class="c.pinned ? 'bi bi-pin-angle-fill' : 'bi bi-pin-angle'" style="font-size:18px"></i>
            </button>
            <button class="op-btn danger" @click="askDelete(c)" title="删除">
              <i class="bi bi-trash3" style="font-size:18px"></i>
            </button>
          </div>
        </div>
      </div>
    </section>

    <div v-if="!grouped.length" class="empty">暂无课程</div>

    <!-- 删除确认 -->
    <div v-if="deleteConfirmId" class="modal-mask" @click.self="cancelDelete">
      <div class="clean-card modal">
        <h3 class="modal-title">删除课程</h3>
        <p class="modal-text">确认删除该课程？此操作不可撤销。</p>
        <div class="modal-actions">
          <button class="modal-btn ghost" @click="cancelDelete">取消</button>
          <button class="modal-btn danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.course-list-page {
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
.back-btn:active { transform: scale(0.92); }
.sub-title {
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.filter-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  background: var(--warm-100);
  color: var(--color-warm);
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-weight: var(--fw-medium);
}
.filter-clear {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: var(--text-sm);
  padding: 0;
  line-height: 1;
}

/* 汇总卡片 */
.summary-card {
  display: flex;
  align-items: center;
  padding: var(--space-4) var(--space-3);
}
.sum-block { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.sum-num { font-size: var(--text-xl); font-weight: var(--fw-bold); color: var(--color-text); }
.sum-label { font-size: var(--text-xs); color: var(--color-text-secondary); }
.sum-div { width: 1px; height: 28px; background: var(--color-divider); }

/* 分组 */
.group { display: flex; flex-direction: column; gap: var(--space-2); }
.group-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: var(--space-2) 0 0;
  padding: 0 var(--space-1);
}
.group-list { display: flex; flex-direction: column; gap: var(--space-2); }

.course-item {
  display: flex;
  align-items: stretch;
  padding: 0;
  overflow: hidden;
}
.course-main {
  flex: 1;
  text-align: left;
  background: transparent;
  border: none;
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  min-width: 0;
}
.course-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.pin { color: var(--color-warm); }
.course-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.course-meta .dot { color: var(--color-text-tertiary); }
.diff-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.diff-tag[data-diff="beginner"] { background: var(--success-50); color: var(--success-600); }
.diff-tag[data-diff="intermediate"] { background: var(--warning-50); color: var(--warning-600); }
.diff-tag[data-diff="advanced"] { background: var(--danger-50); color: var(--danger-600); }
.course-desc {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.course-ops {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-divider);
}
.op-btn {
  flex: 1;
  width: 48px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-fast);
}
.op-btn:active { background: var(--bg-200); }
.op-btn.danger { color: var(--color-danger); }

.empty {
  text-align: center;
  padding: var(--space-10);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

/* 删除确认模态 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: var(--space-5);
}
.modal {
  width: 100%;
  max-width: 320px;
  padding: var(--space-5);
  text-align: center;
}
.modal-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}
.modal-text {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-4);
}
.modal-actions { display: flex; gap: var(--space-2); }
.modal-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.modal-btn.ghost { background: var(--bg-200); color: var(--color-text); }
.modal-btn.danger { background: var(--color-danger); color: #fff; }
</style>
