<script setup lang="ts">
/**
 * Rein 在线服务卡（管理模型页）：地址 + 服务密钥 → 拉服务端下发的模型清单 → 导入成可用模型。
 *
 * 三条原则直接体现在界面上：
 * 1. 模型由服务端指定：这里只列服务端回的模型，导入的模型 ID 不受用户手填；
 * 2. 必须有密钥：没填密钥时按钮直接禁用，401/403 由服务端的中文错误原样透出；
 * 3. 成本双端各算一份：本机账本（离线可看）+ 服务端账本（权威，可刷新对账）。
 */
import { computed, onMounted, ref } from 'vue'
import {
  AlertCircle,
  Check,
  CloudDownload,
  KeyRound,
  RefreshCw,
  Server,
} from 'lucide-vue-next'

import { formatCnyNano } from '@/ai/cost'
import { useToast } from '@/composables/useToast'
import { useModelsStore } from '@/stores/models'
import { useOnlineServiceStore } from '@/stores/onlineService'
import type { OnlineModel } from '@/types'

const emit = defineEmits<{ synced: [] }>()

const online = useOnlineServiceStore()
const models = useModelsStore()
const toast = useToast()

const open = ref(false)
const baseUrl = ref('')
const apiKey = ref('')

const statusTone = computed(() => {
  if (online.ready) return 'ok'
  if (!online.hasKey) return 'idle'
  return 'warn'
})

const pickedCount = computed(() => online.picked.length)

onMounted(async () => {
  await online.load()
  baseUrl.value = online.settings.baseUrl
  apiKey.value = online.settings.apiKey
  // 已配好密钥时先静默连一次：卡片第一眼就该显示「能用哪些模型」
  if (online.hasKey && !online.catalog) await connect(true)
})

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
}

function priceText(m: OnlineModel): string {
  if (!m.priced) return '未定价 · 只计流量'
  return `入 ¥${m.priceIn} / 出 ¥${m.priceOut} 每百万 tokens`
}

const serverCostNano = computed(() => Math.round((online.usage?.costTotal ?? 0) * 1e9))
</script>

