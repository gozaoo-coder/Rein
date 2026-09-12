<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Minus, Plus, Settings2 } from 'lucide-vue-next'

import MonthView from '@/components/todo/MonthView.vue'
import NumberStepper from '@/components/common/NumberStepper.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import WeekView from '@/components/todo/WeekView.vue'
import { EQUIPMENT_LABELS, EXPERIENCE_LABELS, GOAL_LABELS, TIME_SLOT_LABELS } from '@/config/domain'
import { fmtCents } from '@/config/ledger'
import { useLedgerStore } from '@/stores/ledger'
import { useNutritionStore } from '@/stores/nutrition'
import { usePomodoroStore } from '@/stores/pomodoro'
import type { Equipment, Experience, Sex, TimeSlot } from '@/types'
import { todayStr } from '@/utils/date'

/**
 * 我 · 生活面板：2 列便当格——身份缩成一行，待办/目标/记账/番茄钟/约束
 * 各占一格一屏尽收；高频值（专注时长）格内可调，低频配置收进底部「设置」抽屉。
 * 个人约束是健康方案的生成依据，编辑抽屉与跳转保持既有链路。
 */
const router = useRouter()
const n = useNutritionStore()
const pomo = usePomodoroStore()
const ledger = useLedgerStore()

onMounted(() => {
  void n.loadProfile()
  void n.loadSummary(todayStr())
  void pomo.loadToday()
  void ledger.loadMonth()
  void ledger.loadBudget()
})

const avatarChar = computed(() => (n.profile?.nickname ?? 'R').slice(0, 1))
const heightText = computed(() => n.profile?.heightCm ?? '--')
const weightText = computed(() => n.profile?.weightKg ?? '--')
const goalText = computed(() => (n.profile ? GOAL_LABELS[n.profile.goal] : ''))

/* ---- 每日目标格 ---- */
const targetKcal = computed(() => (n.profile?.targets ? Math.round(n.profile.targets.kcal) : null))
const targetSub = computed(() => {
  const t = n.profile?.targets
  if (!t) return '未设置 · 点此配置'
  return `蛋白 ${Math.round(t.protein)}g · 碳水 ${Math.round(t.carb)}g · 脂肪 ${Math.round(t.fat)}g`
})

/* ---- 记账格 ---- */
const balanceCents = computed(() => ledger.monthIncomeCents - ledger.monthExpenseCents)
const balancePos = computed(() => balanceCents.value >= 0)
/** 结余展示取绝对值，符号由 balancePos 单独渲染（与 ledgerSub 同为分位口径） */
const balanceText = computed(() => fmtCents(Math.abs(balanceCents.value), { group: true }))
const ledgerSub = computed(() => {
  const base = `支 ${fmtCents(ledger.monthExpenseCents)} / 收 ${fmtCents(ledger.monthIncomeCents)}`
  const budget = ledger.settings?.monthlyBudgetCents ?? 0
  if (budget <= 0) return base
  const used = Math.min(999, Math.round((ledger.monthExpenseCents / budget) * 100))
  return `${base} · 预算已用 ${used}%`
})

/* ---- 待办完成度（周 / 月） ---- */
const view = ref<'week' | 'month'>('week')
const selectedDate = ref(todayStr())

/* ---- 番茄钟（格内调专注时长；完整配置在底部设置抽屉） ---- */

/* ---- 个人约束（健康方案生成依据） ---- */
const SLOT_OPTIONS: TimeSlot[] = ['morning', 'noon', 'evening']
const EQUIP_OPTIONS = [
  { value: 'gym', label: '健身房' },
  { value: 'home', label: '居家徒手' },
  { value: 'mixed', label: '都可以' },
]
const EXP_OPTIONS = [
  { value: 'beginner', label: '新手' },
  { value: 'intermediate', label: '有基础' },
  { value: 'advanced', label: '进阶' },
]

const constraintSummary = computed(() => {
  const p = n.profile
  return [
    { label: '训练', value: p?.trainingDaysPerWeek != null ? `${p.trainingDaysPerWeek} 天 · ${p.preferredTimeSlots?.length ? p.preferredTimeSlots.map((s) => TIME_SLOT_LABELS[s] ?? s).join('·') : '未设时段'}` : '未设置' },
    { label: '器械', value: p?.equipment ? EQUIPMENT_LABELS[p.equipment] : '未设置' },
    { label: '经验', value: p?.experience ? EXPERIENCE_LABELS[p.experience] : '未设置' },
    { label: '忌口', value: p?.dietRestrictions?.length ? p.dietRestrictions.join('、') : '无' },
  ]
})

