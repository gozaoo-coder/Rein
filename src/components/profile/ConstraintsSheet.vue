<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { DIET_RESTRICTION_PRESETS, EQUIPMENT_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { useNutritionStore } from '@/stores/nutrition'
import type { Equipment, Experience, Sex, TimeSlot } from '@/types'
import { bmiBand, bmiOf } from '@/utils/health'

/**
 * 「我 › 个人约束」编辑抽屉 —— 健康方案的生成参数都在这一屏。
 *
 * 版式走 iOS Health 的分组行卡：灰底分组卡 + 发丝线分行 + 行内右置控件，
 * 替掉旧版「标签漂在半空 + 控件挤在一列」的平面表单。分两组：
 *   身体数据 —— 性别 / 生日 / 身高 / 体重 / 目标体重，右上是实时 BMI 读数；
 *   训练约束 —— 频率 / 时段 / 器械 / 经验 / 忌口，右上是「按当前条件的摘要」。
 * 控件选型只认两条：能一眼看到全部选项的用 chips（多选/三选一），二选一用分段；
 * 原生 date 输入（yyyy/mm/日 占位 + 键盘难用）换成 年/月/日 三个下拉。
 *
 * 草稿就地改、保存才落库（saveProfile），与旧版同一条链路。
 */

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: [] }>()

const n = useNutritionStore()
const saving = ref(false)

/* ---------- 草稿：打开时从 profile 同步 ---------- */

const draftSex = ref<string>('male')
const draftHeight = ref(170)
const draftWeight = ref(65)
const draftTarget = ref(65)
const draftDays = ref(3)
const draftSlots = ref<TimeSlot[]>([])
const draftEquipment = ref<string>('gym')
const draftExperience = ref<string>('beginner')
const draftRestrictions = ref<string[]>([])
const newRestriction = ref('')

const SEX_OPTIONS: { value: string; label: string }[] = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
]
const EQUIP_OPTIONS = Object.entries(EQUIPMENT_LABELS).map(([value, label]) => ({ value, label }))
const EXP_OPTIONS = (['beginner', 'intermediate', 'advanced'] as const).map((value) => ({
  value,
  label: { beginner: '新手', intermediate: '有基础', advanced: '进阶' }[value],
}))
const SLOT_OPTIONS: TimeSlot[] = ['morning', 'noon', 'evening']

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const p = n.profile
    draftSex.value = p?.sex ?? 'male'
    draftHeight.value = Math.round(p?.heightCm ?? 170)
    draftWeight.value = Math.round((p?.weightKg ?? 65) * 10) / 10
    // 目标体重没有历史值时拿当前体重当起点（语义上就是「维持」），不让数值格空着
    draftTarget.value = Math.round((p?.targetWeightKg ?? p?.weightKg ?? 65) * 10) / 10
    draftDays.value = p?.trainingDaysPerWeek ?? 3
    draftSlots.value = [...(p?.preferredTimeSlots ?? [])]
    draftEquipment.value = p?.equipment ?? 'gym'
    draftExperience.value = p?.experience ?? 'beginner'
    draftRestrictions.value = [...(p?.dietRestrictions ?? [])]
    newRestriction.value = ''
    setBirthday(p?.birthday ?? null)
  },
  { immediate: true },
)

/* ---------- 生日：年 / 月 / 日 三个下拉 ---------- */

const THIS_YEAR = new Date().getFullYear()
/** 生日从近往远排：活着的人绝大多数点前几屏 */
const YEAR_OPTIONS = Array.from({ length: THIS_YEAR - 1930 + 1 }, (_, i) => THIS_YEAR - i)
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1)

const draftYear = ref<number | null>(null)
const draftMonth = ref<number | null>(null)
const draftDay = ref<number | null>(null)

function setBirthday(iso: string | null): void {
  const [y, m, d] = (iso ?? '').split('-').map((v) => Number(v))
  draftYear.value = Number.isFinite(y) && y > 0 ? y : null
  draftMonth.value = Number.isFinite(m) && m > 0 ? m : null
  draftDay.value = Number.isFinite(d) && d > 0 ? d : null
}

