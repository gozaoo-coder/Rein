<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertCircle,
  Brain,
  Database,
  FilePlus2,
  FolderOpen,
  FolderTree,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { kbService } from '@/services/kbService'
import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import {
  KB_MEMORY_LABELS,
  KB_SOURCE_LABELS,
  type KbChunk,
  type KbEmbeddingMode,
  type KbGlobHit,
  type KbHit,
  type KbMemory,
  type KbSettings,
  type KbSourceType,
  type KbStatus,
} from '@/types'

/** 知识库 · 二级页：检索模式切换 + 索引概况 + 检索试跑 + 长期记忆审阅。
 *  三档模式是这个页面的核心：keyword 零依赖、local 数据不出设备、cloud 用外部端点。 */

const toast = useToast()
const ai = useAiStore()
const router = useRouter()

const status = ref<KbStatus | null>(null)
const settings = ref<KbSettings | null>(null)
const busy = ref(false)
const probing = ref(false)

const mode = ref<KbEmbeddingMode>('keyword')
const cloudBaseUrl = ref('')
const cloudApiKey = ref('')
const cloudModel = ref('')
const autoMemory = ref(true)

const query = ref('')
const hits = ref<KbHit[] | null>(null)
const searching = ref(false)

const memories = ref<KbMemory[]>([])

/* ---------- 虚拟文件系统：glob 浏览 + 笔记编辑 + 分页阅读 ---------- */

const globPattern = ref('笔记/*.md')
const globHits = ref<KbGlobHit[] | null>(null)
const globbing = ref(false)

interface EditorState {
  id: number | null
  path: string
  content: string
  system: boolean
  isNew: boolean
}
const editor = ref<EditorState | null>(null)
const saving = ref(false)

interface ReaderState {
  docId: number
  level: 'l1' | 'l2'
  offset: number
  totalChunks: number
  hasMore: boolean
  chunks: KbChunk[]
  title: string
  path: string | null
  editable: boolean
}
const reader = ref<ReaderState | null>(null)
const reading = ref(false)

const modeOptions = [
  { value: 'keyword', label: '关键词' },
  { value: 'local', label: '本地模型' },
  { value: 'cloud', label: '云端' },
]

const allSources: KbSourceType[] = [
  'todo', 'workout', 'plan', 'meal', 'body_metric',
  'food', 'program', 'program_meal', 'voice_memo', 'chat_message', 'memory',
]

const sourceEnabled = ref<Record<string, boolean>>({})

