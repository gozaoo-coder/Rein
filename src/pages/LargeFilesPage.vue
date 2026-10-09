<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { HardDrive, RefreshCw } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import UsageFileList from '@/components/kb/UsageFileList.vue'
import { usageCached } from '@/services/kbService'
import { useToast } from '@/composables/useToast'
import { humanBytes } from '@/utils/format'
import type { KbUsageFile, KbUsageReport } from '@/types'

/** 大文件榜（空间总览 › 大文件，路由 /ai/files/space/large）。
 *
 *  总览页只留前三名做摘要，完整榜单在这一页 —— 榜单会长（服务端上限 100 条），
 *  它要的是一个能按体积读下来的浏览面，而不是挤在总览卡里的一段列表。
 *  数据仍是同一条 `kb_usage`（只是 top 更大），口径与总览页完全一致。 */
const TOP = 100

const router = useRouter()
const toast = useToast()

const usage = ref<KbUsageReport | null>(null)
const loading = ref(false)
/** 首次加载失败的原因（已有数据时失败只 toast，不把页面换成错误态） */
const failed = ref('')

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const files = computed<KbUsageFile[]>(() => usage.value?.largest ?? [])
/** 榜单合计：这些「大头」一共占了多少（与工作区总量的对比在总览页） */
const listedBytes = computed(() => files.value.reduce((n, f) => n + f.bytes, 0))
/** 撞到服务端上限（TOP_MAX=100）就说明后面还有更大的没列出来 */
const capped = computed(() => files.value.length >= TOP)

/** `force` 跳过备忘（页头那颗刷新钮）；正常进入吃缓存，切页回来不再重扫库 */
async function load(force = false): Promise<void> {
  loading.value = true
  try {
    usage.value = await usageCached(TOP, force)
    failed.value = ''
  } catch (e) {
    if (usage.value) toast.toast(errMsg(e))
    else failed.value = errMsg(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

/** 打开文件：**按路径跳**，不按 id —— 榜单给的是 `kb_files.id`，阅读器要 `kb_docs.id`，
 *  两个 id 空间（理由详见总览页的同名函数）。 */
function openFile(f: KbUsageFile): void {
  const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  void router.push({ name: 'ai-files', query: parent ? { dir: parent, path: f.path } : { path: f.path } })
}
</script>

<template>
  <div class="page">
    <PageHeader back title="大文件" subtitle="文本 + 本体 · 按体积倒序">
      <template #action>
        <button class="hdr-btn" aria-label="重新统计" :disabled="loading" @click="load(true)">
          <RefreshCw :size="18" :class="{ spin: loading }" />
        </button>
      </template>
    </PageHeader>
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <EmptyState
      v-if="failed && !usage"
      :icon="HardDrive"
      title="读不到榜单"
      :hint="failed"
    >
      <template #action>
        <button class="btn" @click="load(true)">重试</button>
      </template>
    </EmptyState>

    <section v-else-if="!usage" class="card d-full" aria-hidden="true">
      <div class="sk sk-l" />
      <div class="sk sk-m" />
      <div class="sk sk-s" />
    </section>

    <section v-else class="card d-full" :class="{ 'card-empty': !files.length }">
      <div class="card-head">
        <h2>按体积排序</h2>
        <span class="sub">{{ files.length }} 个 · 合计 {{ humanBytes(listedBytes) }}</span>
      </div>

      <UsageFileList v-if="files.length" :files="files" @open="openFile" />
      <EmptyState
        v-else
        :icon="HardDrive"
        title="还没有文件"
        hint="写进工作区的笔记与导入的本体会按体积排在这里"
      />

      <p v-if="files.length" class="foot">
        条长 = 相对最大文件；蓝 = 文本，紫 = 本体。点一行进文件管理器打开它。
      </p>
      <p v-if="capped" class="foot">只列前 {{ TOP }} 个 —— 榜单按体积倒序，更大的都在里面了。</p>
    </section>
    </div>
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
  margin-top: 12px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  line-height: 1.5;
}

/* 空态吃掉剩余高度（桌面栅格会把卡拉到与同行一样高；移动端无影响） */
.card-empty {
  display: flex;
  flex-direction: column;
}
.card-empty :deep(.empty) {
  flex: 1;
  justify-content: center;
}

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
.btn:disabled {
  opacity: 0.5;
}

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
</style>
