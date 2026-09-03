<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ImagePlus, LoaderCircle, Pencil, Plus, Search, Sparkles, X } from 'lucide-vue-next'

import ManageModelsButton from '@/components/ai/ManageModelsButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import FoodPickerSheet from '@/components/diet/FoodPickerSheet.vue'
import TodoEditorSheet from '@/components/todo/TodoEditorSheet.vue'
import { CATEGORY_META, MEAL_LABELS, MEAL_ORDER, priorityMeta, suggestMeal } from '@/config/domain'
import { useAiStore } from '@/stores/ai'
import { useModelsStore } from '@/stores/models'
import { useTodoStore } from '@/stores/todo'
import { minToHHmm, parseDate } from '@/utils/date'
import { resizeImageAsJpeg } from '@/utils/image'
import { useToast } from '@/composables/useToast'
import type { MealType, ParsedFoodItem, Todo, TodoCategory, TodoDraft } from '@/types'

/**
 * 智能添加抽屉（待办 / 饮食通用）：
 * 与 AI 聊天同款交互——上传图片先进草稿区（缩略图芯片，可移除），可同时粘贴文字，
 * 点「生成」后由 AI 在后台解析（任务类内容→待办草稿；吃吃喝喝→食物卡并估算重量），
 * 结果分区出卡供确认、编辑后添加。手动入口按 mode 提供待办表单 / 食物库选择。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    date: string
    /** 待办/饮食模式：决定标题与手动入口 */
    mode?: 'todo' | 'food'
    /** 手动添加待办时的默认分类（如运动页只加运动待办） */
    category?: TodoCategory
    /** 食物模式的预选餐次（如方案页「下一餐」）；缺省按当前时间推测 */
    defaultMeal?: MealType | null
  }>(),
  { mode: 'todo' },
)

const emit = defineEmits<{ close: [] }>()

const todoStore = useTodoStore()
const models = useModelsStore()
const ai = useAiStore()
const toast = useToast()

const NO_MODEL_TEXT = '还没有可用的 AI 模型：先到「管理模型」添加并测试模型后，智能添加即可用。'
const isFood = computed(() => props.mode === 'food')

const text = ref('')
const busy = ref(false)
const adding = ref(false)
const committing = ref(false)
const error = ref('')
const todos = ref<TodoDraft[]>([])
const foods = ref<ParsedFoodItem[]>([])
const foodStats = ref({ totalKcal: 0, total: 0, matched: 0 })
const meal = ref<MealType>(suggestMeal())

// 每次打开重置餐次：调用方给了预选（如「下一餐」）就跟随，否则按当前时间推测
watch(
  () => props.open,
  (open) => {
    if (open) meal.value = props.defaultMeal ?? suggestMeal()
  },
)
const foodCommitted = ref(false)
/** 待发送附图（草稿区）：选图后先挂这里，可移除，点「生成」才随文字一起处理 */
const attachment = ref<{ full: string; small: string | null } | null>(null)
const fileRef = ref<HTMLInputElement | null>(null)

/* ---------- AI 生成（文字 + 可选附图一起后台处理） ---------- */

function failMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function ensureModels(): Promise<void> {
  if (!models.loaded) await models.load()
}

async function runGenerate(): Promise<void> {
  await ensureModels()
  const cfg = attachment.value ? models.bestVisionModel() : models.defaultModel()
  if (!cfg) {
    error.value = attachment.value ? `${NO_MODEL_TEXT}（图片识别需要支持视觉的模型）` : NO_MODEL_TEXT
    return
  }
  busy.value = true
  error.value = ''
  try {
    const { generateSmart } = await import('@/ai/smartGen')
    const att = attachment.value
    const r = await generateSmart(
      cfg,
      text.value,
      att ? { data: att.full, mimeType: 'image/jpeg' } : undefined,
    )
    todos.value = r.todos
    foods.value = r.foods
    foodCommitted.value = false
    meal.value = suggestMeal()
    if (r.todos.length === 0 && r.foods.length === 0) {
      error.value = '没有识别出待办或食物。描述得更具体一些（时间、事件、吃的喝的、数量）再试试。'
    }
  } catch (e) {
    error.value = `识别失败：${failMsg(e)}`
  } finally {
    busy.value = false
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('图片读取失败'))
    fr.readAsDataURL(file)
  })
}

