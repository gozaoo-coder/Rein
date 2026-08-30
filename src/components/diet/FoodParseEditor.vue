<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Pencil, Repeat2, Search, Trash2 } from 'lucide-vue-next'

import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import { dietService } from '@/services/dietService'
import type { Food, ParsedFoodItem } from '@/types'

/**
 * 可编辑食物解析列表：行内改重量（含常见份单位快捷换算）、改名（识别错别字/
 * 想标注场景如「拿铁大杯」）、从食物库匹配/换食物（识别错食物时人工纠正）、
 * 删除条目。聊天里的解析卡与拍照识别弹层共用；条目对象原地修改（引用稳定），
 * 每次变更 shallow-clone 数组向上通知，由父级决定持久化时机。
 */
const props = defineProps<{ modelValue: ParsedFoodItem[] }>()
const emit = defineEmits<{
  'update:modelValue': [ParsedFoodItem[]]
  /** 条目/重量/匹配变化时汇报汇总（父级展示总热量与可写入数） */
  change: [{ totalKcal: number; total: number; matched: number }]
}>()

/* ---- 食物详情缓存（每100g营养素 + 常用份单位），跨实例复用 ---- */
const foodCache = ref(new Map<number, Food>())

watch(
  () => props.modelValue.map((it) => it.foodId).join(','),
  async () => {
    for (const id of props.modelValue.map((it) => it.foodId)) {
      if (id == null || foodCache.value.has(id)) continue
      const f = await dietService.getFood(id)
      if (f) foodCache.value.set(id, f)
    }
  },
  { immediate: true },
)

/** 未匹配项的热量换算基准：首次出现时的克重（估算值按编辑比例缩放） */
const baseGrams = new WeakMap<object, number>()

/* 行身份：条目对象原地修改、数组浅拷贝，引用即稳定身份；
   用索引作 key 会在删除中间行时让后续行的编辑态/焦点串位 */
const uids = new WeakMap<object, number>()
let uidSeq = 0
function keyOf(it: ParsedFoodItem): number {
  let k = uids.get(it)
  if (k == null) {
    uidSeq += 1
    k = uidSeq
    uids.set(it, k)
  }
  return k
}
function baseline(it: ParsedFoodItem): number {
  let b = baseGrams.get(it)
  if (b == null) {
    b = it.grams > 0 ? it.grams : 1
    baseGrams.set(it, b)
  }
  return b
}

function kcalOf(it: ParsedFoodItem): number {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  if (f) return Math.round((f.kcal * it.grams) / 100)
  return Math.round((it.kcalEstimate * it.grams) / baseline(it))
}

/** 汇总上报：克重、条目数或营养缓存变化时重算 */
function emitStats(): void {
  let totalKcal = 0
  let matched = 0
  for (const it of props.modelValue) {
    totalKcal += kcalOf(it)
    if (it.foodId != null) matched++
  }
  emit('change', { totalKcal, total: props.modelValue.length, matched })
}

watch(
  [
    () => props.modelValue.length,
    () => props.modelValue.map((it) => it.grams).join(','),
    () => props.modelValue.map((it) => it.foodId).join(','),
    () => foodCache.value.size,
  ],
  emitStats,
  { immediate: true },
)

function macroLine(it: ParsedFoodItem): string {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  const kcal = kcalOf(it)
  const renamed = f && f.name !== it.foodName ? `匹配「${f.name}」· ` : ''
  if (!f) return `≈${kcal} 大卡 · 未匹配食物库，确认时不会写入`
  return `${renamed}≈${kcal} 大卡 · 蛋白${Math.round(f.protein * (it.grams / 100))}g · 碳水${Math.round(f.carb * (it.grams / 100))}g · 脂肪${Math.round(f.fat * (it.grams / 100))}g`
}

