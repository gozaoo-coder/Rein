<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Camera, Check, ChartPie, Copy, FileText, Folder, FolderUp, History, Images, Mic, Plus, Quote, RotateCcw, SendHorizontal, Trash2, X } from 'lucide-vue-next'

import AppMenu, { type MenuItem } from '@/components/common/AppMenu.vue'
import HistoryDrawer from '@/components/ai/HistoryDrawer.vue'
import FoodParseSheet from '@/components/ai/FoodParseSheet.vue'
import ManageModelsButton from '@/components/ai/ManageModelsButton.vue'
import ProcessSection from '@/components/ai/ProcessSection.vue'
import MdText from '@/components/common/MdText.vue'
import ProgressiveBlur from '@/components/common/ProgressiveBlur.vue'
import MemoPickerSheet from '@/components/voice/MemoPickerSheet.vue'
import { openMemoById } from '@/system/voiceRuntime'
import FoodParseEditor from '@/components/diet/FoodParseEditor.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { MEAL_LABELS, MEAL_ORDER, suggestMeal } from '@/config/domain'
import { useToast } from '@/composables/useToast'
import { useAiStore } from '@/stores/ai'
import { useModelsStore } from '@/stores/models'
import { copyText } from '@/utils/clipboard'
import { listFoodDrafts, removeFoodDraft, type FoodDraft } from '@/utils/foodDrafts'
import { bitmapToJpeg, decodeBitmap, DEFAULT_IMAGE_EDGE } from '@/utils/image'
import { officeKindOf, parseOffice, parseTextFile, type ParsedDoc } from '@/utils/documentParse'
import { perfDegraded } from '@/system/perf'
import { shareInbox } from '@/system/shareInbox'
import type { SendImage } from '@/stores/ai'
import type { VoiceMemo } from '@/types'
import { fmtDateCn, toDateStr } from '@/utils/date'
import type { AiMessage, AiDocMeta, MealType } from '@/types'

/** AI 页：拍照直识别（可编辑卡片 + 草稿箱）/ 文字记饮食 / 数据工具对话。 */
const ai = useAiStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

/** 该消息的气泡元数据（推理过程段 / 思考计时 / 是否被吸收） */
function metaOf(m: AiMessage): ReturnType<typeof ai.getMeta> {
  return ai.getMeta(m.id)
}

/** 正文气泡是否有东西可渲染：有正文，或流式中且还没有过程区（此时显示打字点）。
 *  流式占位气泡在推理/工具阶段是空 text——内容全在 ProcessSection 里，气泡本体不该出现：
 *  它的 padding/底色/阴影会渲染成一个什么都没有的「空气泡」，挂在过程区上方。 */
function showTextBubble(m: AiMessage): boolean {
  if (m.kind !== 'text') return false
  if (m.text) return true
  return !!m.streaming && !metaOf(m)?.segments.length
}

/** 整条消息是否有东西可渲染。挡掉空壳（连带省掉它的 10px 间距）：
 *  流式占位气泡在正文到达前是空 text，历史恢复时被吸收的消息只剩 id/kind 空壳。 */