/** 选图 → 先进草稿区（不立即解析），可继续粘贴文字 */
async function onPickImage(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!file) return
  const dataUrl = await readAsDataURL(file)
  const [full, small] = await Promise.all([
    resizeImageAsJpeg(dataUrl, 1600, 0.85),
    resizeImageAsJpeg(dataUrl, 240, 0.6).catch(() => null),
  ])
  attachment.value = { full, small }
  error.value = ''
}

/* ---------- 待办确认 ---------- */

const pendingCount = computed(() => todos.value.filter((d) => d.checked && !d.added).length)

async function addChecked(): Promise<void> {
  const pick = todos.value.filter((d) => d.checked && !d.added)
  if (pick.length === 0) return
  adding.value = true
  try {
    for (const d of pick) {
      await todoStore.create({
        title: d.title,
        notes: d.notes,
        date: d.date,
        startMin: d.startMin,
        durationMin: d.durationMin,
        category: d.category,
        priority: d.priority,
      })
      d.added = true
    }
  } finally {
    adding.value = false
  }
}

/* 点击待办草稿 → 进编辑器调整细节；保存后该草稿已落库，同步展示 */
const editingKey = ref<string | null>(null)
const editorOpen = ref(false)

function openEditor(d: TodoDraft): void {
  editingKey.value = d.key
  editorOpen.value = true
}

function onEditorSaved(todo: Todo): void {
  const d = todos.value.find((x) => x.key === editingKey.value)
  if (!d) return
  d.title = todo.title
  d.notes = todo.notes
  d.date = todo.date ?? d.date
  d.startMin = todo.startMin
  d.durationMin = todo.durationMin
  d.category = todo.category
  d.priority = todo.priority
  d.added = true
}

