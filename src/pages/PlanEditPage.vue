<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { usePlanStore } from '@/stores/plan'
import { useToast } from '@/composables/useToast'
import { estimatePlanMinutes, PLAN_TYPE_OPTIONS, planTypeLabel } from '@/utils/plan'
import type { PlanExercise, PlanExerciseKind, WorkoutPlanInput, WorkoutType } from '@/types'

/**
 * 课程编辑：新建（:id='new'）或整体编辑一门课程。
 * 提交为全量 upsert；动作按类型（力量/计时/有氧）切换字段。
 */
const route = useRoute()
const router = useRouter()
const planStore = usePlanStore()
const { toast } = useToast()

const isNew = computed(() => route.params.id === 'new')

const id = ref('')
const name = ref('')
const subtitle = ref('')
const workoutType = ref<WorkoutType>('strength')
const exercises = ref<PlanExercise[]>([])
const ready = ref(false)
const saving = ref(false)

function defaultExercise(kind: PlanExerciseKind): PlanExercise {
  return {
    id: crypto.randomUUID(),
    name: '',
    kind,
    sets: kind === 'cardio' ? 1 : 3,
    reps: kind === 'strength' ? 10 : null,
    weightKg: kind === 'strength' ? 20 : null,
    targetSec: kind === 'timed' ? 45 : null,
    durationMin: kind === 'cardio' ? 15 : null,
    restSec: kind === 'cardio' ? 0 : 60,
    tips: '',
  }
}

onMounted(async () => {
  if (isNew.value) {
    id.value = crypto.randomUUID()
    exercises.value = [defaultExercise('strength')]
  } else {
    await planStore.ensureLoaded()
    const p = planStore.byId(String(route.params.id))
    if (p) {
      id.value = p.id
      name.value = p.name
      subtitle.value = p.subtitle
      workoutType.value = p.workoutType
      exercises.value = JSON.parse(JSON.stringify(p.exercises)) as PlanExercise[]
    } else {
      toast('课程不存在或已删除')
      void router.replace('/sports/plans')
      return
    }
  }
  ready.value = true
})

/** 切换动作类型：清空无关字段并补默认值 */
function switchKind(e: PlanExercise, kind: string): void {
  const k = kind as PlanExerciseKind
  e.kind = k
  if (k === 'strength') {
    e.sets = Math.max(1, e.sets || 3)
    e.reps = e.reps ?? 10
    e.weightKg = e.weightKg ?? 20
    e.targetSec = null
    e.durationMin = null
    e.restSec = e.restSec || 60
  } else if (k === 'timed') {
    e.sets = Math.max(1, e.sets || 3)
    e.targetSec = e.targetSec ?? 45
    e.reps = null
    e.weightKg = null
    e.durationMin = null
    e.restSec = e.restSec || 45
  } else {
    e.sets = 1
    e.durationMin = e.durationMin ?? 15
    e.reps = null
    e.weightKg = null
    e.targetSec = null
    e.restSec = 0
  }
}

function addExercise(): void {
  exercises.value.push(defaultExercise('strength'))
}

function removeExercise(i: number): void {
  exercises.value.splice(i, 1)
}

function moveExercise(i: number, d: -1 | 1): void {
  const j = i + d
  if (j < 0 || j >= exercises.value.length) return
  const arr = exercises.value
  ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
}

const estMin = computed(() =>
  estimatePlanMinutes({
    id: id.value,
    name: name.value,
    subtitle: subtitle.value,
    workoutType: workoutType.value,
    exercises: exercises.value,
  }),
)

