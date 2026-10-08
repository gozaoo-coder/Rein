<script setup lang="ts">
/**
 * Rein 在线服务（状态抽屉）：地址 + 密钥 + 可用模型 + 调用条件 + 使用说明 + 双端对账。
 *
 * 从「卡片点进来」改成整层抽屉的原因：这里是**查看状态**的地方（服务地址、密钥、
 * 全部可用模型、账号调用条件、成本对账），内容比一行摘要多得多；摊在模型页里
 * 会把下面的提供商列表推得很远，而且每次同步都要重排一次。
 *
 * 三条原则照旧：
 * 1. 模型由服务端指定：只列服务端回的模型，导入的模型 ID 不受用户手填；
 * 2. 必须有密钥：没填密钥时按钮禁用，401/403 的服务端中文错误原样透出；
 * 3. 成本双端各算一份：本机账本（离线可看）+ 服务端账本（权威，可刷新对账）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { AlertCircle, Check, CloudDownload, RefreshCw, Server } from 'lucide-vue-next'

import ModelListToolbar from '@/components/ai/ModelListToolbar.vue'
import SecretInput from '@/components/ai/fields/SecretInput.vue'
import UrlInput from '@/components/ai/fields/UrlInput.vue'
import SheetModal from '@/components/common/SheetModal.vue'
import { formatCnyNano } from '@/ai/cost'
import { groupByProvider, modelDisplayName } from '@/ai/providerCatalog'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { useOnlineServiceStore } from '@/stores/onlineService'
import { useProvidersStore } from '@/stores/providers'
import type { OnlineModel } from '@/types'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: []; synced: [] }>()

const online = useOnlineServiceStore()
const models = useModelsStore()
const providers = useProvidersStore()
const toast = useToast()

const baseUrl = ref('')
const apiKey = ref('')
const query = ref('')
const syncing = ref(false)

const statusTone = computed(() => {
  if (online.ready) return 'ok'
  if (!online.hasKey) return 'idle'
  return 'warn'
})

const pickedCount = computed(() => online.picked.length)

/** 搜索过滤后的目录（保持服务端顺序） */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return online.models
  return online.models.filter((m) =>
    `${m.id} ${m.providerName} ${m.providerId}`.toLowerCase().includes(q),
  )
})

/** 按提供商分组（沿用列表渲染声明：前缀 / 折叠） */
const groups = computed(() =>
  groupByProvider(
    filtered.value,
    (m: OnlineModel) => m.providerName || m.providerId || '服务端',
    providers.prefs.providerNameFolder,
  ),
)

function labelOf(m: OnlineModel): string {
  const provider = m.providerName || m.providerId || ''
  return modelDisplayName(m.id, provider, providers.prefs.providerNameDisplay)
}

function priceText(m: OnlineModel): string {
  if (!m.priced) return '未定价 · 只计流量'
  return `入 ¥${m.priceIn} / 出 ¥${m.priceOut} 每百万 tokens`
}

const serverCostNano = computed(() => Math.round((online.usage?.costTotal ?? 0) * 1e9))

onMounted(async () => {
  await online.load()
  baseUrl.value = online.settings.baseUrl
  apiKey.value = online.settings.apiKey
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    query.value = ''
    await online.load()
    baseUrl.value = online.settings.baseUrl
    apiKey.value = online.settings.apiKey
    // 打开即静默连一次：抽屉第一眼就该显示「能用哪些模型 + 调用条件」
    if (online.hasKey && !online.catalog) await connect(true)
  },
)

/** 连接：保存设置 → 拉目录（失败原因由服务端给，逐字展示） */
async function connect(silent = false): Promise<void> {
  if (!apiKey.value.trim()) {
    toast.toast('先填服务端签发的密钥（rein_sk_…）')
    return
  }
  await online.saveSettings({ baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() })
  const result = await online.refresh()
  if (result?.ok) {
    void online.refreshUsage()
    if (!silent) toast.toast(`服务端可用模型 ${result.models.length} 个`)
  } else if (result) {
    toast.toast(result.error ?? '连接失败')
  }
}

/** 断开：清掉本机保存的密钥（已导入的模型还在，但下次同步/调用会因无密钥失败） */
async function disconnect(): Promise<void> {
  await online.disconnect()
  apiKey.value = ''
  toast.toast('已断开在线服务（服务密钥已清空）')
}