/** AI 会推断日期（明天/下周…），不等于当前日期时必须显式展示，否则用户看不到排错天 */
function shortDate(s: string): string {
  const d = parseDate(s)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function fmtMeta(d: TodoDraft): string {
  const parts: string[] = []
  if (d.date !== props.date) parts.push(shortDate(d.date))
  if (d.startMin != null) parts.push(minToHHmm(d.startMin))
  return parts.join(' ')
}

/** AI 幻觉条目直接移除，而不是只能不勾一直留着 */
function removeDraft(key: string): void {
  todos.value = todos.value.filter((x) => x.key !== key)
}

/* ---------- 食物确认 ---------- */

async function commitFoods(): Promise<void> {
  if (foods.value.length === 0 || foodCommitted.value) return
  committing.value = true
  try {
    const r = await ai.commitParsedItems(foods.value, meal.value, 'text_ai')
    if (r.written === 0) {
      toast.toast('没有可写入的食物（全部未匹配食物库）')
      return
    }
    const skipped = foods.value.length - r.written
    toast.toast(
      skipped > 0
        ? `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}，跳过 ${skipped} 项未匹配`
        : `已写入 ${r.written} 项到今日${MEAL_LABELS[meal.value]}`,
    )
    foodCommitted.value = true
  } finally {
    committing.value = false
  }
}

/* ---------- 手动入口 ---------- */

const pickerOpen = ref(false)

function clearAll(): void {
  if (busy.value) return // 生成中清空会让完成后的结果凭空回填
  text.value = ''
  attachment.value = null
  todos.value = []
  foods.value = []
  error.value = ''
  foodCommitted.value = false
}
</script>

<template>
  <SheetModal :open="open" :title="isFood ? '记饮食' : '添加待办'" @close="emit('close')">
    <!-- 右上角：管理模型（无模型/换模型时直接跳转） -->
    <template #action>
      <ManageModelsButton @manage="emit('close')" />
    </template>
    <div class="add">
      <!-- 智能添加面板 -->
      <div class="smart card">
        <div class="row between">
          <p class="tag row center"><Sparkles :size="14" /> 智能添加</p>
          <button v-if="text || attachment || todos.length || foods.length" class="clear" :disabled="busy" @click="clearAll">清空</button>
        </div>

        <textarea
          v-model="text"
          class="paste"
          rows="3"
          placeholder="粘贴便签、聊天记录或想法，AI 会提取待办；提到吃的会同时出食物卡…"
        />

        <!-- 草稿区：选图先进这里（可移除），随文字一起生成 -->
        <div v-if="attachment" class="attach-row">
          <div class="attach-chip">
            <img :src="`data:image/jpeg;base64,${attachment.small ?? attachment.full}`" alt="待处理图片">
            <button class="attach-x" aria-label="移除图片" @click="attachment = null">
              <span class="xmark">×</span>
            </button>
          </div>
          <span class="attach-hint t-3">图片已就绪，可继续粘贴文字后一起生成</span>
        </div>

        <div class="row between">
          <button class="pic" @click="fileRef?.click()">
            <ImagePlus :size="16" />
            {{ attachment ? '换一张图' : '识别图片' }}
          </button>
          <button class="run" :disabled="busy || (!text.trim() && !attachment)" @click="runGenerate">
            <LoaderCircle v-if="busy" :size="15" class="spin" />
            <template v-else>生成</template>
          </button>
        </div>
        <input ref="fileRef" type="file" accept="image/*" hidden @change="onPickImage">
      </div>

      <!-- 忙碌 / 错误 -->
      <p class="state t-3 num">
        <span v-if="busy">AI 正在后台解析…</span>
        <span v-else-if="error" class="err">{{ error }}</span>
      </p>

      <!-- 食物卡（识别结果 → 确认餐次 → 写入今日） -->
      <template v-if="foods.length">
        <p class="count t-3 num">
          识别到 {{ foods.length }} 项食物 · ≈{{ foodStats.totalKcal }} 大卡
        </p>
        <div class="food-card">
          <FoodParseEditor v-model="foods" @change="foodStats = $event" />
          <template v-if="!foodCommitted">
            <SegmentedControl
              class="meal"
              v-model="meal"
              :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
            />
            <button class="commit" :disabled="committing || foodStats.matched === 0" @click="commitFoods">
              <LoaderCircle v-if="committing" :size="15" class="spin" />
              <template v-else><Plus :size="15" /> 写入今日{{ MEAL_LABELS[meal] }}</template>
            </button>
          </template>
          <p v-else class="done"><Check :size="14" /> 已写入今日{{ MEAL_LABELS[meal] }}</p>
        </div>
      </template>

      <!-- 待办草稿：标题可换行、异日显性、分类色点、备注预览、可移除 -->
      <template v-if="todos.length">
        <p class="count t-3 num">
          识别到 {{ todos.length }} 条待办<template v-if="pendingCount"> · 待添加 {{ pendingCount }}</template><template v-else-if="!todos.some((d) => !d.added)"> · 全部已处理</template><span class="t-3"> · 点卡片改细节</span>
        </p>
        <TransitionGroup tag="ul" name="tdl" class="list">
          <li
            v-for="(d, di) in todos"
            :key="d.key"
            class="draft"
            :class="{ added: d.added }"
            :style="{ '--i': di }"
          >
            <button
              class="pick"
              :class="{ on: d.checked }"
              :aria-label="d.checked ? '取消勾选' : '勾选'"
              :disabled="d.added"
              @click="d.checked = !d.checked"
            >
              <Transition name="ckin">
                <Check v-if="d.checked || d.added" :size="13" :stroke-width="3.2" />
              </Transition>
            </button>
            <button class="info col grow" @click="openEditor(d)">
              <span class="trow">
                <i class="catdot" :style="{ background: `var(${CATEGORY_META[d.category].colorVar})` }" />
                <b class="dt">{{ d.title }}</b>
              </span>
              <span class="meta num">
                <em v-if="fmtMeta(d)" class="mt">{{ fmtMeta(d) }}</em>
                <em class="mchip">
                  <i :style="{ background: `var(${CATEGORY_META[d.category].colorVar})` }" />
                  {{ CATEGORY_META[d.category].label }}
                </em>
                <em v-if="d.priority > 0" class="mchip" :class="d.priority === 2 ? 'urgent' : 'major'">
                  {{ priorityMeta(d.priority).label }}
                </em>
                <em v-if="d.added" class="mchip ok"><Check :size="10" :stroke-width="3" /> 已添加</em>
              </span>
              <span v-if="d.notes" class="notes t-3">{{ d.notes }}</span>
            </button>
            <span class="acts">
              <button class="act" aria-label="编辑细节" @click="openEditor(d)">
                <Pencil :size="14" />
              </button>
              <button v-if="!d.added" class="act danger" aria-label="移除该条" @click="removeDraft(d.key)">
                <X :size="14" />
              </button>
            </span>
          </li>
        </TransitionGroup>
        <button class="commit" :disabled="pendingCount === 0 || adding" @click="addChecked">
          <LoaderCircle v-if="adding" :size="15" class="spin" />
          <template v-else><Plus :size="15" /> 添加{{ pendingCount ? ` ${pendingCount} 条` : '' }}</template>
        </button>
      </template>

      <!-- 手动入口 -->
      <button v-if="isFood" class="manual row center" @click="pickerOpen = true">
        <Search :size="15" /> 从食物库选择
      </button>
      <button v-else class="manual row center" @click="editorOpen = true">
        <Plus :size="15" /> 手动填写待办
      </button>
    </div>

    <!-- 嵌套弹层：待办完整表单 / 食物库选择器 -->
    <TodoEditorSheet
      :open="editorOpen"
      :todo="null"
      :initial="editingKey ? (todos.find((d) => d.key === editingKey) ?? null) : { date, category }"
      :date
      @close="editorOpen = false"
      @saved="onEditorSaved"
    />
    <FoodPickerSheet :open="pickerOpen" :default-meal="meal" @close="pickerOpen = false" />
  </SheetModal>
</template>

<style scoped>
.add {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.smart {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.tag {
  gap: 5px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--accent);
}

.clear {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-3);
}

.clear:disabled {
  opacity: 0.4;
}

.paste {
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-subhead);
  resize: vertical;
  min-height: 64px;
}

