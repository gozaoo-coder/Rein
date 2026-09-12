<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import SheetModal from '@/components/common/SheetModal.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { DEFAULT_IMAGE_EDGE } from '@/utils/image'
import type { AiModel } from '@/types'

/** 添加/编辑 AI 模型：名称、接入方式（预设 baseUrl）、API Key、模型 ID。 */
const props = defineProps<{
  open: boolean
  /** 传入 = 编辑；null = 新增 */
  model: AiModel | null
}>()

const emit = defineEmits<{
  close: []
  saved: [id: number]
}>()

const store = useModelsStore()
const toast = useToast()

/** provider 预设：切换时自动填 baseUrl（用户手动改过则保留） */
const PROVIDER_PRESETS: Record<string, { label: string; baseUrl: string; models: string[] }> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  'openai-compatible': {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gemini-2.5-flash'],
  },
}

const name = ref('')
const provider = ref('deepseek')
const baseUrl = ref('')
const apiKey = ref('')
const modelId = ref('')
const isDefault = ref(false)
/** 发给该模型的图片最长边（像素）：越大看得越清，也越耗流量与上下文 */
const imageMaxEdge = ref<number>(DEFAULT_IMAGE_EDGE)
/** 发送分辨率档位：覆盖常见视觉模型的输入上限 */
const IMAGE_EDGE_OPTIONS = [
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048' },
  { value: '3072', label: '3072' },
  { value: '4096', label: '4096' },
]
const urlTouched = ref(false)

const editing = computed(() => props.model)
const providerLabel = computed(() => PROVIDER_PRESETS[provider.value]?.label ?? provider.value)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.model) {
      name.value = props.model.name
      provider.value = props.model.provider
      baseUrl.value = props.model.baseUrl
      apiKey.value = props.model.apiKey
      modelId.value = props.model.modelId
      isDefault.value = props.model.isDefault
      imageMaxEdge.value = props.model.imageMaxEdge ?? DEFAULT_IMAGE_EDGE
      urlTouched.value = true
    } else {
      const p = PROVIDER_PRESETS.deepseek
      name.value = ''
      provider.value = 'deepseek'
      baseUrl.value = p.baseUrl
      apiKey.value = ''
      modelId.value = p.models[0]!
      isDefault.value = store.models.length === 0
      urlTouched.value = false
    }
  },
)

function onProviderChange(v: string): void {
  provider.value = v
  const preset = PROVIDER_PRESETS[v]
  if (!preset) return
  if (!urlTouched.value || !props.model) baseUrl.value = preset.baseUrl
  if (!modelId.value || !props.model) modelId.value = preset.models[0]!
}

const canSave = computed(
  () =>
    name.value.trim() !== '' &&
    baseUrl.value.trim() !== '' &&
    apiKey.value.trim() !== '' &&
    modelId.value.trim() !== '' &&
    !saving.value,
)
const saving = ref(false)
const title = computed(() => (editing.value ? '编辑模型' : '添加模型'))

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const input = {
      name: name.value.trim(),
      provider: provider.value,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      modelId: modelId.value.trim(),
      isDefault: isDefault.value,
      imageMaxEdge: imageMaxEdge.value,
    }
    if (editing.value) {
      await store.update(editing.value.id, input)
      toast.toast('已保存，重新测试能力')
      emit('saved', editing.value.id)
    } else {
      const created = await store.add(input)
      toast.toast('已添加，正在测试能力')
      emit('saved', created.id)
    }
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" :title="title" @close="emit('close')">
    <div class="form">
      <label class="row center label" for="ai-name">
        <span class="l">名称</span>
        <input id="ai-name" v-model="name" type="text" placeholder="例如：DeepSeek 视觉" />
      </label>

      <div class="field">
        <p class="l">接入方式</p>
        <SegmentedControl
          class="provider"
          :model-value="provider"
          :options="Object.entries(PROVIDER_PRESETS).map(([k, v]) => ({ value: k, label: v.label }))"
          @update:model-value="onProviderChange($event as string)"
        />
      </div>

      <label class="row center label" for="ai-base">
        <span class="l">接口地址</span>
        <input
          id="ai-base"
          v-model="baseUrl"
          type="text"
          inputmode="url"
          placeholder="https://api.deepseek.com"
          @input="urlTouched = true"
        />
      </label>

      <label class="row center label" for="ai-key">
        <span class="l">API Key</span>
        <input id="ai-key" v-model="apiKey" type="password" autocomplete="off" placeholder="sk-…" />
      </label>

      <label class="row center label" for="ai-model">
        <span class="l">模型 ID</span>
        <input id="ai-model" v-model="modelId" type="text" list="ai-model-suggestions" placeholder="deepseek-v4-flash-vision-exp" />
        <datalist id="ai-model-suggestions">
          <option v-for="m in PROVIDER_PRESETS[provider]?.models ?? []" :key="m" :value="m" />
        </datalist>
      </label>

      <div class="field">
        <p class="l">图片发送分辨率</p>
        <SegmentedControl
          class="provider"
          :model-value="String(imageMaxEdge)"
          :options="IMAGE_EDGE_OPTIONS"
          @update:model-value="imageMaxEdge = Number($event)"
        />
        <p class="edge-hint t-3">发给该模型的图片最长边（像素）。默认 2048 覆盖多数视觉模型；调大看得更清，也更耗流量与上下文。</p>
      </div>

      <div class="row between center">
        <p class="l">设为默认</p>
        <button
          class="toggle"
          :class="{ on: isDefault }"
          role="switch"
          :aria-checked="isDefault"
          aria-label="设为默认"
          @click="isDefault = !isDefault"
        >
          <i />
        </button>
      </div>

      <button type="button" class="save" :disabled="!canSave" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <small class="hint t-3">
        {{ providerLabel }} 兼容 OpenAI 接口；保存后发送 max_tokens=1 的测试包探测「视觉 / 思考 / 努力」能力。
      </small>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 14px;
}

.l {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.label {
  gap: 12px;
  background: var(--surface-2);
  border-radius: var(--radius-m);
  padding: 4px 14px;
}

.label .l {
  width: 84px;
  flex: none;
}

.label input {
  flex: 1;
  min-width: 0;
  padding: 11px 0;
  font-size: var(--fs-subhead);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider :deep(button) {
  flex: 1;
  justify-content: center;
}

.edge-hint {
  font-size: var(--fs-caption);
  line-height: 1.5;
}

/* 默认开关（iOS 风格） */
.toggle {
  width: 52px;
  height: 31px;
  flex: none;
  border-radius: var(--radius-full);
  background: var(--text-3);
  position: relative;
  transition: background var(--dur-fast) var(--ease-standard);
}

.toggle i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  transition: transform var(--dur-fast) var(--ease-spring);
}

.toggle.on {
  background: var(--ok);
}

.toggle.on i {
  transform: translateX(21px);
}

.save {
  padding: 14px 0;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--fs-headline);
  font-weight: 700;
}

.save:disabled {
  opacity: 0.35;
}

.hint {
  text-align: center;
  line-height: 1.5;
}
</style>