/** 导入选中模型（服务端撤下的同源模型会被清掉，手动添加的不受影响） */
async function importPicked(): Promise<void> {
  syncing.value = true
  try {
    const result = await online.sync()
    if (!result) {
      toast.toast(online.error ?? '导入失败')
      return
    }
    await models.load(true)
    await models.loadUsage()
    emit('synced')
    const parts = [`新增 ${result.added}`, `更新 ${result.updated}`]
    if (result.removed > 0) parts.push(`清理 ${result.removed}`)
    toast.toast(`已同步：${parts.join(' · ')}`)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <SheetModal :open="open" title="Rein 在线服务" initial-snap="large" @close="emit('close')">
    <div class="onl">
      <!-- 状态 + 调用条件：这一句是「还能不能用」的答案 -->
      <section class="card head-card">
        <div class="row between center">
          <span class="row center gap">
            <span class="ic"><Server :size="14" /></span>
            <b>接口状态</b>
          </span>
          <i class="chip" :class="`chip-${statusTone}`">{{ online.statusText }}</i>
        </div>
        <p class="acct">{{ online.accountText }}</p>
        <p v-if="online.error" class="err">
          <AlertCircle :size="13" />
          {{ online.error }}
        </p>
      </section>

      <!-- 地址 + 密钥 -->
      <section class="card">
        <p class="l">服务地址</p>
        <UrlInput
          id="osc-base"
          v-model="baseUrl"
          placeholder="http://47.100.36.179:8787"
          hint="服务端网关地址；末尾斜杠会自动去掉"
        />
        <p class="l">服务密钥</p>
        <SecretInput
          id="osc-key"
          v-model="apiKey"
          :saved-tail="online.settings.apiKey ? online.settings.apiKey.slice(-4) : null"
          placeholder="rein_sk_…"
          hint="密钥由服务端签发（POST /admin/api/ai/clients），决定这个客户端能用哪些模型；只存在本机"
          aria-label="Rein 在线服务密钥"
        />
        <div class="row gap acts">
          <button type="button" class="btn primary" :disabled="online.loading || !apiKey.trim()" @click="connect()">
            <RefreshCw :size="14" :class="{ spin: online.loading }" />
            {{ online.loading ? '获取中…' : '获取模型列表' }}
          </button>
          <button v-if="online.hasKey" type="button" class="btn" @click="disconnect">断开</button>
        </div>
      </section>

      <!-- 可用模型（服务端下发） -->
      <section v-if="online.models.length > 0" class="card">
        <div class="row between center">
          <p class="l">可用模型（{{ online.models.length }}）</p>
          <button
            type="button"
            class="mini"
            @click="online.pickAll(pickedCount !== online.models.length)"
          >
            {{ pickedCount === online.models.length ? '全不选' : '全选' }}
          </button>
        </div>
        <ModelListToolbar
          :query="query"
          :count="filtered.length"
          :total="online.models.length"
          :folder="providers.prefs.providerNameFolder"
          :display="providers.prefs.providerNameDisplay"
          placeholder="搜索模型 ID 或提供商"
          @update:query="query = $event"
          @update:folder="providers.savePrefs({ providerNameFolder: $event })"
          @update:display="providers.savePrefs({ providerNameDisplay: $event })"
        />
        <div class="list" data-rubber-self>
          <section v-for="g in groups" :key="g.provider || '_'" class="grp">
            <p v-if="providers.prefs.providerNameFolder" class="grp-head t-2">{{ g.provider }}</p>
            <ul>
              <li v-for="m in g.items" :key="m.id">
                <button
                  type="button"
                  class="row center m"
                  :class="{ on: online.picked.includes(m.id) }"
                  @click="online.toggle(m.id)"
                >
                  <span class="tick" :class="{ on: online.picked.includes(m.id) }">
                    <Check :size="11" />
                  </span>
                  <span class="flex-1 min0 mt">
                    <b>{{ labelOf(m) }}</b>
                    <em>{{ priceText(m) }}</em>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </div>
        <button type="button" class="btn primary" :disabled="syncing || pickedCount === 0" @click="importPicked">
          <CloudDownload :size="14" />
          {{ syncing ? '同步中…' : `导入所选（${pickedCount}）` }}
        </button>
        <p class="hint t-3">
          导入后这些模型出现在「全部模型」里（标记「在线」）。服务端撤下的模型会在下次同步时清掉，自己填 key 的模型不受影响。
        </p>
      </section>

      <!-- 成本：两端各算一份 -->
      <section class="card cost">
        <div class="row between center">
          <p class="l">成本对账</p>
          <button type="button" class="mini" :disabled="!online.hasKey" @click="online.refreshUsage()">
            刷新服务端
          </button>
        </div>
        <div class="crow">
          <span>本机累计（估算）</span>
          <b>{{ formatCnyNano(models.totalCostNano) }}</b>
        </div>
        <div class="csub">
          <span>模型费 {{ formatCnyNano(models.totalModelNano) }} · 流量费 {{ formatCnyNano(models.totalTrafficNano) }}</span>
          <span>{{ models.usage?.total.calls ?? 0 }} 次调用 · 近 {{ models.usage?.days ?? 30 }} 天</span>
        </div>
        <div class="crow">
          <span>服务端累计（权威）</span>
          <b>{{ online.usage?.ok ? formatCnyNano(serverCostNano) : '—' }}</b>
        </div>
        <div class="csub">
          <span v-if="online.usage?.ok">
            模型费 ¥{{ online.usage.costTokens.toFixed(4) }} · 流量费 ¥{{ online.usage.costTraffic.toFixed(4) }}
            · 出方向 {{ ((online.usage.bytesOut ?? 0) / 1024 / 1024).toFixed(2) }} MB
          </span>
          <span v-else>{{ online.hasKey ? '点「刷新服务端」拉取' : '未配置密钥' }}</span>
        </div>
      </section>

      <!-- 使用说明 -->
      <section class="card use">
        <p class="l">使用说明</p>
        <ol class="steps">
          <li>服务端签发的密钥（<code>rein_sk_…</code>）决定你能用哪些模型；密钥只存在本机，请求带它才拿得到清单。</li>
          <li>模型清单、单价与流量价全部由服务端下发，本机不猜也不让手填模型 ID。</li>
          <li>导入后直接用：把其中一条设为主模型（模型页「服务模型」卡）即可开始对话/识别。</li>
          <li>计价 = 官方页价（服务端不溢价）+ 服务器流量 {{ online.catalog?.trafficPerGb ?? 0.8 }} 元/GB（{{ online.catalog?.trafficScope === 'both' ? '双向' : online.catalog?.trafficScope === 'ingress' ? '入方向' : '出方向' }}）；本机按同一公式估算，服务端的账为准。</li>
        </ol>
      </section>
    </div>
  </SheetModal>
</template>

<style scoped>
.onl {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
}

.card {
  padding: 13px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.head-card {
  gap: 7px;
}

.ic {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-s);
  flex: none;
  background: linear-gradient(135deg, #2f6bff, #5ac8fa);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.head-card b {
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.chip {
  font-style: normal;
  font-size: var(--fs-micro);
  font-weight: 800;
  border-radius: var(--radius-full);
  padding: 3px 9px;
}

.chip-ok {
  background: var(--ok-soft);
  color: var(--ok-strong);
}

.chip-idle {
  background: var(--surface-2);
  color: var(--text-3);
}

.chip-warn {
  background: color-mix(in srgb, var(--danger, #ff5257) 14%, transparent);
  color: var(--danger, #ff5257);
}

.acct {
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-2);
}

.l {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
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

.acts {
  gap: 8px;
  margin-top: 2px;
}

.btn {
  flex: 1;
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

.acts .btn + .btn {
  flex: none;
  padding-left: 18px;
  padding-right: 18px;
  color: var(--text-2);
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.btn:disabled {
  opacity: 0.4;
}

.mini {
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--accent);
}

.list {
  max-height: 42dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.grp + .grp {
  margin-top: 8px;
}

.grp-head {
  padding: 4px 2px;
  font-size: var(--fs-caption);
  font-weight: 700;
}

.m {
  gap: 9px;
  width: 100%;
  padding: 9px 2px;
  text-align: left;
}

.m + .m {
  border-top: 0.5px solid var(--line);
}

.m.on {
  color: var(--accent);
}

.tick {
  width: 17px;
  height: 17px;
  flex: none;
  border-radius: var(--radius-xs);
  border: 1.5px solid var(--text-3);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tick.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.mt b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 700;
  word-break: break-all;
}

.mt em {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
}

.cost {
  background: var(--surface-2);
  gap: 4px;
}

.crow {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--fs-footnote);
  color: var(--text-2);
}

.crow b {
  font-size: var(--fs-subhead);
  color: var(--text);
}

.csub {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  margin-bottom: 4px;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-left: 18px;
  list-style: decimal;
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: var(--text-2);
}

.steps code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-micro);
  background: var(--surface-2);
  border-radius: var(--radius-xs);
  padding: 1px 4px;
}

.hint {
  font-size: var(--fs-caption);
  line-height: 1.5;
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
