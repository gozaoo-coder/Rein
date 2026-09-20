<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { BookOpen, RefreshCw, Search } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { campusService } from '@/services/campusService'
import { isSessionLostMessage, useCampusStore } from '@/stores/campus'
import type { ProgramCreditNode, ProgramCreditStat, ProgramInfo } from '@/types'

/**
 * 培养方案。
 *
 * 数据源是教务的 `program-info-json`（实测 900KB+），后端拉一次落 `app_meta` 缓存，
 * 之后离线可读。页面只用其中三段：方案档案、学分分布树、课程清单。
 */
const store = useCampusStore()
const toast = useToast()

const loading = ref(true)
const error = ref('')
const info = ref<ProgramInfo | null>(null)

const keyword = ref('')

/** 学分分布：把树摊平成一维行，用 depth 控制缩进 —— 不做跨层求和，
 *  照教务的口径逐级列出，避免把「父含子」的学分算两遍。 */
interface CreditRow {
  key: string
  name: string
  depth: number
  stats: ProgramCreditStat[]
}

function flatten(node: ProgramCreditNode, depth: number, out: CreditRow[], path: string): void {
  const name = node.type?.nameZh ?? '未命名模块'
  const key = `${path}/${name}`
  out.push({ key, name, depth, stats: node.courseStatistics ?? [] })
  for (const [i, c] of (node.children ?? []).entries()) {
    flatten(c, depth + 1, out, `${key}#${i}`)
  }
}

const creditRows = computed<CreditRow[]>(() => {
  const table = info.value?.creditDistrTable
  if (!table) return []
  const out: CreditRow[] = []
  for (const [i, c] of (table.children ?? []).entries()) flatten(c, 0, out, `r${i}`)
  return out
})

const totalCredits = computed(() => info.value?.creditDistrTable?.sumCredit ?? null)
const earnedCredits = computed(() => store.account?.totalCredits ?? null)

/** 已修 / 要求，用于进度条；要求缺失时不画 */
const progress = computed(() => {
  const need = totalCredits.value
  const got = earnedCredits.value
  if (!need || got == null) return null
  return { got, need, pct: Math.max(0, Math.min(1, got / need)) }
})

const courses = computed(() => info.value?.courseList ?? [])

const filteredCourses = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return courses.value
  return courses.value.filter(
    (c) => c.nameZh.toLowerCase().includes(k) || (c.code ?? '').toLowerCase().includes(k),
  )
})

function statText(stats: ProgramCreditStat[]): string {
  if (stats.length === 0) return ''
  return stats
    .map((s) => `${s.courseProperty?.nameZh ?? '—'} ${s.sumCredit} 学分`)
    .join(' · ')
}

async function load(refresh = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const payload = await campusService.program(refresh)
    info.value = payload?.programInfos?.[0] ?? null
    if (!info.value) error.value = '教务系统未返回培养方案'
  } catch (e) {
    error.value = e instanceof Error ? e.message : '获取培养方案失败'
  } finally {
    loading.value = false
  }
}

async function onRefresh(): Promise<void> {
  await load(true)
  if (!error.value) toast.toast('培养方案已更新')
}

onMounted(async () => {
  await store.init()
  if (!store.hasAccount) {
    loading.value = false
    error.value = '还没有绑定教务系统账号'
    return
  }
  await load()
})
</script>

