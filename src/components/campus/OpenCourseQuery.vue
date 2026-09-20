<script setup lang="ts">
/**
 * 全校开课查询 + **两个域都检测**。
 *
 * 与「选课」的关键区别：**不依赖选课批次** —— 批次没开的时候照样能查全校开了哪些课。
 * 所以它是「提前规划抢什么」的依据：先看清开课名单与时间地点，再去排志愿。
 *
 * 界面有意把「两个域各自的探测结论」摆在名单**前面**：
 * 本科教务挂着两个域名，但它们不是同一套系统（一个是树维 EAMS5、
 * 另一个是 ASP.NET + ExtJS 桌面走 CAS）。合并汇报会把「这个域压根没有 EAMS5」
 * 伪装成「两个域都没这门课」，那种谎在抢课当天很贵。
 */
import { onMounted, ref } from 'vue'
import { AlertTriangle, Info, RefreshCw, Search } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import { useToast } from '@/composables/useToast'
import { campusService } from '@/services/campusService'
import type { LessonSearchHit, LessonSearchOutcome, SchoolDomainProbe } from '@/types'

const { toast } = useToast()

const loading = ref(false)
const outcome = ref<LessonSearchOutcome | null>(null)
const probe = ref<SchoolDomainProbe[]>([])
const error = ref<string | null>(null)
/** 学期：默认用回执里带回的第一个（教务按当前学期排在最前） */
const semesterId = ref<number | null>(null)
const keyword = ref('')

/** 本地过滤：教务那边的筛选要靠服务端会话，这里只做「已经拿到的这页」的检索 */
const filtered = ref<LessonSearchHit[]>([])

function applyFilter(): void {
  const hits = outcome.value?.page.hits ?? []
  const k = keyword.value.trim().toLowerCase()
  if (!k) {
    filtered.value = hits
    return
  }
  // 课名 / 课程代码 / 教学班名 / 教师 / 时间地点 都要能搜到
  filtered.value = hits.filter((h) => {
    const hay = [
      h.course?.nameZh ?? '',
      h.course?.code ?? '',
      h.nameZh ?? '',
      h.scheduleText ?? '',
      teachersOf(h).join(' '),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(k)
  })
}

/** 教师列表的形状随教务而变，所以按「能认出来就认」处理 */
function teachersOf(h: LessonSearchHit): string[] {
  const list = h.teacherAssignmentList
  if (!Array.isArray(list)) return []
  return list
    .map((t) => {
      if (typeof t === 'string') return t
      const o = t as Record<string, unknown>
      return String(o.nameZh ?? o.name ?? o.teacherName ?? '')
    })
    .filter(Boolean)
}

function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(' / ')
  const o = v as Record<string, unknown>
  return String(o.nameZh ?? o.name ?? o.value ?? '')
}

function codeOf(h: LessonSearchHit): string {
  return textOf(h.course?.code)
}

function idOf(h: LessonSearchHit): string {
  return textOf(h.id)
}

async function loadProbe(): Promise<void> {
  try {
    probe.value = await campusService.lessonSearchProbe()
  } catch {
    // 探测失败不该挡住查询本身：它是说明性的，不是前置条件
    probe.value = []
  }
}

async function run(): Promise<void> {
  if (semesterId.value == null) {
    toast('还没有拿到学期列表，先刷新一次')
    return
  }
  loading.value = true
  error.value = null
  try {
    const r = await campusService.lessonSearch(semesterId.value)
    outcome.value = r
    probe.value = r.domains
    if (!semesterId.value && r.semesters.length) semesterId.value = r.semesters[0].id
    applyFilter()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // 失败时也要把两个域的探测结论拿到手 —— 用户最需要知道的正是「哪个域不行」
    await loadProbe()
  } finally {
    loading.value = false
  }
}

/** 先探一次拿到学期列表，再查第一页 */
async function init(): Promise<void> {
  await loadProbe()
  await run()
}

onMounted(init)
</script>

