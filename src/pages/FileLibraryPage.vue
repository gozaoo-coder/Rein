<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  Brain,
  CalendarDays,
  Carrot,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CornerLeftUp,
  Dumbbell,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Lock,
  MessagesSquare,
  Mic,
  MoveRight,
  NotebookPen,
  Paperclip,
  Pencil,
  Pin,
  PackageOpen,
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
  type KbArchiveListing,
  type KbArchiveReport,
  type KbChunk,
  type KbFile,
  type KbGlobHit,
  type KbHit,
  type KbMedia,
  type KbModal,
  type KbSourceType,
  type KbUsageReport,
} from '@/types'

/** 文件管理器（docs/ai-workspace.md §5）：虚拟文件系统的真实视图。
 *  入口在 AI 页左上角；浏览走 glob 目录下钻 + 面包屑，阅读保证完整
 *  （note 源直读 kb_files 真源，派生文档按 L2 分块渐进加载），
 *  本体（音频/视频/图片）按模态取，不可用则降级为文本。
 *  一切操作 = 一条 kb 命令，不读物理路径、不调用系统文件管理器。 */

const ai = useAiStore()
const toast = useToast()
/** 「去原页面」用：派生投影只是索引，正文要看真身就得回它自己的页面 */
const router = useRouter()

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

/**
 * 根目录清单：按真实文件系统的读法——一行一个目录（名称 + 说明 + 条目数 + 进箭头），
 * 而不是方块网格。命名空间在前（规范里定义的心智模型），数据里存在的其他顶层目录补在后面，
 * 保证没有哪个目录会被藏起来。
 */
const rootEntries = computed(() => {
  const counts = new Map(dirs.value.map((d) => [d.name, d.count]))
  const known = new Set<string>(NAMESPACES.map((n) => n.name))
  const rows = NAMESPACES.map((n) => ({
    name: n.name as string,
    icon: n.icon as Component,
    hint: n.hint as string,
    count: counts.get(n.name) ?? 0,
  }))
  for (const d of dirs.value) {
    if (!known.has(d.name)) rows.push({ name: d.name, icon: Folder, hint: '用户目录', count: d.count })
  }
  return rows
})

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
  /** 压缩包清单（打开后才有值）；null = 还没打开或不是压缩包 */
  archive: KbArchiveListing | null
  archiveErr: string
}

const reader = ref<ReaderState | null>(null)

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/* ---------- 空间总览（根视图顶部） ---------- */

const usage = ref<KbUsageReport | null>(null)
const usageOpen = ref(false)
const cleaning = ref(false)
const cleanConfirm = ref(false)

async function loadUsage(): Promise<void> {
  try {
    usage.value = await kbService.usage(12)
  } catch {
    /* 总览是锦上添花：取不到就整块不显示，不打扰浏览 */
    usage.value = null
  }
}

