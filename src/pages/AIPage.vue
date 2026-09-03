<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Camera, Check, ChartPie, Copy, History, Plus, Quote, RotateCcw, SendHorizontal, Trash2, Wrench, X } from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import HistoryDrawer from '@/components/ai/HistoryDrawer.vue'
import FoodParseSheet from '@/components/ai/FoodParseSheet.vue'
import ManageModelsButton from '@/components/ai/ManageModelsButton.vue'
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER, suggestMeal } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { findAppTool } from '@/ai/tools/registry'
import { useAiStore } from '@/stores/ai'
import { copyText } from '@/utils/clipboard'
import { listFoodDrafts, removeFoodDraft, type FoodDraft } from '@/utils/foodDrafts'
import { resizeImageAsJpeg } from '@/utils/image'
import { fmtDateCn, toDateStr } from '@/utils/date'
import type { AiMessage, MealType } from '@/types'

/** AI 页：拍照直识别（可编辑卡片 + 草稿箱）/ 文字记饮食 / 数据工具对话。 */
const ai = useAiStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

/** 该工具是否为删除类高危操作（过程卡红色标注） */
function isDangerous(name: string): boolean {
  return findAppTool(name)?.dangerous ?? false
}

/* ---------- 拍照识别弹层与草稿箱 ---------- */

const foodSheet = ref<InstanceType<typeof FoodParseSheet> | null>(null)
const draftsOpen = ref(false)
const drafts = ref<FoodDraft[]>([])

function refreshDrafts(): void {
  drafts.value = listFoodDrafts()
}

function openDrafts(): void {
  refreshDrafts()
  draftsOpen.value = true
}

function editDraft(d: FoodDraft): void {
  // 先让草稿列表弹层走完关闭 watcher（恢复页面滚动锁），再打开编辑弹层
  draftsOpen.value = false
  void nextTick(() => foodSheet.value?.openDraft(d))
}

function deleteDraft(id: string): void {
  removeFoodDraft(id)
  refreshDrafts()
}

