<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

/**
 * 沉浸模式大数字输入：常态显示大数字，点数字就地变成输入框，可直接用输入法键入。
 *
 * 为什么用 type="text" + inputmode="decimal" 而不是 type="number"：
 *  - 中文输入法下 type=number 无法输入全角数字，部分 WebView 还会直接丢弃非 ASCII 字符；
 *  - number 输入在各家浏览器对小数点 / 逗号的容忍度不一致，且拿不到原始串做容错解析。
 * 因此这里始终用文本输入，提交时自行归一化（全角→半角、中文句号→小数点）后解析。
 *
 * 提交时机：失焦 / 回车（输入法组合中不响应，避免误提交候选词）；Esc 取消。
 * 清空提交 = null（表示「该动作没配次数」），由调用方决定如何展示。
 */
const props = withDefaults(
  defineProps<{
    /** 当前值；null = 未设置（展示占位符） */
    modelValue: number | null
    /** 单位文案，如 kg / 次 */
    unit: string
    /** 无障碍与提示用的字段名，如「重量」 */
    label: string
    step?: number
    min?: number
    max?: number
    /** md = 卡片内常规尺寸；lg = 页面主数字（次数） */
    size?: 'md' | 'lg'
    /** 小数位数：重量 1 位，次数 0 位 */
    precision?: number
    placeholder?: string
  }>(),
  { step: 1, min: 0, max: 9999, size: 'md', precision: 0, placeholder: '—' },
)

const emit = defineEmits<{ 'update:modelValue': [value: number | null] }>()

const editing = ref(false)
const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/** 展示文本：整数不带小数，小数按 precision 定长 */
const text = computed(() => {
  const v = props.modelValue
  if (v == null) return props.placeholder
  return props.precision > 0 && !Number.isInteger(v) ? v.toFixed(props.precision) : String(v)
})

function beginEdit(): void {
  if (editing.value) return
  draft.value = props.modelValue == null ? '' : String(props.modelValue)
  editing.value = true
  void nextTick(() => {
    const el = inputEl.value
    if (!el) return
    el.focus()
    el.select()
  })
}

/** 归一化后取第一个数字：全角数字 / 中文句号 / 千分位逗号都要能识别 */
function parse(raw: string): number | null {
  const s = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。｡]/g, '.')
    .replace(/[，,\s]/g, '')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  if (!Number.isFinite(n)) return null
  const k = 10 ** props.precision
  return Math.min(props.max, Math.max(props.min, Math.round(n * k) / k))
}

function commit(): void {
  if (!editing.value) return
  editing.value = false
  emit('update:modelValue', draft.value.trim() === '' ? null : parse(draft.value))
}

function cancel(): void {
  editing.value = false
}

function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return // 输入法候选还没上屏，别抢这次回车
  e.preventDefault()
  commit()
}

function bump(d: number): void {
  const base = props.modelValue ?? 0
  const raw = Math.min(props.max, Math.max(props.min, base + d))
  const k = 10 ** props.precision
  emit('update:modelValue', Math.round(raw * k) / k)
}
</script>

<template>
  <div class="biginput row center" :class="`sz-${size}`">
    <button
      v-if="!editing"
      type="button"
      class="wbtn"
      :aria-label="`${label}减 ${step}${unit}`"
      @click="bump(-step)"
    >
      −
    </button>

    <div class="wval row center" :class="{ editing }">
      <input
        v-if="editing"
        ref="inputEl"
        v-model="draft"
        class="winp num"
        type="text"
        inputmode="decimal"
        enterkeyhint="done"
        autocomplete="off"
        :aria-label="`输入${label}`"
        @keydown.enter="onEnter"
        @keydown.esc.prevent="cancel"
        @blur="commit"
      />
      <button v-else type="button" class="wview num" :aria-label="`修改${label}`" @click="beginEdit">
        <b>{{ text }}</b><span class="wunit">{{ unit }}</span>
      </button>
      <!-- mousedown.prevent 保住焦点，避免 blur 先提交把按钮点没了 -->
      <button v-if="editing" type="button" class="wok" @mousedown.prevent @click="commit">确定</button>
    </div>

    <button
      v-if="!editing"
      type="button"
      class="wbtn"
      :aria-label="`${label}加 ${step}${unit}`"
      @click="bump(step)"
    >
      ＋
    </button>
  </div>
</template>

<style scoped>
.biginput {
  gap: 18px;
}

.wbtn {
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  font-size: 30px;
  font-weight: 400;
  color: var(--text-1);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.wbtn:active {
  transform: scale(0.9);
}

.wval {
  gap: 6px;
  min-width: 128px;
  justify-content: center;
}

.wval.editing {
  min-width: 172px;
  gap: 8px;
}

.wview {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  border-radius: var(--radius-s);
  color: var(--text-1);
}

.wview:active {
  background: var(--surface-2);
}

.wview b {
  font-size: 44px;
  font-weight: 200;
  letter-spacing: -1.5px;
  line-height: 1;
}

.wunit {
  font-size: var(--fs-callout);
  font-weight: 500;
  color: var(--text-3);
}

/* 输入框：宽度按最长常见值（3 位 + 1 位小数）留够，避免键入时抖动 */
.winp {
  width: 116px;
  padding: 4px 10px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: 32px;
  font-weight: 300;
  letter-spacing: -0.5px;
  text-align: center;
  color: var(--text-1);
}

.wok {
  flex: none;
  padding: 6px 10px;
  border-radius: var(--radius-full);
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
  font-size: var(--fs-caption);
  font-weight: 700;
}

/* 主数字档：次数沿用页面最大的视觉层级，步进钮相应收小 */
.sz-lg .wbtn {
  width: 40px;
  height: 40px;
  font-size: 24px;
  background: transparent;
  color: var(--text-3);
}

.sz-lg .biginput,
.sz-lg {
  gap: 10px;
}

.sz-lg .wview b {
  font-size: 84px;
  font-weight: 200;
  letter-spacing: -4px;
}

.sz-lg .wunit {
  font-size: 26px;
  font-weight: 300;
  color: var(--text-2);
}

.sz-lg .wval {
  min-width: 172px;
}

.sz-lg .winp {
  width: 148px;
  font-size: 56px;
  font-weight: 200;
  letter-spacing: -2px;
}
</style>