.pic {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 12px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.run {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 18px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: 700;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.run:disabled {
  opacity: 0.4;
}

.spin {
  animation: vt-spin 0.9s linear infinite;
}

@keyframes vt-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 草稿区（AI 聊天同款附件芯片） */
.attach-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.attach-chip {
  position: relative;
  width: 56px;
  height: 56px;
  flex: none;
}

.attach-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-m);
  background: var(--surface);
}

.attach-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-2);
}

.xmark {
  font-size: 13px;
  line-height: 1;
  font-weight: 700;
}

.attach-hint {
  font-size: var(--fs-caption);
}

.state {
  min-height: 16px;
}

.state .err {
  color: var(--danger);
}

.count {
  font-weight: 600;
}

/* 食物卡 */
.food-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  animation: draft-in 250ms var(--ease-standard) both;
}

.meal {
  margin-top: 4px;
}

/* 待办草稿 */
.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 增删时其余卡 FLIP 平滑让位 */
.tdl-move {
  transition: transform var(--dur-base) var(--ease-standard);
}

.tdl-enter-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.tdl-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.tdl-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}

.tdl-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

/* AI 揭晓时刻：逐条浮出（stagger 40ms，不阻塞交互；reduced-motion 全局归零） */
.draft {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  animation: draft-in 250ms var(--ease-standard) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

@keyframes draft-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.draft.added {
  opacity: 0.55;
}

.pick {
  width: 24px;
  height: 24px;
  flex: none;
  margin-top: 1px;
  border-radius: 7px;
  border: 1.5px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  background: var(--surface);
  transition: background-color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard);
}

.pick.on {
  background: var(--accent);
  border-color: var(--accent);
}

.pick:disabled {
  opacity: 0.6;
}

/* 对勾弹入 */
.ckin-enter-active {
  transition:
    transform 120ms var(--ease-standard),
    opacity 120ms var(--ease-standard);
}

.ckin-enter-from {
  transform: scale(0.5);
  opacity: 0;
}

.info {
  text-align: left;
  gap: 3px;
  min-width: 0;
  padding: 0;
}

.trow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.catdot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
}

/* AI 标题可能很长：换行到两行而非截断丢信息 */
.dt {
  font-size: var(--fs-subhead);
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.meta .mt {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.mchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface);
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.mchip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.mchip.major {
  background: color-mix(in srgb, var(--c-carb) 14%, transparent);
  color: color-mix(in srgb, var(--c-carb) 80%, var(--text-1));
}

.mchip.urgent {
  background: var(--danger-soft);
  color: var(--danger);
}

.mchip.ok {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok-strong);
}

/* AI 可能带来源说明：一行截断预览，点了编辑器里看全文 */
.notes {
  font-size: var(--fs-micro);
  line-height: 1.4;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.acts {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.act {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.act:active {
  background: var(--surface);
  color: var(--text-2);
}

.act.danger:active {
  color: var(--danger);
}

.commit {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.commit:disabled {
  opacity: 0.4;
}

.done {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--ok);
}

.manual {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
}
</style>
