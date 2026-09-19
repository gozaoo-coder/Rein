<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Brain,
  CalendarDays,
  Carrot,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Dumbbell,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Lock,
  MessagesSquare,
  Mic,
  MoveRight,
  NotebookPen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Scale,
  Search,
  ShieldCheck,
  Soup,
  Target,
  Trash2,
  Upload,
  UtensilsCrossed,
  X,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { kbService } from '@/services/kbService'
import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import {
  KB_SOURCE_LABELS,
  type KbChunk,
  type KbFile,
  type KbGlobHit,
  type KbHit,
  type KbMedia,
  type KbModal,
  type KbSourceType,
} from '@/types'

/** 文件管理器（docs/ai-workspace.md §5）：虚拟文件系统的真实视图。
 *  入口在 AI 页左上角；浏览走 glob 目录下钻 + 面包屑，阅读保证完整
 *  （note 源直读 kb_files 真源，派生文档按 L2 分块渐进加载），
 *  本体（音频/视频/图片）按模态取，不可用则降级为文本。
 *  一切操作 = 一条 kb 命令，不读物理路径、不调用系统文件管理器。 */

const ai = useAiStore()
const toast = useToast()

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 目录列举的单次拉取上限（服务端 glob 上限 500） */
const GLOB_LIMIT = 500
/** 阅读器每次加载的块数（kb_read 上限 64） */
const PAGE_CHUNKS = 24
/** 客户端导入上限：base64 走 IPC，超过这个体积就不再考虑 */
const UPLOAD_CAP = 32 * 1024 * 1024

/* ---------- 目录浏览 ---------- */

interface DirEntry {
  name: string
  path: string
  count: number
}

const dir = ref('')
const dirs = ref<DirEntry[]>([])
const files = ref<KbGlobHit[]>([])
const listingBusy = ref(false)
const truncated = ref(false)
const recent = ref<KbHit[]>([])
const recentLoaded = ref(false)

/** 根目录网格：系统区 → 知识区 → 投影区，顺序即规范里的心智模型（§3.1） */
const NAMESPACES = [
  { name: '系统提示词', icon: ShieldCheck, hint: '只读 · 每轮注入' },
  { name: '用户记忆', icon: Brain, hint: '长期设定与规范' },
  { name: '未分类数据', icon: Folder, hint: '收件箱 · 待归类' },
  { name: '笔记', icon: NotebookPen, hint: '手写笔记' },
  { name: '文档', icon: FileText, hint: '上传文档全文' },
  { name: '语音', icon: Mic, hint: '语音纪要与本音' },
  { name: '视频', icon: FileVideo, hint: '视频与转写' },
  { name: '日程', icon: CalendarDays, hint: '待办与安排' },
  { name: '附件', icon: Paperclip, hint: '图片·音频·文件' },
  { name: '对话', icon: MessagesSquare, hint: '会话转录' },
  { name: '运动', icon: Dumbbell, hint: '训练记录' },
  { name: '课程', icon: ClipboardList, hint: '训练课程' },
  { name: '饮食', icon: UtensilsCrossed, hint: '饮食记录' },
  { name: '体测', icon: Scale, hint: '体重身高' },
  { name: '食物', icon: Carrot, hint: '自建食物' },
  { name: '方案', icon: Target, hint: '健康方案' },
  { name: '菜单', icon: Soup, hint: '方案菜单' },
  { name: '记忆', icon: Brain, hint: '长期记忆' },
  { name: '规范', icon: ShieldCheck, hint: '系统规范' },
] as const

/** 归类时的常用目标（快速 chips） */
const MOVE_TARGETS = ['运动', '饮食', '日程', '笔记', '文档', '语音', '视频', '用户记忆', '未分类数据']

const crumbs = computed(() => (dir.value ? dir.value.split('/') : []))

async function loadDir(path: string): Promise<void> {
  listingBusy.value = true
  try {
    const hits = await kbService.glob(path ? `${path}/**` : '**', GLOB_LIMIT)
    const map = new Map<string, number>()
    const fs: KbGlobHit[] = []
    const prefix = path ? `${path}/` : ''
    for (const h of hits) {
      const rel = path ? h.path.slice(prefix.length) : h.path
      if (!rel || rel.startsWith('..')) continue
      const slash = rel.indexOf('/')
      // 根目录：顶层文件直接列出；顶层目录由命名空间网格承担
      if (slash < 0) {
        fs.push(h)
      } else {
        const name = rel.slice(0, slash)
        map.set(name, (map.get(name) ?? 0) + 1)
      }
    }
    dirs.value = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([name, count]) => ({ name, path: `${path}/${name}`, count }))
    files.value = fs
    truncated.value = hits.length >= GLOB_LIMIT
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    listingBusy.value = false
  }
}

