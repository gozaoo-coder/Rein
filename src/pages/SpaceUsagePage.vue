<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ChevronRight,
  CircleCheck,
  Folder,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import UsageFileList from '@/components/kb/UsageFileList.vue'
import { invalidateUsage, kbService, usageCached } from '@/services/kbService'
import { useToast } from '@/composables/useToast'
import { humanBytes } from '@/utils/format'
import {
  KB_SOURCE_LABELS,
  type KbSourceType,
  type KbUsageFile,
  type KbUsageReport,
  type KbUsageSlice,
} from '@/types'

/** 空间总览（入口 = 文件页页头右侧的总大小胶囊，路由 /ai/files/space）。
 *
 *  一页回答四件事：**总量与构成**（四本账）、**占地方的是哪些目录**、
 *  **体积各是什么来路**（索引按来源 / 本体按模态）、**磁盘上有没有该回收的碎片**。
 *  数据只有一条 kb_usage（走 `usageCached` 的会话级备忘，与文件页那颗胶囊共享同一份
 *  report），页面不做二次聚合 —— 口径全在 Rust 那一处，前端多算一遍就等于多一份会漂移
 *  的真源。
 *
 *  两个容易混淆的口径，页面上必须自己讲清楚（也是这页的设计骨架）：
 *  · `totalBytes = 文本 + 本体`：**真源内容**。删掉它们才真的释放空间，
 *    所以大数字与文件页那颗胶囊都取这个数。
 *  · 索引 / 数据库是**派生缓存**且**不在**上面这个数里 —— 它们的字节本来就在
 *    SQLite 文件内部（kb_files.content、kb_docs.body 这些表都装在那个文件里），
 *    再加一遍就是重复计数。所以它们是第二组（单独一条构成条 + 各自的图例），
 *    而不是与真源挤在同一条里。 */
const router = useRouter()
const toast = useToast()

/** 首屏各榜的可见条数，其余折叠在「展开」后面 */
const AREAS_VISIBLE = 6
const DIST_VISIBLE = 5

