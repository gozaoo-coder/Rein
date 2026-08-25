<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  BrainCircuit,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ModelFormSheet from '@/components/ai/ModelFormSheet.vue'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import type { AiModel } from '@/types'

/** 模型管理：添加 / 编辑 / 删除 / 设默认，max_tokens=1 探测视觉·思考·努力。 */
const store = useModelsStore()
const toast = useToast()

onMounted(() => {
  void store.load().catch(() => toast.toast('模型列表加载失败'))
})

const formOpen = ref(false)
const editing = ref<AiModel | null>(null)
const deleting = ref<AiModel | null>(null)

function onAdd(): void {
  editing.value = null
  formOpen.value = true
}

function onEdit(m: AiModel): void {
  editing.value = m
  formOpen.value = true
}

function onSaved(id: number): void {
  void store.runProbe(id)
}

function probe(m: AiModel): void {
  void store.runProbe(m.id)
}

function setDefault(m: AiModel): void {
  void store
    .setDefault(m.id)
    .then(() => toast.toast(`已设为默认：${m.name}`))
    .catch(() => toast.toast('设置默认失败'))
}

const deleteActions = computed(() => [
  { label: `删除「${deleting.value?.name ?? ''}」`, value: 'delete', danger: true },
])

function onDeleteAction(value: string): void {
  if (value !== 'delete' || !deleting.value) return
  const m = deleting.value
  deleting.value = null
  void store
    .remove(m.id)
    .then(() => toast.toast(`已删除 ${m.name}`))
    .catch(() => toast.toast('删除失败'))
}

const capMeta = {
  vision: { label: '视觉', icon: Eye },
  thinking: { label: '思考', icon: Sparkles },
  effort: { label: '努力', icon: SlidersHorizontal },
} as const
</script>

<template>
  <div class="page">
    <PageHeader title="管理模型" subtitle="添加 AI 模型并测试能力后即可拍照识别" back>
      <template #action>
        <button class="hdr-btn accent" aria-label="添加模型" @click="onAdd">
          <Plus :size="19" />
        </button>
      </template>
    </PageHeader>

    <div class="intro t-2">
      <p>每条模型保存后会自动发送 <b>max_tokens=1</b> 的测试包，探测「视觉（图片上传）、thinking 开关、effort 档位」三项能力，结果以徽章展示。</p>
    </div>

    <ul v-if="store.models.length > 0" class="cards">
      <li v-for="m in store.models" :key="m.id" class="card m-card">
        <div class="row between top">
          <div class="flex-1 min0">
            <p class="m-name">
              {{ m.name }}
              <span v-if="m.isDefault" class="chip-def">默认</span>
            </p>
            <p class="m-id t-2">{{ m.provider }} · {{ m.modelId }}</p>
          </div>
          <div class="acts">
            <button
              v-if="!m.isDefault"
              class="act"
              aria-label="设为默认"
              @click="setDefault(m)"
            >
              <Star :size="16" />
            </button>
            <button class="act" aria-label="编辑模型" @click="onEdit(m)">
              <Pencil :size="16" />
            </button>
            <button class="act" aria-label="删除模型" @click="deleting = m">
              <Trash2 :size="16" class="danger" />
            </button>
          </div>
        </div>

        <div class="caps row">
          <template v-for="(meta, key) in capMeta" :key="key">
            <span class="cap" :class="`cap-${m[key] === true ? 'ok' : m[key] === false ? 'no' : 'unk'}`">
              <component :is="meta.icon" :size="13" />
              {{ meta.label }}
              <span v-if="store.probing[m.id]" class="probe"><RefreshCw :size="11" class="spin" /></span>
            </span>
          </template>
          <button
            class="cap retest"
            :disabled="store.probing[m.id]"
            @click="probe(m)"
          >
            <RefreshCw :size="13" :class="{ spin: store.probing[m.id] }" />
            重新测试
          </button>
        </div>

        <p v-if="m.lastError" class="err t-3">{{ m.lastError }}</p>
      </li>
    </ul>

    <section v-else class="empty card">
      <EmptyState
        :icon="BrainCircuit"
        title="还没有 AI 模型"
        hint="点右上角或下方按钮添加模型，DeepSeek 视觉模型 deepseek-v4-flash-vision-exp 可直接拍照识别食物"
      />
    </section>

    <button class="fab row center" aria-label="添加模型" @click="onAdd">
      <Plus :size="17" />
      添加模型
    </button>

    <ModelFormSheet :open="formOpen" :model="editing" @close="formOpen = false" @saved="onSaved" />
    <ActionSheet
      :open="deleting !== null"
      :title="`删除后照片识别将无法使用该模型`"
      :actions="deleteActions"
      @close="deleting = null"
      @select="onDeleteAction"
    />
  </div>
</template>

<style scoped>
.page {
  /* 与 AIPage 同因：可用高度还要扣 app-frame 的 safe-top 状态栏 padding，
     以及悬浮运动条停靠 bottom 时的 --wbar-reserve（无运动 / 其他槽位为 0） */
  height: calc(
    100dvh - var(--safe-top) - var(--tabbar-h) - var(--safe-bottom) - var(--wbar-reserve, 0px)
  );
  overflow-y: auto;
  padding: 10px var(--page-pad-x) 96px;
  scrollbar-width: none;
}

.intro {
  font-size: var(--fs-caption);
  line-height: 1.6;
  padding: 2px 2px 12px;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.m-card {
  padding: 14px;
}

.m-name {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.chip-def {
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}

.m-id {
  margin-top: 3px;
  font-size: var(--fs-caption);
  word-break: break-all;
}

.acts {
  display: flex;
  gap: 2px;
  flex: none;
}

.act {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: var(--surface-2);
}

.act .danger {
  color: var(--danger, #ff5257);
}

.caps {
  margin-top: 10px;
  gap: 6px;
  flex-wrap: wrap;
}

.cap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 700;
  background: var(--surface-2);
  color: var(--text-3);
}

.cap-ok {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}

.cap-no {
  background: color-mix(in srgb, var(--danger, #ff5257) 14%, transparent);
  color: var(--danger, #ff5257);
}

.cap .probe {
  display: inline-flex;
}

.retest {
  border: unset;
  color: var(--text-2);
  background: transparent;
}

.retest:disabled {
  opacity: 0.4;
}

.spin {
  animation: rotate 0.9s linear infinite;
}

@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}

.err {
  margin-top: 8px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  word-break: break-all;
  color: var(--text-3);
}

.empty {
  margin-top: 6px;
}

.fab {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 14px);
  z-index: 50;
  gap: 5px;
  padding: 13px 24px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: #fff;
  box-shadow: var(--shadow-float);
  font-size: var(--fs-headline);
  font-weight: 700;
  transition: transform var(--dur-fast) var(--ease-standard);
}

.fab:active {
  transform: translateX(-50%) scale(0.95);
}
</style>
