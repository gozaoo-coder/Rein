<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Download, Sparkles, X } from 'lucide-vue-next'

import { useToast } from '@/composables/useToast'
import { useUpdateStore } from '@/stores/update'

/**
 * 启动更新提示：检查到新版本时弹一张明确的卡片（而不是一闪而过的 toast）。
 *
 * 三个动作对应三种意图：
 *   - 立即更新：开始下载并跳到更新页看进度（下载在后台线程，切页不中断）
 *   - 稍后：本次启动不再打扰（下次启动会再提示，除非跳过）
 *   - 跳过此版本：写 ignoredVersion，之后的静默检查不再提示这个版本
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const update = useUpdateStore()
const { toast } = useToast()

const starting = ref(false)

const version = computed(() => update.check?.latestVersion ?? '')
const notes = computed(() => update.check?.notes?.trim() ?? '')
const sizeText = computed(() => {
  const n = update.check?.sizeBytes
  if (!n) return ''
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
})
const mandatory = computed(() => Boolean(update.check?.mandatory))
const unsupported = computed(() => update.snapshot?.installSupported === false)

function close(): void {
  emit('close')
}

/** 当前平台不支持应用内安装：去更新页复制链接手动装。 */
function openPage(): void {
  close()
  void router.push({ name: 'settings-update' })
}

/** 立即更新：后台开始下载 + 跳更新页看进度。下载失败留给更新页的进度卡报错。 */
async function installNow(): Promise<void> {
  if (starting.value) return
  starting.value = true
  try {
    const ok = await update.startDownload()
    close()
    await router.push({ name: 'settings-update' })
    if (!ok) toast(update.error ?? '下载启动失败')
  } finally {
    starting.value = false
  }
}

async function skip(): Promise<void> {
  if (version.value) await update.save({ ignoredVersion: version.value })
  toast(`已跳过 v${version.value}`)
  close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="upfade">
      <div v-if="props.open" class="up-backdrop" @click="close" />
    </Transition>
    <Transition name="upcard">
      <section
        v-if="props.open"
        class="up-card"
        role="dialog"
        aria-modal="true"
        :aria-label="`发现新版本 ${version}`"
      >
        <header class="up-head">
          <Sparkles :size="18" />
          <h2>发现新版本 v{{ version }}</h2>
          <button class="up-x" aria-label="关闭" @click="close">
            <X :size="15" :stroke-width="2.5" />
          </button>
        </header>

        <p class="up-meta">
          <template v-if="sizeText">{{ sizeText }}</template>
          <template v-if="update.check?.sourceName"> · 来自 {{ update.check.sourceName }}</template>
          <template v-if="mandatory"> · <b class="up-must">此版本为必须更新</b></template>
        </p>

        <p v-if="notes" class="up-notes">{{ notes }}</p>

        <p v-if="unsupported" class="up-warn">
          <AlertTriangle :size="14" /> {{ update.snapshot?.installHint }}
        </p>

        <div class="up-actions">
          <button v-if="!unsupported" class="up-btn primary" :disabled="starting" @click="installNow">
            <Download :size="15" /> {{ starting ? '正在开始…' : '立即更新' }}
          </button>
          <button v-else class="up-btn primary" @click="openPage">去更新页</button>
          <button class="up-btn" @click="close">稍后</button>
          <button class="up-skip" @click="skip">跳过此版本</button>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.up-backdrop {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: var(--scrim);
}

.up-card {
  position: fixed;
  z-index: 120;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(400px, calc(100vw - 40px));
  max-height: min(70dvh, 560px);
  display: flex;
  flex-direction: column;
  padding: 16px 18px calc(14px + var(--safe-bottom, 0px));
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-float);
}

.up-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
}

.up-head h2 {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  font-size: var(--fs-headline);
  font-weight: 700;
}

.up-x {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-2);
  color: var(--text-2);
}

.up-meta {
  margin-top: 8px;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.up-must {
  color: var(--danger, #d9534f);
}

.up-notes {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-s);
  background: var(--surface-2);
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-y: auto;
  max-height: 36dvh;
}

.up-warn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: var(--fs-caption);
  color: var(--danger, #d9534f);
}

.up-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.up-btn {
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

.up-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}

.up-btn:disabled {
  opacity: 0.45;
}

.up-skip {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
}

.upfade-enter-active,
.upfade-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.upfade-enter-from,
.upfade-leave-to {
  opacity: 0;
}

.upcard-enter-active {
  transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}
.upcard-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}
.upcard-enter-from,
.upcard-leave-to {
  opacity: 0;
}
.upcard-enter-from {
  transform: translate(-50%, calc(-50% + 14px));
}
</style>