function showMsg(m: AiMessage): boolean {
  const meta = metaOf(m)
  if (meta?.absorbed) return false
  if (meta?.segments.length) return true
  if (m.quoteText) return true
  switch (m.kind) {
    case 'text':
      return showTextBubble(m)
    case 'photo':
      // 与模板分支同条件：没有图就没有可渲染的部分（纯文字的照片消息按空壳处理）
      return !!(m.imageBase64 || m.images?.length)
    case 'doc':
      return !!m.doc
    case 'food-parse':
      return !!m.items
    // 纯过程载体：内容就是上面的 segments，没有过程段时自己没有可渲染的部分
    case 'tools':
      return false
    default:
      return true
  }
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
const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileEl = ref<HTMLInputElement | null>(null)
const galleryEl = ref<HTMLInputElement | null>(null)
const cameraEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/* ---------- 「+」添加菜单（bind 式：锚定按钮弹出，带图标） ---------- */

const camMenuOpen = ref(false)
/** 锚定元素：输入栏左侧的 + 按钮 */
const camBtn = ref<HTMLElement | null>(null)

/** 附图上限：超过后提示，防止消息体撑爆模型上下文 */
const MAX_ATTACHMENTS = 9

/** 发送视图最长边：按视觉模型的配置（imageMaxEdge），未配置用默认值。
 * 视图同时是放大镜的坐标空间与跨重启的精度上限，尽量贴近模型输入分辨率。 */
function imageEdgeCap(): number {
  return useModelsStore().bestVisionModel()?.imageMaxEdge ?? DEFAULT_IMAGE_EDGE
}

/** 添加菜单选项：拍照走系统相机（capture 属性），图库可多选，文件支持图片/Office/文本 */
const camActions: MenuItem[] = [
  { label: '拍照（系统相机）', value: 'camera', icon: Camera },
  { label: '从图库选择', value: 'gallery', icon: Images },
  { label: '上传文件', value: 'file', icon: FolderUp },
]

function openCamMenu(): void {
  camMenuOpen.value = true
}

function onCamSelect(value: string): void {
  if (value === 'camera') cameraEl.value?.click()
  else if (value === 'gallery') galleryEl.value?.click()
  else fileEl.value?.click()
}

/** 待发送附图：选图后先挂输入框上方（可移除/配文字），随下一条消息一起发出。
    数组化以支持「连拍几张 + 图库多选」一起发（相机每次拍一张，可累积）。 */
interface AttImage {
  full: string
  small: string | null
  w: number
  h: number
  source: File
}
const attachments = ref<AttImage[]>([])
/** 待发送 Office 文档：解析结果 + 勾选要发给 AI 的内嵌图（可多选，随消息一起发出） */
const docAtt = ref<{
  file: File
  doc: ParsedDoc
  /** 各图片的发送视图（≤模型图片上限的 JPEG） */
  views: Map<string, { base64: string; w: number; h: number }>
  selected: Set<string>
} | null>(null)

function toggleDocImage(id: string): void {
  const d = docAtt.value
  if (!d) return
  const next = new Set(d.selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  docAtt.value = { ...d, selected: next }
}

/** 消息图片列表（photo 单图/多图、doc 多图统一） */
function msgImages(m: AiMessage): { base64: string; mime: string }[] {
  if (m.images?.length) return m.images.map((im) => ({ base64: im.base64, mime: im.mime }))
  return m.imageBase64 ? [{ base64: m.imageBase64, mime: m.mime ?? 'image/jpeg' }] : []
}

/** 每张解析卡选择的目标餐次，默认按当前时间推荐 */
const mealByMsg = reactive<Record<string, MealType>>({})

/** 历史抽屉 / 长按菜单 / 引用 */
const drawerOpen = ref(false)
const menuTarget = ref<AiMessage | null>(null)
/** 长按菜单锚定元素：被长按的那条消息气泡 */
const menuAnchor = ref<HTMLElement | null>(null)
const quote = ref<AiMessage | null>(null)

/* ---------- @纪要引用（输入 @ 弹出选择器，发送时注入纪要总结与逐句转写） ---------- */
const memoPickerOpen = ref(false)
const memoRefs = ref<VoiceMemo[]>([])

watch(
  () => draft.value,
  (v) => {
    if (v.endsWith('@')) memoPickerOpen.value = true
  },
)

function onPickMemo(m: VoiceMemo): void {
  memoPickerOpen.value = false
  if (memoRefs.value.some((x) => x.id === m.id)) return
  memoRefs.value = [...memoRefs.value, m]
  draft.value = draft.value.slice(0, -1) // 去掉触发的 @
  void nextTick(() => autoGrow())
}

function removeMemoRef(id: string): void {
  memoRefs.value = memoRefs.value.filter((m) => m.id !== id)
}

onMounted(() => {
  void ai.init()
  // 选图压图时要用视觉模型的 imageMaxEdge，提前加载模型配置
  void useModelsStore().load().catch(() => undefined)
  refreshDrafts()
  void scrollToBottom()
  if (route.query.intent === 'photo') openCamMenu()
  // 抢课面板「交给 AI 排查」递过来的现场：**直接发**，不再让人按一次发送 ——
  // 那正是抢课窗口里最缺时间的时候。取完即清，回到本页不会重复发。
  const handed = ai.takePendingPrompt()
  if (handed) {
    // 正在生成时不能直接发（sendText 会直接返回，那段现场就没了）：落到输入框里等着，
    // 比默默丢掉强 —— 人至少看得见「有话没发出去」。
    if (ai.busy) {
      draft.value = handed
      void nextTick(() => autoGrow())
    } else {
      void ai.sendText(handed)
    }
  }
})

// 分享收件箱：路由带 ?intent=share 时消费预填（冷启动 / 运行中被分享唤起都会走到这里）
watch(
  () => route.query.intent,
  (v) => {
    if (v === 'share') void consumeShare()
  },
  { immediate: true },
)

/* 其他页（桌面信息栏「问点什么」）带来的问题：预填进输入框并清掉 URL 参数 */
watch(
  () => route.query.ask,
  (v) => {
    if (typeof v === 'string' && v) {
      draft.value = v
      void router.replace({ query: { ...route.query, ask: undefined } })
      void nextTick(() => autoGrow())
    }
  },
  { immediate: true },
)

watch(
  () => ai.messages.length,
  () => void scrollToBottom(),
)

// 流式输出：过程段/思考/工具任一事件后跟随滚动（等价 EffiBuddy 的事件级 scrollBottom）
watch(
  () => ai.streamSeq,
  () => void scrollToBottom(),
)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
}

/** 文本域自适应高度：随内容增高，上限 5 行，发送后复位 */
function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = '0'
  const max = 5 * 22 // 5 行 × line-height 约 22px
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
}

