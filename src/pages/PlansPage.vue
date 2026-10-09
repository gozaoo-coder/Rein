<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Plus } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PlanSeedUpgradeBanner from '@/components/exercise/PlanSeedUpgradeBanner.vue'
import { usePlanStore } from '@/stores/plan'
import { estimatePlanMinutes, planTypeLabel } from '@/utils/plan'

/** 全部课程：训练课程的管理入口（列表 → 详情/编辑/新建）。 */
const router = useRouter()
const planStore = usePlanStore()

onMounted(() => {
  void planStore.ensureLoaded()
})

function fmtUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '未使用'
  const ms = Date.now() - Date.parse(lastUsedAt.includes('T') ? lastUsedAt : `${lastUsedAt.replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) return '未使用'
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return '今天用过'
  if (days === 1) return '昨天用过'
  if (days < 30) return `${days} 天前用过`
  return '很久未用'
}
</script>

<template>
  <div class="page">
    <PageHeader back title="全部课程" subtitle="最近使用的排在前面" />
    <!-- 超范围平移层：页头留在层外，到边拖动时只有内容位移（system/rubberScroll） -->
    <div class="rubber-layer" data-rubber-content>

    <!-- 内置课程新版本：不再自动覆盖，交给用户三选一 -->
    <PlanSeedUpgradeBanner />

    <button class="new row center" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="18" /> 新建课程
    </button>

    <!-- d-full：课程清单这张卡通栏，多栏摊到卡**内部**去（理由见样式里的桌面段） -->
    <section class="card d-full plans-card">
      <EmptyState
        v-if="planStore.loaded && planStore.plans.length === 0"
        :icon="Plus"
        title="还没有训练课程"
        hint="点上方「新建课程」创建一个"
      />
      <ul v-else class="list d-list">
        <li v-for="p in planStore.plans" :key="p.id">
          <button class="row item" type="button" @click="void router.push(`/sports/plans/${p.id}`)">
            <div class="flex-1">
              <p class="name">{{ p.name }}</p>
              <p class="meta num">
                {{ p.subtitle || '自定义课程' }} · {{ p.exercises.length }} 个动作 · 约 {{ estimatePlanMinutes(p) }} 分钟
              </p>
            </div>
            <div class="col right">
              <span class="type">{{ planTypeLabel(p.workoutType) }}</span>
              <span class="used num">{{ fmtUsed(p.lastUsedAt) }}</span>
            </div>
            <ChevronRight :size="16" class="chev" />
          </button>
        </li>
      </ul>
    </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.new {
  width: 100%;
  margin-bottom: 14px;
  gap: 7px;
  padding: 15px 0;
  border-radius: var(--radius-l);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-body);
  font-weight: 700;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.item {
  width: 100%;
  gap: 12px;
  padding: 13px 0;
  text-align: left;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.name {
  font-size: var(--fs-body);
  font-weight: 600;
}

.meta {
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.right {
  align-items: flex-end;
  flex: none;
  gap: 2px;
}

.type {
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 8px;
  background: rgba(146, 232, 42, 0.16);
  color: #5ba800;
}

@media (prefers-color-scheme: dark) {
  .type {
    color: var(--c-exercise);
  }
}

.used {
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.chev {
  color: var(--text-3);
  flex: none;
}

/* ---------- 桌面（≥ --desk-min 时壳层才渲染 .desk-main，所以这里不用写断点） ----------
   课程清单一整张卡在桌面上被壳层压成半栏（.page 的直接子级 .card），右半屏空着。
   让**卡片**通栏，把多栏摊到卡内部：课程条只有「名字 + 动作数/时长 + 类型 + 上次使用」，
   480px 外还有一半宽度没用上，两栏读起来正好。

   通栏由模板上的 .d-full 声明。 */

/* 卡内两栏流：课程是**无序**清单（排序按最近使用，没有阅读顺序依赖），
   分栏后「先读完左栏再读右栏」不会读错。用多栏流而不是 grid：
   副标题会换行，条目高度不一，grid 会把同行的两条一起撑高。 */
.desk-main .plans-card .list {
  --d-cols: 2;
}
</style>