const usage = ref<KbUsageReport | null>(null)
const loading = ref(false)
/** 首次加载失败的原因（已有数据时失败只 toast，不把页面换成错误态） */
const failed = ref('')
const cleaning = ref(false)
const cleanConfirm = ref(false)
const areasOpen = ref(false)

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `force` 跳过备忘（页头那颗刷新钮）；正常进入页面吃缓存，切页回来不再重扫库 */
async function load(force = false): Promise<void> {
  loading.value = true
  try {
    usage.value = await usageCached(undefined, force)
    failed.value = ''
    cleanConfirm.value = false
  } catch (e) {
    if (usage.value) toast.toast(errMsg(e))
    else failed.value = errMsg(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/* ---------- 构成（四本账） ---------- */

interface Seg {
  key: string
  label: string
  bytes: number
  /** 相对本组总量的百分比（图例里显示） */
  pct: number
}

/** 组内分段：条宽直接用字节数当 flex-grow 权重，宽度即占比 —— 不需要前端算百分比 */
function segs(rows: Array<Omit<Seg, 'pct'>>): Seg[] {
  const total = rows.reduce((n, r) => n + r.bytes, 0)
  return rows.map((r) => ({ ...r, pct: total > 0 ? (r.bytes / total) * 100 : 0 }))
}

const sourceSegs = computed(() =>
  segs([
    { key: 'text', label: '文本', bytes: usage.value?.textBytes ?? 0 },
    { key: 'asset', label: '本体', bytes: usage.value?.assetBytes ?? 0 },
  ]),
)

const derivedSegs = computed(() =>
  segs([
    { key: 'index', label: '索引', bytes: usage.value?.indexBytes ?? 0 },
    { key: 'db', label: '数据库', bytes: usage.value?.dbBytes ?? 0 },
  ]),
)

/** 大数字（数字与单位分开排：单位小一号、跟同一基线） */
const hero = computed(() => splitBytes(usage.value?.totalBytes ?? 0))

function splitBytes(n: number): { num: string; unit: string } {
  if (n >= 1073741824) return { num: (n / 1073741824).toFixed(2), unit: 'GB' }
  if (n >= 1048576) return { num: (n / 1048576).toFixed(1), unit: 'MB' }
  if (n >= 1024) return { num: String(Math.round(n / 1024)), unit: 'KB' }
  return { num: String(n), unit: 'B' }
}

/** 百分比文案：不足 1% 不写成 0%（读起来像「没占」） */
function pctText(p: number): string {
  if (p <= 0) return '0%'
  return p < 1 ? '<1%' : `${Math.round(p)}%`
}

/* ---------- 目录占用 ---------- */

const areas = computed<KbUsageSlice[]>(() => usage.value?.areas ?? [])
const areasShown = computed(() => (areasOpen.value ? areas.value : areas.value.slice(0, AREAS_VISIBLE)))

/** 真源内容合计：目录占比的分母（各目录的文本 + 本体加起来就是它） */
const contentBytes = computed(() =>
  usage.value ? usage.value.textBytes + usage.value.assetBytes : 0,
)

/** 占比条：低于 1.5% 抬到 1.5% 保住可见性（否则最细的一格只剩一条发丝） */
function barWidth(bytes: number): string {
  if (contentBytes.value <= 0) return '0%'
  return `${Math.min(100, Math.max(1.5, (bytes / contentBytes.value) * 100))}%`
}

function areaPct(bytes: number): string {
  return pctText(contentBytes.value > 0 ? (bytes / contentBytes.value) * 100 : 0)
}

/* ---------- 分布（索引按来源 / 本体按模态） ---------- */

const sources = computed<KbUsageSlice[]>(() => usage.value?.sources ?? [])
const modals = computed<KbUsageSlice[]>(() => usage.value?.modals ?? [])

/** 索引里能按来源拆的那部分合计（正文快照 + 分块）；索引总字节减它就是向量 */
const sourcesBytes = computed(() => sources.value.reduce((n, s) => n + s.bytes, 0))
const vectorBytes = computed(() => Math.max(0, (usage.value?.indexBytes ?? 0) - sourcesBytes.value))

function srcLabel(name: string): string {
  return KB_SOURCE_LABELS[name as KbSourceType] ?? name
}

function modalLabel(name: string): string {
  switch (name) {
    case 'text':
      return '文本'
    case 'image':
      return '图片'
    case 'audio':
      return '音频'
    case 'video':
      return '视频'
    default:
      return '本体文件'
  }
}

/** 组内条宽：以最大项为满格 —— 这两本账各有各的分母（与目录那条「以真源为分母」
 *  不是一回事），所以卡片标题里把本组总量写出来，条只负责读层级。 */
function groupWidth(list: KbUsageSlice[], bytes: number): string {
  const max = list[0]?.bytes ?? 0
  return max > 0 ? `${Math.max(2, (bytes / max) * 100)}%` : '0%'
}

/* ---------- 大文件（总览只留前三名，完整榜单在下一级页面） ---------- */

const largest = computed<KbUsageFile[]>(() => usage.value?.largest ?? [])
/** 摘要条数：总览的职责是「一眼看明白」，榜单本身在 /ai/files/space/large */
const FILES_PREVIEW = 3
const largestPreview = computed(() => largest.value.slice(0, FILES_PREVIEW))

/* ---------- 维护 ---------- */

/** 两段确认：第一次点变「确认清理?」，第二次才真删（与文件页原来那张卡同一套手势） */
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
    invalidateUsage()
    await load()
  } catch (e) {
    toast.toast(errMsg(e))
  } finally {
    cleaning.value = false
  }
}

/* ---------- 跳到文件管理器 ---------- */

/** 目录行 → 文件页打开该目录；大文件行 → 文件页打开该文件的阅读器。
 *
 *  **按路径跳，不按 id**：大文件榜给的是 `kb_files.id`（文件行），而阅读器要的是
 *  `kb_docs.id`（索引文档）——两个 id 空间，直接传会把 A 文件的内容读到 B 身上
 *  （原卡片就是这么写的）。路径是两页都认的稳定键，由文件页用一次 glob 解析成 doc id。
 *  跳转走 query，由文件页在挂载时消费一次（见那里的 onMounted）。 */
function openArea(name: string): void {
  void router.push({ name: 'ai-files', query: { dir: name } })
}

function openFile(f: KbUsageFile): void {
  const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  void router.push({ name: 'ai-files', query: parent ? { dir: parent, path: f.path } : { path: f.path } })
}

/** 完整榜单在下一级页面（总览只留前三名摘要） */
function openLargeFiles(): void {
  void router.push({ name: 'ai-files-usage-large' })
}
</script>

<template>
  <div class="page">
    <PageHeader back title="空间总览" subtitle="工作区存了什么、占在哪">
      <template #action>
        <button class="hdr-btn" aria-label="重新统计" :disabled="loading" @click="load(true)">
          <RefreshCw :size="18" :class="{ spin: loading }" />
        </button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="failed && !usage"
      :icon="HardDrive"
      title="读不到空间数据"
      :hint="failed"
    >
      <template #action>
        <button class="btn" @click="load(true)">重试</button>
      </template>
    </EmptyState>

    <!-- 首屏：一条骨架，别让页面空白着等（这条命令要遍历媒体目录，慢的时候有半秒） -->
    <section v-else-if="!usage" class="card hero d-full" aria-hidden="true">
      <div class="sk sk-l" />
      <div class="sk sk-m" />
      <div class="sk sk-s" />
    </section>

    <template v-else>
      <!-- 总量与构成 -->
      <section class="card hero d-full">
        <div class="hero-main">
          <p class="cap">工作区总占用</p>
          <p class="bignum">
            {{ hero.num }}<i>{{ hero.unit }}</i>
          </p>
          <p class="hero-meta">
            {{ usage.fileCount }} 个文件 · {{ usage.assetCount }} 个本体 ·
            {{ usage.docCount }} 条索引文档
          </p>
        </div>

        <div class="hero-side">
          <!-- 真源：文本 + 本体。这一条的分母就是上面的大数字 -->
          <div class="lgroup">
            <p class="lcap"><b>真源内容</b><em>删掉才真的释放</em></p>
            <div
              class="stackbar"
              role="img"
              :aria-label="`真源构成：${sourceSegs.map((s) => `${s.label} ${humanBytes(s.bytes)}`).join('，')}`"
            >
              <i
                v-for="s in sourceSegs"
                :key="s.key"
                class="seg"
                :class="`seg-${s.key}`"
                :style="{ flexGrow: s.bytes }"
              />
            </div>
            <ul class="legend">
              <li v-for="s in sourceSegs" :key="s.key">
                <i class="dot" :class="`seg-${s.key}`" />
                <span class="lg-name">{{ s.label }}</span>
                <span class="lg-bytes">{{ humanBytes(s.bytes) }}</span>
                <span class="lg-pct">{{ pctText(s.pct) }}</span>
              </li>
            </ul>
          </div>

          <!-- 派生缓存：索引 + 数据库。**不计入上面的大数字**（它们的字节本来就在
               数据库文件内部，加进去就是重复计数），所以单列一组、换细条、换淡标题 -->
          <div class="lgroup derived">
            <p class="lcap"><b>派生缓存</b><em>删源数据会自然缩回</em></p>
            <div
              class="stackbar thin"
              role="img"
              :aria-label="`派生缓存：${derivedSegs.map((s) => `${s.label} ${humanBytes(s.bytes)}`).join('，')}`"
            >
              <i
                v-for="s in derivedSegs"
                :key="s.key"
                class="seg"
                :class="`seg-${s.key}`"
                :style="{ flexGrow: s.bytes }"
              />
            </div>
            <ul class="legend">
              <li v-for="s in derivedSegs" :key="s.key">
                <i class="dot" :class="`seg-${s.key}`" />
                <span class="lg-name">{{ s.label }}</span>
                <span class="lg-bytes">{{ humanBytes(s.bytes) }}</span>
                <span class="lg-pct">{{ pctText(s.pct) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- 目录占用：一条一行，进得去对应目录 -->
      <section class="card" :class="{ 'card-empty': !areas.length }">
        <div class="card-head">
          <h2>目录占用</h2>
          <span class="sub">文本 + 本体 · 按一级目录</span>
        </div>
        <ul v-if="areasShown.length" class="bars">
          <li v-for="a in areasShown" :key="a.name">
            <button class="barrow" @click="openArea(a.name)">
              <span class="br-1">
                <b>{{ a.name }}</b>
                <span class="br-count">{{ a.count }} 项</span>
                <span class="br-bytes">{{ humanBytes(a.bytes) }}</span>
                <ChevronRight :size="14" class="t-3" />
              </span>
              <span class="br-2">
                <span class="track"><i class="fill" :style="{ width: barWidth(a.bytes) }" /></span>
                <span class="br-pct">{{ areaPct(a.bytes) }}</span>
              </span>
            </button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Folder"
          title="工作区还是空的"
          hint="新建笔记、导入本体或让 AI 归类之后，占用会按目录出现在这里"
        />
        <button v-if="areas.length > AREAS_VISIBLE" class="more" @click="areasOpen = !areasOpen">
          {{ areasOpen ? '收起' : `展开全部 ${areas.length} 个目录` }}
        </button>
      </section>

      <!-- 大文件：只留前三名做摘要 —— 榜单会长（最多 100 条），完整榜单在下一级页面 -->
      <section class="card" :class="{ 'card-empty': !largest.length }">
        <div class="card-head">
          <h2>大文件</h2>
          <span class="sub">文本 + 本体 · 按体积倒序</span>
        </div>
        <UsageFileList v-if="largest.length" :files="largestPreview" @open="openFile" />
        <EmptyState
          v-else
          :icon="HardDrive"
          title="还没有文件"
          hint="写进工作区的笔记与导入的本体会按体积排在这里"
        />
        <button v-if="largest.length" class="more" @click="openLargeFiles">
          查看完整榜单
          <ChevronRight :size="14" />
        </button>
      </section>

      <!-- 索引来路 -->
      <section class="card" :class="{ 'card-empty': !sources.length }">
        <div class="card-head">
          <h2>索引来源</h2>
          <span class="sub">共 {{ humanBytes(sourcesBytes) }} · 正文快照 + 分块</span>
        </div>
        <ul v-if="sources.length" class="bars mini">
          <li v-for="s in sources.slice(0, DIST_VISIBLE)" :key="s.name">
            <span class="br-1">
              <b>{{ srcLabel(s.name) }}</b>
              <span class="br-count">{{ s.count }} 条</span>
              <span class="br-bytes">{{ humanBytes(s.bytes) }}</span>
            </span>
            <span class="br-2">
              <span class="track"
                ><i class="seg-index" :style="{ width: groupWidth(sources, s.bytes) }"
              /></span>
            </span>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Search"
          title="还没有建立索引"
          hint="写进工作区的文本会自动编目；这里按源类型摊开它的来路"
        />
        <p v-if="vectorBytes > 0" class="foot">
          另有向量 {{ humanBytes(vectorBytes) }}（按块存储，不按来源拆分）。
        </p>
      </section>

      <!-- 本体来路 -->
      <section class="card" :class="{ 'card-empty': !modals.length }">
        <div class="card-head">
          <h2>本体模态</h2>
          <span class="sub">共 {{ humanBytes(usage.assetBytes) }} · 磁盘上的原始文件</span>
        </div>
        <ul v-if="modals.length" class="bars mini">
          <li v-for="m in modals.slice(0, DIST_VISIBLE)" :key="m.name">
            <span class="br-1">
              <b>{{ modalLabel(m.name) }}</b>
              <span class="br-count">{{ m.count }} 个</span>
              <span class="br-bytes">{{ humanBytes(m.bytes) }}</span>
            </span>
            <span class="br-2">
              <span class="track"
                ><i class="seg-asset" :style="{ width: groupWidth(modals, m.bytes) }"
              /></span>
            </span>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="ImageIcon"
          title="还没有本体文件"
          hint="导入图片 / 音频 / 视频后会按模态摊开，占地方的往往就是它们"
        />
      </section>

      <!-- 维护：这一页唯一会写盘的动作 -->
      <section class="card d-full">
        <div class="card-head">
          <h2>维护</h2>
          <span class="sub">磁盘上的碎片与丢失</span>
        </div>
        <div class="mrows">
          <div class="mrow" :class="{ good: usage.orphanCount === 0 }">
            <CircleCheck v-if="usage.orphanCount === 0" :size="17" class="mi ok" />
            <Trash2 v-else :size="17" class="mi" />
            <span class="col flex-1">
              <b v-if="usage.orphanCount === 0">没有发现可回收的碎片</b>
              <b v-else>{{ usage.orphanCount }} 个可回收碎片 · {{ humanBytes(usage.orphanBytes) }}</b>
              <small v-if="usage.orphanCount === 0">磁盘上每个本体都有文件引用它。</small>
              <small v-else>没人引用的历史本体（解压失败、换本体留下的残留），清理不影响现有内容。</small>
            </span>
            <button
              v-if="usage.orphanCount > 0"
              class="btn ghost"
              :class="{ danger: cleanConfirm }"
              :disabled="cleaning"
              @click="cleanOrphans"
            >
              <Trash2 :size="13" />
              {{ cleaning ? '清理中…' : cleanConfirm ? '确认清理?' : '清理' }}
            </button>
          </div>

          <div v-if="usage.missingCount > 0" class="mrow warn">
            <TriangleAlert :size="17" class="mi" />
            <span class="col flex-1">
              <b>{{ usage.missingCount }} 个本体登记在册，文件却不在盘上</b>
              <small>打开这些文件时会提示本体不可用；记录本身与索引不受影响。</small>
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

/* ---------- 骨架（首屏） ---------- */
.sk {
  height: 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.sk-l {
  width: 46%;
  height: 34px;
}
.sk-m {
  width: 72%;
  margin-top: 14px;
}
.sk-s {
  width: 32%;
  margin-top: 10px;
}

/* ---------- 构成 ---------- */
/* 移动端：大数字与构成条上下排；桌面：左数字右构成（hero 是通栏卡，横着才不空） */
.hero {
  display: grid;
  gap: 18px;
}
.desk-main .hero {
  grid-template-columns: minmax(0, 250px) minmax(0, 1fr);
  gap: 34px;
  align-items: start;
}

.cap {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.bignum {
  margin-top: 2px;
  font-size: var(--fs-display-m);
  font-weight: 700;
  letter-spacing: -1.2px;
  line-height: 1.1;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
/* 单位小一号、非斜体，跟数字同一基线 —— 大数字读起来是「132.4 MB」一个整体 */
.bignum i {
  margin-left: 4px;
  font-size: var(--fs-title3);
  font-weight: 600;
  font-style: normal;
  letter-spacing: 0;
  color: var(--text-2);
}
.hero-meta {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.5;
}

.hero-side {
  display: grid;
  gap: 16px;
}

.lcap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-caption);
}
.lcap b {
  font-weight: 600;
  color: var(--text-2);
}
.lcap em {
  font-style: normal;
  color: var(--text-3);
}
.lgroup.derived .lcap b {
  color: var(--text-3);
}

/* 构成条：段宽 = flex-grow = 字节数（比例即数据，不需要算百分比） */
.stackbar {
  display: flex;
  gap: 2px;
  height: 12px;
  margin-top: 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
/* 派生那组用细条：它不是同一档的量，粗细分出主次 */
.stackbar.thin {
  height: 7px;
}
.seg {
  min-width: 0;
  border-radius: 0;
}
.seg-text {
  background: var(--sto-text);
}
.seg-asset {
  background: var(--sto-asset);
}
.seg-index {
  background: var(--sto-index);
}
.seg-db {
  background: var(--sto-db);
}

.legend {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.legend li {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto 42px;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-footnote);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.lg-name {
  color: var(--text-1);
  font-weight: 500;
}
.lg-bytes {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.lg-pct {
  text-align: right;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.lgroup.derived .lg-name {
  color: var(--text-2);
}

/* ---------- 卡片通用小件 ---------- */
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.card-head h2 {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
}
.card-head .sub {
  text-align: right;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.foot {
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}

/* 空态的卡：桌面栅格会把同行的矮卡拉到一样高，空态得吃掉剩下那截高度才像「设计过的」
   （否则一片空白悬在卡中间）。移动端卡高由内容决定，flex:1 不产生任何影响。 */
.card-empty {
  display: flex;
  flex-direction: column;
}
.card-empty :deep(.empty) {
  flex: 1;
  justify-content: center;
}

.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  margin-top: 12px;
  padding: 9px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
}

/* ---------- 占比列表（目录 / 来源 / 模态共用一套读法） ---------- */
.bars {
  display: grid;
  gap: 14px;
}
.barrow {
  display: grid;
  gap: 7px;
  width: 100%;
  text-align: left;
}
.br-1 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto 14px;
  align-items: baseline;
  gap: 10px;
  font-size: var(--fs-footnote);
  color: var(--text-1);
}
.br-1 b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.br-count {
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.br-bytes {
  font-size: var(--fs-caption);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.br-2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.bars.mini .br-1 {
  grid-template-columns: minmax(0, 1fr) auto auto;
}
.bars.mini .br-2 {
  grid-template-columns: minmax(0, 1fr);
}
.bars.mini li {
  display: grid;
  gap: 6px;
}
.br-pct {
  min-width: 34px;
  text-align: right;
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.track {
  display: block;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}
.track i {
  display: block;
  height: 100%;
}
/* 目录占用条用主色：它量的是「内容」这本账（蓝是这页最中性的那一档） */
.fill {
  background: var(--accent);
}

/* 大文件行的样式在 components/kb/UsageFileList.vue（总览的摘要与大文件页共用一份） */

/* ---------- 维护 ---------- */
.mrows {
  display: grid;
  gap: 12px;
}
.mrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}
.mrow b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-1);
}
.mrow small {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.45;
}
.mi {
  flex: none;
  color: var(--warn);
}
.mi.ok {
  color: var(--ok);
}
.mrow.warn {
  background: var(--warn-soft);
}
.mrow.warn .mi {
  color: var(--warn);
}
.mrow.warn small {
  color: var(--warn-strong);
}

/* ---------- 按钮（与文件页同一档：胶囊形主按钮 + 灰底幽灵按钮） ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: none;
  padding: 8px 14px;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-footnote);
  font-weight: 600;
}
.btn.ghost {
  background: var(--surface);
  color: var(--text-1);
}
.btn.ghost.danger {
  color: var(--danger);
}
.btn:disabled {
  opacity: 0.5;
}

/* 刷新钮转起来：与课表页的同步钮同一条做法（时长与主页面动效档一致） */
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

/* 桌面指针：整行给出可点反馈（触屏靠 :active，hover 在触屏上会粘住） */
@media (hover: hover) {
  .barrow:hover,
  .filerow:hover {
    background: var(--surface-2);
    border-radius: var(--radius-m);
  }
}
</style>