/** 文本是否疑似 Markdown（含至少两种语法特征） */
function looksLikeMarkdown(text: string): boolean {
  let hits = 0
  if (/^#{1,6}\s/m.test(text)) hits++
  if (/^\s*[-*•]\s/m.test(text)) hits++
  if (/^\s*\d+\.\s/m.test(text)) hits++
  if (/\*\*[^*]+\*\*/.test(text)) hits++
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) hits++
  if (/```/.test(text)) hits++
  if (/^\s*>\s/m.test(text)) hits++
  if (/\|.*\|/.test(text)) hits++
  return hits >= 2
}

function fmtVoiceDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`
}

function send(): void {
  if (ai.busy) return
  let t = draft.value.trim()
  const doc = docAtt.value
  if (!t && attachments.value.length === 0 && !doc) return
  // 粘贴/输入的文本疑似 Markdown 时，告知模型按 Markdown 理解
  if (t && looksLikeMarkdown(t)) {
    t = `（以下内容为 Markdown 格式）\n${t}`
  }
  draft.value = ''
  // 复位输入框高度
  if (inputEl.value) inputEl.value.style.height = ''
  const atts = attachments.value
  attachments.value = []
  docAtt.value = null
  const q = quote.value
  quote.value = null
  // 组装待发送图片：附图（原图高分辨率保留给放大镜）+ 文档勾选的内嵌图
  const images: SendImage[] = atts.map((a, i) => ({
    base64: a.full,
    mime: 'image/jpeg',
    w: a.w,
    h: a.h,
    label: atts.length > 1 ? `附图 ${i + 1}` : '附图',
    source: a.source,
  }))
  let docMeta: AiDocMeta | undefined
  if (doc) {
    for (const im of doc.doc.images) {
      if (!doc.selected.has(im.id)) continue
      const v = doc.views.get(im.id)
      if (v) {
        images.push({
          base64: v.base64,
          mime: 'image/jpeg',
          w: v.w,
          h: v.h,
          label: `文档《${doc.file.name}》${im.where}`,
          source: new Blob([im.bytes as BlobPart], { type: im.mime }),
        })
      }
    }
    docMeta = {
      name: doc.file.name,
      kind: doc.doc.kind,
      text: doc.doc.text,
      fullText: doc.doc.fullText,
      chars: doc.doc.chars,
      truncated: doc.doc.truncated,
      imagesTotal: doc.doc.images.length,
      skippedImages: doc.doc.skippedImages,
    }
  }
  const refs = memoRefs.value
  memoRefs.value = []
  void ai.sendText(t, { quoteText: q?.text, images: images.length > 0 ? images : undefined, doc: docMeta, memoRefs: refs })
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  await prepareFile(file)
}

/** 图库多选：逐张压入附图列表 */
async function onGallery(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const f of files) await prepareFile(f, f.type || 'image/*')
}

