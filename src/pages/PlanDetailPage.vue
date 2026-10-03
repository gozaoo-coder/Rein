<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronDown, Play, Pencil, SearchX, Trash2 } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ExerciseDetailDrawer from '@/components/exercise/ExerciseDetailDrawer.vue'
import { useExerciseLibStore } from '@/stores/exerciseLib'
import { usePlanStore } from '@/stores/plan'
import { useSessionStore } from '@/stores/session'
import { openImmersive } from '@/system/sessionImmersive'
import { useToast } from '@/composables/useToast'
import { estimatePlanMinutes, exerciseBadge, exerciseSub, planTypeLabel } from '@/utils/plan'
import type { PlanExercise } from '@/types'

/** 课程详情：动作明细，点击动作弹抽屉（激活肌群 / 参数 / 要点），开始训练 / 编辑 / 删除。 */
const route = useRoute()
const router = useRouter()
const planStore = usePlanStore()
const lib = useExerciseLibStore()
const session = useSessionStore()
const { toast } = useToast()

const ready = ref(false)
const detailEx = ref<PlanExercise | null>(null)
const conflictOpen = ref(false)
const delOpen = ref(false)

onMounted(async () => {
  await Promise.all([planStore.ensureLoaded(), lib.ensureLoaded()])
  ready.value = true
})

const plan = computed(() => planStore.byId(String(route.params.id)))
/** 开始训练；已有进行中会话（训练课/跑步）时提示前往接续。
 *  形变锚点 = 开始按钮（从哪点从哪长出）。 */
async function onStart(e: MouseEvent): Promise<void> {
  if (!plan.value) return
  const origin = e.currentTarget as HTMLElement | null // await 后 currentTarget 已置 null，同步先抓
  const r = await session.start(plan.value)
  if (r === 'conflict') conflictOpen.value = true
  else openImmersive(origin)
}

/** 接续进行中的会话：训练课开沉浸层，跑步转跑步路由 */
function goConflict(): void {
  conflictOpen.value = false
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive()
}

async function doDelete(): Promise<void> {
  delOpen.value = false
  if (!plan.value) return
  await planStore.remove(plan.value.id)
  toast('课程已删除')
  void router.replace('/sports/plans')
}
</script>

<template>
  <div class="page">
    <PageHeader back :title="plan?.name ?? '课程详情'">
      <template #action>
        <button v-if="plan" class="hdr-btn" aria-label="编辑课程" @click="void router.push(`/sports/plans/${plan.id}/edit`)">
          <Pencil :size="15" />
        </button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="ready && !plan"
      :icon="SearchX"
      title="课程不存在或已删除"
      hint="回到全部课程看看其他内容"
    />

    <template v-if="plan">
      <!-- 桌面画布：动作明细是这页唯一的主体，整块通栏；移动端这里只是一个普通块容器 -->
      <div class="pd-body">
        <p class="sum num t-2">
          {{ plan.subtitle || '自定义课程' }} · {{ planTypeLabel(plan.workoutType) }} ·
          {{ plan.exercises.length }} 个动作 · 约 {{ estimatePlanMinutes(plan) }} 分钟
        </p>

        <section class="card">
          <!-- 动作条目单独一层：桌面上按两栏流铺开（见样式里的 .exlist） -->
          <div class="exlist">
            <div v-for="(e, i) in plan.exercises" :key="e.id" class="exitem">
              <button type="button" class="row item-row" @click="detailEx = e">
                <span class="idx num">{{ e.group ?? i + 1 }}</span>
                <span class="mid flex-1">
                  <b class="nm">{{ lib.resolveName(e) }}</b>
                  <small class="sub">{{ exerciseSub(e) }}</small>
                </span>
                <span v-if="exerciseBadge(e)" class="badge">{{ exerciseBadge(e) }}</span>
                <ChevronDown :size="16" class="chev" />
              </button>
            </div>
          </div>

          <button type="button" class="start row center" @click="onStart">
            <Play :size="18" /> 开始「{{ plan.name }}」
          </button>
        </section>

        <button class="del row center" @click="delOpen = true">
          <Trash2 :size="16" /> 删除课程
        </button>
      </div>
    </template>

    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="goConflict"
      @close="conflictOpen = false"
    />

    <ActionSheet
      :open="delOpen"
      title="删除后无法恢复"
      :actions="[{ label: `删除「${plan?.name ?? ''}」`, value: 'del', danger: true }]"
      @select="doDelete"
      @close="delOpen = false"
    />

    <!-- 动作详情抽屉：激活肌群 / 训练参数 / 要点 -->
    <ExerciseDetailDrawer :open="detailEx != null" :exercise="detailEx" @close="detailEx = null" />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.sum {
  margin: 2px 2px 14px;
  font-size: var(--fs-footnote);
}

.exitem {
  border-radius: var(--radius-m);
  transition: background-color var(--dur-fast) var(--ease-standard);
}

.exitem:active {
  background: var(--surface-2);
}

.item-row {
  width: 100%;
  text-align: left;
  gap: 12px;
  padding: 12px 4px;
}

.idx {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  /* 50% 在装下「超级组 A1」这类宽内容时会把圆撑成椭圆；999px 方形收敛为圆、变宽是标准胶囊 */
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-caption);
  font-weight: 700;
  flex: none;
}

.nm {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
}

.sub {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-2);
  line-height: 1.45;
}

.badge {
  flex: none;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
  background: rgba(30, 234, 239, 0.14);
  color: #00858a;
}

@media (prefers-color-scheme: dark) {
  .badge {
    color: #1eeaef;
  }
}

.chev {
  color: var(--text-3);
}

.start {
  width: 100%;
  margin-top: 14px;
  gap: 7px;
  height: 52px;
  border-radius: 26px;
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: 700;
  box-shadow: 0 8px 20px rgba(29, 29, 31, 0.22);
}

.del {
  width: 100%;
  margin-top: 12px;
  gap: 6px;
  padding: 13px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--danger);
  font-size: var(--fs-callout);
  font-weight: 600;
}

/* ============================================================
   桌面（壳层只在 ≥ DESKTOP_MIN 时渲染 .desk-main，所以这里不写断点）
   ============================================================ */

/* 这页只有「一套动作」和一枚开始钮。壳层缺省会把 .card 压进半栏（479px），
   右半屏整块空着；动作明细本来就该通栏，所以这里自铺一张单列画布：
   通栏是缺省，将来要塞侧栏再往这里加一列即可。 */
.desk-main .pd-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--desk-gap);
  align-items: start;
}

/* 行距统一交给栅格 gap：条目自身那些 2/12/14px 的纵向边距清掉，
   否则和 gap 叠加成双倍间距 */
.desk-main .pd-body > * {
  min-width: 0;
  margin-block: 0;
}

/* 动作条目摊成两栏流：一行只有「序号 + 名称 / 处方」，970px 单列读起来空荡；
   两栏让整套课程一屏看完。用 columns 而不是 grid —— 处方文字长短不一，
   grid 会把同行条目撑到最高的那条，columns 是按内容自然分栏。
   条目自带序号，按栏读（先读完左栏再读右栏）顺序依然是 1→9。 */
.desk-main .exlist {
  columns: 2;
  column-gap: var(--desk-gap);
}

.desk-main .exlist > .exitem {
  break-inside: avoid;
}
</style>
