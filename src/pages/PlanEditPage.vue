<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-vue-next'

import ExercisePickerSheet from '@/components/exercise/ExercisePickerSheet.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { EXERCISE_CATEGORY_LABELS } from '@/config/domain'
import { MUSCLE_LABELS, type MuscleKey } from '@/config/muscles'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { usePlanStore } from '@/stores/plan'
import { useToast } from '@/composables/useToast'
import { estimatePlanMinutes, PLAN_TYPE_OPTIONS, planTypeLabel } from '@/utils/plan'
import type { ExerciseRecord, PlanExercise, PlanExerciseKind, WorkoutPlanInput, WorkoutType } from '@/types'

/**
 * 课程编辑：新建（:id='new'）或整体编辑一门课程。
 * 提交为全量 upsert；动作从动作库选择（exerciseId 是课程与曲线的关联键），
 * 处方（组数/次数/重量/休息）仍由课程条目自己持有。
 */
const route = useRoute()
const router = useRouter()
const planStore = usePlanStore()
const lib = useExerciseLibStore()
const { toast } = useToast()

const isNew = computed(() => route.params.id === 'new')

const id = ref('')
const name = ref('')
const subtitle = ref('')
const workoutType = ref<WorkoutType>('strength')
const exercises = ref<PlanExercise[]>([])
const ready = ref(false)
const saving = ref(false)
const pickerIdx = ref<number | null>(null)

