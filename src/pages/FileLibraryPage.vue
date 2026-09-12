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
  Folder,
  Image as ImageIcon,
  Lock,
  MessagesSquare,
  Mic,
  NotebookPen,
  Paperclip,
  Pencil,
  Scale,
  Search,
  ShieldCheck,
  Soup,
  Target,
  Trash2,
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
  type KbGlobHit,
  type KbHit,
  type KbSourceType,
} from '@/types'

/** 文件库 · AI 可见文件树（docs/kb-vfs.md）的浏览界面。
 *  根目录 = 最近内容 + 命名空间网格；下钻走 glob 目录列举 + 面包屑。
 *  阅读保证完整：note 源（笔记 / 上传文档归档）直读 kb_files 真源原文，
 *  派生文档按 L2 分块渐进加载到末尾。 */

const ai = useAiStore()
const toast = useToast()

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 目录列举的单次拉取上限（服务端 glob 上限 500） */
const GLOB_LIMIT = 500
/** 阅读器每次加载的块数（kb_read 上限 64） */
const PAGE_CHUNKS = 24

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

const NAMESPACES = [
  { name: '文档', icon: FileText, hint: '上传文档全文' },
  { name: '笔记', icon: NotebookPen, hint: '可编辑笔记' },
  { name: '日程', icon: CalendarDays, hint: '待办与安排' },
  { name: '附件', icon: Paperclip, hint: '图片·音频·文件' },
  { name: '对话', icon: MessagesSquare, hint: '会话转录' },
  { name: '纪要', icon: Mic, hint: '语音纪要' },
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

const crumbs = computed(() => (dir.value ? dir.value.split('/') : []))

async function loadDir(path: string): Promise<void> {
  listingBusy.value = true
  try {
    const hits = await kbService.glob(`${path}/**`, GLOB_LIMIT)
    const map = new Map<string, number>()
    const fs: KbGlobHit[] = []
    const prefix = `${path}/`
    for (const h of hits) {
      const rel = h.path.slice(prefix.length)
      const slash = rel.indexOf('/')
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

/** k = -1 回根目录 */
function jumpCrumb(k: number): void {
  const path = k < 0 ? '' : crumbs.value.slice(0, k + 1).join('/')
  if (path === dir.value) return
  if (!path) {
    dir.value = ''
    return
  }
  openDir(path)
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
}

const reader = ref<ReaderState | null>(null)

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function kindIcon(f: KbGlobHit) {
  return f.kind === 'image' ? ImageIcon : f.kind === 'audio' ? FileAudio : f.kind === 'file' ? Paperclip : FileText
}

const sourceLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  if (r.sourceType !== 'note') return KB_SOURCE_LABELS[r.sourceType] ?? r.sourceType
  // 归档文档与笔记同为 note 源，用路径前缀区分展示
  return r.path?.startsWith('文档/') ? '文档归档' : '笔记'
})

const sizeLabel = computed(() => {
  const r = reader.value
  if (!r) return ''
  return r.raw !== null ? `${r.chars.toLocaleString()} 字` : `共 ${r.totalChunks} 块`
})

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
    }
    if (d.sourceType === 'note') {
      // 真源直读：kb_docs.body 是带截断上限的检索缓存，原文才完整
      const f = await kbService.fileGet(d.id)
      r.raw = f.content
      r.fileId = f.id
      r.chars = f.content.length
      r.system = f.system
      r.editable = !f.system
    }
    reader.value = r
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

/* ---------- 可编辑文件的保存 / 删除 ---------- */

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
    await kbService.fileWrite({ path: r.path ?? '', content: r.editContent })
    r.raw = r.editContent
    r.chars = r.editContent.length
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
    if (dir.value) await loadDir(dir.value)
  } catch (e) {
    toast.toast(errMsg(e))
    r.busy = false
  }
}

onMounted(async () => {
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
    <PageHeader back title="文件库" subtitle="浏览 AI 能看到的全部文件与记录" />

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
        <span class="pill">{{ sizeLabel }}</span>
      </div>
      <div v-if="reader.tags.length" class="tags row">
        <span v-for="t in reader.tags" :key="t" class="tag">{{ t }}</span>
      </div>
      <p v-if="reader.summary" class="summary">{{ reader.summary }}</p>

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

      <div v-if="reader.raw !== null && reader.editable && !reader.editing" class="row actions">
        <button class="btn ghost" :disabled="reader.busy" @click="startEdit">
          <Pencil :size="14" /> 编辑
        </button>
        <button class="btn ghost danger" :disabled="reader.busy" @click="removeFile">
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
      </div>

      <!-- 文件名搜索结果 -->
      <section v-if="found !== null" class="card list">
        <ul v-if="found.length">
          <li v-for="f in found" :key="`${f.sourceType}-${f.id}`">
            <button class="row item" @click="openDoc(f.id)">
              <component :is="kindIcon(f)" :size="15" class="fic" :class="{ dim: f.system }" />
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
      </template>

      <!-- 子目录：面包屑 + 子目录 + 文件 -->
      <template v-else>
        <div class="crumbs row">
          <button class="crumb" @click="jumpCrumb(-1)">文件库</button>
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
                <component :is="kindIcon(f)" :size="15" class="fic" :class="{ dim: f.system }" />
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
  font-size: var(--fs-subhead);
}

.clear {
  padding: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-3);
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
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 14px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: #fff;
  font-size: var(--fs-footnote);
  font-weight: 600;
}

.btn.ghost {
  background: var(--surface-2);
  color: var(--text-1);
}

.btn.ghost.danger {
  color: var(--danger, #e5484d);
}

.btn:disabled {
  opacity: 0.5;
}
</style>