function openDir(path: string): void {
  dir.value = path
  dirs.value = []
  files.value = []
  truncated.value = false
  void loadDir(path)
}

async function refreshListing(): Promise<void> {
  await loadDir(dir.value)
}

/** k = -1 回根目录 */
function jumpCrumb(k: number): void {
  const path = k < 0 ? '' : crumbs.value.slice(0, k + 1).join('/')
  if (path === dir.value) return
  if (!path) {
    dir.value = ''
    void loadDir('')
    return
  }
  openDir(path)
}

/* ---------- 新建目录 / 导入本体 ---------- */

const folderOpen = ref(false)
const folderName = ref('')
const folderBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function openFolderPanel(): void {
  folderOpen.value = true
  folderName.value = ''
}

async function createFolder(): Promise<void> {
  const name = folderName.value.trim()
  if (!name) return
  folderBusy.value = true
  try {
    const f = await kbService.fsMkdir(dir.value ? `${dir.value}/${name}` : name, '用户在文件管理器新建', 'user')
    toast.toast(`已建目录 ${f.path}`)
    folderOpen.value = false
    await refreshListing()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    folderBusy.value = false
  }
}

function pickUpload(): void {
  fileInput.value?.click()
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(f)
  })
}

async function onUploadPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > UPLOAD_CAP) {
    toast.toast(`文件超过 ${UPLOAD_CAP / 1024 / 1024}MB，暂不支持导入工作区`)
    return
  }
  try {
    const dataUrl = await readAsDataUrl(file)
    // 目录里导入就落当前目录；根目录导入先落收件箱，等用户或 AI 归类（§3.3）
    const target = dir.value || '未分类数据'
    const f = await kbService.mediaWrite({
      path: `${target}/${file.name}`,
      name: file.name,
      mime: file.type || '',
      dataBase64: dataUrl,
    })
    toast.toast(`已导入 ${f.path}`)
    await refreshListing()
  } catch (e2) {
    toast.toast(errMsg(e2))
  }
}

/* ---------- 文件名搜索 ---------- */

const query = ref('')
const found = ref<KbGlobHit[] | null>(null)
const searching = ref(false)

async function runFilter(): Promise<void> {
  const kw = query.value.trim().replace(/[*?/\\]/g, '')
  if (!kw) {
    found.value = null
    return
  }
  searching.value = true
  try {
    found.value = await kbService.glob(`**/*${kw}*`, 200)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    searching.value = false
  }
}

let filterTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => void runFilter(), 250)
})

function clearFilter(): void {
  query.value = ''
  found.value = null
}

/* ---------- 阅读器 ---------- */

interface ReaderState {
  docId: number
  title: string
  path: string | null
  sourceType: KbSourceType
  kind: string
  editable: boolean
  system: boolean
  occurredOn: string | null
  tags: string[]
  summary: string
  /** note 源直读的真源原文（完整）；派生文档为 null 走分块 */
  raw: string | null
  fileId: number | null
  chunks: KbChunk[]
  totalChunks: number
  hasMore: boolean
  chars: number
  loadingMore: boolean
  editing: boolean
  editContent: string
  busy: boolean
  /** 文件节点的归类状态与模态清单 */
  classifyState: string
  pinned: boolean
  modalities: string[]
  /** 当前预览的模态与其内容（本体按需取，不预载） */
  viewing: KbModal | 'text'
  media: KbMedia | null
  mediaBusy: boolean
  moveOpen: boolean
  moveTarget: string
}

const reader = ref<ReaderState | null>(null)

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function kindIcon(kind: string) {
  if (kind === 'folder') return Folder
  if (kind === 'image') return ImageIcon
  if (kind === 'audio') return FileAudio
  if (kind === 'video') return FileVideo
  if (kind === 'file') return Paperclip
  return FileText
}

const sourceLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  if (r.sourceType !== 'note') return KB_SOURCE_LABELS[r.sourceType] ?? r.sourceType
  // 归档文档 / 系统文件 / 普通笔记同为 note 源，用路径前缀区分展示
  if (r.system) return r.path?.startsWith('系统提示词/') ? '系统提示词' : '规范'
  return r.path?.startsWith('文档/') ? '文档归档' : '笔记'
})

const sizeLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  return r.raw !== null ? `${r.chars.toLocaleString()} 字` : `共 ${r.totalChunks} 块`
})

const classifyLabel = computed(() => {
  switch (reader.value?.classifyState) {
    case 'inbox':
      return '待归类'
    case 'filed':
      return '已归类'
    case 'manual':
      return '手动放置'
    default:
      return ''
  }
})

/** 模态展示名（chips） */
function modalLabel(m: string): string {
  return m === 'text' ? '文本' : m === 'image' ? '图片' : m === 'audio' ? '音频' : m === 'video' ? '视频' : '本体'
}

/** 打开本体（data URL 预览）。过大时只展示元信息与提示。 */
async function viewModal(modal: KbModal | 'text'): Promise<void> {
  const r = reader.value
  if (!r) return
  r.viewing = modal
  r.mediaBusy = true
  try {
    r.media = await kbService.mediaGet(r.docId, modal)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.mediaBusy = false
  }
}

function applyFile(r: ReaderState, f: KbFile): void {
  r.raw = f.content
  r.fileId = f.id
  r.chars = f.content.length
  r.system = f.system
  r.editable = !f.system && f.kind !== 'folder'
  r.classifyState = f.classifyState
  r.pinned = f.pinned
  r.modalities = [...new Set(['text', ...f.modalities.map((m) => m.modal)])]
  r.path = f.path
}

async function openDoc(docId: number): Promise<void> {
  try {
    const d = await kbService.read(docId, 'l2', 0, PAGE_CHUNKS)
    const r: ReaderState = {
      docId: d.id,
      title: d.title,
      path: d.path,
      sourceType: d.sourceType,
      kind: d.kind,
      editable: d.editable,
      system: d.system,
      occurredOn: d.occurredOn,
      tags: d.tags,
      summary: d.summary,
      raw: null,
      fileId: null,
      chunks: d.chunks,
      totalChunks: d.totalChunks,
      hasMore: d.hasMore,
      chars: d.chunks.reduce((n, c) => n + c.text.length, 0),
      loadingMore: false,
      editing: false,
      editContent: '',
      busy: false,
      classifyState: 'manual',
      pinned: false,
      modalities: d.modalities,
      viewing: 'text',
      media: null,
      mediaBusy: false,
      moveOpen: false,
      moveTarget: '',
    }
    if (d.sourceType === 'note') {
      // 真源直读：kb_docs.body 是带截断上限的检索缓存，原文才完整
      const f = await kbService.fileGet(d.id)
      applyFile(r, f)
    }
    reader.value = r
    // 多模态节点：默认直接开主模态预览（视频 > 音频 > 图片）
    const primary =
      r.modalities.find((m) => m === 'video') ??
      r.modalities.find((m) => m === 'audio') ??
      r.modalities.find((m) => m === 'image')
    if (primary && r.modalities.length > 1) void viewModal(primary as KbModal)
  } catch (e) {
    toast.toast(errMsg(e))
  }
}

async function loadMore(): Promise<void> {
  const r = reader.value
  if (!r || !r.hasMore || r.loadingMore || r.busy) return
  r.loadingMore = true
  try {
    const d = await kbService.read(r.docId, 'l2', r.chunks.length, PAGE_CHUNKS)
    r.chunks.push(...d.chunks)
    r.totalChunks = d.totalChunks
    r.hasMore = d.hasMore
    r.chars += d.chunks.reduce((n, c) => n + c.text.length, 0)
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.loadingMore = false
  }
}

