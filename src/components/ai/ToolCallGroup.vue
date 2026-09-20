<script setup lang="ts">
/**
 * ToolCallGroup 工具调用提示组（照搬 EffiBuddy 同名组件）
 *
 * 用于展示 LLM 连续调用多个工具的过程：
 * - 多条工具调用默认折叠为一个组，标题"使用了 N 个工具"
 * - 展开后每条 tool call 占 38px 高度，显示工具名、参数摘要、状态
 * - 点击某条 tool call → 行内展开完整参数与返回结果
 *
 * 设计要点：
 * - 连续 tools 折叠显示，避免占用过多纵向空间
 * - 详情行内展开（accordion），保持消息流上下文连续
 * - Rein 扩展：resultImage（放大镜结果图）在详情内展示
 */
import { ref, computed, watch, nextTick } from 'vue'
import { animate } from 'animejs'
import {
  Activity, Brain, Calendar, ChevronDown, ChevronRight, FolderSearch,
  Globe, List, ListTodo, Plus, Search, Settings, Wallet, Wrench, ZoomIn,
} from 'lucide-vue-next'
import type { ProcessToolCall } from '@/types'

const props = withDefaults(
  defineProps<{
    /** 工具调用记录列表（按时间顺序） */
    calls: ProcessToolCall[]
    /** 嵌入模式：去掉卡片外观与自带组标题，由外层(如 ProcessSection)统一控制折叠 */
    embedded?: boolean
    /** 结果预览模式：每条工具调用下方直接显示执行结果摘要（供穿插在思考文字间展示） */
    showResult?: boolean
  }>(),
  {
    embedded: false,
    showResult: false,
  },
)

// 整组是否折叠：多条默认折叠，单条默认展开
const groupCollapsed = ref(props.calls.length > 1)
// 当列表长度变化时，若是首次新增（从 0 → 1），保持展开
watch(
  () => props.calls.length,
  (n, old) => {
    if (old === 0 && n === 1) groupCollapsed.value = false
  },
)

const groupBodyRef = ref<HTMLElement | null>(null)

// 当前选中查看详情的 tool call
const selectedCallId = ref<string | null>(null)

function toggleDetail(callId: string): void {
  selectedCallId.value = selectedCallId.value === callId ? null : callId
}

// 键盘可达：Enter / Space 触发展开/折叠（与点击等价，不改变交互模型）
function handleKeydown(e: KeyboardEvent, fn: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fn()
  }
}

// 整组展开/折叠切换
function toggleGroup(): void {
  if (groupCollapsed.value) expandGroup()
  else collapseGroup()
}

function expandGroup(): void {
  groupCollapsed.value = false
  nextTick(() => {
    const el = groupBodyRef.value
    if (!el) return
    const targetH = el.scrollHeight
    animate(el, {
      maxHeight: ['0px', `${targetH}px`],
      opacity: [0, 1],
      duration: 280,
      ease: 'out(3)',
      onComplete: () => {
        // 释放显式 maxHeight，让后续新增 tool 项可自然撑高并触发动画
        el.style.maxHeight = ''
      },
    })
  })
}

function collapseGroup(): void {
  const el = groupBodyRef.value
  if (el) {
    animate(el, {
      maxHeight: [`${el.scrollHeight}px`, '0px'],
      opacity: [1, 0],
      duration: 220,
      ease: 'inOut(2)',
      onComplete: () => {
        groupCollapsed.value = true
        el.style.maxHeight = ''
      },
    })
  } else {
    groupCollapsed.value = true
  }
}

// 监听 calls 长度变化：新增 tool 项时，对 group-body 高度变化做 anime.js 动画
// 用 flush:'pre' 在 DOM 更新前捕获旧高度并锁定，nextTick 后测量新自然高度并动画过渡
watch(
  () => props.calls.length,
  (n, old) => {
    if (n <= old) return
    if (groupCollapsed.value) return // 折叠状态下不可见，无需动画
    const el = groupBodyRef.value
    if (!el) return
    // DOM 更新前：当前渲染高度即为旧高度，锁住防止更新时跳变
    const oldHeight = el.offsetHeight
    el.style.maxHeight = oldHeight + 'px'
    nextTick(() => {
      void el.offsetHeight // 强制 reflow，确保 scrollHeight 反映新 DOM
      const newHeight = el.scrollHeight
      if (Math.abs(newHeight - oldHeight) < 1) {
        el.style.maxHeight = ''
        return
      }
      animate(el, {
        maxHeight: [oldHeight + 'px', newHeight + 'px'],
        duration: 220,
        ease: 'out(3)',
        onComplete: () => {
          el.style.maxHeight = ''
        },
      })
    })
  },
  { flush: 'pre' },
)