/** 系统相机拍摄：每次拍一张并累积，可连续点菜单多拍几张 */
async function onCamera(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  const before = attachments.value.length
  await prepareFile(file, file.type || 'image/*')
  if (attachments.value.length > before) {
    toast.toast(attachments.value.length > 1 ? `已添加第 ${attachments.value.length} 张，可继续拍摄` : '已添加，可继续拍摄或直接发送')
  }
}

/** 统一文件预填：Office/文本 → 文档芯片（解析+图片勾选）；图片 → 附图芯片（可多张累积） */
async function prepareFile(file: File, mimeHint?: string): Promise<void> {
  const mime = mimeHint || file.type || ''
  const kind = officeKindOf(file.name)
  try {
    if (kind === 'text' || (!kind && (mime.startsWith('text/') || /\.(md|txt|markdown|csv)$/i.test(file.name)))) {
      const doc = await parseTextFile(file)
      attachDoc(file, doc)
      return
    }
    if (kind) {
      const doc = await parseOffice(file, file.name)
      attachDoc(file, doc)
      return
    }
    if (mime.startsWith('image/')) {
      if (attachments.value.length >= MAX_ATTACHMENTS) {
        toast.toast(`附图最多 ${MAX_ATTACHMENTS} 张`)
        return
      }
      // 压出发送视图（≤模型上限，坐标空间）与缩略图；原始文件保留给放大镜
      const bm = await decodeBitmap(file)
      const [view, small] = await Promise.all([
        bitmapToJpeg(bm, imageEdgeCap(), 0.85),
        bitmapToJpeg(bm, 240, 0.6).catch(() => null),
      ])
      attachments.value = [...attachments.value, { full: view.base64, small: small?.base64 ?? null, w: view.width, h: view.height, source: file }]
      bm.close()
      return
    }
    toast.toast('不支持的文件类型，仅支持图片 / 文本 / Markdown / Office 文档')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 解析完成 → 挂文档芯片（默认勾选前 3 张内嵌图） */
async function attachDoc(file: File, doc: ParsedDoc): Promise<void> {
  const cap = imageEdgeCap()
  const views = new Map<string, { base64: string; w: number; h: number }>()
  for (const im of doc.images) {
    const blob = new Blob([im.bytes as BlobPart], { type: im.mime })
    const bm = await decodeBitmap(blob)
    const r = await bitmapToJpeg(bm, cap)
    views.set(im.id, { base64: r.base64, w: r.width, h: r.height })
    bm.close()
  }
  docAtt.value = {
    file,
    doc,
    views,
    selected: new Set(doc.images.slice(0, 3).map((im) => im.id)),
  }
}

/** 消费分享收件箱预填（系统分享/打开的文件，见 system/shareInbox） */
async function consumeShare(): Promise<void> {
  const p = shareInbox.takePending()
  if (!p) return
  const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))
  const file = new File([bytes], p.name, { type: p.mime })
  await prepareFile(file, p.mime)
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
    <!-- 消息区是唯一的滚动容器：页头与底栏都粘在它内部（sticky），内容从两端的
         渐进模糊里滚过，而不是被两条硬边裁断（遮罩见 ProgressiveBlur/PageHeader）。 -->
    <div ref="listEl" class="msgs">
      <PageHeader title="AI" compact>
        <template #lead>
          <button class="hdr-btn" aria-label="文件" @click="router.push({ name: 'ai-files' })">
            <Folder :size="18" />
          </button>
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

      <!-- 超范围平移层：页面级滚动区走 item 超伸 —— 吸顶页头与底栏都留在层外，
           超伸时只有消息位移（system/rubberScroll） -->
      <div class="rubber-layer" data-rubber-content>
        <template v-for="m in ai.messages" :key="m.id">
          <div
            v-if="showMsg(m)"
            :id="`msg-${m.id}`"
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
              <!-- 推理过程 + 工具调用合并区块：单行摘要标题，进行中展开、完成后自动折叠 -->
              <ProcessSection
                v-if="metaOf(m)?.segments.length"
                :segments="metaOf(m)?.segments ?? []"
                :is-thinking="metaOf(m)?.isThinking ?? false"
                :thinking-sec="metaOf(m)?.thinkingSec ?? 0"
                :final="m.id !== ai.streamingBubbleId"
              />

              <!-- 引用块 -->
              <p v-if="m.quoteText" class="qblock">{{ m.quoteText }}</p>

              <!-- 照片（可多图；可带随图文字，图与文分气泡，同属一条消息） -->
              <template v-if="m.kind === 'photo' && (m.imageBase64 || m.images?.length)">
                <div class="photo-bubble" :class="{ multi: (m.images?.length ?? 0) > 1 }">
                  <img
                    v-for="(im, i) in msgImages(m)"
                    :key="i"
                    :src="`data:${im.mime};base64,${im.base64}`"
                    alt="用户上传的照片"
                  >
                </div>
                <p v-if="m.text" class="bubble">{{ m.text }}</p>
              </template>

              <!-- 文档消息（解析文本随消息发给模型，气泡展示卡片与勾选的内嵌图） -->
              <template v-else-if="m.kind === 'doc' && m.doc">
                <div class="doc-card">
                  <FileText :size="16" />
                  <div class="dc-info">
                    <p class="dc-name">{{ m.doc.name }}</p>
                    <p class="dc-meta">
                      {{ m.doc.chars }} 字{{ m.doc.truncated ? '（已截断）' : '' }} · 图片 {{ m.doc.imagesTotal }} 张{{
                        m.doc.skippedImages > 0 ? `（跳过 ${m.doc.skippedImages} 张不支持/装饰图）` : ''
                      }}
                    </p>
                  </div>
                </div>
                <div v-if="m.images?.length" class="photo-bubble multi">
                  <img
                    v-for="(im, i) in m.images"
                    :key="i"
                    :src="`data:image/jpeg;base64,${im.base64}`"
                    alt="文档内嵌图片"
                  >
                </div>
                <p v-if="m.text" class="bubble">{{ m.text }}</p>
              </template>

              <!-- 纯文本（Markdown 渲染，流式按块增量；正文还没到就显示打字点）。
                   showTextBubble 已挡掉「有过程区但没正文」的空壳——那正是空气泡的来源 -->
              <div v-else-if="showTextBubble(m)" class="bubble">
                <MdText v-if="m.text" :text="m.text" :streaming="m.streaming" />
                <span v-if="m.text && m.streaming" class="caret" aria-hidden="true" />
                <span v-else-if="!m.text" class="tdots" aria-hidden="true"><i /><i /><i /></span>
              </div>

              <!-- 语音轮（转写 + 关联纪要，点开语音会话回看/重放） -->
              <button v-else-if="m.kind === 'voice'" class="voice-bub" @click="m.voiceMeta && openMemoById(m.voiceMeta.memoId)">
                <span class="vb-head"><Mic :size="13" /> 语音{{ m.voiceMeta ? ` ${fmtVoiceDur(m.voiceMeta.durationMs)}` : '' }} · 会议纪要</span>
                <span class="vb-txt">{{ (m.text ?? '').slice(0, 72) }}{{ (m.text ?? '').length > 72 ? '…' : '' }}</span>
                <span class="vb-go">查看纪要 ›</span>
              </button>

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
            </div>
          </div>
        </template>
      </div>

      <!-- 底栏（快捷操作 → 引用 → 纪要 → 附图 → 输入栏）：与页头同理粘在滚动区底部，
           内容从底部的渐进模糊里滚过；输入栏是浮起的圆角胶囊，胶囊之间能看到糊住的正文。
           margin-top:auto 保证消息不足一屏时它依然落在底部，而不是吊在最后一条下面。 -->
      <div class="composer">
        <div class="cb-mask" aria-hidden="true">
          <!-- 切档（v-if）时由 ProgressiveBlur 自己从透明淡入：淡入不能挂在容器或
               组件根上——容器 opacity<1 就成 backdrop root，模糊在过渡期间不渲染 -->
          <ProgressiveBlur v-if="!perfDegraded" direction="up" />
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

        <!-- @纪要 chips（发送时注入纪要内容） -->
        <div v-if="memoRefs.length > 0" class="memo-refs">
          <span v-for="m in memoRefs" :key="m.id" class="memo-chip">
            @ {{ m.title }}<button class="mx" aria-label="移除纪要引用" @click="removeMemoRef(m.id)"><X :size="10" :stroke-width="3" /></button>
          </span>
        </div>

        <!-- 待发送附图芯片（可多张累积：相机连拍 + 图库多选，随下一条消息发出） -->
        <div v-if="attachments.length > 0" class="attach-row">
          <div v-for="(a, i) in attachments" :key="i" class="attach-chip">
            <img
              :src="`data:image/jpeg;base64,${a.small ?? a.full}`"
              alt="待发送图片"
            >
            <button class="attach-x" aria-label="移除图片" @click="attachments = attachments.filter((_, j) => j !== i)">
              <X :size="11" :stroke-width="3" />
            </button>
          </div>
        </div>

        <!-- 待发送文档芯片（解析结果 + 内嵌图勾选，随下一条消息发出） -->
        <div v-if="docAtt" class="attach-row doc-attach">
          <div class="doc-chip">
            <FileText :size="18" />
            <div class="dc-info">
              <p class="dc-name">{{ docAtt.file.name }}</p>
              <p class="dc-meta">
                {{ docAtt.doc.chars }} 字{{ docAtt.doc.truncated ? '（已截断）' : '' }} · 图片
                {{ docAtt.doc.images.length }} 张{{ docAtt.doc.skippedImages > 0 ? `（跳过 ${docAtt.doc.skippedImages}）` : '' }}
              </p>
            </div>
            <button class="attach-x" aria-label="移除文档" @click="docAtt = null">
              <X :size="11" :stroke-width="3" />
            </button>
          </div>
          <div v-if="docAtt.doc.images.length > 0" class="doc-imgs">
            <button
              v-for="im in docAtt.doc.images"
              :key="im.id"
              class="doc-img"
              :class="{ on: docAtt.selected.has(im.id) }"
              :aria-label="`${docAtt.selected.has(im.id) ? '取消发送' : '发送'}${im.where}的图片`"
              @click="toggleDocImage(im.id)"
            >
              <img :src="`data:image/jpeg;base64,${docAtt.views.get(im.id)?.base64 ?? ''}`" alt="文档内嵌图片">
              <small>{{ im.where }}</small>
              <span v-if="docAtt.selected.has(im.id)" class="doc-check"><Check :size="11" :stroke-width="3" /></span>
            </button>
          </div>
          <p class="doc-hint">点选要发给 AI 的图片（已默认选前 3 张）；发出后可让 AI 放大查看细节。</p>
        </div>

        <!-- 输入栏 -->
        <div class="inbar row">
          <button ref="camBtn" class="cam" aria-label="添加附件" @click="openCamMenu">
            <Plus :size="21" :stroke-width="2.4" />
          </button>
          <textarea
            ref="inputEl"
            v-model="draft"
            rows="1"
            :placeholder="docAtt ? '问问这份文档，或让 AI 放大看图' : attachments.length > 1 ? `问问这 ${attachments.length} 张图，或直接记录饮食` : attachments.length === 1 ? '问问这张图，或直接记录饮食' : '吃了什么？例如：一个鸡蛋和一碗米饭'"
            @keydown.enter.exact.prevent="send"
            @input="autoGrow"
          />
          <button
            class="send"
            :class="{ ready: !!draft.trim() || attachments.length > 0 || !!docAtt || memoRefs.length > 0 }"
            aria-label="发送"
            :disabled="ai.busy || (!draft.trim() && attachments.length === 0 && !docAtt && memoRefs.length === 0)"
            @click="send"
          >
            <SendHorizontal :size="18" />
          </button>
        </div>
      </div>
    </div>

    <!-- 三个隐藏入口：系统相机 / 图库多选 / 文件（图片+Office+文本/Markdown） -->
    <input ref="fileEl" type="file" accept="image/*,.docx,.pptx,.xlsx,.md,.markdown,.txt,.csv" hidden @change="onFile">
    <input ref="galleryEl" type="file" accept="image/*" multiple hidden @change="onGallery">
    <input ref="cameraEl" type="file" accept="image/*" capture="environment" hidden @change="onCamera">

    <!-- 「+」添加菜单（bind 式锚定弹出：拍照 / 图库 / 上传文件） -->
    <AppMenu
      :open="camMenuOpen"
      :actions="camActions"
      :anchor="camBtn"
      title="添加内容"
      @close="camMenuOpen = false"
      @select="onCamSelect"
    />

    <HistoryDrawer :open="drawerOpen" @close="drawerOpen = false" />
    <MemoPickerSheet :open="memoPickerOpen" @close="memoPickerOpen = false" @pick="onPickMemo" />

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
  /* 整帧：页面盒恒为 100dvh × 100vw，安全区不从高度里扣。
     顶部让开交给消息区的 padding-top（页头因此落在安全区之下，与其余页面同观感），
     底部让开交给 padding-bottom（输入栏胶囊的底边正好落在 Dock 顶）。
     从前这里是 height: calc(100dvh - safe-top - tabbar-h - safe-bottom - wbar-reserve)：
     高度一缩，页头与底栏就被挤进「视口减安全区」的盒子里，表现自然与别处不同 ——
     挪进内边距后，盒子的尺寸只由视口决定，安全区成了各自的内边距，两者不再互相污染。 */
  height: 100dvh;
  /* 抵掉 .app-frame 的 padding-top（那一层是给整页滚动的内容让开状态栏的）；
     页面自己要占满整帧，安全区由页头与底栏各自让开 */
  margin-top: calc(-1 * var(--safe-top));
  display: flex;
  flex-direction: column;
  /* 输入栏自身的下内边距（给胶囊的投影在滚动区里留一点余地）。
     底部让开 = Dock 顶 − 它，输入栏底边才正好压在 Dock 顶上
     （间距不变量：AI 输入栏底→底栏顶 = 0，见 scripts/e2e-layout-guard.mjs）。
     悬浮运动条停靠在底部时写入的 --wbar-reserve 一并计进来。 */
  --inbar-pad-b: 4px;
  padding: 0 var(--page-pad-x) calc(var(--dock-top) - var(--inbar-pad-b) + var(--wbar-reserve, 0px));
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

/* 多图：两列网格 */
.photo-bubble.multi {
  flex-wrap: wrap;
  gap: 2px;
}

.photo-bubble.multi img {
  width: calc(50% - 1px);
  max-height: 150px;
}

/* 文档消息卡（用户发过的文档） */
.doc-card {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 86%;
  padding: 9px 12px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
}

.dc-info {
  min-width: 0;
}

.dc-name {
  font-weight: 500;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-meta {
  font-size: 11px;
  color: var(--text-3);
}

/* 消息滚动区。
   负外边距把滚动区拉成整帧宽（镜像 .page 的横向内边距），再用同值内边距把内容推回去：
   滚动容器按 CSS 规范会裁掉溢出——只要有一个轴不是 visible，另一个轴也会变成 auto——
   于是气泡的 --shadow-card（12px 偏移 + 32/80px 模糊）被自己的滚动区硬切出直边。
   留出这段横向余量，影子才有地方扩散；气泡内容宽度与之前一致。
   flex 列：页头与底栏都是它的子项（sticky），内容从两者之间滚过；底部内边距挪给底栏自理。 */
.msgs {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin: 0 calc(-1 * var(--page-pad-x));
  overflow-y: auto;
  padding: 0 var(--page-pad-x);
  scrollbar-width: none;
}

/* 页头自己让开状态栏：margin-top = 安全区高度（其余页面由 .app-frame 的 padding-top 给同一段），
   粘滞位保持 PageHeader 默认的 --safe-top，滚动后正好压在状态栏下缘、遮罩起点落在 0。
   别改成给滚动容器加 padding-top：sticky 的粘滞位会**叠加**在容器的上内边距之上 ——
   实测 `.msgs` padding-top:52 + --ph-stick:42 时页头落在 94（而不是 52），
   页头被顶下去一整段，遮罩起点也跟着错位，越调越乱。 */
.msgs :deep(.page-header) {
  margin-top: var(--safe-top);
}

/* 底栏：粘在滚动区底部，内容从底部的渐进模糊里滚过。
   自身建立层叠上下文，遮罩才能用 -1 沉到糖果条与输入栏背后。 */
.composer {
  position: sticky;
  bottom: 0;
  z-index: 30;
  /* margin-top:auto：消息不足一屏时底栏依然落在底部，而不是吊在最后一条下面；
     左右负外边距把底栏拉到整帧宽，遮罩才铺得满 */
  margin: auto calc(-1 * var(--page-pad-x)) 0;
  padding: 6px var(--page-pad-x) var(--inbar-pad-b);
}

/* 向上多铺一段：内容从模糊里滚出来，而不是在输入栏上沿被硬切 */
.cb-mask {
  position: absolute;
  top: -18px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: -1;
  pointer-events: none;
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

/* 流式打字光标与打字点（仅流式占位气泡） */
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.12em;
  background: var(--text-2);
  animation: caret-blink 1s steps(2, start) infinite;
}

@keyframes caret-blink {
  50% { opacity: 0; }
}

.tdots {
  display: inline-flex;
  gap: 4px;
  padding: 2px 0;
}

.tdots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-3);
  animation: tdots-pulse 1.2s ease-in-out infinite;
}

