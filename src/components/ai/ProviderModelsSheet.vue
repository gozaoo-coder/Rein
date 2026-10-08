<script setup lang="ts">
/**
 * 提供商模型目录（全部）：搜索 + 类别筛选 + 按提供商折叠 + 逐条启用 + 手填模型。
 *
 * 这是「查看全部」的那一层抽屉：目录几十条时不挤在详情里，搜索与筛选也只在这一层
 * 出现（详情里只有预览）。
 */
import { computed, ref, watch } from 'vue'
import { Check, Plus, Trash2 } from 'lucide-vue-next'

import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { KIND_LABEL } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelRolesStore } from '@/stores/modelRoles'
import { useProvidersStore } from '@/stores/providers'
import type { AiProvider, ProviderModelKind } from '@/types'

const props = defineProps<{ open: boolean; provider: AiProvider | null }>()

const emit = defineEmits<{ close: []; activated: [string] }>()

const providers = useProvidersStore()
const roles = useModelRolesStore()
const toast = useToast()

const query = ref('')
const kindFilter = ref<ProviderModelKind | 'all'>('all')
const busyRef = ref('')
/** 手填模型 */
const manualId = ref('')
const manualKind = ref<ProviderModelKind>('llm')
const adding = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    kindFilter.value = 'all'
    manualId.value = ''
    void roles.load()
  },
)

/** 一律读 store 里的那一行：加/删目录条目之后 store 会整表刷新 */
const live = computed(() =>
  props.provider ? (providers.providerOf(props.provider.id) ?? props.provider) : null,
)

const kinds = computed<ProviderModelKind[]>(() => {
  const p = live.value
  if (!p) return []
  const a = providers.adapterOf(p.adapter)
  const seen = new Set<ProviderModelKind>()
  for (const m of p.models) seen.add(m.kind)
  // 适配器声明的类别也列出来（即使目录里暂时没有），方便手填
  for (const k of a?.kinds ?? []) seen.add(k)
  return ['llm', 'vision', 'asr', 'embedding', 'tts'].filter((k) =>
    seen.has(k as ProviderModelKind),
  ) as ProviderModelKind[]
})

interface Row {
  ref: string
  label: string
  sub: string
  provider: string
  kind: ProviderModelKind
  badge?: string
}

const rows = computed<Row[]>(() => {
  const p = live.value
  if (!p) return []
  const q = query.value.trim().toLowerCase()
  return p.models
    .filter((m) => kindFilter.value === 'all' || m.kind === kindFilter.value)
    .filter((m) => !q || `${m.modelId} ${m.kind}`.toLowerCase().includes(q))
    .map((m) => {
      const active = roles.isActive(p, m)
      return {
        ref: m.modelId,
        label: m.modelId,
        sub: `${KIND_LABEL[m.kind]}${
          m.origin === 'preset' ? ' · 内置参考（接口清单里没有）' : m.origin === 'manual' ? ' · 手填' : ''
        }${active ? ' · 已启用' : ''}`,
        provider: p.name,
        kind: m.kind,
        badge: active ? '使用中' : undefined,
      }
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
})

async function activate(row: Row): Promise<void> {
  const p = live.value
  if (!p || busyRef.value) return
  const model = p.models.find((m) => m.modelId === row.ref)
  if (!model) return
  busyRef.value = row.ref
  try {
    const msg = await roles.activate(p, model)
    emit('activated', msg)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '启用失败')
  } finally {
    busyRef.value = ''
  }
}

async function addManual(): Promise<void> {
  const p = live.value
  const id = manualId.value.trim()
  if (!p || !id || adding.value) return
  adding.value = true
  try {
    await providers.addModel(p.id, id, manualKind.value)
    manualId.value = ''
    toast.toast(`已加入目录：${id}`)
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : '添加失败')
  } finally {
    adding.value = false
  }
}

async function removeRow(row: Row): Promise<void> {
  const p = live.value
  if (!p) return
  await providers.removeModel(p.id, row.ref)
  toast.toast('已从目录移除（接口清单里的条目下次同步会回来）')
}

const isManual = (row: Row): boolean => {
  const m = live.value?.models.find((x) => x.modelId === row.ref)
  return m?.origin === 'manual'
}
</script>

