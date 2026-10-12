<script setup lang="ts">
/**
 * 设置页「外部访问」分区：对外服务网关的开关 / 绑定模式 / 端口 / 已授权程序列表。
 *
 * 只接管理面里「看一眼、改一下、撤一个」这半张脸（`gateway_status` / `gateway_set_enabled` /
 * `gateway_set_bind` / `gateway_revoke_client`）；授权弹窗与它的单例状态机在另一层
 * （`components/settings/GatewayAuthSheet.vue` + `system/externalAccessRuntime.ts`）。
 *
 * 服务**默认关**：用户开了才监听端口（contract §4.1）—— 界面文案照此写实，不美化。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Ban, Globe, KeyRound, Link2, Power, Server, TriangleAlert, Unplug } from 'lucide-vue-next'

import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { gatewayService } from '@/services/gatewayService'
import {
  GATEWAY_SCOPE_LABELS,
  type GatewayBindMode,
  type GatewayBlocked,
  type GatewayClient,
  type GatewayScope,
  type GatewayStatus,
} from '@/types'

const { toast } = useToast()

const status = ref<GatewayStatus | null>(null)
const busy = ref(false)

const BIND_OPTIONS = [
  { value: 'local', label: '仅本机', testid: 'gateway-bind-local' },
  { value: 'lan', label: '局域网', testid: 'gateway-bind-lan' },
]

const enabled = computed(() => status.value?.enabled ?? false)
const bindMode = computed<GatewayBindMode>(() => status.value?.bindMode ?? 'local')
const port = computed(() => status.value?.port ?? null)
const clients = computed(() => status.value?.clients ?? [])
const blocked = computed(() => status.value?.blocked ?? [])
const pendingCount = computed(() => status.value?.pendingCount ?? 0)
const pairToken = computed(() => status.value?.pairToken ?? null)

/** 复制配对令牌（LAN 模式给外部客户端首帧用）。失败时不吞掉，给用户提示手动抄。 */
async function copyPairToken(): Promise<void> {
  const t = pairToken.value
  if (!t) return
  try {
    await navigator.clipboard.writeText(t)
    toast('已复制配对令牌')
  } catch {
    toast('复制失败，请手动选中复制')
  }
}

/** 卡头右侧的一句话：不开卡片也知道现在是什么状态 */
const stateHint = computed(() => {
  if (pendingCount.value > 0) return `等待授权 ${pendingCount.value} 个`
  if (!enabled.value) return '未开启'
  return clients.value.length > 0 ? `已授权 ${clients.value.length} 个程序` : '监听中 · 还没有程序接入'
})

const portHint = computed(() => {
  if (!enabled.value) return '开启后才会绑定端口，被占用时自动往后顺延'
  return bindMode.value === 'lan' ? '局域网已开放 · 同网段设备可连' : '仅本机可连（127.0.0.1 / ::1）'
})

async function refresh(): Promise<void> {
  try {
    status.value = await gatewayService.status()
  } catch (e) {
    console.warn('[gateway] 读取服务状态失败', e)
  }
}

/** 所有改动都走它：忙碌期拦重复点击；失败回读真实状态，别把没生效的假值留在界面上 */
async function run(action: () => Promise<GatewayStatus>, failText: string): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  try {
    status.value = await action()
    return true
  } catch (e) {
    console.warn('[gateway] 操作失败', e)
    toast(failText)
    await refresh()
    return false
  } finally {
    busy.value = false
  }
}

const toggleChoice = computed({
  get: () => enabled.value,
  set: (on: boolean) => {
    void run(() => gatewayService.setEnabled(on), on ? '开启失败，请稍后重试' : '关闭失败，请稍后重试')
  },
})

const bindChoice = computed({
  get: () => bindMode.value as string,
  set: (v: string) => {
    if (v === bindMode.value) return
    const mode = v as GatewayBindMode
    void run(() => gatewayService.setBind(mode, null), '切换绑定模式失败，请稍后重试')
  },
})

async function revoke(c: { clientId: string; name: string }): Promise<void> {
  const name = c.name || '该程序'
  const ok = await run(() => gatewayService.revokeClient(c.clientId), '操作失败，请稍后重试')
  if (ok) toast(`已解除「${name}」的限制`)
}