const progressPct = computed(() => {
  const p = status.value?.progress
  if (!p || p.total <= 0) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

async function refresh(): Promise<void> {
  const [s, st, mem] = await Promise.all([
    kbService.settingsGet(),
    kbService.status(),
    kbService.memories(),
  ])
  settings.value = s
  status.value = st
  memories.value = mem
  mode.value = s.embeddingMode
  cloudBaseUrl.value = s.cloudBaseUrl ?? ''
  cloudModel.value = s.cloudModel ?? ''
  cloudApiKey.value = ''
  autoMemory.value = s.autoMemory
  sourceEnabled.value = { ...(s.sourcesEnabled as Record<string, boolean>) }
}

onMounted(() => {
  void refresh().catch((e) => toast.toast(e instanceof Error ? e.message : String(e)))
})

/** 逐类开关：只在真正修改时写库，避免每次点击都发一次 IPC */
async function toggleSource(t: KbSourceType): Promise<void> {
  const next = !(sourceEnabled.value[t] ?? true)
  sourceEnabled.value = { ...sourceEnabled.value, [t]: next }
  await saveSettings()
}

async function saveSettings(): Promise<void> {
  busy.value = true
  try {
    const input: Record<string, unknown> = {
      embeddingMode: mode.value,
      sourcesEnabled: sourceEnabled.value,
      autoMemory: autoMemory.value,
    }
    if (mode.value === 'cloud') {
      input.cloudBaseUrl = cloudBaseUrl.value.trim()
      input.cloudModel = cloudModel.value.trim()
      // 留空 = 不改动已存的密钥（后端拿不到明文，无法回传）
      if (cloudApiKey.value.trim()) input.cloudApiKey = cloudApiKey.value.trim()
    }
    settings.value = await kbService.settingsSet(input)
    cloudApiKey.value = ''
    status.value = await kbService.status()
    toast.toast('已保存')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

async function probe(): Promise<void> {
  probing.value = true
  try {
    const dim = await kbService.probeEmbedder()
    toast.toast(`嵌入后端可用，向量维度 ${dim}`)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    probing.value = false
  }
}

async function rebuild(): Promise<void> {
  busy.value = true
  try {
    const n = await kbService.reindex()
    toast.toast(`已重新入队 ${n} 条`)
    status.value = await kbService.status()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

async function runSearch(): Promise<void> {
  searching.value = true
  try {
    hits.value = await kbService.search({ query: query.value.trim(), limit: 12 })
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    searching.value = false
  }
}

async function runGlob(): Promise<void> {
  globbing.value = true
  try {
    globHits.value = await kbService.glob(globPattern.value.trim() || '笔记/*.md', 200)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    globbing.value = false
  }
}

function openNewNote(): void {
  editor.value = { id: null, path: '', content: '', system: false, isNew: true }
}

async function openNote(hit: KbGlobHit): Promise<void> {
  // 只读文档走阅读器；可写的真实文件才进编辑器
  if (!hit.editable) {
    await openReader(hit.id)
    return
  }
  try {
    const f = await kbService.fileGet(hit.id)
    editor.value = { id: f.id, path: f.path, content: f.content, system: f.system, isNew: false }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

async function saveNote(): Promise<void> {
  const ed = editor.value
  if (!ed) return
  saving.value = true
  try {
    if (ed.id === null) {
      const f = await kbService.fileWrite({ path: ed.path.trim(), content: ed.content })
      ed.id = f.id
      ed.path = f.path
      ed.isNew = false
    } else {
      // 已有文件：内容用 write（按路径幂等覆盖），路径改了走 rename
      const cur = await kbService.fileGet(ed.id)
      if (ed.path.trim() !== cur.path) {
        const f = await kbService.fileRename(ed.id, ed.path.trim())
        ed.path = f.path
      }
      if (ed.content !== cur.content) {
        await kbService.fileWrite({ path: ed.path, content: ed.content })
      }
    }
    ai.invalidateCognitionCache()
    toast.toast('已保存')
    await refresh()
    await runGlob()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

async function removeNote(): Promise<void> {
  const ed = editor.value
  if (!ed || ed.id === null) return
  try {
    await kbService.fileDelete(ed.id)
    editor.value = null
    ai.invalidateCognitionCache()
    toast.toast('已删除该笔记')
    await refresh()
    await runGlob()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 打开分页阅读器（检索命中与只读文档共用） */
async function openReader(docId: number, level: 'l1' | 'l2' = 'l1', offset = 0): Promise<void> {
  reading.value = true
  try {
    const d = await kbService.read(docId, level, offset, level === 'l1' ? 1 : 8)
    reader.value = {
      docId: d.id,
      level: d.level as 'l1' | 'l2',
      offset: d.offset,
      totalChunks: d.totalChunks,
      hasMore: d.hasMore,
      chunks: d.chunks,
      title: d.title,
      path: d.path,
      editable: d.editable,
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    reading.value = false
  }
}

async function readerPage(delta: number): Promise<void> {
  const r = reader.value
  if (!r) return
  const next = Math.max(0, r.offset + delta * 8)
  await openReader(r.docId, r.level, next)
}

async function removeMemory(id: number): Promise<void> {
  try {
    await kbService.memoryDelete(id)
    memories.value = memories.value.filter((m) => m.id !== id)
    // 让下一轮对话的认知注入立刻反映改动，而不是等 TTL 过期
    ai.invalidateCognitionCache()
    toast.toast('已删除该条记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="kb-page">
    <PageHeader title="知识库" subtitle="让 AI 记得住你" back />

    <div class="scroll">
      <!-- 索引概况 -->
      <section class="card">
        <div class="card-head">
          <Database :size="16" />
          <h2>索引概况</h2>
          <span v-if="status" class="chip" :class="{ on: status.indexing }">
            {{ status.indexing ? '索引中' : '空闲' }}
          </span>
        </div>
        <div v-if="status" class="stats">
          <div><b>{{ status.docs }}</b><span>条目</span></div>
          <div><b>{{ status.chunks }}</b><span>分块</span></div>
          <div><b>{{ status.vectors }}</b><span>向量</span></div>
          <div><b>{{ status.pending }}</b><span>待处理</span></div>
        </div>
        <div v-if="status?.indexing" class="bar"><i :style="{ width: `${progressPct}%` }" /></div>
        <p v-if="status?.lastError" class="err">
          <AlertCircle :size="14" /> {{ status.lastError }}
        </p>
        <p v-if="status && !status.embedderReady" class="hint">
          当前模式的嵌入后端未就绪，检索会自动降级为关键词匹配。
        </p>
      </section>

      <!-- 检索模式 -->
      <section class="card">
        <div class="card-head"><Search :size="16" /><h2>检索模式</h2></div>
        <SegmentedControl v-model="mode" :options="modeOptions" />
        <p class="hint">
          <template v-if="mode === 'keyword'">
            纯关键词匹配（内置 trigram 全文索引）。零依赖、全部设备可用、瞬时生效。
          </template>
          <template v-else-if="mode === 'local'">
            进程内运行内置的 bge-small-zh 模型，语义检索、数据不出设备。首次启用会有一段时间的后台建索引。
          </template>
          <template v-else>
            调用 OpenAI 兼容的 <code>/v1/embeddings</code> 端点。速度快，但索引文本会发送到该服务商。
          </template>
        </p>

        <div v-if="mode === 'cloud'" class="fields">
          <label>
            <span>Base URL</span>
            <input v-model="cloudBaseUrl" type="url" placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>API Key</span>
            <input
              v-model="cloudApiKey"
              type="password"
              :placeholder="settings?.cloudApiKeyTail ? `已保存 ${settings.cloudApiKeyTail}（留空不改）` : 'sk-...'"
            />
          </label>
          <label>
            <span>模型名</span>
            <input v-model="cloudModel" type="text" placeholder="bge-m3" />
          </label>
        </div>

        <div class="row">
          <button class="btn" :disabled="busy" @click="saveSettings">保存</button>
          <button v-if="mode !== 'keyword'" class="btn ghost" :disabled="probing" @click="probe">
            {{ probing ? '测试中…' : '测试嵌入' }}
          </button>
          <button class="btn ghost" :disabled="busy" @click="rebuild">
            <RefreshCw :size="14" /> 重建索引
          </button>
        </div>
      </section>

      <!-- 索引范围 -->
      <section class="card">
        <div class="card-head"><h2>索引范围</h2></div>
        <div class="toggles">
          <button
            v-for="t in allSources"
            :key="t"
            type="button"
            class="toggle"
            :class="{ on: sourceEnabled[t] ?? true }"
            @click="toggleSource(t)"
          >
            {{ KB_SOURCE_LABELS[t] }}
          </button>
        </div>
        <label class="switch">
          <input v-model="autoMemory" type="checkbox" @change="saveSettings" />
          <span>会话结束时自动提炼长期记忆</span>
        </label>
      </section>

      <!-- 检索试跑 -->
      <section class="card">
        <div class="card-head"><Search :size="16" /><h2>检索试跑</h2></div>
        <div class="searchbar">
          <input
            v-model="query"
            type="search"
            placeholder="如「膝盖」「腿部训练」（留空看最近内容）"
            @keyup.enter="runSearch"
          />
          <button class="btn" :disabled="searching" @click="runSearch">
            {{ searching ? '…' : '搜索' }}
          </button>
        </div>
        <ul v-if="hits?.length" class="hits">
          <li v-for="h in hits" :key="`${h.sourceType}-${h.id}`" class="clickable" @click="openReader(h.id)">
            <div class="hit-head">
              <span class="src">{{ KB_SOURCE_LABELS[h.sourceType] ?? h.sourceType }}</span>
              <span v-if="h.path" class="hpath">{{ h.path }}</span>
              <span class="date">{{ h.occurredOn ?? '' }}</span>
              <span class="matched">{{ h.matched }}</span>
            </div>
            <p class="hit-title">{{ h.title }}</p>
            <p class="hit-snippet">{{ h.snippet }}</p>
          </li>
        </ul>
        <EmptyState
          v-else-if="hits"
          :icon="Search"
          title="没有命中"
          hint="换个更短的关键词，或去掉日期限制再试"
        />
      </section>

      <!-- 阅读器：L1/L2 切换 + 分页 -->
      <section v-if="reader" class="card">
        <div class="card-head">
          <h2 class="rt">{{ reader.title }}</h2>
          <button class="x" aria-label="关闭阅读器" @click="reader = null">✕</button>
        </div>
        <p v-if="reader.path" class="hpath big">{{ reader.path }}</p>
        <div class="seg-mini">
          <button
            type="button"
            :class="{ on: reader.level === 'l1' }"
            @click="openReader(reader.docId, 'l1')"
          >概览</button>
          <button
            type="button"
            :class="{ on: reader.level === 'l2' }"
            @click="openReader(reader.docId, 'l2', 0)"
          >全文</button>
          <span v-if="reader.level === 'l2'" class="pager">
            <button :disabled="reader.offset <= 0 || reading" @click="readerPage(-1)">上一页</button>
            <em>{{ reader.totalChunks ? reader.offset + 1 : 0 }}–{{ reader.offset + reader.chunks.length }} / {{ reader.totalChunks }} 块</em>
            <button :disabled="!reader.hasMore || reading" @click="readerPage(1)">下一页</button>
          </span>
        </div>
        <div v-if="reader.level === 'l2'" class="doc-body">
          <p v-for="c in reader.chunks" :key="c.id">{{ c.text }}</p>
        </div>
        <p v-else class="doc-body sum">{{ reader.chunks[0]?.text }}</p>
      </section>

      <!-- 文件区：glob 浏览 + 笔记编辑 -->
      <section class="card">
        <div class="card-head">
          <FolderTree :size="16" />
          <h2>文件</h2>
          <button class="mini" @click="router.push('/ai/knowledge/files')">
            <FolderOpen :size="13" /> 文件库
          </button>
          <button class="mini" @click="openNewNote"><FilePlus2 :size="13" /> 新建笔记</button>
        </div>
        <div class="searchbar">
          <input
            v-model="globPattern"
            type="text"
            placeholder="路径模式：笔记/*.md、对话/**、附件/**、日程/2026-09-10/*.md"
            @keyup.enter="runGlob"
          />
          <button class="btn" :disabled="globbing" @click="runGlob">
            {{ globbing ? '…' : '浏览' }}
          </button>
        </div>
        <p class="hint">星号不跨目录、双星跨目录；只读目录（日程/运动/…）来自应用数据，改内容请去对应功能。</p>
        <ul v-if="globHits?.length" class="files">
          <li v-for="f in globHits" :key="`${f.sourceType}-${f.id}`" class="clickable" @click="openNote(f)">
            <component :is="f.system ? Lock : Pencil" :size="13" class="fic" :class="{ ro: !f.editable }" />
            <span class="fpath">{{ f.path }}</span>
            <span class="ftag">{{ f.editable ? (f.system ? '系统' : '可编辑') : '只读' }}</span>
          </li>
        </ul>
        <p v-else-if="globHits" class="hint">没有匹配的路径。</p>

        <!-- 编辑器 -->
        <div v-if="editor" class="editor">
          <label class="epath">
            <span>路径</span>
            <input v-model="editor.path" type="text" :disabled="editor.system" />
          </label>
          <textarea
            v-model="editor.content"
            rows="10"
            placeholder="markdown 正文"
            :disabled="editor.system"
          />
          <div class="row">
            <button class="btn" :disabled="saving || editor.system" @click="saveNote">
              {{ saving ? '保存中…' : editor.isNew ? '创建' : '保存' }}
            </button>
            <button
              v-if="!editor.isNew && !editor.system"
              class="btn ghost"
              :disabled="saving"
              @click="removeNote"
            >
              <Trash2 :size="14" /> 删除
            </button>
            <button class="btn ghost" @click="editor = null">关闭</button>
          </div>
          <p v-if="editor.system" class="hint">系统文件随应用版本更新，内容只读。</p>
        </div>
      </section>

      <!-- 长期记忆 -->
      <section class="card">
        <div class="card-head">
          <Brain :size="16" />
          <h2>长期记忆</h2>
          <span class="chip">{{ memories.length }}</span>
        </div>
        <ul v-if="memories.length" class="mems">
          <li v-for="m in memories" :key="m.id">
            <div class="mem-head">
              <span class="type">{{ KB_MEMORY_LABELS[m.memType] ?? m.memType }}</span>
              <span v-if="m.topic" class="topic">{{ m.topic }}</span>
            </div>
            <p class="mem-text">{{ m.content }}</p>
            <button class="del" aria-label="删除该条记忆" @click="removeMemory(m.id)">
              <Trash2 :size="14" />
            </button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Brain"
          title="还没有长期记忆"
          hint="默认会在每次会话结束时自动提炼。也可以直接对 AI 说「记住……」"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.hpath {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-3);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hpath.big {
  max-width: 100%;
  margin-bottom: 8px;
}
.clickable {
  cursor: pointer;
}
.clickable:hover .hit-title {
  color: var(--accent);
}
.x {
  border: none;
  background: none;
  color: var(--text-3);
  padding: 4px;
}
.rt {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg-mini {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.seg-mini button {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
}
.seg-mini button.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}
.seg-mini .pager {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.seg-mini .pager em {
  font-style: normal;
}
.doc-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.doc-body.sum {
  color: var(--text-2);
}
.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: 12px;
}
.files {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
}
.files li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  font-size: 12.5px;
}
.fic {
  flex: none;
  color: var(--accent);
}
.fic.ro {
  color: var(--text-3);
}
.fpath {
  flex: 1;
  font-family: ui-monospace, monospace;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ftag {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}
.editor {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.epath {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.epath span {
  font-size: 12px;
  color: var(--text-2);
}
textarea {
  width: 100%;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.6;
  font-family: ui-monospace, monospace;
  resize: vertical;
}

.kb-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px calc(24px + var(--wbar-reserve, 0px));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.card-head h2 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  flex: 1;
}
.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.stats div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.stats b {
  font-size: 17px;
  color: var(--text-1);
}
.stats span {
  font-size: 11px;
  color: var(--text-3);
}
.bar {
  margin-top: 10px;
  height: 4px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger);
  display: flex;
  align-items: center;
  gap: 4px;
}
.hint {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
.hint code {
  font-size: 11px;
  background: var(--surface-2);
  padding: 1px 4px;
  border-radius: 4px;
}
.fields {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fields span {
  font-size: 12px;
  color: var(--text-2);
}
input {
  width: 100%;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: 14px;
}
.row {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px;
  border-radius: 10px;
  border: none;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 500;
}
.btn.ghost {
  background: var(--surface-2);
  color: var(--text-1);
}
.btn:disabled {
  opacity: 0.5;
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.toggle {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 12px;
}
.toggle.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}
.switch {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-1);
}
.switch input {
  width: auto;
}
.searchbar {
  display: flex;
  gap: 8px;
}
.hits {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hits li {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.hit-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.src {
  color: var(--accent);
}
.matched {
  margin-left: auto;
  font-family: ui-monospace, monospace;
}
.hit-title {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
}
.hit-snippet {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
}
.mems {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mems li {
  position: relative;
  border-top: 1px solid var(--line);
  padding-top: 10px;
  padding-right: 28px;
}
.mem-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.type {
  color: var(--accent);
}
.topic {
  color: var(--text-3);
}
.mem-text {
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-1);
}
.del {
  position: absolute;
  top: 8px;
  right: 0;
  padding: 4px;
  border: none;
  background: none;
  color: var(--text-3);
}
</style>