/** 选中月的天数；年或月未选时按 31 供选 */
const dayCount = computed(() =>
  draftYear.value && draftMonth.value ? new Date(draftYear.value, draftMonth.value, 0).getDate() : 31,
)
const DAY_OPTIONS = computed(() => Array.from({ length: dayCount.value }, (_, i) => i + 1))

/** 换月/换年后日子越界的（1月31 → 2月）收回月末 */
watch([draftYear, draftMonth], () => {
  if (draftDay.value && draftDay.value > dayCount.value) draftDay.value = dayCount.value
})

/* select 走 :value + @change 而不是 v-model.number：占位 option 的 null 值
   经过 number 修饰符的 looseToNumber 属于边角行为，不值得赌 */
function pickYear(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  draftYear.value = v === '' ? null : Number(v)
}

function pickMonth(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  draftMonth.value = v === '' ? null : Number(v)
}

function pickDay(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  draftDay.value = v === '' ? null : Number(v)
}

/* ---------- 实时读数：身体卡的 BMI / 训练卡的摘要 ---------- */

const bmi = computed(() => bmiOf(draftWeight.value, draftHeight.value))
const bmiBandInfo = computed(() => (bmi.value == null ? null : bmiBand(bmi.value)))

/** 预设之外的自定义忌口：渲染成带 ✕ 的可删 chip（预设是点选态，自定义是确认态） */
const customRestrictionList = computed(() =>
  draftRestrictions.value.filter((r) => !DIET_RESTRICTION_PRESETS.includes(r)),
)

const trainSummary = computed(
  () => `${draftDays.value} 天 · ${EQUIPMENT_LABELS[draftEquipment.value] ?? draftEquipment.value}`,
)

/* ---------- 忌口 ---------- */

/** 「自由安排」= 不限时段（落库 null，引擎按晚间兜底）；只在具体时段全不选时点亮 */
const freeSlots = computed(() => draftSlots.value.length === 0)

function toggleSlot(s: TimeSlot): void {
  draftSlots.value = draftSlots.value.includes(s)
    ? draftSlots.value.filter((x) => x !== s)
    : [...draftSlots.value, s]
}

function toggleRestriction(r: string): void {
  draftRestrictions.value = draftRestrictions.value.includes(r)
    ? draftRestrictions.value.filter((x) => x !== r)
    : [...draftRestrictions.value, r]
}

function addRestriction(): void {
  const v = newRestriction.value.trim()
  if (!v) return
  if (!draftRestrictions.value.includes(v)) draftRestrictions.value.push(v)
  newRestriction.value = ''
}

/* ---------- 保存 ---------- */

