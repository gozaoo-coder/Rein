<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { ChevronRight, Fingerprint, KeyRound, Link2, LogIn, Package, Smartphone, Zap } from 'lucide-vue-next'

import ActionSheet from '@/components/common/ActionSheet.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { syncService } from '@/services/syncService'
import type { PairStatus, SyncPeerInfo, SyncRunResult, SyncRunStats, SyncStatus } from '@/types'

/**
 * 多设备同步（三级页，入口在「设置 › 多设备同步」）。
 *
 * 三张卡片，顺序就是用户的心智顺序：
 *   1. 本机是谁（名字 / 指纹 / 有多少条在账上）
 *   2. 连了谁（每台上次走的哪条路：局域网直连 · 打洞直连 · 云端中继）
 *   3. 怎么再加一台（开码 / 输码）
 *
 * 路径是自动选的（同网段直连 → 打洞 → 中继兜底），页面上**不给「用哪条路」的开关** ——
 * 那是实现细节，不是用户的选择；这里只如实显示这次走成了哪条。
 */
const { toast } = useToast()

const status = ref<SyncStatus | null>(null)
const busy = ref(false)
const offer = ref<string | null>(null)
const claimCode = ref('')
const lastRun = ref<SyncRunStats | null>(null)
const peerSheet = ref<SyncPeerInfo | null>(null)
let pollTimer: number | null = null

const PATH_TEXT: Record<string, string> = {
  lan: '局域网直连',
  punch: '打洞直连',
  relay: '云端中继',
}

const peers = computed(() => status.value?.peers ?? [])
const paired = computed(() => peers.value.length > 0)

const peerActions = computed(() => [
  { label: '立即同步', value: 'run' },
  { label: `解除与「${peerSheet.value?.name || peerSheet.value?.short || ''}」的配对`, value: 'forget', danger: true },
])

const pendingHint = computed(() => {
  const s = status.value
  if (!s) return ''
  const bits: string[] = []
  if (s.pending > 0) bits.push(`${s.pending} 条正在打包`)
  if (s.staleTables > 0) bits.push(`${s.staleTables} 张表结构变了，会重新补录`)
  if (s.conflicts > 0) bits.push(`${s.conflicts} 处冲突留档`)
  return bits.length > 0 ? bits.join(' · ') : '改动会自动打包，同步时只发对方没有的'
})

/**
 * 「上次走的是哪条路」这一行。
 * 本次会话刚回来时用事件里的明细（含用时与流量）；重新进页面时退回到状态里记的那一份 ——
 * 用户最想知道的就是这句话，不该只在刚同步完的那几分钟里看得见。
 */
const lastSummary = computed(() => {
  const run = lastRun.value
  if (run) {
    const tail = run.notes.length > 0 ? ` · ${run.notes.join(' · ')}` : ''
    return `这次走「${run.pathLabel}」· 收到 ${run.applied} 条 · 冲突 ${run.conflicts} 处 · 用时 ${secs(run.ms)} 秒 · ↑${fmtBytes(run.up)} ↓${fmtBytes(run.down)}${tail}`
  }
  const s = status.value
  if (s?.lastAt) {
    return `上次同步 ${fmtTime(s.lastAt)} · 走「${pathText(s.lastPath)}」· ↑${fmtBytes(s.lastUp)} ↓${fmtBytes(s.lastDown)}`
  }
  return ''
})

function pathText(p: string | null | undefined): string {
  if (!p) return '未同步'
  return PATH_TEXT[p] ?? p
}

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B'
  const mb = n / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '从未'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0)
}

async function refresh(): Promise<void> {
  status.value = await syncService.status()
}

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pairStart(): Promise<void> {
  busy.value = true
  try {
    const res = await syncService.pairStart()
    offer.value = res.code
    stopPoll()
    // 另一台输完码这边就该收尾；过期由服务端判，这里只管问
    pollTimer = window.setInterval(() => void pollOnce(), 2000)
  } catch (e) {
    toast(`开码失败：${String(e)}`)
  } finally {
    busy.value = false
  }
}

async function pollOnce(): Promise<void> {
  try {
    const st: PairStatus = await syncService.pairPoll()
    if (st.peer) {
      stopPoll()
      offer.value = null
      await refresh()
      toast(`配对完成：${st.peer.name || st.peer.short} 已加入`)
    }
  } catch {
    // 轮询失败不打扰：下一拍再试，码过期会由服务端返回错误
  }
}