<template>
  <section class="card open-course">
    <header class="head">
      <h2>全校开课查询</h2>
      <button class="mini" :disabled="loading" @click="run">
        <RefreshCw :size="14" :class="{ spin: loading }" />
        {{ loading ? '查询中' : '刷新' }}
      </button>
    </header>
    <p class="hint">
      看清全校开了哪些课、谁在什么时候上 —— <b>与选课批次无关</b>，批次没开也能查。
      查到合适的班可以照着去排抢课计划。
    </p>

    <!-- 两个域都检测：把各自的结论摆出来，不合并 -->
    <div v-if="probe.length" class="domains">
      <div v-for="d in probe" :key="d.baseUrl" class="domain" :class="{ ok: d.eamsAssets, off: !d.eamsAssets }">
        <span class="host">{{ d.baseUrl.replace(/^https?:\/\//, '') }}</span>
        <span class="verdict">{{ d.eamsAssets ? 'EAMS5' : '另一套系统' }}</span>
        <span class="detail">{{ d.detail }}</span>
      </div>
    </div>

    <EmptyState
      v-if="error"
      :icon="AlertTriangle"
      title="两个域都没查到"
      :hint="error"
    />

    <template v-else-if="outcome">
      <div class="toolbar">
        <label class="field">
          <Search :size="14" />
          <input v-model="keyword" placeholder="按课名 / 代码 / 教师 / 时间地点筛选本页" @input="applyFilter" />
        </label>
        <span class="count">
          {{ filtered.length }} 条
          <template v-if="outcome.page.total != null"> / 共 {{ outcome.page.total }}</template>
        </span>
      </div>

      <p class="src">
        数据来自
        <b>{{ (outcome.usedBaseUrl ?? '').replace(/^https?:\/\//, '') }}</b>
      </p>

      <EmptyState
        v-if="!filtered.length"
        :icon="Info"
        title="这一页没有开课记录"
        :hint="
          outcome.page.rawKeys.length
            ? `教务返回的字段：${outcome.page.rawKeys.join('、')} —— 空列表时先看这里，能区分「确实没开课」和「教务改了字段名」`
            : '换个学期或稍后再试'
        "
      />

      <ul v-else class="list">
        <li v-for="h in filtered" :key="idOf(h)" class="row">
          <div class="l1">
            <span class="name">{{ h.course?.nameZh ?? '(未知课程)' }}</span>
            <span v-if="h.nameZh" class="lesson">{{ h.nameZh }}</span>
            <span v-if="codeOf(h)" class="num">{{ codeOf(h) }}</span>
            <span v-if="h.course?.credits != null" class="dim">{{ h.course.credits }} 学分</span>
          </div>
          <div class="l2 dim">
            <span v-if="teachersOf(h).length">教师 {{ teachersOf(h).join('、') }}</span>
            <span v-if="h.scheduleText">{{ h.scheduleText }}</span>
            <span v-if="textOf(h.campus)">{{ textOf(h.campus) }}</span>
            <span v-if="textOf(h.courseType)">{{ textOf(h.courseType) }}</span>
          </div>
        </li>
      </ul>
    </template>

    <p v-else-if="loading" class="hint">正在查开课名单…</p>
  </section>
</template>

<style scoped>
.card {
  padding: 14px;
  border-radius: var(--radius-m);
  background: var(--surface);
  margin-bottom: 14px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.head h2 {
  font-size: var(--fs-title);
  font-weight: 600;
  margin: 0;
}
.mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-caption);
  padding: 5px 10px;
  border-radius: var(--radius-s);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
}
.hint {
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-2);
  margin: 8px 0 0;
}
.domains {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.domain {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--radius-s);
  border: 1px solid var(--line);
  font-size: var(--fs-caption);
}
.domain.ok { border-color: var(--ok, #2f9e63); }
.domain.off { opacity: 0.75; }
.host { font-weight: 600; }
.verdict {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-2);
}
.detail { color: var(--text-2); flex: 1 1 100%; }
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  padding: 6px 9px;
  border-radius: var(--radius-s);
  border: 1px solid var(--line);
  background: var(--surface-2, transparent);
}
.field input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-caption);
  outline: none;
}
.count { font-size: var(--fs-caption); color: var(--text-2); white-space: nowrap; }
.src { font-size: var(--fs-caption); color: var(--text-2); margin: 8px 0 0; }
.list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.row {
  padding: 9px 10px;
  border-radius: var(--radius-s);
  border: 1px solid var(--line);
}
.l1 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.name { font-weight: 600; }
.lesson { font-size: var(--fs-caption); color: var(--text-2); }
.num { font-variant-numeric: tabular-nums; font-size: var(--fs-caption); color: var(--text-2); }
.l2 { display: flex; flex-wrap: wrap; gap: 10px; font-size: var(--fs-caption); margin-top: 4px; }
.dim { color: var(--text-2); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
