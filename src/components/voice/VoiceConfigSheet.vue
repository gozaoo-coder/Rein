<script setup lang="ts">
import { ref, watch } from 'vue'
import { Volume2 } from 'lucide-vue-next'

import SheetModal from '@/components/common/SheetModal.vue'
import { voiceService } from '@/services/voiceService'
import { useToast } from '@/composables/useToast'
import type { AsrAdapter, TtsCredential, VoiceConfig } from '@/types'

/** 语音服务配置表单（模型页语音服务卡 → 编辑）。
 *
 * ASR 适配器双层选择机制：
 * - 第一层（用户未手选 = 「自动」）：检测 baseURL/模型名关键词 → 程序自动替选适配器并提示；
 *   关键词变化自动换向（qwen 删了填 doubao → 自动改选豆包），清空后回到「自动」。
 * - 第二层（用户已手选豆包/Qwen）：只弹推荐气泡（一键切换/忽略），绝不覆盖用户选择。
 * 凭据：豆包 = 旧版 App ID+Token / 新版 API Key；Qwen = DASHSCOPE_API_KEY（Bearer）。
 *
 * 朗读（豆包 TTS）凭据独立分区：
 * - 默认「跟随识别凭据」（豆包适配器下零配置可用）；
 * - 识别配 Qwen 时豆包 TTS 无法继承凭据 → 提示并要求独立凭据才能朗读；
 * - 「独立凭据」开启后填写豆包凭据，保存进 ttsCredential（识别配置不受影响）。
 * 连通性测试：识别（WS 建连即结束）与朗读（试听任意音色）分开验证。 */
const props = defineProps<{ open: boolean; config: VoiceConfig | null }>()
const emit = defineEmits<{ close: []; saved: [config: VoiceConfig] }>()

const toast = useToast()

const ADAPTER_META = {
  doubao: {
    label: '豆包',
    defaultUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async',
    defaultModel: 'volc.seedasr.sauc.duration',
  },
  qwen: {
    label: 'Qwen',
    defaultUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    defaultModel: 'qwen-audio-3.0-asr-flash-streaming',
  },
} as const

/** 关键词 → 适配器（与 Rust AsrAdapterKind::detect 同一套词表） */
function detectAdapter(url: string, model: string): 'doubao' | 'qwen' | null {
  const s = `${url} ${model}`.toLowerCase()
  if (/(qwen|dashscope|aliyun)/.test(s)) return 'qwen'
  if (/(doubao|volc|openspeech|bytedance|seedasr)/.test(s)) return 'doubao'
  return null
}

const mode = ref<'legacy' | 'new'>('legacy')
const appKey = ref('')
const accessKey = ref('')
const adapter = ref<AsrAdapter>('auto')
const asrBaseUrl = ref('')
const asrResourceId = ref('volc.seedasr.sauc.duration')

/** 朗读独立凭据分区 */
const ttsStandaloneOn = ref(false)
const ttsMode = ref<'legacy' | 'new'>('legacy')
const ttsAppKey = ref('')
const ttsAccessKey = ref('')

const ttsResourceId = ref('seed-tts-2.0')
const voiceName = ref('')
const speed = ref(1)

/** 用户手动点过具体适配器（离开「自动」层） */
const adapterTouched = ref(false)
/** 第一层自动替选的结果（提示条展示；字段清空后撤回回「自动」） */
const autoApplied = ref<'doubao' | 'qwen' | null>(null)
/** 第二层推荐气泡（不强改，可忽略） */
const suggestion = ref<'doubao' | 'qwen' | null>(null)
const suggestionDismissed = ref<'doubao' | 'qwen' | null>(null)

/** 表单生效中的适配器（自动层下 = 关键词识别结果，识别不出回落豆包） */
const effectiveAdapter = ref<'doubao' | 'qwen'>('doubao')

/** 朗读凭据是否不可用（识别配 Qwen 且未开独立凭据 → 豆包 TTS 无法继承） */
const ttsBlocked = ref(false)