.tdots i:nth-child(2) { animation-delay: 0.15s; }
.tdots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes tdots-pulse {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

@media (prefers-reduced-motion: reduce) {
  .caret,
  .tdots i {
    animation: none;
  }
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

/* 待发送附图芯片（Kimi 式：缩略图 + 右上角移除钮，多张自动换行） */
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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

/* 待发送文档芯片（文档卡 + 内嵌图勾选网格） */
.doc-attach {
  flex-direction: column;
  gap: 8px;
}

.doc-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
  color: var(--text-1);
  width: 100%;
}

.doc-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.doc-img {
  position: relative;
  width: 72px;
  border-radius: var(--radius-s);
  overflow: hidden;
  background: var(--surface-2);
  padding: 0;
}

.doc-img img {
  display: block;
  width: 100%;
  height: 56px;
  object-fit: cover;
  opacity: 0.45;
}

.doc-img small {
  display: block;
  font-size: 10px;
  color: var(--text-2);
  text-align: center;
  padding: 2px 0 3px;
}

.doc-img.on img {
  opacity: 1;
}

.doc-img.on small {
  color: var(--text-1);
}

.doc-check {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-card);
}

.doc-hint {
  font-size: 11px;
  color: var(--text-3);
}

/* 语音轮气泡（用户侧，点开语音会话回看纪要/重放） */
.voice-bub {
  max-width: 82%;
  padding: 9px 13px;
  border-radius: 16px;
  border-bottom-right-radius: 6px;
  background: var(--accent);
  color: #fff;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-bub .vb-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 800;
  opacity: 0.92;
}

.voice-bub .vb-txt {
  font-size: var(--fs-subhead);
  line-height: 1.5;
}

.voice-bub .vb-go {
  font-size: 11px;
  font-weight: 700;
  opacity: 0.8;
}

/* @纪要引用 chips */
.memo-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 2px 8px;
}

.memo-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 700;
  max-width: 70%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.memo-chip .mx {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(0, 122, 255, 0.18);
}

/* 气泡内 Markdown（MdText 渲染的内容不带 pre-line，由块级元素控制行距） */
.bubble :deep(.md) {
  font-size: inherit;
  line-height: inherit;
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

.inbar textarea {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
  font-family: inherit;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  line-height: 22px;
  padding: 9px 0;
  max-height: 110px; /* 5 行 × 22px */
  overflow-y: auto;
  scrollbar-width: none;
}

.inbar textarea::-webkit-scrollbar {
  display: none;
}

.inbar textarea::placeholder {
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
