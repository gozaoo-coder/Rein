<script setup lang="ts">
/**
 * 提供商详情抽屉：凭据摘要 → 拉模型清单 → 预览几条 → 启用。
 *
 * 列表只放**前几条预览**，「查看全部」另开一层抽屉（ProviderModelsSheet）——
 * 目录动辄几十条，在详情里展开会把下面的说明与按钮一路推下去（DOM 重排），
 * 而抽屉是独立一层：展开多少都不动底下的页面。
 */
import { computed, ref } from 'vue'
import { AlertCircle, CloudDownload, Pencil, RefreshCw } from 'lucide-vue-next'

import ModelCandidateList from '@/components/ai/ModelCandidateList.vue'
import ProviderModelsSheet from '@/components/ai/ProviderModelsSheet.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider } from '@/types'

/** 详情里预览几条（其余去「查看全部」） */
const PREVIEW = 5

const props = defineProps<{ open: boolean; provider: AiProvider | null }>()

const emit = defineEmits<{ close: []; edit: [AiProvider] }>()

const providers = useProvidersStore()
const roles = useModelRolesStore()
const toast = useToast()

const allOpen = ref(false)
const activating = ref('')

/** 一律读 store 里的那一行：拉目录/启用之后 store 会整表刷新，
 *  组件若抱着打开时的那份快照，目录就不会跟着更新 */
const live = computed(() =>
  props.provider ? (providers.providerOf(props.provider.id) ?? props.provider) : null,
)

const adapter = computed(() => (live.value ? providers.adapterOf(live.value.adapter) : undefined))
const catalog = computed(() => (live.value ? providers.catalogs[live.value.id] : undefined))
const busy = computed(() => (live.value ? !!providers.fetching[live.value.id] : false))

/** 预览行：按类别排好（对话 → 视觉 → 识别 → 向量），每类最多几条 */
const preview = computed(() => {
  const p = live.value
  if (!p) return []
  const order = ['llm', 'vision', 'asr', 'embedding', 'tts']
  return [...p.models]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.modelId.localeCompare(b.modelId))
    .slice(0, PREVIEW)
    .map((m) => ({
      ref: `${p.id}:${m.modelId}`,
      label: m.modelId,
      sub: `${KIND_LABEL[m.kind]}${m.origin === 'preset' ? ' · 内置参考' : m.origin === 'manual' ? ' · 手填' : ''}${
        roles.isActive(p, m) ? ' · 已启用' : ''
      }`,
      provider: p.name,
      kind: m.kind,
      badge: roles.isActive(p, m) ? '使用中' : undefined,
    }))
})

async function fetchModels(): Promise<void> {
  const p = live.value
  if (!p) return
  const result = await providers.fetchModels(p.id)
  if (!result) return
  if (result.ok) toast.toast(`已拉到 ${result.models.length} 个模型`)
  else toast.toast(result.error ?? '拉取失败')
}

/** 预览行点一下 = 启用（按类别落到对应执行位） */
async function activateByRef(ref_: string): Promise<void> {
  const p = live.value
  if (!p) return
  const modelId = ref_.slice(`${p.id}:`.length)
  const model = p.models.find((m) => m.modelId === modelId)
  if (!model || activating.value) return
  activating.value = ref_
  try {
    const msg = await roles.activate(p, model)
    toast.toast(msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '启用失败')
  } finally {
    activating.value = ''
  }
}

const keyTail = computed(() => (live.value?.apiKey ? live.value.apiKey.slice(-4) : ''))
</script>

<template>
  <SheetModal :open="open" :title="live?.name ?? '提供商'" initial-snap="large" @close="emit('close')">
    <div v-if="live" class="pv">
      <!-- 凭据摘要：编辑走另一个抽屉（不在本层展开表单） -->
      <section class="card cred">
        <div class="row between center">
          <span class="row center gap">
            <b class="ad-label">{{ adapter?.label ?? live.adapter }}</b>
            <i class="style">{{ adapter?.styles.find((s) => s.id === live!.apiStyle)?.label ?? live.apiStyle }}</i>
          </span>
          <button type="button" class="edit" @click="emit('edit', live)">
            <Pencil :size="13" />
            编辑
          </button>
        </div>
        <p class="kv t-2">{{ live.baseUrl }}</p>
        <p class="kv t-3">
          密钥 ****{{ keyTail }}<template v-if="live.lastSyncAt">
            · 上次同步 {{ live.lastSyncAt.slice(0, 16).replace('T', ' ') }}</template>
        </p>
        <p v-if="live.lastError" class="err">
          <AlertCircle :size="13" />
          {{ live.lastError }}
        </p>
        <div class="row gap">
          <button type="button" class="btn primary" :disabled="busy" @click="fetchModels">
            <RefreshCw :size="14" :class="{ spin: busy }" />
            {{ busy ? '拉取中…' : '获取模型列表' }}
          </button>
        </div>
        <p v-if="catalog?.fromPreset" class="hint t-3">
          接口没通，下面列的是内置参考目录：可以手填模型 ID，或确认地址/密钥后重试。
        </p>
      </section>

      <!-- 目录预览：只放前几条，全部另开抽屉 -->
      <section class="card list-card">
        <div class="row between center">
          <span class="l">模型目录（{{ live.models.length }}）</span>
          <button type="button" class="more" @click="allOpen = true">查看全部 ›</button>
        </div>
        <ModelCandidateList
          :items="preview"
          :folder="false"
          :display="false"
          :active-of="(c) => !!c.badge"
          empty-text="还没有目录：点上面「获取模型列表」，或在全部模型里手填一个"
          @select="activateByRef"
        />
        <p class="hint t-3">
          点一条即启用：对话/视觉模型进「全部模型」，识别模型写进语音服务，向量模型写进知识库设置。
        </p>
      </section>

      <p class="hint t-3 foot">
        <CloudDownload :size="12" />
        启用状态以本机实际配置为准（这里只做「启用」；换用哪个模型去模型页的「服务模型」卡）。
      </p>
    </div>

    <ProviderModelsSheet
      :open="allOpen"
      :provider="live"
      @close="allOpen = false"
      @activated="toast.toast($event)"
    />
  </SheetModal>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 10px;
}

.card {
  padding: 13px 14px;
}

.cred {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ad-label {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.style {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
}

.edit {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--accent);
}

.kv {
  font-size: var(--fs-caption);
  word-break: break-all;
}

.err {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--danger, #ff5257);
  word-break: break-all;
}

.btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 11px 0;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  color: var(--text);
  font-size: var(--fs-footnote);
  font-weight: 700;
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.btn:disabled {
  opacity: 0.5;
}

.list-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.l {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.more {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--accent);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.foot {
  padding: 0 2px;
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
