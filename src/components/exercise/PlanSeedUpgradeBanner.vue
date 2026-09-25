<script setup lang="ts">
import { computed, ref } from 'vue'
import { Merge, RefreshCw, ShieldCheck, Sparkles } from 'lucide-vue-next'

import AppMenu from '@/components/common/AppMenu.vue'
import { usePlanStore } from '@/stores/plan'
import { useToast } from '@/composables/useToast'

/**
 * 内置课程新版本横幅：版本升级时不再自动覆盖用户数据，改为三选一。
 *  - 兼容合并（推荐）：新种子按动作字段级合并进本地内置课，用户设置过的值全部保留；
 *  - 使用新版本：内置课内容整体替换为新种子；
 *  - 保留我的：本版本不再刷新内置课内容，下个种子版本再问。
 */
const planStore = usePlanStore()
const { toast } = useToast()

const sheetOpen = ref(false)
const busy = ref(false)
/** 菜单锚点：横幅里那颗「更新」——bind 菜单要贴着它弹 */
const optBtn = ref<HTMLElement | null>(null)

const SUMMARY = computed(() => {
  const s = planStore.seed
  return s ? `内置课程有更新（${s.currentVersion} → ${s.latestVersion}）` : '内置课程有更新'
})

async function run(fn: () => Promise<void>, ok: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
    toast(ok)
  } finally {
    busy.value = false
  }
}

function onPick(value: string): void {
  sheetOpen.value = false
  if (value === 'migrate') void run(planStore.applySeedMigrate, '已按你的数据合并新版课程')
  else if (value === 'override') void run(planStore.applySeedOverride, '已使用新版内置课程')
  else if (value === 'keep') void run(planStore.applySeedKeep, '已保留你的课程')
}

/** 三选一是平级命令（怎么应用更新），不是破坏性确认 —— 走 bind 菜单，图标 + 文字 */
const ACTIONS = [
  { label: '兼容合并', value: 'migrate', icon: Merge },
  { label: '使用新版本', value: 'override', icon: RefreshCw },
  { label: '保留我的', value: 'keep', icon: ShieldCheck },
]
</script>

<template>
  <div v-if="planStore.seedPending" class="banner">
    <div class="row center iconbox">
      <Sparkles :size="20" />
    </div>
    <div class="flex-1 col text">
      <p class="title">{{ SUMMARY }}</p>
      <p class="desc">不会覆盖你的修改，可先看看你的版本</p>
    </div>
    <button ref="optBtn" class="opt" :disabled="busy" @click="sheetOpen = true">更新</button>

    <!-- 贴着「更新」弹的 bind 菜单：三项平级、都能反悔（不改数据的那项排在最后） -->
    <AppMenu
      :open="sheetOpen"
      :anchor="optBtn"
      title="如何应用新版内置课程？"
      :actions="ACTIONS"
      @select="onPick"
      @close="sheetOpen = false"
    />
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 14px;
  border-radius: var(--radius-l);
  background: linear-gradient(135deg, rgba(146, 232, 42, 0.14), rgba(10, 132, 255, 0.08));
  border: 1px solid var(--line);
}

.iconbox {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--c-exercise-soft);
  color: var(--c-exercise-deep);
}

.text {
  gap: 2px;
}

.title {
  font-size: var(--fs-callout);
  font-weight: 700;
}

.desc {
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.opt {
  flex: none;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  background: var(--text-1);
  color: var(--bg);
  font-size: var(--fs-footnote);
  font-weight: 600;
}
</style>