async function claim(): Promise<void> {
  const code = claimCode.value.trim()
  if (!code) return
  busy.value = true
  try {
    const st = await syncService.pairClaim(code)
    claimCode.value = ''
    await refresh()
    toast(`配对完成：${st.peer?.name || '已加入同步组'}`)
  } catch (e) {
    toast(`配对没成：${String(e)}`)
  } finally {
    busy.value = false
  }
}

async function runNow(): Promise<void> {
  if (busy.value) return
  busy.value = true
  lastRun.value = null
  try {
    await syncService.run()
  } catch (e) {
    busy.value = false
    toast(`同步起不来：${String(e)}`)
    return
  }
  // 结果由 sync://result 事件送回来；万一事件没到（例如浏览器里的 mock），
  // 别让按钮一直卡在「同步中」—— 但留足时间，别把真在跑的大同步放开成第二次。
  window.setTimeout(() => {
    if (busy.value) {
      busy.value = false
      void refresh()
    }
  }, 20000)
}

async function forget(peer: SyncPeerInfo): Promise<void> {
  status.value = await syncService.forget(peer.device)
  lastRun.value = null
  toast('已解除配对，本机数据没动')
}

function openPeer(peer: SyncPeerInfo): void {
  peerSheet.value = peer
}

async function onPeerAction(value: string): Promise<void> {
  const peer = peerSheet.value
  if (!peer) return
  if (value === 'run') await runNow()
  if (value === 'forget') await forget(peer)
}

let unlisten: (() => void) | null = null

onMounted(async () => {
  await refresh()
  unlisten = await listen<SyncRunResult>('sync://result', (event) => {
    busy.value = false
    const payload = event.payload
    const first = payload.stats?.[0] ?? null
    lastRun.value = first
    if (payload.error) {
      toast(`同步失败：${payload.error}`)
    } else if (payload.errors && payload.errors.length > 0) {
      toast(`部分设备没同步成：${payload.errors.join('；')}`)
    } else if (first) {
      toast(`${first.pathLabel} · 收到 ${first.applied} 条，用时 ${secs(first.ms)} 秒`)
    } else {
      toast('还没有配对的设备')
    }
    void refresh()
  })
})

onUnmounted(() => {
  stopPoll()
  unlisten?.()
})
</script>

<template>
  <div class="page">
    <PageHeader title="多设备同步" back />

    <!-- 桌面栅格：壳层只把 .page 的**直接子项**摊成两栏，而这一页要的是
         「本机 | 已配对设备 并排 + 加一台设备通栏」，所以自带一层 .d-grid 承接。
         手机端它只是个普通 div，块流与卡片间距都不变 -->
    <div class="d-grid sync-grid">
    <!-- 本机 -->
    <section class="card">
      <h2 class="gtitle">本机</h2>
      <div class="rows">
        <div class="frow row">
          <i class="fic"><Smartphone :size="17" /></i>
          <span class="col ftxt">
            <b>{{ status?.deviceName || '—' }}</b>
            <em class="t-3">这台设备在同步里的名字</em>
          </span>
        </div>
        <div class="frow row">
          <i class="fic"><Fingerprint :size="17" /></i>
          <span class="col ftxt">
            <b class="mono">{{ status?.fingerprint || '—' }}</b>
            <em class="t-3">公钥指纹 · 设备号 {{ status?.deviceShort || '—' }}</em>
          </span>
        </div>
        <div class="frow row">
          <i class="fic"><Package :size="17" /></i>
          <span class="col ftxt">
            <b>{{ status?.objects ?? 0 }} 条在同步账上</b>
            <em class="t-3">{{ pendingHint }}</em>
          </span>
        </div>
      </div>
      <p class="pnote t-3">
        配对时两端会互换公钥指纹：两边显示的一致，才说明中间没有人插进来。
        之后每次连接都按这把公钥校验，换了就拒连。
      </p>
    </section>

    <!-- 已配对设备 -->
    <section class="card">
      <h2 class="gtitle">已配对设备</h2>

      <EmptyState
        v-if="!paired"
        :icon="Link2"
        title="还没有配对的设备"
        hint="两台设备都装 Rein、都指向同一台在线服务，然后下面开一串码互相认一下即可"
      />

      <template v-else>
        <div class="rows">
          <button v-for="p in peers" :key="p.device" class="frow row" @click="openPeer(p)">
            <i class="fic"><Link2 :size="17" /></i>
            <span class="col ftxt">
              <b>{{ p.name || '未命名设备' }}</b>
              <em class="t-3">{{ p.short }} · 上次 {{ fmtTime(p.lastSeen) }}</em>
            </span>
            <span class="tag" :class="p.path ?? 'none'">{{ pathText(p.path) }}</span>
            <ChevronRight :size="16" class="t-3" />
          </button>
        </div>

        <button class="btn" :disabled="busy" @click="runNow">
          <Zap :size="16" />
          {{ busy ? '同步中…' : '立即同步' }}
        </button>

        <p v-if="lastSummary" class="pnote t-3">{{ lastSummary }}</p>
      </template>
    </section>

    <!-- 加一台设备：桌面上通栏后内部再分两栏（见 .desk-main 那段注释） -->
    <section class="card d-full add-card">
      <h2 class="gtitle">加一台设备</h2>
      <div class="rows">
        <div class="frow row">
          <i class="fic"><KeyRound :size="17" /></i>
          <span class="col ftxt">
            <b>在这台开同步码</b>
            <em class="t-3">念给另一台，5 分钟内有效、用过即废</em>
          </span>
          <button class="btn small" :disabled="busy || !!offer" @click="pairStart">开码</button>
        </div>
      </div>

      <div v-if="offer" class="code">
        <b class="mono">{{ offer }}</b>
        <em class="t-3">在另一台上输入这串码，这边会自动收尾</em>
      </div>

      <p class="pnote t-3">或者反过来 —— 在另一台上开码，把码输到这里：</p>
      <div class="claim">
        <input
          v-model="claimCode"
          class="input mono"
          placeholder="ABCD2345"
          maxlength="12"
          autocapitalize="characters"
          autocomplete="off"
          @keyup.enter="claim"
        />
        <button class="btn small" :disabled="busy || !claimCode.trim()" @click="claim">
          <LogIn :size="15" /> 确认
        </button>
      </div>
    </section>
    </div>

    <ActionSheet
      :open="!!peerSheet"
      :title="peerSheet?.name || peerSheet?.short || ''"
      :actions="peerActions"
      @close="peerSheet = null"
      @select="onPeerAction"
    />
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.gtitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