// 工具图标：根据工具名映射（Rein 工具注册表）
const toolIcons = {
  Activity, Brain, Calendar, FolderSearch, Globe, ZoomIn, List,
  ListTodo, Plus, Search, Settings, Wallet, Wrench,
} as const

function toolIcon(name: string): unknown {
  const map: Record<string, unknown> = {
    search_food: toolIcons.Search,
    create_food: toolIcons.Plus,
    web_search: toolIcons.Globe,
    web_fetch: toolIcons.Globe,
    search_knowledge: toolIcons.FolderSearch,
    glob_knowledge: toolIcons.FolderSearch,
    read_knowledge: toolIcons.List,
    write_note: toolIcons.Plus,
    list_memories: toolIcons.Brain,
    view_image_detail: toolIcons.ZoomIn,
    get_program: toolIcons.Activity,
    generate_program: toolIcons.Activity,
    adjust_program: toolIcons.Activity,
    list_todos: toolIcons.ListTodo,
    get_strength_progress: toolIcons.Activity,
    probe_model: toolIcons.Settings,
    list_models: toolIcons.Settings,
    // 校园教务（AI 的最后补救）：抢课与选课都挂在课表这一天里，原始请求按「读网」算
    campus_status: toolIcons.Calendar,
    campus_lessons: toolIcons.Calendar,
    campus_grab_plan: toolIcons.Calendar,
    campus_grab_control: toolIcons.Calendar,
    campus_select: toolIcons.Calendar,
    campus_session: toolIcons.Calendar,
    campus_http: toolIcons.Globe,
    campus_export_script: toolIcons.List,
  }
  return map[name] ?? toolIcons.Wrench
}

// 参数摘要：优先提取关键字段(文件路径/URL/命令等)，取前 48 字符
const ARG_KEY_PRIORITY = [
  'file_path',
  'path',
  'url',
  'command',
  'query',
  'pattern',
  'description',
]

function argsSummary(args: string): string {
  if (!args || args === 'null' || args === '{}') return '无参数'
  try {
    const obj = JSON.parse(args)
    if (obj && typeof obj === 'object') {
      for (const k of ARG_KEY_PRIORITY) {
        const v = (obj as Record<string, unknown>)[k]
        if (typeof v === 'string' && v) {
          return v.length > 48 ? v.slice(0, 48) + '…' : v
        }
      }
    }
  } catch {
    /* 非 JSON 时回退原始文本 */
  }
  return args.length > 40 ? args.slice(0, 40) + '…' : args
}

