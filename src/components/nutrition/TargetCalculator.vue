<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ActionSheet from '@/components/common/ActionSheet.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { ACTIVITY_LEVEL_LABELS, GOAL_LABELS, TARGET_FIELD_META } from '@/config/domain'
import { useNutritionStore } from '@/stores/nutrition'
import { useToast } from '@/composables/useToast'
import { ageFromBirthday } from '@/utils/date'
import { calcTargets } from '@/utils/nutritionCalc'
import type { ActivityLevel, Goal, Sex } from '@/types'

/** 方案计算器：身体参数 → BMR/TDEE → 各营养素与热量推荐；采用前二次确认。
 *  参数改动静默落库（calc_params 快照），再次进入原样恢复；未保存过时回落到资料推导。 */
const n = useNutritionStore()
const { toast } = useToast()

/* ---- 参数（挂载时恢复上次快照，其次用资料预填） ---- */
const sex = ref<Sex>('male')
const age = ref(30)
const heightCm = ref(175)
const weightKg = ref(70)
const activityLevel = ref<ActivityLevel>('light')
const goal = ref<Goal>('cut')

/** 水合完成前不触发自动保存，避免默认值覆盖快照 */
let ready = false

function snapshotParams() {
  return {
    sex: sex.value,
    age: age.value,
    heightCm: heightCm.value,
    weightKg: weightKg.value,
    activityLevel: activityLevel.value,
    goal: goal.value,
    savedAt: null,
  }
}

onMounted(async () => {
  if (!n.profile) await n.loadProfile()
  await n.loadCalcState()
  const s = n.calcState
  if (s && s.savedAt) {
    if (s.sex) sex.value = s.sex
    if (s.age != null) age.value = s.age
    if (s.heightCm != null) heightCm.value = s.heightCm
    if (s.weightKg != null) weightKg.value = s.weightKg
    activityLevel.value = s.activityLevel
    goal.value = s.goal
  } else {
    const p = n.profile
    if (!p) {
      ready = true
      return
    }
    if (p.sex) sex.value = p.sex
    const a = ageFromBirthday(p.birthday)
    if (a != null) age.value = a
    if (p.heightCm != null) heightCm.value = p.heightCm
    if (p.weightKg != null) weightKg.value = p.weightKg
    activityLevel.value = p.activityLevel
    goal.value = p.goal
  }
  ready = true
})

/* ---- 自动保存：防抖 600ms 静默落库；离页前有未保存改动则立即补存 ---- */
let saveTimer: ReturnType<typeof setTimeout> | undefined

watch([sex, age, heightCm, weightKg, activityLevel, goal], () => {
  if (!ready) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void n.saveCalcState(snapshotParams())
  }, 600)
})

onBeforeUnmount(() => {
  if (!saveTimer || !ready) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  void n.saveCalcState(snapshotParams())
})

const SEX_OPTIONS = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
]

const GOAL_OPTIONS = [
  { value: 'cut', label: GOAL_LABELS.cut },
  { value: 'keep', label: GOAL_LABELS.keep },
  { value: 'bulk', label: GOAL_LABELS.bulk },
]

const ACTIVITY_OPTIONS = (Object.keys(ACTIVITY_LEVEL_LABELS) as ActivityLevel[]).map((k) => ({
  value: k,
  // 分段控件空间有限，取标签前两字
  label: ACTIVITY_LEVEL_LABELS[k].slice(0, 2),
}))

/* ---- 实时计算与差异 ---- */
const result = computed(() =>
  calcTargets({
    sex: sex.value,
    age: age.value,
    heightCm: heightCm.value,
    weightKg: weightKg.value,
    activityLevel: activityLevel.value,
    goal: goal.value,
  }),
)

const cells = computed(() =>
  TARGET_FIELD_META.map((m) => {
    const from = Math.round(n.profile?.targets[m.key] ?? result.value.targets[m.key])
    const to = Math.round(result.value.targets[m.key])
    return { ...m, from, to, changed: to !== from }
  }),
)

const diffs = computed(() => cells.value.filter((c) => c.changed))

const diffsText = computed(() =>
  diffs.value.map((c) => `${c.label} ${c.from}→${c.to}`).join(' · '),
)

const DELTA_TEXT: Record<Goal, string> = {
  cut: '，已扣减约 400 大卡缺口',
  keep: '',
  bulk: '，已加回约 300 大卡盈余',
}

function setSex(v: string): void {
  sex.value = v as Sex
}
function setGoal(v: string): void {
  goal.value = v as Goal
}
function setActivity(v: string): void {
  activityLevel.value = v as ActivityLevel
}