<template>
  <div class="page">
    <PageHeader title="培养方案" :subtitle="info?.nameZh ?? ''" back>
      <template #action>
        <button class="hdr-btn" :disabled="loading" aria-label="刷新培养方案" @click="onRefresh">
          <RefreshCw :size="19" :class="{ spin: loading }" />
        </button>
      </template>
    </PageHeader>

    <!-- 会话过期时给一条明确的路，而不是让用户自己去「课表配置」里翻 -->
    <EmptyState
      v-if="error"
      :icon="BookOpen"
      :title="error"
      :hint="isSessionLostMessage(error) ? '重新登录一次教务系统就能继续看' : '检查课表配置里的登录状态后重试'"
    >
      <template v-if="isSessionLostMessage(error)" #action>
        <RouterLink :to="{ name: 'campus-settings' }" class="cta">去重新登录</RouterLink>
      </template>
    </EmptyState>

    <template v-else-if="info">
      <!-- 档案 -->
      <section class="card">
        <div class="meta-grid">
          <div><span class="k">年级</span><span class="v">{{ info.grade ?? '—' }}</span></div>
          <div><span class="k">学历</span><span class="v">{{ info.education?.nameZh ?? '—' }}</span></div>
          <div><span class="k">院系</span><span class="v">{{ info.department?.nameZh ?? '—' }}</span></div>
          <div><span class="k">专业</span><span class="v">{{ info.major?.nameZh ?? '—' }}</span></div>
          <div><span class="k">培养类型</span><span class="v">{{ info.cultivateType?.nameZh ?? '—' }}</span></div>
          <div><span class="k">课程门数</span><span class="v num">{{ courses.length }}</span></div>
        </div>

        <div v-if="progress" class="prog">
          <div class="prog-top">
            <span class="prog-label">学分进度</span>
            <span class="prog-num num">{{ progress.got }} / {{ progress.need }}</span>
          </div>
          <div class="bar"><div class="fill" :style="{ width: `${progress.pct * 100}%` }" /></div>
          <p class="prog-hint">
            已修学分取自习成绩单；要求学分为培养方案总学分。仅统计已出成绩的课程。
          </p>
        </div>
      </section>

      <!-- 学分分布 -->
      <section v-if="creditRows.length" class="card">
        <h2 class="sec">学分分布</h2>
        <ul class="credit">
          <li
            v-for="r in creditRows"
            :key="r.key"
            class="crow"
            :class="{ l1: r.depth === 0, l2: r.depth >= 1 }"
            :style="{ paddingLeft: `${10 + r.depth * 14}px` }"
          >
            <span class="cname">{{ r.name }}</span>
            <span v-if="statText(r.stats)" class="cstat">{{ statText(r.stats) }}</span>
          </li>
        </ul>
        <p class="tip">按教务的模块层级逐级列出，不做跨层求和，避免重复计入学分。</p>
      </section>

      <!-- 课程清单 -->
      <section v-if="courses.length" class="card">
        <h2 class="sec">课程清单 <em class="num">{{ filteredCourses.length }}/{{ courses.length }}</em></h2>
        <div class="search">
          <Search :size="15" />
          <input v-model="keyword" type="search" placeholder="搜索课程名或代码" />
        </div>
        <ul class="courses">
          <li v-for="c in filteredCourses" :key="c.id" class="course">
            <span class="cname">{{ c.nameZh }}</span>
            <span v-if="c.code" class="ccode num">{{ c.code }}</span>
          </li>
        </ul>
      </section>

      <p v-if="info.printedTime" class="foot">{{ info.printedTime }}</p>
    </template>
  </div>
</template>

<style scoped>
.page {
  padding: 0 var(--page-pad-x) var(--page-pad-bottom);
}

.sec {
  font-size: var(--fs-subhead);
  font-weight: 700;
  color: var(--text-1);
  margin-bottom: 10px;
}

.sec em {
  font-style: normal;
  font-weight: 600;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

/* ---------- 档案 ---------- */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
}

.meta-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.k {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.v {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  font-variant-numeric: tabular-nums;
}

.prog {
  margin-top: 16px;
}

.prog-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.prog-label {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.prog-num {
  font-size: var(--fs-callout);
  font-weight: 700;
  color: var(--accent);
}

.bar {
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transition: width var(--dur-sheet) var(--ease-standard);
}

.prog-hint {
  margin-top: 6px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.4;
}

/* ---------- 学分分布 ---------- */
.credit {
  display: flex;
  flex-direction: column;
}

.crow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 0.5px solid var(--line);
}

.crow:last-child {
  border-bottom: none;
}

.cname {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  line-height: 1.35;
}

.crow.l1 .cname {
  font-weight: 700;
  font-size: var(--fs-callout);
}

.crow.l2 .cname {
  font-weight: 500;
  color: var(--text-2);
}

.cstat {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ---------- 课程清单 ---------- */
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text-3);
  margin-bottom: 8px;
}

.search input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-caption);
  color: var(--text-1);
  background: none;
}

.courses {
  display: flex;
  flex-direction: column;
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.course {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--line);
}

.course:last-child {
  border-bottom: none;
}

.ccode {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.tip,
.foot {
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  line-height: 1.45;
}

.foot {
  text-align: center;
  padding: 6px 0 4px;
}

/* 「去重新登录」：与选课页同一个样式，两个空状态的出口看起来要是一回事 */
.cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 22px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-subhead);
  font-weight: 600;
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
    animation-duration: 2.4s;
  }
  .fill {
    transition: none;
  }
}
</style>