// 美化 JSON 用于详情显示
function prettyJson(s: string): string {
  if (!s) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

// 状态文案
function statusText(c: ProcessToolCall): string {
  if (c.pending) return '执行中…'
  if (c.isError) return '失败'
  return '完成'
}

// 完成数量
const doneCount = computed(() => props.calls.filter((c) => !c.pending).length)

// 结果预览摘要：压平空白后截断（单条工具段内的紧凑展示）
function resultSummary(c: ProcessToolCall): string {
  if (c.pending) return '执行中…'
  if (!c.result) return c.isError ? '执行失败' : '无返回结果'
  const compact = c.result.replace(/\s+/g, ' ').trim()
  return compact.length > 200 ? compact.slice(0, 200) + '…' : compact
}
</script>

<template>
  <div v-if="calls.length > 0" class="tool-group" :class="{ embedded }">
    <!-- 组标题：38px（嵌入模式下由外层提供标题，隐藏） -->
    <div
      v-if="!embedded"
      class="group-header"
      role="button"
      tabindex="0"
      :aria-expanded="!groupCollapsed"
      aria-controls="toolgroup-body"
      data-tooltip="点击展开 / 折叠工具调用"
      @click="toggleGroup"
      @keydown="handleKeydown($event, toggleGroup)"
    >
      <span class="group-icon"><Wrench :size="16" /></span>
      <span class="group-title">
        {{ calls.length === 1 ? '使用了工具' : `使用了 ${calls.length} 个工具` }}
      </span>
      <span class="group-progress">{{ doneCount }}/{{ calls.length }}</span>
      <span class="group-arrow">
        <ChevronDown v-if="!groupCollapsed" :size="12" />
        <ChevronRight v-else :size="12" />
      </span>
    </div>

    <!-- 工具列表：每条 38px（嵌入模式下始终展示，折叠由外层控制） -->
    <div v-show="embedded || !groupCollapsed" id="toolgroup-body" ref="groupBodyRef" class="group-body">
      <!-- 工具调用（点击行内展开详情） -->
      <div
        v-for="c in calls"
        :key="c.callId"
        class="tool-item-wrap"
        :class="{ 'is-expanded': selectedCallId === c.callId }"
      >
        <div
          class="tool-item"
          role="button"
          tabindex="0"
          :aria-expanded="selectedCallId === c.callId"
          :aria-label="(selectedCallId === c.callId ? '收起' : '展开') + c.toolName + ' 详情'"
          data-tooltip="点击展开 / 收起详情"
          @click="toggleDetail(c.callId)"
          @keydown="handleKeydown($event, () => toggleDetail(c.callId))"
        >
          <span class="tool-icon"><component :is="toolIcon(c.rawName ?? c.toolName)" :size="18" /></span>
          <div class="tool-info">
            <div class="tool-name-row">
              <span class="tool-name">{{ c.toolName }}</span>
              <span
                class="tool-status"
                :class="{ pending: c.pending, error: c.isError && !c.pending, ok: !c.pending && !c.isError }"
              >
                <span v-if="c.pending" class="status-dot"></span>
                {{ statusText(c) }}
              </span>
            </div>
            <div class="tool-args">{{ argsSummary(c.arguments) }}</div>
          </div>
          <span v-if="!embedded" class="tool-arrow" :class="{ expanded: selectedCallId === c.callId }"><ChevronRight :size="16" /></span>
          <!-- 结果预览：嵌入 + showResult 模式下直接展示执行结果（执行中先隐藏） -->
          <span v-if="showResult && !c.pending" class="tool-result-inline">{{ resultSummary(c) }}</span>
        </div>

        <!-- 行内详情：参数 + 返回结果（accordion，不遮挡消息流） -->
        <div v-if="selectedCallId === c.callId" class="tool-detail-inline">
          <section class="detail-section">
            <h4 class="detail-section-title">工具名</h4>
            <pre class="detail-pre">{{ c.toolName }}</pre>
          </section>

          <section class="detail-section">
            <h4 class="detail-section-title">输入参数</h4>
            <pre class="detail-pre">{{ prettyJson(c.arguments) || '无' }}</pre>
          </section>

          <section class="detail-section">
            <h4 class="detail-section-title">
              返回结果
              <span
                v-if="!c.pending"
                class="result-status"
                :class="{ error: c.isError, ok: !c.isError }"
              >{{ c.isError ? '失败' : '成功' }}</span>
              <span v-else class="result-status pending">执行中…</span>
            </h4>
            <pre
              v-if="c.result"
              class="detail-pre"
              :class="{ 'is-error': c.isError }"
            >{{ c.result }}</pre>
            <div v-else class="detail-empty">{{ c.pending ? '等待结果返回…' : '无返回结果' }}</div>
            <img
              v-if="c.resultImage"
              class="detail-img"
              :src="`data:${c.resultImage.mime};base64,${c.resultImage.base64}`"
              alt="工具返回图片"
            >
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  margin: 4px 0 8px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
  border: 1px solid var(--line);
  overflow: hidden;
  font-size: 13px;
}

/* 嵌入模式：无外层卡片，每条工具调用为单行文档流样式（无卡片、无边框、无底色） */
.tool-group.embedded {
  margin: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  overflow: visible;
}