/* 分组行：行间细线，首行不留线（与设置页同一套） */
.rows {
  display: grid;
  grid-template-columns: 1fr;
  margin-top: 4px;
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

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
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.94em;
  letter-spacing: 0.02em;
}

/* 路径标签：走成打洞时给一点强调色 —— 这是用户最想确认的事 */
.tag {
  flex: none;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  color: var(--text-3);
  background: var(--surface-2);
}

.tag.punch {
  color: var(--accent);
  background: var(--accent-soft);
}

.tag.lan {
  color: var(--text-2);
  background: var(--surface-2);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 14px;
  padding: 10px 16px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: #fff;
  font-size: var(--fs-body);
  font-weight: 600;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.btn:disabled {
  opacity: 0.45;
}

.btn.small {
  margin-top: 0;
  padding: 7px 13px;
  font-size: var(--fs-caption);
}

.code {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
  padding: 16px;
  border-radius: var(--radius-l);
  background: var(--surface-2);
}

.code b {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--text-1);
}

.code em {
  font-style: normal;
  font-size: var(--fs-caption);
}

.pnote {
  margin-top: 12px;
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.claim {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.input {
  flex: 1;
  min-width: 0;
  padding: 9px 13px;
  border-radius: var(--radius-full);
  border: 0.5px solid var(--line);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-body);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.input::placeholder {
  color: var(--text-3);
  letter-spacing: 0.14em;
}

/* ============================================================
   桌面（由 .desk-main 的存在判定 —— 壳层只在 ≥ DESKTOP_MIN 渲染它）
   三张卡是同一层的三件事：本机是谁 / 连了谁 / 怎么再加一台。
   前两张并排（都是「读」，交给 .d-grid 缺省的两栏）；第三张是「写」——
   要输入、还会吐出一串大号同步码，塞进半栏会把它自己的按钮和码挤到一起。
   让它通栏（.d-full），内部再分两栏：
   左边「在这台开码」（码跟着它），右边「在另一台开码、把码输进来」。
   ============================================================ */

.desk-main .add-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 var(--desk-gap);
  align-items: start;
}

.desk-main .add-card > .gtitle {
  grid-column: 1 / -1;
}

/* 「在这台开码」与它会吐出的那串码同栏；两段说明与输入框同栏 */
.desk-main .add-card > .rows,
.desk-main .add-card > .code {
  grid-column: 1;
}

.desk-main .add-card > .pnote,
.desk-main .add-card > .claim {
  grid-column: 2;
}

/* 右栏首行是句小字，加个与 .rows 同值的 4px 起始偏移，两栏的第一行才齐平 */
.desk-main .add-card > .pnote {
  margin-top: 4px;
}
</style>
