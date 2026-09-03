<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronRight, Play, Plus } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import { usePlanStore } from '@/stores/plan'
import { useSessionStore } from '@/stores/session'
import { openImmersive } from '@/system/sessionImmersive'
import { estimatePlanMinutes } from '@/utils/plan'
import type { WorkoutPlanRecord } from '@/types'

/**
 * 训练课程卡：训练主页只展示最近使用的三个课程；
 * 全部课程的管理（列表/详情/编辑）收敛在 /sports/plans 二级页。
 */
const router = useRouter()
const planStore = usePlanStore()
const session = useSessionStore()

const conflictOpen = ref(false)
const startingId = ref('')

onMounted(() => {
  void planStore.ensureLoaded()
})

/** 快速开始（卡片播放键）：已有进行中会话时提示前往接续。
 *  形变锚点 = 被点的播放键本身（从哪点从哪长出，且不依赖此刻
 *  可能尚未落位的悬浮条）。 */
async function quickStart(e: MouseEvent, p: WorkoutPlanRecord): Promise<void> {
  startingId.value = p.id
  const origin = e.currentTarget as HTMLElement | null // await 后 currentTarget 已置 null，同步先抓
  try {
    const r = await session.start(p)
    if (r === 'conflict') conflictOpen.value = true
    else openImmersive(origin)
  } finally {
    startingId.value = ''
  }
}

/** 接续进行中的会话：训练课开沉浸层，跑步转跑步路由 */
function goConflict(): void {
  conflictOpen.value = false
  if (session.foreignRoute) void router.push(session.foreignRoute)
  else openImmersive()
}
</script>

<template>
  <section class="card">
    <header class="row between head">
      <h2>训练课程</h2>
      <button class="all row" type="button" @click="void router.push('/sports/plans')">
        全部课程 <ChevronRight :size="15" />
      </button>
    </header>

    <ul v-if="planStore.recent.length > 0" class="list">
      <li v-for="p in planStore.recent" :key="p.id" class="row item">
        <button class="row body flex-1" type="button" @click="void router.push(`/sports/plans/${p.id}`)">
          <span class="flex-1">
            <b class="name">{{ p.name }}</b>
            <small class="meta num">
              {{ p.subtitle || '自定义课程' }} · {{ p.exercises.length }} 个动作 · 约 {{ estimatePlanMinutes(p) }} 分钟
            </small>
          </span>
        </button>
        <button
          class="play col center"
          type="button"
          :aria-label="`开始「${p.name}」`"
          :disabled="startingId === p.id"
          @click="quickStart($event, p)"
        >
          <Play :size="16" :stroke-width="2.6" />
        </button>
      </li>
    </ul>

    <button v-else class="new row center" type="button" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="17" /> 创建第一个训练课程
    </button>

    <button class="more row center" type="button" @click="void router.push('/sports/plans/new/edit')">
      <Plus :size="16" /> 新建课程
    </button>

    <ActionSheet
      :open="conflictOpen"
      title="已有进行中的训练，请先接续"
      :actions="[{ label: '前往继续', value: 'go' }]"
      @select="goConflict"
      @close="conflictOpen = false"
    />
  </section>
</template>

<style scoped>
.head h2 {
  font-size: var(--fs-title3);
  font-weight: 700;
  letter-spacing: -0.3px;
}

.all {
  gap: 0;
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-2);
}

.list {
  margin-top: 4px;
}

.item {
  gap: 10px;
  padding: 11px 0;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.body {
  gap: 10px;
  text-align: left;
  min-width: 0;
}

.name {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-caption);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.play {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 50%;
  background: var(--text-1);
  color: var(--bg);
  padding-left: 2px;
}

.play:disabled {
  opacity: 0.4;
}

.new,
.more {
  width: 100%;
  gap: 6px;
  border-radius: var(--radius-m);
  font-size: var(--fs-callout);
  font-weight: 700;
}

.new {
  margin-top: 6px;
  padding: 22px 0;
  background: var(--surface-2);
  color: var(--text-2);
}

.more {
  margin-top: 10px;
  padding: 12px 0;
  background: var(--surface-2);
  color: var(--text-2);
}

.more:active,
.new:active {
  opacity: 0.7;
}
</style>