<template>
  <SheetModal :open="open" :title="`${provider?.name ?? ''} · 模型目录`" initial-snap="large" @close="emit('close')">
    <div class="cat">
      <ModelListToolbar
        :query="query"
        :count="rows.length"
        :total="provider?.models.length ?? 0"
        :folder="providers.prefs.providerNameFolder"
        :display="providers.prefs.providerNameDisplay"
        placeholder="搜索模型 ID"
        @update:query="query = $event"
        @update:folder="providers.savePrefs({ providerNameFolder: $event })"
        @update:display="providers.savePrefs({ providerNameDisplay: $event })"
      />

      <!-- 类别筛选 -->
      <div class="row kinds">
        <button
          type="button"
          class="kchip"
          :class="{ on: kindFilter === 'all' }"
          @click="kindFilter = 'all'"
        >
          全部
        </button>
        <button
          v-for="k in kinds"
          :key="k"
          type="button"
          class="kchip"
          :class="{ on: kindFilter === k }"
          @click="kindFilter = k"
        >
          {{ KIND_LABEL[k] }}
        </button>
      </div>

      <div class="list" data-rubber-self>
        <p v-if="rows.length === 0" class="none t-3">
          没有匹配的模型：先「获取模型列表」，或在下面手填一个模型 ID
        </p>
        <ul v-else>
          <li v-for="r in rows" :key="r.ref" class="row center item">
            <button
              type="button"
              class="flex-1 min0 main"
              :disabled="busyRef === r.ref"
              @click="activate(r)"
            >
              <b>{{ r.label }}</b>
              <small>{{ r.sub }}</small>
            </button>
            <span v-if="r.badge" class="on-chip">
              <Check :size="12" />
              {{ r.badge }}
            </span>
            <button v-else type="button" class="use" :disabled="busyRef === r.ref" @click="activate(r)">
              {{ busyRef === r.ref ? '启用中…' : '启用' }}
            </button>
            <button v-if="isManual(r)" type="button" class="rm" aria-label="从目录移除" @click="removeRow(r)">
              <Trash2 :size="14" />
            </button>
          </li>
        </ul>
      </div>

      <!-- 手填模型：接口清单里没有、或该服务商没有 /models 接口 -->
      <section class="manual">
        <p class="l">手填模型 ID</p>
        <div class="row gap">
          <input
            v-model="manualId"
            class="mid"
            type="text"
            placeholder="如 doubao-seed-1.6"
            autocapitalize="off"
            spellcheck="false"
            @keyup.enter="addManual"
          >
          <select v-model="manualKind" class="mkind" aria-label="模型类别">
            <option v-for="k in kinds" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
          </select>
          <button type="button" class="add" :disabled="!manualId.trim() || adding" @click="addManual">
            <Plus :size="14" />
          </button>
        </div>
        <p class="hint t-3">手填的条目不会被同步清掉；类别决定「启用」写到哪个执行位。</p>
      </section>
    </div>
  </SheetModal>
</template>

<style scoped>
.cat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 10px;
}

.kinds {
  gap: 6px;
  flex-wrap: wrap;
}

.kchip {
  padding: 5px 11px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 700;
}

.kchip.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.list {
  max-height: 46dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.none {
  text-align: center;
  padding: 24px 0;
  font-size: var(--fs-footnote);
}

.item {
  gap: 8px;
  padding: 10px 2px;
}

.item + .item {
  border-top: 0.5px solid var(--line);
}

.main {
  text-align: left;
}

.main b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 700;
  word-break: break-all;
}

.main small {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: var(--fs-micro);
  line-height: 1.45;
}

.use {
  flex: none;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: var(--fs-micro);
  font-weight: 800;
}

.use:disabled {
  opacity: 0.5;
}

.on-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 5px 9px;
  border-radius: var(--radius-full);
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-micro);
  font-weight: 800;
}

.rm {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.manual {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 13px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.mid {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-footnote);
}

.mkind {
  flex: none;
  padding: 10px 8px;
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: var(--fs-caption);
  color: var(--text);
}

.add {
  flex: none;
  width: 40px;
  border-radius: var(--radius-s);
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.add:disabled {
  opacity: 0.4;
}

.hint {
  font-size: var(--fs-caption);
  line-height: 1.5;
}
</style>