async function save(): Promise<void> {
  if (!n.profile || saving.value) return
  saving.value = true
  try {
    await n.saveProfile({
      ...n.profile,
      sex: draftSex.value as Sex,
      birthday:
        draftYear.value && draftMonth.value && draftDay.value
          ? `${draftYear.value}-${String(draftMonth.value).padStart(2, '0')}-${String(draftDay.value).padStart(2, '0')}`
          : null,
      heightCm: draftHeight.value,
      weightKg: Math.round(draftWeight.value * 10) / 10,
      targetWeightKg: Math.round(draftTarget.value * 10) / 10,
      trainingDaysPerWeek: draftDays.value,
      preferredTimeSlots: draftSlots.value.length ? draftSlots.value : null,
      equipment: draftEquipment.value as Equipment,
      experience: draftExperience.value as Experience,
      dietRestrictions: draftRestrictions.value.length ? draftRestrictions.value : null,
    })
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="个人约束" initial-snap="large" @close="emit('close')">
    <div class="csform">
      <!-- 身体数据：方案热卡的硬前置 -->
      <section class="sec">
        <header class="seccap">
          <span>身体数据</span>
          <em v-if="bmi && bmiBandInfo" class="capinfo num" :class="`t-${bmiBandInfo.tone}`">
            BMI {{ bmi.toFixed(1) }} · {{ bmiBandInfo.label }}
          </em>
        </header>
        <div class="card">
          <div class="lrow">
            <span class="rlabel">性别</span>
            <SegmentedControl v-model="draftSex" class="sexseg" :options="SEX_OPTIONS" />
          </div>
          <div class="lrow">
            <span class="rlabel">生日</span>
            <div class="bsels" role="group" aria-label="生日">
              <select
                class="bsel"
                :class="{ unset: draftYear == null }"
                aria-label="出生年份"
                :value="draftYear ?? ''"
                @change="pickYear"
              >
                <option value="" disabled>年</option>
                <option v-for="y in YEAR_OPTIONS" :key="y" :value="y">{{ y }}</option>
              </select>
              <select
                class="bsel"
                :class="{ unset: draftMonth == null }"
                aria-label="出生月份"
                :value="draftMonth ?? ''"
                @change="pickMonth"
              >
                <option value="" disabled>月</option>
                <option v-for="m in MONTH_OPTIONS" :key="m" :value="m">{{ m }}</option>
              </select>
              <select
                class="bsel"
                :class="{ unset: draftDay == null }"
                aria-label="出生日"
                :value="draftDay ?? ''"
                @change="pickDay"
              >
                <option value="" disabled>日</option>
                <option v-for="d in DAY_OPTIONS" :key="d" :value="d">{{ d }}</option>
              </select>
            </div>
          </div>
          <NumberStepper v-model="draftHeight" label="身高" unit="cm" :min="80" :max="250" />
          <NumberStepper v-model="draftWeight" label="体重" unit="kg" :step="0.1" :decimals="1" :min="25" :max="300" />
          <NumberStepper v-model="draftTarget" label="目标体重" unit="kg" :step="0.1" :decimals="1" :min="25" :max="300" />
        </div>
      </section>

      <!-- 训练约束：方案生成的输入参数 -->
      <section class="sec">
        <header class="seccap">
          <span>训练约束</span>
          <em class="capinfo num">{{ trainSummary }}</em>
        </header>
        <div class="card">
          <NumberStepper v-model="draftDays" label="每周训练" unit="天" :min="0" :max="7" />

          <div class="crow">
            <p class="rlabel">运动时段</p>
            <div class="chips">
              <button
                type="button"
                class="chip"
                :class="{ on: freeSlots }"
                :aria-pressed="freeSlots"
                @click="draftSlots = []"
              >
                自由安排
              </button>
              <button
                v-for="s in SLOT_OPTIONS"
                :key="s"
                type="button"
                class="chip"
                :class="{ on: draftSlots.includes(s) }"
                :aria-pressed="draftSlots.includes(s)"
                @click="toggleSlot(s)"
              >
                {{ TIME_SLOT_LABELS[s] }}
              </button>
            </div>
          </div>

          <div class="crow">
            <p class="rlabel">器械条件</p>
            <div class="chips">
              <button
                v-for="e in EQUIP_OPTIONS"
                :key="e.value"
                type="button"
                class="chip"
                :class="{ on: draftEquipment === e.value }"
                :aria-pressed="draftEquipment === e.value"
                @click="draftEquipment = e.value"
              >
                {{ e.label }}
              </button>
            </div>
          </div>

          <div class="crow">
            <p class="rlabel">训练经验</p>
            <div class="chips">
              <button
                v-for="e in EXP_OPTIONS"
                :key="e.value"
                type="button"
                class="chip"
                :class="{ on: draftExperience === e.value }"
                :aria-pressed="draftExperience === e.value"
                @click="draftExperience = e.value"
              >
                {{ e.label }}
              </button>
            </div>
          </div>

          <div class="crow">
            <p class="rlabel">
              忌口 / 过敏
              <em class="rhint">点选排除，食谱会自动避开</em>
            </p>
            <div class="chips">
              <button
                v-for="r in DIET_RESTRICTION_PRESETS"
                :key="r"
                type="button"
                class="chip"
                :class="{ on: draftRestrictions.includes(r) }"
                :aria-pressed="draftRestrictions.includes(r)"
                @click="toggleRestriction(r)"
              >
                {{ r }}
              </button>
              <button
                v-for="r in customRestrictionList"
                :key="r"
                type="button"
                class="chip on chip-x"
                :aria-label="`删除忌口 ${r}`"
                @click="toggleRestriction(r)"
              >
                {{ r }}
                <X :size="12" :stroke-width="2.5" />
              </button>
            </div>
            <input
              v-model="newRestriction"
              class="cinput"
              placeholder="自定义忌口，回车添加（如：芒果、花生）"
              @keydown.enter.prevent="addRestriction"
            >
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <button class="save" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </SheetModal>
</template>

<style scoped>
/* ================= 版式：分组行卡 ================= */
/* 灰底分组卡坐在白抽屉上（iOS Health 的 inset grouped）；
   行内控件一律反白 —— 灰卡上的 surface-2 会隐形，这是选型不是口味。 */
.csform {
  padding-top: 6px;
}

.sec + .sec {
  margin-top: 18px;
}

/* 分组小帽：左标题右实时读数。呼吸位上多下少 */
.seccap {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 0 6px;
  margin-bottom: 7px;
}

.seccap span {
  font-size: var(--fs-caption);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-3);
}

.capinfo {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
}

/* BMI 读数分档色 */
.capinfo.t-ok {
  color: var(--ok-strong);
}

.capinfo.t-warn {
  color: var(--warn);
}

.capinfo.t-danger {
  color: var(--danger);
}

.card {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  padding: 3px 14px;
}

/* 发丝线分行：卡内第二个孩子起都压一条，行节奏统一 */
.card > * + * {
  border-top: 0.5px solid var(--line);
}

.lrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  min-height: 44px;
}