/* 约束编辑抽屉：草稿就地改，保存才落库。
 * 身体数据（性别/生日/身高/体重）也在这里维护——它们是方案计算的硬前置，
 * 此前应用内没有手动编辑入口（只有 AI 工具和体重补录能写）。 */
const editOpen = ref(false)
const draftDays = ref(3)
const draftSlots = ref<TimeSlot[]>([])
const draftEquipment = ref<string>('gym')
const draftExperience = ref<string>('beginner')
const draftRestrictions = ref<string[]>([])
const newRestriction = ref('')
const draftSex = ref<string>('male')
const draftBirthday = ref('')
const draftHeight = ref(170)
const draftWeight = ref(65)

const SEX_OPTIONS = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
]

function toggleSlot(s: TimeSlot): void {
  const i = draftSlots.value.indexOf(s)
  if (i === -1) draftSlots.value.push(s)
  else draftSlots.value.splice(i, 1)
}

function addRestriction(): void {
  const v = newRestriction.value.trim()
  if (!v) return
  if (!draftRestrictions.value.includes(v)) draftRestrictions.value.push(v)
  newRestriction.value = ''
}

function openEdit(): void {
  const p = n.profile
  draftDays.value = p?.trainingDaysPerWeek ?? 3
  draftSlots.value = [...(p?.preferredTimeSlots ?? ['evening'])]
  draftEquipment.value = p?.equipment ?? 'gym'
  draftExperience.value = p?.experience ?? 'beginner'
  draftRestrictions.value = [...(p?.dietRestrictions ?? [])]
  newRestriction.value = ''
  draftSex.value = p?.sex ?? 'male'
  draftBirthday.value = p?.birthday ?? ''
  draftHeight.value = Math.round(p?.heightCm ?? 170)
  draftWeight.value = Math.round((p?.weightKg ?? 65) * 10) / 10
  editOpen.value = true
}

async function saveConstraints(): Promise<void> {
  if (!n.profile) return
  await n.saveProfile({
    ...n.profile,
    trainingDaysPerWeek: draftDays.value,
    preferredTimeSlots: draftSlots.value.length ? draftSlots.value : null,
    equipment: draftEquipment.value as Equipment,
    experience: draftExperience.value as Experience,
    dietRestrictions: draftRestrictions.value.length ? draftRestrictions.value : null,
    sex: draftSex.value as Sex,
    birthday: draftBirthday.value || null,
    heightCm: draftHeight.value,
    weightKg: Math.round(draftWeight.value * 10) / 10,
  })
  editOpen.value = false
}

/* ---- 底部设置抽屉：番茄钟完整配置 + 关于 ---- */
const setOpen = ref(false)
</script>

