<script setup lang="ts">
/**
 * 全部模型抽屉：本机已配置的模型（ai_models）一览 —— 设默认 / 重新探测 / 编辑 / 删除。
 *
 * 为什么单独一层：模型页主体只放「服务模型 + 提供商」，把这条长列表塞在页面里
 * 会让下方所有内容随列表长度重排；抽屉展开时页面不动，关掉即恢复。
 */
import { computed, ref } from 'vue'
import { Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-vue-next'

import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import ActionSheet from '@/components/common/ActionSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { groupByProvider, modelDisplayName } from '@/ai/providerCatalog'
import { formatUnitPrice } from '@/ai/cost'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { useProvidersStore } from '@/stores/providers'
import type { AiModel } from '@/types'

const emit = defineEmits<{ close: []; add: []; edit: [AiModel] }>()

const models = useModelsStore()
const providers = useProvidersStore()
const toast = useToast()

defineProps<{ open: boolean }>()

const query = ref('')
const deleting = ref<AiModel | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = models.models
  if (!q) return list
  return list.filter((m) =>
    `${m.name} ${m.modelId} ${providers.nickname(m.provider)}`.toLowerCase().includes(q),
  )
})

const groups = computed(() =>
  groupByProvider(
    filtered.value,
    (m) => providers.nickname(m.provider),
    providers.prefs.providerNameFolder,
  ),
)

function labelOf(m: AiModel): string {
  return modelDisplayName(m.name, providers.nickname(m.provider), providers.prefs.providerNameDisplay)
}

function setDefault(m: AiModel): void {
  void models
    .setDefault(m.id)
    .then(() => toast.toast(`已设为默认：${m.name}`))
    .catch(() => toast.toast('设置默认失败'))
}

function probe(m: AiModel): void {
  void models.runProbe(m.id)
}

const deleteActions = computed(() => [
  { label: `删除「${deleting.value?.name ?? ''}」`, value: 'delete', danger: true },
])

function onDelete(value: string): void {
  if (value !== 'delete' || !deleting.value) return
  const m = deleting.value
  deleting.value = null
  void models
    .remove(m.id)
    .then(() => toast.toast(`已删除 ${m.name}`))
    .catch(() => toast.toast('删除失败'))
}

const capMeta = {
  vision: '视觉',
  thinking: '思考',
  effort: '努力',
} as const

function capTone(v: boolean | null): string {
  return v === true ? 'ok' : v === false ? 'no' : 'unk'
}
</script>

<template>
  <SheetModal :open="open" title="全部模型" initial-snap="large" @close="emit('close')">
    <div class="all">
      <ModelListToolbar
        :query="query"
        :count="filtered.length"
        :total="models.models.length"
        :folder="providers.prefs.providerNameFolder"
        :display="providers.prefs.providerNameDisplay"
        @update:query="query = $event"
        @update:folder="providers.savePrefs({ providerNameFolder: $event })"
        @update:display="providers.savePrefs({ providerNameDisplay: $event })"
      />

      <div class="list" data-rubber-self>
        <p v-if="filtered.length === 0" class="none t-3">没有匹配的模型</p>
        <section v-for="g in groups" v-else :key="g.provider || '_'" class="grp">
          <p v-if="providers.prefs.providerNameFolder && g.provider" class="grp-head">
            {{ g.provider }}<span class="cnt t-3">{{ g.items.length }}</span>
          </p>
          <ul>
            <li v-for="m in g.items" :key="m.id" class="card m-card">
              <div class="row between top">
                <div class="flex-1 min0">
                  <p class="m-name">
                    {{ labelOf(m) }}
                    <span v-if="m.source === 'online'" class="chip-onl">在线</span>
                    <span v-if="m.isDefault" class="chip-def">默认</span>
                  </p>
                  <p class="m-id t-2">{{ providers.nickname(m.provider) }} · {{ m.modelId }}</p>
                  <p v-if="formatUnitPrice(m)" class="m-cost t-3">{{ formatUnitPrice(m) }}</p>
                </div>
                <div class="acts">
                  <button v-if="!m.isDefault" class="act" aria-label="设为默认" @click="setDefault(m)">
                    <Star :size="15" />
                  </button>
                  <button class="act" aria-label="重新测试能力" :disabled="models.probing[m.id]" @click="probe(m)">
                    <RefreshCw :size="15" :class="{ spin: models.probing[m.id] }" />
                  </button>
                  <button class="act" aria-label="编辑模型" @click="emit('edit', m)">
                    <Pencil :size="15" />
                  </button>
                  <button class="act" aria-label="删除模型" @click="deleting = m">
                    <Trash2 :size="15" class="danger" />
                  </button>
                </div>
              </div>
              <div class="row caps">
                <span
                  v-for="(label, key) in capMeta"
                  :key="key"
                  class="cap"
                  :class="`cap-${capTone(m[key])}`"
                >
                  {{ label }}
                </span>
                <span v-if="m.lastError" class="err t-3">{{ m.lastError }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <button type="button" class="add" @click="emit('add')">
        <Plus :size="15" />
        手动添加模型
      </button>
    </div>

    <ActionSheet
      :open="deleting !== null"
      title="删除后用到该模型的功能会回落到默认模型"
      :actions="deleteActions"
      @close="deleting = null"
      @select="onDelete"
    />
  </SheetModal>
</template>

<style scoped>
.all {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 10px;
}

.list {
  max-height: 56dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.none {
  text-align: center;
  padding: 26px 0;
  font-size: var(--fs-footnote);
}

.grp + .grp {
  margin-top: 12px;
}

.grp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px;
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 700;
}

.grp-head .cnt {
  font-weight: 600;
}

.m-card {
  padding: 13px 14px;
}

.m-card + .m-card {
  margin-top: 8px;
}

.m-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-subhead);
  font-weight: 700;
  word-break: break-all;
}

.chip-def,
.chip-onl {
  font-size: var(--fs-micro);
  font-weight: 800;
  padding: 2px 7px;
  border-radius: var(--radius-full);
}

.chip-def {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.chip-onl {
  background: var(--surface-2);
  color: var(--text-2);
}

.m-id,
.m-cost {
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
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: var(--surface-2);
}

.act:disabled {
  opacity: 0.4;
}

.act .danger {
  color: var(--danger, #ff5257);
}

.caps {
  margin-top: 9px;
  gap: 6px;
  flex-wrap: wrap;
}

.cap {
  padding: 3px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-micro);
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

.err {
  font-size: var(--fs-micro);
  word-break: break-all;
}

.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text);
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.spin {
  animation: rotate 0.9s linear infinite;
}

@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
