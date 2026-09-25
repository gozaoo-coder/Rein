<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  AlertCircle,
  Archive,
  Brain,
  Database,
  FilePlus2,
  FolderOpen,
  FolderTree,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { kbService, onKbIndexProgress } from '@/services/kbService'
import { useAiStore } from '@/stores/ai'
import { useToast } from '@/composables/useToast'
import {
  KB_MEMORY_LABELS,
  KB_SOURCE_LABELS,
  type KbChunk,
  type KbEmbeddingMode,
  type KbHit,
  type KbIndexEvent,
  type KbMemory,
  type KbMemoryStats,
  type KbSettings,
  type KbSourceType,
  type KbStatus,
} from '@/types'

/** 知识库 · 二级页。信息架构按到访频率排布：
 *  主体只有三块 —— 检索（高频入口，置顶）、长期记忆（AI 记住了什么）、文件（新建笔记 + 文件库入口）。
 *  低频的机器层（嵌入模式 / 索引范围 / 索引概况 / 云端配置）收进「检索设置」抽屉；
 *  文档阅读用全高抽屉，不再往页面中段插卡。 */

const toast = useToast()
const ai = useAiStore()
const router = useRouter()

const status = ref<KbStatus | null>(null)
/** kb://index 订阅的退订句柄（卸载时释放，否则重挂载会重复派发） */
let offIndex: (() => void) | null = null
const settings = ref<KbSettings | null>(null)
const busy = ref(false)
const probing = ref(false)
const settingsOpen = ref(false)

const mode = ref<KbEmbeddingMode>('keyword')
const cloudBaseUrl = ref('')
const cloudApiKey = ref('')
const cloudModel = ref('')
const autoMemory = ref(true)
const autoConsolidate = ref(true)

const query = ref('')
const hits = ref<KbHit[] | null>(null)
const searching = ref(false)

const memories = ref<KbMemory[]>([])
const memoryStats = ref<KbMemoryStats | null>(null)
/** 记忆列表视角：false（默认）只看活跃；true 连归档一起看（归档可恢复） */
const showArchived = ref(false)
const maintaining = ref(false)
const consolidating = ref(false)
/** 信噪比详情的展开态（默认只给一句结论，数字墙收起来） */
const snrDetail = ref(false)

/** 显著性低于 0.15 视为「低信号」：界面标出来，和 Rust 侧 STALE_SALIENCE 一致 */
const STALE_SALIENCE = 0.15

const visibleMemories = computed(() =>
  showArchived.value ? memories.value : memories.value.filter((m) => !m.archivedAt),
)

const archivedCount = computed(() => memories.value.filter((m) => m.archivedAt).length)

/* ---------- 检索设置抽屉 ---------- */

const modeOptions = [
  { value: 'keyword', label: '关键词' },
  { value: 'local', label: '本地模型' },
  { value: 'cloud', label: '云端' },
]

const modeLabel = computed(() => modeOptions.find((o) => o.value === mode.value)?.label ?? '关键词')

/** 抽屉入口的警示点：索引进行中，或当前档位的语义后端没准备好 */
const modeWarn = computed(() => {
  if (!status.value) return false
  if (status.value.indexing) return true
  return mode.value !== 'keyword' && !status.value.embedderReady
})

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
  const [s, st, mem, stats] = await Promise.all([
    kbService.settingsGet(),
    kbService.status(),
    kbService.memories(undefined, 'all'),
    kbService.memoryStats(),
  ])
  settings.value = s
  status.value = st
  memories.value = mem
  memoryStats.value = stats
  mode.value = s.embeddingMode
  cloudBaseUrl.value = s.cloudBaseUrl ?? ''
  cloudModel.value = s.cloudModel ?? ''
  cloudApiKey.value = ''
  autoMemory.value = s.autoMemory
  autoConsolidate.value = s.autoConsolidate
  sourceEnabled.value = { ...(s.sourcesEnabled as Record<string, boolean>) }
}

/** 只刷新记忆区（记忆操作后调用；不必整页重来） */
async function refreshMemories(): Promise<void> {
  const [mem, stats] = await Promise.all([
    kbService.memories(undefined, 'all'),
    kbService.memoryStats(),
  ])
  memories.value = mem
  memoryStats.value = stats
}

