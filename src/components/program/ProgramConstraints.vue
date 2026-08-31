<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { EQUIPMENT_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { useNutritionStore } from '@/stores/nutrition'
import type { ProgramStart } from '@/types'
import type { Equipment, Profile, TimeSlot } from '@/types'
import { addDays, fmtDateCn, startOfWeek, todayStr } from '@/utils/date'
import { phaseForFirstCourse, pickWeekTemplate } from '@/utils/programEngine'
import { constraintSummary, constraintWarning } from '@/utils/programSetup'

/**
 * 内联约束向导：训练频率 / 开始日 / 首练课程 / 器械 / 忌口 / 常练时段当场可改，
 * 不再「跳去「我」页改完再回来」——这些约束本来就是方案的输入参数。
 *
 * 改动直接写回 profile（saveProfile），不引入第二套存储；开始日与首练是方案级
 * 参数（不落 profile）：选项与相位反解都按**本地草稿值**即时计算（先改频率、
 * 再选开始日时，首练选项同步跟随），变化即时经 start-change 回传方案页；
 * 底部一行「按此条件 → …」用与引擎相同的 pickWeekTemplate 口径实时预览。
 */

const props = defineProps<{
  /** 草稿已生成后约束又被改动 → 提示重新计算 */
  stale: boolean
  generating: boolean
  /** CTA 文案随草稿状态变化 */
  hasDrafts: boolean
  /** 课程 id → 名称（首练选择的展示用；加载失败时回退 id） */
  courseNames: Record<string, string>
}>()

const emit = defineEmits<{
  generate: []
  'start-change': [v: ProgramStart]
}>()

const n = useNutritionStore()

const draftDays = ref(4)
const draftEquipment = ref<string>('gym')
const draftSlots = ref<string[]>(['evening'])
const draftRestrictions = ref<string[]>([])
const customInput = ref('')
const saving = ref(false)

const startMode = ref<'next' | 'today' | 'tomorrow'>('next')
const firstCourseId = ref<string | null>(null)

watch(
  () => n.profile,
  (p: Profile | null) => {
    if (!p) return
    draftDays.value = p.trainingDaysPerWeek ?? 4
    draftEquipment.value = p.equipment ?? 'gym'
    draftSlots.value = [...(p.preferredTimeSlots ?? ['evening'])]
    draftRestrictions.value = [...(p.dietRestrictions ?? [])]
  },
  { immediate: true },
)

/**
 * 向导只提供 3–6 天：这是「起步建议」而非硬上限（硬上限是
 * ADJUSTMENT_LIMITS.trainingDaysMax）。开方案时给到 7 天会诱导过度承诺，
 * 真需要更高频率可以在方案页手动调参里加。
 */
const DAY_OPTIONS = [3, 4, 5, 6]
const dayOptions = computed(() => {
  const list = DAY_OPTIONS.includes(draftDays.value) ? DAY_OPTIONS : [draftDays.value, ...DAY_OPTIONS]
  return [...list].sort((a, b) => a - b)
})

const EQUIPMENT_OPTIONS = ['gym', 'home', 'mixed']
const SLOT_OPTIONS = ['morning', 'noon', 'evening']
const RESTRICTION_PRESETS = ['乳制品', '麸质', '海鲜', '蛋类', '大豆', '坚果']

const startDate = computed(() =>
  startMode.value === 'today'
    ? todayStr()
    : startMode.value === 'tomorrow'
      ? addDays(todayStr(), 1)
      : startOfWeek(addDays(todayStr(), 7)),
)

/** 本地草稿（频率/器械）对应的周模板——首练选项与相位都按它算，跟手不滞后 */
const draftTpl = computed(() => pickWeekTemplate(draftEquipment.value === 'home' ? 'home' : 'gym', draftDays.value))

const courseOptions = computed(() => {
  const ids = [...new Set(draftTpl.value.days.filter((d): d is string => d != null))]
  return ids.map((id) => ({ id, name: props.courseNames[id] ?? id }))
})

const phase = computed(() =>
  firstCourseId.value ? phaseForFirstCourse(draftTpl.value, firstCourseId.value) : 0,
)

const tomorrow = computed(() => addDays(todayStr(), 1))
const nextMonday = computed(() => startOfWeek(addDays(todayStr(), 7)))
/** 下周一恰好是明天（今天周日）时，两个选项是同一天：隐藏「明天开始」，并入「下周一」 */
const nextIsTomorrow = computed(() => nextMonday.value === tomorrow.value)

const startOptions = computed(() => {
  const opts: { value: 'next' | 'today' | 'tomorrow'; label: string }[] = [
    { value: 'today', label: `今天开始 · ${fmtDateCn(todayStr())}` },
  ]
  if (!nextIsTomorrow.value) {
    opts.push({ value: 'tomorrow', label: `明天开始 · ${fmtDateCn(tomorrow.value)}` })
  }
  opts.push({
    value: 'next',
    label: `下周一 · ${fmtDateCn(nextMonday.value)}${nextIsTomorrow.value ? '（明天）' : ''}`,
  })
  return opts
})

/** 预设之外的自定义忌口（已存进 profile 的关键词） */
const customRestrictions = computed(() =>
  draftRestrictions.value.filter((r) => !RESTRICTION_PRESETS.includes(r)),
)

const previewText = computed(() => {
  let text = constraintSummary(draftDays.value, draftEquipment.value)
  if (startMode.value !== 'next') {
    text += ` · ${startMode.value === 'today' ? '今天' : '明天'}开跑`
  }
  if (firstCourseId.value) {
    const name = courseOptions.value.find((c) => c.id === firstCourseId.value)?.name
    if (name) text += ` · 首练${name}`
  }
  return text
})
const warning = computed(() => constraintWarning(draftDays.value))

/** 模板变了（频率/器械改动）首练课程可能不存在了：清掉回默认顺序 */
watch(courseOptions, (opts) => {
  if (firstCourseId.value && !opts.some((c) => c.id === firstCourseId.value)) {
    firstCourseId.value = null
  }
})

/** 开始参数即时回传方案页（生成与 stale 判定都吃同一份） */
watch(
  [startMode, firstCourseId, draftTpl],
  () => {
    emit('start-change', {
      startMode: startMode.value,
      firstCourseId: firstCourseId.value,
      phase: phase.value,
      startDate: startDate.value,
    })
  },
  { immediate: true },
)

function pickStart(v: 'next' | 'today' | 'tomorrow'): void {
  startMode.value = v
  if (v === 'next') firstCourseId.value = null
}

function toggleSlot(s: string): void {
  draftSlots.value = draftSlots.value.includes(s)
    ? draftSlots.value.filter((x) => x !== s)
    : [...draftSlots.value, s]
}

function toggleRestriction(r: string): void {
  draftRestrictions.value = draftRestrictions.value.includes(r)
    ? draftRestrictions.value.filter((x) => x !== r)
    : [...draftRestrictions.value, r]
}

function addCustom(): void {
  const v = customInput.value.trim()
  if (!v || draftRestrictions.value.includes(v)) return
  draftRestrictions.value.push(v)
  customInput.value = ''
}

/** 保存到 profile 并触发生成（约束是方案的输入参数，改完必须重新计算） */
async function applyAndGenerate(): Promise<void> {
  const p = n.profile
  if (!p || saving.value) return
  saving.value = true
  try {
    await n.saveProfile({
      ...p,
      trainingDaysPerWeek: draftDays.value,
      equipment: draftEquipment.value as Equipment,
      preferredTimeSlots: (draftSlots.value.length ? draftSlots.value : null) as TimeSlot[] | null,
      dietRestrictions: draftRestrictions.value.length ? draftRestrictions.value : null,
    })
    emit('generate')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section v-if="n.profile" class="pod">
    <header class="pod-head">
      <b>定制你的方案</b>
      <span class="t-3 cond-note">保存到「我 › 个人约束」</span>
    </header>

    <div class="group">
      <p class="glabel">每周能练几天</p>
      <div class="chips">
        <button
          v-for="d in dayOptions"
          :key="d"
          class="chip"
          :class="{ on: draftDays === d }"
          :aria-pressed="draftDays === d"
          @click="draftDays = d"
        >
          {{ d === 0 ? '不训练' : `${d} 天` }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">什么时候开始</p>
      <div class="chips">
        <button
          v-for="o in startOptions"
          :key="o.value"
          class="chip"
          :class="{ on: startMode === o.value }"
          :aria-pressed="startMode === o.value"
          @click="pickStart(o.value)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <!-- 提前开跑时的相位平移：接续当前训练节奏，避免连续同部位高负荷 -->
    <div v-if="(startMode !== 'next' || nextIsTomorrow) && courseOptions.length" class="group">
      <p class="glabel">首个训练日练（今天已经练过？接着练下个部位，别连着来）</p>
      <div class="chips">
        <button
          class="chip"
          :class="{ on: firstCourseId === null }"
          :aria-pressed="firstCourseId === null"
          @click="firstCourseId = null"
        >
          按模板顺序
        </button>
        <button
          v-for="c in courseOptions"
          :key="c.id"
          class="chip"
          :class="{ on: firstCourseId === c.id }"
          :aria-pressed="firstCourseId === c.id"
          @click="firstCourseId = c.id"
        >
          {{ c.name }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">可用器械</p>
      <div class="chips">
        <button
          v-for="e in EQUIPMENT_OPTIONS"
          :key="e"
          class="chip"
          :class="{ on: draftEquipment === e }"
          :aria-pressed="draftEquipment === e"
          @click="draftEquipment = e"
        >
          {{ EQUIPMENT_LABELS[e] ?? e }}
        </button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">忌口（点选排除，引擎会自动换掉含它们的食谱）</p>
      <div class="chips">
        <button
          v-for="r in RESTRICTION_PRESETS"
          :key="r"
          class="chip"
          :class="{ on: draftRestrictions.includes(r) }"
          :aria-pressed="draftRestrictions.includes(r)"
          @click="toggleRestriction(r)"
        >
          {{ r }}
        </button>
        <button
          v-for="r in customRestrictions"
          :key="r"
          class="chip on"
          :aria-pressed="true"
          :aria-label="`移除忌口 ${r}`"
          @click="toggleRestriction(r)"
        >
          {{ r }} ×
        </button>
      </div>
      <div class="custom-add">
        <input v-model="customInput" class="cinput" placeholder="其他忌口关键词" @keyup.enter="addCustom">
        <button class="link" type="button" @click="addCustom">添加</button>
      </div>
    </div>

    <div class="group">
      <p class="glabel">常练时段</p>
      <div class="chips">
        <button
          v-for="s in SLOT_OPTIONS"
          :key="s"
          class="chip"
          :class="{ on: draftSlots.includes(s) }"
          :aria-pressed="draftSlots.includes(s)"
          @click="toggleSlot(s)"
        >
          {{ TIME_SLOT_LABELS[s] ?? s }}
        </button>
      </div>
    </div>

    <div class="preview num">
      <span class="pv-label">按此条件</span>
      <span class="pv-value">{{ previewText }}</span>
    </div>

    <p v-if="warning" class="warn-note">{{ warning }}</p>
    <p v-if="stale && hasDrafts" class="stale-note">约束已变化 · 下方方案是旧条件算的，重新计算后生效</p>

    <button class="primary" :disabled="generating || saving" @click="applyAndGenerate">
      {{ generating || saving ? '正在计算…' : hasDrafts ? '按新条件重新计算' : '计算三套方案' }}
    </button>
  </section>
</template>

<style scoped>
.pod {
  padding: 15px 16px;
  border-radius: var(--radius-l);
  background: var(--surface);
}

.pod-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.pod-head b {
  font-size: var(--fs-headline);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.cond-note {
  font-size: var(--fs-micro);
}

.group + .group {
  margin-top: 13px;
}

.glabel {
  margin-bottom: 7px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chip {
  padding: 7px 13px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}

.custom-add {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.cinput {
  flex: 1;
  padding: 8px 11px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-1);
}

.link {
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

/* 即时结果预览：方案输入参数的直接反馈 */
.preview {
  margin-top: 14px;
  padding: 11px 13px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pv-label {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

.pv-value {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

.warn-note {
  margin-top: 9px;
  font-size: var(--fs-caption);
  color: var(--warn);
  line-height: 1.5;
}

.stale-note {
  margin-top: 9px;
  font-size: var(--fs-caption);
  color: var(--warn);
  line-height: 1.5;
}

.primary {
  width: 100%;
  margin-top: 13px;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.primary:disabled {
  opacity: 0.45;
}
</style>