<template>
  <div class="page">
    <!-- 身份条：点头像区进约束/身体资料编辑 -->
    <button class="id row" @click="openEdit">
      <div class="avatar col center">{{ avatarChar }}</div>
      <div class="idcol">
        <p class="nick">{{ n.profile?.nickname ?? '…' }}</p>
        <p class="meta num">{{ heightText }}cm · {{ weightText }}kg → {{ n.profile?.targetWeightKg ?? '--' }}kg · {{ goalText || '未设目标' }}</p>
      </div>
      <ChevronRight :size="16" class="t-3" />
    </button>

    <div class="grid">
      <!-- 待办完成度：周 / 月 -->
      <section class="cell span2">
        <header class="chead row between">
          <h2>待办完成度</h2>
          <SegmentedControl
            v-model="view"
            class="seg"
            :options="[
              { value: 'week', label: '周' },
              { value: 'month', label: '月' },
            ]"
          />
        </header>
        <WeekView v-if="view === 'week'" :selected="selectedDate" @select="selectedDate = $event" />
        <MonthView v-else :selected="selectedDate" @select="selectedDate = $event" />
      </section>

      <!-- 每日目标 -->
      <button class="cell" @click="router.push('/nutrition/adjust')">
        <header class="chead"><h2>每日目标</h2></header>
        <p class="bignum num">{{ targetKcal ?? '--' }}<i>大卡</i></p>
        <p class="sub">{{ targetSub }}</p>
      </button>

      <!-- 记账 -->
      <button class="cell" @click="router.push('/ledger')">
        <header class="chead"><h2>本月结余</h2></header>
        <p class="bignum num" :class="balancePos ? 'pos' : 'neg'">
          {{ balancePos ? '+' : '-' }}{{ balanceText }}<i>元</i>
        </p>
        <p class="sub num">{{ ledgerSub }}</p>
      </button>

      <!-- 番茄钟：今日专注 + 专注时长格内可调 -->
      <section class="cell span2">
        <header class="chead row between">
          <h2>番茄钟</h2>
          <span class="num t-3">今日专注 {{ pomo.todayFocusMin }} 分钟</span>
        </header>
        <div class="pomo row between">
          <span class="pmeta">专注时长<b class="num">{{ pomo.settings.focusMin }}<i>分钟</i></b></span>
          <span class="stepper row">
            <button aria-label="减少专注时长" @click="pomo.settings.focusMin = Math.max(5, pomo.settings.focusMin - 5)"><Minus :size="15" /></button>
            <button aria-label="增加专注时长" @click="pomo.settings.focusMin = Math.min(120, pomo.settings.focusMin + 5)"><Plus :size="15" /></button>
          </span>
        </div>
        <p class="hint t-3">短休 {{ pomo.settings.breakMin }} 分 · 长休 {{ pomo.settings.longBreakMin }} 分 · 每 {{ pomo.settings.roundsBeforeLongBreak }} 轮长休</p>
      </section>

      <!-- 知识库：AI 的检索模式与长期记忆 -->
      <button class="cell span2" @click="router.push('/ai/knowledge')">
        <header class="chead row between">
          <h2>知识库</h2>
          <span class="go row">管理<ChevronRight :size="13" /></span>
        </header>
        <p class="hint t-3">AI 从这里检索你的日程、运动、饮食与历史对话，并长期记住你的偏好与约束</p>
      </button>

      <!-- 个人约束：方案生成依据 -->
      <button class="cell span2" @click="openEdit">
        <header class="chead row between">
          <h2>个人约束</h2>
          <span class="go row">编辑<ChevronRight :size="13" /></span>
        </header>
        <ul class="clist num">
          <li v-for="c in constraintSummary" :key="c.label">
            <em>{{ c.label }}</em>
            <b>{{ c.value }}</b>
          </li>
        </ul>
        <p class="hint t-3">健康方案按这些约束计算日程与食谱；也可在「健康方案」向导中临时调整</p>
      </button>
    </div>

    <!-- 设置入口 -->
    <button class="setrow row between" @click="setOpen = true">
      <span class="row setlabel"><Settings2 :size="16" /> 设置</span>
      <span class="row setval">番茄钟 · 关于<ChevronRight :size="15" class="chev" /></span>
    </button>

    <!-- 个人约束编辑（保留既有抽屉） -->
    <SheetModal :open="editOpen" title="个人约束" initial-snap="large" @close="editOpen = false">
      <div class="cform">
        <div class="grid2">
          <NumberStepper v-model="draftHeight" label="身高（cm）" :min="80" :max="250" />
          <NumberStepper v-model="draftWeight" label="体重（kg）" :step="0.1" :min="25" :max="300" />
        </div>

        <div class="frow">
          <p class="flabel">性别</p>
          <SegmentedControl v-model="draftSex" :options="SEX_OPTIONS" />
        </div>

        <div class="frow">
          <p class="flabel">生日</p>
          <input v-model="draftBirthday" type="date" class="dinput" aria-label="生日">
        </div>

        <NumberStepper v-model="draftDays" label="每周训练（天）" :min="0" :max="7" />

        <div class="frow">
          <p class="flabel">运动时段</p>
          <div class="chips">
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

        <div class="frow">
          <p class="flabel">器械条件</p>
          <SegmentedControl v-model="draftEquipment" :options="EQUIP_OPTIONS" />
        </div>

        <div class="frow">
          <p class="flabel">训练经验</p>
          <SegmentedControl v-model="draftExperience" :options="EXP_OPTIONS" />
        </div>

        <div class="frow">
          <p class="flabel">忌口 / 过敏</p>
          <div class="restrict-edit row">
            <input
              v-model="newRestriction"
              class="rinput"
              placeholder="如：牛奶、海鲜、花生…回车添加"
              @keydown.enter.prevent="addRestriction"
            >
            <button class="link row center" type="button" @click="addRestriction">添加</button>
          </div>
          <div v-if="draftRestrictions.length" class="chips">
            <button
              v-for="r in draftRestrictions"
              :key="r"
              type="button"
              class="chip on"
              :aria-label="`删除忌口 ${r}`"
              @click="draftRestrictions = draftRestrictions.filter((x) => x !== r)"
            >
              {{ r }} ×
            </button>
          </div>
        </div>

        <button class="save" type="button" @click="saveConstraints">保存</button>
      </div>
    </SheetModal>

    <!-- 设置抽屉：番茄钟完整配置 + 关于 -->
    <SheetModal :open="setOpen" title="设置" @close="setOpen = false">
      <div class="sform">
        <header class="shead row between">
          <h2>番茄钟</h2>
          <span class="num t-3">今日专注 {{ pomo.todayFocusMin }} 分钟</span>
        </header>
        <div class="sgrid">
          <NumberStepper v-model="pomo.settings.focusMin" label="专注时长" unit="分钟" :step="5" :min="5" :max="120" />
          <NumberStepper v-model="pomo.settings.breakMin" label="短休息" unit="分钟" :step="1" :min="1" :max="30" />
          <NumberStepper v-model="pomo.settings.longBreakMin" label="长休息" unit="分钟" :step="5" :min="5" :max="60" />
          <NumberStepper v-model="pomo.settings.roundsBeforeLongBreak" label="长休间隔" unit="轮" :step="1" :min="2" :max="8" />
        </div>
        <p class="about t-3">
          Rein v0.2.0 · Tauri + Vue + Rust<br>
          架构与编码规范见 docs/ARCHITECTURE.md 与 docs/STANDARDS.md
        </p>
      </div>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 身份条 */