/** 双层选择求值：baseURL/模型名变化与手动切换适配器时都要跑一遍 */
function evaluateAdapter(): void {
  const detected = detectAdapter(asrBaseUrl.value, asrResourceId.value)
  effectiveAdapter.value = adapter.value === 'qwen' ? 'qwen' : detected ?? 'doubao'
  ttsBlocked.value = effectiveAdapter.value === 'qwen' && !ttsStandaloneOn.value
  if (!detected) {
    // 关键词消失：自动替选的撤回到「自动」
    if (autoApplied.value && !adapterTouched.value) {
      adapter.value = 'auto'
      autoApplied.value = null
    }
    suggestion.value = null
    return
  }
  if (!adapterTouched.value) {
    // 第一层：程序自动替选，跟随关键词换向
    if (adapter.value !== detected) {
      adapter.value = detected
      autoApplied.value = detected
    }
    suggestion.value = null
  } else if (adapter.value !== detected) {
    // 第二层：用户已手选 → 仅推荐，不覆盖
    if (suggestionDismissed.value !== detected) suggestion.value = detected
  } else {
    suggestion.value = null
    suggestionDismissed.value = null
  }
}

function toggleTtsStandalone(v: boolean): void {
  ttsStandaloneOn.value = v
  evaluateAdapter()
}

watch([asrBaseUrl, asrResourceId], () => evaluateAdapter())

function pickAdapter(a: AsrAdapter): void {
  adapter.value = a
  autoApplied.value = null
  suggestion.value = null
  suggestionDismissed.value = null
  adapterTouched.value = a !== 'auto'
  evaluateAdapter() // 手动切到与关键词冲突的适配器 → 立即给出推荐气泡
}

function applySuggestion(): void {
  if (!suggestion.value) return
  adapter.value = suggestion.value
  suggestion.value = null
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    const c = props.config
    mode.value = c?.mode ?? 'legacy'
    appKey.value = c?.appKey ?? ''
    accessKey.value = c?.accessKey ?? ''
    adapter.value = c?.asrAdapter ?? 'auto'
    adapterTouched.value = c?.asrAdapterUserPicked === true
    asrBaseUrl.value = c?.asrBaseUrl ?? ''
    const tc = c?.ttsCredential
    ttsStandaloneOn.value = !!tc?.appKey
    ttsMode.value = tc?.mode ?? 'legacy'
    ttsAppKey.value = tc?.appKey ?? ''
    ttsAccessKey.value = tc?.accessKey ?? ''
    asrResourceId.value = c?.asrResourceId || 'volc.seedasr.sauc.duration'
    ttsResourceId.value = c?.ttsResourceId || 'seed-tts-2.0'
    voiceName.value = c?.voiceName ?? ''
    speed.value = c?.speed ?? 1
    autoApplied.value = null
    suggestion.value = null
    suggestionDismissed.value = null
    evaluateAdapter()
  },
)

const saving = ref(false)

/** 组装朗读独立凭据：未开启或 Key 空 = null（继承识别凭据） */
function buildTtsCredential(): TtsCredential | null {
  if (!ttsStandaloneOn.value || !ttsAppKey.value.trim()) return null
  return {
    mode: ttsMode.value,
    appKey: ttsAppKey.value.trim(),
    accessKey: ttsAccessKey.value.trim(),
  }
}