async function cleanOrphans(): Promise<void> {
  if (!cleanConfirm.value) {
    cleanConfirm.value = true
    return
  }
  cleaning.value = true
  try {
    const r = await kbService.usageClean(false)
    toast.toast(r.removed > 0 ? r.message : '没有需要清理的碎片')
    cleanConfirm.value = false
    await loadUsage()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    cleaning.value = false
  }
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 占用条：以最大项为满格（比按总量归一更能看出层级） */
function areaPct(bytes: number): number {
  const max = usage.value?.areas[0]?.bytes ?? 0
  return max > 0 ? Math.max(2, Math.round((bytes / max) * 100)) : 0
}

/* ---------- 压缩包（zip / tar / gz） ---------- */

const archiveBusy = ref(false)
const archiveToDir = ref('')
const archiveOnly = ref('')
const archiveReport = ref<KbArchiveReport | null>(null)

/** 是不是「可能能打开」的压缩包：按扩展名给出入口，真实格式由后端按魔数判 */
const archiveCandidate = computed(() => /\.(zip|tar|gz|tgz)$/i.test(reader.value?.path ?? ''))

async function openArchive(): Promise<void> {
  const r = reader.value
  if (!r || archiveBusy.value) return
  archiveBusy.value = true
  r.archiveErr = ''
  try {
    r.archive = await kbService.archiveList(r.docId)
  } catch (e) {
    r.archive = null
    r.archiveErr = errMsg(e)
  } finally {
    archiveBusy.value = false
  }
}

async function doExtract(): Promise<void> {
  const r = reader.value
  if (!r || archiveBusy.value) return
  const only = archiveOnly.value
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
  archiveBusy.value = true
  r.archiveErr = ''
  try {
    const rep = await kbService.archiveExtract(
      r.docId,
      archiveToDir.value.trim() || undefined,
      only.length ? only : undefined,
    )
    archiveReport.value = rep
    toast.toast(rep.message)
    await refreshListing()
    await loadUsage()
  } catch (e) {
    r.archiveErr = errMsg(e)
    toast.toast(errMsg(e))
  } finally {
    archiveBusy.value = false
  }
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

/**
 * 正文文本（**首行去重后**）。
 *
 * 后端每个派生文档的正文第一段恒等于它的标题（source.rs 里 `parts = vec![title]`），
 * 而标题已经在卡片顶部大号显示 —— 原样渲染就是「标题 / 标题」两行，
 * 正文区读起来像空的。这里统一取「raw 优先，其次分块拼接」，再剔掉开头等于标题的段。
 *
 * 剔完可能是空串：那说明这条记录真的只有标题（源记录没有备注/子任务/明细），
 * 由模板走 .thin 分支讲清楚，而不是留一片空白让用户以为文件坏了。
 */
const bodyText = computed(() => {
  const r = reader.value
  if (!r) return ''
  const full = r.raw !== null ? r.raw : r.chunks.map((c) => c.text).join('\n')
  const paras = full.split('\n').filter((s) => s.trim().length > 0)
  if (paras.length && paras[0].trim() === r.title.trim()) paras.shift()
  return paras.join('\n').trim()
})

/** 是否还有后续分块可加载（raw 直读的真源没有分页概念） */
const canPageMore = computed(() => reader.value !== null && reader.value.raw === null)

/**
 * 摘要：**与标题相同时不显示**。派生文档的 summary 多数就是标题本身
 * （投影只有标题与结构化字段），原样渲染会在标题下再重复一行同样的字。
 * 只有摘要确实包含额外信息（如笔记的首句）时才值得占一行。
 */
const summaryText = computed(() => {
  const r = reader.value
  if (!r?.summary) return ''
  const s = r.summary.trim()
  return s && s !== r.title.trim() ? s : ''
})

/**
 * 「这条记录本就这么短」的补充说明：把该源类型实际会展开的字段列出来。
 * 目的是让用户明白这不是加载失败 —— 原来只有一片空白，读起来就是「坏了」。
 */
const structuredHint = computed(() => {
  const t = reader.value?.sourceType
  switch (t) {
    case 'todo':
      return '备注、子任务、附件摘要'
    case 'workout':
      return '训练组数、次数、重量、容量、备注'
    case 'meal':
      return '各食物克重与营养'
    case 'plan':
      return '动作、组次与强度'
    case 'body_metric':
      return '各项体测数值'
    case 'voice_memo':
      return '转写与要点'
    default:
      return ''
  }
})

/** 原始内容所在页面（派生投影只是给人看的索引，该去看真身）。
 *  只列**确实有独立页面**的源类型 —— 语音纪要走 voiceRuntime 浮层、没有路由可推，
 *  硬凑一个链接只会点出 404。 */
const ORIGIN: Partial<Record<KbSourceType, { path: string; label: string }>> = {
  todo: { path: '/todos', label: '待办' },
  workout: { path: '/sports/records', label: '运动记录' },
  meal: { path: '/nutrition', label: '营养' },
  body_metric: { path: '/nutrition', label: '营养' },
  food: { path: '/nutrition/foods', label: '食物库' },
  plan: { path: '/sports/plans', label: '课程库' },
  program: { path: '/program', label: '健康方案' },
  chat_message: { path: '/ai', label: 'AI 会话' },
}

const origin = computed(() => (reader.value ? ORIGIN[reader.value.sourceType] : undefined))
const originRoute = computed(() => origin.value?.path ?? null)
const originLabel = computed(() => origin.value?.label ?? '原页面')

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
  archiveReport.value = null
  archiveToDir.value = ''
  archiveOnly.value = ''
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
      archive: null,
      archiveErr: '',
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
  void loadUsage()
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
      <!-- 摘要块：**标题型记录的摘要就等于标题**，再渲染一次又是重复的一行。
           只在摘要确实带来新信息时才显示（与正文首行去重同一条理由）。 -->
      <p v-if="summaryText" class="summary">{{ summaryText }}</p>

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

      <!-- 压缩包：打开看内容 / 解压进工作区 -->
      <div v-if="archiveCandidate" class="archive">
        <div class="row actions">
          <button class="btn ghost" :disabled="archiveBusy" @click="openArchive">
            <PackageOpen :size="14" />
            {{ reader.archive ? '重新读取' : '打开压缩包' }}
          </button>
          <span class="t-3 hint-inline">按内容真解压：文本会成为可检索的笔记</span>
        </div>
        <p v-if="reader.archiveErr" class="err"><AlertCircle :size="13" /> {{ reader.archiveErr }}</p>

        <template v-if="reader.archive">
          <div class="meta row">
            <span class="pill">{{ reader.archive.format }}</span>
            <span class="pill">{{ reader.archive.total }} 项</span>
            <span class="pill">解压后 {{ humanBytes(reader.archive.totalBytes) }}</span>
            <span v-if="reader.archive.packedBytes > 0" class="pill">
              压缩包 {{ humanBytes(reader.archive.packedBytes) }}
            </span>
          </div>
          <p v-for="n in reader.archive.notes" :key="n" class="t-3 hint-inline">{{ n }}</p>

          <ul class="arc-list">
            <li v-for="e in reader.archive.entries.slice(0, 80)" :key="e.path" :class="{ dim: e.isDir }">
              <span class="arc-ic">
                <Folder v-if="e.isDir" :size="13" class="fic dim" />
                <FileText v-else-if="e.text" :size="13" class="fic" />
                <Paperclip v-else :size="13" class="fic dim" />
              </span>
              <span class="arc-path">{{ e.path }}</span>
              <span class="arc-size">{{ e.isDir ? '' : humanBytes(e.size) }}</span>
              <span v-if="e.skipped" class="arc-skip" :title="e.skipped">跳过</span>
            </li>
          </ul>
          <p v-if="reader.archive.total > 80" class="t-3 hint-inline">
            只显示前 80 项（共 {{ reader.archive.total }} 项），解压仍按全部执行。
          </p>

          <div class="arc-extract">
            <label class="arc-field">
              <span>解压到（留空 = 未分类数据/解压/包名）</span>
              <input v-model="archiveToDir" placeholder="笔记/课程资料" aria-label="解压目标目录">
            </label>
            <label class="arc-field">
              <span>只解压路径包含（逗号分隔，留空 = 全部）</span>
              <input v-model="archiveOnly" placeholder="复习, docx" aria-label="只解压匹配项">
            </label>
            <div class="row">
              <button class="btn" :disabled="archiveBusy" @click="doExtract">
                <Archive :size="14" /> {{ archiveBusy ? '处理中…' : '解压到工作区' }}
              </button>
            </div>
          </div>

          <div v-if="archiveReport" class="arc-report">
            <p class="arc-ok">{{ archiveReport.message }}</p>
            <ul>
              <li v-for="f in archiveReport.extracted.slice(0, 12)" :key="f.id">
                <button class="link" @click="openDoc(f.id)">{{ f.path }}</button>
                <span class="t-3">{{ humanBytes(f.bytes) }}</span>
              </li>
            </ul>
            <p v-for="n in archiveReport.skipped.slice(0, 5)" :key="n" class="t-3 hint-inline">{{ n }}</p>
          </div>
        </template>
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
          <!-- 正文（已剔掉与标题重复的首段）。空 = 这条记录真的只有标题，
               走下面的 .thin 说明，而不是留白。 -->
          <div v-if="bodyText" class="doc">{{ bodyText }}</div>
          <div v-else class="thin">
            <p class="thin-t">这条记录没有更多正文</p>
            <p class="thin-b">
              工作区里的{{ sourceLabel }}条目是按「标题 + 结构化字段」导出的投影<template
                v-if="structuredHint"
              >（{{ structuredHint }}）</template>，它本身没有可展开的长文。
              上面那些标签就是这条记录的全部信息；要改内容请回它自己的页面。
            </p>
            <button v-if="originRoute" class="btn" @click="router.push(originRoute)">
              去{{ originLabel }}
            </button>
          </div>

          <!-- 分页读取：只有走分块（非 note 真源直读）的文档才有"下一页" -->
          <div v-if="canPageMore && reader.hasMore" class="row more-row">
            <button class="btn ghost" :disabled="reader.loadingMore || reader.busy" @click="loadMore">
              {{ reader.loadingMore ? '加载中…' : `继续加载（${reader.chunks.length}/${reader.totalChunks} 块）` }}
            </button>
            <button class="btn ghost" :disabled="reader.busy" @click="loadAll">一次读完</button>
          </div>
          <p v-else-if="canPageMore && bodyText && reader.totalChunks > 1" class="t-3 fin">
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
      <section v-if="found !== null" class="card list list-found">
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

      <!-- 根目录：空间总览 + 最近内容 + 命名空间 -->
      <template v-else-if="!dir">
        <!-- 空间总览：总量一句话 + 可展开的分布（大文件榜 / 目录占比 / 碎片清理） -->
        <section v-if="usage" class="card usage">
          <button class="usage-head" @click="usageOpen = !usageOpen">
            <HardDrive :size="15" class="fic" />
            <span class="flex-1">
              <b>空间总览 · {{ humanBytes(usage.totalBytes) }}</b>
              <small>
                文本 {{ humanBytes(usage.textBytes) }} · 本体 {{ humanBytes(usage.assetBytes) }} · 索引
                {{ humanBytes(usage.indexBytes) }} · {{ usage.fileCount }} 个文件
              </small>
            </span>
            <ChevronRight :size="15" class="t-3" :class="{ rot: usageOpen }" />
          </button>

          <div v-show="usageOpen" class="usage-body">
            <div class="usage-sec">
              <h4>目录占用</h4>
              <div v-for="a in usage.areas.slice(0, 8)" :key="a.name" class="ubar">
                <span class="ubar-name">{{ a.name }}</span>
                <span class="ubar-track"><i :style="{ transform: `scaleX(${areaPct(a.bytes) / 100})` }" /></span>
                <span class="ubar-val">{{ humanBytes(a.bytes) }}</span>
              </div>
              <p v-if="!usage.areas.length" class="t-3 hint-inline">还没有内容</p>
            </div>

            <div class="usage-sec">
              <h4>大文件（文本 + 本体）</h4>
              <ul class="ubig">
                <li v-for="f in usage.largest.slice(0, 6)" :key="f.id">
                  <button class="link" @click="openDoc(f.id)">{{ f.path }}</button>
                  <span class="t-3">{{ humanBytes(f.bytes) }}</span>
                </li>
              </ul>
              <p v-if="!usage.largest.length" class="t-3 hint-inline">还没有文件</p>
            </div>

            <div class="usage-sec">
              <h4>存储明细</h4>
              <p class="t-3 hint-inline">
                索引 {{ humanBytes(usage.indexBytes) }}（删源数据会自然缩回）· 数据库
                {{ humanBytes(usage.dbBytes) }} · 本体 {{ usage.assetCount }} 个
                <template v-if="usage.missingCount">
                  · <span class="bad">{{ usage.missingCount }} 个本体文件丢失</span>
                </template>
              </p>
              <div v-if="usage.orphanCount > 0" class="row orphans">
                <span class="flex-1">
                  发现 {{ usage.orphanCount }} 个没人引用的本体碎片（{{ humanBytes(usage.orphanBytes) }}）
                </span>
                <button class="btn ghost tiny" :class="{ danger: cleanConfirm }" :disabled="cleaning" @click="cleanOrphans">
                  <Trash2 :size="13" /> {{ cleaning ? '清理中…' : cleanConfirm ? '确认清理?' : '清理' }}
                </button>
              </div>
              <p v-else class="t-3 hint-inline">没有发现可回收的碎片。</p>
            </div>
          </div>
        </section>

        <section class="card list list-recent">
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

        <!-- 顶层目录：一行一个（像文件管理器左侧的「位置」栏），不做方块网格 -->
        <section class="card list list-roots">
          <h3 class="sec">顶层目录</h3>
          <ul>
            <li v-for="e in rootEntries" :key="e.name">
              <button class="row item" @click="openDir(e.name)">
                <component :is="e.icon" :size="16" class="fic" />
                <span class="flex-1">
                  <b>{{ e.name }}</b>
                  <small>{{ e.hint }}</small>
                </span>
                <span v-if="e.count > 0" class="t-3 dcount">{{ e.count }} 项</span>
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
          </ul>
        </section>

        <section v-if="files.length" class="card list list-files">
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

        <section class="card list list-dir">
          <!-- 「..」不跟着空状态走：空目录也要留一条回退的路（真实文件管理器就是这样） -->
          <ul>
            <li>
              <button class="row item" @click="jumpCrumb(crumbs.length - 2)">
                <CornerLeftUp :size="16" class="fic dim" />
                <span class="flex-1">
                  <b>..</b>
                  <small>{{ crumbs.length > 1 ? crumbs[crumbs.length - 2] : '文件' }}</small>
                </span>
              </button>
            </li>
            <li v-for="d in dirs" :key="d.path">
              <button class="row item" @click="openDir(d.path)">
                <Folder :size="16" class="fic" />
                <span class="flex-1"><b>{{ d.name }}</b><small>目录</small></span>
                <span class="t-3 dcount">{{ d.count }} 项</span>
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
            <li v-for="f in files" :key="`${f.sourceType}-${f.id}`">
              <button class="row item" @click="openDoc(f.id)">
                <component :is="kindIcon(f.kind)" :size="16" class="fic" :class="{ dim: f.system }" />
                <span class="flex-1">
                  <b>{{ baseName(f.path) }}</b>
                  <small v-if="f.occurredOn">{{ f.occurredOn }}</small>
                </span>
                <Lock v-if="f.system" :size="12" class="t-3" />
                <ChevronRight :size="15" class="t-3" />
              </button>
            </li>
          </ul>
          <p v-if="!dirs.length && !files.length" class="t-3 hint-line">
            {{ listingBusy ? '加载中…' : '此目录还没有文件' }}
          </p>
          <!-- 状态栏一行：目录 / 文件计数 + 当前路径，像文件管理器底部的信息栏 -->
          <p class="listing-meta t-3">
            {{ dirs.length }} 个目录 · {{ files.length }} 个文件 · /{{ dir }}
          </p>
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

/* 状态栏一行（目录 / 文件计数 + 当前路径）：像文件管理器底部的信息栏 */
.listing-meta {
  padding: 9px 0 7px;
  border-top: 0.5px solid var(--line);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-micro);
  overflow-wrap: anywhere;
}

/* 桌面指针：整行给出可点反馈（移动端靠 :active，不要 hover 残留） */
@media (hover: hover) {
  .item:hover {
    background: var(--surface-2);
    border-radius: var(--radius-m);
  }
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
.hint-inline {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.rot {
  transform: rotate(90deg);
}

/* 空间总览 */
.usage {
  display: grid;
  gap: 0;
  padding: 10px 12px;
}
.usage-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  color: var(--text-1);
}
.usage-head b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 600;
}
.usage-head small {
  display: block;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-top: 2px;
}
.usage-head .rot {
  transition: transform 0.2s var(--ease-standard);
}
.usage-body {
  display: grid;
  gap: 12px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.usage-sec {
  display: grid;
  gap: 5px;
}
.usage-sec h4 {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-weight: 600;
}
.ubar {
  display: grid;
  grid-template-columns: 68px 1fr 62px;
  gap: 8px;
  align-items: center;
  font-size: var(--fs-caption);
  color: var(--text-1);
}
.ubar-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ubar-track {
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
.ubar-track i {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: 0 50%;
}
.ubar-val {
  text-align: right;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ubig {
  display: grid;
  gap: 4px;
  list-style: none;
}
.ubig li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-caption);
}
.ubig .link {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orphans {
  align-items: center;
  padding: 6px 8px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  color: var(--text-1);
}
.bad {
  color: var(--danger);
}

/* 压缩包面板 */
.archive {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.arc-list {
  display: grid;
  gap: 3px;
  max-height: 260px;
  overflow-y: auto;
  list-style: none;
  font-size: var(--fs-caption);
}
.arc-list li {
  display: grid;
  grid-template-columns: 18px 1fr auto auto;
  gap: 6px;
  align-items: center;
  color: var(--text-1);
}
.arc-list li.dim {
  color: var(--text-2);
}
.arc-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: var(--fs-micro);
}
.arc-size {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.arc-skip {
  color: var(--danger);
  font-size: var(--fs-micro);
}
.arc-extract {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.arc-field {
  display: grid;
  gap: 3px;
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.arc-field input {
  padding: 7px 9px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text-1);
  font-size: var(--fs-footnote);
}
.arc-report {
  display: grid;
  gap: 4px;
  font-size: var(--fs-caption);
}
.arc-ok {
  color: var(--accent);
}
.arc-report ul {
  display: grid;
  gap: 3px;
  list-style: none;
}
.arc-report li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

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

/* 「这条记录没有更多正文」：派生文档只带标题与结构化字段，而那些字段已经在
   上面的 pills 里说过了 —— 正文区于是常常是空的。原先直接留白，用户读到的是
   「文件坏了」；这里把原因讲清，并把人送回真身所在页面。 */
.thin {
  margin-top: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: center;
}

.thin-t {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}

.thin-b {
  margin: 6px auto 0;
  max-width: 34em;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-2);
}

.thin .btn {
  margin-top: 12px;
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

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   这页是 wide 路由：主人区整宽自负，没有壳层的两栏栅格，
   所以「宽浏览面」= 每张列表卡通栏 + 卡内列表按多栏流铺开。
   ============================================================ */

/* 宽形态页面的内容上限，超过就不再拉长行 */
.desk-main .page {
  max-width: var(--desk-wide);
}

/* 列表卡内部多栏流：根目录有近 20 个顶层目录、每个只有「图标 + 名词 + 计数」，
   一列排到 970px 宽、一屏只看得下几个 —— 桌面上按栏摊开才叫文件浏览面。
   用 columns 而不是 grid：条目高度参差（有的带日期、有的带锁标），
   grid 会把同行撑到最高的那条，留下锯齿状空白。 */
.desk-main .card.list > ul {
  columns: var(--b-cols, 2);
  column-gap: var(--desk-gap);
}

.desk-main .card.list > ul > li {
  break-inside: avoid;
}

/* 顶层目录条目最短（图标 + 名称 + 说明 + 项数），三栏摊得开；
   最近内容/根目录文件带路径或日期，两栏给足宽度 */
.desk-main .card.list.list-roots > ul {
  --b-cols: 3;
}

/* 阅读器：正文一行 80+ 字就没人读得下去。这页没有侧栏可放元信息，
   所以把阅读卡收成一张居中的定宽卡（≈ 820px，约 55 字/行），
   两侧留白是对称的——看上去是「一张阅读卡」，不是「右边空着」。 */
.desk-main .page > .card.reader {
  max-width: 820px;
  margin-inline: auto;
}
</style>