<template>
  <section class="card osc" :class="{ open }">
    <button class="head" @click="open = !open">
      <span class="ic"><Server :size="15" /></span>
      <span class="t">
        <b>
          Rein 在线服务
          <i class="chip" :class="`chip-${statusTone}`">{{ online.statusText }}</i>
        </b>
        <em>
          模型由服务端下发 · 需服务密钥
          <template v-if="models.usage"> · 本机累计 {{ formatCnyNano(models.totalCostNano) }}</template>
        </em>
      </span>
      <span class="go">{{ open ? '⌃' : '›' }}</span>
    </button>

    <div v-if="open" class="body">
      <label class="row center label" for="osc-base">
        <span class="l">服务地址</span>
        <input id="osc-base" v-model="baseUrl" type="text" inputmode="url" placeholder="http://47.100.36.179:8787" />
      </label>
      <label class="row center label" for="osc-key">
        <span class="l">服务密钥</span>
        <input id="osc-key" v-model="apiKey" type="password" autocomplete="off" placeholder="rein_sk_…" />
      </label>
      <p class="hint t-3">
        <KeyRound :size="12" />
        密钥由服务端签发（<code>POST /admin/api/ai/clients</code>），决定这个客户端能用哪些模型；只存在本机，请求带它才拿得到清单。
      </p>

      <div class="row gap acts">
        <button class="act primary" :disabled="online.loading || !apiKey.trim()" @click="connect()">
          <RefreshCw :size="14" :class="{ spin: online.loading }" />
          {{ online.loading ? '获取中…' : '获取模型列表' }}
        </button>
        <button v-if="online.hasKey" class="act" @click="disconnect">断开</button>
      </div>

      <p v-if="online.error" class="err">
        <AlertCircle :size="13" />
        {{ online.error }}
      </p>

      <template v-if="online.models.length > 0">
        <div class="row between center list-head">
          <span class="l">服务端可用模型（{{ online.models.length }}）</span>
          <button class="mini" @click="online.pickAll(pickedCount !== online.models.length)">
            {{ pickedCount === online.models.length ? '全不选' : '全选' }}
          </button>
        </div>
        <ul class="models">
          <li v-for="m in online.models" :key="m.id">
            <button class="m" :class="{ on: online.picked.includes(m.id) }" @click="online.toggle(m.id)">
              <span class="tick" :class="{ on: online.picked.includes(m.id) }">
                <Check :size="11" />
              </span>
              <span class="mt">
                <b>{{ m.id }}</b>
                <em>{{ m.providerName || m.providerId }} · {{ priceText(m) }}</em>
              </span>
            </button>
          </li>
        </ul>

        <button class="act" :disabled="online.syncing || pickedCount === 0" @click="importPicked">
          <CloudDownload :size="14" />
          {{ online.syncing ? '同步中…' : `导入所选（${pickedCount}）` }}
        </button>
        <p class="hint t-3">
          导入后这些模型直接出现在下方列表里（标记「在线」）。服务端撤下的模型会在下次同步时清掉，自己填 key 的模型不受影响。
        </p>
      </template>

      <!-- 成本：两端各算一份，本机为估算、服务端为权威 -->
      <div class="cost">
        <div class="row between center">
          <span class="l">服务成本</span>
          <button class="mini" :disabled="!online.hasKey" @click="online.refreshUsage()">刷新服务端</button>
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
        <p class="hint t-3">
          计价：模型按官方页价（服务端不溢价）+ 服务器流量
          {{ online.catalog?.trafficPerGb ?? 0.8 }} 元/GB（{{ online.catalog?.trafficScope === 'both' ? '双向' : online.catalog?.trafficScope === 'ingress' ? '入方向' : '出方向' }}）。
          本机按同一公式估算，服务端的账为准。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.osc {
  padding: 0;
  margin-top: 12px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 13px 14px;
  text-align: left;
}

.ic {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  flex: none;
  background: linear-gradient(135deg, #2f6bff, #5ac8fa);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.t {
  flex: 1;
  min-width: 0;
}

.t b {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-subhead);
  font-weight: 700;
}

.t em {
  font-style: normal;
  font-size: var(--fs-caption);
  color: var(--text-3);
  display: block;
  margin-top: 2px;
}

.chip {
  font-style: normal;
  font-size: 9px;
  font-weight: 800;
  border-radius: var(--radius-full);
  padding: 2px 7px;
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

.go {
  flex: none;
  color: var(--text-3);
  font-size: 16px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 14px 14px;
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
  width: 72px;
  flex: none;
}

.label input {
  flex: 1;
  min-width: 0;
  padding: 11px 0;
  font-size: var(--fs-subhead);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: var(--fs-caption);
  line-height: 1.55;
}

.hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: var(--surface-2);
  border-radius: 4px;
  padding: 1px 4px;
}

.act {
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

.acts .act {
  flex: 1;
}

/* 断开是次要动作：不给它抢位置 */
.acts .act + .act {
  flex: none;
  padding-left: 16px;
  padding-right: 16px;
  color: var(--text-2);
}

.act.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.act:disabled {
  opacity: 0.4;
}

.mini {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
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

.list-head {
  margin-top: 2px;
}

.models {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.m {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
  text-align: left;
}

.m.on {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.tick {
  width: 17px;
  height: 17px;
  flex: none;
  border-radius: 6px;
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

.mt {
  min-width: 0;
}

.mt b {
  display: block;
  font-size: var(--fs-footnote);
  font-weight: 700;
  word-break: break-all;
}

.mt em {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
}

.cost {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  padding: 11px 12px;
  border-radius: var(--radius-m);
  background: var(--surface-2);
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
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
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
