<script setup lang="ts">
/**
 * ShareSheet — 分享底部抽屉
 *
 * - 模式切换：文本 / 图片
 * - 渠道按钮：系统分享 / QQ / 微信 / 复制 / 保存（按支持情况显示）
 * - QQ / 微信 实际通过系统分享面板路由，UI 仅提示用户选择
 * - 图片模式下：先预览 SVG，再触发分享
 */
import { computed, ref, watch } from "vue";
import type { ShareContent, ShareMode } from "@/types/share";
import { useShare } from "@/composables/useShare";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ content: ShareContent }>();
const emit = defineEmits<{ close: [] }>();

const { canShareNative, canShareFiles, shareText, shareImage, copyText, saveImage } = useShare();
const toast = useToast();

const mode = ref<ShareMode>("text");
const previewing = ref(false);
const busy = ref(false);

const hasImage = computed(() => !!props.content.svg);

watch(
  () => props.content,
  () => {
    mode.value = hasImage.value ? "image" : "text";
  },
  { immediate: true },
);

async function run(busyFn: () => Promise<boolean>, successMsg: string, failMsg: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const ok = await busyFn();
    if (ok) {
      toast.success(successMsg);
      emit("close");
    } else {
      toast.info(failMsg);
    }
  } catch {
    toast.error(failMsg);
  } finally {
    busy.value = false;
  }
}

function handleSystem() {
  if (mode.value === "image") {
    void run(
      () => shareImage(props.content),
      "已唤起分享面板",
      "分享失败，请尝试复制或保存",
    );
  } else {
    void run(
      () => shareText(props.content),
      "已唤起分享面板",
      "分享失败，请尝试复制",
    );
  }
}

/** QQ / 微信：均通过系统面板路由 — 移动端等价于 handleSystem */
function handleChannel() {
  handleSystem();
}

function handleCopy() {
  void run(
    () => copyText(props.content),
    "已复制到剪贴板",
    "复制失败",
  );
}

function handleSave() {
  void run(
    () => saveImage(props.content),
    "图片已保存",
    "保存失败",
  );
}
</script>

<template>
  <div class="share-mask" @click.self="emit('close')">
    <div class="share-sheet clean-card">
      <div class="sheet-handle" />

      <header class="sheet-head">
        <h3 class="sheet-title">分享</h3>
        <button class="close-btn" @click="emit('close')" aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <!-- 模式切换 -->
      <div v-if="hasImage" class="mode-tabs">
        <button class="mode-tab" :class="{ active: mode === 'text' }" @click="mode = 'text'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="14" y2="18" />
          </svg>
          <span>文本</span>
        </button>
        <button class="mode-tab" :class="{ active: mode === 'image' }" @click="mode = 'image'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>图片</span>
        </button>
      </div>

      <!-- 文本预览 -->
      <div v-if="mode === 'text'" class="text-preview scrollbar-hide">
        <div class="preview-title">{{ content.title }}</div>
        <pre class="preview-body">{{ content.text }}</pre>
      </div>

      <!-- 图片预览 -->
      <div v-else class="image-preview scrollbar-hide" @click="previewing = !previewing">
        <div v-if="content.svg" class="image-wrap" v-html="content.svg"></div>
        <p class="preview-hint">点击{{ previewing ? '收起' : '展开' }}大图</p>
      </div>

      <!-- 渠道按钮 -->
      <div class="channels">
        <button v-if="canShareNative" class="channel" @click="handleSystem">
          <div class="ch-icon ch-icon--system">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          </div>
          <span class="ch-label">系统分享</span>
        </button>

        <button v-if="canShareNative" class="channel" @click="handleChannel">
          <div class="ch-icon ch-icon--qq">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2c-3.3 0-6 2.7-6 6 0 1.3.4 2.5 1.1 3.5L6 14l2.5-1c.5.3 1 .5 1.5.6L9 16l3-1 3 1-1-2.4c.5-.1 1-.3 1.5-.6L18 14l-1.1-2.5C17.6 10.5 18 9.3 18 8c0-3.3-2.7-6-6-6z"/>
            </svg>
          </div>
          <span class="ch-label">QQ</span>
        </button>

        <button v-if="canShareNative" class="channel" @click="handleChannel">
          <div class="ch-icon ch-icon--wechat">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9 4C4.6 4 1 6.9 1 10.5c0 2 1.1 3.8 2.9 5L3 18l2.7-1.4c.8.2 1.6.3 2.4.4-.1-.5-.2-1.1-.2-1.6 0-3.3 3.1-6 7-6 .3 0 .6 0 .9.1C15.4 6.1 12.5 4 9 4zm-2.5 4a1 1 0 110 2 1 1 0 010-2zm5 0a1 1 0 110 2 1 1 0 010-2zM15.5 10C12 10 9 12.5 9 15.5c0 1.7.9 3.2 2.4 4.2L11 22l2.3-1.2c.7.2 1.4.3 2.2.3 3.6 0 6.5-2.5 6.5-5.6S19.1 10 15.5 10zm-2 3a.8.8 0 110 1.6.8.8 0 010-1.6zm4 0a.8.8 0 110 1.6.8.8 0 010-1.6z"/>
            </svg>
          </div>
          <span class="ch-label">微信</span>
        </button>

        <button class="channel" @click="handleCopy">
          <div class="ch-icon ch-icon--copy">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </div>
          <span class="ch-label">复制</span>
        </button>

        <button
          v-if="mode === 'image' && hasImage"
          class="channel"
          @click="handleSave"
        >
          <div class="ch-icon ch-icon--save">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <span class="ch-label">保存</span>
        </button>
      </div>

      <p v-if="!canShareNative" class="fallback-hint">
        当前环境不支持系统分享，请使用复制或保存后手动发送
      </p>
      <p v-else-if="mode === 'image' && !canShareFiles" class="fallback-hint">
        当前环境不支持图片直传，将自动保存图片并复制文本
      </p>
    </div>
  </div>