.tool-group.embedded .group-body {
  border-top: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 嵌入模式下行内详情与工具行文本列对齐，保持紧凑（融入文档流：无块状底色、无顶边分隔线） */
.tool-group.embedded .tool-detail-inline {
  padding: 8px 8px 12px 24px;
  margin: 0;
  background: transparent;
  border-top: none;
}

/* 嵌入模式下展开态的行不自带块状底色，避免破坏单行文档流 */
.tool-group.embedded .tool-item-wrap.is-expanded .tool-item {
  background: transparent;
}

/* 单行布局：icon + 工具名/状态 + 参数摘要 全在一行内，超出省略 */
.tool-group.embedded .tool-item {
  height: auto;
  min-height: 22px;
  max-height: none;
  padding: 0 2px;
  border: none;
  border-radius: 0;
  background: transparent;
  gap: 6px;
  transition: none;
}

.tool-group.embedded .tool-item:hover {
  background: transparent;
  border-color: transparent;
}

.tool-group.embedded .tool-icon {
  width: 16px;
  font-size: 14px;
}

.tool-group.embedded .tool-info {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.tool-group.embedded .tool-name-row {
  flex-shrink: 1;
  min-width: 0;
  gap: 5px;
}

.tool-group.embedded .tool-name {
  font-size: 12px;
}

.tool-group.embedded .tool-args {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
}

.tool-group.embedded .tool-status {
  font-size: 10.5px;
  padding: 0;
  background: transparent;
}

/* 结果预览模式：参数摘要让位给结果，工具行只保留 名称/状态 + 结果 */
.tool-group.embedded.show-result .tool-args {
  display: none;
}

/* 结果预览（showResult 模式）：等宽小字，单行省略，点缀在工具行内 */
.tool-result-inline {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-left: 1px solid var(--line);
  padding-left: 8px;
}

.tool-group.embedded .tool-item:hover .tool-result-inline {
  color: var(--text-1);
}

/* 执行中的状态小圆点：呼吸动画 */
.status-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: status-pulse 1s infinite ease-in-out;
}

@keyframes status-pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

/* 组标题：38px */
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  max-height: 38px;
  padding: 0 12px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: background 120ms ease;
}

.group-header:hover {
  background: var(--surface);
}

.group-icon {
  font-size: 16px;
  line-height: 1;
  color: var(--text-1);
  display: inline-flex;
}

.group-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-progress {
  font-size: 11px;
  color: var(--text-3);
  padding: 2px 6px;
  background: var(--surface);
  border-radius: var(--radius-m);
}

.group-arrow {
  font-size: 12px;
  color: var(--text-3);
  display: inline-flex;
}

/* 工具列表 */
.group-body {
  overflow: hidden;
  border-top: 1px solid var(--line);
}

/* 每条 tool call：38px 高度 */
.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  max-height: 38px;
  padding: 0 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
  transition: background 120ms ease;
  overflow: hidden;
}

.tool-item:last-child {
  border-bottom: none;
}

.tool-item:hover {
  background: var(--surface);
}

.tool-icon {
  font-size: 18px;
  line-height: 1;
  width: 24px;
  text-align: center;
  flex-shrink: 0;
  color: var(--text-2);
  display: inline-flex;
  justify-content: center;
}

.tool-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.tool-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
  font-weight: 500;
}

.tool-status.pending {
  color: var(--text-3);
  background: var(--surface);
}

.tool-status.error {
  color: var(--danger);
  background: var(--danger-soft);
}

.tool-status.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.tool-args {
  font-size: 11px;
  color: var(--text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-arrow {
  font-size: 18px;
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform 150ms ease;
  display: inline-flex;
}

/* 展开时箭头由右转下（chevron-right 旋转 —90°），带平滑过渡 */
.tool-arrow.expanded {
  transform: rotate(-90deg);
}

/* 展开时行底色 */
.tool-item-wrap.is-expanded .tool-item {
  background: var(--surface-2);
  /* 展开时去掉行底边框，避免与详情区虚线顶边叠加成双分隔线 */
  border-bottom: none;
}

.tool-detail-inline {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 1px dashed var(--line);
  background: var(--surface-2);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.result-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-weight: 400;
}

.result-status.pending {
  color: var(--text-3);
  background: var(--surface);
}

.result-status.error {
  color: var(--danger);
  background: var(--danger-soft);
}

.result-status.ok {
  color: var(--ok-strong);
  background: var(--ok-soft);
}

.detail-pre {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  color: var(--text-1);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}

.detail-pre.is-error {
  border-color: var(--danger);
  color: var(--danger);
}

.detail-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  background: var(--surface-2);
  border-radius: var(--radius-m);
}

/* 工具返回图片（Rein 放大镜结果） */
.detail-img {
  display: block;
  max-width: 200px;
  max-height: 160px;
  border-radius: var(--radius-s);
  border: 0.5px solid var(--line);
}

/* 无障碍：reduce 下禁用位移类动效（箭头旋转、状态圆点呼吸） */
@media (prefers-reduced-motion: reduce) {
  .tool-arrow,
  .group-arrow {
    transition: none;
  }
  .status-dot {
    animation: none;
  }
}
</style>