.rlabel {
  flex: none;
  font-size: var(--fs-subhead);
  font-weight: 500;
  color: var(--text-1);
}

.rhint {
  margin-left: 7px;
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--text-3);
  font-style: normal;
}

/* ================= 行内控件（反白） ================= */

/* 性别：二选一分段，定宽防挤压；白轨道让滑块在灰卡上仍可读 */
.sexseg {
  width: 168px;
  flex: none;
  background: var(--surface);
}

/* 生日：年 / 月 / 日 三个白底下拉，替掉原生 date（yyyy/mm/日 占位键盘难用） */
.bsels {
  display: flex;
  gap: 7px;
  flex: none;
}

.bsel {
  padding: 8px 8px 8px 11px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: 500;
  color: var(--text-1);
}

.bsel[aria-label='出生年份'] {
  min-width: 96px;
}

.bsel[aria-label='出生月份'],
.bsel[aria-label='出生日'] {
  min-width: 72px;
}

/* 未选中的占位（年/月/日）降灰：读起来是「未设置」而不是一个已选的值 */
.bsel.unset {
  color: var(--text-3);
}

/* 步进行本身就是一个行：把组件自带的上下内边距并进行节奏 */
.card :deep(.stepper) {
  flex: 1;
  padding: 9px 0;
  min-height: 44px;
  box-sizing: border-box;
}

/* 步进小圆钮在灰卡上反白（与 .chip 同一反白逻辑） */
.card :deep(.ctrl button::before) {
  background: var(--surface);
}

/* chips 行：标签在上，选项换行铺满 */
.crow {
  display: grid;
  gap: 9px;
  padding: 11px 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 8px 14px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: 500;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}

/* 自定义忌口 chip：文字 + 删除叉排成一行 */
.chip-x {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.cinput {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.cinput::placeholder {
  color: var(--text-3);
}

/* ================= 保存（钉底） ================= */

.save {
  width: 100%;
  padding: 14px 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-body);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.save:disabled {
  opacity: 0.5;
}
</style>
