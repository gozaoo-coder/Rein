<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useExerciseStore } from "@/stores/exerciseStore";
import {
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
  MUSCLE_GROUP_LABEL,
  type ExerciseCategory,
  type ExerciseDifficulty,
  type MuscleGroup,
} from "@/types/exercise";
import ShareSheet from "@/components/share/ShareSheet.vue";
import ShareButton from "@/components/share/ShareButton.vue";
import { formatExerciseDetail } from "@/data/shareFormatters";
import type { ShareContent } from "@/types/share";

const route = useRoute();
const router = useRouter();
const store = useExerciseStore();

const id = computed(() => (route.params.id as string) ?? "");
const isNew = computed(() => !id.value || id.value === "new");
const existing = computed(() => (id.value && !isNew.value ? store.getById(id.value) : undefined));

const form = ref({
  name: "",
  category: "equipment" as ExerciseCategory,
  muscleGroup: "chest" as MuscleGroup,
  difficulty: "beginner" as ExerciseDifficulty,
  equipment: "",
  description: "",
});

const pendingDelete = ref(false);
const showShare = ref(false);

const shareContent = computed<ShareContent | null>(() =>
  existing.value ? formatExerciseDetail(existing.value) : null,
);

const categoryOptions = Object.entries(EXERCISE_CATEGORY_LABEL) as [ExerciseCategory, string][];
const muscleOptions = Object.entries(MUSCLE_GROUP_LABEL) as [MuscleGroup, string][];
const difficultyOptions = Object.entries(EXERCISE_DIFFICULTY_LABEL) as [ExerciseDifficulty, string][];

const canSave = computed(() => form.value.name.trim().length > 0);

function goBack() {
  router.push("/sports/exercises");
}

function loadForm() {
  if (existing.value) {
    form.value = {
      name: existing.value.name,
      category: existing.value.category,
      muscleGroup: existing.value.muscleGroup,
      difficulty: existing.value.difficulty,
      equipment: existing.value.equipment ?? "",
      description: existing.value.description ?? "",
    };
  }
}

function save() {
  if (!canSave.value) return;
  const payload = {
    name: form.value.name.trim(),
    category: form.value.category,
    muscleGroup: form.value.muscleGroup,
    difficulty: form.value.difficulty,
    equipment: form.value.equipment.trim() || undefined,
    description: form.value.description.trim() || undefined,
  };
  if (existing.value) {
    store.updateExercise(existing.value.id, payload);
  } else {
    store.createExercise({ ...payload, custom: true });
  }
  goBack();
}

function askDelete() {
  pendingDelete.value = true;
}
function confirmDelete() {
  if (existing.value) {
    store.deleteExercise(existing.value.id);
  }
  pendingDelete.value = false;
  goBack();
}
function cancelDelete() {
  pendingDelete.value = false;
}

onMounted(() => {
  store.load().then(loadForm);
});
</script>

<template>
  <div class="ex-edit-page">
    <header class="sub-header">
      <button class="back-btn" @click="goBack" aria-label="返回">
        <i class="bi bi-chevron-left" style="font-size:22px"></i>
      </button>
      <h2 class="sub-title">{{ isNew ? '新增动作' : '编辑动作' }}</h2>
      <ShareButton v-if="existing" @click="showShare = true" />
    </header>

    <section class="clean-card form-card">
      <label class="fe-field">
        <span class="fe-label">动作名 *</span>
        <input v-model="form.name" type="text" placeholder="如：哑铃卧推" />
      </label>

      <div class="fe-grid">
        <label class="fe-field">
          <span class="fe-label">类别</span>
          <select v-model="form.category">
            <option v-for="[v, l] in categoryOptions" :key="v" :value="v">{{ l }}</option>
          </select>
        </label>
        <label class="fe-field">
          <span class="fe-label">部位</span>
          <select v-model="form.muscleGroup">
            <option v-for="[v, l] in muscleOptions" :key="v" :value="v">{{ l }}</option>
          </select>
        </label>
        <label class="fe-field">
          <span class="fe-label">难度</span>
          <select v-model="form.difficulty">
            <option v-for="[v, l] in difficultyOptions" :key="v" :value="v">{{ l }}</option>
          </select>
        </label>
        <label class="fe-field">
          <span class="fe-label">器械</span>
          <input v-model="form.equipment" type="text" placeholder="如：哑铃（可选）" />
        </label>
      </div>

      <label class="fe-field">
        <span class="fe-label">动作要领</span>
        <textarea v-model="form.description" rows="4" placeholder="动作描述、要点、注意事项…" />
      </label>

      <div class="fe-actions">
        <button v-if="existing && existing.custom" class="danger-btn" @click="askDelete">删除</button>
        <button class="ghost-btn" @click="goBack">取消</button>
        <button class="primary-btn" :disabled="!canSave" @click="save">保存</button>
      </div>

      <p v-if="existing && !existing.custom" class="preset-hint">
        这是预设动作，部分字段可编辑但不可删除。
      </p>
    </section>

    <div v-if="pendingDelete" class="modal-mask" @click.self="cancelDelete">
      <div class="clean-card modal">
        <h3 class="modal-title">删除动作</h3>
        <p class="modal-text">确认删除该自定义动作？此操作不可撤销。</p>
        <div class="modal-actions">
          <button class="ghost-btn modal-btn" @click="cancelDelete">取消</button>
          <button class="danger-btn modal-btn" @click="confirmDelete">删除</button>
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
</template>

<style scoped>
.ex-edit-page {
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

.form-card { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.fe-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.fe-label { font-weight: var(--fw-medium); }
.fe-field input, .fe-field select, .fe-field textarea {
  padding: 8px 12px;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  font-size: var(--text-md);
  background: var(--bg-50);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  resize: vertical;
}
.fe-field input:focus, .fe-field select:focus, .fe-field textarea:focus {
  border-color: var(--color-warm);
}
.fe-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}

.fe-actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
.primary-btn {
  flex: 1;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: none;
  background: var(--color-warm);
  color: #fff;
  font-size: var(--text-md);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.primary-btn:disabled { opacity: 0.4; }
.primary-btn:active { opacity: 0.85; }
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

.preset-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin: var(--space-1) 0 0;
}

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
.modal-title { font-size: var(--text-md); font-weight: var(--fw-semibold); color: var(--color-text); margin: 0 0 var(--space-2); }
.modal-text { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0 0 var(--space-4); }
.modal-actions { display: flex; gap: var(--space-2); }
.modal-btn { flex: 1; }
</style>
