<script setup lang="ts">
/**
 * ShareSheet — 分享底部抽屉
 *
 * - 模式切换：文本 / 图片
 * - 渠道按钮：系统分享 / QQ / 微信 / 复制 / 保存（按支持情况显示）
 * - QQ / 微信 实际通过系统分享面板路由，UI 仅提示用户选择
 * - 图片模式下：先预览 SVG，再触发分享
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { ShareContent, ShareMode } from "@/types/share";
import { useShare } from "@/composables/useShare";
import { useToast } from "@/composables/useToast";
import { useAnime } from "@/composables/useAnime";

const props = defineProps<{ content: ShareContent }>();
const emit = defineEmits<{ close: [] }>();

const { canShareNative, canShareFiles, shareText, shareImage, copyText, saveImage } = useShare();
const toast = useToast();

const sheetRef = ref<HTMLDivElement | null>(null);
const { enter, staggerEnter, reduced } = useAnime(sheetRef);

onMounted(async () => {
  if (reduced.value) return;
  await nextTick();
  if (!sheetRef.value) return;
  // 桌面端中心缩放入场，移动端缩放淡入
  const isDesktop = window.matchMedia("(min-width: 768px)").matches;
  enter(sheetRef.value, isDesktop ? "popIn" : "scaleIn", {
    springName: "smooth",
    duration: 300,
  });
  // 渠道按钮错峰入场
  const channels = sheetRef.value.querySelectorAll(".channel");
  if (channels.length) {
    staggerEnter(Array.from(channels), "fadeUp", "list");
  }
});

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
    <div ref="sheetRef" class="share-sheet clean-card">
      <div class="sheet-handle" />

      <header class="sheet-head">
        <h3 class="sheet-title">分享</h3>
        <button class="close-btn" @click="emit('close')" aria-label="关闭">
          <i class="bi bi-x-lg" style="font-size:20px"></i>
        </button>
      </header>

      <!-- 模式切换 -->
      <div v-if="hasImage" class="mode-tabs">
        <button class="mode-tab" :class="{ active: mode === 'text' }" @click="mode = 'text'">
          <i class="bi bi-file-text" style="font-size:16px"></i>
          <span>文本</span>
        </button>
        <button class="mode-tab" :class="{ active: mode === 'image' }" @click="mode = 'image'">
          <i class="bi bi-image" style="font-size:16px"></i>
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
            <i class="bi bi-share" style="font-size:22px"></i>
          </div>
          <span class="ch-label">系统分享</span>
        </button>

        <button v-if="canShareNative" class="channel" @click="handleChannel">
          <div class="ch-icon ch-icon--qq">
            <i class="bi bi-qq" style="font-size:22px"></i>
          </div>
          <span class="ch-label">QQ</span>
        </button>

        <button v-if="canShareNative" class="channel" @click="handleChannel">
          <div class="ch-icon ch-icon--wechat">
            <i class="bi bi-wechat" style="font-size:22px"></i>
          </div>
          <span class="ch-label">微信</span>
        </button>

        <button class="channel" @click="handleCopy">
          <div class="ch-icon ch-icon--copy">
            <i class="bi bi-copy" style="font-size:22px"></i>
          </div>
          <span class="ch-label">复制</span>
        </button>

        <button
          v-if="mode === 'image' && hasImage"
          class="channel"
          @click="handleSave"
        >
          <div class="ch-icon ch-icon--save">
            <i class="bi bi-download" style="font-size:22px"></i>
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