async function save(): Promise<void> {
  const finalName = name.value.trim()
  if (!finalName) {
    toast('请填写课程名称')
    return
  }
  const finalExercises = exercises.value
    .map((e) => ({ ...e, name: e.name.trim() }))
    .filter((e) => e.name.length > 0)
  if (finalExercises.length === 0) {
    toast('至少添加一个动作并填写动作名称')
    return
  }
  saving.value = true
  try {
    const input: WorkoutPlanInput = {
      id: id.value,
      name: finalName,
      subtitle: subtitle.value.trim(),
      workoutType: workoutType.value,
      exercises: finalExercises,
    }
    await planStore.upsert(input)
    toast(isNew.value ? '课程已创建' : '课程已更新')
    void router.replace(`/sports/plans/${id.value}`)
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader back :title="isNew ? '新建课程' : '编辑课程'" :subtitle="`约 ${estMin} 分钟 · ${exercises.length} 个动作`" />

    <template v-if="ready">
      <!-- 基本信息 -->
      <section class="card">
        <label class="field">
          <span class="flabel">课程名称</span>
          <input v-model="name" type="text" maxlength="20" placeholder="如：推力日" />
        </label>
        <label class="field">
          <span class="flabel">副标题</span>
          <input v-model="subtitle" type="text" maxlength="30" placeholder="如：胸 · 肩 · 三头" />
        </label>
        <div class="field">
          <span class="flabel">课程类型</span>
          <SegmentedControl
            class="typeseg"
            :options="PLAN_TYPE_OPTIONS.map((t) => ({ value: t, label: planTypeLabel(t) }))"
            :model-value="workoutType"
            @update:model-value="workoutType = $event as WorkoutType"
          />
        </div>
      </section>

      <!-- 动作列表 -->
      <section v-for="(e, i) in exercises" :key="e.id" class="card excard">
        <div class="row between exhead">
          <span class="exidx num">动作 {{ i + 1 }}</span>
          <div class="row ops">
            <button aria-label="上移" :disabled="i === 0" @click="moveExercise(i, -1)">
              <ArrowUp :size="15" />
            </button>
            <button aria-label="下移" :disabled="i === exercises.length - 1" @click="moveExercise(i, 1)">
              <ArrowDown :size="15" />
            </button>
            <button aria-label="删除动作" class="danger" @click="removeExercise(i)">
              <X :size="15" />
            </button>
          </div>
        </div>

        <label class="field">
          <span class="flabel">动作名称</span>
          <input v-model="e.name" type="text" maxlength="20" placeholder="如：杠铃卧推" />
        </label>

        <div class="field">
          <span class="flabel">类型</span>
          <SegmentedControl
            class="typeseg"
            :options="[
              { value: 'strength', label: '力量' },
              { value: 'timed', label: '计时' },
              { value: 'cardio', label: '有氧' },
            ]"
            :model-value="e.kind"
            @update:model-value="switchKind(e, $event)"
          />
        </div>

        <template v-if="e.kind === 'strength'">
          <NumberStepper v-model="e.sets" :step="1" :min="1" :max="20" label="组数" unit="组" />
          <NumberStepper v-model="e.reps!" :step="1" :min="1" :max="100" label="每组次数" unit="次" />
          <NumberStepper v-model="e.weightKg!" :step="2.5" :min="0" :max="500" label="建议重量" unit="kg" />
        </template>
        <template v-else-if="e.kind === 'timed'">
          <NumberStepper v-model="e.sets" :step="1" :min="1" :max="20" label="组数" unit="组" />
          <NumberStepper v-model="e.targetSec!" :step="5" :min="10" :max="3600" label="每组目标" unit="秒" />
        </template>
        <template v-else>
          <NumberStepper v-model="e.durationMin!" :step="5" :min="5" :max="300" label="时长" unit="分钟" />
        </template>
        <NumberStepper v-model="e.restSec" :step="15" :min="0" :max="300" label="组间休息" unit="秒" />

        <label class="field">
          <span class="flabel">动作要点</span>
          <textarea v-model="e.tips" rows="2" maxlength="120" placeholder="发力细节、注意事项（训练中展示）" />
        </label>
      </section>

      <button class="add row center" @click="addExercise">
        <Plus :size="17" /> 添加动作
      </button>

      <button class="save row center" :disabled="saving" @click="void save()">
        {{ saving ? '保存中…' : isNew ? '创建课程' : '保存修改' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.field {
  display: block;
  padding: 9px 0;
}

.field + .field {
  border-top: 0.5px solid var(--line);
}

.flabel {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.field input,
.field textarea {
  width: 100%;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-body);
  color: var(--text-1);
}

.field textarea {
  resize: vertical;
  line-height: 1.6;
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-3);
}

.typeseg {
  max-width: 100%;
}

.excard {
  margin-top: 14px;
}

.exhead {
  margin-bottom: 4px;
}

.exidx {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-3);
}

.ops {
  gap: 4px;
}

.ops button {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.ops button.danger {
  color: var(--danger);
}

.ops button:disabled {
  opacity: 0.3;
}

.add {
  width: 100%;
  margin-top: 14px;
  gap: 6px;
  padding: 14px 0;
  border-radius: var(--radius-l);
  border: 1.5px dashed var(--line-strong);
  color: var(--text-2);
  font-size: var(--fs-callout);
  font-weight: 600;
}

.save {
  width: 100%;
  margin-top: 16px;
  gap: 7px;
  padding: 15px 0;
  border-radius: var(--radius-l);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: 700;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.save:disabled {
  opacity: 0.6;
}
</style>