/** 「被拦下」的原因文案。 */
function blockedReason(b: GatewayBlocked): string {
  if (b.reason === 'deny') return '你拒绝过它'
  if (b.reason === 'revoked') return '授权已撤销'
  return '连续忽略，暂时不再弹窗'
}

/** scope 串 → 中文；后端将来加了新串也不会显示一片空白 */
function scopeLabel(s: string): string {
  return GATEWAY_SCOPE_LABELS[s as GatewayScope] ?? s
}

function scopesText(c: GatewayClient): string {
  if (c.scopes.length === 0) return '未授予任何权限'
  return `${c.scopes.length} 项权限 · ${c.scopes.map(scopeLabel).join('、')}`
}

function fmtSeen(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function seenText(c: GatewayClient): string {
  if (!c.lastSeen) return c.online ? '在线' : '从未活跃'
  return c.online ? `在线 · 最后活跃 ${fmtSeen(c.lastSeen)}` : `最后活跃 ${fmtSeen(c.lastSeen)}`
}

let offChanged: (() => void) | null = null

onMounted(async () => {
  await refresh()
  // 授权 / 撤销后 Rust 会推一份新状态；订阅它，列表就不必轮询
  offChanged = await gatewayService.onAuthorizationChanged((s) => {
    status.value = s
  })
})

onUnmounted(() => {
  offChanged?.()
})
</script>

<template>
  <section class="card d-full" data-testid="settings-external-access">
    <header class="row between ghead">
      <h2 class="gtitle">外部访问</h2>
      <span class="t-3">{{ stateHint }}</span>
    </header>

    <p class="pnote t-3">
      让这台电脑上的其它程序（桌面客户端、小组件）读写在 Rein 里的日程、番茄钟与运动数据。
      每个程序连上来都要你当面批一次，只拿到你勾的那几项权限；下面随时可以撤销。
    </p>

    <div class="card sub rows">
      <div class="frow row">
        <i class="fic" :class="{ on: enabled }"><Power :size="17" /></i>
        <span class="col ftxt">
          <b>对外服务</b>
          <em class="t-3">{{ enabled ? '正在监听，外部程序可以连' : '默认关闭，不监听任何端口' }}</em>
        </span>
        <ToggleSwitch v-model="toggleChoice" label="对外服务" :disabled="busy" data-testid="gateway-toggle-enabled" />
      </div>

      <div class="frow row">
        <i class="fic" :class="{ on: enabled && port !== null }"><Server :size="17" /></i>
        <span class="col ftxt">
          <b v-if="port !== null" class="num">端口 {{ port }}</b>
          <b v-else>端口未监听</b>
          <em class="t-3">{{ portHint }}</em>
        </span>
      </div>
    </div>

    <h3 class="stitle">谁能连</h3>
    <div class="segwrap" data-testid="gateway-bind-mode">
      <SegmentedControl v-model="bindChoice" :options="BIND_OPTIONS" />
    </div>
    <p class="pnote t-3">
      「仅本机」只绑 127.0.0.1：这台电脑上的程序才连得上；网页（带着 Origin 的浏览器连接）在握手阶段就被拒掉。
    </p>

    <p v-if="bindMode === 'lan'" class="warn row">
      <TriangleAlert :size="16" class="warn-ico" />
      <span class="col">
        <b>局域网模式把这个端口开给了同网段的设备</b>
        <em>
          同一个 WiFi（宿舍、公司、咖啡店）里的其它设备都能扫到它，拿到配对令牌就能读写你授权过的数据；
          本轮不做端到端加密。只在自家可信网络里开，用完切回「仅本机」。
        </em>
      </span>
    </p>

    <div v-if="bindMode === 'lan' && pairToken" class="card sub rows paircard">
      <div class="frow row">
        <i class="fic on"><KeyRound :size="17" /></i>
        <span class="col ftxt">
          <b>配对令牌</b>
          <em class="t-3">外部客户端首帧必须带上它（LAN 模式必填）。仅本机设置页可见，别外传。</em>
          <code class="paircode" data-testid="gateway-pair-token">{{ pairToken }}</code>
        </span>
        <button
          type="button"
          class="copy"
          data-testid="gateway-copy-pair-token"
          @click="copyPairToken"
        >
          复制
        </button>
      </div>
    </div>

    <h3 class="stitle">已授权的程序</h3>
    <EmptyState
      v-if="clients.length === 0"
      :icon="Globe"
      title="还没有程序接入"
      hint="外部程序连上来、你在弹窗里点了「允许」之后，会出现在这里"
    />

    <div v-else class="card sub rows">
      <div
        v-for="c in clients"
        :key="c.clientId"
        class="frow row"
        :data-testid="`gateway-client-${c.clientId}`"
      >
        <i class="fic" :class="{ on: c.online }">
          <component :is="c.online ? Link2 : Unplug" :size="17" />
        </i>
        <span class="col ftxt">
          <b>{{ c.name || '未命名程序' }}</b>
          <em class="t-3">{{ c.grant === 'always' ? '始终允许' : '本次会话' }} · {{ scopesText(c) }}</em>
          <em class="t-3">{{ seenText(c) }}</em>
        </span>
        <button
          type="button"
          class="revoke"
          :disabled="busy"
          :data-testid="`gateway-client-revoke-${c.clientId}`"
          :aria-label="`撤销「${c.name || '未命名程序'}」的访问权限`"
          @click="revoke(c)"
        >
          撤销
        </button>
      </div>
    </div>

    <template v-if="blocked.length > 0">
      <h3 class="stitle">被拦下的程序</h3>
      <p class="pnote t-3">
        你拒绝过、或撤销过授权、或连续忽略进入静默的程序会列在这里。点「解除」让它回到未记录状态
        —— 下次再连会重新询问。
      </p>
      <div class="card sub rows">
        <div
          v-for="b in blocked"
          :key="b.clientId"
          class="frow row"
          :data-testid="`gateway-blocked-${b.clientId}`"
        >
          <i class="fic"><Ban :size="17" /></i>
          <span class="col ftxt">
            <b>{{ b.name || '未命名程序' }}</b>
            <em class="t-3">{{ blockedReason(b) }}</em>
            <em v-if="b.ip" class="t-3">来自 {{ b.ip }}</em>
          </span>
          <button
            type="button"
            class="unblock"
            :disabled="busy"
            :data-testid="`gateway-blocked-unblock-${b.clientId}`"
            :aria-label="`解除对「${b.name || '未命名程序'}」的限制`"
            @click="revoke({ clientId: b.clientId, name: b.name })"
          >
            解除
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.gtitle,
.stitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.stitle {
  margin-top: 16px;
}

/* 卡头与下面那口浅井之间恒为 4px（与设置页其它分区同一条节奏） */
.ghead + .card.sub {
  margin-top: 4px;
}

.pnote {
  margin-top: 10px;
  font-size: var(--fs-caption);
  line-height: 1.7;
}

.segwrap {
  margin-top: 10px;
}

/* 行组：图标章 + 标题/说明 + 尾部控件（与设置页其它分区的格内行同构） */
.frow {
  width: 100%;
  gap: 11px;
  padding: 10px 0;
  text-align: left;
  color: inherit;
}

.fic {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-s);
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-3);
}

.fic.on {
  background: var(--accent-soft);
  color: var(--accent);
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: 1px;
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: 600;
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 行间细线，首行不留线 */
.rows > * + * {
  border-top: 0.5px solid var(--line);
}

/* 局域网风险提示：说的是「数据可能被谁拿走」，用危险色，别做成一句可有可无的注脚 */
.warn {
  margin-top: 10px;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.warn-ico {
  flex: none;
  margin-top: 1px;
}

.warn b {
  font-weight: 600;
}

.warn em {
  font-style: normal;
}

.revoke {
  flex: none;
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger-strong);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.paircard {
  margin-top: 10px;
}

/* 复制按钮：中性色，与「撤销」的红色区分开 */
.copy {
  flex: none;
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: 600;
}

/* 令牌串：等宽、可选中、长串换行，别被 ellipsis 吞掉尾部 */
.paircode {
  margin-top: 2px;
  font-size: var(--fs-caption);
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--text-2);
  word-break: break-all;
  user-select: all;
}

.revoke:disabled {
  opacity: 0.45;
}

/* 「被拦下」的解除按钮：中性色（不是破坏性操作） */
.unblock {
  flex: none;
  padding: 7px 13px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.unblock:disabled {
  opacity: 0.45;
}
</style>
