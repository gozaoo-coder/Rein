<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Cloud, Download, RefreshCw, ShieldCheck, ShieldX, Sparkles } from 'lucide-vue-next'

import NumberStepper from '@/components/common/NumberStepper.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useToast } from '@/composables/useToast'
import { useUpdateStore } from '@/stores/update'
import { notesAboveCurrent } from '@/utils/updateNotes'
import type { SourceReport, UpdatePhase, UpdateSettingsPatch, UpdateSource } from '@/types'

/**
 * 更新中心（二级内容页，入口在「设置 › 关于」）。
 *
 * 这一页要回答四件事，顺序就是从上到下的卡片顺序：
 *   1. 我现在是什么版本、能装什么平台的包
 *   2. 有没有新版本（以及各更新源分别探到了什么）
 *   3. 下载到哪一步了、装不装得上
 *   4. 更新之外的在线服务可用吗（模型网关是预留接口）
 */
const router = useRouter()
const update = useUpdateStore()
const { toast } = useToast()

const customUrl = ref('')
const customName = ref('')
const showSourceEditor = ref(false)
const CHANNELS = ['stable', 'beta'] as const

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '待检查',
  preparing: '准备中…',
  downloading: '下载中',
  verifying: '校验签名…',
  ready: '已就绪，可安装',
  installing: '正在安装…',
  failed: '下载失败',
  cancelled: '已取消',
}

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '未知大小'
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function fmtSpeed(n: number): string {
  if (!n) return ''
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(n / 1024)} KB/s`
}

function fmtTime(iso: string | null): string {
  if (!iso) return '从未'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 平台键 → 人话（键名与 tauri updater 的 target 一致，不能改） */
const platformLabel = computed(() => {
  const key = update.snapshot?.platform ?? ''
  const [os, arch] = key.split('-')
  const osName = ({ windows: 'Windows', android: 'Android', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[os] ?? os
  const archName = ({ x86_64: 'x64', aarch64: 'arm64', armv7: 'armv7', i686: 'x86' } as Record<string, string>)[arch ?? ''] ?? arch
  return archName ? `${osName} · ${archName}` : osName
})

const download = computed(() => update.downloadState)
const check = computed(() => update.check)
/** 说明只显示比本机高的版本段落：清单里装的是整份 RELEASE_NOTES.md（见 utils/updateNotes） */
const notes = computed(() => notesAboveCurrent(check.value?.notes, check.value?.currentVersion ?? ''))

const downloadedPercent = computed(() => {
  const d = download.value
  if (!d) return 0
  if (d.total > 0) return Math.min(100, Math.round((d.received / d.total) * 100))
  return d.phase === 'ready' || d.phase === 'installing' ? 100 : 0
})

/** 某更新源这次检查的结果（还没检查过时为空） */
function reportOf(id: string): SourceReport | null {
  return check.value?.sources.find((s) => s.id === id) ?? null
}

function sourceDetail(s: SourceReport): string {
  if (!s.ok) return s.error ?? '不可用'
  return `${s.version ?? '—'}${s.manifestSigned ? ' · 清单已签名' : ''}`
}

const statusLine = computed(() => {
  if (!update.snapshot) return '正在读取…'
  const d = download.value
  if (d && d.phase !== 'idle') return PHASE_TEXT[d.phase]
  if (check.value?.ignored) return `已跳过 ${check.value.latestVersion}`
  if (update.hasUpdate) return `发现新版本 ${check.value?.latestVersion}`
  if (check.value) return `已是最新版本（${fmtTime(check.value.checkedAt)}检查）`
  return '尚未检查过'
})

/** 设置类写操作统一走这里：失败要吵（toast），成功不出声 */
async function save(patch: UpdateSettingsPatch): Promise<void> {
  if (!(await update.save(patch))) toast(update.error ?? '保存失败')
}

async function onCheck(): Promise<void> {
  const result = await update.checkNow(true)
  if (!result) {
    toast(update.error ?? '检查更新失败')
    return
  }
  if (result.downgradeBlocked) toast('该源提供的版本低于此前见过的最新版，已忽略')
  else if (result.available) toast(`发现新版本 ${result.latestVersion}`)
  else toast('当前已是最新版本')
}

async function onDownload(): Promise<void> {
  if (await update.startDownload()) toast('已开始下载，可在本页查看进度')
  else toast(update.error ?? '下载启动失败')
}

async function onInstall(): Promise<void> {
  const result = await update.install()
  toast(result ? result.message : (update.error ?? '安装失败'))
}

async function onCancel(): Promise<void> {
  await update.cancel()
  toast('已取消下载')
}

async function onSkip(): Promise<void> {
  const v = check.value?.latestVersion
  if (v) await save({ ignoredVersion: v })
}

async function onUnskip(): Promise<void> {
  await save({ ignoredVersion: '' })
}

async function onToggleSource(source: UpdateSource, on: boolean): Promise<void> {
  const list = (update.settings?.sources ?? []).map((s) => (s.id === source.id ? { ...s, enabled: on } : s))
  await save({ sources: list })
}

async function onAddSource(): Promise<void> {
  const url = customUrl.value.trim()
  if (!/^https?:\/\//.test(url)) {
    toast('请填写 http(s) 开头的清单地址')
    return
  }
  const list = update.settings?.sources ?? []
  if (list.some((s) => s.url === url)) {
    toast('该地址已在列表中')
    return
  }
  const next: UpdateSource = {
    id: `custom-${Date.now().toString(36)}`,
    name: customName.value.trim() || '自定义源',
    kind: 'tauri-static',
    url,
    enabled: true,
    priority: 20 + list.length,
  }
  if (await update.save({ sources: [...list, next] })) {
    customUrl.value = ''
    customName.value = ''
    showSourceEditor.value = false
    toast('已添加更新源')
  } else {
    toast(update.error ?? '添加失败')
  }
}

async function onRemoveCustom(id: string): Promise<void> {
  const list = (update.settings?.sources ?? []).filter((s) => s.id !== id)
  if (await update.save({ sources: list })) toast('已移除（内置源会自动补回）')
}

async function onPrune(): Promise<void> {
  const freed = await update.pruneCache()
  toast(freed > 0 ? `已清理 ${fmtBytes(freed)}` : '没有可清理的残留')
}

onMounted(async () => {
  await update.load()
  // 进页面就把在线服务探一次：这张卡的信息用户一眼要能看到
  void update.probeOnline()
})
</script>

<template>
  <div class="page">
    <PageHeader title="软件更新" back />

    <!-- 版本 -->
    <section class="card">
      <div class="row between head">
        <span class="col">
          <b class="ver num">v{{ update.currentVersion || '—' }}</b>
          <em class="t-3">{{ platformLabel }}</em>
        </span>
        <button class="btn primary" :disabled="update.checking" @click="onCheck">
          <RefreshCw :size="15" :class="{ spin: update.checking }" />
          {{ update.checking ? '检查中…' : '检查更新' }}
        </button>
      </div>
      <p class="t-3 status">{{ statusLine }}</p>
      <p v-if="update.snapshot && !update.snapshot.installSupported" class="warn">
        <AlertTriangle :size="14" /> {{ update.snapshot.installHint }}
      </p>
    </section>

    <!-- 有更新 -->
    <section v-if="update.hasUpdate || update.readyToInstall" class="card hl">
      <header class="row between ghead">
        <h2 class="gtitle">可更新到 v{{ check?.latestVersion }}</h2>
        <span v-if="check?.sourceName" class="t-3 tiny">{{ check.sourceName }}</span>
      </header>

      <p class="meta t-3">
        {{ fmtBytes(check?.sizeBytes) }} · 发布于 {{ fmtTime(check?.publishedAt ?? null) }}
        <template v-if="check?.mandatory"> · 此版本为必须更新</template>
      </p>

      <p v-if="notes" class="notes">{{ notes }}</p>

      <p v-if="check?.downgradeBlocked" class="warn">
        <ShieldX :size="14" /> 该源给出的版本低于此前见过的最新版，可能被回放旧版本，已阻止自动更新
      </p>

      <!-- 进度 -->
      <div v-if="download && download.phase !== 'idle'" class="progress-box">
        <div class="pbar">
          <i class="pfill" :style="{ width: `${downloadedPercent}%` }" />
        </div>
        <div class="row between t-3 tiny">
          <span>{{ PHASE_TEXT[download.phase] }}<template v-if="download.phase === 'downloading'"> · {{ fmtSpeed(download.bytesPerSec) }}</template></span>
          <span class="num">
            {{ fmtBytes(download.received) }} / {{ fmtBytes(download.total) }}
          </span>
        </div>
        <p v-if="download.error" class="warn"><AlertTriangle :size="14" /> {{ download.error }}</p>
        <p v-if="download.phase === 'ready'" class="ok"><ShieldCheck :size="14" /> 已通过摘要与签名校验，可以安装</p>
      </div>

      <div class="actions">
        <button v-if="!update.readyToInstall && !update.busy" class="btn primary" @click="onDownload">
          <Download :size="15" /> 下载安装包
        </button>
        <button v-if="update.readyToInstall && !update.installing" class="btn primary" @click="onInstall">
          <Download :size="15" /> 安装并重启
        </button>
        <button v-if="update.busy && download?.phase === 'downloading'" class="btn" @click="onCancel">取消</button>
        <button v-if="update.readyToInstall" class="btn" @click="update.discard()">丢弃安装包</button>
        <button v-if="!update.readyToInstall" class="btn ghost" @click="onSkip">跳过此版本</button>
      </div>
    </section>

    <!-- 已跳过 -->
    <section v-if="check?.ignored" class="card">
      <p class="t-3">
        已跳过 v{{ check.latestVersion }}。
        <button class="link" @click="onUnskip">恢复提示</button>
      </p>
    </section>

    <!-- 更新源 -->
    <section class="card">
      <header class="row between ghead">
        <h2 class="gtitle">更新源</h2>
        <button class="link" @click="showSourceEditor = !showSourceEditor">
          {{ showSourceEditor ? '收起' : '添加自定义源' }}
        </button>
      </header>

      <div v-if="showSourceEditor" class="editor">
        <input v-model="customName" class="inp" placeholder="名称（可选）" />
        <input v-model="customUrl" class="inp" placeholder="清单地址，如 https://…/latest.json" />
        <button class="btn primary" @click="onAddSource">添加</button>
      </div>

      <div v-for="s in update.settings?.sources ?? []" :key="s.id" class="srow row">
        <span class="col stxt">
          <b>{{ s.name }}</b>
          <em class="t-3 url">{{ s.url }}</em>
          <em v-if="reportOf(s.id)" class="t-3" :class="{ bad: !reportOf(s.id)!.ok }">
            {{ reportOf(s.id)!.ok ? '✓ ' : '✕ ' }}{{ sourceDetail(reportOf(s.id)!) }}
          </em>
        </span>
        <button v-if="s.id.startsWith('custom-')" class="link" @click="onRemoveCustom(s.id)">移除</button>
        <ToggleSwitch
          :model-value="s.enabled"
          :label="`${s.name} 开关`"
          @update:model-value="onToggleSource(s, $event)"
        />
      </div>
    </section>

    <!-- 设置 -->
    <section class="card">
      <h2 class="gtitle">更新设置</h2>
      <div class="rows">
        <div class="row between frow">
          <span class="col ftxt"><b>自动检查更新</b><em class="t-3">启动时静默检查，有新版本才提示</em></span>
          <ToggleSwitch
            :model-value="update.settings?.autoCheck ?? true"
            label="自动检查更新"
            @update:model-value="update.save({ autoCheck: $event })"
          />
        </div>
        <NumberStepper
          :model-value="update.settings?.checkIntervalHours ?? 12"
          label="检查间隔"
          unit="小时"
          :step="6"
          :min="1"
          :max="168"
          @update:model-value="update.save({ checkIntervalHours: $event })"
        />
        <div class="row between frow">
          <span class="col ftxt"><b>更新通道</b><em class="t-3">选择跟随哪个发布通道</em></span>
          <span class="row chips">
            <button
              v-for="c in CHANNELS"
              :key="c"
              class="chip"
              :class="{ on: update.settings?.channel === c }"
              @click="update.save({ channel: c })"
            >
              {{ c }}
            </button>
          </span>
        </div>
        <div class="row between frow">
          <span class="col ftxt">
            <b>允许明文 http 源</b>
            <em class="t-3">自建服务器没有证书时开启；安装包签名仍是硬校验</em>
          </span>
          <ToggleSwitch
            :model-value="update.settings?.allowHttp ?? true"
            label="允许明文 http 源"
            @update:model-value="update.save({ allowHttp: $event })"
          />
        </div>
        <div v-if="update.snapshot?.platform.startsWith('windows')" class="row between frow">
          <span class="col ftxt"><b>静默安装</b><em class="t-3">安装时不显示进度窗口</em></span>
          <ToggleSwitch
            :model-value="update.settings?.silentInstall ?? false"
            label="静默安装"
            @update:model-value="update.save({ silentInstall: $event })"
          />
        </div>
        <div class="row between frow">
          <span class="col ftxt"><b>清理下载缓存</b><em class="t-3">删除与当前版本无关的安装包残留</em></span>
          <button class="btn" @click="onPrune">清理</button>
        </div>
      </div>
    </section>

    <!-- 在线服务（更新之外的预留接口） -->
    <section class="card">
      <header class="row between ghead">
        <h2 class="gtitle">Rein 在线服务</h2>
        <button class="link" :disabled="update.onlineLoading" @click="update.probeOnline()">
          {{ update.onlineLoading ? '探测中…' : '重新探测' }}
        </button>
      </header>

      <template v-if="update.online">
        <p class="t-3 tiny">
          {{ update.online.baseUrl }} · {{ update.online.reachable ? `在线（${update.online.elapsedMs}ms）` : '不可达' }}
        </p>
        <p v-if="update.online.error" class="warn"><AlertTriangle :size="14" /> {{ update.online.error }}</p>
        <p v-else class="t-3 tiny">
          当前发布版本：{{ update.online.currentRelease ?? '尚无发布' }}
        </p>

        <div v-if="update.online.ai" class="ai-box">
          <p class="row tiny">
            <Cloud :size="14" />
            <b>在线大模型 API</b>
            <span class="tag" :class="{ ready: update.online.ai.status === 'ready' }">
              {{ update.online.ai.status === 'ready' ? '可用' : '未配置' }}
            </span>
          </p>
          <p class="t-3 tiny">
            OpenAI 兼容端点：{{ update.online.ai.chatEndpoint }}
          </p>
          <p v-if="update.online.ai.providers.length" class="t-3 tiny">
            已接入：
            <template v-for="(p, i) in update.online.ai.providers" :key="p.id">
              {{ i ? '、' : '' }}{{ p.name }}{{ p.enabled ? '' : '（未启用）' }}
            </template>
          </p>
          <p v-else class="t-3 tiny">服务端还没有配置 provider，填入密钥后这里会显示可用模型。</p>
          <button class="btn" @click="router.push({ name: 'ai-models' })">
            <Sparkles :size="14" /> 去配置模型
          </button>
        </div>
      </template>
      <p v-else class="t-3 tiny">正在探测…</p>
    </section>

    <p class="note t-3">
      安装包在下载完成后会用内置公钥做 Ed25519 验签，签名不符或摘要不符的包一律不安装。
      清单本身也带签名 —— 服务端只能分发你签过名的更新。
    </p>
  </div>
</template>

<style scoped>
.page {
  padding: 10px var(--page-pad-x) var(--page-pad-bottom);
}

.head {
  gap: 12px;
}

.ver {
  font-size: var(--fs-title2);
  font-weight: 700;
}

.status {
  margin-top: 8px;
  font-size: var(--fs-caption);
}

.gtitle {
  font-size: var(--fs-footnote);
  font-weight: 700;
  color: var(--text-2);
}

.ghead + * {
  margin-top: 8px;
}

.tiny {
  font-size: var(--fs-caption);
}

.meta {
  margin-top: 6px;
  font-size: var(--fs-caption);
}

.notes {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  line-height: 1.6;
  white-space: pre-wrap;
}

.progress-box {
  margin-top: 10px;
}

.pbar {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  overflow: hidden;
}

.pfill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-base) var(--ease-standard);
}

.progress-box > .row {
  margin-top: 6px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  font-weight: 600;
  color: var(--text-1);
}

.btn:active {
  opacity: 0.7;
}

.btn:disabled {
  opacity: 0.45;
}

.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.btn.ghost {
  background: transparent;
  color: var(--text-3);
}

.link {
  color: var(--accent);
  font-size: var(--fs-caption);
}

.editor {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.inp {
  width: 100%;
  padding: 9px 12px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-footnote);
  color: var(--text-1);
}

.srow {
  gap: 10px;
  padding: 10px 0;
}

.srow + .srow {
  border-top: 0.5px solid var(--line);
}

.stxt {
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.stxt b {
  font-size: var(--fs-body);
  font-weight: 600;
}

.stxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.stxt em.bad {
  color: var(--danger, #d9534f);
}

.url {
  color: var(--text-3);
}

.rows {
  display: grid;
  grid-template-columns: 1fr;
  margin-top: 6px;
}

.rows > * + * {
  border-top: 0.5px solid var(--line);
}

.frow {
  gap: 12px;
  padding: 10px 0;
}

.ftxt {
  flex: 1;
  min-width: 0;
  gap: 2px;
}

.ftxt b {
  font-size: var(--fs-body);
  font-weight: 600;
}

.ftxt em {
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.chips {
  gap: 6px;
}

.chip {
  padding: 5px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-2);
}

.chip.on {
  background: var(--accent);
  color: var(--on-accent);
}

.warn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--danger, #d9534f);
  line-height: 1.5;
}

.ok {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--ok);
}

.ai-box {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
}

.tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: 11px;
  color: var(--text-3);
}

.tag.ready {
  background: color-mix(in srgb, var(--ok) 18%, transparent);
  color: var(--ok);
}

.note {
  margin: 14px 4px 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
