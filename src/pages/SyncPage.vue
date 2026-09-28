<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { Link2, RefreshCw, Trash2, Zap } from 'lucide-vue-next'

import PageHeader from '@/components/layout/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import { syncService } from '@/services/syncService'
import type { PairStatus, SyncPeerInfo, SyncRunResult, SyncRunStats, SyncStatus } from '@/types'

/**
 * 多设备同步（三级页，入口在「设置 › 多设备同步」）。
 *
 * 这一页要回答四件事，顺序就是卡片顺序：
 *   1. 我是谁（设备名 + 设备号 + 公钥指纹 —— 指纹是人工核对配对有没有被掉包的）
 *   2. 连了谁（每台设备上次走的哪条路：局域网直连 / 打洞直连 / 云端中继）
 *   3. 怎么再加一台（开码 / 报码，5 分钟有效）
 *   4. 这次同步发生了什么（落了多少条、有没有冲突、走了多少流量）
 *
 * 三条路径的**选择是自动的**：同一网段直接连 → 跨网段打洞 → 都走不通才中继。
 * 这里只如实显示结果，不给用户一个「用哪条路」的开关 —— 那是实现细节，不是选择。
 */
const { toast: rawToast } = useToast()

/**
 * 这一页的提示一律「一句人话」：本应用的 toast 只收字符串（没有 tone）。
 * 这里把 {title, description} 拼成一句，调用处读起来更顺。
 */
function toast(note: { title: string; description?: string; tone?: string } | string): void {
  rawToast(typeof note === 'string' ? note : note.description ? `${note.title}：${note.description}` : note.title)
}

const status = ref<SyncStatus | null>(null)
const busy = ref(false)
const offer = ref<string | null>(null)
const claimCode = ref('')
const claimed = ref<SyncPeerInfo | null>(null)
const lastRun = ref<SyncRunStats | null>(null)
let pollTimer: number | null = null

const PATH_TEXT: Record<string, string> = {
  lan: '局域网直连',
  punch: '打洞直连',
  relay: '云端中继',
}

const peers = computed(() => status.value?.peers ?? [])
const paired = computed(() => peers.value.length > 0)

function pathText(p: string | null | undefined): string {
  if (!p) return '还没同步过'
  return PATH_TEXT[p] ?? p
}

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0'
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '从未'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
    // 另一台输完码，这边的轮询就能收尾 —— 5 分钟到期由服务端判，这里只负责问
    pollTimer = window.setInterval(() => void pollOnce(), 2000)
  } catch (e) {
    toast({ title: '开码失败', description: String(e), tone: 'error' })
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
      toast({ title: '配对完成', description: `${st.peer.name || st.peer.short} 已加入`, tone: 'success' })
    }
  } catch {
    // 轮询失败不打扰用户：下一拍再试，码过期自然会报错
  }
}

async function claim(): Promise<void> {
  const code = claimCode.value.trim()
  if (!code) return
  busy.value = true
  try {
    const st = await syncService.pairClaim(code)
    claimed.value = st.peer
    claimCode.value = ''
    await refresh()
    toast({ title: '配对完成', description: st.peer?.name || '已加入同步组', tone: 'success' })
  } catch (e) {
    toast({ title: '配对没成', description: String(e), tone: 'error' })
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
    toast({ title: '同步起不来', description: String(e), tone: 'error' })
  }
}

