<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useCourseStore } from "@/stores/courseStore";
import { useExerciseStore } from "@/stores/exerciseStore";
import { useWorkoutStore } from "@/stores/workoutStore";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  type Course,
  type CourseStep,
  type StepPhase,
} from "@/types/course";
import { MUSCLE_GROUP_LABEL } from "@/types/exercise";
import ShareSheet from "@/components/share/ShareSheet.vue";
import ShareButton from "@/components/share/ShareButton.vue";
import { formatCourseDetail } from "@/data/shareFormatters";
import type { ShareContent } from "@/types/share";

const route = useRoute();
const router = useRouter();
const courseStore = useCourseStore();
const exerciseStore = useExerciseStore();
const workoutStore = useWorkoutStore();

const courseId = computed(() => route.params.id as string);
const course = computed<Course | undefined>(() => courseStore.getById(courseId.value));

const isEditing = ref(false);
const showAddSheet = ref(false);
const pendingDeleteIdx = ref<number | null>(null);
const showShare = ref(false);

const shareContent = computed<ShareContent | null>(() =>
  course.value ? formatCourseDetail(course.value) : null,
);

// 新增步骤的临时表单
const newStepForm = ref({
  exerciseId: "",
  sets: 3,
  reps: 10,
  durationSec: 0,
  restSec: 60,
  phase: "main" as StepPhase,
  note: "",
});
const phaseOptions: { value: StepPhase; label: string }[] = [
  { value: "warmup", label: "热身" },
  { value: "main", label: "正式" },
  { value: "stretch", label: "拉伸" },
];

// 可选动作列表（按部位分组）
const exerciseGroups = computed(() => exerciseStore.byMuscleGroup);

function startWorkout() {
  if (!course.value) return;
  workoutStore.startCourse(course.value);
  router.push("/workout");
}

function goBack() {
  router.push("/sports/courses");
}

function togglePin() {
  if (!course.value) return;
  courseStore.togglePin(course.value.id);
}

function toggleEditing() {
  isEditing.value = !isEditing.value;
}

function moveStep(fromIdx: number, toIdx: number) {
  if (!course.value) return;
  courseStore.reorderSteps(course.value.id, fromIdx, toIdx);
}

function moveUp(idx: number) {
  if (idx <= 0) return;
  moveStep(idx, idx - 1);
}

function moveDown(idx: number) {
  if (!course.value) return;
  if (idx >= course.value.steps.length - 1) return;
  moveStep(idx, idx + 1);
}

function removeStep(idx: number) {
  if (!course.value) return;
  pendingDeleteIdx.value = idx;
}

function confirmRemoveStep() {
  if (pendingDeleteIdx.value == null || !course.value) return;
  const idx = pendingDeleteIdx.value;
  const steps = [...course.value.steps];
  steps.splice(idx, 1);
  courseStore.updateCourse(course.value.id, { steps });
  pendingDeleteIdx.value = null;
}

function cancelRemoveStep() {
  pendingDeleteIdx.value = null;
}

function openAddSheet() {
  newStepForm.value = {
    exerciseId: "",
    sets: 3,
    reps: 10,
    durationSec: 0,
    restSec: 60,
    phase: "main",
    note: "",
  };
  showAddSheet.value = true;
}

function closeAddSheet() {
  showAddSheet.value = false;
}