/* ---- 采用确认 ---- */
const confirmOpen = ref(false)

async function adopt(): Promise<void> {
  await n.adoptPlan(
    {
      sex: sex.value,
      heightCm: heightCm.value,
      weightKg: weightKg.value,
      activityLevel: activityLevel.value,
      goal: goal.value,
    },
    result.value.targets,
  )
  toast(`已采用${GOAL_LABELS[goal.value]}方案`)
}

function onConfirm(value: string): void {
  if (value === 'adopt') void adopt()
}
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>方案计算器</h2>
      <p class="t-3">由身体参数推算营养与热量目标</p>
    </header>

    <!-- 参数 -->
    <div class="form">
      <div class="frow">
        <span class="flabel">性别</span>
        <SegmentedControl
          class="fctrl"
          :model-value="sex"
          :options="SEX_OPTIONS"
          @update:model-value="setSex"
        />
      </div>
      <NumberStepper v-model="age" label="年龄" unit="岁" :step="1" :min="10" :max="100" />
      <NumberStepper v-model="heightCm" label="身高" unit="cm" :step="1" :min="100" :max="250" />
      <NumberStepper v-model="weightKg" label="体重" unit="kg" :step="0.5" :min="30" :max="200" />
      <div class="frow">
        <span class="flabel">活动水平</span>
        <SegmentedControl
          class="fctrl wide"
          :model-value="activityLevel"
          :options="ACTIVITY_OPTIONS"
          @update:model-value="setActivity"
        />
      </div>
      <div class="frow">
        <span class="flabel">我的目标</span>
        <SegmentedControl
          class="fctrl wide"
          :model-value="goal"
          :options="GOAL_OPTIONS"
          @update:model-value="setGoal"
        />
      </div>
    </div>

    <!-- 推荐结果 -->
    <div class="plan">
      <p class="cap">{{ GOAL_LABELS[goal] }} · 推荐每日目标</p>
      <div class="kcal row">
        <b class="num">{{ result.targets.kcal }}</b>
        <span class="unit">大卡/天</span>
      </div>
      <ul class="cells">
        <li v-for="c in cells.slice(1)" :key="c.key">
          <em>{{ c.label }}</em>
          <span class="num cv"><b>{{ c.to }}</b><i>{{ c.unit }}</i></span>
        </li>
      </ul>
      <p class="formula num">
        基础代谢 {{ result.bmr }} · 总消耗 {{ result.tdee }} 大卡{{ DELTA_TEXT[goal] }}
      </p>
      <p v-if="diffs.length" class="diffs num">较当前：{{ diffsText }}</p>
      <p v-else class="diffs same">与当前目标一致</p>
    </div>

    <button class="adopt" @click="confirmOpen = true">采用该方案</button>
    <p class="note t-3">采用后同步更新身体资料与每日目标，可随时手动微调。</p>

    <ActionSheet
      :open="confirmOpen"
      title="采用推荐方案？将覆盖当前每日目标"
      :actions="[{ label: '采用并保存', value: 'adopt' }]"
      @select="onConfirm"
      @close="confirmOpen = false"
    />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.head p {
  font-size: var(--fs-caption);
  margin-top: 1px;
}

.form {
  margin-top: 10px;
}

.frow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
}

.form > * + * {
  border-top: 0.5px solid var(--line);
}

.flabel {
  font-size: var(--fs-subhead);
  font-weight: 500;
  flex: none;
}

.fctrl {
  width: 128px;
  flex: none;
}

.fctrl.wide {
  width: 190px;
}

/* 推荐面板 */
.plan {
  margin-top: 16px;
  padding: 14px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.cap {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.kcal {
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
}

.kcal b {
  font-size: var(--fs-display-s);
  font-weight: 200;
  letter-spacing: -1px;
  color: var(--accent);
  line-height: 1.1;
}

.unit {
  font-size: var(--fs-caption);
  color: var(--text-2);
}

.cells {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px 6px;
}

.cells li {
  min-width: 0;
}

.cells em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
}

.cv {
  display: block;
  font-size: var(--fs-subhead);
}

.cv b {
  font-weight: 700;
}

.cv i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-left: 1px;
}

.formula {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.diffs {
  margin-top: 4px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
  line-height: 1.5;
}

.diffs.same {
  font-weight: 500;
  color: var(--text-3);
}

/* 采用按钮 */
.adopt {
  width: 100%;
  margin-top: 16px;
  padding: 13px 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: 700;
}

.note {
  margin-top: 8px;
  text-align: center;
  font-size: var(--fs-caption);
}
</style>