async function forget(peer: SyncPeerInfo): Promise<void> {
  if (!window.confirm(`解除与「${peer.name || peer.short}」的配对？本机数据不会删。`)) return
  status.value = await syncService.forget(peer.device)
  toast({ title: '已解除', tone: 'success' })
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
      toast({ title: '同步失败', description: payload.error, tone: 'error' })
    } else if (payload.errors && payload.errors.length > 0) {
      toast({ title: '部分设备没同步成', description: payload.errors.join('；'), tone: 'error' })
    } else if (first) {
      toast({
        title: `${first.pathLabel} · 完成`,
        description: `收到 ${first.applied} 条，用时 ${(first.ms / 1000).toFixed(1)} 秒`,
        tone: 'success',
      })
    } else {
      toast({ title: '没有已配对的设备', tone: 'error' })
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

    <!-- 本机 -->
    <section class="card">
      <h2 class="gtitle">本机</h2>
      <div class="kv">
        <span class="k t-3">设备名</span>
        <span class="v">{{ status?.deviceName || '—' }}</span>
      </div>
      <div class="kv">
        <span class="k t-3">设备号</span>
        <span class="v mono">{{ status?.deviceShort || '—' }}</span>
      </div>
      <div class="kv">
        <span class="k t-3">公钥指纹</span>
        <span class="v mono">{{ status?.fingerprint || '—' }}</span>
      </div>
      <p class="pnote t-3">
        配对时两端会互换公钥指纹；两边显示的一致，才说明中间没有人插进来。
        之后每次连接都按这把公钥校验，换了就拒连。
      </p>
      <div class="kv">
        <span class="k t-3">本机待同步</span>
        <span class="v">
          {{ status?.objects ?? 0 }} 条对象
          <em v-if="(status?.pending ?? 0) > 0" class="t-3">（还有 {{ status?.pending }} 条正在打包）</em>
        </span>
      </div>
    </section>

    <!-- 已配对设备 -->
    <section class="card">
      <h2 class="gtitle">已配对设备</h2>
      <p v-if="!paired" class="pnote t-3">
        还没有配对任何设备。下面开一串码，在另一台上输入即可 —— 两台都要装 Rein，
        并且都在「设置 → 在线服务」里配好同一台服务器地址（用于换地址打洞与兜底中继）。
      </p>

      <div v-for="p in peers" :key="p.device" class="peer">
        <div class="prow">
          <i class="pic" :style="{ background: 'var(--accent-soft)', color: 'var(--accent)' }">
            <Link2 :size="16" />
          </i>
          <span class="col">
            <b>{{ p.name || '未命名设备' }}</b>
            <em class="t-3 mono">{{ p.short }} · {{ p.fingerprint }}</em>
          </span>
          <span class="pill" :class="p.path ?? 'none'">{{ pathText(p.path) }}</span>
        </div>
        <div class="pmeta t-3">
          上次同步 {{ fmtTime(p.lastSeen) }}
          <template v-if="p.seqSent > 0"> · 已发 {{ p.seqSent }} 条</template>
        </div>
        <button class="ghost danger" @click="forget(p)">
          <Trash2 :size="15" /> 解除配对
        </button>
      </div>

      <button class="primary" :disabled="busy || !paired" @click="runNow">
        <Zap :size="16" :class="{ spin: busy }" />
        {{ busy ? '同步中…' : '立即同步' }}
      </button>

      <div v-if="lastRun" class="result">
        <b>这次走了「{{ lastRun.pathLabel }}」</b>
        <span class="t-3">
          收到 {{ lastRun.applied }} 条 · 冲突 {{ lastRun.conflicts }} · 用时
          {{ (lastRun.ms / 1000).toFixed(1) }} 秒 · ↑{{ fmtBytes(lastRun.up) }} ↓{{ fmtBytes(lastRun.down) }}
        </span>
        <span v-for="(note, i) in lastRun.notes" :key="i" class="t-3">{{ note }}</span>
      </div>
    </section>

    <!-- 配对 -->
    <section class="card">
      <h2 class="gtitle">加一台设备</h2>
      <p class="pnote t-3">
        两台设备各点一次就行：这一台开码，另一台输码。码 5 分钟内有效，用过即废；
        组密钥由两端各自用一次性码推出来，服务器全程不知道。
      </p>

      <button class="primary" :disabled="busy || !!offer" @click="pairStart">
        <RefreshCw :size="16" :class="{ spin: busy }" /> 在这台开同步码
      </button>
      <div v-if="offer" class="code">
        <b class="mono">{{ offer }}</b>
        <span class="t-3">在另一台设备上输入这串码；这边会自动等它进来</span>
      </div>

      <div class="claim">
        <input
          v-model="claimCode"
          class="input mono"
          placeholder="输入另一台上的同步码"
          maxlength="12"
          autocapitalize="characters"
          @keyup.enter="claim"
        />
        <button class="primary" :disabled="busy || !claimCode.trim()" @click="claim">确认</button>
      </div>
      <div v-if="claimed" class="result">
        <b>已与「{{ claimed.name || claimed.short }}」配对</b>
        <span class="t-3 mono">{{ claimed.fingerprint }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gtitle {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.pnote {
  font-size: var(--fs-caption);
  line-height: 1.55;
}

.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: var(--fs-caption);
}

.k {
  flex: none;
}

.v {
  text-align: right;
  color: var(--text-1);
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
}

.peer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md, 12px);
}

.prow {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pic {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  display: grid;
  place-items: center;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.col em {
  font-style: normal;
  font-size: var(--fs-caption);
}

.pill {
  flex: none;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  background: var(--surface-2, var(--surface));
  border: 1px solid var(--line);
  color: var(--text-2, var(--text-3));
}

.pill.punch {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}

.pill.lan {
  color: var(--text-1);
}

.pmeta {
  font-size: var(--fs-caption);
}

.primary,
.ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--radius-full);
  font-size: var(--fs-caption);
  font-weight: 600;
  padding: 9px 14px;
  transition: opacity var(--dur-fast) var(--ease-standard);
}

.primary {
  background: var(--accent);
  color: #fff;
}

.primary:disabled {
  opacity: 0.5;
}

.ghost {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--text-2, var(--text-3));
  align-self: flex-start;
}

.ghost.danger {
  color: var(--danger, #e5484d);
}

.code {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  padding: 12px;
  border-radius: var(--radius-md, 12px);
  background: var(--surface-2, var(--surface));
}

.code b {
  font-size: 26px;
  letter-spacing: 0.16em;
}

.code span,
.result span {
  font-size: var(--fs-caption);
}

.claim {
  display: flex;
  gap: 8px;
}

.input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--line);
  background: var(--surface-2, var(--surface));
  color: var(--text-1);
  font-size: var(--fs-caption);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-caption);
  padding: 10px;
  border-radius: var(--radius-md, 12px);
  background: var(--surface-2, var(--surface));
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