function defaultExercise(kind: PlanExerciseKind): PlanExercise {
  return {
    id: crypto.randomUUID(),
    exerciseId: '',
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
  await lib.ensureLoaded()
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

/** 动作行的展示名（库内名优先，缺失回落条目快照） */
function exName(e: PlanExercise): string {
  return lib.resolveName(e)
}

/** 条目副标题：库内主攻肌群 / 分类（让用户确认选对了动作） */
function exMeta(e: PlanExercise): string {
  const rec = lib.get(e.exerciseId)
  if (!rec) return e.exerciseId ? '动作库条目已删除' : '尚未选择动作'
  const mains = (Object.entries(rec.muscles ?? {}) as [MuscleKey, number][])
    .filter(([, lv]) => lv === 3)
    .map(([m]) => MUSCLE_LABELS[m])
  return `${EXERCISE_CATEGORY_LABELS[rec.category]}${mains.length ? ` · ${mains.join(' · ')}` : ''}`
}

function openPicker(i: number): void {
  pickerIdx.value = i
}

/** 选中库内动作：写 exerciseId + 名称；条目参数仍是初始值时用库内默认处方补足 */
function onPick(rec: ExerciseRecord): void {
  const i = pickerIdx.value
  pickerIdx.value = null
  const e = i == null ? null : exercises.value[i]
  if (!e) return
  e.exerciseId = rec.id
  e.name = rec.name
  if (e.kind !== rec.kind) switchKind(e, rec.kind)
  if (!e.tips) e.tips = rec.tips
  if (e.kind === 'strength') {
    if (e.weightKg == null) e.weightKg = rec.defaultWeightKg ?? e.weightKg
    if (e.reps == null) e.reps = rec.defaultReps ?? e.reps
  }
  if (e.kind === 'timed' && e.targetSec == null) e.targetSec = rec.defaultTargetSec ?? e.targetSec
  if (e.kind === 'cardio' && e.durationMin == null) e.durationMin = rec.defaultDurationMin ?? e.durationMin
}

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
    .map((e) => ({ ...e, name: lib.resolveName(e).trim() }))
    .filter((e) => e.exerciseId || e.name.length > 0)
  if (finalExercises.length === 0) {
    toast('至少添加一个动作')
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
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <template v-if="ready">
      <!-- 基本信息 -->
      <section class="card basics">
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

      <!-- 动作列表：每张卡自带栅格壳，增删与上下移都在壳上做过渡 -->
      <TransitionGroup tag="div" name="ex" class="exlist">
        <div v-for="(e, i) in exercises" :key="e.id" class="exrow">
          <div class="excell">
            <section class="card excard">
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

            <div class="field">
              <span class="flabel">动作</span>
              <button class="expick row" type="button" @click="openPicker(i)">
                <span class="col expickmain">
                  <span class="exname" :class="{ empty: !e.exerciseId }">
                    {{ e.exerciseId ? exName(e) : '点击从动作库选择' }}
                  </span>
                  <span class="exmeta t-3">{{ exMeta(e) }}</span>
                </span>
                <span class="expickop">选择</span>
              </button>
            </div>

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
          </div>
        </div>
      </TransitionGroup>

      <button class="add row center" @click="addExercise">
        <Plus :size="17" /> 添加动作
      </button>

      <button class="save row center" :disabled="saving" @click="void save()">
        {{ saving ? '保存中…' : isNew ? '创建课程' : '保存修改' }}
      </button>

      <ExercisePickerSheet
        :open="pickerIdx !== null"
        :kind="exercises[pickerIdx ?? 0]?.kind ?? 'strength'"
        :current-id="exercises[pickerIdx ?? 0]?.exerciseId ?? ''"
        @pick="onPick"
        @close="pickerIdx = null"
      />
    </template>
    </div>
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

/* 动作选择器：只读展示已选动作（名称/肌群来自动作库），点击开选择弹层 */
.expick {
  width: 100%;
  gap: 10px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.expickmain {
  flex: 1;
  min-width: 0;
  gap: 3px;
}

.exname {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-1);
}

.exname.empty {
  font-weight: 500;
  color: var(--text-3);
}

.exmeta {
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.expickop {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--c-exercise-deep);
}

/* 动作行壳：0fr↔1fr 收高度，卡的间距职责从 .excard 移到这一层 */
.exlist {
  display: contents;
}

.exrow {
  display: grid;
  grid-template-rows: 1fr;
  margin-top: 14px;
}

/* 裸壳：动作卡自带 padding，直接当轨道项 0fr 收不干净，会剩一截卡内边距 */
.excell {
  min-height: 0;
  overflow: hidden;
}

/* 桌面壳层原先靠 .rubber-layer > .card「占半栏」+ min-width:0 摆动作卡；
   卡被 .exrow 包着后这两条都命中不到，这里补齐（带 .page 前缀压过壳层那串同特指度规则） */
.desk-main .page > .rubber-layer > .exlist > .exrow {
  min-width: 0;
  grid-column: span 1;
}

.desk-main .exrow {
  margin-top: 0;
}

.ex-enter-active {
  transition:
    grid-template-rows var(--dur-base) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.ex-enter-from {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(6px);
}

.ex-leave-active {
  transition:
    grid-template-rows var(--dur-base) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}

.ex-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}

.ex-move {
  transition: transform var(--dur-base) var(--ease-standard);
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

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   壳层缺省已经把 .page 铺成两栏、.card 占半栏 —— 那正是动作卡想要的排法，
   所以这里只修两处「半栏不对」的地方，不再自铺画布。
   ============================================================ */

/* 基本信息只有名称/副标题/类型三格，半栏放不满、右半屏还会空着；
   拉通一行后三格横排 —— 表单的「表头」在桌面上就该是一条，而不是一列拉到底。 */
.desk-main .rubber-layer > section.card.basics {
  /* 选择器带上 section/元素名，才压得过壳层给 .rubber-layer > .card 定的「占半栏」 */
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr 1fr 1.5fr;
  gap: 0 var(--desk-gap);
  align-items: start;
}

/* 横排之后原来那条「字段之间的上分隔线」方向就错了，改用栅格间距分隔 */
.desk-main .rubber-layer > section.card.basics .field + .field {
  border-top: none;
}

/* 类型分段控件在横排里吃满自己那一格：否则右边会留出一段无意义的空白 */
.desk-main .rubber-layer > section.card.basics .typeseg {
  width: 100%;
}

/* 动作卡沿用壳层缺省的「.card 占半栏」：每张卡是一段完整表单（约 500px 高，
   字段里是「标签 + 步进器」一路排开），479px 一行放得下，两两并排刚好。
   这里刻意不显式声明它的栅格位，免得和壳层的规则互相覆盖。 */

/* 「添加动作 / 保存修改」两枚收尾按钮并排放到底部：
   各占半栏比两条 970px 长的通栏按钮更像一次表单提交。 */
.desk-main .rubber-layer > button.add {
  grid-column: 1;
}

.desk-main .rubber-layer > button.save {
  grid-column: 2;
}
</style>