function addStep() {
  if (!course.value) return;
  if (!newStepForm.value.exerciseId) return;
  const ex = exerciseStore.getById(newStepForm.value.exerciseId);
  if (!ex) return;
  const step: CourseStep = {
    id: `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    exerciseId: ex.id,
    exerciseName: ex.name,
    sets: newStepForm.value.sets,
    reps: newStepForm.value.durationSec > 0 ? undefined : newStepForm.value.reps,
    durationSec: newStepForm.value.durationSec > 0 ? newStepForm.value.durationSec : undefined,
    restSec: newStepForm.value.restSec,
    phase: newStepForm.value.phase,
    note: newStepForm.value.note || undefined,
  };
  const steps = [...course.value.steps, step];
  courseStore.updateCourse(course.value.id, { steps });
  closeAddSheet();
}

function updateStepField(idx: number, patch: Partial<CourseStep>) {
  if (!course.value) return;
  const steps = [...course.value.steps];
  steps[idx] = { ...steps[idx], ...patch };
  courseStore.updateCourse(course.value.id, { steps });
}

onMounted(() => {
  courseStore.load();
  exerciseStore.load();
});
</script>

<template>
  <div v-if="course" class="course-edit-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <h2 class="sub-title">{{ course.name }}</h2>
      <button class="head-action" @click="togglePin" :class="{ active: course.pinned }" :title="course.pinned ? '取消置顶' : '置顶'">
        <svg width="20" height="20" viewBox="0 0 24 24" :fill="course.pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 4l4 4-5 1-3 3 1 6-2-2-3 3-1-1 3-3-2-2 6 1 3-3 1-5z"/>
        </svg>
      </button>
      <ShareButton @click="showShare = true" />
    </header>

    <!-- 概览 -->
    <section class="clean-card overview">
      <div class="ov-row">
        <span class="ov-label">部位</span>
        <span class="ov-value">{{ CATEGORY_LABEL[course.category] }}</span>
      </div>
      <div class="ov-row">
        <span class="ov-label">难度</span>
        <span class="ov-value">{{ DIFFICULTY_LABEL[course.difficulty] }}</span>
      </div>
      <div class="ov-row">
        <span class="ov-label">时长</span>
        <span class="ov-value">{{ course.estimatedMinutes }} 分钟</span>
      </div>
      <div class="ov-row">
        <span class="ov-label">热量</span>
        <span class="ov-value">{{ course.estimatedCalories }} 千卡</span>
      </div>
      <div class="ov-row">
        <span class="ov-label">已练习</span>
        <span class="ov-value">{{ course.practiceCount }} 次</span>
      </div>
      <p v-if="course.description" class="ov-desc">{{ course.description }}</p>

      <div class="ov-actions">
        <button class="primary-btn" @click="startWorkout">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          开始训练
        </button>
        <button class="ghost-btn" @click="toggleEditing">
          {{ isEditing ? '完成' : '编辑/调整' }}
        </button>
      </div>
    </section>

    <!-- 步骤列表 -->
    <section class="block">
      <div class="block-head">
        <h3 class="block-title">训练组（{{ course.steps.length }}）</h3>
        <button v-if="isEditing" class="add-btn" @click="openAddSheet">+ 添加</button>
      </div>

      <div class="steps">
        <div
          v-for="(s, idx) in course.steps"
          :key="s.id"
          class="clean-card step-row"
        >
          <div class="step-idx" :data-phase="s.phase">{{ idx + 1 }}</div>
          <div class="step-main">
            <template v-if="!isEditing">
              <div class="step-name">{{ s.exerciseName }}</div>
              <div class="step-meta">
                <span class="phase-tag" :data-phase="s.phase">
                  {{ phaseOptions.find(p => p.value === s.phase)?.label ?? s.phase }}
                </span>
                <span>{{ s.sets }}组</span>
                <span class="dot">·</span>
                <span v-if="s.reps != null">{{ s.reps }}次</span>
                <span v-else-if="s.durationSec != null">{{ s.durationSec }}秒</span>
                <span class="dot">·</span>
                <span>休息{{ s.restSec }}s</span>
              </div>
              <div v-if="s.note" class="step-note">{{ s.note }}</div>
            </template>
            <template v-else>
              <input
                class="step-input step-name-input"
                :value="s.exerciseName"
                @input="updateStepField(idx, { exerciseName: ($event.target as HTMLInputElement).value })"
              />
              <div class="step-edit-grid">
                <label class="se-field">
                  <span>组数</span>
                  <input type="number" min="1" :value="s.sets" @input="updateStepField(idx, { sets: Number(($event.target as HTMLInputElement).value) || 1 })" />
                </label>
                <label class="se-field">
                  <span>次数</span>
                  <input type="number" min="0" :value="s.reps ?? 0" @input="updateStepField(idx, { reps: Number(($event.target as HTMLInputElement).value) || undefined })" />
                </label>
                <label class="se-field">
                  <span>时长(秒)</span>
                  <input type="number" min="0" :value="s.durationSec ?? 0" @input="updateStepField(idx, { durationSec: Number(($event.target as HTMLInputElement).value) || undefined })" />
                </label>
                <label class="se-field">
                  <span>休息(秒)</span>
                  <input type="number" min="0" :value="s.restSec" @input="updateStepField(idx, { restSec: Number(($event.target as HTMLInputElement).value) || 0 })" />
                </label>
                <label class="se-field">
                  <span>阶段</span>
                  <select :value="s.phase" @change="updateStepField(idx, { phase: ($event.target as HTMLSelectElement).value as StepPhase })">
                    <option v-for="p in phaseOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
                  </select>
                </label>
              </div>
              <input
                class="step-input step-note-input"
                placeholder="备注"
                :value="s.note ?? ''"
                @input="updateStepField(idx, { note: ($event.target as HTMLInputElement).value || undefined })"
              />
            </template>
          </div>
          <div v-if="isEditing" class="step-ops">
            <button class="op-btn" :disabled="idx === 0" @click="moveUp(idx)" title="上移">↑</button>
            <button class="op-btn" :disabled="idx === course.steps.length - 1" @click="moveDown(idx)" title="下移">↓</button>
            <button class="op-btn danger" @click="removeStep(idx)" title="删除">×</button>
          </div>
        </div>
      </div>
      <div v-if="!course.steps.length" class="empty">暂无训练组，点击"添加"开始</div>
    </section>

    <!-- 添加步骤抽屉 -->
    <div v-if="showAddSheet" class="modal-mask" @click.self="closeAddSheet">
      <div class="clean-card sheet">
        <h3 class="sheet-title">添加训练组</h3>
        <div class="sheet-body">
          <label class="se-field">
            <span>动作</span>
            <select v-model="newStepForm.exerciseId">
              <option value="">请选择</option>
              <optgroup v-for="g in exerciseGroups" :key="g.key" :label="g.label">
                <option v-for="ex in g.exercises" :key="ex.id" :value="ex.id">{{ ex.name }}（{{ MUSCLE_GROUP_LABEL[ex.muscleGroup] }}）</option>
              </optgroup>
            </select>
          </label>
          <div class="sheet-grid">
            <label class="se-field">
              <span>组数</span>
              <input type="number" min="1" v-model.number="newStepForm.sets" />
            </label>
            <label class="se-field">
              <span>次数</span>
              <input type="number" min="0" v-model.number="newStepForm.reps" />
            </label>
            <label class="se-field">
              <span>时长(秒)</span>
              <input type="number" min="0" v-model.number="newStepForm.durationSec" />
            </label>
            <label class="se-field">
              <span>休息(秒)</span>
              <input type="number" min="0" v-model.number="newStepForm.restSec" />
            </label>
            <label class="se-field">
              <span>阶段</span>
              <select v-model="newStepForm.phase">
                <option v-for="p in phaseOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
          </div>
          <label class="se-field">
            <span>备注</span>
            <input type="text" v-model="newStepForm.note" placeholder="可选" />
          </label>
        </div>
        <div class="sheet-actions">
          <button class="ghost-btn" @click="closeAddSheet">取消</button>
          <button class="primary-btn" :disabled="!newStepForm.exerciseId" @click="addStep">添加</button>
        </div>
      </div>
    </div>

    <!-- 删除步骤确认 -->
    <div v-if="pendingDeleteIdx != null" class="modal-mask" @click.self="cancelRemoveStep">
      <div class="clean-card modal">
        <h3 class="modal-title">删除训练组</h3>
        <p class="modal-text">确认删除该训练组？</p>
        <div class="modal-actions">
          <button class="ghost-btn modal-btn" @click="cancelRemoveStep">取消</button>
          <button class="danger-btn modal-btn" @click="confirmRemoveStep">删除</button>
        </div>
      </div>
    </div>

    <!-- 分享面板 -->
    <ShareSheet
      v-if="showShare && shareContent"
      :content="shareContent"
      @close="showShare = false"
    />
  </div>

  <div v-else class="not-found">
    <p>课程不存在</p>
    <button class="ghost-btn" @click="goBack">返回</button>
  </div>
</template>

<style scoped>
.course-edit-page {
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
.back-btn, .head-action {
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
.head-action.active { color: var(--color-warm); background: var(--warm-100); }
.sub-title {
  flex: 1;
  font-size: var(--text-xl);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 概览卡片 */
.overview { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.ov-row { display: flex; justify-content: space-between; align-items: center; font-size: var(--text-sm); }
.ov-label { color: var(--color-text-secondary); }
.ov-value { color: var(--color-text); font-weight: var(--fw-medium); }
.ov-desc { font-size: var(--text-sm); color: var(--color-text-secondary); margin: var(--space-2) 0 0; line-height: 1.5; }
.ov-actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
.primary-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.primary-btn:active { opacity: 0.85; }
.primary-btn:disabled { opacity: 0.4; }
.ghost-btn {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.ghost-btn:active { opacity: 0.7; }
.danger-btn {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-danger);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-medium);
  cursor: pointer;
}

/* 区块 */
.block { display: flex; flex-direction: column; gap: var(--space-2); }
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-1);
}
.block-title {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}
.add-btn {
  background: var(--warm-100);
  border: none;
  color: var(--color-warm);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  padding: 6px 12px;
  border-radius: var(--radius-full);
  cursor: pointer;
}

/* 步骤 */
.steps { display: flex; flex-direction: column; gap: var(--space-2); }
.step-row {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  padding: var(--space-3);
}
.step-idx {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-200);
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--fw-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.step-idx[data-phase="warmup"] { background: var(--success-50); color: var(--success-600); }
.step-idx[data-phase="stretch"] { background: var(--accent-500); color: #fff; opacity: 0.85; }
.step-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.step-name {
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
}
.step-meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.step-meta .dot { color: var(--color-text-tertiary); }
.phase-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-200);
  color: var(--color-text-secondary);
}
.phase-tag[data-phase="warmup"] { background: var(--success-50); color: var(--success-600); }
.phase-tag[data-phase="main"] { background: var(--warm-100); color: var(--color-warm); }
.phase-tag[data-phase="stretch"] { background: rgba(172,73,245,0.12); color: var(--accent-600); }
.step-note { font-size: var(--text-xs); color: var(--color-text-tertiary); }

.step-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
}
.step-input:focus { border-color: var(--color-warm); }
.step-name-input { font-weight: var(--fw-semibold); }
.step-note-input { margin-top: 4px; }

.step-edit-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
  margin-top: 6px;
}
.se-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.se-field input, .se-field select {
  padding: 6px 10px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
}
.se-field input:focus, .se-field select:focus { border-color: var(--color-warm); }

.step-ops {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.op-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--bg-200);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-md);
  display: flex;
  align-items: center;
  justify-content: center;
}
.op-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.op-btn.danger { background: var(--danger-50); color: var(--color-danger); }

.empty {
  text-align: center;
  padding: var(--space-8);
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

/* 抽屉/模态 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 200;
  padding: 0;
}
.sheet {
  width: 100%;
  max-width: 520px;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 85vh;
  overflow-y: auto;
}
.sheet-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin: 0;
}
.sheet-body { display: flex; flex-direction: column; gap: var(--space-3); }
.sheet-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}
.sheet-actions { display: flex; gap: var(--space-2); }
.sheet-actions .primary-btn, .sheet-actions .ghost-btn { flex: 1; }

.modal {
  width: 100%;
  max-width: 320px;
  padding: var(--space-5);
  text-align: center;
  align-self: center;
}
.modal-title { font-size: var(--text-md); font-weight: var(--fw-semibold); color: var(--color-text); margin: 0 0 var(--space-2); }
.modal-text { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0 0 var(--space-4); }
.modal-actions { display: flex; gap: var(--space-2); }
.modal-btn { flex: 1; }

.not-found {
  padding: var(--space-10);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: center;
  color: var(--color-text-secondary);
}
</style>