</template>

<style scoped>
.share-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.share-sheet {
  width: 100%;
  max-width: 520px;
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  padding: var(--space-3) var(--space-4) var(--space-5);
  background: var(--bg-50);
  box-shadow: var(--shadow-modal);
  animation: sheet-up 0.3s var(--ease-out);
}

@keyframes sheet-up {
  from { transform: translateY(100%); opacity: 0.4; }
  to { transform: translateY(0); opacity: 1; }
}

.sheet-handle {
  width: 36px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--bg-300);
  margin: 0 auto var(--space-3);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}
.sheet-title {
  font-size: var(--text-lg);
  font-weight: var(--fw-bold);
  color: var(--color-text);
  margin: 0;
}
.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-200);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.mode-tabs {
  display: flex;
  gap: var(--space-2);
  background: var(--bg-200);
  border-radius: var(--radius-md);
  padding: 3px;
  margin-bottom: var(--space-3);
}
.mode-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--fw-medium);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.mode-tab.active {
  background: var(--bg-50);
  color: var(--color-warm);
  font-weight: var(--fw-semibold);
}

.text-preview {
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-100);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin-bottom: var(--space-4);
}
.preview-title {
  font-size: var(--text-base);
  font-weight: var(--fw-semibold);
  color: var(--color-text);
  margin-bottom: var(--space-2);
}
.preview-body {
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.55;
}

.image-preview {
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-100);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin-bottom: var(--space-4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}
.image-wrap {
  width: 100%;
  max-width: 220px;
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}
.image-wrap :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
}
.preview-hint {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin: 0;
}

.channels {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.channel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-1);
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background 0.15s;
}
.channel:active {
  background: var(--bg-100);
}
.ch-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.ch-icon--system { background: var(--brand-500); }
.ch-icon--qq { background: #12b7f5; }
.ch-icon--wechat { background: #07c160; }
.ch-icon--copy { background: var(--accent-500); }
.ch-icon--save { background: var(--warm-500); }

.ch-label {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  font-weight: var(--fw-medium);
}

.fallback-hint {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: center;
  line-height: 1.5;
}
</style>