/** 常用份单位快捷按钮：点一下按「一份」的克重设置 */
function unitOptions(it: ParsedFoodItem): { label: string; grams: number }[] {
  const f = it.foodId != null ? foodCache.value.get(it.foodId) : undefined
  return (f?.units ?? []).slice(0, 4).map((u) => ({ label: `1${u.name}=${Math.round(u.grams)}g`, grams: Math.round(u.grams) }))
}

/* ---- 行内重量编辑 ---- */
const editIndex = ref<number | null>(null)
const draftVal = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/** 函数式 ref：v-for 里的字符串 ref 会被收集成数组，这里确保拿到单个元素 */
function setInputEl(el: unknown): void {
  inputEl.value = el instanceof HTMLInputElement ? el : null
}

function beginEdit(i: number): void {
  if (editIndex.value === i) return
  editIndex.value = i
  draftVal.value = String(Math.round(props.modelValue[i]?.grams ?? 0))
  void nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

function commitEdit(): void {
  const i = editIndex.value
  if (i == null) return
  const it = props.modelValue[i]
  const v = Math.round(Number(draftVal.value))
  if (it && Number.isFinite(v) && v > 0 && v !== it.grams) {
    it.grams = v
    emit('update:modelValue', [...props.modelValue])
  }
  editIndex.value = null
}

function cancelEdit(): void {
  editIndex.value = null
}

function applyUnit(it: ParsedFoodItem, grams: number): void {
  if (grams > 0 && grams !== it.grams) {
    it.grams = grams
    emit('update:modelValue', [...props.modelValue])
  }
  editIndex.value = null
}

function removeRow(i: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, idx) => idx !== i),
  )
}

/* ---- 行内改名（识别名是 AI 猜的，允许直接改字） ---- */
const editNameIndex = ref<number | null>(null)
const draftName = ref('')
const nameEl = ref<HTMLInputElement | null>(null)

function setNameEl(el: unknown): void {
  nameEl.value = el instanceof HTMLInputElement ? el : null
}

function beginRename(i: number): void {
  if (editNameIndex.value === i) return
  editNameIndex.value = i
  draftName.value = props.modelValue[i]?.foodName ?? ''
  void nextTick(() => {
    nameEl.value?.focus()
    nameEl.value?.select()
  })
}

function commitRename(): void {
  const i = editNameIndex.value
  if (i == null) return
  const it = props.modelValue[i]
  const v = draftName.value.trim()
  if (it && v && v !== it.foodName) {
    it.foodName = v
    emit('update:modelValue', [...props.modelValue])
  }
  editNameIndex.value = null
}

/* ---- 从食物库匹配 / 换一个（识别错食物时人工纠正；选中即回传不落库） ---- */
const pickIndex = ref<number | null>(null)
const pickerOpen = ref(false)

function openPicker(i: number): void {
  pickIndex.value = i
  pickerOpen.value = true
}

function onPicked(f: Food): void {
  const it = pickIndex.value != null ? props.modelValue[pickIndex.value] : null
  if (it) {
    it.foodId = f.id
    emit('update:modelValue', [...props.modelValue])
  }
  pickIndex.value = null
}
</script>