function fmtDraftTime(iso: string): string {
  const d = new Date(iso)
  // 日期与时刻都用本地时区：toISOString() 取的是 UTC，两者混用会出现
  // 「昨天 07:00」这类错位
  return `${fmtDateCn(toDateStr(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const draft = ref('')
const fileEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
/** 待发送附图：选图后先挂输入框上方（可移除/配文字），随下一条消息一起发出 */
const attachment = ref<{ full: string; small: string | null } | null>(null)

/** 每张解析卡选择的目标餐次，默认按当前时间推荐 */
const mealByMsg = reactive<Record<string, MealType>>({})

/** 历史抽屉 / 长按菜单 / 引用 */
const drawerOpen = ref(false)
const menuTarget = ref<AiMessage | null>(null)
/** 长按菜单锚定元素：被长按的那条消息气泡 */
const menuAnchor = ref<HTMLElement | null>(null)
const quote = ref<AiMessage | null>(null)

onMounted(() => {
  void ai.init()
  refreshDrafts()
  void scrollToBottom()
  if (route.query.intent === 'photo') fileEl.value?.click()
})

/* 其他页（桌面信息栏「问点什么」）带来的问题：预填进输入框并清掉 URL 参数 */
watch(
  () => route.query.ask,
  (v) => {
    if (typeof v === 'string' && v) {
      draft.value = v
      void router.replace({ query: { ...route.query, ask: undefined } })
    }
  },
  { immediate: true },
)

watch(
  () => ai.messages.length,
  () => void scrollToBottom(),
)

// 流式输出：最后一条消息文本增长时跟随滚动
watch(
  () => ai.messages.at(-1)?.text?.length,
  () => void scrollToBottom(),
)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
}

function send(): void {
  if (ai.busy) return
  const t = draft.value.trim()
  if (!t && !attachment.value) return
  const att = attachment.value
  draft.value = ''
  attachment.value = null
  const q = quote.value
  quote.value = null
  void ai.sendText(t, q?.text, att ? { base64: att.full, mime: 'image/jpeg' } : undefined)
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  const dataUrl = await readFileAsDataUrl(file)
  // 压出全图（随消息发给模型）与缩略图（附件芯片预览）；不立即发送
  const [full, small] = await Promise.all([
    resizeImageAsJpeg(dataUrl, 1600, 0.85),
    resizeImageAsJpeg(dataUrl, 240, 0.6).catch(() => null),
  ])
  attachment.value = { full, small }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/* ---------- 长按菜单（复制 / 引用 / 撤回；桌面右键同款） ---------- */

let pressTimer: number | undefined
let pressStart: { x: number; y: number } | null = null

function onPressStart(e: PointerEvent, m: AiMessage): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined
    menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
    menuTarget.value = m
  }, 450)
}

function onPressMove(e: PointerEvent): void {
  // 手指移动超过 8px 视为滚动，取消长按
  if (pressTimer === undefined || !pressStart) return
  if (Math.abs(e.clientX - pressStart.x) > 8 || Math.abs(e.clientY - pressStart.y) > 8) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function onPressEnd(): void {
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function onCtxMenu(e: MouseEvent, m: AiMessage): void {
  e.preventDefault()
  menuAnchor.value = (e.currentTarget as HTMLElement) ?? null
  menuTarget.value = m
}

const menuActions = computed<MenuItem[]>(() => {
  const m = menuTarget.value
  if (!m) return []
  const acts: MenuItem[] = []
  if (m.text) acts.push({ label: '复制', value: 'copy', icon: Copy })
  acts.push({ label: '引用', value: 'quote', icon: Quote })
  if (m.role === 'user') acts.push({ label: '撤回（连同其后对话）', value: 'retract', icon: RotateCcw, danger: true })
  return acts
})

async function onMenuSelect(value: string): Promise<void> {
  const m = menuTarget.value
  menuTarget.value = null
  if (!m) return
  if (value === 'copy' && m.text) {
    const ok = await copyText(m.text)
    toast.toast(ok ? '已复制' : '复制失败')
  } else if (value === 'quote') {
    quote.value = m
  } else if (value === 'retract') {
    void ai.retract(m.id)
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="AI" compact>
      <template #lead>
        <button class="hdr-btn" aria-label="历史记录" @click="drawerOpen = true">
          <History :size="19" />
        </button>
      </template>
      <template #action>
        <button class="hdr-btn accent" aria-label="新建对话" @click="ai.newChat()">
          <Plus :size="17" :stroke-width="2.6" />
        </button>
        <ManageModelsButton />
      </template>
    </PageHeader>

    <!-- 消息流 -->
    <div ref="listEl" class="msgs">
      <div
        v-for="m in ai.messages"
        :key="m.id"
        class="msg"
        :class="[m.role]"
        @pointerdown="onPressStart($event, m)"
        @pointermove="onPressMove($event)"
        @pointerup="onPressEnd"
        @pointerleave="onPressEnd"
        @pointercancel="onPressEnd"
        @contextmenu.prevent="onCtxMenu($event, m)"
      >
        <div class="msg-col">
          <!-- 引用块 -->
          <p v-if="m.quoteText" class="qblock">{{ m.quoteText }}</p>

          <!-- 思考过程（LLM 回复折叠展示） -->
          <details v-if="m.thinking" class="think">
            <summary>思考过程</summary>
            <p class="think-body">{{ m.thinking }}</p>
          </details>

          <!-- 照片（可带随图文字，图与文分气泡，同属一条消息） -->
          <template v-if="m.kind === 'photo' && m.imageBase64">
            <div class="photo-bubble">
              <img :src="`data:${m.mime ?? 'image/jpeg'};base64,${m.imageBase64}`" alt="用户上传的照片">
            </div>
            <p v-if="m.text" class="bubble">{{ m.text }}</p>
          </template>

          <!-- 纯文本 -->
          <p v-else-if="m.kind === 'text'" class="bubble">{{ m.text }}</p>

          <!-- 食物解析卡（行内改重量 / 删行，未匹配项不会写入） -->
          <div v-else-if="m.kind === 'food-parse' && m.items" class="parse">
            <p class="parse-title">识别到 {{ m.items.length }} 项食物</p>
            <FoodParseEditor v-model="m.items" />

            <template v-if="!m.committed">
              <SegmentedControl
                class="meal"
                :model-value="mealByMsg[m.id] ?? suggestMeal()"
                :options="MEAL_ORDER.map((x) => ({ value: x, label: MEAL_LABELS[x] }))"
                @update:model-value="mealByMsg[m.id] = $event as MealType"
              />
              <div class="row actions between">
                <small class="t-3">确认后写入今日{{ MEAL_LABELS[mealByMsg[m.id] ?? suggestMeal()] }}</small>
                <button
                  class="commit"
                  :disabled="m.items.every((it) => it.foodId == null)"
                  @click="ai.commitParse(m.id, mealByMsg[m.id] ?? suggestMeal())"
                >
                  加入记录
                </button>
              </div>
            </template>
            <p v-else class="committed"><Check :size="14" /> 已写入今日饮食</p>
          </div>

          <!-- 分析卡 -->
          <div v-else-if="m.kind === 'analysis'" class="analysis">
            <p class="a-title row center"><ChartPie :size="15" /> 今日饮食分析</p>
            <p class="a-body">{{ m.text }}</p>
          </div>

          <!-- 工具调用过程卡 -->
          <div v-else-if="m.kind === 'tools' && m.toolCalls?.length" class="tools-card">
            <details :open="m.toolCalls.some((c) => c.status === 'running')">
              <summary><Wrench :size="13" /> 工具调用 · {{ m.toolCalls.length }}</summary>
              <ul class="tcalls">
                <li v-for="(c, i) in m.toolCalls" :key="i" class="tcall">
                  <div class="t-head">
                    <span class="t-label" :class="{ danger: isDangerous(c.name) }">{{ c.label }}</span>
                    <span v-if="c.argsBrief" class="t-args">{{ c.argsBrief }}</span>
                    <span class="t-state" :class="c.status">{{
                      c.status === 'running' ? '…' : c.status === 'ok' ? '✓' : '✕'
                    }}</span>
                  </div>
                  <p v-if="c.resultBrief && c.status === 'error'" class="t-result error">{{ c.resultBrief }}</p>
                </li>
              </ul>
            </details>
          </div>
        </div>
      </div>
    </div>

    <!-- 快捷操作 -->
    <div class="chips">
      <button class="chip" :disabled="ai.busy" @click="ai.analyzeToday()">分析今日饮食</button>
      <button class="chip" @click="openDrafts()">
        草稿箱{{ drafts.length > 0 ? ` · ${drafts.length}` : '' }}
      </button>
    </div>

    <!-- 引用条 -->
    <div v-if="quote" class="quote-bar row">
      <p class="q-text flex-1">引用：{{ quote.text ?? '[图片]' }}</p>
      <button class="q-x" aria-label="取消引用" @click="quote = null">
        <X :size="14" />
      </button>
    </div>

    <!-- 待发送附图芯片（选图后挂在这里，可移除，随下一条消息发出） -->
    <div v-if="attachment" class="attach-row">
      <div class="attach-chip">
        <img
          :src="`data:image/jpeg;base64,${attachment.small ?? attachment.full}`"
          alt="待发送图片"
        >
        <button class="attach-x" aria-label="移除图片" @click="attachment = null">
          <X :size="11" :stroke-width="3" />
        </button>
      </div>
    </div>

    <!-- 输入栏 -->
    <div class="inbar row">
      <button class="cam" aria-label="拍照记录" @click="fileEl?.click()">
        <Camera :size="19" />
      </button>
      <input
        v-model="draft"
        type="text"
        :placeholder="attachment ? '问问这张图，或直接记录饮食' : '吃了什么？例如：一个鸡蛋和一碗米饭'"
        @keydown.enter="send"
      >
      <button
        class="send"
        :class="{ ready: !!draft.trim() || !!attachment }"
        aria-label="发送"
        :disabled="ai.busy || (!draft.trim() && !attachment)"
        @click="send"
      >
        <SendHorizontal :size="18" />
      </button>
    </div>

    <input ref="fileEl" type="file" accept="image/*" hidden @change="onFile">

    <HistoryDrawer :open="drawerOpen" @close="drawerOpen = false" />

    <!-- 拍照直识别弹层（识别 → 编辑 → 写入 / 存草稿） -->
    <FoodParseSheet ref="foodSheet" @committed="refreshDrafts" @saved-draft="refreshDrafts" />

    <!-- 食物草稿箱 -->
    <SheetModal :open="draftsOpen" title="食物草稿箱" initial-snap="medium" @close="draftsOpen = false">
      <div v-if="drafts.length === 0" class="dempty">
        暂无草稿。拍照识别后点「存草稿箱」，稍后可以回来继续改重量再写入。
      </div>
      <ul v-else class="dlist">
        <li v-for="d in drafts" :key="d.id" class="drow" @click="editDraft(d)">
          <img
            v-if="d.thumbBase64"
            :src="`data:image/jpeg;base64,${d.thumbBase64}`"
            alt="草稿缩略图"
            class="dthumb"
          >
          <div v-else class="dthumb ph"><Camera :size="16" /></div>
          <div class="dinfo flex-1">
            <p class="dtitle">{{ d.items.map((it) => it.foodName).join('、') }}</p>
            <p class="dmeta">{{ fmtDraftTime(d.createdAt) }} · {{ d.items.length }} 项</p>
          </div>
          <button class="ddel" aria-label="删除草稿" @click.stop="deleteDraft(d.id)">
            <Trash2 :size="15" />
          </button>
        </li>
      </ul>
    </SheetModal>

    <!-- 长按/右键菜单 -->
    <AppMenu
      :open="menuTarget !== null"
      :actions="menuActions"
      :anchor="menuAnchor"
      @close="menuTarget = null"
      @select="onMenuSelect"
    />
  </div>
</template>

<style scoped>
.page {
  /* 可用高度 = 100dvh - safe-top（app-frame 的状态栏 padding-top）- 底栏总高（tabbar-h + safe-bottom）
     - wbar-reserve（悬浮运动条停靠 bottom 时写入的高度预留，无运动 / 其他槽位为 0）。
     少任何一项，输入栏都会被对应悬浮物盖住（真机手势导航 + 运动中最明显）。 */
  height: calc(
    100dvh - var(--safe-top) - var(--tabbar-h) - var(--safe-bottom) - var(--wbar-reserve, 0px)
  );
  display: flex;
  flex-direction: column;
  padding: 10px var(--page-pad-x) 10px;
}

/* 消息长按菜单：禁用原生文本选择避免冲突（复制走菜单） */
.msg {
  user-select: none;
  -webkit-user-select: none;
}

/* 引用块（气泡内） */
.qblock {
  max-width: 82%;
  padding: 6px 10px;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg.user .qblock {
  align-self: flex-end;
}

/* 引用条（输入栏上方） */
.quote-bar {
  gap: 8px;
  padding: 7px 10px;
  margin-bottom: 6px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.q-text {
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.q-x {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 照片气泡 */
.photo-bubble {
  max-width: 74%;
  border-radius: 20px;
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  display: flex;
}

.photo-bubble img {
  display: block;
  width: 100%;
  max-height: 220px;
  object-fit: cover;
}

.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px;
  scrollbar-width: none;
}

.msgs::-webkit-scrollbar {
  display: none;
}

.msg {
  margin-bottom: 10px;
  display: flex;
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

/* 文本消息容器（可带思考折叠框） */
.msg-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 82%;
}

.msg.user .msg-col {
  align-items: flex-end;
}

.msg.assistant .msg-col {
  align-items: flex-start;
}

.msg-col .bubble {
  max-width: 100%;
}

/* 思考过程折叠框 */
.think {
  background: var(--surface-2);
  border-radius: var(--radius-m);
  color: var(--text-2);
  font-size: var(--fs-caption);
  max-width: 100%;
}

.think summary {
  padding: 8px 12px;
  font-weight: 700;
  cursor: pointer;
  user-select: none;
}

.think-body {
  padding: 0 12px 8px;
  line-height: 1.55;
  white-space: pre-line;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: none;
}

/* 气泡 */
.bubble {
  max-width: 82%;
  padding: 9px 14px;
  border-radius: 20px;
  font-size: var(--fs-subhead);
  line-height: 1.5;
  white-space: pre-line;
}

.msg.user .bubble {
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 6px;
}

.msg.assistant .bubble {
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-bottom-left-radius: 6px;
}

/* 解析卡 */
.parse,
.analysis {
  width: 92%;
  max-width: 360px;
  background: var(--surface);
  box-shadow: var(--shadow-card);
  border-radius: var(--radius-l);
  border-bottom-left-radius: 6px;
  padding: 14px;
}

.parse-title {
  font-size: var(--fs-footnote);
  font-weight: 700;
  margin-bottom: 8px;
}

/* 食物草稿箱 */
.dempty {
  padding: 24px 8px;
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-footnote);
  line-height: 1.6;
}

.dlist {
  display: flex;
  flex-direction: column;
}

.drow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  cursor: pointer;
}

.drow + .drow {
  border-top: 0.5px solid var(--line);
}

.dthumb {
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: var(--radius-m);
  object-fit: cover;
  background: var(--surface-2);
}

.dthumb.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.dinfo {
  min-width: 0;
}

.dtitle {
  font-size: var(--fs-subhead);
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dmeta {
  margin-top: 1px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.ddel {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-3);
}

.ddel:active {
  background: var(--surface-2);
  color: var(--danger);
}

.meal {
  margin-top: 10px;
}

.actions {
  margin-top: 12px;
  align-items: flex-end;
}

.actions small {
  max-width: 55%;
  line-height: 1.4;
}

.commit {
  padding: 10px 18px;
  border-radius: var(--radius-full);
  background: var(--ok);
  color: #fff;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.committed {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--ok);
}

/* 分析卡 */
.a-title {
  gap: 6px;
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 6px;
}

.a-body {
  font-size: var(--fs-subhead);
  line-height: 1.6;
  white-space: pre-line;
}

/* 工具调用过程卡 */
.tools-card {
  width: 92%;
  max-width: 360px;
  background: var(--surface-2);
  border-radius: var(--radius-m);
  font-size: var(--fs-caption);
  overflow: hidden;
}

.tools-card summary {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 12px;
  font-weight: 700;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.tools-card summary::-webkit-details-marker {
  display: none;
}

.tcalls {
  padding: 0 12px 8px;
}

.tcall {
  padding: 6px 0;
}

.tcall + .tcall {
  border-top: 0.5px solid var(--line);
}

.t-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.t-label {
  flex: none;
  font-weight: 700;
}

.t-label.danger {
  color: var(--danger);
}

.t-args {
  flex: 1;
  min-width: 0;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.t-state {
  flex: none;
  font-weight: 800;
}

.t-state.ok {
  color: var(--ok);
}

.t-state.error {
  color: var(--danger);
}

.t-result.error {
  margin-top: 3px;
  color: var(--danger);
  line-height: 1.45;
  word-break: break-all;
}

/* 快捷与输入 */
.chips {
  display: flex;
  gap: 8px;
  padding: 2px 0 8px;
}

.chip {
  padding: 6px 13px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
}

.chip:disabled {
  opacity: 0.5;
}

/* 待发送附图芯片（Kimi 式：缩略图 + 右上角移除钮） */
.attach-row {
  display: flex;
  padding: 0 2px 8px;
}

.attach-chip {
  position: relative;
  width: 56px;
  height: 56px;
}

.attach-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 14px;
  background: var(--surface-2);
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

.inbar {
  gap: 8px;
  padding: 8px 8px 8px 6px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.cam {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-1);
}

.inbar input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.inbar input::placeholder {
  color: var(--text-3);
}

.send {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 有文字或附图时点亮（Kimi 式：灰 → 主色） */
.send.ready {
  background: var(--accent);
  color: #fff;
}

.send:disabled {
  opacity: 0.5;
}
</style>
