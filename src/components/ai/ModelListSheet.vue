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
import InfoHint from '@/components/common/InfoHint.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import StatusChip from '@/components/common/StatusChip.vue'
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

/** 探测结果的三项能力：用词与说明一致（「努力」这种无图例的内部说法不上屏） */
const capMeta = {
  vision: '看图',
  thinking: '深度思考',
  effort: '思考强度',
} as const

/** 探测档位 → 胶囊语义：支持 ok / 不支持 danger / 未测 neutral（未探测不是故障） */
function capTone(v: boolean | null): 'ok' | 'danger' | 'neutral' {
  return v === true ? 'ok' : v === false ? 'danger' : 'neutral'
}
</script>

<template>
  <SheetModal :open="open" title="全部模型" initial-snap="large" @close="emit('close')">
    <template #action>
      <InfoHint
        title="模型能力"
        content="这三项是保存模型时自动探测出来的能力（后台用最小测试包试一次）。

看图：模型能接收图片 —— 拍照识食、发图提问都靠它。

深度思考：模型有推理能力，回答前会先想一步。

思考强度：推理力度的档位，档位越高想得越久、费用也越高。

胶囊分三档：绿色 = 支持，红色 = 不支持；灰色带「未测」表示还没探测过（不是故障），重新测试即可。"
      />
    </template>
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
                  <p class="m-id t-2">{{ m.modelId }}</p>
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
                <StatusChip
                  v-for="(label, key) in capMeta"
                  :key="key"
                  :tone="capTone(m[key])"
                  size="sm"
                >
                  {{ label }}<template v-if="m[key] === null"> 未测</template>
                </StatusChip>
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
  font-size: var(--fs-caption);
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
  position: relative;
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
  opacity: var(--disabled-opacity);
}

/* 30 的圆钮命中区纵向撑到 44；横向不外扩 —— 同排四颗只隔 2px，
   再扩就会把相邻那颗的点击吃到自己里。 */
.act::after {
  content: '';
  position: absolute;
  inset: -7px 0;
}

.act .danger {
  color: var(--danger);
}

.caps {
  margin-top: 9px;
  gap: 6px;
  flex-wrap: wrap;
}

.err {
  font-size: var(--fs-caption);
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
  color: var(--text-1);
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