<template>
  <div>
    <TransitionGroup tag="ul" name="fprl" class="fpl">
      <li v-for="(it, i) in modelValue" :key="keyOf(it)" class="fpr" :class="{ miss: it.foodId == null }">
        <div class="info flex-1" @click="beginEdit(i)">
          <p class="name">
            <button
              v-if="editNameIndex !== i"
              class="name-btn"
              :aria-label="`改名 ${it.foodName}`"
              @click.stop="beginRename(i)"
            >
              <span class="name-text">{{ it.foodName }}</span>
              <Pencil :size="10" class="name-pen" />
            </button>
            <input
              v-else
              :ref="setNameEl"
              v-model="draftName"
              type="text"
              aria-label="食物名称"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="editNameIndex = null"
              @blur="commitRename"
            >
            <span v-if="it.foodId == null" class="tag">未匹配</span>
            <button
              v-else
              class="rematch"
              aria-label="换一个食物"
              @click.stop="openPicker(i)"
            >
              <Repeat2 :size="11" /> 换
            </button>
          </p>
          <p class="macro">{{ macroLine(it) }}</p>
          <button v-if="it.foodId == null" class="golink" @click.stop="openPicker(i)">
            <Search :size="11" /> 从食物库匹配
          </button>
          <div class="units-wrap" :class="{ open: editIndex === i && unitOptions(it).length > 0 }">
            <div v-if="editIndex === i && unitOptions(it).length > 0" class="units">
              <button
                v-for="u in unitOptions(it)"
                :key="u.label"
                class="unit"
                @click.stop="applyUnit(it, u.grams)"
              >
                {{ u.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="weight">
          <input
            v-if="editIndex === i"
            :ref="setInputEl"
            v-model="draftVal"
            type="number"
            inputmode="decimal"
            min="1"
            aria-label="克重"
            @click.stop
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="commitEdit"
          >
          <button v-else class="chip" @click.stop="beginEdit(i)">
            {{ Math.round(it.grams) }}g
            <Pencil :size="11" />
          </button>
          <span v-if="editIndex === i" class="g-suffix">克</span>
        </div>

        <button class="del" aria-label="删除该食物" @click.stop="removeRow(i)">
          <Trash2 :size="15" />
        </button>
      </li>
    </TransitionGroup>

    <!-- 换匹配用的食物库选择（纯选择模式：点结果即回传，不写记录） -->
    <FoodPickerSheet
      :open="pickerOpen"
      title="从食物库选择"
      select-only
      @close="pickerOpen = false"
      @pick="onPicked"
    />
  </div>
</template>

<style scoped>
.fpl {
  display: flex;
  flex-direction: column;
}

.fpr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}

.fpr + .fpr {
  border-top: 0.5px solid var(--line);
}

/* 列表增删：删除折叠退场，其余行 FLIP 平滑让位；新行轻浮入 */
.fprl-move {
  transition: transform var(--dur-base) var(--ease-standard);
}

.fprl-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.fprl-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.fprl-leave-active {
  overflow: hidden;
  max-height: 120px;
  transition:
    opacity 200ms var(--ease-standard),
    max-height 200ms var(--ease-standard);
}

.fprl-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.info {
  min-width: 0;
  cursor: text;
  border-radius: var(--radius-s);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.info:active {
  background: var(--surface-2);
}

.name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-subhead);
  font-weight: 600;
  min-width: 0;
}

/* 名称可点改名：铅笔微图标做可供性，避免整行文字链的视觉噪音 */
.name-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 1px 2px;
  border-radius: var(--radius-s);
  text-align: left;
  font: inherit;
  color: inherit;
}

.name-btn:active {
  background: var(--surface-2);
}

.name-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.name-pen {
  flex: none;
  color: var(--text-3);
  opacity: 0.7;
}

.name input {
  width: 100%;
  padding: 2px 6px;
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-subhead);
  font-weight: 600;
}

/* 换一个（已匹配）：低调的 mini pill，错配时人工纠正 */
.rematch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.rematch:active {
  color: var(--accent);
}

/* 未匹配行的显性纠正入口：这类条目确认时不会写入，必须引导处理 */
.golink {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  align-self: flex-start;
  margin-top: 3px;
  padding: 2px 0;
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.tag {
  padding: 1px 6px;
  margin-left: 2px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 700;
  vertical-align: 1px;
}

.macro {
  margin-top: 1px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.35;
}

.fpr.miss .macro {
  color: var(--text-3);
}

/* 份单位快捷区：展开时高度过渡，避免编辑中下方内容被无动画顶开 */
.units-wrap {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}

.units-wrap.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.units-wrap > .units {
  overflow: hidden;
  min-height: 0;
}

.units {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
}

.unit {
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.weight {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 74px;
  justify-content: flex-end;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.weight input {
  width: 72px;
  padding: 6px 8px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.g-suffix {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.del {
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-3);
}

.del:active {
  background: var(--surface-2);
  color: var(--danger);
}
</style>