/** 一次读完：连续拉取直到末尾（kb_read 单次上限 64 块，循环翻页） */
async function loadAll(): Promise<void> {
  const r = reader.value
  if (!r || r.raw !== null || r.busy) return
  r.busy = true
  try {
    while (r.hasMore) {
      const d = await kbService.read(r.docId, 'l2', r.chunks.length, 64)
      if (!d.chunks.length) break
      r.chunks.push(...d.chunks)
      r.totalChunks = d.totalChunks
      r.hasMore = d.hasMore
      r.chars += d.chunks.reduce((n, c) => n + c.text.length, 0)
    }
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

/* ---------- 编辑 / 删除 / 钉住 / 归类 ---------- */

function startEdit(): void {
  const r = reader.value
  if (!r || r.raw === null) return
  r.editing = true
  r.editContent = r.raw
}

async function saveEdit(): Promise<void> {
  const r = reader.value
  if (!r || r.fileId === null) return
  r.busy = true
  try {
    // fileWrite 按路径幂等覆盖，路径不变即原地更新
    const f = await kbService.fileWrite({ path: r.path ?? '', content: r.editContent })
    applyFile(r, f)
    r.editing = false
    ai.invalidateCognitionCache()
    toast.toast('已保存')
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

async function removeFile(): Promise<void> {
  const r = reader.value
  if (!r || r.fileId === null) return
  r.busy = true
  try {
    await kbService.fileDelete(r.fileId)
    ai.invalidateCognitionCache()
    toast.toast('已删除该文件')
    reader.value = null
    await refreshListing()
  } catch (e) {
    toast.toast(errMsg(e))
    r.busy = false
  }
}

async function togglePin(): Promise<void> {
  const r = reader.value
  if (!r) return
  r.busy = true
  try {
    const f = await kbService.fsPin(r.docId, !r.pinned, 'user')
    r.pinned = f.pinned
    r.classifyState = f.classifyState
    toast.toast(f.pinned ? '已钉住：AI 不会再自动移动它' : '已取消钉住')
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

function openMovePanel(): void {
  const r = reader.value
  if (!r) return
  r.moveOpen = true
  r.moveTarget = ''
}

async function doMove(target?: string): Promise<void> {
  const r = reader.value
  if (!r) return
  const to = (target ?? r.moveTarget).trim()
  if (!to) return
  r.busy = true
  try {
    const res = await kbService.fsMove(r.docId, to, '用户在文件管理器归类', 'user')
    r.path = res.to
    r.classifyState = res.file.classifyState
    r.moveOpen = false
    toast.toast(`已移到 ${res.to}`)
    await refreshListing()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    r.busy = false
  }
}

onMounted(async () => {
  void loadDir('')
  try {
    // 空查询 = 按日期倒序浏览最近内容
    recent.value = await kbService.search({ query: '', limit: 8 })
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    recentLoaded.value = true
  }
})
</script>

<template>
  <div class="page">
    <PageHeader back title="文件" subtitle="AI 工作区的虚拟文件系统" />

    <!-- 阅读器 -->
    <section v-if="reader" class="card reader">
      <div class="row rhead">
        <button class="back" aria-label="返回列表" @click="reader = null">
          <ChevronLeft :size="18" />
        </button>
        <div class="col flex-1">
          <h2 class="rtitle">{{ reader.title }}</h2>
          <p v-if="reader.path" class="rpath">{{ reader.path }}</p>
        </div>
      </div>

      <div class="meta row">
        <span class="pill">{{ sourceLabel }}</span>
        <span v-if="reader.occurredOn" class="pill">{{ reader.occurredOn }}</span>
        <span v-if="reader.system" class="pill ro"><Lock :size="11" /> 系统文件</span>
        <span v-if="classifyLabel" class="pill">{{ classifyLabel }}</span>
        <span v-if="reader.pinned" class="pill ro"><Pin :size="11" /> 已钉住</span>
        <span class="pill">{{ sizeLabel }}</span>
      </div>
      <div v-if="reader.tags.length" class="tags row">
        <span v-for="t in reader.tags" :key="t" class="tag">{{ t }}</span>
      </div>
      <p v-if="reader.summary" class="summary">{{ reader.summary }}</p>

      <!-- 模态切换：一个节点可以有多种模态（§2.2） -->
      <div v-if="reader.modalities.length > 1" class="modals row">
        <button
          v-for="m in reader.modalities"
          :key="m"
          class="chip"
          :class="{ cur: reader.viewing === m }"
          @click="viewModal(m as KbModal)"
        >
          {{ modalLabel(m) }}
        </button>
        <span v-if="reader.mediaBusy" class="t-3 chip-busy">读取中…</span>
      </div>

      <!-- 文本模态 -->
      <template v-if="reader.viewing === 'text'">
        <template v-if="reader.editing">
          <textarea v-model="reader.editContent" rows="16" class="editbox" />
          <div class="row actions">
            <button class="btn" :disabled="reader.busy" @click="saveEdit">保存</button>
            <button class="btn ghost" :disabled="reader.busy" @click="reader.editing = false">取消</button>
          </div>
        </template>
        <template v-else>
          <div v-if="reader.raw !== null" class="doc">{{ reader.raw }}</div>
          <div v-else class="doc">
            <p v-for="c in reader.chunks" :key="c.ord">{{ c.text }}</p>
          </div>
          <div v-if="reader.hasMore" class="row more-row">
            <button class="btn ghost" :disabled="reader.loadingMore || reader.busy" @click="loadMore">
              {{ reader.loadingMore ? '加载中…' : `继续加载（${reader.chunks.length}/${reader.totalChunks} 块）` }}
            </button>
            <button class="btn ghost" :disabled="reader.busy" @click="loadAll">一次读完</button>
          </div>
          <p v-else-if="reader.raw === null && reader.totalChunks > 1" class="t-3 fin">
            已到末尾 · 约 {{ reader.chars.toLocaleString() }} 字
          </p>
        </template>
      </template>

      <!-- 本体模态（图片 / 音频 / 视频 / 其他二进制） -->
      <template v-else>
        <p v-if="reader.media?.degraded" class="degrade">
          已降级为文本：{{ reader.media.degradeReason }}
        </p>
        <img
          v-if="reader.viewing === 'image' && reader.media?.dataUrl"
          class="preview-img"
          :src="reader.media.dataUrl"
          :alt="reader.title"
        >
        <audio
          v-else-if="reader.viewing === 'audio' && reader.media?.dataUrl"
          class="preview-audio"
          controls
          :src="reader.media.dataUrl"
        />
        <video
          v-else-if="reader.viewing === 'video' && reader.media?.dataUrl"
          class="preview-video"
          controls
          :src="reader.media.dataUrl"
        />
        <p v-if="reader.media?.tooLarge" class="t-3 fin">本体较大，未在页面内联；可导出后外部打开。</p>
        <p v-if="reader.media?.hint" class="t-3 fin">{{ reader.media.hint }}</p>
        <blockquote v-if="reader.media && !reader.media.dataUrl && !reader.media.tooLarge" class="doc fallback">
          {{ reader.media.text ?? '（该模态没有可展示的内容）' }}
        </blockquote>
      </template>

      <!-- 归类面板 -->
      <div v-if="reader.moveOpen" class="movebox">
        <div class="row moveq">
          <input v-model="reader.moveTarget" placeholder="目标目录，如「运动/知识」" aria-label="目标目录">
          <button class="btn" :disabled="reader.busy" @click="doMove()">移动</button>
        </div>
        <div class="row chips">
          <button v-for="t in MOVE_TARGETS" :key="t" class="chip" @click="doMove(t)">{{ t }}</button>
        </div>
      </div>

      <div class="row actions">
        <button
          v-if="reader.raw !== null && reader.editable && !reader.editing"
          class="btn ghost"
          :disabled="reader.busy"
          @click="startEdit"
        >
          <Pencil :size="14" /> 编辑
        </button>
        <button v-if="!reader.system" class="btn ghost" :disabled="reader.busy" @click="togglePin">
          <component :is="reader.pinned ? PinOff : Pin" :size="14" />
          {{ reader.pinned ? '取消钉住' : '钉住' }}
        </button>
        <button
          v-if="!reader.system"
          class="btn ghost"
          :disabled="reader.busy"
          @click="reader.moveOpen ? (reader.moveOpen = false) : openMovePanel()"
        >
          <MoveRight :size="14" /> 归类
        </button>
        <button
          v-if="reader.fileId !== null && !reader.system"
          class="btn ghost danger"
          :disabled="reader.busy"
          @click="removeFile"
        >
          <Trash2 :size="14" /> 删除
        </button>
      </div>
    </section>

    <!-- 浏览 -->
    <template v-else>
      <div class="finder row">
        <Search :size="17" class="t-3" />
        <input v-model="query" type="text" placeholder="按文件名搜索，如「膝盖」「安排表」">
        <button v-if="query" class="clear" aria-label="清空搜索" @click="clearFilter">
          <X :size="14" />
        </button>
        <button class="tool" aria-label="新建目录" @click="openFolderPanel">
          <FolderPlus :size="17" />
        </button>
        <button class="tool" aria-label="导入文件" @click="pickUpload">
          <Upload :size="17" />
        </button>
        <input ref="fileInput" type="file" class="hidden-input" @change="onUploadPicked">
      </div>

      <div v-if="folderOpen" class="card newfolder">
        <input v-model="folderName" placeholder="新目录名，如「知识」" aria-label="新目录名" @keyup.enter="createFolder">
        <button class="btn" :disabled="folderBusy || !folderName.trim()" @click="createFolder">创建</button>
        <button class="btn ghost" :disabled="folderBusy" @click="folderOpen = false">取消</button>
      </div>

      <!-- 文件名搜索结果 -->
      <section v-if="found !== null" class="card list">
        <ul v-if="found.length">
          <li v-for="f in found" :key="`${f.sourceType}-${f.id}`">
            <button class="row item" @click="openDoc(f.id)">
              <component :is="kindIcon(f.kind)" :size="15" class="fic" :class="{ dim: f.system }" />
              <span class="flex-1">
                <b>{{ baseName(f.path) }}</b>
                <small>{{ f.path }}</small>
              </span>
              <ChevronRight :size="15" class="t-3" />
            </button>
          </li>
        </ul>
        <p v-else-if="searching" class="t-3 hint-line">搜索中…</p>
        <EmptyState
          v-else
          :icon="Search"
          title="没有匹配的文件"
          hint="这里按文件名匹配；搜正文内容请到「知识库」页检索"
        />
      </section>

      <!-- 根目录：最近内容 + 命名空间 -->
      <template v-else-if="!dir">
        <section class="card list">
          <h3 class="sec">最近内容</h3>
          <ul v-if="recent.length">
            <li v-for="h in recent" :key="`${h.sourceType}-${h.id}`">
              <button class="row item" @click="openDoc(h.id)">
                <component :is="kindIcon(h.kind)" :size="15" class="fic" :class="{ dim: h.system }" />
                <span class="flex-1">
                  <b>{{ h.title }}</b>
                  <small>{{ h.path ?? KB_SOURCE_LABELS[h.sourceType] ?? h.sourceType }}</small>
                </span>
                <span class="t-3 date">{{ h.occurredOn ?? '' }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="t-3 hint-line">{{ recentLoaded ? '知识库还没有内容' : '加载中…' }}</p>
        </section>

        <section class="card">
          <h3 class="sec">目录</h3>
          <div class="nsgrid">
            <button v-for="ns in NAMESPACES" :key="ns.name" class="ns" @click="openDir(ns.name)">
              <component :is="ns.icon" :size="18" class="nsic" />
              <b>{{ ns.name }}</b>
              <small>{{ ns.hint }}</small>
            </button>
          </div>
        </section>

        <section v-if="files.length" class="card list">
          <h3 class="sec">根目录文件</h3>
          <ul>
            <li v-for="f in files" :key="`${f.sourceType}-${f.id}`">
              <button class="row item" @click="openDoc(f.id)">
                <component :is="kindIcon(f.kind)" :size="15" class="fic" :class="{ dim: f.system }" />
                <span class="flex-1">
                  <b>{{ baseName(f.path) }}</b>
                  <small>{{ f.path }}</small>
                </span>
                <Lock v-if="f.system" :size="12" class="t-3" />
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
          </ul>
        </section>
      </template>

      <!-- 子目录：面包屑 + 子目录 + 文件 -->
      <template v-else>
        <div class="crumbs row">
          <button class="crumb" @click="jumpCrumb(-1)">文件</button>
          <template v-for="(c, k) in crumbs" :key="k">
            <ChevronRight :size="13" class="t-3" />
            <button class="crumb" :class="{ cur: k === crumbs.length - 1 }" @click="jumpCrumb(k)">
              {{ c }}
            </button>
          </template>
        </div>

        <section class="card list">
          <ul v-if="dirs.length || files.length">
            <li v-for="d in dirs" :key="d.path">
              <button class="row item" @click="openDir(d.path)">
                <Folder :size="15" class="fic" />
                <span class="flex-1"><b>{{ d.name }}</b></span>
                <span class="t-3 dcount">{{ d.count }} 项</span>
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
            <li v-for="f in files" :key="`${f.sourceType}-${f.id}`">
              <button class="row item" @click="openDoc(f.id)">
                <component :is="kindIcon(f.kind)" :size="15" class="fic" :class="{ dim: f.system }" />
                <span class="flex-1">
                  <b>{{ baseName(f.path) }}</b>
                  <small v-if="f.occurredOn">{{ f.occurredOn }}</small>
                </span>
                <Lock v-if="f.system" :size="12" class="t-3" />
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
          </ul>
          <p v-else class="t-3 hint-line">{{ listingBusy ? '加载中…' : '此目录还没有文件' }}</p>
          <p v-if="truncated" class="t-3 hint-line">
            目录较大，仅列出前 {{ GLOB_LIMIT }} 项；进入子目录可缩小范围。
          </p>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.finder {
  gap: 8px;
  padding: 11px 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}

.finder input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-subhead);
}

.clear {
  flex: none;
  padding: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
}

.tool {
  flex: none;
  padding: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--accent);
}

.hidden-input {
  display: none;
}

.newfolder {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.newfolder input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

/* 列表卡片：行式布局，压掉全局卡片的大内边距 */
.card.list {
  margin-top: 14px;
  padding: 6px 20px;
}

.sec {
  padding: 12px 0 4px;
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.item {
  width: 100%;
  text-align: left;
  gap: 10px;
  padding: 13px 0;
}

.item + .item,
li + li .item {
  border-top: 0.5px solid var(--line);
}

.item b {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item small {
  color: var(--text-3);
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.fic {
  flex: none;
  color: var(--accent);
}

.fic.dim {
  color: var(--text-3);
}

.date,
.dcount {
  flex: none;
  font-size: var(--fs-caption);
}

.hint-line {
  padding: 12px 0;
  font-size: var(--fs-footnote);
}

/* 根目录命名空间网格 */
.nsgrid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 8px 0 12px;
}

.ns {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 4px 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: center;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.ns:active {
  transform: scale(0.96);
}

.ns b {
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-1);
}

.ns small {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.nsic {
  color: var(--accent);
}

/* 面包屑 */
.crumbs {
  gap: 4px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.crumb {
  padding: 4px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.crumb.cur {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* 阅读器 */
.reader {
  margin-top: 14px;
}

.rhead {
  gap: 8px;
}

.back {
  flex: none;
  padding: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.rtitle {
  font-size: var(--fs-headline);
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.3;
}

.rpath {
  margin-top: 2px;
  font-family: ui-monospace, monospace;
  font-size: var(--fs-micro);
  color: var(--text-3);
  word-break: break-all;
}

.meta {
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-micro);
}

.pill.ro {
  background: var(--accent-soft);
  color: var(--accent);
}

.tags {
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line);
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.summary {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  line-height: 1.6;
  color: var(--text-2);
}

/* 模态 chips */
.modals {
  gap: 6px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.chip,
.chip-busy {
  padding: 5px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
  transition: transform var(--dur-fast) var(--ease-standard);
}

.chip:active {
  transform: scale(0.96);
}

.chip.cur {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.chips {
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* 本体预览 */
.preview-img,
.preview-video {
  width: 100%;
  margin-top: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.preview-audio {
  width: 100%;
  margin-top: 12px;
}

.degrade {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.doc {
  margin-top: 12px;
  font-size: var(--fs-footnote);
  line-height: 1.8;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.doc p + p {
  margin-top: 8px;
}

.fallback {
  padding: 10px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-2);
}

.more-row {
  gap: 8px;
  margin-top: 12px;
}

.more-row .btn {
  flex: 1;
}

.fin {
  margin-top: 10px;
  text-align: center;
  font-size: var(--fs-caption);
}

/* 归类面板 */
.movebox {
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.moveq {
  gap: 8px;
}

.moveq input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--radius-m);
  background: var(--surface);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}

.editbox {
  width: 100%;
  margin-top: 12px;
  padding: 10px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-footnote);
  line-height: 1.6;
  font-family: ui-monospace, monospace;
  resize: vertical;
}

.actions {
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 14px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: 600;
}

.btn.ghost {
  background: var(--surface-2);
  color: var(--text-1);
}

.btn.ghost.danger {
  color: var(--danger);
}

.btn:disabled {
  opacity: 0.5;
}
</style>