/** 索引进度推送：worker 每推进一轮推一条，就地更新状态条（不必等下一次 kb_status 快照） */
function onIndexProgress(e: KbIndexEvent): void {
  if (!status.value) return
  status.value.progress = { phase: e.phase, done: e.done, total: e.total }
  status.value.pending = e.pending
  status.value.indexing = e.indexing
}

onMounted(() => {
  void refresh().catch((e) => toast.toast(e instanceof Error ? e.message : String(e)))
  void onKbIndexProgress(onIndexProgress).then((off) => {
    offIndex = off
  })
})

onBeforeUnmount(() => {
  offIndex?.()
})

/** silent：开关/chips 这类即时生效的小改动不出声，别让「已保存」toast 打断操作节奏 */
async function saveSettings(silent = false): Promise<void> {
  busy.value = true
  try {
    const input: Record<string, unknown> = {
      embeddingMode: mode.value,
      sourcesEnabled: sourceEnabled.value,
      autoMemory: autoMemory.value,
      autoConsolidate: autoConsolidate.value,
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
    if (!silent) toast.toast('已保存')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

/** 分段控件切档即生效（旧版「点了不保存不生效」的分裂提交模型已废） */
function onModeChange(v: string): void {
  if (v === mode.value) return
  mode.value = v as KbEmbeddingMode
  void saveSettings(true)
}

/** 逐类开关：即时保存但不出声 */
async function toggleSource(t: KbSourceType): Promise<void> {
  const next = !(sourceEnabled.value[t] ?? true)
  sourceEnabled.value = { ...sourceEnabled.value, [t]: next }
  await saveSettings(true)
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

/* ---------- 检索 ---------- */

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

/* ---------- 阅读抽屉：概览 / 全文（滚动加载 + 一次读完） ---------- */

interface ReaderState {
  docId: number
  level: 'l1' | 'l2'
  hasMore: boolean
  totalChunks: number
  chunks: KbChunk[]
  title: string
  path: string | null
  /** 「继续加载」进行中：防重复点、按钮文案读它 */
  loadingMore: boolean
  /** 「一次读完」进行中：这一趟循环期间不许再点任何拉取 */
  busy: boolean
}
const reader = ref<ReaderState | null>(null)
const reading = ref(false)

async function openReader(docId: number, level: 'l1' | 'l2' = 'l1', offset = 0): Promise<void> {
  reading.value = true
  try {
    const d = await kbService.read(docId, level, offset, level === 'l1' ? 1 : 8)
    reader.value = {
      docId: d.id,
      level: d.level as 'l1' | 'l2',
      hasMore: d.hasMore,
      totalChunks: d.totalChunks,
      chunks: d.chunks,
      title: d.title,
      path: d.path,
      loadingMore: false,
      busy: false,
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    reading.value = false
  }
}

function switchLevel(v: string): void {
  const r = reader.value
  if (!r || v === r.level) return
  void openReader(r.docId, v as 'l1' | 'l2', 0)
}

async function loadMore(): Promise<void> {
  const r = reader.value
  if (!r || !r.hasMore || r.loadingMore || r.busy) return
  r.loadingMore = true
  try {
    const d = await kbService.read(r.docId, 'l2', r.chunks.length, 24)
    r.chunks.push(...d.chunks)
    r.totalChunks = d.totalChunks
    r.hasMore = d.hasMore
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    r.loadingMore = false
  }
}

/** 一次读完：kb_read 单次上限 64 块，循环拉到末尾 */
async function readAll(): Promise<void> {
  const r = reader.value
  if (!r || r.busy) return
  r.busy = true
  try {
    while (r.hasMore) {
      const d = await kbService.read(r.docId, 'l2', r.chunks.length, 64)
      if (!d.chunks.length) break
      r.chunks.push(...d.chunks)
      r.totalChunks = d.totalChunks
      r.hasMore = d.hasMore
    }
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    r.busy = false
  }
}

/* ---------- 长期记忆 ---------- */

async function removeMemory(id: number): Promise<void> {
  try {
    await kbService.memoryDelete(id)
    confirmDel.value = null
    await refreshMemories()
    // 让下一轮对话的认知注入立刻反映改动，而不是等 TTL 过期
    ai.invalidateCognitionCache()
    toast.toast('已删除该条记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 归档：软删除，退出注入与检索，可在「显示归档」里恢复 */
async function archiveMemory(id: number): Promise<void> {
  try {
    await kbService.memoryArchive(id)
    await refreshMemories()
    ai.invalidateCognitionCache()
    toast.toast('已归档（可在「显示归档」里恢复）')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

async function restoreMemory(id: number): Promise<void> {
  try {
    await kbService.memoryRestore(id)
    await refreshMemories()
    ai.invalidateCognitionCache()
    toast.toast('已恢复到活跃记忆')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  }
}

/** 删除的两段确认：第一段点亮「删除?」，3 秒内再点才真删（防拇指误触永久丢失） */
const confirmDel = ref<number | null>(null)
let confirmDelTimer: ReturnType<typeof setTimeout> | null = null

function tapDeleteMemory(id: number): void {
  if (confirmDel.value === id) {
    void removeMemory(id)
    return
  }
  confirmDel.value = id
  if (confirmDelTimer) clearTimeout(confirmDelTimer)
  confirmDelTimer = setTimeout(() => {
    confirmDel.value = null
  }, 3000)
}

/** 本地维护：衰减 + 自动归档长期闲置的低信号记忆（无模型调用） */
async function runMaintain(): Promise<void> {
  maintaining.value = true
  try {
    const r = await kbService.memoryMaintain()
    await refreshMemories()
    ai.invalidateCognitionCache()
    toast.toast(
      r.archived > 0
        ? `检查 ${r.checked} 条，归档 ${r.archived} 条低信号记忆`
        : `检查 ${r.checked} 条，没有需要归档的`,
    )
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    maintaining.value = false
  }
}

/** AI 整理（“做梦”）：合并重叠、统一分类、归档噪声、清理归档区（一次模型调用） */
async function runConsolidate(): Promise<void> {
  consolidating.value = true
  try {
    const changed = await ai.consolidateMemoriesNow(true)
    await refreshMemories()
    toast.toast(changed > 0 ? `AI 已整理 ${changed} 处记忆` : '记忆库很健康，无需调整')
  } finally {
    consolidating.value = false
  }
}

/** 记忆健康度的一句话结论（数字墙收进详情） */
const memorySummary = computed(() => {
  const s = memoryStats.value
  if (!s) return ''
  const parts: string[] = []
  if (s.injected >= s.active) {
    parts.push(`${s.active} 条活跃记忆，全部会注入对话`)
  } else {
    parts.push(`${s.active} 条活跃记忆，其中 ${s.injected} 条会注入对话（上限 ${s.limit}）`)
  }
  if (s.noiseRatio > 0.3) {
    parts.push(`${Math.round(s.noiseRatio * 100)}% 近期没用上，建议整理`)
  }
  return parts.join('；')
})

/* ---------- 新建笔记（已有笔记的浏览与编辑在文件库） ---------- */

const editor = ref<{ path: string; content: string } | null>(null)
const saving = ref(false)
const closeConfirm = ref(false)

function openNewNote(): void {
  editor.value = { path: '', content: '' }
  closeConfirm.value = false
}

async function createNote(): Promise<void> {
  const ed = editor.value
  if (!ed) return
  saving.value = true
  try {
    const f = await kbService.fileWrite({ path: ed.path.trim(), content: ed.content })
    ai.invalidateCognitionCache()
    toast.toast(`已创建 ${f.path}`)
    editor.value = null
    await refresh()
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

/** 关闭守卫：有未保存内容时第一次点只提醒，3 秒内再点才放弃 */
function requestCloseEditor(): void {
  const ed = editor.value
  if (!closeConfirm.value && ed && (ed.path.trim() || ed.content.trim())) {
    closeConfirm.value = true
    setTimeout(() => {
      closeConfirm.value = false
    }, 3000)
    return
  }
  editor.value = null
}
</script>

<template>
  <!-- 标准文档滚动页（与 FileLibraryPage 同壳）：横内边距必须走 --page-pad-x，
       PageHeader 的模糊遮罩会向两侧铺同宽的 --ph-bleed，页头缩在它里面遮罩才正好
       铺满整帧 —— 曾经自造壳让页头顶在 x=0，遮罩超出视口 18px，整页能横向拖动。 -->
  <div class="page">
    <PageHeader title="知识库" subtitle="让 AI 记得住你" back>
      <template #action>
        <button class="hdr-btn" aria-label="检索设置" @click="settingsOpen = true">
          <Settings2 :size="18" />
          <i v-if="modeWarn" class="dot" />
        </button>
      </template>
    </PageHeader>

    <div class="cards">
      <!-- 检索：这页 90% 的到访是搜一下 / 看看最近内容，放第一卡 -->
      <section class="card">
        <div class="card-head">
          <Search :size="16" />
          <h2>检索</h2>
          <button class="mode-chip" aria-label="打开检索设置" @click="settingsOpen = true">
            {{ modeLabel }}
            <i v-if="modeWarn" class="dot" />
          </button>
        </div>
        <div class="searchbar">
          <input
            v-model="query"
            type="search"
            placeholder="关键词，留空看最近内容"
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

      <!-- 长期记忆 -->
      <section class="card">
        <div class="card-head">
          <Brain :size="16" />
          <h2>长期记忆</h2>
          <span class="chip">{{ visibleMemories.length }}</span>
        </div>

        <!-- 健康度：一句结论 + 可展开的详情（数字墙默认收起） -->
        <div v-if="memoryStats" class="snr">
          <p class="snr-sum">{{ memorySummary }}</p>
          <button class="snr-toggle" @click="snrDetail = !snrDetail">
            {{ snrDetail ? '收起详情' : '详情' }}
          </button>
          <div v-show="snrDetail" class="snr-detail">
            <div class="snr-grid">
              <div><b>{{ memoryStats.active }}</b><span>活跃</span></div>
              <div><b>{{ memoryStats.injected }}</b><span>注入（上限 {{ memoryStats.limit }}）</span></div>
              <div><b>{{ Math.round(memoryStats.signalRatio * 100) }}%</b><span>注入覆盖率</span></div>
              <div>
                <b :class="{ bad: memoryStats.noiseRatio > 0.3 }">{{ Math.round(memoryStats.noiseRatio * 100) }}%</b>
                <span>低信号占比</span>
              </div>
            </div>
            <p class="snr-line">
              注入 {{ memoryStats.injectedChars }} / {{ memoryStats.maxChars }} 字符 · 平均置信度
              {{ memoryStats.avgConfidence.toFixed(2) }} · 平均显著性 {{ memoryStats.avgSalience.toFixed(2) }}
              <template v-if="memoryStats.archived"> · 已归档 {{ memoryStats.archived }}</template>
            </p>
            <p class="snr-line">
              最近维护：{{ memoryStats.lastMaintainAt ?? '从未' }} · 最近 AI 整理：{{ memoryStats.lastConsolidateAt ?? '从未' }}
            </p>
          </div>
          <div class="mem-actions">
            <button class="btn ghost" :disabled="maintaining" @click="runMaintain">
              <RefreshCw :size="14" /> {{ maintaining ? '维护中…' : '衰减维护' }}
            </button>
            <button class="btn ghost" :disabled="consolidating" @click="runConsolidate">
              <Sparkles :size="14" /> {{ consolidating ? 'AI 整理中…' : 'AI 整理' }}
            </button>
            <button class="link" @click="showArchived = !showArchived">
              {{ showArchived ? '隐藏归档' : `显示归档${archivedCount ? `（${archivedCount}）` : ''}` }}
            </button>
          </div>
        </div>

        <ul v-if="visibleMemories.length" class="mems">
          <li v-for="m in visibleMemories" :key="m.id" :class="{ 'is-archived': m.archivedAt }">
            <div class="mem-head">
              <span class="type">{{ KB_MEMORY_LABELS[m.memType] ?? m.memType }}</span>
              <span v-if="m.topic" class="topic">{{ m.topic }}</span>
              <span v-if="m.category" class="cat">{{ m.category }}</span>
              <span v-if="m.archivedAt" class="badge arch">已归档 · {{ m.archivedReason ?? '手动' }}</span>
              <span v-else-if="m.salience < STALE_SALIENCE" class="badge stale">低信号</span>
            </div>
            <p class="mem-text">{{ m.content }}</p>
            <div class="mem-ops">
              <button
                v-if="m.archivedAt"
                class="op"
                aria-label="恢复该条记忆"
                @click="restoreMemory(m.id)"
              >
                <RotateCcw :size="16" />
              </button>
              <button v-else class="op" aria-label="归档该条记忆" @click="archiveMemory(m.id)">
                <Archive :size="16" />
              </button>
              <button
                v-if="confirmDel === m.id"
                class="op del-arm"
                aria-label="再点一次确认删除"
                @click="tapDeleteMemory(m.id)"
              >
                删除?
              </button>
              <button
                v-else
                class="op del"
                aria-label="删除该条记忆（需确认）"
                @click="tapDeleteMemory(m.id)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Brain"
          title="还没有长期记忆"
          hint="默认会在每次会话结束时自动提炼。也可以直接对 AI 说「记住……」"
        />
        <p v-if="visibleMemories.length" class="foot">
          记忆会随时间自然衰减：长期没被用到且显著性变低的条目会被自动归档（可在上方恢复）。
        </p>
      </section>

      <!-- 文件：入口 + 新建笔记；浏览与编辑在文件库 -->
      <section class="card">
        <div class="card-head">
          <FolderTree :size="16" />
          <h2>文件</h2>
          <button class="mini" @click="router.push('/ai/knowledge/files')">
            <FolderOpen :size="13" /> 文件库
          </button>
          <button class="mini" @click="openNewNote"><FilePlus2 :size="13" /> 新建笔记</button>
        </div>
        <p v-if="!editor" class="hint">
          笔记、上传的文档与各类记录都存在 AI 工作区里，进文件库可以翻阅和编辑。
        </p>

        <!-- 新建笔记编辑器 -->
        <div v-if="editor" class="editor">
          <label class="epath">
            <span>路径</span>
            <input v-model="editor.path" type="text" placeholder="笔记/训练笔记.md" />
          </label>
          <textarea
            v-model="editor.content"
            rows="10"
            placeholder="markdown 正文"
          />
          <div class="row">
            <button class="btn" :disabled="saving" @click="createNote">
              {{ saving ? '创建中…' : '创建' }}
            </button>
            <button class="btn ghost" :class="{ danger: closeConfirm }" @click="requestCloseEditor">
              {{ closeConfirm ? '放弃内容?' : '关闭' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- 检索设置抽屉：索引概况 / 模式 / 范围 —— 低频的机器层全在这里 -->
    <SheetModal :open="settingsOpen" title="检索设置" initial-snap="large" @close="settingsOpen = false">
      <!-- 索引概况 -->
      <section class="set-block">
        <div class="set-head">
          <Database :size="15" />
          <h3>索引概况</h3>
          <span v-if="status" class="chip" :class="{ on: status.indexing }">
            {{ status.indexing ? '索引中' : '空闲' }}
          </span>
        </div>
        <div v-if="status" class="stats">
          <div><b>{{ status.docs }}</b><span>条目</span></div>
          <div><b>{{ status.chunks }}</b><span>分块</span></div>
          <div><b>{{ status.vectors }}</b><span>向量</span></div>
          <div><b>{{ status.pending }}</b><span>待更新</span></div>
        </div>
        <div v-if="status?.indexing" class="bar"><i :style="{ transform: `scaleX(${progressPct / 100})` }" /></div>
        <p v-if="status?.lastError" class="err">
          <AlertCircle :size="14" /> {{ status.lastError }}
        </p>
        <p v-if="status && !status.embedderReady && mode !== 'keyword'" class="hint">
          语义模型还没准备好，检索暂时按关键词匹配，不影响使用。
        </p>
      </section>

      <!-- 检索模式 -->
      <section class="set-block">
        <div class="set-head">
          <Search :size="15" />
          <h3>检索模式</h3>
        </div>
        <SegmentedControl :options="modeOptions" :model-value="mode" @update:model-value="onModeChange" />
        <p class="hint">
          <template v-if="mode === 'keyword'">
            按字面关键词匹配，零配置、所有设备可用，改完立即生效。
          </template>
          <template v-else-if="mode === 'local'">
            在设备上运行内置的语义模型，意思相近也能搜到，数据不出设备。首次启用会先在后台建一段时间的索引。
          </template>
          <template v-else>
            调用兼容 OpenAI 的云端服务，速度快；索引文本会发送给该服务商。
          </template>
        </p>

        <div v-if="mode === 'cloud'" class="fields">
          <label>
            <span>服务地址</span>
            <input v-model="cloudBaseUrl" type="url" placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>密钥</span>
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
          <div class="row">
            <button class="btn" :disabled="busy" @click="saveSettings()">应用</button>
            <button class="btn ghost" :disabled="probing" @click="probe">
              {{ probing ? '测试中…' : '测试连接' }}
            </button>
          </div>
        </div>

        <div v-if="mode !== 'keyword'" class="row">
          <button class="btn ghost" :disabled="probing" @click="probe">
            {{ probing ? '测试中…' : '测试嵌入' }}
          </button>
          <button class="btn ghost" :disabled="busy" @click="rebuild">
            <RefreshCw :size="14" /> 重建索引
          </button>
        </div>
      </section>

      <!-- 索引范围 -->
      <section class="set-block">
        <div class="set-head">
          <FolderTree :size="15" />
          <h3>索引范围</h3>
        </div>
        <p class="hint">告诉 AI 可以从哪些记录里找知识，点一下即生效。</p>
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
        <div class="switch-row">
          <span>会话结束时自动提炼长期记忆</span>
          <ToggleSwitch v-model="autoMemory" label="会话结束时自动提炼长期记忆" @update:model-value="saveSettings(true)" />
        </div>
        <div class="switch-row">
          <span>定期整理记忆库（合并重复、归档噪声，每天最多一次）</span>
          <ToggleSwitch v-model="autoConsolidate" label="定期整理记忆库" @update:model-value="saveSettings(true)" />
        </div>
      </section>
    </SheetModal>

    <!-- 阅读抽屉 -->
    <SheetModal
      :open="reader !== null"
      :title="reader?.title ?? '阅读'"
      initial-snap="large"
      @close="reader = null"
    >
      <template v-if="reader">
        <p v-if="reader.path" class="hpath big">{{ reader.path }}</p>
        <div class="reader-bar">
          <SegmentedControl
            :options="[{ value: 'l1', label: '概览' }, { value: 'l2', label: '全文' }]"
            :model-value="reader.level"
            @update:model-value="switchLevel"
          />
        </div>
        <div v-if="reader.level === 'l2'" class="doc-body">
          <p v-for="c in reader.chunks" :key="c.id">{{ c.text }}</p>
        </div>
        <p v-else class="doc-body sum">{{ reader.chunks[0]?.text }}</p>
        <div v-if="reader.level === 'l2' && reader.hasMore" class="row more-row">
          <button class="btn ghost" :disabled="reading || reader.busy" @click="loadMore">
            {{ reader.loadingMore ? '加载中…' : `继续加载（${reader.chunks.length}/${reader.totalChunks} 块）` }}
          </button>
          <button class="btn ghost" :disabled="reader.busy" @click="readAll">一次读完</button>
        </div>
        <p v-else-if="reader.level === 'l2' && reader.totalChunks > 1" class="fin">
          已到末尾 · 共 {{ reader.totalChunks }} 块
        </p>
      </template>
    </SheetModal>
  </div>
</template>

<style scoped>
.page {
  /* 标准文档滚动页内边距：底部 --page-pad-bottom 已含 TabBar 的 --dock-top
     与悬浮条预留 —— 只留固定 24px 时最后一张卡片会压进标签栏 */
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 页头设置钮上的警示点（索引中 / 语义后端未就绪） */
.hdr-btn .dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
.mode-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--fs-caption);
  font-weight: 600;
}
.mode-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--accent);
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
  font-size: var(--fs-subhead);
  font-weight: 600;
  color: var(--text-1);
  flex: 1;
}
.chip {
  font-size: var(--fs-caption);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 检索 */
.searchbar {
  display: flex;
  gap: 8px;
}
.searchbar input {
  flex: 1;
  min-width: 0;
}
input {
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  /* 16px 起才不触发 iOS 聚焦自动放大 */
  font-size: 16px;
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
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.src {
  flex: none;
  color: var(--accent);
}
.hpath {
  font-family: ui-monospace, monospace;
  font-size: var(--fs-micro);
  color: var(--text-3);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hpath.big {
  margin-bottom: 8px;
  white-space: normal;
  word-break: break-all;
}
.date {
  flex: none;
  margin-left: auto;
}
.hit-title {
  margin-top: 4px;
  font-size: var(--fs-subhead);
  font-weight: 500;
  color: var(--text-1);
}
.hit-snippet {
  margin-top: 3px;
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-2);
}
.clickable {
  cursor: pointer;
}

/* 长期记忆 */
.snr {
  display: grid;
  gap: 8px;
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.snr-sum {
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}
.snr-toggle {
  justify-self: start;
  font-size: var(--fs-caption);
  color: var(--accent);
}
.snr-detail {
  display: grid;
  gap: 8px;
}
.snr-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.snr-grid > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.snr-grid b {
  font-size: var(--fs-headline);
  font-weight: 700;
}
.snr-grid b.bad {
  color: var(--danger);
}
.snr-grid span {
  font-size: var(--fs-micro);
  color: var(--text-2);
  text-align: center;
}
.snr-line {
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}
.mem-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.link {
  font-size: var(--fs-caption);
  color: var(--text-2);
  text-decoration: underline;
  text-underline-offset: 3px;
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
}
.mems li.is-archived .mem-text {
  color: var(--text-3);
}
.mem-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--fs-caption);
  /* 给右侧操作钮让位，避免长 topic 塞到按钮底下 */
  padding-right: 96px;
}
.type {
  color: var(--accent);
}
.topic,
.cat {
  color: var(--text-3);
}
.badge {
  padding: 1px 7px;
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
}
.badge.arch {
  background: var(--surface-2);
  color: var(--text-2);
}
.badge.stale {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.mem-text {
  margin-top: 3px;
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-1);
}
.mem-ops {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.op {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  padding: 6px;
  border: none;
  border-radius: var(--radius-s);
  background: none;
  color: var(--text-3);
}
/* 命中区撑到 44×44（同 PageHeader 圆钮的 ::after 扩展法） */
.op::after {
  content: '';
  position: absolute;
  inset: -6px;
}
.op:active {
  opacity: 0.6;
}
.op.del-arm {
  padding: 6px 12px;
  background: var(--danger);
  color: #fff;
  font-size: var(--fs-caption);
  font-weight: 600;
}
.foot {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-2);
}

/* 文件 / 编辑器 */
.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
}
.hint {
  margin-top: 4px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-2);
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
  font-size: var(--fs-caption);
  color: var(--text-2);
}
textarea {
  width: 100%;
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

/* 抽屉里的设置块 */
.set-block {
  display: grid;
  gap: 10px;
  padding-bottom: 18px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--line);
}
.set-block:last-child {
  border-bottom: none;
  margin-bottom: 0;
}
.set-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-1);
}
.set-head h3 {
  font-size: var(--fs-subhead);
  font-weight: 600;
  flex: 1;
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
  font-size: var(--fs-headline);
  color: var(--text-1);
}
.stats span {
  font-size: var(--fs-micro);
  color: var(--text-2);
}
.bar {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: 0 50%;
  transition: transform 0.3s var(--ease-standard);
}
.err {
  font-size: var(--fs-caption);
  color: var(--danger);
  display: flex;
  align-items: center;
  gap: 4px;
}
.fields {
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
  font-size: var(--fs-caption);
  color: var(--text-2);
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  /* flex 内不被输入框（width:100%）挤成竖排字；窄屏也不折行 */
  flex: none;
  white-space: nowrap;
  padding: 8px 14px;
  border-radius: var(--radius-m);
  border: none;
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
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.toggle {
  padding: 6px 11px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
.toggle.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-footnote);
  color: var(--text-1);
}

/* 阅读抽屉 */
.reader-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
/* 分段控件吃满抽屉宽度（根节点 .seg 默认收缩到内容宽） */
.reader-bar :deep(.seg) {
  flex: 1;
  width: 100%;
}
.doc-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--fs-footnote);
  line-height: 1.7;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
}
.doc-body.sum {
  color: var(--text-2);
}
.more-row {
  margin-top: 12px;
}
.more-row .btn {
  flex: 1;
}
.fin {
  margin-top: 10px;
  text-align: center;
  font-size: var(--fs-caption);
  color: var(--text-2);
}
</style>