.id {
  gap: 11px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.id:active {
  background: var(--surface-2);
}

.avatar {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--c-intake), #ff6482);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
}

.idcol {
  flex: 1;
  min-width: 0;
}

.nick {
  font-size: var(--fs-headline);
  font-weight: 700;
}

.meta {
  margin-top: 1px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 便当格 */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  animation: rise var(--dur-base) var(--ease-standard) both;
}

.cell {
  padding: 13px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  font: inherit;
  color: inherit;
  min-width: 0;
}

.span2 {
  grid-column: span 2;
}

button.cell {
  transition: background-color var(--dur-fast) var(--ease-standard);
}

button.cell:active {
  background: var(--surface-2);
}

.chead h2 {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.go {
  gap: 1px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--accent);
}

.seg {
  width: 104px;
}

.bignum {
  margin-top: 8px;
  font-size: var(--fs-display-m);
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1;
}

.bignum i {
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: 400;
  color: var(--text-3);
  margin-left: 3px;
  letter-spacing: 0;
}

.bignum.pos {
  color: var(--ok-strong);
}

.bignum.neg {
  color: var(--danger);
}

.sub {
  margin-top: 6px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 番茄钟行 */
.pomo {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

.pmeta {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.pmeta b {
  margin-left: 8px;
  font-size: var(--fs-title3);
  color: var(--text-1);
}

.pmeta i {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--text-3);
  margin-left: 1px;
}

.stepper {
  gap: 8px;
}

.stepper button {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: var(--shadow-thumb);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hint {
  margin-top: 8px;
  font-size: var(--fs-micro);
}

/* 约束摘要 */
.clist {
  margin-top: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.clist em {
  display: block;
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.clist b {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-footnote);
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 设置入口行 */
.setrow {
  width: 100%;
  gap: 10px;
  padding: 13px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.setrow:active {
  background: var(--surface-2);
}

.setlabel {
  gap: 8px;
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--text-1);
}

.setval {
  gap: 2px;
  font-size: var(--fs-footnote);
  color: var(--text-3);
}

.chev {
  color: var(--text-3);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .grid {
    animation: none;
  }
}

/* 个人约束编辑抽屉（沿用既有表单） */
.cform {
  display: grid;
  gap: 18px;
  padding-bottom: 20px;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.dinput {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.frow {
  display: grid;
  gap: 8px;
}

.flabel {
  font-size: var(--fs-subhead);
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 7px 14px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-2);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.restrict-edit {
  gap: 8px;
}

.rinput {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: var(--radius-s);
  border: none;
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  color: var(--text-1);
}

.save {
  margin-top: 4px;
  padding: 13px 0;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-callout);
  font-weight: 700;
}

/* 设置抽屉 */
.sform {
  display: grid;
  gap: 12px;
  padding-bottom: 20px;
}

.shead h2 {
  font-size: var(--fs-headline);
  font-weight: 700;
}

.sgrid {
  display: grid;
  grid-template-columns: 1fr;
}

.sgrid > * + * {
  border-top: 0.5px solid var(--line);
}

.about {
  font-size: var(--fs-caption);
  line-height: 1.7;
}
</style>