async function onSave(): Promise<void> {
  if (!appKey.value.trim() || (effectiveAdapter.value === 'doubao' && mode.value === 'legacy' && !accessKey.value.trim())) {
    toast.toast('请填写完整的识别凭据')
    return
  }
  const ttsCred = buildTtsCredential()
  if (ttsCred && ttsCred.mode === 'legacy' && !ttsCred.accessKey) {
    toast.toast('请填写朗读独立凭据的 Access Token')
    return
  }
  saving.value = true
  const config: VoiceConfig = {
    mode: mode.value,
    appKey: appKey.value.trim(),
    accessKey: accessKey.value.trim(),
    asrAdapter: adapter.value,
    asrAdapterUserPicked: adapterTouched.value,
    asrBaseUrl: asrBaseUrl.value.trim(),
    ttsCredential: ttsCred,
    asrResourceId: asrResourceId.value.trim() || ADAPTER_META[effectiveAdapter.value].defaultModel,
    ttsResourceId: ttsResourceId.value.trim() || 'seed-tts-2.0',
    voiceName: voiceName.value.trim(),
    speed: Math.min(3, Math.max(0.2, speed.value || 1)),
  }
  try {
    await voiceService.configSave(config)
    toast.toast('语音服务配置已保存')
    emit('saved', config)
    emit('close')
  } catch (e) {
    toast.toast(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}

/** 识别连通性测试：先保存当前表单，再用配置建一次识别连接立即结束 */
const probing = ref(false)

async function onAsrProbe(): Promise<void> {
  if (probing.value) return
  probing.value = true
  try {
    await onSave()
    await voiceService.asrProbe()
    toast.toast('识别服务连通正常 ✓')
  } catch (e) {
    toast.toast(`识别连通失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    probing.value = false
  }
}

/** 试听音色：先保存当前表单（探测读取已存配置），再用表单里的音色合成短句播放 */
const trying = ref(false)

async function onTry(): Promise<void> {
  if (trying.value) return
  trying.value = true
  try {
    await onSave()
    const { audioUrl } = await voiceService.ttsProbe(voiceName.value.trim() || undefined)
    if (!audioUrl) throw new Error('未获得音频')
    const a = new Audio(audioUrl)
    await a.play()
    toast.toast('试听已播放')
  } catch (e) {
    toast.toast(`试听失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    trying.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="语音服务（识别与朗读）" initial-snap="large" @close="emit('close')">
    <div class="form">
      <label class="f-label">识别适配器</label>
      <div class="mode-seg">
        <button :class="{ on: adapter === 'auto' }" @click="pickAdapter('auto')">自动识别</button>
        <button :class="{ on: adapter === 'doubao' }" @click="pickAdapter('doubao')">豆包</button>
        <button :class="{ on: adapter === 'qwen' }" @click="pickAdapter('qwen')">Qwen</button>
      </div>
      <!-- 第一层：自动替选提示 -->
      <p v-if="autoApplied" class="auto-notice">
        检测到{{ ADAPTER_META[autoApplied].label }}关键词，已自动选择{{ ADAPTER_META[autoApplied].label }}适配器（跟随输入变化）
      </p>
      <!-- 第二层：推荐气泡（用户已手选，不强改） -->
      <div v-if="suggestion" class="suggestion">
        <span>检测到{{ ADAPTER_META[suggestion].label }}关键词，建议切换适配器</span>
        <button class="sgo" @click="applySuggestion">切换到{{ ADAPTER_META[suggestion].label }}</button>
        <button class="sgx" @click="suggestionDismissed = suggestion; suggestion = null">忽略</button>
      </div>

      <label class="f-label">ASR WebSocket baseURL（留空 = 默认端点）</label>
      <input
        v-model="asrBaseUrl"
        type="text"
        class="mono"
        :placeholder="ADAPTER_META[effectiveAdapter].defaultUrl"
      >

      <template v-if="effectiveAdapter === 'doubao'">
        <label class="f-label">凭据模式</label>
        <div class="mode-seg">
          <button :class="{ on: mode === 'legacy' }" @click="mode = 'legacy'">旧版 · App ID + Token</button>
          <button :class="{ on: mode === 'new' }" @click="mode = 'new'">新版 · API Key</button>
        </div>

        <label class="f-label">{{ mode === 'new' ? 'API Key（X-Api-Key）' : 'App ID（X-Api-App-Key）' }}</label>
        <input v-model="appKey" type="text" autocomplete="off" placeholder="控制台获取">

        <template v-if="mode === 'legacy'">
          <label class="f-label">Access Token（X-Api-Access-Key）</label>
          <input v-model="accessKey" type="password" autocomplete="new-password" placeholder="控制台获取">
        </template>

        <label class="f-label">识别 ASR · Resource-Id</label>
        <input v-model="asrResourceId" type="text" class="mono" placeholder="volc.seedasr.sauc.duration">
      </template>

      <template v-else>
        <label class="f-label">API Key（DASHSCOPE_API_KEY）</label>
        <input v-model="appKey" type="password" autocomplete="new-password" placeholder="阿里云百炼 API Key">
        <label class="f-label">识别 ASR · 模型名</label>
        <input v-model="asrResourceId" type="text" class="mono" placeholder="qwen-audio-3.0-asr-flash-streaming">
      </template>

      <div class="acts">
        <button class="try" :disabled="probing || saving" @click="onAsrProbe">
          {{ probing ? '测试中…' : '测试识别连通' }}
        </button>
      </div>

      <div class="divider" />

      <label class="f-label">朗读合成（豆包 TTS）· 凭据</label>
      <div class="mode-seg">
        <button :class="{ on: !ttsStandaloneOn }" @click="toggleTtsStandalone(false)">跟随识别凭据</button>
        <button :class="{ on: ttsStandaloneOn }" @click="toggleTtsStandalone(true)">独立凭据</button>
      </div>
      <p v-if="ttsBlocked" class="warn-notice">
        识别适配器是 Qwen，朗读凭据无法继承（豆包 TTS 只认豆包凭据）——请切换到「独立凭据」填入豆包 Key，否则纪要朗读不可用。
      </p>

      <template v-if="ttsStandaloneOn">
        <label class="f-label">朗读凭据模式</label>
        <div class="mode-seg">
          <button :class="{ on: ttsMode === 'legacy' }" @click="ttsMode = 'legacy'">旧版 · App ID + Token</button>
          <button :class="{ on: ttsMode === 'new' }" @click="ttsMode = 'new'">新版 · API Key</button>
        </div>

        <label class="f-label">{{ ttsMode === 'new' ? 'API Key（X-Api-Key）' : 'App ID（X-Api-App-Key）' }}</label>
        <input v-model="ttsAppKey" type="text" autocomplete="off" placeholder="控制台获取">

        <template v-if="ttsMode === 'legacy'">
          <label class="f-label">Access Token（X-Api-Access-Key）</label>
          <input v-model="ttsAccessKey" type="password" autocomplete="new-password" placeholder="控制台获取">
        </template>
      </template>

      <label class="f-label">合成 TTS · Resource-Id（纪要朗读）</label>
      <input v-model="ttsResourceId" type="text" class="mono" placeholder="seed-tts-2.0">
      <label class="f-label">朗读音色（voice_type · 2.0 音色 ID）</label>
      <input v-model="voiceName" type="text" class="mono" placeholder="如 zh_female_cancan_uranus_bigtts">
      <label class="f-label">语速（0.2 ~ 3.0）</label>
      <input v-model.number="speed" type="number" step="0.1" min="0.2" max="3">

      <div class="acts">
        <button class="try" :disabled="trying || saving" @click="onTry">
          <Volume2 :size="14" /> {{ trying ? '合成中…' : '试听音色' }}
        </button>
        <button class="save" :disabled="saving" @click="onSave">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </SheetModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
}

.hint,
.auto-notice {
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.auto-notice {
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 6px 10px;
  margin-top: 6px;
}

.warn-notice {
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--c-warn, #b45309);
  background: rgba(245, 158, 11, 0.12);
  border-radius: 8px;
  padding: 6px 10px;
  margin-top: 6px;
}

.divider {
  height: 1px;
  background: var(--surface-3, var(--surface-2));
  margin: 14px 0 4px;
}

/* 第二层推荐气泡：只提示不强改 */
.suggestion {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--ok-soft);
  color: var(--ok-strong);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.suggestion .sgo {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--ok);
  color: #fff;
  font-size: var(--fs-caption);
  font-weight: 700;
}

.suggestion .sgx {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.f-label {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--text-2);
  margin-top: 8px;
}

.form input {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  font-size: var(--fs-subhead);
}

.form input.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--fs-caption);
}

.mode-seg {
  display: flex;
  background: var(--surface-2);
  border-radius: 9px;
  padding: 2px;
}

.mode-seg button {
  flex: 1;
  height: 30px;
  border-radius: 7px;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.mode-seg button.on {
  background: var(--surface);
  color: var(--text-1);
  font-weight: 700;
  box-shadow: var(--shadow-thumb);
}

.acts {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.acts button {
  flex: 1;
  height: 42px;
  border-radius: var(--radius-full);
  font-size: var(--fs-subhead);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.try {
  background: var(--accent-soft);
  color: var(--accent);
}

.save {
  background: var(--accent);
  color: var(--on-accent);
}

.acts button:disabled {
  opacity: 0.5;
}
</style>
